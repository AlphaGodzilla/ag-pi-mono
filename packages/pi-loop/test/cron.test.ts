import assert from "node:assert/strict"
import { test } from "node:test"

import { hasUpcomingRun, nextCronTime, parseCronExpression, type CronSpec } from "../src/cron.ts"

function spec(expr: string): CronSpec {
  const parsed = parseCronExpression(expr)
  assert.equal(parsed.ok, true, `expected "${expr}" to parse: ${parsed.ok ? "" : parsed.reason}`)
  if (!parsed.ok) throw new Error("unreachable")
  return parsed.spec
}

/** 本机时区的固定时刻，避免测试依赖 CI 的时区设置。 */
function localTime(year: number, month: number, day: number, hour: number, minute: number, second = 0): number {
  return new Date(year, month - 1, day, hour, minute, second, 0).getTime()
}

function formatLocal(ms: number): string {
  const d = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

test("解析：通配、单值、区间、列表、步长", () => {
  assert.deepEqual(spec("* * * * *").minutes.length, 60)
  assert.deepEqual(spec("0 9 * * *").hours, [9])
  assert.deepEqual(spec("*/15 * * * *").minutes, [0, 15, 30, 45])
  assert.deepEqual(spec("1-5 * * * *").minutes, [1, 2, 3, 4, 5])
  assert.deepEqual(spec("1-5/2 * * * *").minutes, [1, 3, 5])
  assert.deepEqual(spec("0,30 * * * *").minutes, [0, 30])
  assert.deepEqual(spec("10/20 * * * *").minutes, [10, 30, 50], "a/n 表示从 a 到上界按步长取")
  assert.deepEqual(spec("0 9 * * 1-5").daysOfWeek, [1, 2, 3, 4, 5])
  assert.deepEqual(spec("0 9 * * 7").daysOfWeek, [0], "7 归一为周日 0")
  assert.deepEqual(spec("0  9  *  *  1 ").expr, "0 9 * * 1", "表达式规范化成单空格")
})

test("解析：非法表达式给出字段级原因", () => {
  const cases: Array<[string, RegExp]> = [
    ["* * * *", /expected 5 fields/],
    ["* * * * * *", /expected 5 fields/],
    ["60 * * * *", /minute .*out of range/],
    ["* 24 * * *", /hour .*out of range/],
    ["* * 0 * *", /day-of-month .*out of range/],
    ["* * * 13 *", /month .*out of range/],
    ["* * * * 8", /day-of-week .*out of range/],
    ["*/0 * * * *", /step must be >= 1/],
    ["5-1 * * * *", /starts after it ends/],
    ["a * * * *", /invalid value/],
    ["1,,2 * * * *", /empty list item/],
    ["@daily", /expected 5 fields/],
  ]
  for (const [expr, pattern] of cases) {
    const parsed = parseCronExpression(expr)
    assert.equal(parsed.ok, false, `expected "${expr}" to be rejected`)
    if (!parsed.ok) assert.match(parsed.reason, pattern)
  }
})

test("下一次触发：严格晚于当前时刻，且秒位归零", () => {
  const everyFive = spec("*/5 * * * *")
  const from = localTime(2030, 6, 10, 12, 3, 30)
  assert.equal(formatLocal(nextCronTime(everyFive, from)!), "2030-06-10 12:05")

  // 恰好在触发时刻 → 取下一个（不重跑同一分钟）
  const exact = localTime(2030, 6, 10, 12, 5, 0)
  assert.equal(formatLocal(nextCronTime(everyFive, exact)!), "2030-06-10 12:10")
})

test("下一次触发：跨小时、跨天与每周固定钟点", () => {
  const hourly = spec("0 * * * *")
  assert.equal(formatLocal(nextCronTime(hourly, localTime(2030, 6, 10, 12, 30))!), "2030-06-10 13:00")

  const dailyNine = spec("0 9 * * *")
  assert.equal(formatLocal(nextCronTime(dailyNine, localTime(2030, 6, 10, 12, 0))!), "2030-06-11 09:00")

  const weekdaysNine = spec("0 9 * * 1-5")
  // 2030-06-10 是周一，12:00 之后的下一次是周二 09:00
  assert.equal(new Date(localTime(2030, 6, 10, 12, 0)).getDay(), 1)
  assert.equal(formatLocal(nextCronTime(weekdaysNine, localTime(2030, 6, 10, 12, 0))!), "2030-06-11 09:00")
  // 周五 12:00 之后跳到下周一 09:00
  assert.equal(new Date(localTime(2030, 6, 14, 12, 0)).getDay(), 5)
  assert.equal(formatLocal(nextCronTime(weekdaysNine, localTime(2030, 6, 14, 12, 0))!), "2030-06-17 09:00")
})

test("下一次触发：日与周同时限制时取「或」（Vixie 语义）", () => {
  // 每月 1 号或每周一
  const specOr = spec("0 0 1 * 1")
  // 2030-06-10 是周一 → 命中「周一」这条，而不是等到 7 月 1 日
  const next = nextCronTime(specOr, localTime(2030, 6, 10, 12, 0))!
  assert.equal(formatLocal(next), "2030-06-17 00:00")
  // 2030-06-30 12:00 → 次日（7 月 1 日）既不是周一但命中「1 号」
  assert.equal(formatLocal(nextCronTime(specOr, localTime(2030, 6, 30, 12, 0))!), "2030-07-01 00:00")
})

test("下一次触发：2 月 29 日跨闰年，永不触发的表达式返回 undefined", () => {
  const leap = spec("0 0 29 2 *")
  const next = nextCronTime(leap, localTime(2030, 3, 1, 0, 0))!
  assert.equal(formatLocal(next), "2032-02-29 00:00")
  assert.equal(hasUpcomingRun(leap, localTime(2030, 3, 1, 0, 0)), true)

  const impossible = spec("0 0 30 2 *")
  assert.equal(nextCronTime(impossible, localTime(2030, 3, 1, 0, 0)), undefined)
  assert.equal(hasUpcomingRun(impossible, localTime(2030, 3, 1, 0, 0)), false)
})

test("下一次触发：长间隔（每月 1 号）也只在未来返回", () => {
  const monthly = spec("0 0 1 * *")
  const from = localTime(2030, 6, 2, 0, 0)
  assert.equal(formatLocal(nextCronTime(monthly, from)!), "2030-07-01 00:00")
})
