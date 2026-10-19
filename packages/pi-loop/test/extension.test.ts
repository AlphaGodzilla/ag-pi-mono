/**
 * 扩展接线的单元测试：用一个假的 pi API 捕获注册项，验证
 *
 *   - 命令 / 工具 / 快捷键 / 事件钩子都注册了；
 *   - `/loop 3s <task>` 启动后立刻派发第一轮（自定义消息 + 触发回合）；
 *   - loop 期间输入被锁（终端层吞文本、input 事件返回 handled）、面板常驻退出提示；
 *   - 快捷键与 /loop stop 都能解锁；
 *   - 还有 subagent 在跑时 loop_report 被拒，注册表消失后放行；
 *   - 事件模式由 pi.events 触发；
 *   - 问卷工具在 loop 期间被 block。
 */
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"

import type { ExtensionAPI, ExtensionCommandContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent"

import piLoop from "../index.ts"

// 让 getAgentDir() 指向临时目录，避免读到真实配置
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-loop-agent-"))

after(() => {
  delete (globalThis as Record<string, unknown>).__piSubagentRunningRegistry
})

interface FakeMessage {
  customType: string
  content: unknown
  display?: boolean
  details?: unknown
}

type Handler = (event: any, ctx: any) => unknown

interface FakeCommand {
  description?: string
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>
}

interface FakePi {
  api: ExtensionAPI
  commands: Map<string, FakeCommand>
  tools: Map<string, ToolDefinition<any, any, any>>
  shortcuts: Map<string, () => void>
  handlers: Map<string, Handler[]>
  messages: FakeMessage[]
  sentOptions: Array<{ triggerTurn?: boolean; deliverAs?: string }>
  bus: Map<string, Set<(data: unknown) => void>>
  /** 可调的激活工具集合，用于模拟 subagent 工具是否可用 */
  activeTools: string[]
}

function makeFakePi(): FakePi {
  const commands = new Map<string, FakeCommand>()
  const tools: FakePi["tools"] = new Map()
  const shortcuts: FakePi["shortcuts"] = new Map()
  const handlers: FakePi["handlers"] = new Map()
  const messages: FakeMessage[] = []
  const sentOptions: FakePi["sentOptions"] = []
  const bus = new Map<string, Set<(data: unknown) => void>>()
  const activeTools: string[] = []

  const api = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    registerCommand(name: string, options: FakeCommand) {
      commands.set(name, options)
    },
    registerTool(tool: ToolDefinition<any, any, any>) {
      tools.set(tool.name, tool)
    },
    registerShortcut(key: string, options: { handler: () => void }) {
      shortcuts.set(key, options.handler)
    },
    registerMessageRenderer() {},
    sendMessage(message: FakeMessage, options: { triggerTurn?: boolean; deliverAs?: string } = {}) {
      messages.push(message)
      sentOptions.push(options)
    },
    sendUserMessage() {},
    appendEntry() {},
    setActiveTools() {},
    getActiveTools() {
      return [...activeTools]
    },
    events: {
      emit(channel: string, data: unknown) {
        for (const handler of bus.get(channel) ?? []) handler(data)
      },
      on(channel: string, handler: (data: unknown) => void) {
        const set = bus.get(channel) ?? new Set()
        set.add(handler)
        bus.set(channel, set)
        return () => {
          set.delete(handler)
        }
      },
    },
  }

  return {
    api: api as unknown as ExtensionAPI,
    commands,
    tools,
    shortcuts,
    handlers,
    messages,
    sentOptions,
    bus,
    activeTools,
  }
}

interface FakeUi {
  notices: string[]
  widgets: Map<string, unknown>
  statuses: Map<string, string | undefined>
  terminalHandler?: (data: string) => { consume?: boolean } | undefined
  editorText: string
}

const THEME = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  bg: (_color: string, text: string) => text,
} as unknown as Theme

function makeUi(): FakeUi {
  const widgets = new Map<string, unknown>()
  const statuses = new Map<string, string | undefined>()
  return {
    notices: [],
    widgets,
    statuses,
    editorText: "",
    // 其余字段由 makeCtx 拼装
  }
}

function makeCtx(ui: FakeUi, mode: "tui" | "rpc" = "tui", branch: unknown[] = []): ExtensionCommandContext {
  const uiContext = {
    notify: (message: string) => {
      ui.notices.push(message)
    },
    setWidget: (key: string, content: unknown) => {
      widgetsSet(ui, key, content)
    },
    setStatus: (key: string, text: string | undefined) => {
      ui.statuses.set(key, text)
    },
    onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => {
      ui.terminalHandler = handler
      return () => {
        ui.terminalHandler = undefined
      }
    },
    setEditorText: (text: string) => {
      ui.editorText = text
    },
  }
  return {
    mode,
    hasUI: true,
    ui: uiContext,
    cwd: "/tmp",
    sessionManager: { getBranch: () => branch },
    isIdle: () => true,
    waitForIdle: async () => {},
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
  } as unknown as ExtensionCommandContext
}

function widgetsSet(ui: FakeUi, key: string, content: unknown): void {
  if (content === undefined) ui.widgets.delete(key)
  else ui.widgets.set(key, content)
}

function setup() {
  const fake = makeFakePi()
  const ui = makeUi()
  const ctx = makeCtx(ui)
  piLoop(fake.api)
  return { fake, ui, ctx }
}

async function runLoopCommand(fake: FakePi, ctx: ExtensionCommandContext, args: string): Promise<void> {
  const command = fake.commands.get("loop")
  assert.ok(command, "/loop 未注册")
  await command.handler(args, ctx)
}

function lastMessageOfType(fake: FakePi, type: string): FakeMessage | undefined {
  for (let i = fake.messages.length - 1; i >= 0; i -= 1) {
    if (fake.messages[i]?.customType === type) return fake.messages[i]
  }
  return undefined
}

test("注册了命令、工具、快捷键与事件钩子", () => {
  const { fake } = setup()
  assert.deepEqual([...fake.commands.keys()].sort(), ["loop", "loop-emit", "loop-stop"])
  assert.deepEqual([...fake.tools.keys()], ["loop_report"])
  assert.deepEqual([...fake.shortcuts.keys()], ["ctrl+shift+l"])
  for (const event of ["session_start", "session_shutdown", "input", "agent_settled", "before_agent_start", "tool_call"]) {
    assert.ok(fake.handlers.has(event), `缺少 ${event} 钩子`)
  }
})

test("/loop 5s <task>：立刻派发第一轮，主 agent 被要求只做调度", async () => {
  const { fake, ui, ctx } = setup()
  await runLoopCommand(fake, ctx, "3s check the deploy")

  const iteration = lastMessageOfType(fake, "loop_iteration")
  assert.ok(iteration, "缺少迭代消息")
  assert.equal(iteration.details && (iteration.details as { iteration?: number }).iteration, 1)
  const text = String(iteration.content)
  assert.match(text, /iteration 1/)
  assert.match(text, /check the deploy/)
  assert.match(text, /subagent/)
  assert.match(text, /loop_report/)
  assert.match(text, /Do not do the task yourself/)
  const iterationIndex = fake.messages.indexOf(iteration)
  assert.equal(fake.sentOptions[iterationIndex]?.triggerTurn, true)

  // 面板与 footer 状态都在，且面板里有退出快捷键
  const widget = ui.widgets.get("pi-loop")
  assert.equal(typeof widget, "function")
  const component = (widget as (tui: unknown, theme: typeof THEME) => { render: (width: number) => string[] })(
    {},
    THEME,
  )
  const panel = component.render(80).join("\n")
  assert.match(panel, /ctrl\+shift\+l/)
  assert.match(panel, /check the deploy/)
  assert.ok((ui.statuses.get("pi-loop") ?? "").startsWith("loop · "))
  assert.equal(ui.editorText, "")

  // 启动提示
  const notice = lastMessageOfType(fake, "loop_notice")
  assert.ok(notice)
  assert.match(String(notice.content), /pi-loop started/)
})

test("loop 期间文本输入被吞掉，Esc / Ctrl+C 透传；退出快捷键解锁", async () => {
  const { fake, ui, ctx } = setup()
  await runLoopCommand(fake, ctx, "3s check the deploy")

  assert.ok(ui.terminalHandler, "未注册终端输入监听")
  assert.deepEqual(ui.terminalHandler?.("hello"), { consume: true })
  assert.deepEqual(ui.terminalHandler?.("\r"), { consume: true })
  assert.equal(ui.terminalHandler?.("\x1b"), undefined, "Esc 必须透传（中断）")
  assert.equal(ui.terminalHandler?.("\x03"), undefined, "Ctrl+C 必须透传")
  assert.equal(ui.terminalHandler?.("\x04"), undefined, "Ctrl+D 必须透传")

  // 传统终端的 ctrl+shift+L 压成 0x0c
  assert.deepEqual(ui.terminalHandler?.("\x0c"), { consume: true })

  // 退出后：面板清理、状态清空、监听解绑、停止提示入库
  assert.equal(ui.widgets.has("pi-loop"), false)
  assert.equal(ui.statuses.get("pi-loop"), undefined)
  assert.equal(ui.terminalHandler, undefined)
  const notice = lastMessageOfType(fake, "loop_notice")
  assert.ok(notice)
  assert.match(String(notice.content), /pi-loop stopped \(user\)/)

  // 停止后终端输入不再被拦截，input 事件也放行
  const inputHandler = fake.handlers.get("input")?.[0]
  const ctx2 = makeCtx(ui)
  assert.equal(inputHandler?.({ type: "input", text: "hi", source: "interactive" }, ctx2), undefined)
})

test("loop 期间 input 事件返回 handled（RPC 等非 TUI 路径的兜底）", async () => {
  const { fake, ui } = setup()
  const ctx = makeCtx(ui)
  await runLoopCommand(fake, ctx, "3s task")

  const inputHandler = fake.handlers.get("input")?.[0]
  assert.deepEqual(inputHandler?.({ type: "input", text: "typed", source: "interactive" }, ctx), { action: "handled" })
  assert.deepEqual(inputHandler?.({ type: "input", text: "typed", source: "rpc" }, ctx), { action: "handled" })
  assert.equal(inputHandler?.({ type: "input", text: "from ext", source: "extension" }, ctx), undefined)
  assert.ok(ui.notices.some((notice) => notice.includes("输入已锁定")))
})

test("快捷键 ctrl+shift+l 与 /loop stop 都能退出 loop", async () => {
  const { fake, ui, ctx } = setup()
  await runLoopCommand(fake, ctx, "3s task")
  const shortcut = fake.shortcuts.get("ctrl+shift+l")
  assert.ok(shortcut)
  shortcut()
  assert.equal(ui.terminalHandler, undefined)
  assert.match(String(lastMessageOfType(fake, "loop_notice")?.content), /stopped \(user\)/)

  await runLoopCommand(fake, ctx, "3s task")
  await fake.commands.get("loop-stop")!.handler("", ctx)
  assert.equal(ui.terminalHandler, undefined)
})

test("loop_report：本轮还有 subagent 在跑时被拒，清空注册表后放行", async () => {
  const { fake, ui, ctx } = setup()
  await runLoopCommand(fake, ctx, "3s task")
  const tool = fake.tools.get("loop_report")
  assert.ok(tool)

  const registry = new Map<string, unknown>([["a1b2c3d4", {}]])
  ;(globalThis as Record<string, unknown>).__piSubagentRunningRegistry = registry

  const rejected = await tool.execute("t1", { summary: "half done" }, undefined, undefined, ctx)
  const rejectedText = (rejected.content as Array<{ text: string }>)[0]?.text ?? ""
  assert.match(rejectedText, /NOT recorded/)
  assert.match(rejectedText, /still running/)
  assert.equal((rejected.details as { ok?: boolean }).ok, false)

  registry.clear()
  // 收尾报告结束 loop 并解锁输入
  const done = await tool.execute("t2", { summary: "release is out", keepGoing: false }, undefined, undefined, ctx)
  assert.equal((done.details as { ok?: boolean }).ok, true)
  assert.equal((done.details as { stopped?: boolean }).stopped, true)
  assert.equal(ui.terminalHandler, undefined)

  // 本轮结束后再报告会被拒（不会凭空开启新轮次）
  const again = await tool.execute("t3", { summary: "late", keepGoing: true }, undefined, undefined, ctx)
  assert.equal((again.details as { reason?: string }).reason, "no-loop")
})

test("loop_report 在没有 loop 时被拒，不影响普通会话", async () => {
  const { fake, ui } = setup()
  const ctx = makeCtx(ui)
  const tool = fake.tools.get("loop_report")
  assert.ok(tool)
  const result = await tool.execute("t1", { summary: "x" }, undefined, undefined, ctx)
  const text = (result.content as Array<{ text: string }>)[0]?.text ?? ""
  assert.match(text, /no pi-loop loop is active/)
  assert.equal((result.details as { reason?: string }).reason, "no-loop")
})

test("事件模式：pi.events 上的事件触发一轮，轮内事件合并", async () => {
  const { fake, ui, ctx } = setup()
  await runLoopCommand(fake, ctx, "event tasks:created process the backlog")
  assert.equal(fake.bus.get("tasks:created")?.size, 1)
  assert.equal(fake.messages.filter((message) => message.customType === "loop_iteration").length, 0, "事件模式不主动开跑")

  fake.api.events.emit("tasks:created", { id: 7 })
  const first = lastMessageOfType(fake, "loop_iteration")
  assert.ok(first)
  assert.match(String(first.content), /process the backlog/)
  assert.match(String(first.content), /"id": 7/)

  fake.api.events.emit("tasks:created", { id: 8 })
  fake.api.events.emit("tasks:created", { id: 9 })
  assert.equal(fake.messages.filter((message) => message.customType === "loop_iteration").length, 1)

  const tool = fake.tools.get("loop_report")
  assert.ok(tool)
  await tool.execute("t1", { summary: "processed", keepGoing: true }, undefined, undefined, ctx)
  const second = fake.messages.filter((message) => message.customType === "loop_iteration").at(-1)
  assert.match(String(second?.content), /2 events arrived/)
})

test("/loop-emit 把事件发到总线（手工触发事件模式）", async () => {
  const { fake, ui, ctx } = setup()
  await runLoopCommand(fake, ctx, "event tasks:created process the backlog")
  await fake.commands.get("loop-emit")!.handler("tasks:created {\"id\":42}", ctx)
  const iteration = lastMessageOfType(fake, "loop_iteration")
  assert.ok(iteration)
  assert.match(String(iteration.content), /"id": 42/)
  assert.ok(ui.notices.some((notice) => notice.includes("已发出事件")))
})

test("/loop-emit 的 payload 不是合法 JSON 时按 { text } 发送", async () => {
  const { fake, ui, ctx } = setup()
  await runLoopCommand(fake, ctx, "event tasks:created process the backlog")
  await fake.commands.get("loop-emit")!.handler("tasks:created plain text payload", ctx)
  const iteration = lastMessageOfType(fake, "loop_iteration")
  assert.ok(iteration)
  assert.match(String(iteration.content), /"text": "plain text payload"/)
  assert.ok(ui.notices.some((notice) => notice.includes("已发出事件")))
})

test("/loop 无参数：空闲时打印用法（含运行时追加的退出键行）", async () => {
  const { fake, ui, ctx } = setup()
  await runLoopCommand(fake, ctx, "")
  const usageNotice = ui.notices.at(-1) ?? ""
  assert.match(usageNotice, /pi-loop 用法:/)
  assert.match(usageNotice, /\/loop event <channel> <task>/)
  assert.match(usageNotice, /退出：ctrl\+shift\+l 或 \/loop stop/)
  assert.equal(fake.messages.filter((message) => message.customType === "loop_iteration").length, 0)
})

test("/loop status 在运行中打印状态而不是用法", async () => {
  const { fake, ui, ctx } = setup()
  await runLoopCommand(fake, ctx, "3s check the deploy")
  const before = ui.notices.length
  await runLoopCommand(fake, ctx, "status")
  const statusNotice = ui.notices[before] ?? ""
  assert.match(statusNotice, /pi-loop 状态:/)
  assert.match(statusNotice, /task {6}check the deploy/)
  assert.match(statusNotice, /退出键 {4}ctrl\+shift\+l/)
  assert.doesNotMatch(statusNotice, /用法:/)
})


test("loop 期间 ask_user_question 被 block，loop_report 与其它工具不受影响", async () => {
  const { fake, ui, ctx } = setup()
  const toolCall = fake.handlers.get("tool_call")?.[0]
  assert.ok(toolCall)

  // 未启动时放行
  assert.equal(toolCall({ type: "tool_call", toolName: "ask_user_question", toolCallId: "x", input: {} }, ctx), undefined)

  await runLoopCommand(fake, ctx, "3s task")
  const blocked = toolCall({ type: "tool_call", toolName: "ask_user_question", toolCallId: "x", input: {} }, ctx)
  assert.equal((blocked as { block?: boolean }).block, true)
  assert.match((blocked as { reason?: string }).reason ?? "", /loop_report/)

  assert.equal(toolCall({ type: "tool_call", toolName: "loop_report", toolCallId: "y", input: {} }, ctx), undefined)
  assert.equal(toolCall({ type: "tool_call", toolName: "bash", toolCallId: "z", input: {} }, ctx), undefined)
})

test("loop 期间系统提示词追加 pi-loop 段，退出后不再追加", async () => {
  const { fake, ui, ctx } = setup()
  const beforeStart = fake.handlers.get("before_agent_start")?.[0]
  assert.ok(beforeStart)

  const idleOptions = { sections: {} as Record<string, string> }
  beforeStart({ type: "before_agent_start", prompt: "hi", systemPrompt: "", systemPromptOptions: idleOptions }, ctx)
  assert.equal(idleOptions.sections["pi-loop"], undefined)

  await runLoopCommand(fake, ctx, "3s task")
  const runningOptions = { sections: {} as Record<string, string> }
  beforeStart({ type: "before_agent_start", prompt: "hi", systemPrompt: "", systemPromptOptions: runningOptions }, ctx)
  assert.match(runningOptions.sections["pi-loop"] ?? "", /orchestrator/)
  assert.match(runningOptions.sections["pi-loop"] ?? "", /ctrl\+shift\+l/)
})

test("重复 /loop 被拒绝（必须先退出），间隔低于下限也被拒绝", async () => {
  const { fake, ui, ctx } = setup()
  await runLoopCommand(fake, ctx, "3s task")
  const before = fake.messages.filter((message) => message.customType === "loop_iteration").length
  await runLoopCommand(fake, ctx, "3s another task")
  assert.equal(fake.messages.filter((message) => message.customType === "loop_iteration").length, before)
  assert.ok(ui.notices.some((notice) => notice.includes("已在运行")))

  await fake.commands.get("loop-stop")!.handler("", ctx)
  await runLoopCommand(fake, ctx, "10ms too fast")
  assert.ok(ui.notices.some((notice) => notice.includes("小于下限")))
})

test("有 subagent 工具却没派发：回合结束后补一条「先派 subagent」的提醒", async () => {
  const { fake, ui, ctx } = setup()
  fake.activeTools.push("subagent")
  await runLoopCommand(fake, ctx, "3s task")

  // 这一轮的会话分支里没有任何 subagent 工具结果
  fake.handlers.get("agent_settled")?.[0]?.({ type: "agent_settled" }, makeCtx(ui))
  const nudge = lastMessageOfType(fake, "loop_iteration")
  assert.ok(nudge)
  assert.match(String(nudge.content), /ended without dispatching a subagent/)
  assert.match(String(nudge.content), /call the `subagent` tool/)

  // 同一轮再 settle 不重复提醒（改为隐式报告推进）
  const before = fake.messages.filter((message) => message.customType === "loop_iteration").length
  fake.handlers.get("agent_settled")?.[0]?.({ type: "agent_settled" }, makeCtx(ui))
  assert.equal(fake.messages.filter((message) => message.customType === "loop_iteration").length, before)
})

test("派发过 subagent 的回合不提醒（按隐式报告推进）", async () => {
  const { fake, ui, ctx } = setup()
  fake.activeTools.push("subagent")
  await runLoopCommand(fake, ctx, "3s task")
  const branch = [
    {
      type: "message",
      timestamp: new Date(Date.now() + 1).toISOString(),
      message: { role: "toolResult", toolName: "subagent", content: [], isError: false },
    },
  ]
  const before = fake.messages.filter((message) => message.customType === "loop_iteration").length
  fake.handlers.get("agent_settled")?.[0]?.({ type: "agent_settled" }, makeCtx(ui, "tui", branch))
  assert.equal(fake.messages.filter((message) => message.customType === "loop_iteration").length, before)
})

test("模型回合以 error 结束（有界重试耗尽）时停止 loop，不再反复空跑", async () => {
  const { fake, ui, ctx } = setup()
  await runLoopCommand(fake, ctx, "3s task")
  const failingBranch = [{ type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "boom" } }]
  const failingCtx = makeCtx(ui, "tui", failingBranch)
  fake.handlers.get("agent_settled")?.[0]?.({ type: "agent_settled" }, failingCtx)
  assert.equal(ui.terminalHandler, undefined)
  assert.match(String(lastMessageOfType(fake, "loop_notice")?.content), /stopped \(error\)/)
})

test("会话关闭时幂等清理（定时器与监听），不发停止提示", async () => {
  const { fake, ui, ctx } = setup()
  await runLoopCommand(fake, ctx, "3s task")
  const before = fake.messages.length
  fake.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, ctx)
  assert.equal(ui.terminalHandler, undefined)
  assert.equal(fake.messages.length, before, "shutdown 不应再往 transcript 写消息")
  assert.equal(ui.widgets.has("pi-loop"), false)
})
