import assert from "node:assert/strict"
import { test } from "node:test"

import { LOOP_USAGE, parseLoopCommand } from "../src/args.ts"
import { formatDuration, parseDuration } from "../src/duration.ts"

test("时长解析：单位串联与小数", () => {
  assert.deepEqual(parseDuration("30s"), { ok: true, ms: 30_000 })
  assert.deepEqual(parseDuration("5m"), { ok: true, ms: 300_000 })
  assert.deepEqual(parseDuration("2h30m"), { ok: true, ms: 9_000_000 })
  assert.deepEqual(parseDuration("1.5h"), { ok: true, ms: 5_400_000 })
  assert.deepEqual(parseDuration("500ms"), { ok: true, ms: 500 })
  assert.deepEqual(parseDuration(" 1d "), { ok: true, ms: 86_400_000 })
})

test("时长解析：拒绝含糊与非法写法，并给出原因", () => {
  for (const input of ["", "5", "5 minutes", "1w", "m", "5m30", "-5m"]) {
    const result = parseDuration(input)
    assert.equal(result.ok, false, `expected ${JSON.stringify(input)} to be rejected`)
    if (!result.ok) assert.ok(result.reason.length > 0)
  }
  assert.equal(parseDuration("0s").ok, false)
})

test("时长格式化：用于面板与回执", () => {
  assert.equal(formatDuration(500), "500ms")
  assert.equal(formatDuration(5_000), "5s")
  assert.equal(formatDuration(300_000), "5m")
  assert.equal(formatDuration(5_400_000), "1h30m")
  assert.equal(formatDuration(0), "0s")
})

test("/loop 5m check the deploy → 固定间隔", () => {
  const parsed = parseLoopCommand("5m check the deploy")
  assert.deepEqual(parsed, {
    kind: "start",
    spec: { mode: "interval", intervalMs: 300_000, task: "check the deploy", rawArgs: "5m check the deploy" },
  })
})

test("/loop event tasks:created process the backlog → 事件驱动", () => {
  const parsed = parseLoopCommand("event tasks:created process the backlog")
  assert.deepEqual(parsed, {
    kind: "start",
    spec: { mode: "event", channel: "tasks:created", task: "process the backlog", rawArgs: "event tasks:created process the backlog" },
  })
})

test('/loop cron "*/5 * * * *" check the deploy → cron 模式（带引号）', () => {
  const parsed = parseLoopCommand('cron "*/5 * * * *" check the deploy')
  assert.equal(parsed.kind, "start")
  if (parsed.kind !== "start") return
  assert.equal(parsed.spec.mode, "cron")
  assert.equal(parsed.spec.task, "check the deploy")
  assert.equal(parsed.spec.cron?.expr, "*/5 * * * *")
  assert.deepEqual(parsed.spec.cron?.minutes, [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55])
})

test("/loop cron 不带引号：前 5 个 token 当表达式", () => {
  const parsed = parseLoopCommand("cron 0 9 * * 1-5 梳理夜间构建失败")
  assert.equal(parsed.kind, "start")
  if (parsed.kind !== "start") return
  assert.equal(parsed.spec.cron?.expr, "0 9 * * 1-5")
  assert.equal(parsed.spec.task, "梳理夜间构建失败")
})

test("/loop cron 的非法输入给出可执行的原因", () => {
  const cases: Array<[string, RegExp]> = [
    ["cron", /需要表达式与 task/],
    ["cron */5 * * *", /需要 5 段表达式与 task/],
    ['cron "*/5 * * * *"', /缺少 task/],
    ['cron "*/5 * * *', /缺少收尾引号/],
    ['cron "60 * * * *" 检查', /cron 表达式无效.*out of range/],
    ['cron "0 0 30 2 *" 检查', /在未来 8 年内不会触发/],
  ]
  for (const [args, pattern] of cases) {
    const parsed = parseLoopCommand(args)
    assert.equal(parsed.kind, "error", `expected ${JSON.stringify(args)} to fail`)
    if (parsed.kind === "error") assert.match(parsed.message, pattern)
  }
})

test("/loop finish the release → 自定节拍（整条参数就是任务）", () => {
  const parsed = parseLoopCommand("finish the release")
  assert.deepEqual(parsed, {
    kind: "start",
    spec: { mode: "self", task: "finish the release", rawArgs: "finish the release" },
  })
})

test("自定节拍：以数字开头但不是时长的任务不被误判", () => {
  const parsed = parseLoopCommand("3 bugs need fixing")
  assert.equal(parsed.kind, "start")
  if (parsed.kind === "start") {
    assert.equal(parsed.spec.mode, "self")
    assert.equal(parsed.spec.task, "3 bugs need fixing")
  }
})

test("/loop status / stop / help", () => {
  assert.deepEqual(parseLoopCommand(""), { kind: "status" })
  assert.deepEqual(parseLoopCommand("   "), { kind: "status" })
  assert.deepEqual(parseLoopCommand("status"), { kind: "status" })
  assert.deepEqual(parseLoopCommand("stop"), { kind: "stop" })
  assert.deepEqual(parseLoopCommand("off"), { kind: "stop" })
  assert.deepEqual(parseLoopCommand("help"), { kind: "help" })
})

test("缺少 task / channel 时报错，不静默启动空循环", () => {
  const noTask = parseLoopCommand("5m")
  assert.equal(noTask.kind, "error")
  const noEventTask = parseLoopCommand("event tasks:created")
  assert.equal(noEventTask.kind, "error")
  const noChannel = parseLoopCommand("event")
  assert.equal(noChannel.kind, "error")
})

test("用法文本逐行锁定：抬头 + 三种模式 + 状态/停止/事件命令", () => {
  // 断言整行原文：措辞漂移（例如又写成「每 5m 一轮」）必须让测试失败。
  assert.deepEqual(LOOP_USAGE, [
    "pi-loop 用法:",
    "  /loop 5m <task>              报告后等 5m 再开下一轮（支持 30s / 90s / 2h30m）",
    "  /loop event <channel> <task>  channel 有事件时开一轮，轮内事件合并到下一轮",
    '  /loop cron "<5 段表达式>" <task>  按本机时区的绝对钟点触发（如 "*/5 * * * *"）',
    "  /loop <task>                  自定节拍：上一轮报告后立即开始下一轮",
    "  /loop status                  查看当前 loop 状态",
    "  /loop stop                    停止 loop 并解锁输入",
    "  /loop-emit <channel> [json]   向事件总线发一条事件（手工触发）",
  ])
})
