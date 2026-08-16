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
})

const DEFAULT_CONFIG = {
  continuePrompt: '（系统已重启完成）请继续之前未完成的工作。',
}

const HOME = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const FILE = {
  index: () => path.join(HOME(), 'dsh-process.json'),
  executor: () => path.join(HOME(), 'dsh-graceful-restart-executor.cjs'),
  resume: () => path.join(HOME(), 'dsh-resume.json'),
  log: () => path.join(HOME(), 'dsh-graceful-restart.log'),
  snapshot: () => path.join(HOME(), 'dsh-graceful-restart-snapshot.json'),
}

// 当前代际的 stderr 文件（每次 spawn 建立独立文件，避免多次失败内容累积）
let stderrLogPath = null
/** 本次代际的 stderr 文件路径（无则用默认路径——兼容旧行为）。 */
const stderrFile = () => stderrLogPath || path.join(HOME(), 'dsh-graceful-restart-stderr.log')
/** 开始新代际：清理上一个 stderr 文件，建立本次独立文件。 */
const newStderrFile = () => {
  if (stderrLogPath) {
    try { fs.unlinkSync(stderrLogPath) } catch { /* 已删/不存在 */ }
  }
  stderrLogPath = path.join(HOME(), 'dsh-graceful-restart-stderr-' + Date.now() + '.log')
  return stderrLogPath
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
 * 快照差集：插件是**整包粒度**，任何变化都是"删旧包 + 加新包"——
 * 版本更换（版本号/地址变化）就是 - 旧版本 + 新版本，**没有 changed 类别**。
 * added/removed = 包增删，条目结构：{name, version}（removed 带旧版本，added 带新版本）。
 */
function diffDeps(from, to) {
  const added = []
  const removed = []
  for (const k of Object.keys(to)) {
    if (!(k in from)) {
      added.push({ name: k, version: to[k] })
    } else if (from[k] !== to[k]) {
      // 版本更换 = 卸载旧版（removed）+ 安装新版（added），整包处理
      removed.push({ name: k, version: from[k] })
      added.push({ name: k, version: to[k] })
    }
  }
  for (const k of Object.keys(from)) {
    if (!(k in to)) removed.push({ name: k, version: from[k] })
  }
  return { added, removed }
}

/** 从"前一版本"deps 按相邻差集重建该版本完整清单（先删后加，整包语义精确）。 */
function applyDiff(prev, diff) {
  const out = { ...prev }
  const nameOf = (e) => (typeof e === 'string' ? e : e && e.name)
  for (const r of diff.removed || []) delete out[nameOf(r)]
  for (const a of diff.added || []) out[nameOf(a)] = a && a.version !== undefined ? a.version : '?'
  return out
}

/** 键序无关的 deps 相等比较（避免 JSON.stringify 因对象键序不同而误判）。 */
function depsEqual(a, b) {
  if (!a || !b) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!(k in b) || b[k] !== a[k]) return false
  }
  return true
}

/**
 * 读取并规范化启动守护快照。
 * 文件结构：{ history: [{deps, at} | {diff, at}], current: <at 时间键值>, errors: [...], rollbacks }
 *   history[0] 存完整 deps（最新快照）；更早快照只存相邻差集：
 *   diff = "该版本相对更早版本带来的变化"（+ 方向，git commit 语义）。
 *   current = 唯一指针（时间戳键值），指向 history 中当前生效的快照。
 *   errors = 独立错误记录（启动失败，不记在快照条目里）。
 * 读取时从最老到最新链式重建完整清单（applyDiff 正向）；兼容旧版（current={deps,at} / 条目内 error）。
 */
function readSnapshot() {
  try {
    const s = JSON.parse(fs.readFileSync(FILE.snapshot(), 'utf8'))
    if (!s || typeof s !== 'object') return { history: [], current: null, errors: [], rollbacks: 0 }
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
        // 完整条目：diff 用存储值（记录时固定，不重算）；旧条目无存储 diff 时后续附加
        ordered.push({ deps: h.deps, at: h.at, note: h.note, diff: h.diff })
      } else {
        const prev = ordered.length > 0 ? ordered[ordered.length - 1].deps : {}
        ordered.push({ deps: applyDiff(prev, h.diff), diff: h.diff, at: h.at, note: h.note })
      }
    }
    const history = ordered.reverse() // 最新在前
    // 兼容：完整 deps 条目若无存储 diff（旧格式）→ 附加"相对更早版本"的差集（仅展示，不落盘）
    for (let i = 0; i < history.length; i++) {
      if (history[i].diff === undefined && history[i + 1]) {
        history[i].diff = diffDeps(history[i + 1].deps, history[i].deps)
      }
    }
    // 错误记录：只保留最新一条（视图只显示最新；历史错误在日志文件）；旧格式条目内 error → 迁移
    let errors = Array.isArray(s.errors)
      ? s.errors.filter((e) => e && typeof e.detail === 'string').map((e) => ({ ...e }))
      : []
    for (const h of history) {
      if (h.error && typeof h.error.detail === 'string') {
        errors.push({ at: h.error.at || h.at, detail: h.error.detail, stderr: h.error.stderr })
        delete h.error
      }
    }
    errors = errors.slice(-1) // 只留最新一条
    // current 指针：新格式 = 时间戳键值；旧格式 {deps,at} → 按 deps/at 匹配
    let current = null
    if (typeof s.current === 'string' && s.current !== '') {
      current = s.current
    } else if (s.current && typeof s.current.at === 'string') {
      current = s.current.at
    } else if (s.current && typeof s.current.deps === 'object') {
      const m = history.find((h) => depsEqual(h.deps, s.current.deps))
      current = m ? m.at : (history.length > 0 ? history[0].at : null)
    } else if (history.length > 0) {
      current = history[0].at
    }
    return {
      history,
      current,
      errors,
      rollbacks: typeof s.rollbacks === 'number' ? s.rollbacks : 0,
      // 最近一次失败过程的完整回滚序列（新一次失败整组覆盖旧组）
      rollbackLog: s.rollbackLog && Array.isArray(s.rollbackLog.entries)
        ? { startedAt: s.rollbackLog.startedAt, entries: s.rollbackLog.entries.filter((e) => e && typeof e.detail === 'string') }
        : null,
      // 唤醒病历（与 marker incidents 同步持久化；视图"最近唤醒记录"）
      wakeLog: s.wakeLog && Array.isArray(s.wakeLog.entries)
        ? { startedAt: s.wakeLog.startedAt, entries: s.wakeLog.entries.filter((e) => e && typeof e.detail === 'string') }
        : null,
    }
  } catch { return { history: [], current: null, errors: [], rollbacks: 0, rollbackLog: null, wakeLog: null } }
}

function writeSnapshot(s) {
  try {
    // 序列化（git commit 风格）：**所有条目统一只存相邻差集**——
    //   diff = 该版本相对更早版本（history[i+1]）带来的变化（+ 方向）；
    //   最老条目相对空清单（第一次变化 = 全部 added）；
    //   无变化条目跳过（不留冗余快照）。
    // 完整 deps 不在磁盘存储：读取时从最老到最新链式组合（applyDiff）临时重建。
    // 快照条目不含错误（错误独立存 errors 数组）。
    const history = Array.isArray(s.history) && s.history.length > 0
      ? s.history.map((h, i) => {
        const prev = i + 1 < s.history.length ? s.history[i + 1].deps : {}
        const diff = diffDeps(prev, h.deps) // 相对更早版本（+ 方向）；最老相对空
        if (diff.added.length === 0 && diff.removed.length === 0) return null
        return { diff, at: h.at, note: h.note }
      }).filter(Boolean)
      : []
    const payload = {
      history,
      current: s.current, // 唯一指针：时间戳键值
      errors: Array.isArray(s.errors) ? s.errors : [],
      rollbacks: s.rollbacks,
      rollbackLog: s.rollbackLog,
      wakeLog: s.wakeLog,
    }
    fs.writeFileSync(FILE.snapshot(), JSON.stringify(payload, null, 2) + '\n', 'utf8')
  } catch (e) { log('guard: writeSnapshot THREW ' + String(e)) }
}

function log(msg) {
  try { fs.appendFileSync(FILE.log(), `${new Date().toISOString()} ${msg}\n`, 'utf8') } catch { /* best-effort */ }
}

/** 读取当前代际 stderr 文件全文（全量捕获，不截断——具体错误信息，供 error 记录/唤醒病历）。 */
function readStderr() {
  try {
    return fs.readFileSync(stderrFile(), 'utf8').trim()
  } catch { return '' }
}

/** 清空当前代际 stderr 文件（新代际/启动成功后）。 */
function clearStderrLog() {
  try { fs.writeFileSync(stderrFile(), '', 'utf8') } catch { /* best-effort */ }
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

/** 把重启过程记录（错误/回滚等）追加到唤醒 marker——唤醒时作为消息的一部分发给 agent。
 *  两级信息：detail = 一级概要（第一代即可知）；stderr = 二级具体报错（第一代经 pipe 捕获）。
 *  只有概要（如 client 404 探测失败）时 stderr 省略。 */
function recordIncident(detail, stderr) {
  try {
    const marker = JSON.parse(fs.readFileSync(FILE.resume(), 'utf8'))
    if (!marker || typeof marker !== 'object') return
    const incidents = Array.isArray(marker.incidents) ? marker.incidents : []
    incidents.push(stderr ? { at: new Date().toISOString(), detail, stderr } : { at: new Date().toISOString(), detail })
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
    return '  · ' + (t ? t + ' ' : '') + i.detail + (i.stderr ? '\n      具体报错：' + i.stderr.replace(/\n/g, '\n      ') : '')
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
/** 安排的发起者会话 id（agent 工具调用时记录；cancel 只允许发起者撤销）。 */
let pendingActionOwner = null

/**
 * 会话活动追踪：记录最近活动时间，**仅用于关闭/重启等待时的进度标注**
 * （区分活跃/疑似卡住的 running 会话），不参与唤醒判定——
 * 唤醒目标 = 安排重启的那个会话（发起者），见 checkIdleAndExit。
 */
const sessionActivity = new Map() // sessionId -> lastActivityAt

/** 追踪会话活动：agent/status 转换 + 真实对话事件（user/message、turn/start/end）。 */
function trackSessionActivity(ctx) {
  try {
    ctx.effect(() => ctx.on('agent/status', (payload) => {
      if (payload && payload.agent && typeof payload.agent.id === 'string') {
        sessionActivity.set(payload.agent.id, Date.now())
      }
    }), 'dsh-graceful-restart: agent/status activity tracker')
    ctx.effect(() => ctx.on('session/event', (session, event) => {
      if (!session || typeof session.id !== 'string') return
      if (event && (event.type === 'user/message' || event.type === 'turn/start' || event.type === 'turn/end')) {
        sessionActivity.set(session.id, Date.now())
      }
    }), 'dsh-graceful-restart: session/event activity tracker')
  } catch (e) { log('activity: listener THREW ' + String(e)) }
}

/** 本进程由外部 launcher（launcher.cjs）或内部 wrapper（自动套壳）拉起：
 *  IPC 通知父进程即可（杀旧 + 同控制台拉起新实例），无需 executor。 */
const LAUNCHER_MODE = process.env.DSH_LAUNCHED_BY === 'dsh-graceful-restart-launcher' || process.env.DSH_LAUNCHER_WRAPPER === '1'

function scheduleExit(ctx, action, ownerId) {
  // 如果已有未完成的安排，但执行器已失效（进程退出/超时），重置后重新安排
  if (pendingAction) {
    const alive = executorChild !== null && executorChild.exitCode === null && executorChild.signalCode === null
    if (!alive) {
      log('previous pending action (' + pendingAction + ') executor dead, resetting')
      pendingAction = null
      exitArmed = false
      executorChild = null
      pendingActionOwner = null
    } else {
      log('already pending action (' + pendingAction + '), ignoring new ' + action)
      return
    }
  }
  pendingAction = action
  pendingActionOwner = ownerId || null
  const actionLabel = action === 'shutdown' ? '关闭' : action === 'restart-wake' ? '重启+唤醒' : '重启'
  log('exit scheduled (' + action + ') owner=' + (pendingActionOwner || '(none)') + ', waiting for turns to finish')
  console.log('[dsh-graceful-restart] ' + actionLabel + '已安排：等当前轮次结束后'
    + (action === 'shutdown' ? '进程退出（不重启）。' : '进程退出并拉起新一代。')
    + '等待期间终端将显示进度。')
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
      console.log('[dsh-graceful-restart] 等待超时（70s）：'
        + (pendingAction === 'shutdown' ? '仍有会话在运行，关闭安排已重置' : '仍有会话在运行，重启安排已重置')
        + '。如需继续，请再次触发。')
      pendingAction = null
      exitArmed = false
      executorChild = null
      pendingActionOwner = null
    }
  }, 70000)
}

/**
 * 撤销已安排但尚未执行的重启/关闭（进程退出前可调用）。
 * 只允许安排的发起者撤销——其他会话（如被唤醒的并行会话）无权取消
 * 本会话发起的关闭/重启（曾出现：另一会话主动 cancel 导致关闭未生效）。
 * @param callerId - 调用者会话 id（工具 execute 的 exec.agent?.id）；非 agent 调用（undefined）视为发起者本人。
 *  @returns {{ok: true, previous: string} | {ok: false, reason: 'armed' | 'none' | 'forbidden'}} */
function cancelPendingExit(callerId) {
  if (exitArmed) return { ok: false, reason: 'armed' } // 退出流程已触发，无法撤销
  if (!pendingAction) return { ok: false, reason: 'none' }
  if (pendingActionOwner && callerId && callerId !== pendingActionOwner) {
    log('cancel DENIED: caller ' + callerId + ' != owner ' + pendingActionOwner)
    return { ok: false, reason: 'forbidden' }
  }
  const previous = pendingAction
  pendingAction = null
  exitArmed = false
  if (executorChild) {
    try { executorChild.kill() } catch (e) { log('cancel: executor kill THREW ' + String(e)) }
    executorChild = null
  }
  pendingContinuePrompt = null
  pendingActionOwner = null
  const label = previous === 'restart-wake' ? '重启+唤醒' : previous === 'restart' ? '重启' : '关闭'
  log('cancel: pending action (' + previous + ') cancelled' + (callerId ? ' by ' + callerId : ''))
  console.log('[dsh-graceful-restart] ' + label + '安排已取消，进程将继续运行。')
  return { ok: true, previous }
}

let lastWaitPrint = 0
function checkIdleAndExit(ctx) {
  if (!pendingAction || exitArmed) return
  const running = ctx.agents.list().filter((agent) => agent.status === 'running')
  if (running.length > 0) {
    log('still running agents: ' + running.map((a) => a.id).join(', '))
    // 终端可见的等待进度（每 5s 一次，避免刷屏）：
    // 之前有用户反馈"安排关闭后终端没有任何输出，以为没生效"——这里明确打印在等谁。
    // 注意：绝不超时强制关闭——显式等所有轮次结束（可能很久），
    // 由用户自行决定是否再次触发/取消；只有 70s 兜底重置（见 scheduleExit）。
    const now = Date.now()
    if (now - lastWaitPrint >= 5000) {
      lastWaitPrint = now
      const label = pendingAction === 'shutdown' ? '关闭' : pendingAction === 'restart-wake' ? '重启+唤醒' : '重启'
      // 区分活跃/闲置的 running 会话：闲置会话可能是被唤醒后卡住的（如并行验证会话）
      const idleRunning = running.filter((a) => (sessionActivity.get(a.id) || 0) < now - 60000)
      console.log('[dsh-graceful-restart] ' + label + '等待中：还有 ' + running.length + ' 个会话在运行（'
        + running.map((a) => String(a.id).slice(0, 8)).join(', ') + '）'
        + (idleRunning.length > 0
          ? '；其中 ' + idleRunning.map((a) => String(a.id).slice(0, 8)).join(', ')
            + ' 已超过 60s 无活动——若确认为卡住会话，可对其实行取消（/cancel 或 cancel_harness_action 由发起会话执行）'
          : '')
        + '，轮次结束后自动执行...')
    }
    return
  }
  lastWaitPrint = 0
  log('all agents idle, action=' + pendingAction)
  console.log('[dsh-graceful-restart] 所有会话已空闲，执行'
    + (pendingAction === 'shutdown' ? '关闭' : pendingAction === 'restart-wake' ? '重启+唤醒' : '重启') + '...')
  exitArmed = true
  // 记录唤醒目标：**只唤醒安排重启的那个会话（发起者）**——重启是某个会话
  // 主动发起的，恢复时只需要它继续；其他会话（并行/空会话/闲置）一律不唤醒
  // （曾出现：空会话被 marker 记录唤醒后失控跑工具循环阻塞重启）。
  // 非 agent 发起（如 Web 端点触发，ownerId 为空）→ 无唤醒目标，只重启不唤醒。
  if (pendingAction === 'restart-wake') {
    try {
      const ids = pendingActionOwner ? [pendingActionOwner] : []
      const marker = { sessionIds: ids, at: new Date().toISOString() }
      // agent 触发重启时传入的继续提示（优先于 settings 配置）
      if (pendingContinuePrompt) marker.prompt = pendingContinuePrompt
      fs.writeFileSync(FILE.resume(), JSON.stringify(marker), 'utf8')
      log('resume marker written: ' + (ids.join(', ') || '(none)') + (pendingContinuePrompt ? ' prompt=yes' : ''))
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

function tryResumeSessions(ctx, sessionIds, text, onResult) {
  if (!sessionIds || sessionIds.length === 0) {
    log('resume: no target sessions')
    if (typeof onResult === 'function') onResult(true)
    return
  }
  const pending = new Set(sessionIds)
  // 恢复策略（修复：目标会话无法恢复时不再无限轮询挂起——refresh 永不报告、
  // guard 永不 success、用户无感知）：
  //   1. 优先等 web 客户端重连后自动恢复（live agent 出现 → steer）；
  //   2. 迟迟不出现 → 主动 ctx.agents.resume 尝试恢复（限频 2s/次）；
  //   3. resume 连续失败 3 次（确定性失败，如历史损坏）→ 记录 detail 并放弃该会话；
  //   4. 全部处理完 → onResult(true, detail)——服务本身正常，不报 refresh-failed
  //      （避免触发插件回滚）；未恢复的会话记入 detail 供唤醒消息携带。
  const failed = [] // { sessionId, reason }
  const lastResumeAt = new Map() // sessionId -> ts
  const failCount = new Map() // sessionId -> 连续失败次数
  const interval = setInterval(() => {
    for (const sessionId of [...pending]) {
      const agent = ctx.agents.get(sessionId)
      if (agent) {
        try {
          agent.steer(buildContinueMessage(text))
          log('steered session ' + sessionId)
        } catch (error) {
          console.error('[dsh-graceful-restart] steer failed:', error)
          failed.push({ sessionId, reason: 'steer: ' + String(error && error.message || error) })
        }
        pending.delete(sessionId)
        continue
      }
      // agent 未出现：尝试主动恢复（限频）
      const last = lastResumeAt.get(sessionId) || 0
      if (Date.now() - last < 2000) continue
      lastResumeAt.set(sessionId, Date.now())
      ctx.agents.resume({ resumeSessionId: sessionId }).then((h) => {
        if (!pending.has(sessionId)) return
        const a = h && (h.agent ?? h)
        if (a) {
          try {
            a.steer(buildContinueMessage(text))
            log('steered session ' + sessionId + ' (resumed)')
          } catch (error) {
            console.error('[dsh-graceful-restart] steer failed:', error)
            failed.push({ sessionId, reason: 'steer: ' + String(error && error.message || error) })
          }
          pending.delete(sessionId)
        }
      }).catch((e) => {
        if (!pending.has(sessionId)) return
        const n = (failCount.get(sessionId) || 0) + 1
        failCount.set(sessionId, n)
        if (n >= 3) {
          log('resume: session ' + sessionId + ' 无法恢复（连续 ' + n + ' 次失败）: ' + (e && e.message))
          failed.push({ sessionId, reason: (e && e.message) || String(e) })
          pending.delete(sessionId)
        }
      })
    }
    if (pending.size === 0) {
      clearInterval(interval)
      const detail = failed.length > 0
        ? '唤醒会话部分失败: ' + failed.map((f) => f.sessionId + '（' + f.reason + '）').join('; ')
        : undefined
      log('resume: all sessions handled' + (failed.length > 0 ? ', ' + failed.length + ' failed' : ''))
      clearResumeMarker()
      if (typeof onResult === 'function') onResult(true, detail)
    }
  }, 500)
  ctx.effect(() => () => clearInterval(interval))
}

/* ------------------------------------------------------------------ */
/* 自动套壳（wrapper）：第一代 spawn 第二代并常驻为隐形 launcher        */
/* ------------------------------------------------------------------ */

/** 正式服务端口（与 bundle patch 中的 webserver port 表达式一致）。 */
const TARGET_PORT = 3080

/* ------------------------------------------------------------------ */
/* 刷新阶段故障判断（第二代自检）：连接就绪探测                         */
/* ------------------------------------------------------------------ */

/** 判断插件是否有 client 半（有 client 声明且 exports["./client"]）——探测只针对这类。 */
function hasClientHalf(pkg, profileDirPath) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(profileDirPath, 'node_modules', pkg, 'package.json'), 'utf8'))
    return !!(p.dsh && p.dsh.client && p.dsh.client.platform === 'web' && p.exports && p.exports['./client'])
  } catch { return false }
}

/** 探测一个插件的 client bundle（页面级启动失败检测）：
 *  只做 HTTP 可达性检查（页面能取到 bundle 文件的最基本前提）——
 *  不检查 bundle 内容写法（不规定其他插件怎么写）。
 *  返回 null = 就绪；否则返回失败原因。 */
async function probeClientBundle(pkg) {
  const res = await fetch('http://127.0.0.1:' + TARGET_PORT + '/plugins/' + pkg + '/client.js', {
    signal: AbortSignal.timeout(3000),
  })
  if (!res.ok) return 'HTTP ' + res.status
  return null // 就绪
}

/** 启动失败特征（第一代扫描第二代 stdout/stderr 的 boot 输出）：
 *  不依赖静态猜测——client/插件加载失败的**真实错误输出**本身就是信号：
 *    "Failed to load plugins" / "failed to import loader entry" / "plugin tree failed"
 *    以及 boot 早期的 SyntaxError/ReferenceError（如 exports is not defined）。
 *  这些特征只出现在启动阶段，正常运行输出不会有。 */
const BOOT_FAILURE_PATTERNS = [
  /Failed to load plugins/i,
  /failed to import loader entry/i,
  /plugin tree failed/i,
  /failed to apply loader entry/i,
]

/** 判断一段启动输出是否含 boot 失败特征；命中返回匹配文本（用于错误记录），否则 null。 */
function detectBootFailure(chunk) {
  for (const re of BOOT_FAILURE_PATTERNS) {
    const m = chunk.match(re)
    if (m) return m[0]
  }
  return null
}

/** 当前 profile 全部有 client 半的插件（刷新自检目标）。 */
function clientHalfPackages(profileDirPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDirPath, 'package.json'), 'utf8'))
    return Object.keys(pkg.dependencies || {}).filter((p) => hasClientHalf(p, profileDirPath))
  } catch { return [] }
}

/** 打开一条 downlink-only WebSocket（浏览器 /api/events.mux|host 同款），open 即关闭。
 *  模拟浏览器的"流建立"判定（onOpen）；失败返回 false。 */
function probeWs(url) {
  return new Promise((resolve) => {
    let socket
    try {
      socket = new WebSocket(url)
    } catch {
      resolve(false)
      return
    }
    const timer = setTimeout(() => {
      try { socket.close() } catch { /* already closed */ }
      resolve(false)
    }, 5000)
    socket.onopen = () => {
      clearTimeout(timer)
      try { socket.close() } catch { /* already closed */ }
      resolve(true)
    }
    socket.onerror = () => {
      clearTimeout(timer)
      resolve(false)
    }
  })
}

/** 连接就绪探测：完全复刻浏览器连接就绪判定（错误页 = 该判定失败）——
 *  1) host.describe RPC 成功；2) /api/events.mux、/api/events.host 双 WebSocket 均能建立。
 *  返回 null = 就绪；否则返回失败原因。 */
async function probeConnectionReady() {
  const base = 'http://127.0.0.1:' + TARGET_PORT
  try {
    const rpcId = 'probe-' + randomUUID()
    const res = await fetch(base + '/api/host.describe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'host.describe', payload: {} }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return 'host.describe HTTP ' + res.status
    const body = await res.json()
    if (!body || !body.result || body.result.ok !== true) return 'host.describe 未返回 ok'
    for (const p of ['/api/events.mux', '/api/events.host']) {
      const ok = await probeWs('ws://127.0.0.1:' + TARGET_PORT + p)
      if (!ok) return 'WebSocket ' + p + ' 未能建立'
    }
    return null
  } catch (e) {
    return '探测异常：' + String((e && e.message) || e)
  }
}

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
async function wrapperApply(ctx) {
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
    log('wrapper: first generation listened port ' + (listened || 'random') + ' (target ' + TARGET_PORT + ')')
  } catch (e) { log('wrapper: port check THREW ' + String(e)) }

  // spawn 前释放端口：关闭第一代 webServer 的 HTTP 监听（server.close 直接关闭
  // 底层 node:http server——WebServer 无公开 stop，server 为普通实例字段），
  // 保证 spawn 第二代时第一代零端口占用，与第二代端口配置完全无冲突。
  // 失败不致命（patch 已 port 0 随机兜底），仅记录。
  try {
    const webServer = ctx.get('webServer')
    if (webServer && webServer.server && typeof webServer.server.close === 'function') {
      await new Promise((resolve) => {
        try { webServer.server.close(() => resolve()) } catch { resolve() }
      })
      log('wrapper: webServer closed, first generation holds no port')
    }
  } catch (e) { log('wrapper: webServer close THREW ' + String(e)) }
  console.log('[dsh-graceful-restart] 第一代 wrapper：正在启动正式 dsh（几秒内完成）...')

  // ---- 启动守护：快照链（按时间排序）+ 唯一指针 current（时间戳键值） ----
  // 结构：{ history: [{deps, at}, ...]（最新在前）, current: <at>, errors: [...] }
  // 每次 spawn：扫描实际清单 vs current 指向快照 → 差集空不变化 / 非空建新快照 + current 指向；
  // 启动失败：错误独立记录（errors）→ current 向后移一条 → 删除 current 之后的快照 → 差集逆操作 → 重试；
  // 正常启动成功 → 不再操作快照。
  const profile = profileName()
  const snapshot = readSnapshot()
  let history = snapshot.history
  // 唯一指针：current = 时间戳键值，指向 history 中当前生效的快照
  let current = snapshot.current || (history.length > 0 ? history[0].at : null)
  let errors = snapshot.errors || [] // 独立错误记录（不记在快照里）
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
  // 唤醒病历（持久化）：与 marker incidents 同步记录，视图显示"最近唤醒记录"。
  // 与 rollbackLog 同生命周期（新失败周期覆盖）。
  let wakeLog = snapshot.wakeLog || null
  const logWake = (detail, newGroup) => {
    if (newGroup || !wakeLog) {
      wakeLog = { startedAt: new Date().toISOString(), entries: [] }
    }
    wakeLog.entries.push({ at: new Date().toISOString(), detail })
    log('guard: wakeLog: ' + detail)
  }

  // 第一代不再注册设置段（回滚无上限；continuePrompt 由第二代读取）。
  // current 指向的快照 deps（指针失效时回退到最新快照）
  const currentDeps = () => {
    const e = history.find((h) => h.at === current)
    return e ? e.deps : (history.length > 0 ? history[0].deps : {})
  }
  const persist = () => writeSnapshot({
    history,
    current,
    errors,
    rollbacks,
    rollbackLog,
    wakeLog,
  })
  persist()
  log('guard: current=' + current + ' deps [' + Object.keys(currentDeps()).join(', ') + ']')
  log('guard: baseline history ' + history.length + ' version(s)'
    + (history.length ? ' [' + history.map((h) => Object.keys(h.deps).join('|')).join('] <- [') + ']' : ' (none)'))

  let child = null
  let restarting = false
  let pendingWake = false
  let deliberateExit = false
  let spawnedAt = 0
  let successTimer = null
  // 本次 spawn 引入的新插件（client probe 检测目标；差集为空则无）
  let lastAdded = []
  // 刷新阶段确认（第二代 IPC）：refresh-ok = 连接/会话就绪自检通过；refresh-failed = 失败原因。
  // 成功判定 = 宽限期存活 AND refresh-ok（两阶段统一判断，缺一不算成功）。
  let refreshOk = false
  // 刷新失败原因：exit 处理器以它构造 failDetail（而非"退出码非 0"的启动失败文案）
  let pendingFailureDetail = null

  // Ctrl+C（控制台组信号）：用户操作 → 不判定启动失败。
  // Node 注册 SIGINT handler 后默认退出行为被取代，需自行退出。
  process.on('SIGINT', () => {
    deliberateExit = true
    log('wrapper: SIGINT received')
    try { if (child) child.kill() } catch {}
    setTimeout(() => process.exit(0), 3000).unref() // 兜底：child 若未在 3s 内退出
  })

  // 两阶段统一成功判定：启动阶段（宽限期存活）AND 刷新阶段（第二代 refresh-ok）。
  // 第二代存活超过宽限期且连接/会话就绪自检通过 → 启动成功。正常启动后不再操作快照：
  // 快照/指针在 spawn 时已定（差集空 → 不动；非空 → 新快照 + current 指向）。
  // 这里只做收尾：清空 stderr log、若曾回滚则追加"恢复成功"记录。
  const markSuccess = () => {
    successTimer = null
    if (!child || child.exitCode !== null) return
    if (Date.now() - spawnedAt < STARTUP_GRACE_MS) {
      log('guard: grace not passed yet, waiting before success')
      return
    }
    if (!refreshOk) {
      log('guard: refresh-ok not received yet, waiting before success')
      return
    }
    log('guard: second generation alive past grace + refresh ok, marking success')
    clearStderrLog() // 启动成功：清空 stderr log（避免旧报错残留）
    // 若存在回滚记录 → 追加"恢复成功"（组保留到下次失败整组覆盖）
    if (rollbackLog) logRollback('重试成功，服务恢复', false)
    if (wakeLog) logWake('重试成功，服务恢复', false)
    persist()
    log('guard: success, current=' + current + ', history ' + history.length + ' version(s)')
  }

  // 回滚"当前清单 vs 目标快照"的差集逆操作（官方 CLI：node bin.js plugin --profile <p> remove/add <pkg>）：
  // 插件是整包粒度，逆操作只有两类：
  //   added   实际有、目标没有 → 卸载
  //   removed 实际没有、目标有（含版本更换的旧版）→ 装回目标版本
  // 版本更换（同包名版本/地址不同）= 卸载实际版本（removed 侧）+ 装回目标版本（added 侧）
  const rollbackPlugins = (candidate, baseline) => {
    const diff = diffDeps(candidate, baseline)
    const added = diff.added // 目标有、实际没有（或版本不同 → 装回目标版本）
    const removed = diff.removed // 实际有、目标没有（或版本不同 → 卸载实际版本）
    if (added.length === 0 && removed.length === 0) return { added: [], removed: [] }
    console.log('[dsh-graceful-restart] 启动失败，自动回滚该快照之后的变更：'
      + '卸载 ' + (removed.map((r) => r.name).join(', ') || '(无)')
      + (added.length ? '；装回 ' + added.map((a) => a.name).join(', ') : ''))
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
    // 装回/恢复的 add 参数：file:/link:/github: 等完整 spec 可裸传（pnpm 按包名注册）；
    // 纯版本号（如 0.12.1）必须带包名：pkg@spec
    const addSpec = (pkg, spec) => /^(file|link|github|http|https|git|workspace):/.test(String(spec))
      ? String(spec)
      : pkg + '@' + String(spec)
    // 先卸载（实际有、目标没有；含版本更换的旧版），再装回（目标版本）
    for (const r of removed) {
      log('guard: removing ' + r.name + (r.version !== undefined ? '@' + r.version : ''))
      if (runCli(['remove', r.name])) log('guard: removed ' + r.name)
      else log('guard: remove ' + r.name + ' FAILED')
    }
    for (const a of added) {
      const spec = a.version
      log('guard: re-adding ' + a.name + ' → ' + spec)
      if (runCli(['add', addSpec(a.name, spec)])) log('guard: re-added ' + a.name)
      else log('guard: re-add ' + a.name + ' FAILED')
    }
    return { added: added.map((a) => a.name), removed: removed.map((r) => r.name) }
  }

  // 本次 spawn 引入的新插件（spawnChild 差集非空时记录；client probe 检测目标）
  const newlyAdded = () => lastAdded

  // 探测新增插件的 client bundle（页面级启动失败检测）+ 唤醒闸门：
  // 宿主进程可能正常起来（退出码 0），但页面加载其 client 脚本 404/失败——
  // 页面级"半启动失败"。探测失败 → 主动杀第二代 → 走现有回滚路径。
  // 探测全部通过（或无新增）→ IPC {type:'probe-ok'} 放行第二代的唤醒——
  // 避免坏代提前唤醒 + 重试代再次唤醒的重复唤醒。
  const scheduleClientProbe = (childRef) => {
    const added = newlyAdded().filter((pkg) => hasClientHalf(pkg, profileDir()))
    if (added.length === 0) {
      // 无新增插件：短暂等待第二代就绪后直接放行唤醒
      setTimeout(() => {
        if (!childRef || childRef.exitCode !== null) return
        try { childRef.send({ type: 'probe-ok' }) } catch { /* child 已死 */ }
      }, 3000)
      return
    }
    log('guard: client probe targets [' + added.join(', ') + ']')
    // 持续探测直到成功（无次数上限、无时间窗口——webServer 监听是必然趋势，
    // 禁止超时判断）：全部可达 → 放行唤醒。探测是文件存在性检测（HTTP 200），
    // 失败只说明 bundle 未就绪，不涉及"把正常判为错误"。
    const probeAll = async () => {
      if (!childRef || childRef.exitCode !== null) return // 已退出：由 exit 路径处理
      let allOk = true
      for (const pkg of added) {
        try {
          const reason = await probeClientBundle(pkg)
          if (reason) {
            log('guard: probe ' + pkg + ' not ready: ' + reason)
            allOk = false
          }
        } catch (e) {
          log('guard: probe ' + pkg + ' net error: ' + String(e && e.message || e))
          allOk = false
        }
      }
      if (!allOk) {
        setTimeout(probeAll, 2000)
        return
      }
      // 全部探测通过 → 放行唤醒
      try { if (childRef && childRef.exitCode === null) childRef.send({ type: 'probe-ok' }) } catch { /* child 已死 */ }
    }
    setTimeout(probeAll, 5000)
  }

  // 失败回滚前的 marker 保全：病历追加 + （若坏代已消费清除 marker）用备份重建，
  // 保证重试代能唤醒并拿到完整病历。同时持久化唤醒病历（wakeLog，视图显示）。
  let markerBackup = null
  const restoreMarkerForRetry = (detail, stderr) => {
    recordIncident(detail, stderr) // marker 存在 → 追加病历
    logWake(detail, !wakeLog) // 持久化唤醒病历（视图"最近唤醒记录"）
    if (!fs.existsSync(FILE.resume()) && markerBackup && markerBackup.sessionIds.length > 0) {
      const m = { sessionIds: markerBackup.sessionIds, at: new Date().toISOString() }
      if (markerBackup.prompt) m.prompt = markerBackup.prompt
      const incidents = Array.isArray(markerBackup.incidents) ? [...markerBackup.incidents] : []
      incidents.push(stderr ? { at: new Date().toISOString(), detail, stderr } : { at: new Date().toISOString(), detail })
      m.incidents = incidents
      try {
        fs.writeFileSync(FILE.resume(), JSON.stringify(m), 'utf8')
        log('guard: marker restored for retry wake (sessions=' + m.sessionIds.length + ')')
      } catch (e) { log('guard: marker restore THREW ' + String(e)) }
    }
  }

  // 业务插件排除（第一代零业务插件）：由 bundle patch 的条件 disabled 在配置合成时
  // 完成（第一代无 DSH_LAUNCHER_WRAPPER → disabled → 根本不加载），
  // 不需要运行时拆树（拆树受 boot 校验约束且有时序风险）。
  // 第一代 = 官方 core（闲置无副作用）+ 自身；端口在 spawn 前已释放。
  const spawnChild = (wake, rollbackRetry = false) => {
    // 每次 spawn 都重读清单：重启期间可能新装了插件（导致失败），
    // 判定必须基于最新 dependencies。
    // 正常启动时扫描全部插件 vs current 指向的快照：
    //   差集为空 → 不变化（current 不动）；
    //   差集非空 → 先删除比 current 新的条目（回滚遗留的失败尝试），
    //              再建立新快照（修改快照链），current 指针指向新快照（向更新移动）。
    // 回滚重试（rollbackRetry=true）：**完全不修改快照链**——
    // 不新建、不删除、不移动 current。回滚的语义是"回到某个成功基线并验证它"，
    // 成功后 current 就停留在该基线；快照链只在正常启动（用户主动变更清单）时更新。
    // 若逆操作后实际清单与基线仍有差异（如包名漂移），保持 current 不动，
    // 由后续正常启动再对齐（包名漂移无关紧要——链代表意图状态，不要求与实际逐键一致）。
    newStderrFile() // 新代际：建立独立 stderr 文件（失败时读到的只是本次启动的输出，不累积）
    const latest = readProfileDeps()
    if (latest !== null) {
      if (rollbackRetry) {
        lastAdded = [] // 回滚重试不探测新增插件（逆操作已卸载）
        log('guard: rollback retry (snapshot chain untouched, current kept ' + current + ', deps ['
          + Object.keys(currentDeps()).join(', ') + '])')
      } else {
        const curDeps = currentDeps()
        if (!depsEqual(curDeps, latest)) {
          // 新建前：删除比 current 新的条目（current 之前的索引），避免链上重复状态
          const curIdx = history.findIndex((h) => h.at === current)
          if (curIdx > 0) {
            log('guard: discarding ' + curIdx + ' snapshot(s) newer than current ' + current)
            history = history.slice(curIdx)
          }
          // 差集非空 → 新快照入列（最新在前），current 指向新快照
          const newAt = new Date().toISOString()
          history = [{ deps: latest, at: newAt }, ...history]
          current = newAt
          lastAdded = diffDeps(curDeps, latest).added.map((a) => a.name) // client probe 目标
          log('guard: new snapshot ' + newAt + ' (was ' + (history[1] ? history[1].at : '(none)') + ')')
        } else {
          lastAdded = []
        }
        persist()
        log('guard: refreshed current deps [' + Object.keys(latest).join(', ') + ']')
      }
    }
    markerBackup = readResumeMarker() // 备份唤醒 marker：失败回滚时可能已被坏代消费清除
    const args = process.argv.slice(1) // ['.../bin.js', 'web', ...]
    // 第二代 stdout+stderr → pipe → 转发回终端并扫描 boot 失败：
    //   · stderr 写入独立 log 文件（失败时取具体报错）
    //   · stdout 转发回用户终端（输出不变），同时扫描启动失败特征——
    //     client/插件加载失败时 dsh 启动早期打印 "Failed to load plugins" /
    //     "failed to import loader entry"（打在 stdout），这正是"错误页面"的
    //     底层信号。检测真实错误输出，比静态猜测全面。
    //   注意：stdio[2] 必须是 'pipe'（'inherit' 时 child.stderr 为 null）。
    child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        DSH_LAUNCHER_WRAPPER: '1',
        ...(wake ? { DSH_GRACEFUL_RESTART_WAKE: '1' } : {}),
      },
    })
    // boot 失败检测：仅在启动阶段（宽限期结束前）扫描 stdout/stderr 的失败特征。
    // 命中 → 记 pendingFailureDetail → kill 第二代 → exit 处理器走统一故障链。
    // 防止重复触发：同一次 spawn 只触发一次（bootFailureFired）。
    let bootFailureFired = false
    const scanBootOutput = (chunk) => {
      if (bootFailureFired || !child || child.exitCode !== null) return
      const hit = detectBootFailure(String(chunk))
      if (!hit) return
      // 仅启动阶段判定（宽限期后正常输出不再扫描）；避免把运行期误报当启动失败
      if (Date.now() - spawnedAt > STARTUP_GRACE_MS) return
      bootFailureFired = true
      const snippet = String(chunk).replace(/\s+/g, ' ').slice(0, 300)
      log('wrapper: BOOT FAILURE detected: ' + hit + ' | ' + snippet)
      console.log('[dsh-graceful-restart] 检测到启动失败输出（' + hit + '），自动回滚...')
      pendingFailureDetail = '启动输出检测到失败（' + hit + '）：' + snippet
      try { child.kill() } catch {}
    }
    child.stdout.on('data', (c) => {
      process.stdout.write(c) // 转发回用户终端（输出不变）
      scanBootOutput(c)
    })
    child.stderr.on('data', (c) => {
      try { fs.appendFileSync(stderrFile(), c) } catch { /* best-effort */ }
      process.stderr.write(c) // 转发回用户终端（输出不变）
      scanBootOutput(c)
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
      } else if (msg.type === 'refresh-ok') {
        // 刷新阶段自检通过（连接就绪 + 会话恢复）：参与成功判定
        log('wrapper: refresh-ok received')
        refreshOk = true
        markSuccess()
      } else if (msg.type === 'refresh-failed') {
        // 刷新阶段自检失败（第二代主动上报）→ 走统一故障链：
        // 记 errors → current 回退 → 差集逆操作 → 重试（与启动失败同一套逻辑）
        log('wrapper: refresh-failed: ' + msg.detail)
        console.log('[dsh-graceful-restart] 刷新就绪自检失败：' + msg.detail + '，自动回滚...')
        pendingFailureDetail = '刷新阶段自检失败（' + msg.detail + '）'
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
      const hadRefreshFailure = pendingFailureDetail !== null
      const failed = code !== 0 || elapsed < STARTUP_GRACE_MS || hadRefreshFailure
      // 启动失败 → 错误独立记录（errors，不记在快照里）→ current 向更早移一条（不修改快照）
      // → 对差集做逆操作（把插件清单恢复到 current 指向的快照）→ 重试；无更早快照 → 放弃。
      if (failed) {
        // 刷新阶段自检失败时以第二代的失败原因作为 failDetail（而非"退出码"文案）
        const failDetail = pendingFailureDetail
          || '第二代启动失败（退出码 ' + code + '，' + Math.round(elapsed / 1000) + 's）'
        pendingFailureDetail = null
        const failStderr = readStderr()
        // 错误记录只保留最新一条（视图只显示最新；历史错误在日志文件 dsh-graceful-restart.log）
        errors = [{ at: new Date().toISOString(), detail: failDetail, ...(failStderr ? { stderr: failStderr } : {}) }]
        // 循环回滚：从 current 起逐条向更早（索引 +1）尝试——
        //   1. 逆操作：把实际清单恢复到该快照的 deps（CLI remove/add）
        //   2. 验证：逆操作后实际清单必须与目标基线**完全一致**（depsEqual）。
        //      不一致（如包名漂移：基线键 @my/wake-trigger 但 pnpm 按目录 name 注册为
        //      dsh-waker-trigger，装回后键仍不一致）→ 本次回滚**未达基线**，视作失败，
        //      继续向更早的快照回滚（不 spawn 重试——清单不对重试必败）。
        //   3. 达到基线 → current 移到该快照 → spawnChild(pendingWake, true) 重试。
        // 快照链（history 数组）在整个回滚过程中**不修改**——current 只是指针移动。
        // 防循环由"逆操作验证"承担（不达基线就继续向更早，不会在同一快照反复卸载装回）。
        const curIdx = history.findIndex((h) => h.at === current)
        let prevIdx = curIdx + 1
        let rollbackOk = false
        while (prevIdx < history.length) {
          const target = history[prevIdx].deps
          // 差集逆操作：把实际清单恢复到目标快照（撤销本次尝试的变更）
          const actual = readProfileDeps()
          const diff = rollbackPlugins(actual !== null ? actual : target, target)
          const after = readProfileDeps()
          const reached = after !== null && depsEqual(after, target)
          const desc = [...diff.removed.map((k) => k), ...diff.added.map((k) => k)].join(', ')
          if (!reached) {
            // 逆操作未达基线（包名漂移/CLI 失败等）→ 记录并继续向更早
            rollbacks++
            log('guard: rollback to ' + history[prevIdx].at + ' did NOT reach baseline'
              + ' (actual [' + Object.keys(after || {}).join(', ') + '] vs target [' + Object.keys(target || {}).join(', ') + ']), continuing earlier')
            logRollback(failDetail + ' → 回滚 #' + rollbacks + '：卸载 ' + (desc || '(无)')
              + '（回到 ' + history[prevIdx].at + '）后清单与基线不一致，继续向更早', rollbacks === 1)
            console.log('[dsh-graceful-restart] 回滚到 ' + history[prevIdx].at + ' 后清单与基线不一致'
              + '（可能包名漂移），继续向更早回滚...')
            prevIdx++
            continue
          }
          // 达到基线：current 移动到该快照（指针移动，链不修改）
          rollbacks++
          current = history[prevIdx].at
          const detail = '回滚 #' + rollbacks + '：卸载 ' + (desc || '(无)') + '（回到 ' + current + '）'
          restoreMarkerForRetry(failDetail + '，自动回滚卸载：' + (desc || '(无)') + '（回到 ' + current + '）', failStderr)
          logRollback(failDetail + ' → ' + detail, rollbacks === 1)
          console.log('[dsh-graceful-restart] ' + failDetail
            + '，第 ' + rollbacks + ' 次回滚重试（回到 ' + current + '）...')
          persist()
          // 回滚重试也带上未消费的唤醒请求（重启 marker 仍在，恢复后继续唤醒）；
          // rollbackRetry=true：不建新快照、不移动 current（回滚语义 = 回到基线验证）
          spawnChild(pendingWake, true)
          rollbackOk = true
          return
        }
        if (rollbackOk) return
        // 所有快照均无法达到（或无更早快照）→ 放弃
        const detail = failDetail + '，'
          + (history.length > 0 ? '已回滚 ' + rollbacks + ' 次，未能恢复，请手动检查' : '且没有可用快照，请手动检查')
        persist()
        logRollback(detail, !rollbackLog)
        console.log('[dsh-graceful-restart] ' + failDetail + '，'
          + (history.length > 0 ? '已回滚 ' + rollbacks + ' 次，请手动检查（wrapper 保持运行）' : '且没有可用快照，请手动检查（wrapper 保持运行）'))
        log('guard: giving up, rollbacks=' + rollbacks + ', current=' + current)
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

  // 拆根（第一代变空壳）：remove('include', true) 一个调用拆掉整棵树
  // （含自身与全部插件）——零插件名、通用、与任何插件零关系。
  // 时机（只依赖第一代自身状态，与第二代完全无关）：
  //   约束 = 必须晚于第一代 boot 的 assertEntriesActivated 校验
  //   （启动阶段拆根会因"条目 fiber 缺失"被判 did-not-activate 导致崩溃，实测）。
  //   信号 = await ctx.loader.tree.await() —— 与 boot 的 await 共享同一完成条件
  //   （所有条目的 initTask/inertia 真实结束），resolve 时 boot 的 await 也已
  //   resolve（微任务序：boot 先注册先恢复 → 校验同步先跑）→ 我们恢复 → 拆根安全。
  //   ★ 不能用 fiber.state 轮询：启动早期未创建的 fiber 会被漏判，过早触发（实测崩溃）。
  //   10s 超时兜底防极端卡住。
  try {
    const loaderSvc = ctx.get('loader')
    const tree = loaderSvc && loaderSvc.tree
    const useAwait = !!(tree && typeof tree.await === 'function')
    log('wrapper: prune setup loader=' + (loaderSvc ? 'yes' : 'no') + ' tree.await=' + (useAwait ? 'yes' : 'NO'))
    if (loaderSvc && typeof loaderSvc.remove === 'function') {
      ;(async () => {
        try {
          if (useAwait) {
            await Promise.race([
              tree.await(),
              new Promise((r) => setTimeout(r, 10000)),
            ])
            log('wrapper: tree.await settled, pruning root')
          } else {
            // 兜底：拿不到 tree.await 时用 1.5s 延迟（15:10 轮实证的成功组合）
            await new Promise((r) => setTimeout(r, 1500))
          }
          await loaderSvc.remove('include', true)
          log('wrapper: root pruned (first generation is a bare process)')
        } catch (e) { log('wrapper: root prune THREW ' + String(e)) }
      })()
    }
  } catch (e) { log('wrapper: root prune THREW ' + String(e)) }
}

export async function apply(ctx) {
  log(`apply: start pid=${process.pid}`)
  try { writeProcessIndex(); log('apply: process index written') } catch (e) { log('apply: index THREW ' + String(e)) }

  // 第一代（用户直接启动）：释放端口 → spawn 第二代 → 常驻 launcher（boot 后拆树变空壳）
  if (process.env.DSH_LAUNCHER_WRAPPER !== '1') {
    try { await wrapperApply(ctx) } catch (e) { log('apply: wrapper THREW ' + String(e)) }
    return
  }
  log('apply: second generation (wrapper child), normal mode')
  console.log('[dsh-graceful-restart] 正式 dsh 实例（第二代）开始服务'
    + '（启动时间 ' + new Date(STARTED_AT).toLocaleString('zh-CN', { hour12: false }) + '）')

  // 活跃会话追踪：重启唤醒只针对"最近活跃"的会话（闲置的旧测试会话不唤醒）
  trackSessionActivity(ctx)
  log('apply: session activity tracking enabled')

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
  // 唤醒 marker（重启前记录的活跃会话 + 继续提示）；非唤醒启动为空
  const marker = readResumeMarker()
  // 继续提示优先级：agent 触发时传入（marker.prompt）> settings 配置 > 默认；
  // 重启过程记录（启动失败/回滚等）作为消息前缀——agent 醒来即知发生了什么
  const prompt = (marker.prompt || dynamic().continuePrompt)
  const incidentsText = formatIncidents(marker.incidents)
  const text = incidentsText ? incidentsText + '\n\n' + prompt : prompt
  // ---- 刷新阶段故障判断（第二代自检，所有启动统一）----
  // 统一故障判断的"刷新阶段"：本进程自检"浏览器刷新是否会被错误页阻挡"——
  // 完全复刻浏览器连接就绪判定（host.describe + mux/host 双 WS），
  // 外加所有 client 半插件的 bundle 静态检查（HTTP 200 且含正确模块包装——
  // 缺失会抛 exports is not defined，页面显示 Failed to load plugins），
  // 外加（唤醒场景）"目标会话是否恢复为 live agent"。
  // 全部通过 → IPC refresh-ok（第一代成功判定需要它）；任一失败 → IPC refresh-failed
  // （第一代走统一故障链：记 errors → current 回退 → 逆操作 → 重试）。
  let refreshLocalOk = false // 连接就绪自检通过
  let refreshReported = false // 已上报（ok/failed 二选一）
  const reportRefresh = (ok, detail) => {
    if (refreshReported) return
    refreshReported = true
    log('apply: refresh self-check ' + (ok ? 'OK' : 'FAILED' + (detail ? ': ' + detail : '')))
    try {
      if (typeof process.send === 'function') {
        process.send({ type: ok ? 'refresh-ok' : 'refresh-failed', detail })
        log('apply: refresh ' + (ok ? 'ok' : 'failed') + ' reported to wrapper')
      } else {
        log('apply: no IPC parent, refresh result only logged')
      }
    } catch (e) { log('apply: refresh report THREW ' + String(e)) }
  }
  // 连接就绪自检（**无超时判断**）：探测直到成功——webServer 监听可能晚于
  // apply，重复探测（不设次数上限、不设时间窗口）直到连接就绪。
  // 通过 → 唤醒场景开始会话恢复 + steer，非唤醒直接 refresh-ok。
  // **不主动报 refresh-failed**：失败判定交给确定性信号（boot 输出扫描 +
  // client 半故障页上报），避免"加载慢的正常系统被超时误判为故障"。
  const runConnectionCheck = async (source) => {
    if (refreshReported) return
    const reason = await probeConnectionReady()
    if (reason === null) {
      log('apply: [' + source + '] connection check OK')
      refreshLocalOk = true
      if (wake && marker.sessionIds.length > 0) {
        // 唤醒场景：连接就绪 → 会话恢复 + steer；恢复完成决定最终 refresh 结果
        tryResumeSessions(ctx, marker.sessionIds, text, (ok, detail) => reportRefresh(ok, ok ? undefined : detail))
      } else {
        reportRefresh(true)
      }
      return
    }
    // 未就绪：继续探测（无超时、无上限——就绪是必然趋势，不是时限内的赌注）
    log('apply: [' + source + '] connection check not ready yet: ' + reason)
    setTimeout(() => runConnectionCheck(source), 2000)
  }
  if (wake) {
    log('apply: launched by executor with WAKE=1, scheduling steer')
    // 会话恢复发生在客户端重连之后（resume），apply 时 agents 可能为空：
    // 读重启前记录的 marker，轮询等待目标会话出现后再 steer
    log('apply: resume marker sessions: ' + marker.sessionIds.join(', ') + (marker.prompt ? ' prompt=yes' : '')
      + (marker.incidents.length ? ' incidents=' + marker.incidents.length : ''))
    // 唤醒闸门：等第一代的"启动检查通过"（IPC probe-ok）再唤醒——
    // 避免坏代（client 404 但 host 正常）提前唤醒 + 重试代再次唤醒的重复唤醒；
    // **纯事件驱动，无兜底超时**（禁止超时判断——probe-ok 由第一代持续探测
    // 直到成功，就绪是必然趋势）。
    let gated = false
    const gate = () => {
      if (gated) return
      gated = true
      runConnectionCheck('probe-ok')
    }
    try {
      if (typeof process.send === 'function') {
        process.on('message', (msg) => {
          if (msg && msg.type === 'probe-ok') {
            log('apply: probe-ok received, starting refresh self-check')
            gate()
          }
        })
      }
    } catch (e) { log('apply: message listener THREW ' + String(e)) }
    log('apply: wake gated on probe-ok (event-driven, no timeout)')
  } else {
    // 非唤醒（正常启动 / WAKE=0）：同样做刷新自检（连接就绪），成功报 refresh-ok
    log('apply: not a wake launch, refresh self-check scheduled (startup)')
    setTimeout(() => runConnectionCheck('startup'), 5000)
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

  // 故障页上报端点：client 半检测到页面处于 "Failed to load plugins" 故障页时上报。
  // 这是"刷新后是故障页还是正常页"的判定通道——client 半在故障页场景下仍会
  // apply（entry 独立 fiber），可轮询 DOM 检测故障页特征文本并上报；
  // host 收到后走统一故障链（refresh-failed → 回滚坏插件 → 重试）。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-graceful-restart/page-failed',
    handler: (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end('method not allowed')
        return
      }
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        let detail = '页面显示加载失败（Failed to load plugins）'
        try {
          const p = JSON.parse(body || '{}')
          if (typeof p.detail === 'string' && p.detail) detail = p.detail
          if (typeof p.failedEntries === 'string' && p.failedEntries) detail += '：' + p.failedEntries
        } catch { /* 忽略解析失败，用默认 detail */ }
        log('page-failed received: ' + detail)
        console.log('[dsh-graceful-restart] 页面检测到加载失败（故障页）：' + detail + '，自动回滚...')
        // 与 refresh-failed 同一处理路径：记 errors → current 回退 → 逆操作 → 重试
        if (typeof process.send === 'function') {
          try {
            process.send({ type: 'refresh-failed', detail: '页面故障页（' + detail + '）' })
          } catch (e) { log('page-failed send THREW ' + String(e)) }
        } else {
          log('page-failed: no IPC parent, result only logged')
        }
        res.writeHead(204)
        res.end()
      })
    },
  }), 'dsh-graceful-restart: page-failed endpoint')

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
        async execute(args, exec) {
          const ownerId = exec && exec.agent && exec.agent.id
          pendingContinuePrompt = (args && typeof args.continuePrompt === 'string' && args.continuePrompt.trim() !== '')
            ? args.continuePrompt.trim()
            : null
          scheduleExit(ctx, 'restart-wake', ownerId)
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
        async execute(args, exec) {
          const ownerId = exec && exec.agent && exec.agent.id
          scheduleExit(ctx, 'shutdown', ownerId)
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
        async execute(args, exec) {
          const callerId = exec && exec.agent && exec.agent.id
          const r = cancelPendingExit(callerId)
          if (r.ok) {
            const label = r.previous === 'restart-wake' ? '重启+唤醒' : r.previous === 'restart' ? '重启' : '关闭'
            return { ok: true, message: '已撤销' + label + '安排，进程将继续运行。' }
          }
          if (r.reason === 'armed') {
            return { ok: false, message: '退出流程已触发（进程即将退出），无法撤销。' }
          }
          if (r.reason === 'forbidden') {
            return { ok: false, message: '该安排由另一会话发起，仅发起会话可撤销。' }
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
