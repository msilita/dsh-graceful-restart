// 独立驱动脚本：由 Start-Process 启动，不依赖被杀的 DSH 进程。
// spawn executor → send proceed → kill old dsh → executor 拉起新进程
const { spawn } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const executorPath = path.join(home, 'dsh-graceful-restart-executor.cjs')
const oldPid = Number(process.argv[2] || 0)
const wake = process.argv[3] === '1'
const logFile = path.join(home, 'dsh-graceful-restart-manual.log')

function log(msg) {
  try { require('node:fs').appendFileSync(logFile, new Date().toISOString() + ' manual: ' + msg + '\n', 'utf8') } catch {}
}

log('starting, old pid ' + oldPid + ' wake ' + wake)
const exec = spawn(process.execPath, [executorPath, String(oldPid), wake ? '1' : '0'], {
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  detached: true,
  env: process.env,
})
exec.unref()
log('executor spawned pid ' + exec.pid)

setTimeout(() => {
  try {
    exec.send({ type: 'proceed' })
    log('proceed sent')
  } catch (e) { log('proceed failed: ' + e.message) }
}, 1000)

setTimeout(() => {
  try {
    process.kill(oldPid)
    log('old dsh ' + oldPid + ' killed')
  } catch (e) { log('kill failed: ' + e.message) }
}, 2500)

setTimeout(() => { log('driver exiting'); process.exit(0) }, 10000)
