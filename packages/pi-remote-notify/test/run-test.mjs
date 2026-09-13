/**
 * remote-notify 独立测试（不启动 pi）：
 *  - jiti 加载扩展，验证命令注册 / 事件订阅 / 通道订阅
 *  - toggle 命令切换并持久化状态
 *  - extractWorkSummary 摘要提取纯函数
 *  - 发送经 `ag-pi-channel:send` 事件契约：假装成 pi-channel 订阅并应答，
 *    断言 payload（provider=feishu / kind=text / text 含任务摘要）与结果回传
 *  - pi-channel 缺席（无应答者）时超时降级为 error.log，不抛异常、不写 console
 *
 * 运行：node test/run-test.mjs
 */
import { createJiti } from 'jiti'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

// 测试隔离：getAgentDir() 读 PI_CODING_AGENT_DIR，把它指到 /tmp 下的临时目录，
// 避免 toggle 命令写到真实的 ~/.pi/agent/extensions/pi-remote-notify/
const TEST_AGENT_DIR = mkdtempSync(join('/tmp', 'pi-remote-notify-test-'))
process.env.PI_CODING_AGENT_DIR = TEST_AGENT_DIR
const PI_DIST = resolvePiDist()
const { createEventBus, getAgentDir } = await import(PI_DIST)
const EXT_DIR = join(fileURLToPath(new URL('..', import.meta.url)))
const STATE_FILE = join(getAgentDir(), 'extensions', 'pi-remote-notify', 'state.json')
const ERROR_LOG = join(getAgentDir(), 'extensions', 'pi-remote-notify', 'error.log')

const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: { '@earendil-works/pi-coding-agent': PI_DIST },
})

let failures = 0
function check(name, cond, info) {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.error(`  ✗ ${name}${info === undefined ? '' : ` — ${info}`}`)
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
    emit: (ch, data) => events.emit(ch, data),
    on: (ch, h) => {
      subscriptions.push(ch)
      return events.on(ch, h)
    },
  },
  registerCommand: (name, def) => commands.set(name, def),
  registerTool: () => {},
}
factory(fakePi)

console.log('[1] 加载并组合注册')
check('default export 是函数', typeof factory === 'function')
check('注册了 /remote-notify 命令', commands.has('remote-notify'))
check('订阅 before_agent_start', handlers.has('before_agent_start'))
check('订阅 agent_settled', handlers.has('agent_settled'))
check('订阅 session_shutdown', handlers.has('session_shutdown'))
check('订阅 permissions:ui_prompt', subscriptions.includes('permissions:ui_prompt'))
check('订阅 rpiv:ask-user:prompt', subscriptions.includes('rpiv:ask-user:prompt'))

// pi-channel 事件契约常量必须与 pi-channel 保持一致（跨包防漂移检查）
const channelMod = await jiti.import(join(EXT_DIR, 'src', 'channel.ts'))
const piChannelEvents = await jiti.import(join(EXT_DIR, '..', 'pi-channel', 'lib', 'events.ts'))
check(
  'CHANNEL_SEND / CHANNEL_SEND_RESULT 与 pi-channel 契约一致',
  channelMod.CHANNEL_SEND === piChannelEvents.CHANNEL_SEND &&
    channelMod.CHANNEL_SEND_RESULT === piChannelEvents.CHANNEL_SEND_RESULT,
  `${channelMod.CHANNEL_SEND} vs ${piChannelEvents.CHANNEL_SEND}`,
)

// 不再直接依赖飞书 SDK
const pkg = JSON.parse(readFileSync(join(EXT_DIR, 'package.json'), 'utf8'))
check('package.json 不再依赖 @larksuiteoapi/node-sdk', !JSON.stringify(pkg.dependencies ?? {}).includes('@larksuiteoapi'))

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
check('关闭态不写 error.log', !existsSync(ERROR_LOG))

// ---- 事件契约：发送 = ag-pi-channel:send（假装成 pi-channel 应答） ----
console.log('[5] 发送经 ag-pi-channel:send 事件契约')
await cmd.handler('on', fakeCtxUI)

const sendRequests = []
/** 假装成 pi-channel 的应答器；null = 无应答者（模拟插件缺席） */
let sendResponder = null
events.on('ag-pi-channel:send', (data) => {
  const req = data
  sendRequests.push(req)
  if (!sendResponder) return
  const result = sendResponder(req)
  queueMicrotask(() => events.emit('ag-pi-channel:send:result', result))
})

// 先直接调本包的 sendViaBus（与扩展内是不同模块实例，等效跨扩展通信）
sendResponder = (req) => ({ requestId: req.requestId, ok: false, error: { code: 'not_configured', message: 'fake channel' } })
const direct = await channelMod.sendViaBus(events, { provider: 'feishu', kind: 'text', text: 'ping' }, 1000)
check('sendViaBus 关联 requestId 并收到应答结果', !direct.ok && direct.error?.code === 'not_configured', JSON.stringify(direct))
check('requestId 原样回传一致', direct.requestId === sendRequests.at(-1)?.requestId)

// 再走扩展的真实事件路径（应答成功）
sendResponder = (req) => ({ requestId: req.requestId, ok: true, messageId: `om_${sendRequests.length}` })
sendRequests.length = 0
await handlers.get('before_agent_start')({ prompt: '重构登录模块' }, fakeCtx)
await handlers.get('agent_settled')({}, fakeCtx)
await handlers.get('session_shutdown')({}, fakeCtx)
events.emit('permissions:ui_prompt', { message: '允许 rm -rf 吗？', forwarding: null, agentName: null })
events.emit('rpiv:ask-user:prompt', { questions: [{ question: '选一个？' }] })
await new Promise((resolve) => setTimeout(resolve, 50))

check('5 类事件各发出 1 条 send 请求', sendRequests.length === 5, `实际 ${sendRequests.length}`)
check('payload: provider=feishu / kind=text / 带 requestId', sendRequests.every((r) => r.provider === 'feishu' && r.kind === 'text' && typeof r.requestId === 'string'))
check('payload 不指定 to（用 pi-channel 默认收件人）', sendRequests.every((r) => !('to' in r)))
check('任务开始 text 含请求摘要', sendRequests[0]?.text?.includes('🟢 任务开始') && sendRequests[0]?.text?.includes('重构登录模块'), sendRequests[0]?.text)
check(
  '任务完成 text 含最近一次工作总结',
  sendRequests[1]?.text?.includes('✅ 任务完成') &&
    sendRequests[1]?.text?.includes('重构登录模块') &&
    sendRequests[1]?.text?.includes('write×2') &&
    sendRequests[1]?.text?.includes('⏱ 耗时'),
  sendRequests[1]?.text,
)
check('会话结束 text', sendRequests[2]?.text?.includes('🔚 会话结束'), sendRequests[2]?.text)
check('权限弹窗 text', sendRequests[3]?.text?.includes('🔐 需要你的授权') && sendRequests[3]?.text?.includes('允许 rm -rf 吗？'), sendRequests[3]?.text)
check('问卷弹窗 text', sendRequests[4]?.text?.includes('❓ 需要你回答') && sendRequests[4]?.text?.includes('选一个？'), sendRequests[4]?.text)
check('全部应答成功时不写 error.log', !existsSync(ERROR_LOG))
check('扩展通过 send:result 通道等待应答', subscriptions.includes('ag-pi-channel:send:result'))

// ---- pi-channel 缺席：无应答者，超时降级为日志 ----
console.log('[6] pi-channel 缺席（无应答者）不抛异常、只写日志')
sendResponder = null
if (existsSync(ERROR_LOG)) rmSync(ERROR_LOG)
// sendViaBus 真实超时是 10s；这里把本次触发期间的定时器上限压到 100ms，
// 走的是同一条 timeout 分支，避免测试白等 10 秒。
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, Math.min(ms ?? 0, 100), ...args)
const beforeWarn = console.warn
let consoleNoise = 0
console.warn = () => consoleNoise++
try {
  await handlers.get('session_shutdown')({}, fakeCtx)
} finally {
  globalThis.setTimeout = realSetTimeout
  console.warn = beforeWarn
}
await new Promise((resolve) => realSetTimeout(resolve, 300))
check('无应答者时不抛异常（已走到此处）', true)
check('无应答者时不写 console', consoleNoise === 0)
const absentLog = existsSync(ERROR_LOG) ? readFileSync(ERROR_LOG, 'utf8') : ''
check('无应答者时超时降级写入 error.log', absentLog.includes('[session_end] send failed: timeout'), absentLog)

// ---- state 落点与旧位置兼容 ----
console.log('[7] state 落点与旧位置兼容')
const { statePath, loadState } = await jiti.import(join(EXT_DIR, 'src', 'state.ts'))
check('statePath 指向 extensions/pi-remote-notify/state.json', statePath() === join(TEST_AGENT_DIR, 'extensions', 'pi-remote-notify', 'state.json'))
rmSync(statePath(), { force: true })
const legacyState = join(TEST_AGENT_DIR, 'feishu', 'remote-notify-state.json')
mkdirSync(dirname(legacyState), { recursive: true })
writeFileSync(legacyState, JSON.stringify({ enabled: true }), 'utf8')
check('旧位置 state 仍可读（兼容兜底）', loadState().enabled === true)
rmSync(legacyState)

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
