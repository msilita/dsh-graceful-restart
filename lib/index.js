/**
 * dsh-graceful-restart — 优雅重启（等轮次结束）+ 唤醒。
 *
 * 架构（v2，无看门狗）：
 *   触发（/restart 命令 | restart_harness 工具）
 *     → 插件内存 pendingAction + spawn 一次性"重启执行器"（附着原控制台 + IPC）
 *     → 插件监听 agent/status，所有 agent idle（turn/end 已落盘）后：
 *         IPC 通知执行器 proceed → 插件 process.exit(0)
 *     → 执行器探测旧 DSH 退出 → spawn 新 DSH（原控制台内，env: DSH_GRACEFUL_RESTART_WAKE=1/0）
 *     → 新 DSH 插件 apply：读 env → WAKE=1 时 steer 唤醒
 *     → Client 半检测连接恢复 → 自动 location.reload() 一次 → POST /ack
 *     → 插件收到 /ack → IPC 通知执行器 → 执行器 60s 超时或收 ack 后自毁
 *
 * 零常驻进程、零文件标志：意图走 IPC/内存，代际信息走 env。
 * 崩溃恢复不做（DSH 原生会话恢复会修复历史并提示 TOOL_OUTCOME_UNKNOWN）。
 */

import { spawn } from 'node:child_process'
import process from 'node:process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-graceful-restart'
export const inject = ['commands', 'agents', 'timer', 'webServer']

const HOME = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const FILE = {
  index: () => path.join(HOME(), 'dsh-process.json'),
  executor: () => path.join(HOME(), 'dsh-graceful-restart-executor.cjs'),
  log: () => path.join(HOME(), 'dsh-graceful-restart.log'),
}

function log(msg) {
  try { fs.appendFileSync(FILE.log(), `${new Date().toISOString()} ${msg}\n`, 'utf8') } catch { /* best-effort */ }
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
  return String.raw`// dsh-graceful-restart executor: one-shot restart worker. Spawned attached to the original
// console by the DSH plugin when a restart is triggered; self-destructs after ack or timeout.
// 非 detached：继承原控制台，其拉起的 DSH 才能回到用户启动 dsh 的终端。
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const indexFile = path.join(home, 'dsh-process.json')
const logFile = path.join(home, 'dsh-graceful-restart.log')
const ACK_TIMEOUT_MS = 60000
const POLL_MS = 500

// 参数：argv[2] = old dsh pid（等待其退出），argv[3] = wake 1/0
const oldPid = Number(process.argv[2] || 0)
const wake = process.argv[3] === '1'

function log(msg) {
  try { fs.appendFileSync(logFile, new Date().toISOString() + ' executor: ' + msg + '\n', 'utf8') } catch {}
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

function readIndex() {
  try { return JSON.parse(fs.readFileSync(indexFile, 'utf8')) } catch { return null }
}

let started = false

// 来自插件：proceed（旧 DSH 轮次已结束，即将退出）/ ack（页面已确认）
process.on('message', (msg) => {
  if (msg && msg.type === 'proceed') {
    log('proceed received, waiting for old dsh (' + oldPid + ') to exit')
    started = true
  } else if (msg && msg.type === 'ack') {
    log('ack received, exiting')
    setTimeout(() => process.exit(0), 100)
  }
})

function relaunch() {
  const idx = readIndex()
  if (!idx || !idx.execPath) { log('relaunch: no usable process index'); return }
  try {
    const argv = [].concat(idx.execArgv || [], idx.argv || [])
    const child = spawn(idx.execPath, argv, {
      cwd: idx.cwd || process.cwd(),
      // 非 detached + stdio inherit：新 DSH 在原控制台运行（日志回终端，Ctrl+C 可用）
      detached: false,
      // ipc 保留：新 DSH 的插件 apply 时可 process.send ack 给本执行器
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, DSH_GRACEFUL_RESTART_WAKE: wake ? '1' : '0' },
    })
    child.once('error', (er) => log('relaunch spawn error: ' + String(er)))
    child.on('message', (msg) => {
      if (msg && msg.type === 'ack') {
        log('ack from new dsh, exiting')
        setTimeout(() => process.exit(0), 100)
      }
    })
    child.unref()
    log('relaunch: spawned pid ' + child.pid + ' cwd=' + (idx.cwd || '') + ' wake=' + wake)
  } catch (er) {
    log('relaunch failed: ' + String(er))
  }
}

// 超时自毁（无论是否收到 ack）
setTimeout(() => {
  log('ack timeout (' + ACK_TIMEOUT_MS + 'ms), exiting')
  process.exit(0)
}, ACK_TIMEOUT_MS)

// 主循环：等 proceed → 等旧进程退出 → relaunch → 等 ack/超时
log('executor started, old pid ' + oldPid + ', wake ' + wake)
const iv = setInterval(() => {
  if (!started) return
  if (processAlive(oldPid)) return // 旧 DSH 还没退出
  clearInterval(iv)
  log('old dsh exited, relaunching')
  relaunch()
}, POLL_MS)
`
}

/** Spawn the one-shot executor (attached to the original console + IPC). Returns the child or null. */
function spawnExecutor(action) {
  try {
    fs.writeFileSync(FILE.executor(), executorScript(), 'utf8')
    const wake = action === 'restart-wake' ? '1' : '0'
    const child = spawn(process.execPath, [FILE.executor(), String(process.pid), wake], {
      // 非 detached：executor 附着原控制台，其拉起的 DSH 才能继承同一控制台
      // （不脱离用户启动 dsh 的终端；stdio inherit 使控制台输出可见）
      detached: false,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: process.env,
    })
    child.once('error', () => {})
    log('executor spawned pid ' + child.pid + ' action=' + action)
    return child
  } catch (error) {
    console.error('[dsh-graceful-restart] spawn executor:', error)
    return null
  }
}

/* ------------------------------------------------------------------ */
/* 等轮次结束后退出                                                    */
/* ------------------------------------------------------------------ */

let pendingAction = null // 'restart' | 'restart-wake'
let exitArmed = false
let executorChild = null

function scheduleExit(ctx, action) {
  // 如果已有未完成的安排，但执行器已失效（进程退出/超时），重置后重新安排
  if (pendingAction) {
    const alive = executorChild !== null && typeof executorChild.connected === 'boolean' ? executorChild.connected : false
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
  executorChild = spawnExecutor(action)
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

function checkIdleAndExit(ctx) {
  if (!pendingAction || exitArmed) return
  const running = ctx.agents.list().filter((agent) => agent.status === 'running')
  if (running.length > 0) {
    log('still running agents: ' + running.map((a) => a.id).join(', '))
    return
  }
  log('all agents idle, action=' + pendingAction)
  exitArmed = true
  // 通知执行器 proceed（旧进程即将退出），然后自己退出
  try { executorChild?.send({ type: 'proceed' }) } catch (e) { log('send proceed failed: ' + String(e)) }
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

function tryResumeSessions(ctx, text) {
  const sessionIds = ctx.agents.roots().map((a) => a.id)
  if (sessionIds.length === 0) {
    log('resume: no live agents to steer')
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
    } else if (attempts >= 120) {
      clearInterval(interval)
      log('resume: timed out after 60s, never steered: ' + [...pending].join(', '))
    }
  }, 500)
  ctx.effect(() => () => clearInterval(interval))
}

/* ------------------------------------------------------------------ */
/* apply                                                               */
/* ------------------------------------------------------------------ */

export function apply(ctx) {
  log(`apply: start pid=${process.pid}`)
  try { writeProcessIndex(); log('apply: process index written') } catch (e) { log('apply: index THREW ' + String(e)) }

  // 代际信息：本进程是被重启执行器拉起的？
  const wake = process.env.DSH_GRACEFUL_RESTART_WAKE === '1'
  if (wake) {
    log('apply: launched by executor with WAKE=1, scheduling steer')
    try { tryResumeSessions(ctx, '（系统已重启完成）请继续之前未完成的工作。') } catch (e) { log('apply: resume THREW ' + String(e)) }
  } else if (process.env.DSH_GRACEFUL_RESTART_WAKE !== undefined) {
    log('apply: launched by executor with WAKE=0, no steer')
  }
  const restartedByExecutor = process.env.DSH_GRACEFUL_RESTART_WAKE !== undefined

  // Web 端点：status（启动信号）+ ack（页面确认）
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-graceful-restart/status',
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      // restarted=true 仅当本进程是被重启执行器拉起时（启动信号）；正常启动为 false
      res.end(JSON.stringify({ ok: true, pid: process.pid, restarted: restartedByExecutor }))
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
          properties: {},
        },
        output: {
          // 纯文本呈现，不做卡片：重启是一次性动作，结果文本即反馈
          schema: { type: 'object', additionalProperties: true },
          render(args, value) {
            return [{ type: 'text', text: value && value.message ? String(value.message) : JSON.stringify(value) }]
          },
        },
        async execute() {
          scheduleExit(ctx, 'restart-wake')
          return {
            ok: true,
            message: '重启+唤醒已安排：等当前轮次结束后进程退出，执行器将拉起新进程，重启完成后自动唤醒智能体。',
          }
        },
      }), 'dsh-graceful-restart: restart_harness tool')
      log('apply: restart_harness tool registered')
    } catch (e) {
      log('apply: tools.register THREW ' + String(e))
    }
  }

  log('apply: complete')
}
