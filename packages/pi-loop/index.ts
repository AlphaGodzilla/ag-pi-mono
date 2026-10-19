/**
 * pi-loop —— 让 pi 以「无人值守的循环」运行，行为对齐 Claude Code 的 `/loop`：
 *
 *   /loop 5m check the deploy              固定间隔
 *   /loop event tasks:created process it   事件驱动（pi.events 总线）
 *   /loop finish the release               自定节拍（按每轮报告推进）
 *
 * 三条核心约束：
 *  1. **主 agent 只做调度与汇总**：每轮把任务派给 subagent（pi-interactive-subagents 的
 *     `subagent` 工具），结果 steer 回来后写摘要并调用 `loop_report` 推进节奏。
 *  2. **人类输入被锁死**：loop 期间吞掉输入框的文本输入（终端层 + input 事件双保险），
 *     并在编辑器上方的面板里常驻显示退出快捷键。
 *  3. **不需要退出 loop 的模型能力**：用户用快捷键退出，模型也可以用
 *     `loop_report({ keepGoing: false })` 结束；两条路径都恢复输入。
 *
 * 与其它扩展的耦合只有两处，且都是「只读 / 只发」：
 *  - 读取 pi-interactive-subagents 放在 `globalThis.__piSubagentRunningRegistry` 的运行中
 *    注册表，判断本轮是否还在等 subagent 结果（插件缺席时退化为按回合推进）；
 *  - 通过 `pi.events` 订阅事件模式的 channel（任何扩展或 `/loop-emit` 都能触发）。
 */

import { Type } from "@earendil-works/pi-ai"
import {
  defineTool,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type MessageRenderOptions,
  type Theme,
} from "@earendil-works/pi-coding-agent"
import type { Component, KeyId } from "@earendil-works/pi-tui"

import { LOOP_USAGE, parseLoopCommand, type LoopSpec } from "./src/args.ts"
import { loadLoopConfig } from "./src/config.ts"
import { formatDuration } from "./src/duration.ts"
import { isTextualInput, matchesExitInput } from "./src/input-lock.ts"
import { createLoopMachine, type IterationRequest, type LoopSnapshot, type ReportOutcome } from "./src/loop-machine.ts"
import {
  formatDispatchNudge,
  formatIterationMessage,
  formatLoopSection,
  formatReportAccepted,
  formatReportRejected,
} from "./src/messages.ts"
import { runningSubagentCount } from "./src/subagents.ts"
import {
  formatNoticeText,
  formatStartNotice,
  formatStatusLine,
  formatStatusReport,
  formatStopNotice,
  panelKey,
  renderLoopMessage,
  renderLoopPanel,
  type LoopNotice,
} from "./src/ui.ts"

const ITERATION_MESSAGE_TYPE = "loop_iteration"
const NOTICE_MESSAGE_TYPE = "loop_notice"
const LOCK_NOTICE_INTERVAL_MS = 3_000

interface LoopReportDetails {
  ok: boolean
  iteration?: number
  stopped?: boolean
  reason?: string
  runningSubagents?: number
}

const reportParams = Type.Object({
  summary: Type.String({
    description: "Short user-facing summary of what this iteration produced (2-5 lines).",
  }),
  keepGoing: Type.Optional(
    Type.Boolean({
      description:
        "false stops the loop (task finished or cannot progress) and unlocks human input. Defaults to true.",
    }),
  ),
  nextDelayMs: Type.Optional(
    Type.Number({
      description: "Optional delay before the next iteration in milliseconds. Defaults to the loop rhythm.",
    }),
  ),
})

export default function piLoop(pi: ExtensionAPI): void {
  if (process.env.PI_LOOP_DISABLED === "1") return

  const { config, source } = loadLoopConfig(getAgentDir())
  const exitKeyLabel = config.exitKeys.join(" / ")

  // 每个 session 一个闭包；/reload 与 session 替换都会重新执行 factory。
  let latestCtx: ExtensionContext | undefined
  let terminalInputOff: (() => void) | undefined
  let eventUnsubscribe: (() => void) | undefined
  let lastLockNoticeAt = 0

  const machine = createLoopMachine({
    send: (request) => sendIteration(request),
    onChange: () => refreshUi(),
    stopped: (info) => handleStopped(info.reason, info.snapshot),
    runningSubagents: () => runningSubagentCount(),
    canDispatch: () => latestCtx?.isIdle() ?? true,
    expectDispatch: () => subagentToolAvailable(),
    didDispatch: () => dispatchedInCycle(machine.snapshot().cycleStartedAt),
    nudge: (snapshot) => {
      pi.sendMessage(
        {
          customType: ITERATION_MESSAGE_TYPE,
          content: formatDispatchNudge(snapshot),
          display: true,
          details: { iteration: snapshot.iteration, mode: snapshot.mode, task: snapshot.task, trigger: "nudge" },
        },
        { triggerTurn: true, deliverAs: "steer" },
      )
    },
    warn: (message) => notify(message, "warning"),
    cycleWarnMs: config.cycleWarnMs,
    abortCooldownMs: config.abortCooldownMs,
    implicitSettleDelayMs: config.implicitSettleDelayMs,
    maxQueuedEvents: config.maxQueuedEvents,
    exitKeyLabel,
  })

  // ── 与 pi 的交互 ────────────────────────────────────────────────────────

  function notify(message: string, type: "info" | "warning" | "error" = "info"): void {
    const ctx = latestCtx
    if (!ctx) return
    if (ctx.hasUI) ctx.ui.notify(message, type)
    else console.log(message)
  }

  function sendIteration(request: IterationRequest): void {
    pi.sendMessage(
      {
        customType: ITERATION_MESSAGE_TYPE,
        content: formatIterationMessage(request),
        display: true,
        details: {
          iteration: request.iteration,
          mode: request.mode,
          task: request.task,
          trigger: request.trigger,
          queuedEvents: request.events.count,
        },
      },
      { triggerTurn: true, deliverAs: "steer" },
    )
  }

  function sendNotice(notice: LoopNotice): void {
    pi.sendMessage(
      {
        customType: NOTICE_MESSAGE_TYPE,
        content: formatNoticeText(notice),
        display: true,
        details: { title: notice.title, tone: notice.tone },
      },
      { triggerTurn: false },
    )
  }

  function refreshUi(): void {
    const ctx = latestCtx
    if (!ctx?.hasUI) return
    const key = panelKey()
    const snapshot = machine.snapshot()
    if (!snapshot.active) {
      ctx.ui.setWidget(key, undefined)
      ctx.ui.setStatus(key, undefined)
      return
    }
    if (ctx.mode !== "tui") return
    ctx.ui.setWidget(
      key,
      (_tui, theme) => ({
        render: (width: number) => renderLoopPanel(machine.snapshot(), theme, width, exitKeyLabel),
        invalidate: () => {},
      }),
      { placement: "aboveEditor" },
    )
    ctx.ui.setStatus(key, formatStatusLine(snapshot))
  }

  /** 终端层锁输入：文本被吞掉，Esc / Ctrl+C / Ctrl+D 等应用级按键照常透传。 */
  function installInputLock(ctx: ExtensionContext): void {
    removeInputLock()
    if (ctx.mode !== "tui") return
    terminalInputOff = ctx.ui.onTerminalInput((data) => {
      if (!machine.snapshot().active) return undefined
      if (matchesExitInput(data, config.exitKeys)) {
        machine.stop("user")
        return { consume: true }
      }
      if (isTextualInput(data)) return { consume: true }
      return undefined
    })
    // 锁输入前先清掉用户正在写的内容，避免残留草稿在解锁后被误提交。
    ctx.ui.setEditorText("")
  }

  function removeInputLock(): void {
    terminalInputOff?.()
    terminalInputOff = undefined
  }

  function subscribeEvents(spec: LoopSpec): void {
    unsubscribeEvents()
    if (spec.mode !== "event" || !spec.channel) return
    eventUnsubscribe = pi.events.on(spec.channel, (payload) => machine.onEvent(payload))
  }

  function unsubscribeEvents(): void {
    eventUnsubscribe?.()
    eventUnsubscribe = undefined
  }

  function handleStopped(reason: string, snapshot: LoopSnapshot): void {
    removeInputLock()
    unsubscribeEvents()
    refreshUi()
    if (reason === "shutdown") return
    const notice = formatStopNotice(snapshot, reason)
    notify(`${notice.title} — ${snapshot.completed} iteration(s), input unlocked`, notice.tone === "warning" ? "warning" : "info")
    sendNotice(notice)
  }

  async function startLoop(spec: LoopSpec, ctx: ExtensionCommandContext): Promise<void> {
    if (machine.snapshot().active) {
      notify(`pi-loop 已在运行；用 /loop stop 或 ${exitKeyLabel} 退出后再启动新的 loop`, "warning")
      return
    }
    if (spec.mode === "interval" && (spec.intervalMs ?? 0) < config.minIntervalMs) {
      notify(
        `间隔 ${formatDuration(spec.intervalMs ?? 0)} 小于下限 ${formatDuration(config.minIntervalMs)}，已拒绝启动`,
        "warning",
      )
      return
    }

    await ctx.waitForIdle()
    installInputLock(ctx)
    subscribeEvents(spec)
    machine.start(spec)
    const notice = formatStartNotice(machine.snapshot(), exitKeyLabel)
    notify(`${notice.title} — ${spec.task}`, "info")
    sendNotice(notice)
  }

  /**
   * 只读判断：最近一条 assistant 消息是怎么结束的。
   *
   * `aborted` 用来区分「用户按 Esc」与「模型正常收尾」；`error` 表示这一轮
   * 已经耗尽 pi 的有界重试（鉴权错误、provider 起不来等），无人值守时继续
   * 循环只会反复失败，因此直接停掉 loop 并把错误留给用户。
   */
  function lastAssistantStopReason(ctx: ExtensionContext): "aborted" | "error" | "end" {
    const branch = ctx.sessionManager.getBranch()
    for (let i = branch.length - 1; i >= 0; i -= 1) {
      const entry = branch[i]
      if (entry.type !== "message") continue
      const message = entry.message
      if (message.role !== "assistant") continue
      if (message.stopReason === "aborted") return "aborted"
      if (message.stopReason === "error") return "error"
      return "end"
    }
    return "end"
  }

  /** 本会话是否真的能派 subagent（工具已注册且处于激活集合里）。 */
  function subagentToolAvailable(): boolean {
    return pi.getActiveTools().includes("subagent")
  }

  /**
   * 本轮（从 cycleStartedAt 起）是否已经通过 `subagent` 工具派发过。
   *
   * 直接读会话分支里的 toolResult，而不是猜运行中注册表：subagent 结束后就会从注册表里
   * 消失，只有工具结果能证明「这一轮确实派了」。
   */
  function dispatchedInCycle(since: number | undefined): boolean {
    const ctx = latestCtx
    if (!ctx || since === undefined) return false
    const branch = ctx.sessionManager.getBranch()
    for (let i = branch.length - 1; i >= 0; i -= 1) {
      const entry = branch[i]
      const at = Date.parse(entry.timestamp)
      if (Number.isFinite(at) && at < since) return false
      if (entry.type !== "message") continue
      const message = entry.message
      if (message.role !== "toolResult") continue
      if (message.toolName === "subagent") return true
    }
    return false
  }

  // ── 命令 ───────────────────────────────────────────────────────────────

  pi.registerCommand("loop", {
    description: "循环模式：/loop 5m <task> | /loop event <channel> <task> | /loop <task> | /loop stop",
    handler: async (args, ctx) => {
      latestCtx = ctx
      const usage = [...LOOP_USAGE, `  退出：${exitKeyLabel} 或 /loop stop`].join("\n")
      const parsed = parseLoopCommand(args ?? "")
      switch (parsed.kind) {
        case "help":
          notify(usage, "info")
          return
        case "error":
          notify(`${parsed.message}\n${usage}`, "warning")
          return
        case "status": {
          const snapshot = machine.snapshot()
          notify(snapshot.active ? formatStatusReport(snapshot, exitKeyLabel) : usage, "info")
          return
        }
        case "stop":
          if (!machine.snapshot().active) notify("pi-loop: 当前没有运行中的 loop", "info")
          else machine.stop("user")
          return
        case "start":
          await startLoop(parsed.spec, ctx)
          return
      }
    },
  })

  pi.registerCommand("loop-stop", {
    description: "停止 pi-loop 并解锁输入（等价于退出快捷键）",
    handler: async (_args, ctx) => {
      latestCtx = ctx
      if (!machine.snapshot().active) {
        notify("pi-loop: 当前没有运行中的 loop", "info")
        return
      }
      machine.stop("user")
    },
  })

  pi.registerCommand("loop-emit", {
    description: "向 pi.events 发一条事件以触发事件模式：/loop-emit <channel> [json]",
    handler: async (args, ctx) => {
      latestCtx = ctx
      const text = (args ?? "").trim()
      if (!text) {
        notify("用法: /loop-emit <channel> [json]", "warning")
        return
      }
      const space = text.search(/\s/)
      const channel = space === -1 ? text : text.slice(0, space)
      const payloadText = space === -1 ? "" : text.slice(space + 1).trim()
      let payload: unknown
      if (payloadText !== "") {
        try {
          payload = JSON.parse(payloadText)
        } catch {
          payload = { text: payloadText }
        }
      }
      pi.events.emit(channel, payload)
      notify(`pi-loop: 已发出事件 "${channel}"`, "info")
    },
  })

  // ── 退出快捷键 ─────────────────────────────────────────────────────────

  for (const key of config.exitKeys) {
    pi.registerShortcut(key as KeyId, {
      description: `pi-loop: 退出 loop 并解锁输入（${exitKeyLabel}）`,
      handler: (ctx) => {
        latestCtx = ctx
        if (machine.snapshot().active) machine.stop("user")
      },
    })
  }

  // ── loop_report 工具 ───────────────────────────────────────────────────

  pi.registerTool(
    defineTool<typeof reportParams, LoopReportDetails>({
      name: "loop_report",
      label: "Loop Report",
      description:
        "Report the outcome of the current pi-loop iteration and let pi schedule the next one. Only meaningful while a pi-loop loop is active: the iteration message you received carries the task. Pass a short summary for the user; pass keepGoing=false only when the task is finished or cannot progress (that stops the loop and unlocks human input). The call is rejected while a subagent from this iteration is still running — wait for its result first.",
      promptSnippet:
        "loop_report: close the current pi-loop iteration and schedule the next one (rejected while a subagent is still running)",
      parameters: reportParams,
      async execute(_toolCallId, params) {
        const before = machine.snapshot()
        const outcome: ReportOutcome = machine.report({
          summary: params.summary.trim() || "(no summary provided)",
          keepGoing: params.keepGoing !== false,
          ...(params.nextDelayMs !== undefined ? { nextDelayMs: params.nextDelayMs } : {}),
        })
        const text = outcome.ok ? formatReportAccepted(outcome, before) : formatReportRejected(outcome)
        const details: LoopReportDetails = outcome.ok
          ? { ok: true, iteration: outcome.iteration, stopped: outcome.stopped }
          : {
              ok: false,
              reason: outcome.reason,
              ...(outcome.runningSubagents !== undefined ? { runningSubagents: outcome.runningSubagents } : {}),
            }
        return { content: [{ type: "text" as const, text }], details }
      },
    }),
  )

  // ── 事件钩子 ───────────────────────────────────────────────────────────

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx
    if (source) {
      // 记一条配置来源，便于排查「改了配置没生效」；custom entry 不进模型上下文。
      pi.appendEntry("pi-loop-config", { source, config })
    }
    refreshUi()
  })

  pi.on("session_shutdown", () => {
    // 幂等：无论 quit / reload / 会话替换，都清掉定时器、监听与面板。
    machine.stop("shutdown")
  })

  pi.on("input", (event, ctx) => {
    latestCtx = ctx
    if (!machine.snapshot().active) return undefined
    // 扩展自己发出的消息不算人类输入
    if (event.source === "extension") return undefined
    const now = Date.now()
    if (now - lastLockNoticeAt > LOCK_NOTICE_INTERVAL_MS) {
      lastLockNoticeAt = now
      notify(`pi-loop 运行中：输入已锁定，按 ${exitKeyLabel} 退出 loop`, "warning")
    }
    return { action: "handled" as const }
  })

  pi.on("agent_settled", (_event, ctx) => {
    latestCtx = ctx
    const stop = lastAssistantStopReason(ctx)
    if (stop === "error") {
      // 有界重试已耗尽：无人值守的循环继续跑只会反复失败并烧钱。
      if (machine.snapshot().active) machine.stop("error")
      return
    }
    machine.onAgentSettled({ aborted: stop === "aborted" })
  })

  pi.on("before_agent_start", (event) => {
    const snapshot = machine.snapshot()
    if (!snapshot.active) return undefined
    event.systemPromptOptions.sections["pi-loop"] = formatLoopSection(snapshot, exitKeyLabel)
    return undefined
  })

  pi.on("tool_call", (event) => {
    // 输入被锁时问卷没人能回答：直接挡掉，并让模型改用 loop_report 报告阻塞。
    if (event.toolName !== "ask_user_question") return undefined
    if (!machine.snapshot().active) return undefined
    return {
      block: true,
      reason:
        "pi-loop is running with human input locked: nobody can answer this questionnaire. " +
        "Report the blocker through loop_report({ keepGoing: false }) instead, or proceed with your best judgement.",
    }
  })

  // ── 渲染 ───────────────────────────────────────────────────────────────

  pi.registerMessageRenderer<{ iteration?: number; mode?: string; task?: string; trigger?: string }>(
    ITERATION_MESSAGE_TYPE,
    (message, options, theme) =>
      loopMessageComponent(
        {
          title: `pi-loop iteration ${message.details?.iteration ?? "?"}`,
          subtitle: `${message.details?.mode ?? ""} · ${message.details?.task ?? ""}`,
          body: typeof message.content === "string" ? message.content : "",
          tone: "accent",
        },
        options,
        theme,
      ),
  )

  pi.registerMessageRenderer<{ title?: string; tone?: string }>(NOTICE_MESSAGE_TYPE, (message, options, theme) =>
    loopMessageComponent(
      {
        title: message.details?.title ?? "pi-loop",
        subtitle: "",
        body: typeof message.content === "string" ? message.content : "",
        tone: message.details?.tone === "success" ? "success" : message.details?.tone === "warning" ? "warning" : "muted",
      },
      options,
      theme,
    ),
  )

  // 画一次空状态：/reload 或会话替换后清掉上一次残留的 widget。
  refreshUi()

}

function loopMessageComponent(
  input: { title: string; subtitle: string; body: string; tone: "accent" | "success" | "warning" | "muted" },
  options: MessageRenderOptions,
  theme: Theme,
): Component {
  return {
    render: (width: number) => renderLoopMessage(input, options.expanded, theme, width),
    invalidate: () => {},
  }
}
