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

test("用法文本覆盖三种模式与退出方式", () => {
  const usage = LOOP_USAGE.join("\n")
  assert.match(usage, /\/loop 5m <task>/)
  assert.match(usage, /\/loop event <channel> <task>/)
  assert.match(usage, /\/loop <task>/)
  assert.match(usage, /\/loop-emit/)
})
