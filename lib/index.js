/**
 * dsh-graceful-restart — 优雅重启（等轮次结束）+ 唤醒 + 启动守护。
 *
 * 架构（v5 自动套壳 + 启动守护）：
 *   用户直接运行 `dsh web`（第一代，无 DSH_LAUNCHER_WRAPPER env）：
 *     第一代经 bundle patch 的 !!js 表达式把 webServer 端口设为 3081（正式端口 3080 的
 *     固定偏移），自身不占正式端口；spawn 第二代（node bin.js web，env
 *     DSH_LAUNCHER_WRAPPER=1，非 detached + stdio inherit + IPC），
 *     第二代用正式端口 3080 服务。第一代常驻为"隐形启动器"。
 *   句柄继承链（用户终端 → 第一代 → 第二代）保证输出始终回原终端；
 *   父退杀子（非 detached）保证第一代退出时第二代随之退出。
 *   重启 = 第二代 IPC {type:'restart', wake} → 第一代 kill 旧第二代 →
 *     重新 spawn 新一代（env DSH_GRACEFUL_RESTART_WAKE=1 时唤醒）。
 *   关闭 = 第二代 IPC {type:'shutdown'} → 第一代 kill → 退出。
 *   唤醒 = 重启前写 $DSH_HOME/dsh-resume.json（sessionIds + 可选 prompt）；
 *     新代 apply 时轮询 ctx.agents 等会话恢复后 steer。
 *   启动守护（第一代）：
 *     spawn 前记录插件清单快照（profile package.json dependencies），成功基线保留
 *     多版本（history，无限保留；回滚过则新正确版本出现时丢弃错误版本）；
 *     第二代意外退出（退出码非 0，或宽限期 20s 内退出）视为启动失败：
 *       逐级回滚——第 N 次回滚对比最新到更早的成功基线 history[N-1]，
 *       对"该基线之后新增"的插件逐个 dsh plugin remove（官方 CLI）→ 重试；
 *       连续失败达上限后保持第一代存活，提示用户手动处理。
 *     第二代存活超过宽限期 → 新基线入列（与最新相同则不重复；回滚过则先丢弃 head 之前的错误版本）。
 *     Ctrl+C / shutdown 视为用户显式操作，不触发回滚。
 *   Client 半检测连接恢复 → 自动 location.reload() 一次。
 */

import { spawn, spawnSync } from 'node:child_process'
import process from 'node:process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

export const name = 'dsh-graceful-restart'
export const inject = ['commands', 'agents', 'timer', 'webServer']

/** 插件配置（settings.yaml 的 `dsh-graceful-restart:` 段，热重载）。 */
const ConfigSchema = z.object({
  continuePrompt: z.string().default('（系统已重启完成）请继续之前未完成的工作。'),
  // 启动守护：回滚上限（1-10）。失败时按 head 指针向更早基线逐级回滚，
  // 最多尝试 rollbackLimit 次后放弃（历史基线无限保留）。
  // step(1) = 整数约束（schemastery 无 .int()）
  rollbackLimit: z.number().step(1).min(1).max(10).default(2),
})

const DEFAULT_CONFIG = {
  continuePrompt: '（系统已重启完成）请继续之前未完成的工作。',
  rollbackLimit: 2,
}

const HOME = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const FILE = {
  index: () => path.join(HOME(), 'dsh-process.json'),
  executor: () => path.join(HOME(), 'dsh-graceful-restart-executor.cjs'),
  resume: () => path.join(HOME(), 'dsh-resume.json'),
  log: () => path.join(HOME(), 'dsh-graceful-restart.log'),
  snapshot: () => path.join(HOME(), 'dsh-graceful-restart-snapshot.json'),
}

/* ------------------------------------------------------------------ */
/* 启动守护：插件清单快照（成功基线 + 当前清单）                        */
/* ------------------------------------------------------------------ */

/** 第二代启动宽限期：存活超过该时长视为启动成功。 */
const STARTUP_GRACE_MS = 20000

/** 当前运行的 profile 名（`dsh web` → 'web'）。 */
function profileName() {
  const p = process.argv[2]
  return typeof p === 'string' && p !== '' ? p : 'web'
}

/** profile 目录（含 package.json）。 */
function profileDir() {
  return path.join(HOME(), 'profiles', profileName())
}

/** 读取 profile package.json 的 dependencies（即当前安装的插件清单）。 */
function readProfileDeps() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir(), 'package.json'), 'utf8'))
    return pkg && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
  } catch (e) {
    log('guard: readProfileDeps THREW ' + String(e))
    return null
  }
}

/**
 * 快照差集：快照文件只记录基线的差异（最新基线存完整 deps 作基准）。
 * added/removed = 包增删（含版本）；changed = 同包名但值不同——值即"版本"：
 * 版本号变化、file:/link:/github: 地址变化都算（地址就是这类依赖的版本）。
 * 条目结构：added/removed = {name, version}，changed = {name, from, to}。
 */
function diffDeps(from, to) {
  const added = []
  const removed = []
  const changed = []
  for (const k of Object.keys(to)) {
    if (!(k in from)) {
      added.push({ name: k, version: to[k] })
    } else if (from[k] !== to[k]) {
      changed.push({ name: k, from: from[k], to: to[k] })
    }
  }
  for (const k of Object.keys(from)) {
    if (!(k in to)) removed.push({ name: k, version: from[k] })
  }
  return { added, removed, changed }
}

/** 从"前一版本"deps 按相邻差集重建该版本完整清单（added/changed 已带值，重建精确）。 */
function applyDiff(prev, diff) {
  const out = { ...prev }
  const nameOf = (e) => (typeof e === 'string' ? e : e && e.name)
  for (const r of diff.removed || []) delete out[nameOf(r)]
  for (const a of diff.added || []) out[nameOf(a)] = a && a.version !== undefined ? a.version : '?'
  for (const c of diff.changed || []) out[nameOf(c)] = c && c.to !== undefined ? c.to : '?'
  return out
}

/**
 * 读取并规范化启动守护快照。
 * 文件结构：{ history: [{deps, at} | {diff, at}], current: {deps, at}, rollbacks }
 *   history[0] 存完整 deps（最新基线）；更早基线只存相邻差集：
 *   diff = "该版本相对更早版本带来的变化"（+ 方向，git commit 语义）。
 * 读取时从最老到最新链式重建完整清单（applyDiff 正向）；兼容旧版（全 deps 条目 / 单值 ok）。
 */
function readSnapshot() {
  try {
    const s = JSON.parse(fs.readFileSync(FILE.snapshot(), 'utf8'))
    if (!s || typeof s !== 'object') return { history: [], current: null, rollbacks: 0 }
    let entries = Array.isArray(s.history)
      ? s.history.filter((h) => h && (typeof h.deps === 'object' || typeof h.diff === 'object'))
      : []
    // 旧结构兼容：仅当没有 history 时才采用单值 ok
    if (entries.length === 0 && s.ok && typeof s.ok.deps === 'object') entries = [s.ok]
    // 从最老到最新重建（diff 是"相对更早版本"的增量，正向应用）
    const ordered = [] // 最老 → 最新
    for (let i = entries.length - 1; i >= 0; i--) {
      const h = entries[i]
      if (typeof h.deps === 'object') {
        ordered.push({ deps: h.deps, at: h.at, note: h.note, error: h.error })
      } else {
        const prev = ordered.length > 0 ? ordered[ordered.length - 1].deps : {}
        ordered.push({ deps: applyDiff(prev, h.diff), diff: h.diff, at: h.at, note: h.note, error: h.error })
      }
    }
    const history = ordered.reverse() // 最新在前
    // 视图统一语义：最新条目（完整 deps）也附加"相对上一版本"的差集（+方向，不落盘，仅展示用）
    if (history.length > 1 && history[0].diff === undefined) {
      history[0].diff = diffDeps(history[1].deps, history[0].deps)
    }
    return {
      history,
      current: s.current && typeof s.current.deps === 'object'
        ? { deps: s.current.deps, at: s.current.at, error: s.current.error }
        : null,
      rollbacks: typeof s.rollbacks === 'number' ? s.rollbacks : 0,
      // 最近一次失败过程的完整回滚序列（新一次失败整组覆盖旧组）
      rollbackLog: s.rollbackLog && Array.isArray(s.rollbackLog.entries)
        ? { startedAt: s.rollbackLog.startedAt, entries: s.rollbackLog.entries.filter((e) => e && typeof e.detail === 'string') }
        : null,
    }
  } catch { return { history: [], current: null, rollbacks: 0, rollbackLog: null } }
}

function writeSnapshot(s) {
  try {
    // 序列化：history[0] 存完整 deps（最新）；更早基线只存"相邻差集"——
    // diff = 该版本相对更早版本（history[i+1]）带来的变化（+ 方向）；
    // 最老条目相对空（第一次变化 = 全部新增）；无变化条目跳过——不留冗余快照
    const history = Array.isArray(s.history) && s.history.length > 0
      ? s.history.map((h, i) => {
        if (i === 0) return { deps: h.deps, at: h.at, note: h.note, error: h.error }
        const prev = i + 1 < s.history.length ? s.history[i + 1].deps : {}
        const diff = diffDeps(prev, h.deps) // 相对更早版本（+ 方向）；最老相对空
        if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) return null
        return { diff, at: h.at, note: h.note, error: h.error }
      }).filter(Boolean)
      : []
    const payload = {
      ...s,
      history,
      ok: history.length > 0 ? history[0] : null, // ok 冗余 = 最新基线（兼容旧代码读取）
    }
    fs.writeFileSync(FILE.snapshot(), JSON.stringify(payload, null, 2) + '\n', 'utf8')
  } catch (e) { log('guard: writeSnapshot THREW ' + String(e)) }
}

function log(msg) {
  try { fs.appendFileSync(FILE.log(), `${new Date().toISOString()} ${msg}\n`, 'utf8') } catch { /* best-effort */ }
}

/** 读唤醒 marker（重启前记录的活跃会话 id 列表 + 可选继续提示 + 重启过程记录）。 */
function readResumeMarker() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE.resume(), 'utf8'))
    const sessionIds = Array.isArray(parsed.sessionIds)
      ? parsed.sessionIds.filter((id) => typeof id === 'string' && id !== '')
      : []
    const prompt = typeof parsed.prompt === 'string' && parsed.prompt !== '' ? parsed.prompt : undefined
    const incidents = Array.isArray(parsed.incidents)
      ? parsed.incidents.filter((i) => i && typeof i.detail === 'string')
      : []
    return { sessionIds, prompt, incidents }
  } catch { return { sessionIds: [], prompt: undefined, incidents: [] } }
}

/** 把重启过程记录（错误/回滚等）追加到唤醒 marker——唤醒时作为消息的一部分发给 agent。 */
function recordIncident(detail) {
  try {
    const marker = JSON.parse(fs.readFileSync(FILE.resume(), 'utf8'))
    if (!marker || typeof marker !== 'object') return
    const incidents = Array.isArray(marker.incidents) ? marker.incidents : []
    incidents.push({ at: new Date().toISOString(), detail })
    marker.incidents = incidents
    fs.writeFileSync(FILE.resume(), JSON.stringify(marker), 'utf8')
    log('guard: incident recorded: ' + detail)
  } catch { /* 无 marker（非唤醒重启）→ 不记录 */ }
}

/** 唤醒消息中的"重启过程记录"段落（无记录时返回空串）。 */
function formatIncidents(incidents) {
  if (!Array.isArray(incidents) || incidents.length === 0) return ''
  const lines = incidents.map((i) => {
    const t = i.at ? new Date(i.at).toLocaleTimeString('zh-CN', { hour12: false }) : ''
    return '  · ' + (t ? t + ' ' : '') + i.detail
  })
  return '重启过程记录：\n' + lines.join('\n')
}

/** 清空唤醒 marker（唤醒完成或放弃后）。 */
function clearResumeMarker() {
  try { fs.unlinkSync(FILE.resume()) } catch { /* already gone */ }
}

/* ------------------------------------------------------------------ */
/* 进程索引（事实上报）                                                */
/* ------------------------------------------------------------------ */

function quoteArg(value) {
  return /[\s"]/.test(value) ? '"' + value.replace(/"/g, '\\"') + '"' : value
}

function launchCommandLine() {
  return [process.execPath, ...process.execArgv, ...process.argv.slice(1)].map(quoteArg).join(' ')
}

function writeProcessIndex() {
  try {
    const file = FILE.index()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({
      pid: process.pid,
      cwd: process.cwd(),
      commandLine: launchCommandLine(),
      execPath: process.execPath,
      execArgv: process.execArgv,
      argv: process.argv.slice(1),
      startedAt: new Date().toISOString(),
    }, null, 2) + '\n', 'utf8')
  } catch (error) {
    console.error('[dsh-graceful-restart] writeProcessIndex:', error)
  }
}

/* ------------------------------------------------------------------ */
/* 一次性重启执行器脚本                                                */
/* ------------------------------------------------------------------ */

function executorScript() {
  return String.raw`// dsh-graceful-restart executor: one-shot restart worker.
// 由 DSH 以 detached + stdio=['ignore',1,2] 方式 spawn（stdout/stderr 继承 DSH 的
// ConPTY 管道/控制台句柄）。新 DSH 以 pipe 捕获输出并转发到本进程 stdout/stderr，
// 输出回到用户终端（绕开数字 fd 继承在 ConPTY 下的不确定性）。
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const indexFile = path.join(home, 'dsh-process.json')
const logFile = path.join(home, 'dsh-graceful-restart.log')
const oldPid = Number(process.argv[2] || 0)
const wake = process.argv[3] === '1'

function log(msg) {
  try { fs.appendFileSync(logFile, new Date().toISOString() + ' executor: ' + msg + '\n', 'utf8') } catch {}
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

log('executor started pid=' + process.pid + ' oldPid=' + oldPid + ' wake=' + wake)
// 防御：stdout/stderr 写入无效句柄时的异步 error 不崩溃（否则会连带杀掉新 DSH）
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})
// 诊断：executor 的 stdout 是否有效（应出现在用户终端）
console.log('[dsh-graceful-restart] executor pid=' + process.pid + ' stdout-ok')

function relaunch() {
  let idx = null
  try { idx = JSON.parse(fs.readFileSync(indexFile, 'utf8')) } catch {}
  if (!idx || !idx.execPath || !idx.argv) { log('no usable process index'); process.exit(0) }
  const argv = [].concat(idx.execArgv || [], idx.argv || [])
  // pipe 捕获新 DSH 输出，转发到本进程 stdout/stderr（= 用户终端句柄）
  const child = spawn(idx.execPath, argv, {
    cwd: idx.cwd || process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, DSH_GRACEFUL_RESTART_WAKE: wake ? '1' : '0' },
  })
  child.stdout.on('data', (d) => { try { process.stdout.write(d) } catch {} })
  child.stderr.on('data', (d) => { try { process.stderr.write(d) } catch {} })
  child.once('error', (e) => { log('relaunch spawn error: ' + String(e)); process.exit(0) })
  log('relaunch spawned pid ' + child.pid)
  // 阻塞到新 DSH 退出（父退出会连带杀死共享控制台的子进程，executor 必须存活到那时）
  child.once('exit', (code, sig) => { log('new dsh exited code=' + code + ' sig=' + sig); process.exit(0) })
}

// 等旧 DSH 退出（最多 60s），然后 relaunch
const deadline = Date.now() + 60000
const waitIv = setInterval(() => {
  if (!processAlive(oldPid)) {
    clearInterval(waitIv)
    log('old dsh exited, relaunching')
    relaunch()
  } else if (Date.now() > deadline) {
    clearInterval(waitIv)
    log('old dsh still alive after 60s, exiting without relaunch')
    process.exit(0)
  }
}, 500)
`
}

/** Spawn the one-shot executor (detached, inheriting DSH's stdout/stderr fds). Returns the child or null. */
function spawnExecutor(action) {
  try {
    fs.writeFileSync(FILE.executor(), executorScript(), 'utf8')
    const wake = action === 'restart-wake' ? '1' : '0'
    const child = spawn(process.execPath, [
      FILE.executor(),
      String(process.pid),
      wake,
    ], {
      // detached：executor 不附加控制台，父 DSH 退出后存活；
      // stdio 'inherit'：stdout/stderr 继承 DSH 的句柄（ConPTY 管道），
      // 供 pipe 转发回用户终端（数字 fd 在 ConPTY 下不可靠，改用 inherit）。
      detached: true,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
    })
    child.once('error', (error) => log('executor spawn error: ' + String(error)))
    child.unref()
    log('executor spawned pid ' + child.pid + ' action=' + action + ' ppid=' + (process.ppid || 0))
    return child
  } catch (error) {
    console.error('[dsh-graceful-restart] spawn executor:', error)
    return null
  }
}

/* ------------------------------------------------------------------ */
/* 等轮次结束后退出                                                    */
/* ------------------------------------------------------------------ */

let pendingAction = null // 'restart' | 'restart-wake' | 'shutdown'
let exitArmed = false
let executorChild = null
/** agent 触发重启时传入的继续提示（写入 marker，重启后唤醒用）。 */
let pendingContinuePrompt = null

/** 本进程由外部 launcher（launcher.cjs）或内部 wrapper（自动套壳）拉起：
 *  IPC 通知父进程即可（杀旧 + 同控制台拉起新实例），无需 executor。 */
const LAUNCHER_MODE = process.env.DSH_LAUNCHED_BY === 'dsh-graceful-restart-launcher' || process.env.DSH_LAUNCHER_WRAPPER === '1'

function scheduleExit(ctx, action) {
  // 如果已有未完成的安排，但执行器已失效（进程退出/超时），重置后重新安排
  if (pendingAction) {
    const alive = executorChild !== null && executorChild.exitCode === null && executorChild.signalCode === null
    if (!alive) {
      log('previous pending action (' + pendingAction + ') executor dead, resetting')
      pendingAction = null
      exitArmed = false
      executorChild = null
    } else {
      log('already pending action (' + pendingAction + '), ignoring new ' + action)
      return
    }
  }
  pendingAction = action
  log('exit scheduled (' + action + '), waiting for turns to finish')
  // shutdown 或 launcher 模式不 spawn 执行器：等轮次结束后通知启动器/直接退出
  if (action !== 'shutdown' && !LAUNCHER_MODE) executorChild = spawnExecutor(action)
  checkIdleAndExit(ctx)
  // 兜底：agent/status 事件可能错过（例如 subagent 结束的时序），
  // 每 1s 主动检查一次，直到退出或执行器超时
  const iv = ctx.setInterval(() => checkIdleAndExit(ctx), 1000)
  ctx.effect(() => () => clearInterval(iv))
  // 安全网：执行器默认 60s 超时，若 70s 后仍未退出，清空 pendingAction
  // 避免"卡住的安排"阻塞后续重启（例如 subagent 场景）
  ctx.setTimeout(() => {
    if (pendingAction && !exitArmed) {
      log('pending action (' + pendingAction + ') stale after 70s, resetting')
      pendingAction = null
      exitArmed = false
      executorChild = null
    }
  }, 70000)
}

/** 撤销已安排但尚未执行的重启/关闭（进程退出前可调用）。
 *  @returns {{ok: true, previous: string} | {ok: false, reason: 'armed' | 'none'}} */
function cancelPendingExit() {
  if (exitArmed) return { ok: false, reason: 'armed' } // 退出流程已触发，无法撤销
  if (!pendingAction) return { ok: false, reason: 'none' }
  const previous = pendingAction
  pendingAction = null
  exitArmed = false
  if (executorChild) {
    try { executorChild.kill() } catch (e) { log('cancel: executor kill THREW ' + String(e)) }
    executorChild = null
  }
  pendingContinuePrompt = null
  log('cancel: pending action (' + previous + ') cancelled')
  return { ok: true, previous }
}

function checkIdleAndExit(ctx) {
  if (!pendingAction || exitArmed) return
  const running = ctx.agents.list().filter((agent) => agent.status === 'running')
  if (running.length > 0) {
    log('still running agents: ' + running.map((a) => a.id).join(', '))
    return
  }
  log('all agents idle, action=' + pendingAction)
  exitArmed = true
  // 记录活跃会话（唤醒目标）：重启后会话从持久化恢复，apply 时可能还没有 agent，
  // 需要 marker 记住"重启前在跑的会话"，恢复后再 steer
  if (pendingAction === 'restart-wake') {
    try {
      const ids = ctx.agents.roots().map((a) => a.id)
      const marker = { sessionIds: ids, at: new Date().toISOString() }
      // agent 触发重启时传入的继续提示（优先于 settings 配置）
      if (pendingContinuePrompt) marker.prompt = pendingContinuePrompt
      fs.writeFileSync(FILE.resume(), JSON.stringify(marker), 'utf8')
      log('resume marker written: ' + ids.join(', ') + (pendingContinuePrompt ? ' prompt=yes' : ''))
    } catch (e) { log('resume marker write failed: ' + String(e)) }
  }
  if (LAUNCHER_MODE) {
    // 启动器/wrapper 模式：通过 IPC 通知常驻父进程（杀旧 + 同控制台拉起新实例），然后本进程退出
    const message = pendingAction === 'shutdown' ? 'shutdown' : 'restart'
    try {
      if (typeof process.send === 'function') process.send({ type: message, wake: pendingAction === 'restart-wake' })
      log('launcher notified: ' + message + ' wake=' + (pendingAction === 'restart-wake'))
    } catch (e) { log('launcher notify failed: ' + String(e)) }
    setTimeout(() => process.exit(0), 500)
    return
  }
  // executor（detached）已就绪并等待旧 DSH 退出，这里直接退出
  setTimeout(() => process.exit(0), 500)
}

/* ------------------------------------------------------------------ */
/* 恢复对话（steer）                                                   */
/* ------------------------------------------------------------------ */

function buildContinueMessage(text) {
  return Object.freeze({
    id: `msg-${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: name, form: 'instructions' },
  })
}

function tryResumeSessions(ctx, sessionIds, text) {
  if (!sessionIds || sessionIds.length === 0) {
    log('resume: no target sessions')
    return
  }
  const pending = new Set(sessionIds)
  let attempts = 0
  const interval = setInterval(() => {
    attempts += 1
    for (const sessionId of [...pending]) {
      const agent = ctx.agents.get(sessionId)
      if (!agent) continue
      try {
        agent.steer(buildContinueMessage(text))
        log('steered session ' + sessionId)
      } catch (error) {
        console.error('[dsh-graceful-restart] steer failed:', error)
      }
      pending.delete(sessionId)
    }
    if (pending.size === 0) {
      clearInterval(interval)
      log('resume: all sessions steered')
      clearResumeMarker()
    } else if (attempts >= 120) {
      clearInterval(interval)
      log('resume: timed out after 60s, never steered: ' + [...pending].join(', '))
      clearResumeMarker()
    }
  }, 500)
  ctx.effect(() => () => clearInterval(interval))
}

/* ------------------------------------------------------------------ */
/* 自动套壳（wrapper）：第一代 spawn 第二代并常驻为隐形 launcher        */
/* ------------------------------------------------------------------ */

/** 正式服务端口（与 bundle patch 中的 webserver port 表达式一致）。 */
const TARGET_PORT = 3080

/**
 * 代际 ID：本进程的记录时刻（毫秒级，每个进程必然不同——进程间启动间隔远大于 1ms）。
 * 客户端用它做"重启检测"的持久化对比。
 */
const STARTED_AT = Date.now()

/**
 * 第一代（用户直接启动，无 DSH_LAUNCHER_WRAPPER）：
 * 阻止自身启动（webServer 已被 bundle patch 设为 port 0，不占 3080），
 * spawn 第二代（继承控制台 + env DSH_LAUNCHER_WRAPPER=1 + IPC），
 * 常驻等待第二代的 restart/shutdown 请求。
 */
function wrapperApply(ctx) {
  log('wrapper: first generation, spawning real dsh')
  // 撞端口检测：port 0 由 OS 从动态范围分配；若正式端口被配置在动态范围内
  // （如 49152-65535），理论上可能撞上。撞了则明确报错、不 spawn 第二代
  // （避免第二代 EADDRINUSE 崩溃），保持进程存活供用户处理。
  try {
    const webServer = ctx.get('webServer')
    const listened = webServer && typeof webServer.port === 'number' ? webServer.port : 0
    if (listened === TARGET_PORT) {
      console.log('[dsh-graceful-restart] 错误：第一代分配的端口(' + listened + ')与正式端口冲突！'
        + ' 请更换正式端口或重启后重试（未启动第二代）。')
      log('wrapper: port collision with target ' + TARGET_PORT + ', aborting spawn')
      return
    }
    log('wrapper: first generation listened port ' + listened + ' (target ' + TARGET_PORT + ')')
  } catch (e) { log('wrapper: port check THREW ' + String(e)) }
  console.log('[dsh-graceful-restart] 第一代 wrapper：正在启动正式 dsh（几秒内完成）...')

  // ---- 启动守护：记录插件清单快照（多版本成功基线） ----
  // 结构：{ history: [{deps, at}, ...]（最新在前）, current: {deps, at}, rollbacks }
  // 第二代启动失败（意外退出/过快退出）时：逐级对比 current vs history[k]，
  // 对"该基线之后新增"的插件逐个 dsh plugin remove（官方 CLI），然后重试。
  const profile = profileName()
  const deps = readProfileDeps()
  const snapshot = readSnapshot()
  let history = snapshot.history
  let current = deps !== null
    ? deps
    : (snapshot.current ? snapshot.current.deps : {})
  let rollbacks = snapshot.rollbacks
  // 回滚记录：最近一次失败过程的完整回滚序列（每次回滚尝试追加一条；
  // 新一次失败整组覆盖旧组）。持久化于快照文件。
  let rollbackLog = snapshot.rollbackLog || null
  const logRollback = (detail, newGroup) => {
    if (newGroup || !rollbackLog) {
      rollbackLog = { startedAt: new Date().toISOString(), entries: [] }
    }
    rollbackLog.entries.push({ at: new Date().toISOString(), detail })
    log('guard: rollbackLog: ' + detail)
  }

  // 第一代也注册设置段（与第二代共享 settings.yaml 的同名命名空间），
  // 读取 rollbackLimit：回滚上限（设置菜单可调）
  let resolveGuardConfig = () => DEFAULT_CONFIG
  try {
    installSettingsSection(ctx, settingsNamespace('dsh-graceful-restart'), ConfigSchema, DEFAULT_CONFIG, {
      setSource: (get) => { resolveGuardConfig = get },
      onChange: () => {},
    })
    log('wrapper: settings installed')
  } catch (e) { log('wrapper: installSettingsSection THREW ' + String(e)) }
  const guardRollbackLimit = () => {
    const v = Number(resolveGuardConfig().rollbackLimit)
    return Number.isFinite(v) ? Math.min(10, Math.max(1, Math.floor(v))) : DEFAULT_CONFIG.rollbackLimit
  }
  const persist = () => writeSnapshot({
    history,
    current: { deps: current, at: new Date().toISOString() },
    rollbacks,
    rollbackLog,
  })
  persist()
  log('guard: current deps [' + Object.keys(current).join(', ') + ']')
  log('guard: baseline history ' + history.length + ' version(s)'
    + (history.length ? ' [' + history.map((h) => Object.keys(h.deps).join('|')).join('] <- [') + ']' : ' (none)'))
  log('guard: rollbackLimit=' + guardRollbackLimit())

  let child = null
  let restarting = false
  let pendingWake = false
  let deliberateExit = false
  let spawnedAt = 0
  let successTimer = null
  // git HEAD 指针：回滚后 current 在历史中的对齐位置（内存态）。
  // 回滚从 head 往后（更早）排着找；新正确版本出现（markSuccess）时丢弃 head 之前的错误版本。
  let rollbackHead = null

  // Ctrl+C（控制台组信号）：用户操作 → 不判定启动失败。
  // Node 注册 SIGINT handler 后默认退出行为被取代，需自行退出。
  process.on('SIGINT', () => {
    deliberateExit = true
    log('wrapper: SIGINT received')
    try { if (child) child.kill() } catch {}
    setTimeout(() => process.exit(0), 3000).unref() // 兜底：child 若未在 3s 内退出
  })

  // 第二代存活超过宽限期 → 启动成功。
  // 历史无限保留，失败尝试（错误版本）也保留（带 error 标记，视图 ⚠ hover 看报错）；
  // 状态与当前基线相同 → 不重复入列（note 记到当前基线），否则新基线入列。清零回滚计数。
  const markSuccess = () => {
    successTimer = null
    if (!child || child.exitCode !== null) return
    log('guard: second generation alive past grace, marking success baseline')
    const note = rollbackLog && rollbackLog.entries.length > 0
      ? '回滚后恢复：' + rollbackLog.entries.map((e) => e.detail).join('；')
      : undefined
    const sameAsHead = history.length > 0
      && JSON.stringify(history[0].deps) === JSON.stringify(current)
    if (sameAsHead) {
      // 状态未变（回滚恢复到既有基线）：不重复入列，note 记到当前基线
      if (note && history[0].note === undefined) history[0].note = note
    } else {
      history = [{ deps: current, at: new Date().toISOString(), note }, ...history]
    }
    rollbackHead = null
    rollbacks = 0
    // 若存在回滚记录 → 追加"恢复成功"（组保留到下次失败整组覆盖）
    if (rollbackLog) logRollback('重试成功，服务恢复', false)
    persist()
    log('guard: baseline history now ' + history.length + ' version(s)')
  }

  // 回滚"指定基线之后的变更"（官方 CLI：node bin.js plugin --profile <p> remove/add <pkg>）：
  //   added   基线里没有的包 → 卸载
  //   changed 基线里有但版本/地址不同 → 卸载后重装基线版本（版本回滚）
  const rollbackPlugins = (candidate, baseline) => {
    const added = Object.keys(candidate).filter((k) => !(k in baseline))
    const changed = Object.keys(candidate).filter((k) => (k in baseline) && baseline[k] !== candidate[k])
    if (added.length === 0 && changed.length === 0) return { added: [], changed: [] }
    console.log('[dsh-graceful-restart] 启动失败，自动回滚该基线之后的变更：'
      + '卸载 ' + (added.join(', ') || '(无)') + (changed.length ? '；版本回滚 ' + changed.join(', ') : ''))
    const runCli = (args) => {
      try {
        return spawnSync(process.execPath, [process.argv[1], 'plugin', '--profile', profile, ...args], {
          cwd: profileDir(),
          stdio: ['ignore', 'inherit', 'inherit'],
          timeout: 120000,
        }).status === 0
      } catch (e) {
        log('guard: cli THREW ' + String(e))
        return false
      }
    }
    for (const pkg of added) {
      log('guard: removing ' + pkg)
      if (runCli(['remove', pkg])) log('guard: removed ' + pkg)
      else log('guard: remove ' + pkg + ' FAILED')
    }
    for (const pkg of changed) {
      const spec = baseline[pkg] // 基线版本/地址（如 0.12.1 或 file:D:/...）
      log('guard: version rollback ' + pkg + ' → ' + spec)
      if (runCli(['remove', pkg]) && runCli(['add', String(spec)])) log('guard: version restored ' + pkg)
      else log('guard: version rollback ' + pkg + ' FAILED')
    }
    return { added, changed }
  }

  // 新增插件 = 当前清单 − 最新成功基线（回滚判定与客户端探测共用）
  const newlyAdded = () => {
    if (history.length === 0) return []
    const baseline = history[0].deps
    return Object.keys(current).filter((k) => !(k in baseline))
  }

  // 判断插件是否有 client 半（有 client 声明且 exports["./client"]）——探测只针对这类
  const hasClientHalf = (pkg) => {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(profileDir(), 'node_modules', pkg, 'package.json'), 'utf8'))
      return !!(p.dsh && p.dsh.client && p.dsh.client.platform === 'web' && p.exports && p.exports['./client'])
    } catch { return false }
  }

  // 探测新增插件的 client bundle（页面级启动失败检测）+ 唤醒闸门：
  // 宿主进程可能正常起来（退出码 0），但页面加载其 client 脚本 404/失败——
  // 页面级"半启动失败"。探测失败 → 主动杀第二代 → 走现有回滚路径。
  // 探测全部通过（或无新增）→ IPC {type:'probe-ok'} 放行第二代的唤醒——
  // 避免坏代提前唤醒 + 重试代再次唤醒的重复唤醒。
  const scheduleClientProbe = (childRef) => {
    const added = newlyAdded().filter(hasClientHalf)
    if (added.length === 0) {
      // 无新增插件：短暂等待第二代就绪后直接放行唤醒
      setTimeout(() => {
        if (!childRef || childRef.exitCode !== null) return
        try { childRef.send({ type: 'probe-ok' }) } catch { /* child 已死 */ }
      }, 3000)
      return
    }
    log('guard: client probe targets [' + added.join(', ') + ']')
    setTimeout(async () => {
      if (!childRef || childRef.exitCode !== null) return // 已退出：由 exit 路径处理
      for (const pkg of added) {
        let ok = false
        for (let i = 0; i < 3 && !ok; i++) {
          try {
            const res = await fetch('http://127.0.0.1:' + TARGET_PORT + '/plugins/' + pkg + '/client.js', {
              signal: AbortSignal.timeout(3000),
            })
            ok = res.ok
            if (!ok) log('guard: probe ' + pkg + ' status=' + res.status + ' (attempt ' + (i + 1) + ')')
          } catch (e) {
            log('guard: probe ' + pkg + ' net error (attempt ' + (i + 1) + '): ' + String(e && e.message || e))
          }
          if (!ok) await new Promise((r) => setTimeout(r, 1000))
        }
        if (!ok) {
          log('guard: client probe FAILED for ' + pkg + ' — treating as startup failure')
          console.log('[dsh-graceful-restart] 新增插件 ' + pkg + ' 的客户端加载失败（/plugins/' + pkg
            + '/client.js 不可用），视为启动失败，自动回滚...')
          restoreMarkerForRetry('新增插件 ' + pkg + ' 客户端加载失败（/plugins/' + pkg + '/client.js 不可用）')
          logRollback('新增插件 ' + pkg + ' 客户端加载失败（/plugins/' + pkg + '/client.js 不可用），开始回滚', true)
          try { if (childRef) childRef.kill() } catch {}
          return
        }
      }
      // 全部探测通过 → 放行唤醒
      try { if (childRef && childRef.exitCode === null) childRef.send({ type: 'probe-ok' }) } catch { /* child 已死 */ }
    }, 5000)
  }

  // 失败回滚前的 marker 保全：病历追加 + （若坏代已消费清除 marker）用备份重建，
  // 保证重试代能唤醒并拿到完整病历
  let markerBackup = null
  const restoreMarkerForRetry = (detail) => {
    recordIncident(detail) // marker 存在 → 追加病历
    if (!fs.existsSync(FILE.resume()) && markerBackup && markerBackup.sessionIds.length > 0) {
      const m = { sessionIds: markerBackup.sessionIds, at: new Date().toISOString() }
      if (markerBackup.prompt) m.prompt = markerBackup.prompt
      const incidents = Array.isArray(markerBackup.incidents) ? [...markerBackup.incidents] : []
      incidents.push({ at: new Date().toISOString(), detail })
      m.incidents = incidents
      try {
        fs.writeFileSync(FILE.resume(), JSON.stringify(m), 'utf8')
        log('guard: marker restored for retry wake (sessions=' + m.sessionIds.length + ')')
      } catch (e) { log('guard: marker restore THREW ' + String(e)) }
    }
  }

  const spawnChild = (wake) => {
    // 每次 spawn 都重读清单：重启期间可能新装了插件（导致失败），
    // 回滚判定必须基于最新 dependencies
    const latest = readProfileDeps()
    if (latest !== null) {
      current = latest
      // 尝试版本入列（current 指向的版本）：只与"完整 deps 条目"做值比较去重
      // （diff 条目重建值不精确，且 key 相同不代表版本相同——版本变化必须入列）
      const dup = history.some((h) => h.deps && JSON.stringify(h.deps) === JSON.stringify(current))
      if (!dup) {
        // 当前再次向新移动（新版本产生）→ 丢弃比当前新的记录（回滚跳过的错误版本）
        if (rollbackHead !== null && rollbackHead > 0) {
          log('guard: discarding records newer than current (rollback head ' + rollbackHead + ')')
          history = history.slice(rollbackHead)
          rollbackHead = null
        }
        history = [{ deps: current, at: new Date().toISOString() }, ...history]
      }
      persist()
      log('guard: refreshed current deps [' + Object.keys(current).join(', ') + '] dup=' + dup
        + ' head=' + (history.length > 0 ? history[0].at : 'none'))
    }
    markerBackup = readResumeMarker() // 备份唤醒 marker：失败回滚时可能已被坏代消费清除
    const args = process.argv.slice(1) // ['.../bin.js', 'web', ...]
    child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      // 非 detached + inherit：第二代继承本进程的控制台（用户终端 ConPTY 管道）→ 输出回原终端
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: {
        ...process.env,
        DSH_LAUNCHER_WRAPPER: '1',
        ...(wake ? { DSH_GRACEFUL_RESTART_WAKE: '1' } : {}),
      },
    })
    child.once('error', (e) => log('wrapper: spawn error ' + String(e)))
    child.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'restart') {
        log('wrapper: restart requested wake=' + (msg.wake === true))
        console.log('[dsh-graceful-restart] 收到重启请求，正在拉起新一代 dsh...')
        restarting = true
        pendingWake = msg.wake === true
        try { child.kill() } catch {}
      } else if (msg.type === 'shutdown') {
        log('wrapper: shutdown requested')
        console.log('[dsh-graceful-restart] 收到关闭请求，进程即将退出')
        deliberateExit = true
        try { child.kill() } catch {}
      }
    })
    child.once('exit', (code, sig) => {
      log('wrapper: child exited code=' + code + ' sig=' + sig + ' restarting=' + restarting)
      child = null
      if (successTimer) { clearTimeout(successTimer); successTimer = null }
      if (restarting) {
        restarting = false
        spawnChild(pendingWake)
        return
      }
      if (deliberateExit) {
        log('wrapper: deliberate exit, wrapper exiting')
        process.exit(0)
        return
      }
      const elapsed = Date.now() - spawnedAt
      const failed = code !== 0 || elapsed < STARTUP_GRACE_MS
      // 启动失败且存在成功基线、仍有回滚次数 → 逐级回滚后重试。
      // 版本链语义：错误记在 current 指向的版本（history[0] 尝试版本）上，
      // 然后 current 回退（HEAD 移动）——按差集（基线 vs 实际清单）调整插件，
      // 重试时 current 由 refresh 更新为调整后的实际；再失败重复。
      if (failed && history.length > 0 && rollbacks < guardRollbackLimit()) {
        let baseline = null
        let baselineIdx = -1
        for (let i = rollbackHead !== null ? rollbackHead + 1 : 0; i < history.length; i++) {
          const b = history[i].deps
          if (Object.keys(current).some((k) => !(k in b) || b[k] !== current[k])) {
            baseline = b
            baselineIdx = i
            break
          }
        }
        if (baseline) {
          rollbacks++
          rollbackHead = baselineIdx
          // 1) 错误信息记到 current 指向的版本（history[0] 尝试版本）
          const failDetail = '第二代启动失败（退出码 ' + code + '，' + Math.round(elapsed / 1000) + 's）'
          if (history.length > 0) history[0].error = { at: new Date().toISOString(), detail: failDetail }
          // 2) current 回退：按差集（基线 vs 实际清单）调整插件，重试时 current 自然回到基线状态
          const actual = readProfileDeps()
          const diff = rollbackPlugins(actual !== null ? actual : current, baseline)
          const desc = [...diff.added.map((k) => k), ...diff.changed.map((k) => k + '@基线版本')].join(', ')
          const detail = '回滚 #' + rollbacks + '：卸载 ' + (desc || '(无)') + '（基线版本 #' + baselineIdx + '）'
          restoreMarkerForRetry(failDetail + '，自动回滚卸载：' + (desc || '(无)') + '（基线版本 #' + baselineIdx + '）')
          logRollback(failDetail + ' → ' + detail, rollbacks === 1)
          console.log('[dsh-graceful-restart] ' + failDetail
            + '，第 ' + rollbacks + ' 次回滚重试（基线版本 #' + baselineIdx + '）...')
          persist()
          // 回滚重试也带上未消费的唤醒请求（重启 marker 仍在，恢复后继续唤醒）
          spawnChild(pendingWake)
          return
        }
      }
      if (failed) {
        const detail = '第二代启动失败（退出码 ' + code + '，' + Math.round(elapsed / 1000) + 's），'
          + (history.length > 0 ? '已回滚 ' + rollbacks + ' 次，未能恢复，请手动检查' : '且没有可用回滚基线，请手动检查')
        // 错误记到 current 指向的版本（history[0] 尝试版本）
        if (history.length > 0) history[0].error = { at: new Date().toISOString(), detail }
        persist()
        logRollback(detail, !rollbackLog)
        console.log('[dsh-graceful-restart] 第二代启动失败（退出码 ' + code + '，' + Math.round(elapsed / 1000) + 's），'
          + (history.length > 0 ? '已回滚 ' + rollbacks + ' 次，请手动检查（wrapper 保持运行）' : '且没有可用回滚基线，请手动检查（wrapper 保持运行）'))
        log('guard: giving up, rollbacks=' + rollbacks)
        return // 保持进程存活，供用户查看终端输出
      }
      log('wrapper: child ended after successful startup, wrapper exiting')
      process.exit(0)
    })
    spawnedAt = Date.now()
    successTimer = setTimeout(markSuccess, STARTUP_GRACE_MS)
    log('wrapper: spawned dsh pid=' + child.pid + ' wake=' + wake)
    console.log('[dsh-graceful-restart] 正式 dsh 已启动 pid=' + child.pid)
    // 客户端探测：新增插件的 client bundle 404/不可用 → 页面级启动失败 → 回滚
    scheduleClientProbe(child)
  }

  spawnChild(false)
  log('wrapper: complete (staying resident)')
}

export function apply(ctx) {
  log(`apply: start pid=${process.pid}`)
  try { writeProcessIndex(); log('apply: process index written') } catch (e) { log('apply: index THREW ' + String(e)) }

  // 第一代（用户直接启动）：阻止启动 → spawn 第二代 → 常驻 launcher
  if (process.env.DSH_LAUNCHER_WRAPPER !== '1') {
    try { wrapperApply(ctx) } catch (e) { log('apply: wrapper THREW ' + String(e)) }
    return
  }
  log('apply: second generation (wrapper child), normal mode')
  console.log('[dsh-graceful-restart] 正式 dsh 实例（第二代）开始服务'
    + '（启动时间 ' + new Date(STARTED_AT).toLocaleString('zh-CN', { hour12: false }) + '）')

  // 设置（settings.yaml 的 dsh-graceful-restart 段，热重载）：
  //   continuePrompt: 重启+唤醒时注入给智能体的继续提示文本
  let resolveConfig = () => DEFAULT_CONFIG
  const dynamic = () => resolveConfig()
  try {
    installSettingsSection(ctx, settingsNamespace('dsh-graceful-restart'), ConfigSchema, DEFAULT_CONFIG, {
      setSource: (get) => { resolveConfig = get },
      onChange: () => {},
    })
    log('apply: settings installed')
  } catch (e) {
    log('apply: installSettingsSection THREW ' + String(e))
  }

  // 代际信息：本进程是被重启执行器拉起的？
  const wake = process.env.DSH_GRACEFUL_RESTART_WAKE === '1'
  if (wake) {
    log('apply: launched by executor with WAKE=1, scheduling steer')
    // 会话恢复发生在客户端重连之后（resume），apply 时 agents 可能为空：
    // 读重启前记录的 marker，轮询等待目标会话出现后再 steer
    const marker = readResumeMarker()
    log('apply: resume marker sessions: ' + marker.sessionIds.join(', ') + (marker.prompt ? ' prompt=yes' : '')
      + (marker.incidents.length ? ' incidents=' + marker.incidents.length : ''))
    // 继续提示优先级：agent 触发时传入（marker.prompt）> settings 配置 > 默认；
    // 重启过程记录（启动失败/回滚等）作为消息前缀——agent 醒来即知发生了什么
    const prompt = marker.prompt || dynamic().continuePrompt
    const incidentsText = formatIncidents(marker.incidents)
    const text = incidentsText ? incidentsText + '\n\n' + prompt : prompt
    // 唤醒闸门：等第一代的"启动检查通过"（IPC probe-ok）再唤醒——
    // 避免坏代（client 404 但 host 正常）提前唤醒 + 重试代再次唤醒的重复唤醒；
    // 15s 兜底：第一代探测逻辑故障时不阻塞唤醒
    let steered = false
    const doSteer = () => {
      if (steered) return
      steered = true
      try { tryResumeSessions(ctx, marker.sessionIds, text) } catch (e) { log('apply: resume THREW ' + String(e)) }
    }
    try {
      if (typeof process.send === 'function') {
        process.on('message', (msg) => {
          if (msg && msg.type === 'probe-ok') {
            log('apply: probe-ok received, steering')
            doSteer()
          }
        })
      }
    } catch (e) { log('apply: message listener THREW ' + String(e)) }
    setTimeout(doSteer, 15000)
    log('apply: wake gated on probe-ok (15s fallback)')
  } else if (process.env.DSH_GRACEFUL_RESTART_WAKE !== undefined) {
    log('apply: launched by executor with WAKE=0, no steer')
  }
  const restartedByExecutor = process.env.DSH_GRACEFUL_RESTART_WAKE !== undefined

  // 设置读写面（client 设置菜单用）：复用 installSettingsSection 注册的命名空间，
  // 只 describe/update，不重复注册
  let settingsView = () => ({ value: {}, revision: null })
  let settingsUpdate = null
  try {
    ctx.inject(['settings'], (sctx) => {
      const ns = settingsNamespace('dsh-graceful-restart')
      settingsView = () => {
        const descriptor = sctx.settings.describe({ redactSecrets: true }).find((c) => c.ns === ns)
        return descriptor
          ? { value: descriptor.value || {}, revision: typeof descriptor.revision === 'number' ? descriptor.revision : null }
          : { value: {}, revision: null }
      }
      settingsUpdate = (patch, expectedRevision) => sctx.settings.update(ns, patch, expectedRevision)
    })
    log('apply: settings view/update wired')
  } catch (e) { log('apply: settings wire THREW ' + String(e)) }

  // Web 端点：status（启动信号 + 代际 ID）+ ack（页面确认）+ settings（设置菜单读写）
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-graceful-restart/status',
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      // startedAt = 本进程启动时间（代际 ID，比 pid 可靠——pid 可能被复用）；
      // restarted=true 仅当本进程是被重启执行器拉起时（启动信号）；正常启动为 false
      res.end(JSON.stringify({ ok: true, pid: process.pid, startedAt: STARTED_AT, restarted: restartedByExecutor }))
    },
  }), 'dsh-graceful-restart: status endpoint')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-graceful-restart/ack',
    handler: (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end('method not allowed')
        return
      }
      log('ack received via web endpoint')
      // 通知执行器（若存在）：页面已确认新界面
      try { if (typeof process.send === 'function') process.send({ type: 'ack' }) } catch (e) { log('send ack failed: ' + String(e)) }
      res.writeHead(204)
      res.end()
    },
  }), 'dsh-graceful-restart: ack endpoint')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-graceful-restart/snapshot',
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
      try {
        const s = readSnapshot() // 共享快照文件（第一代写入）
        res.end(JSON.stringify({ ok: true, ...s }, null, 2))
      } catch (e) {
        res.end(JSON.stringify({ ok: false, error: String(e) }))
      }
    },
  }), 'dsh-graceful-restart: snapshot view endpoint')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-graceful-restart/settings',
    handler: (req, res) => {
      const writeJson = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(obj))
      }
      if (req.method === 'GET') {
        const v = settingsView()
        writeJson(200, { ok: true, value: v.value, revision: v.revision })
        return
      }
      if (req.method === 'POST') {
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => {
          try {
            const payload = JSON.parse(body || '{}')
            if (typeof settingsUpdate !== 'function') {
              writeJson(503, { ok: false, error: 'settings service unavailable' })
              return
            }
            settingsUpdate(payload.patch, payload.expectedRevision)
              .then(() => {
                const v = settingsView()
                writeJson(200, { ok: true, value: v.value, revision: v.revision })
              })
              .catch((e) => writeJson(409, { ok: false, error: String((e && e.message) || e) }))
          } catch (e) {
            writeJson(400, { ok: false, error: 'bad request: ' + String(e) })
          }
        })
        return
      }
      writeJson(405, { ok: false, error: 'method not allowed' })
    },
  }), 'dsh-graceful-restart: settings endpoint')

  // 命令
  try {
    ctx.commands.register({
      name: 'restart',
      description: '重启 DeepSeek Harness：等当前轮次结束后退出，由执行器拉起新进程（不唤醒）',
      recordInput: false,
      handler() {
        scheduleExit(ctx, 'restart')
        return { kind: 'success', text: '重启已安排：等当前轮次结束后进程退出，执行器将拉起新进程（不唤醒）。' }
      },
    })
    ctx.commands.register({
      name: 'shutdown',
      description: '关闭 DeepSeek Harness：等当前轮次结束后进程退出，不重启',
      recordInput: false,
      handler() {
        scheduleExit(ctx, 'shutdown')
        return { kind: 'success', text: '关闭已安排：等当前轮次结束后进程退出（不重启）。' }
      },
    })
    log('apply: commands registered')
  } catch (e) {
    log('apply: commands THREW ' + String(e))
  }

  // 模型工具：触发重启 = 重启 + 唤醒
  const tools = ctx.get('tools')
  if (tools !== undefined) {
    try {
      ctx.effect(() => tools.register({
        name: 'restart_harness',
        description:
          '重启整个 DeepSeek Harness 进程（等当前轮次结束后优雅退出，由重启执行器拉起新进程），'
          + '并在重启完成后自动唤醒智能体继续之前的工作。'
          + '触发后当前会话连接会短暂中断，网页自动刷新后重连。'
          + '返回安排结果。',
        parameters: {
          type: 'object',
          properties: {
            continuePrompt: {
              type: 'string',
              description: '可选：重启后唤醒智能体的继续提示文本。不传则用默认提示（可在 settings.yaml 的 dsh-graceful-restart.continuePrompt 配置）。',
            },
          },
        },
        output: {
          // 纯文本呈现，不做卡片：重启是一次性动作，结果文本即反馈
          schema: { type: 'object', additionalProperties: true },
          render(args, value) {
            return [{ type: 'text', text: value && value.message ? String(value.message) : JSON.stringify(value) }]
          },
        },
        async execute(args) {
          pendingContinuePrompt = (args && typeof args.continuePrompt === 'string' && args.continuePrompt.trim() !== '')
            ? args.continuePrompt.trim()
            : null
          scheduleExit(ctx, 'restart-wake')
          return {
            ok: true,
            message: '重启+唤醒已安排：等当前轮次结束后进程退出，执行器将拉起新进程，重启完成后自动唤醒智能体'
              + (pendingContinuePrompt ? '（继续提示：' + pendingContinuePrompt + '）' : '。'),
          }
        },
      }), 'dsh-graceful-restart: restart_harness tool')
      log('apply: restart_harness tool registered')

      ctx.effect(() => tools.register({
        name: 'shutdown_harness',
        description:
          '关闭整个 DeepSeek Harness 进程（等当前轮次结束后优雅退出，不重启）。'
          + '触发后当前会话连接中断，网页将无法访问，需要手动重新启动。'
          + '返回安排结果。',
        parameters: {
          type: 'object',
          properties: {},
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render(args, value) {
            return [{ type: 'text', text: value && value.message ? String(value.message) : JSON.stringify(value) }]
          },
        },
        async execute() {
          scheduleExit(ctx, 'shutdown')
          return {
            ok: true,
            message: '关闭已安排：等当前轮次结束后进程退出（不重启）。',
          }
        },
      }), 'dsh-graceful-restart: shutdown_harness tool')
      log('apply: shutdown_harness tool registered')

      ctx.effect(() => tools.register({
        name: 'cancel_harness_action',
        description:
          '撤销已安排但尚未执行的重启或关闭（restart_harness / shutdown_harness 触发后、'
          + '进程退出前可调用，用于改变主意）。'
          + '若退出流程已触发或没有待撤销的安排，返回对应结果。'
          + '返回撤销结果。',
        parameters: {
          type: 'object',
          properties: {},
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render(args, value) {
            return [{ type: 'text', text: value && value.message ? String(value.message) : JSON.stringify(value) }]
          },
        },
        async execute() {
          const r = cancelPendingExit()
          if (r.ok) {
            const label = r.previous === 'restart-wake' ? '重启+唤醒' : r.previous === 'restart' ? '重启' : '关闭'
            return { ok: true, message: '已撤销' + label + '安排，进程将继续运行。' }
          }
          if (r.reason === 'armed') {
            return { ok: false, message: '退出流程已触发（进程即将退出），无法撤销。' }
          }
          return { ok: true, message: '当前没有待撤销的重启/关闭安排。' }
        },
      }), 'dsh-graceful-restart: cancel_harness_action tool')
      log('apply: cancel_harness_action tool registered')
    } catch (e) {
      log('apply: tools.register THREW ' + String(e))
    }
  }

  log('apply: complete')
}
