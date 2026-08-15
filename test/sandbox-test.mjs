// 沙盒测试：一次性重启执行器全链路（无看门狗）。
// 每个用例独立 HOME 目录。
// 用法: node test/sandbox-test.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.dirname(here)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-graceful-restart-test-'))

// 提取 executor 脚本模板
const src = fs.readFileSync(path.join(pkgRoot, 'lib', 'index.js'), 'utf8')
const mExec = src.match(/function executorScript\(\) \{\s*return String\.raw`([\s\S]*?)`\s*\n\}/)
if (!mExec) throw new Error('executorScript template not found')

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function waitFor(pred, timeoutMs, what) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true
    await sleep(200)
  }
  console.log(`  TIMEOUT waiting for: ${what}`)
  return false
}

/** 一个独立 HOME 下运行一个场景。 */
async function runScenario(mode) {
  const home = path.join(root, `case-${mode}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  fs.mkdirSync(home, { recursive: true })
  const env = { ...process.env, DSH_HOME: home }
  const LOG = path.join(home, 'dsh-graceful-restart.log')
  const EXECUTOR = path.join(home, 'dsh-graceful-restart-executor.cjs')
  fs.writeFileSync(EXECUTOR, mExec[1], 'utf8')

  // 伪 DSH：写索引，常驻
  const FAKE_FILE = path.join(home, 'fake-dsh.cjs')
  fs.writeFileSync(FAKE_FILE, `
const fs = require('node:fs')
const path = require('node:path')
const home = process.env.DSH_HOME
fs.writeFileSync(path.join(home, 'dsh-process.json'), JSON.stringify({
  pid: process.pid, cwd: process.cwd(),
  commandLine: process.execPath + ' ' + __filename,
  execPath: process.execPath, execArgv: [], argv: [__filename],
  startedAt: new Date().toISOString()
}), 'utf8')
setInterval(() => {}, 1000)
`)

  const spawnFake = () => {
    const child = spawn(process.execPath, [FAKE_FILE], { env, stdio: 'ignore', detached: true })
    child.unref()
    return child
  }
  const spawnExecutor = (oldPid, wake) => {
    const child = spawn(process.execPath, [EXECUTOR, String(oldPid), wake ? '1' : '0'], {
      env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: true,
    })
    child.unref()
    return child
  }

  const result = {}
  if (mode === 'restart-wake') {
    const fake = spawnFake()
    const exec = spawnExecutor(fake.pid, true)
    await sleep(1000)
    exec.send({ type: 'proceed' })       // 模拟插件 idle 后通知
    await sleep(600)
    process.kill(fake.pid)               // 模拟旧 DSH 退出
    result.relaunched = await waitFor(() => {
      try {
        const idx = JSON.parse(fs.readFileSync(path.join(home, 'dsh-process.json'), 'utf8'))
        return idx.pid !== fake.pid && idx.pid > 0
      } catch { return false }
    }, 10000, 'new dsh after relaunch')
    await sleep(300)
    exec.send({ type: 'ack' })           // 模拟 web 端点 → IPC ack
    result.executorExited = await waitFor(() => {
      try { process.kill(exec.pid, 0); return false } catch { return true }
    }, 5000, 'executor exit after ack')
    result.relaunchLogged = fs.readFileSync(LOG, 'utf8').includes('relaunch: spawned')
    result.wakeLogged = fs.readFileSync(LOG, 'utf8').includes('wake=true')
    // 清理 relaunch 出的新 fake（它也是 fake-dsh.cjs 常驻）
    try {
      const idx = JSON.parse(fs.readFileSync(path.join(home, 'dsh-process.json'), 'utf8'))
      process.kill(idx.pid)
    } catch {}
    console.log('  --- log ---')
    console.log(fs.readFileSync(LOG, 'utf8'))
  } else if (mode === 'no-ack') {
    const fake = spawnFake()
    const exec = spawnExecutor(fake.pid, false)
    await sleep(1000)
    exec.send({ type: 'proceed' })
    await sleep(600)
    process.kill(fake.pid)
    await sleep(2000) // 不 ack：executor 应仍存活（等待 60s 超时）
    result.aliveWithoutAck = (() => { try { process.kill(exec.pid, 0); return true } catch { return false } })()
    try { process.kill(exec.pid) } catch {}
  }

  await sleep(300)
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
  return result
}

console.log('=== TEST 1: restart-wake full chain (proceed → old exits → relaunch → ack → executor exits) ===')
{
  const r = await runScenario('restart-wake')
  console.log('  relaunched (new pid indexed):', r.relaunched)
  console.log('  relaunch logged:', r.relaunchLogged)
  console.log('  wake=true logged:', r.wakeLogged)
  console.log('  executor exited after ack:', r.executorExited)
}
console.log('=== TEST 2: no ack -> executor stays alive (waits for timeout) ===')
{
  const r = await runScenario('no-ack')
  console.log('  executor alive without ack:', r.aliveWithoutAck)
}

try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
console.log('\ncleaned up:', root)
