/**
 * 共存验证：pi-cmux 与 remote-notify 在同一 fakePi 中同时加载，
 * 确认两者独立注册命令/订阅事件，互不干扰。
 * 运行：node test/coexist-check.mjs
 */
import { createJiti } from 'jiti'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// pi 核心包与 jiti 均从工作区 devDependencies 解析；PI_DIST 可覆盖（指向其它安装）
function resolvePiDist() {
  if (process.env.PI_DIST) return process.env.PI_DIST
  try {
    return fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))
  } catch {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim()
    return join(root, '@earendil-works', 'pi-coding-agent', 'dist', 'index.js')
  }
}

const PI_DIST = resolvePiDist()
const { createEventBus } = await import(PI_DIST)
const EXT_DIR = fileURLToPath(new URL('..', import.meta.url))

const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: { '@earendil-works/pi-coding-agent': PI_DIST },
})

let failures = 0
function check(name, cond) {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.error(`  ✗ ${name}`)
  }
}

const handlers = new Map()
const commands = new Map()
const subscriptions = []
const events = createEventBus()
const fakePi = {
  on: (evt, handler) => handlers.set(evt, handler),
  events: { on: (ch, h) => { subscriptions.push(ch); return events.on(ch, h) } },
  registerCommand: (name, def) => commands.set(name, def),
  registerTool: () => {},
  exec: async () => ({ stdout: '', exitCode: 0 }),
}

// 先加载 pi-cmux，再加载 remote-notify
const cmuxMod = await jiti.import(join(EXT_DIR, '..', 'pi-cmux', 'index.ts'))
const cmuxFactory = cmuxMod.default ?? cmuxMod
cmuxFactory(fakePi)

const rnMod = await jiti.import(join(EXT_DIR, 'index.ts'))
const rnFactory = rnMod.default ?? rnMod
rnFactory(fakePi)

console.log('[共存] pi-cmux + remote-notify 同时加载')
check('pi-cmux 注册 /cmux-status', commands.has('cmux-status'))
check('remote-notify 注册 /remote-notify', commands.has('remote-notify'))
check('两个命令互不覆盖', commands.size >= 2)
check('pi-cmux 订阅 before_agent_start', handlers.has('before_agent_start'))
check('pi-cmux 订阅 agent_end', handlers.has('agent_end'))
check('remote-notify 订阅 agent_settled', handlers.has('agent_settled'))
check('remote-notify 订阅 session_shutdown', handlers.has('session_shutdown'))
check('订阅 permissions:ui_prompt', subscriptions.includes('permissions:ui_prompt'))
check('订阅 rpiv:ask-user:prompt', subscriptions.includes('rpiv:ask-user:prompt'))

if (failures > 0) {
  console.error(`\n共 ${failures} 项失败`)
  process.exit(1)
}
console.log('\n共存验证通过 ✔')
