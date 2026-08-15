/**
 * dsh-graceful-restart — 优雅重启（等轮次结束）+ 唤醒。
 *
 * 架构（v3，无看门狗、无 IPC）：
 *   触发（/restart 命令 | restart_harness 工具）
 *     → 插件内存 pendingAction + spawn 一次性"重启执行器"（detached pwsh，无控制台，父退出后存活）
 *     → 插件监听 agent/status，所有 agent idle（turn/end 已落盘）后：process.exit(0)
 *     → 执行器探测旧 DSH 退出 → FreeConsole + AttachConsole(用户终端) →
 *        继承控制台前台拉起新 DSH（env: DSH_GRACEFUL_RESTART_WAKE=1/0）→ 执行器退出
 *     → 新 DSH 插件 apply：读 env → WAKE=1 时 steer 唤醒
 *     → Client 半检测连接恢复 → 自动 location.reload() 一次 → POST /ack（兼容保留）
 *
 * 零常驻进程、零 IPC、零文件标志：意图走"detached 执行器 + AttachConsole 回终端"。
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
  return String.raw`# dsh-graceful-restart executor: one-shot restart worker (PowerShell).
# detached 方式启动（无控制台，父 DSH 退出后存活）；等旧 DSH 退出后
# AttachConsole 附着到用户终端（旧 DSH 的父进程），再以继承控制台的方式拉起新 DSH。
$ErrorActionPreference = 'Stop'
$oldPid = [int]$args[0]
$userShellPid = [int]$args[1]
$wake = $args[2] -eq '1'
$home = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$logFile = Join-Path $home 'dsh-graceful-restart.log'
function Log($m) {
  try { Add-Content -LiteralPath $logFile -Value ((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') + ' executor: ' + $m) -Encoding UTF8 } catch {}
}
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DshCon {
  [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint dwProcessId);
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
}
'@
Log "executor started pid=$PID oldPid=$oldPid userShellPid=$userShellPid wake=$wake"

# 等旧 DSH 退出（最多 60s）
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  if (-not (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 500
}
if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) {
  Log 'old dsh still alive after 60s, exiting without relaunch'
  exit 0
}
Log 'old dsh exited'

# 读进程索引（argv/cwd/execPath）
try { $idx = Get-Content -LiteralPath (Join-Path $home 'dsh-process.json') -Raw | ConvertFrom-Json } catch { Log 'no process index'; exit 0 }
if (-not $idx.execPath -or -not $idx.argv) { Log 'no usable process index'; exit 0 }

# 附着用户终端控制台（旧 DSH 的父进程；失败则回退到日志文件）
$attachOk = $false
try {
  [DshCon]::FreeConsole() | Out-Null
  if ($userShellPid -gt 0) { $attachOk = [DshCon]::AttachConsole([uint32]$userShellPid) }
  if (-not $attachOk) { $attachOk = [DshCon]::AttachConsole([uint32]$oldPid) }
  Log "attach console to userShell=$userShellPid result=$attachOk"
} catch { Log ('attach console threw: ' + $_) }

$env:DSH_GRACEFUL_RESTART_WAKE = if ($wake) { '1' } else { '0' }

# 组装命令行（手动引号包裹，防止路径含空格）
function QuoteArg($v) {
  if ($v -match '[\s"]') { return '"' + ($v -replace '"', '\"') + '"' }
  return $v
}
$argv = @($idx.execPath) + @($idx.execArgv) + @($idx.argv)
$cmdline = (($argv | ForEach-Object { QuoteArg $_ }) -join ' ')
$cwd = if ($idx.cwd) { [string]$idx.cwd } else { $PWD.Path }

try {
  if ($attachOk) {
    # 继承本进程控制台（= 用户终端）启动新 DSH
    Start-Process -FilePath $idx.execPath -ArgumentList $cmdline -WorkingDirectory $cwd -NoNewWindow
    Log 'relaunch started (console attached)'
  } else {
    # 回退：输出到日志文件
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $logOut = Join-Path $env:TEMP ("dsh-graceful-restart-" + $stamp + ".out.log")
    $logErr = Join-Path $env:TEMP ("dsh-graceful-restart-" + $stamp + ".err.log")
    Start-Process -FilePath $idx.execPath -ArgumentList $cmdline -WorkingDirectory $cwd -RedirectStandardOutput $logOut -RedirectStandardError $logErr
    Log "relaunch started (log fallback) out=$logOut err=$logErr"
  }
} catch { Log ('relaunch failed: ' + $_) }

# 给新 DSH 一点启动时间后，本执行器退出（控制台由用户 shell 持有，不会关闭）
Start-Sleep -Seconds 5
Log 'executor done, exiting'
`
}

/** Spawn the one-shot executor (detached pwsh: survives parent exit; no IPC). Returns the child or null. */
function spawnExecutor(action) {
  try {
    fs.writeFileSync(FILE.executor(), executorScript(), 'utf8')
    const wake = action === 'restart-wake' ? '1' : '0'
    const child = spawn('pwsh', [
      '-NoProfile', '-NonInteractive', '-File',
      FILE.executor(),
      String(process.pid),
      String(process.ppid || 0),
      wake,
    ], {
      // detached：executor 脱离控制台，父 DSH 退出后存活；
      // 它随后自行 AttachConsole 到用户终端再拉起新 DSH
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    child.once('error', () => {})
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

let pendingAction = null // 'restart' | 'restart-wake'
let exitArmed = false
let executorChild = null

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
  // executor（detached pwsh）已就绪并等待旧 DSH 退出，这里直接退出
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
