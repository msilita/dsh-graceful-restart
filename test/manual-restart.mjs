// 手动驱动重启执行器：绕过卡死的插件 pendingAction。
// 用法: node manual-restart.mjs <oldPid> [wake]
// 流程：spawn executor → send proceed → kill old dsh → executor 拉起新进程
const { spawn } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const executorPath = path.join(home, 'dsh-graceful-restart-executor.cjs')
const oldPid = Number(process.argv[2] || 0)
const wake = process.argv[3] === '1'

if (!oldPid) { console.error('usage: node manual-restart.mjs <oldPid> [wake]'); process.exit(1) }

console.log('spawning executor for old pid', oldPid, 'wake', wake)
const exec = spawn(process.execPath, [executorPath, String(oldPid), wake ? '1' : '0'], {
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  detached: true,
  env: process.env,
})
exec.unref()

exec.on('message', (msg) => {
  console.log('executor message:', msg)
  if (msg && msg.type === 'proceed') console.log('executor confirmed proceed')
})

// 等 executor 起来，发 proceed，然后杀旧进程
setTimeout(() => {
  try {
    exec.send({ type: 'proceed' })
    console.log('proceed sent to executor')
  } catch (e) {
    console.error('send proceed failed:', e.message)
  }
}, 1000)

setTimeout(() => {
  try {
    process.kill(oldPid)
    console.log('old dsh', oldPid, 'killed')
  } catch (e) {
    console.error('kill old dsh failed:', e.message)
  }
}, 2500)

// 本脚本 10s 后退出，executor detached 继续工作
setTimeout(() => {
  console.log('manual driver exiting, executor continues')
  process.exit(0)
}, 10000)
