import assert from "node:assert/strict"
import { test } from "node:test"

import type { LoopSpec } from "../src/args.ts"
import { nextCronTime, parseCronExpression } from "../src/cron.ts"
import {
  createLoopMachine,
  type IterationRequest,
  type LoopMachineOptions,
  type StopInfo,
  type TimerHandle,
} from "../src/loop-machine.ts"

interface FakeTimer {
  id: number
  delay: number
  fn: () => void
}

interface Harness {
  machine: ReturnType<typeof createLoopMachine>
  sent: IterationRequest[]
  stops: StopInfo[]
  warnings: string[]
  timers: FakeTimer[]
  advance(ms?: number): void
  setRunningSubagents(count: number): void
  nextDelay(): number | undefined
}

function harness(overrides: Partial<LoopMachineOptions> = {}): Harness {
  let now = 1_700_000_000_000
  let timerId = 0
  let running = 0
  const timers: FakeTimer[] = []
  const sent: IterationRequest[] = []
  const stops: StopInfo[] = []
  const warnings: string[] = []

  const options: LoopMachineOptions = {
    send: (request) => sent.push(request),
    onChange: () => {},
    stopped: (info) => stops.push(info),
    runningSubagents: () => running,
    warn: (message) => warnings.push(message),
    now: () => now,
    // 默认一次挂满，chunk 行为由专门用例覆盖
    maxTimerChunkMs: 1_000_000_000,
    setTimer: (fn, delayMs) => {
      timerId += 1
      const timer: FakeTimer = { id: timerId, delay: delayMs, fn }
      timers.push(timer)
      return timer.id as unknown as TimerHandle
    },
    clearTimer: (handle) => {
      const index = timers.findIndex((timer) => timer.id === (handle as unknown as number))
      if (index >= 0) timers.splice(index, 1)
    },
    ...overrides,
  }

  const machine = createLoopMachine(options)

  return {
    machine,
    sent,
    stops,
    warnings,
    timers,
    advance(ms = 0) {
      now += ms
      // 只跑当前已经排队的定时器，跑之前摘下（运行中可能重新排新的）
      const pending = timers.splice(0, timers.length)
      for (const timer of pending) timer.fn()
    },
    setRunningSubagents(count: number) {
      running = count
    },
    nextDelay() {
      return timers[0]?.delay
    },
  }
}

const INTERVAL: LoopSpec = { mode: "interval", task: "check the deploy", intervalMs: 300_000, rawArgs: "5m check the deploy" }
const SELF: LoopSpec = { mode: "self", task: "finish the release", rawArgs: "finish the release" }
const EVENT: LoopSpec = { mode: "event", task: "process the backlog", channel: "tasks:created", rawArgs: "event tasks:created process the backlog" }

test("固定间隔：启动即开跑第一轮，报告后按 interval 重新计时", () => {
  const h = harness()
  h.machine.start(INTERVAL)

  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0]?.iteration, 1)
  assert.equal(h.sent[0]?.trigger, "kickoff")
  assert.equal(h.machine.snapshot().cycle, "running")

  const outcome = h.machine.report({ summary: "deploy is green", keepGoing: true })
  assert.equal(outcome.ok, true)
  assert.equal(h.machine.snapshot().cycle, "idle")
  assert.equal(h.nextDelay(), 300_000)

  h.advance(300_000)
  assert.equal(h.sent.length, 2)
  assert.equal(h.sent[1]?.iteration, 2)
  assert.equal(h.sent[1]?.trigger, "timer")
})

test("报告可用 nextDelayMs 覆盖本次节奏（自定节拍）", () => {
  const h = harness()
  h.machine.start(SELF)
  const outcome = h.machine.report({ summary: "step 1 done", keepGoing: true, nextDelayMs: 45_000 })
  assert.equal(outcome.ok, true)
  assert.equal(h.nextDelay(), 45_000)
})

test("自定节拍：报告后默认立即推进", () => {
  const h = harness()
  h.machine.start(SELF)
  h.machine.report({ summary: "step done", keepGoing: true })
  assert.equal(h.nextDelay(), 0)
  h.advance(0)
  assert.equal(h.sent.length, 2)
})

test("keepGoing=false 结束 loop 并回调 stopped(done)", () => {
  const h = harness()
  h.machine.start(INTERVAL)
  const outcome = h.machine.report({ summary: "release is out", keepGoing: false })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.ok && outcome.stopped, true)
  assert.equal(h.machine.snapshot().active, false)
  assert.deepEqual(
    h.stops.map((info) => info.reason),
    ["done"],
  )
  assert.equal(h.timers.length, 0)
})

test("本轮还有 subagent 在跑时拒绝继续类报告，但不阻止收尾报告", () => {
  const h = harness()
  h.machine.start(INTERVAL)
  h.setRunningSubagents(2)

  const rejected = h.machine.report({ summary: "partial", keepGoing: true })
  assert.deepEqual(rejected, { ok: false, reason: "subagents-running", runningSubagents: 2 })
  assert.equal(h.machine.snapshot().cycle, "running")
  assert.equal(h.timers.length, 0)

  const done = h.machine.report({ summary: "blocked", keepGoing: false })
  assert.equal(done.ok, true)
})

test("没有 loop 或本轮已结束时，报告被拒且不改状态", () => {
  const h = harness()
  assert.deepEqual(h.machine.report({ summary: "x", keepGoing: true }), { ok: false, reason: "no-loop" })

  h.machine.start(SELF)
  h.machine.report({ summary: "first", keepGoing: true })
  assert.deepEqual(h.machine.report({ summary: "again", keepGoing: true }), { ok: false, reason: "not-in-iteration" })
})

test("模型忘调 loop_report：回合结束按隐式报告推进", () => {
  const h = harness({ implicitSettleDelayMs: 3_000 })
  h.machine.start(SELF)
  h.setRunningSubagents(1)
  h.machine.onAgentSettled()
  assert.equal(h.machine.snapshot().cycle, "running", "subagent 还在跑时不推进")
  assert.equal(h.timers.length, 0)

  h.setRunningSubagents(0)
  h.machine.onAgentSettled()
  assert.equal(h.machine.snapshot().completed, 1)
  assert.equal(h.nextDelay(), 3_000)
})

test("有 subagent 工具却没派发就结束回合：补一条提醒，每轮只提醒一次", () => {
  const nudges: unknown[] = []
  let dispatched = false
  const h = harness({
    expectDispatch: () => true,
    didDispatch: () => dispatched,
    nudge: (snapshot) => nudges.push(snapshot),
  })
  h.machine.start(INTERVAL)

  h.machine.onAgentSettled()
  assert.equal(nudges.length, 1, "没派发 → 提醒一次")
  assert.equal(h.machine.snapshot().cycle, "running", "提醒后本轮继续，不排下一轮")
  assert.equal(h.timers.length, 0)

  h.machine.onAgentSettled()
  assert.equal(nudges.length, 1, "同一轮不再重复提醒")
  assert.equal(h.nextDelay(), 300_000, "第二次结束按隐式报告推进")
})

test("已派发 subagent 或没有 subagent 工具时不提醒", () => {
  const nudges: unknown[] = []
  const dispatched = harness({
    expectDispatch: () => true,
    didDispatch: () => true,
    nudge: (snapshot) => nudges.push(snapshot),
  })
  dispatched.machine.start(INTERVAL)
  dispatched.machine.onAgentSettled()
  assert.equal(nudges.length, 0)

  const noTool = harness({ expectDispatch: () => false, didDispatch: () => false, nudge: (s) => nudges.push(s) })
  noTool.machine.start(INTERVAL)
  noTool.machine.onAgentSettled()
  assert.equal(nudges.length, 0)
})

test("固定间隔模式下隐式报告仍用 interval，而不是兜底短延迟", () => {
  const h = harness({ implicitSettleDelayMs: 3_000 })
  h.machine.start(INTERVAL)
  h.machine.onAgentSettled()
  assert.equal(h.nextDelay(), 300_000)
})

test("用户中断回合后按 abortCooldownMs 冷却（任何模式都覆盖本次节奏）", () => {
  const self = harness({ abortCooldownMs: 30_000 })
  self.machine.start(SELF)
  self.machine.onAgentSettled({ aborted: true })
  assert.equal(self.nextDelay(), 30_000)
  assert.equal(self.machine.snapshot().lastOutcome, "aborted")

  // 固定间隔模式同样用冷却值，而不是 intervalMs
  const interval = harness({ abortCooldownMs: 30_000 })
  interval.machine.start(INTERVAL)
  interval.machine.onAgentSettled({ aborted: true })
  assert.equal(interval.nextDelay(), 30_000)
})

function cronSpec(expr: string) {
  const parsed = parseCronExpression(expr)
  if (!parsed.ok) throw new Error(parsed.reason)
  return parsed.spec
}

test("cron：启动时等下一个绝对钟点，不立即开跑", () => {
  const spec = cronSpec("*/5 * * * *")
  const h = harness()
  const startedAt = 1_700_000_000_000
  h.machine.start({ mode: "cron", task: "check the deploy", cron: spec, rawArgs: "cron */5 * * * * check the deploy" })

  assert.equal(h.sent.length, 0, "cron 不在启动时抢跑")
  const expected = nextCronTime(spec, startedAt)!
  assert.equal(h.machine.snapshot().nextTickAt, expected)
  assert.equal(h.machine.snapshot().cronExpr, "*/5 * * * *")
  assert.equal(h.nextDelay(), expected - startedAt)

  h.advance(expected - startedAt)
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0]?.trigger, "timer")
  assert.equal(h.sent[0]?.cronExpr, "*/5 * * * *")
})

test("cron：报告后按绝对钟点排下一次；间隔由时钟决定而非轮次耗时", () => {
  const spec = cronSpec("*/5 * * * *")
  const h = harness()
  h.machine.start({ mode: "cron", task: "t", cron: spec, rawArgs: "cron */5 * * * * t" })
  const firstFire = h.machine.snapshot().nextTickAt!
  h.advance(firstFire - 1_700_000_000_000)

  // 这一轮「跑了 90 秒」后才报告
  h.advance(90_000)
  const reportAt = 1_700_000_000_000 + (firstFire - 1_700_000_000_000) + 90_000
  h.machine.report({ summary: "ok", keepGoing: true })

  const expected = nextCronTime(spec, reportAt)!
  assert.equal(h.machine.snapshot().nextTickAt, expected)
})

test("cron：中断回合不套用 abortCooldown，仍按绝对钟点", () => {
  const spec = cronSpec("0 * * * *")
  const h = harness({ abortCooldownMs: 30_000 })
  h.machine.start({ mode: "cron", task: "t", cron: spec, rawArgs: "cron 0 * * * * t" })
  const fire = h.machine.snapshot().nextTickAt!
  h.advance(fire - 1_700_000_000_000)

  h.machine.onAgentSettled({ aborted: true })
  assert.notEqual(h.nextDelay(), 30_000)
  assert.equal(h.machine.snapshot().nextTickAt, nextCronTime(spec, fire)!)
})

test("cron：长间隔按 chunk 分段续期，不会一次性挂超长定时器", () => {
  const spec = cronSpec("0 0 1 * *") // 每月 1 号，可能超过一个月
  const chunk = 3_600_000
  const h = harness({ maxTimerChunkMs: chunk })
  h.machine.start({ mode: "cron", task: "t", cron: spec, rawArgs: "cron 0 0 1 * * t" })
  const target = h.machine.snapshot().nextTickAt!
  assert.ok(target - 1_700_000_000_000 > chunk, "下一次触发至少在一个 chunk 之外")
  assert.equal(h.nextDelay(), chunk, "每次只挂一个 chunk")

  // 走完所有 chunk 才真正触发（最后一段可能不足一个 chunk）
  let steps = 0
  while (h.sent.length === 0 && steps < 1_000) {
    h.advance(chunk)
    steps += 1
  }
  assert.equal(h.sent.length, 1)
  const startedAt = h.machine.snapshot().cycleStartedAt!
  assert.ok(startedAt >= target && startedAt < target + chunk, `fired at ${startedAt}, target ${target}`)
})

test("事件驱动：等事件才开跑；轮内事件排队并合并到下一轮", () => {
  const h = harness()
  h.machine.start(EVENT)
  assert.equal(h.sent.length, 0, "事件模式不主动开跑")
  assert.equal(h.machine.snapshot().active, true)

  h.machine.onEvent({ id: 1 })
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0]?.trigger, "event")
  assert.equal(h.sent[0]?.events.count, 1)

  h.machine.onEvent({ id: 2 })
  h.machine.onEvent({ id: 3 })
  assert.equal(h.sent.length, 1, "轮内事件不并发开跑")
  assert.equal(h.machine.snapshot().queuedEvents, 2)

  h.machine.report({ summary: "processed 1", keepGoing: true })
  assert.equal(h.sent.length, 2, "报告后立即补跑积压事件")
  assert.equal(h.sent[1]?.events.count, 2)
  assert.deepEqual(h.sent[1]?.events.last, { id: 3 })
  assert.equal(h.timers.length, 0, "事件模式不排定时器")
})

test("事件积压有上限，超出只计数不撑爆内存", () => {
  const h = harness({ maxQueuedEvents: 2 })
  h.machine.start(EVENT)
  h.machine.onEvent({ id: 1 })
  for (let i = 2; i <= 5; i += 1) h.machine.onEvent({ id: i })
  h.machine.report({ summary: "ok", keepGoing: true })
  assert.equal(h.sent[1]?.events.count, 4)
})

test("stop 清掉所有定时器，之后不再触发", () => {
  const h = harness()
  h.machine.start(INTERVAL)
  h.machine.report({ summary: "ok", keepGoing: true })
  assert.equal(h.timers.length, 1)
  h.machine.stop("user")
  assert.equal(h.timers.length, 0)
  h.advance(300_000)
  assert.equal(h.sent.length, 1)
  assert.deepEqual(
    h.stops.map((info) => info.reason),
    ["user"],
  )
})

test("重复 stop 与未启动时 stop 都是幂等的", () => {
  const h = harness()
  h.machine.stop("user")
  assert.equal(h.stops.length, 0)
  h.machine.start(SELF)
  h.machine.stop("user")
  h.machine.stop("shutdown")
  assert.equal(h.stops.length, 1)
})

test("单轮超时只告警并标记，不打断在跑的回合", () => {
  const h = harness({ cycleWarnMs: 60_000 })
  h.machine.start(INTERVAL)
  assert.equal(h.timers.length, 1)
  h.advance(60_000)
  assert.equal(h.warnings.length, 1)
  assert.match(h.warnings[0] ?? "", /iteration 1/)
  assert.equal(h.machine.snapshot().cycleWarning, true)
  assert.equal(h.machine.snapshot().cycle, "running")
})

test("主会话忙碌时推迟派发，空闲后才开新一轮", () => {
  let idle = true
  const h = harness({ canDispatch: () => idle, dispatchGateMs: 500 })
  h.machine.start(INTERVAL)
  assert.equal(h.sent.length, 1)

  idle = false
  h.machine.report({ summary: "ok", keepGoing: true })
  assert.equal(h.nextDelay(), 300_000)

  // 定时器到期但会话仍在跑：不开新一轮，改为每 500ms 轮询
  h.advance(300_000)
  assert.equal(h.sent.length, 1)
  assert.equal(h.nextDelay(), 500)

  idle = true
  h.advance(500)
  assert.equal(h.sent.length, 2)
  assert.equal(h.sent[1]?.iteration, 2)
})

test("同一 spec 不能重复启动（防止两套循环叠加）", () => {
  const h = harness()
  h.machine.start(INTERVAL)
  assert.throws(() => h.machine.start(SELF), /already running/)
})
