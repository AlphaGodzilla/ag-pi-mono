/**
 * loop 状态机（纯逻辑，不触碰 pi API）：
 *
 *   start(spec) ──► 触发第 1 轮 ──► send(iteration) ──► 等 loop_report / 回合结束
 *                                        ▲                      │
 *                                        └── schedule ◄──── finish(continue)
 *
 * 节奏由**报告**决定：每轮结束后按模式重新计时，因此永远不会出现「上一轮还没结束就
 * 触发下一轮」的重叠。三个模式：
 *
 *   - interval：报告后等固定间隔（报告可给 nextDelayMs 覆盖本次）
 *   - self    ：报告后立刻（或按报告给的 nextDelayMs）
 *   - event   ：报告后等下一个事件；事件在轮内到达时排队合并，轮结束立即补一轮
 *
 * 关键的防呆：
 *   - 本轮还有 subagent 在跑时拒绝「继续」类报告，避免报告和结果错位；
 *   - 模型没有调用 loop_report 就结束回合（agent_settled）时按隐式报告推进，
 *     于是忘调工具只会退化成「按回合边界推进」，不会让 loop 静默停摆；
 *   - 每轮最长告警（cycleWarnMs）只提醒，不擅自中断在跑的回合。
 */

import type { LoopMode, LoopSpec } from "./args.ts"
import { nextCronTime } from "./cron.ts"

export type { LoopMode, LoopSpec }

export type TimerHandle = ReturnType<typeof setTimeout>

export type StopReason = "user" | "done" | "error" | "shutdown" | "replaced"

export type CycleState = "idle" | "running"

export type TriggerKind = "timer" | "event" | "kickoff"

export interface QueuedEvents {
  count: number
  last?: unknown
}

export interface IterationRequest {
  iteration: number
  mode: LoopMode
  task: string
  intervalMs?: number
  channel?: string
  /** mode === "cron" 时的规范化表达式 */
  cronExpr?: string
  trigger: TriggerKind
  events: QueuedEvents
  exitKeyLabel: string
}

export interface LoopSnapshot {
  active: boolean
  mode?: LoopMode
  task?: string
  intervalMs?: number
  channel?: string
  /** mode === "cron" 时的规范化表达式 */
  cronExpr?: string
  iteration: number
  completed: number
  cycle: CycleState
  startedAt?: number
  cycleStartedAt?: number
  nextTickAt?: number
  queuedEvents: number
  lastSummary?: string
  lastOutcome?: string
  cycleWarning: boolean
}

export type ReportRejection = "no-loop" | "not-in-iteration" | "subagents-running"

export type ReportOutcome =
  | { ok: true; stopped: boolean; iteration: number; nextTickAt?: number }
  | { ok: false; reason: ReportRejection; runningSubagents?: number }

export interface ReportInput {
  summary: string
  /** false 表示本轮是最后一轮，loop 停止并解锁输入 */
  keepGoing: boolean
  /** 覆盖本次的推进间隔（毫秒）；不传时按模式默认 */
  nextDelayMs?: number
}

export interface StopInfo {
  reason: StopReason
  snapshot: LoopSnapshot
}

export interface LoopMachineOptions {
  /** 把一轮任务派给主 agent */
  send: (request: IterationRequest) => void
  /** 状态变化（面板刷新） */
  onChange: () => void
  /** loop 结束 */
  stopped: (info: StopInfo) => void
  /** 仍在运行的 subagent 数量（pi-interactive-subagents 缺席时为 0） */
  runningSubagents?: () => number
  /** 告警通道（单轮超时等） */
  warn?: (message: string) => void
  cycleWarnMs?: number
  abortCooldownMs?: number
  implicitSettleDelayMs?: number
  maxQueuedEvents?: number
  exitKeyLabel?: string
  /** 只有主会话空闲时才派发新的一轮；忙碌时轮询等待（避免把迭代撞进正在跑的回合） */
  canDispatch?: () => boolean
  /** 忙碌时重试派发的间隔 */
  dispatchGateMs?: number
  /** 单次定时器最长时长；超过则分段续期（setTimeout 超过 2^31-1ms 会立即触发） */
  maxTimerChunkMs?: number
  /** 本会话是否具备派发 subagent 的能力（`subagent` 工具可用） */
  expectDispatch?: () => boolean
  /** 本轮是否已经真的通过 `subagent` 工具派发过 */
  didDispatch?: () => boolean
  /** 一轮结束却没派发 subagent 时的补救指令（每轮最多一次） */
  nudge?: (snapshot: LoopSnapshot) => void
  now?: () => number
  setTimer?: (fn: () => void, delayMs: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
}

export interface LoopMachine {
  start(spec: LoopSpec): void
  stop(reason: StopReason): void
  report(input: ReportInput): ReportOutcome
  onAgentSettled(input?: { aborted?: boolean }): void
  onEvent(payload: unknown): void
  snapshot(): LoopSnapshot
}

interface InternalState {
  active: boolean
  spec?: LoopSpec
  iteration: number
  completed: number
  cycle: CycleState
  startedAt?: number
  cycleStartedAt?: number
  nextTickAt?: number
  lastSummary?: string
  lastOutcome?: string
  cycleWarning: boolean
  /** 本轮是否已经因为「没派 subagent」提醒过一次 */
  nudged: boolean
  queue: unknown[]
  queuedOverflow: number
}

export function createLoopMachine(options: LoopMachineOptions): LoopMachine {
  const now = options.now ?? (() => Date.now())
  const setTimer =
    options.setTimer ??
    ((fn, delayMs) => {
      const handle = setTimeout(fn, delayMs)
      // 定时器不应拖住进程退出
      handle.unref?.()
      return handle
    })
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))
  const runningSubagents = options.runningSubagents ?? (() => 0)
  const maxQueuedEvents = Math.max(0, options.maxQueuedEvents ?? 5)
  const implicitSettleDelayMs = Math.max(0, options.implicitSettleDelayMs ?? 3_000)
  const abortCooldownMs = Math.max(0, options.abortCooldownMs ?? 30_000)
  const cycleWarnMs = Math.max(0, options.cycleWarnMs ?? 0)
  const exitKeyLabel = options.exitKeyLabel ?? "ctrl+shift+l"
  const dispatchGateMs = Math.max(50, options.dispatchGateMs ?? 500)
  const maxTimerChunkMs = Math.max(1, options.maxTimerChunkMs ?? 300_000)
  const canDispatch = options.canDispatch ?? (() => true)

  const state: InternalState = {
    active: false,
    iteration: 0,
    completed: 0,
    cycle: "idle",
    cycleWarning: false,
    nudged: false,
    queue: [],
    queuedOverflow: 0,
  }

  let nextTimer: TimerHandle | undefined
  let warnTimer: TimerHandle | undefined

  function snapshot(): LoopSnapshot {
    return {
      active: state.active,
      ...(state.spec ? { mode: state.spec.mode, task: state.spec.task } : {}),
      ...(state.spec?.intervalMs !== undefined ? { intervalMs: state.spec.intervalMs } : {}),
      ...(state.spec?.channel !== undefined ? { channel: state.spec.channel } : {}),
      ...(state.spec?.cron ? { cronExpr: state.spec.cron.expr } : {}),
      iteration: state.iteration,
      completed: state.completed,
      cycle: state.cycle,
      ...(state.startedAt !== undefined ? { startedAt: state.startedAt } : {}),
      ...(state.cycleStartedAt !== undefined ? { cycleStartedAt: state.cycleStartedAt } : {}),
      ...(state.nextTickAt !== undefined ? { nextTickAt: state.nextTickAt } : {}),
      queuedEvents: state.queue.length,
      ...(state.lastSummary !== undefined ? { lastSummary: state.lastSummary } : {}),
      ...(state.lastOutcome !== undefined ? { lastOutcome: state.lastOutcome } : {}),
      cycleWarning: state.cycleWarning,
    }
  }

  function clearNextTimer(): void {
    if (nextTimer !== undefined) {
      clearTimer(nextTimer)
      nextTimer = undefined
    }
  }

  function clearWarnTimer(): void {
    if (warnTimer !== undefined) {
      clearTimer(warnTimer)
      warnTimer = undefined
    }
  }

  function clearTimers(): void {
    clearNextTimer()
    clearWarnTimer()
  }

  function armCycleWarning(): void {
    clearWarnTimer()
    if (!state.active || state.cycle !== "running" || cycleWarnMs <= 0) return
    const startIteration = state.iteration
    warnTimer = setTimer(() => {
      warnTimer = undefined
      if (!state.active || state.cycle !== "running" || state.iteration !== startIteration) return
      state.cycleWarning = true
      options.onChange()
      options.warn?.(
        `[pi-loop] iteration ${startIteration} has been running for over ${Math.round(cycleWarnMs / 60_000)}m; ` +
          `waiting for loop_report. Use the exit key (${exitKeyLabel}) to stop the loop.`,
      )
    }, cycleWarnMs)
  }

  function takeEvents(): QueuedEvents {
    const count = state.queue.length + state.queuedOverflow
    const last = state.queue[state.queue.length - 1]
    state.queue = []
    state.queuedOverflow = 0
    return { count, ...(last !== undefined ? { last } : {}) }
  }

  function trigger(kind: TriggerKind): void {
    if (!state.active || state.cycle === "running") return
    const spec = state.spec
    if (!spec) throw new Error("[pi-loop] internal error: active loop without a spec")

    // 主会话还在跑（例如模型仍在收尾）时不并发开新一轮：轮询等待空闲。
    if (!canDispatch()) {
      state.nextTickAt = now() + dispatchGateMs
      options.onChange()
      clearNextTimer()
      nextTimer = setTimer(() => {
        nextTimer = undefined
        trigger(kind)
      }, dispatchGateMs)
      return
    }

    state.cycle = "running"
    state.iteration = state.completed + 1
    state.cycleStartedAt = now()
    state.nextTickAt = undefined
    state.cycleWarning = false
    state.nudged = false
    const events = takeEvents()

    options.send({
      iteration: state.iteration,
      mode: spec.mode,
      task: spec.task,
      ...(spec.intervalMs !== undefined ? { intervalMs: spec.intervalMs } : {}),
      ...(spec.channel !== undefined ? { channel: spec.channel } : {}),
      ...(spec.cron ? { cronExpr: spec.cron.expr } : {}),
      trigger: kind,
      events,
      exitKeyLabel,
    })
    armCycleWarning()
    options.onChange()
  }

  /**
   * 分段续期：Node 的 setTimeout 超过 2^31-1ms（约 24.8 天）会立刻触发，
   * 而 cron 的「每月 1 号」这类间隔可能更久，因此按时长切片重复挂表。
   */
  function armNextTimer(): void {
    clearNextTimer()
    const target = state.nextTickAt
    if (target === undefined) return
    const remaining = target - now()
    nextTimer = setTimer(() => {
      nextTimer = undefined
      if ((state.nextTickAt ?? 0) > now()) {
        armNextTimer()
        return
      }
      trigger("timer")
    }, Math.min(Math.max(0, remaining), maxTimerChunkMs))
  }

  function schedule(delayMs: number): void {
    state.nextTickAt = now() + Math.max(0, Math.round(delayMs))
    armNextTimer()
    options.onChange()
  }

  function stop(reason: StopReason): void {
    if (!state.active) return
    clearTimers()
    state.active = false
    state.cycle = "idle"
    state.nextTickAt = undefined
    state.queue = []
    state.queuedOverflow = 0
    const finalSnapshot = snapshot()
    options.onChange()
    options.stopped({ reason, snapshot: finalSnapshot })
  }

  function finishCycle(input: {
    keepGoing: boolean
    summary: string
    nextDelayMs?: number
    outcome: string
  }): void {
    clearWarnTimer()
    state.cycle = "idle"
    state.completed += 1
    state.lastSummary = input.summary
    state.lastOutcome = input.outcome
    options.onChange()

    if (!input.keepGoing) {
      stop("done")
      return
    }

    const spec = state.spec
    if (!spec) throw new Error("[pi-loop] internal error: active loop without a spec")

    if (spec.mode === "event") {
      if (state.queue.length + state.queuedOverflow > 0) {
        trigger("event")
        return
      }
      state.nextTickAt = undefined
      options.onChange()
      return
    }

    if (spec.mode === "cron") {
      if (input.nextDelayMs !== undefined) {
        schedule(input.nextDelayMs)
        return
      }
      const next = spec.cron ? nextCronTime(spec.cron, now()) : undefined
      if (next === undefined) {
        options.warn?.(`[pi-loop] cron expression "${spec.cron?.expr ?? "?"}" has no future run; stopping the loop.`)
        stop("error")
        return
      }
      schedule(next - now())
      return
    }

    const fallback = spec.mode === "interval" ? (spec.intervalMs ?? 0) : 0
    schedule(input.nextDelayMs ?? fallback)
  }

  function start(spec: LoopSpec): void {
    if (state.active) throw new Error("[pi-loop] a loop is already running")

    state.active = true
    state.spec = spec
    state.iteration = 0
    state.completed = 0
    state.cycle = "idle"
    state.startedAt = now()
    state.cycleStartedAt = undefined
    state.nextTickAt = undefined
    state.lastSummary = undefined
    state.lastOutcome = undefined
    state.cycleWarning = false
    state.nudged = false
    state.queue = []
    state.queuedOverflow = 0

    if (spec.mode === "event") {
      // 事件驱动：等第一件事发生，不主动开跑
      options.onChange()
      return
    }
    if (spec.mode === "cron") {
      // cron 按绝对钟点：等下一个触发时刻，不立即开跑
      const next = spec.cron ? nextCronTime(spec.cron, state.startedAt ?? now()) : undefined
      if (next === undefined) {
        options.warn?.(`[pi-loop] cron expression "${spec.cron?.expr ?? "?"}" has no future run; nothing to schedule.`)
        stop("error")
        return
      }
      schedule(next - (state.startedAt ?? now()))
      return
    }
    trigger("kickoff")
  }

  function report(input: ReportInput): ReportOutcome {
    if (!state.active) return { ok: false, reason: "no-loop" }
    if (state.cycle !== "running") return { ok: false, reason: "not-in-iteration" }

    const running = runningSubagents()
    if (input.keepGoing && running > 0) {
      return { ok: false, reason: "subagents-running", runningSubagents: running }
    }

    finishCycle({
      keepGoing: input.keepGoing,
      summary: input.summary,
      ...(input.nextDelayMs !== undefined ? { nextDelayMs: input.nextDelayMs } : {}),
      outcome: input.keepGoing ? "reported" : "reported-done",
    })

    return {
      ok: true,
      stopped: !state.active,
      iteration: state.completed,
      ...(state.nextTickAt !== undefined ? { nextTickAt: state.nextTickAt } : {}),
    }
  }

  /**
   * 回合结束（pi 的 agent_settled）且本轮还没收到报告时，按隐式报告推进。
   *
   * 还有 subagent 在跑就什么都不做：结果会作为 steer 消息唤醒主 agent，
   * 那一轮再报告或再 settle。
   *
   * 有 `subagent` 工具却没派发就结束了回合：说明主 agent 自己把活干了，页面上不会出现
   * subagent pane 与状态栏。先补一条提醒（每轮最多一次），让它按 loop 约定派发。
   */
  function onAgentSettled(input: { aborted?: boolean } = {}): void {
    if (!state.active || state.cycle !== "running") return
    if (runningSubagents() > 0) return

    const expectDispatch = options.expectDispatch?.() === true
    const dispatched = !expectDispatch || options.didDispatch?.() === true
    if (!dispatched && !state.nudged && options.nudge) {
      state.nudged = true
      options.onChange()
      options.nudge(snapshot())
      return
    }

    const aborted = input.aborted === true
    // 固定间隔模式下隐式报告仍走 interval；自定节拍与中断才用兜底延迟，
    // 避免模型忘调 loop_report 时变成忙等循环。
    // cron 按绝对钟点，冷启动/中断都不改节奏；其余模式按中断冷却与自定节拍兜底。
    const nextDelayMs =
      state.spec?.mode === "cron"
        ? undefined
        : aborted
          ? abortCooldownMs
          : state.spec?.mode === "self"
            ? implicitSettleDelayMs
            : undefined
    finishCycle({
      keepGoing: true,
      summary: state.lastSummary ?? "(iteration ended without loop_report)",
      ...(nextDelayMs !== undefined ? { nextDelayMs } : {}),
      outcome: aborted ? "aborted" : "implicit",
    })
  }

  function onEvent(payload: unknown): void {
    if (!state.active || state.spec?.mode !== "event") return
    if (state.queue.length < maxQueuedEvents) state.queue.push(payload)
    else state.queuedOverflow += 1

    if (state.cycle === "running") {
      options.onChange()
      return
    }
    trigger("event")
  }

  return {
    start,
    stop,
    report,
    onAgentSettled,
    onEvent,
    snapshot,
  }
}
