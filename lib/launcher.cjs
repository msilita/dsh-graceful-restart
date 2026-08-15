#!/usr/bin/env node
/**
 * dsh-graceful-restart launcher — 常驻启动器。
 *
 * 用法：node <此文件> [dsh 参数...]    例如：node launcher.cjs web
 *
 * 由它拉起真正的 dsh（非 detached + inherit → 输出回到用户终端）。
 * 重启 = 杀掉旧 dsh → 同一控制台拉起新 dsh；启动器自身不退出，
 * 因此没有"父进程退出连带杀子进程"的问题（Windows Terminal/ConPTY 下实测的坑）。
 *
 * dsh 的 bin.js 定位：$DSH_BIN 环境变量，或 npm 全局 root 下的
 * @deepseek-ai/dsh/lib/bin.js（与 `dsh` 命令同一安装）。
 *
 * IPC：spawn dsh 带 'ipc' 通道；dsh 内插件 process.send({type:'restart'|'shutdown'})。
 *   restart → 杀旧 dsh → 等退出 → 拉起新 dsh（env DSH_GRACEFUL_RESTART_WAKE=1）
 *   shutdown → 杀旧 dsh → 启动器跟随退出
 * dsh 意外退出（非 restart 流程）→ 启动器跟随退出（不做看门狗式自动拉起）。
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const logFile = path.join(home, 'dsh-graceful-restart-launcher.log')
function log(msg) {
  try { fs.appendFileSync(logFile, new Date().toISOString() + ' launcher: ' + msg + '\n', 'utf8') } catch {}
}

/** 定位 dsh 的 bin.js（与 `dsh` 命令同一安装）。 */
function findDshBin() {
  const candidates = [
    process.env.DSH_BIN,
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ].filter(Boolean)
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c } catch {}
  }
  return null
}

let current = null
let restarting = false
const dshArgs = process.argv.slice(2) // 例如 ['web']

/** 拉起 dsh；wake=true 表示这是重启后的实例（插件将唤醒智能体）。 */
function boot(wake) {
  const binJs = findDshBin()
  if (!binJs) {
    log('dsh bin.js not found (set $DSH_BIN or install dsh via npm)')
    process.exit(1)
  }
  restarting = false
  log('spawning dsh pid-mode args=' + JSON.stringify(dshArgs) + ' wake=' + wake)
  current = spawn(process.execPath, [binJs, ...dshArgs], {
    // 非 detached + inherit：dsh 输出回到本启动器所在的用户终端（ConPTY 管道链）
    // 'ipc'：dsh 内插件可 process.send 通知本启动器
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      DSH_GRACEFUL_RESTART_WAKE: wake ? '1' : '0',
      DSH_LAUNCHED_BY: 'dsh-graceful-restart-launcher',
    },
  })
  current.once('error', (e) => log('spawn error: ' + String(e)))
  current.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'restart') {
      log('restart requested (wake)')
      restarting = true
      // 插件已等轮次结束；直接终止旧 dsh（无损），exit 事件里拉起新的
      try { current.kill() } catch {}
    } else if (msg.type === 'shutdown') {
      log('shutdown requested')
      try { current.kill() } catch {}
    }
  })
  current.once('exit', (code, sig) => {
    log('dsh exited code=' + code + ' sig=' + sig + ' restarting=' + restarting)
    current = null
    if (restarting) {
      log('relaunching dsh')
      boot(true)
    } else {
      log('launcher exiting')
      process.exit(0)
    }
  })
}

log('launcher started pid=' + process.pid + ' args=' + JSON.stringify(dshArgs))
boot(false)
