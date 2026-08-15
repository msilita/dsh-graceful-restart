// Host apply 集成测试：mock ctx 跑 apply，验证不抛错、命令注册、工具注册、标志逻辑。
// 用法: node test/apply-test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const mod = await import(`file:///${path.join(here, '..', 'lib', 'index.js').replaceAll('\\', '/')}`)

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lifecycle-apply-'))
process.env.DSH_HOME = home

// ---- mock ctx ----
const listeners = {}
let intervalId = 0
const registeredTools = []
const registeredRoutes = []
const ctx = {
  webServer: {
    register: (route) => { registeredRoutes.push(route); return () => {} },
  },
  get: (name) => {
    if (name === 'tools') return { register: (def) => { registeredTools.push(def); return () => {} } }
    return undefined
  },
  on: (name, fn) => {
    ;(listeners[name] ||= []).push(fn)
    return () => { listeners[name] = listeners[name].filter((f) => f !== fn) }
  },
  effect: (fn, label) => {
    const disposer = fn()
    return () => { if (typeof disposer === 'function') disposer() }
  },
  interval: (fn, ms) => {
    const id = ++intervalId
    const iv = setInterval(fn, ms)
    return () => clearInterval(iv)
  },
  agents: {
    list: () => [{ id: 's1', status: 'idle' }, { id: 's2', status: 'idle' }],
    roots: () => [{ id: 's1', status: 'idle' }],
    get: () => undefined,
  },
  commands: {
    register: (def) => { registeredCommands.push(def); return () => {} },
  },
}

const registeredCommands = []

try {
  mod.apply(ctx)
  console.log('apply() completed without throwing')
  console.log('registered commands:', registeredCommands.map((c) => c.name).join(', '))
  console.log('registered tools:', registeredTools.map((t) => t.name).join(', '))
  console.log('web routes:', registeredRoutes.map((r) => `${r.kind} ${r.path}`).join(', '))
  console.log('--- log ---')
  const log = fs.readFileSync(path.join(home, 'dsh-graceful-restart.log'), 'utf8').trim().split('\n')
  console.log(log.join('\n'))
  console.log('--- files ---')
  for (const f of fs.readdirSync(home)) console.log(' ', f)
  // 验证命令执行
  const restartCmd = registeredCommands.find((c) => c.name === 'restart')
  const r = restartCmd.handler()
  console.log('restart command result:', JSON.stringify(r))
  // 验证工具执行
  const tool = registeredTools.find((t) => t.name === 'restart_harness')
  const toolResult = await tool.execute({}, {})
  console.log('tool result:', JSON.stringify(toolResult))
} catch (e) {
  console.error('APPLY FAILED:', e)
  process.exit(1)
}

// 清理
for (const id of [...Array(intervalId)].map((_, i) => i + 1)) clearInterval(id)
try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
