/**
 * remote-notify 独立测试（不启动 pi）：
 *  - jiti 加载扩展，验证命令注册 / 事件订阅 / 通道订阅
 *  - toggle 命令切换并持久化状态
 *  - extractWorkSummary 摘要提取纯函数
 *  - 事件 handler 在关闭态下不抛异常、不触发发送
 *
 * 运行：node test/run-test.mjs
 */
import { createJiti } from 'jiti'
import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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

// 测试隔离：getAgentDir() 读 PI_CODING_AGENT_DIR，把它指到临时目录，
// 避免 toggle 命令写到真实的 ~/.pi/agent/feishu/remote-notify-state.json
const TEST_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pi-remote-notify-test-'))
process.env.PI_CODING_AGENT_DIR = TEST_AGENT_DIR
const PI_DIST = resolvePiDist()
const { createEventBus, getAgentDir } = await import(PI_DIST)
const EXT_DIR = join(fileURLToPath(new URL('..', import.meta.url)))
const STATE_FILE = join(getAgentDir(), 'feishu', 'remote-notify-state.json')

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

// ---- 加载扩展 ----
const mod = await jiti.import(join(EXT_DIR, 'index.ts'))
const factory = mod.default ?? mod

const handlers = new Map()
const commands = new Map()
const subscriptions = []
const events = createEventBus()
const fakePi = {
  on: (evt, handler) => handlers.set(evt, handler),
  events: {
    on: (ch, h) => {
      subscriptions.push(ch)
      return events.on(ch, h)
    },
  },
  registerCommand: (name, def) => commands.set(name, def),
  registerTool: () => {},
}

console.log('[1] 加载并组合注册')
factory(fakePi)
check('default export 是函数', typeof factory === 'function')
check('注册了 /remote-notify 命令', commands.has('remote-notify'))
check('订阅 before_agent_start', handlers.has('before_agent_start'))
check('订阅 agent_settled', handlers.has('agent_settled'))
check('订阅 session_shutdown', handlers.has('session_shutdown'))
check('订阅 permissions:ui_prompt', subscriptions.includes('permissions:ui_prompt'))
check('订阅 rpiv:ask-user:prompt', subscriptions.includes('rpiv:ask-user:prompt'))

// ---- toggle 命令 ----
console.log('[2] /remote-notify toggle 命令与持久化')
const cmd = commands.get('remote-notify')
const fakeCtxUI = { hasUI: true, ui: { notify: () => {} } }
if (existsSync(STATE_FILE)) rmSync(STATE_FILE)
check('默认状态关闭（无状态文件）', !existsSync(STATE_FILE))
await cmd.handler('', fakeCtxUI)
check('无参数切换为开启', existsSync(STATE_FILE) && JSON.parse(readFileSync(STATE_FILE, 'utf8')).enabled === true)
await cmd.handler('off', fakeCtxUI)
check('off 关闭并持久化', JSON.parse(readFileSync(STATE_FILE, 'utf8')).enabled === false)
await cmd.handler('on', fakeCtxUI)
check('on 开启', JSON.parse(readFileSync(STATE_FILE, 'utf8')).enabled === true)
await cmd.handler('status', fakeCtxUI)
check('status 保持开启', JSON.parse(readFileSync(STATE_FILE, 'utf8')).enabled === true)
await cmd.handler('', fakeCtxUI)
check('再次无参数切回关闭', JSON.parse(readFileSync(STATE_FILE, 'utf8')).enabled === false)

// ---- 摘要提取纯函数 ----
console.log('[3] extractWorkSummary 摘要提取')
const { extractWorkSummary, formatTaskDoneSummary } = await jiti.import(join(EXT_DIR, 'src', 'summary.ts'))
const fakeBranch = [
  { type: 'message', id: '1', message: { role: 'user', content: [{ type: 'text', text: '重构登录模块' }] } },
  { type: 'message', id: '2', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }] } },
  { type: 'message', id: '3', message: { role: 'toolResult', toolName: 'read', isError: false, content: [{ type: 'text', text: 'file content' }] } },
  { type: 'message', id: '4', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c2', name: 'write', arguments: {} }, { type: 'toolCall', id: 'c3', name: 'write', arguments: {} }] } },
  { type: 'message', id: '5', message: { role: 'toolResult', toolName: 'write', isError: true, content: [] } },
  { type: 'message', id: '6', message: { role: 'assistant', content: [{ type: 'text', text: '登录模块重构完成，并修复了权限问题。' }] } },
]
const fakeSm = { getBranch: () => fakeBranch }
const summary = extractWorkSummary(fakeSm)
check('prompt = 最近请求', summary.prompt === '重构登录模块')
check('工具 read×1 write×2', JSON.stringify(summary.tools) === JSON.stringify([{ name: 'read', count: 1 }, { name: 'write', count: 2 }]))
check('结论 = 最后 assistant 文本', summary.finalAnswer.includes('重构完成'))
check('错误工具 = write', JSON.stringify(summary.errors) === JSON.stringify(['write']))
const formatted = formatTaskDoneSummary(summary, '/repo', 42)
check('格式化含标题/请求/工具/结论/耗时', formatted.includes('✅ 任务完成') && formatted.includes('重构登录模块') && formatted.includes('write×2') && formatted.includes('42s'))

// 只保留"最后一个 user 请求"之后的内容
const fakeBranch2 = [
  { type: 'message', id: 'a', message: { role: 'user', content: '旧任务一' } },
  { type: 'message', id: 'b', message: { role: 'assistant', content: [{ type: 'text', text: '旧结论' }] } },
  { type: 'message', id: 'c', message: { role: 'user', content: '新任务二' } },
  { type: 'message', id: 'd', message: { role: 'assistant', content: [{ type: 'text', text: '新结论' }] } },
]
const summary2 = extractWorkSummary({ getBranch: () => fakeBranch2 })
check('只取最近一次请求', summary2.prompt === '新任务二' && summary2.finalAnswer === '新结论')

// ---- 事件 handler 关闭态下不抛异常 ----
console.log('[4] 事件 handler 关闭态下不抛异常、不发送')
const fakeCtx = {
  cwd: '/repo',
  hasUI: true,
  ui: { notify: () => {} },
  sessionManager: { getBranch: () => fakeBranch, getSessionFile: () => '/tmp/session.jsonl' },
}
const beforeError = console.error
let errorLog = []
console.error = (...a) => errorLog.push(a.join(' '))
try {
  await handlers.get('before_agent_start')({ prompt: '测试请求' }, fakeCtx)
  await handlers.get('agent_settled')({}, fakeCtx)
  await handlers.get('session_shutdown')({}, fakeCtx)
  events.emit('permissions:ui_prompt', { message: '允许 rm -rf 吗？', forwarding: null, agentName: null })
  events.emit('rpiv:ask-user:prompt', { questions: [{ question: '选一个？' }] })
} finally {
  console.error = beforeError
}
check('关闭态事件触发无发送/无报错', errorLog.length === 0, errorLog)

// 清理隔离目录（含测试产生的状态文件，恢复默认关闭）
if (existsSync(STATE_FILE)) rmSync(STATE_FILE)
rmSync(TEST_AGENT_DIR, { recursive: true, force: true })
console.log('  已清理测试隔离目录（状态文件默认关闭）')

if (failures > 0) {
  console.error(`\n共 ${failures} 项失败`)
  process.exit(1)
} else {
  console.log('\n全部通过 ✔')
}
