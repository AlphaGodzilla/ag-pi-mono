/**
 * crontab 的 5 段表达式解析与「下一次触发时刻」计算（本机时区）。
 *
 * 支持常见字段写法：星号、星号加 `/n` 的步长、区间 `a-b`、区间加步长、逗号列表、
 * 单个值，以及标准 cron 的起点加步长（`a/n` 表示从 a 到字段上界）。不支持宏
 * （`@daily` 等）与秒级字段。
 *
 * 语义与 Vixie cron 对齐（这两点是常见误解，单测里各有一条）：
 *   - 「日」与「周」同时被限制时取**或**：任一侧命中即当天触发；
 *   - 只在「指定时刻」触发，不做补跑：错过的一次不再补。
 *
 * 下一次触发永远**严格晚于**传入时刻，且秒位归零（cron 的最小粒度是分钟）。
 */

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
] as const

/** 找一个触发时刻最多往后看多少天：覆盖 2 月 29 日（闰年间隔最长 8 年，取 8 年足够）。 */
const MAX_LOOKAHEAD_DAYS = 366 * 8

export interface CronSpec {
  /** 规范化后的表达式（单空格分隔） */
  expr: string
  minutes: number[]
  hours: number[]
  daysOfMonth: number[]
  months: number[]
  /** 周日 = 0；`7` 已归一到 0 */
  daysOfWeek: number[]
  /** 「日」字段是否不是 `*`（Vixie 的或语义需要） */
  domRestricted: boolean
  /** 「周」字段是否不是 `*` */
  dowRestricted: boolean
}

export type CronParseResult = { ok: true; spec: CronSpec } | { ok: false; reason: string }

function parseNumberList(text: string, min: number, max: number): { values: number[]; reason?: string } {
  const values = new Set<number>()
  for (const part of text.split(",")) {
    const token = part.trim()
    if (token === "") return { values: [], reason: "empty list item" }

    const stepSplit = token.split("/")
    if (stepSplit.length > 2) return { values: [], reason: `invalid step "${token}"` }
    const base = stepSplit[0] ?? ""
    const step = stepSplit.length === 2 ? stepSplit[1] : undefined
    let stepValue = 1
    if (step !== undefined) {
      if (!/^\d+$/.test(step)) return { values: [], reason: `invalid step "${token}"` }
      stepValue = Number(step)
      if (stepValue <= 0) return { values: [], reason: `step must be >= 1 in "${token}"` }
    }

    let start: number
    let end: number
    if (base === "*") {
      start = min
      end = max
    } else if (base.includes("-")) {
      const [fromText, toText] = base.split("-")
      if (!/^\d+$/.test(fromText ?? "") || !/^\d+$/.test(toText ?? "")) {
        return { values: [], reason: `invalid range "${token}"` }
      }
      start = Number(fromText)
      end = Number(toText)
    } else {
      if (!/^\d+$/.test(base)) return { values: [], reason: `invalid value "${token}"` }
      start = Number(base)
      // `a/n` 在标准 cron 里表示 a..上界 步长 n；纯 `a` 只取 a
      end = step !== undefined ? max : start
    }

    if (start < min || start > max || end < min || end > max) {
      return { values: [], reason: `"${token}" out of range ${min}-${max}` }
    }
    if (start > end) return { values: [], reason: `range "${token}" starts after it ends` }

    for (let value = start; value <= end; value += stepValue) values.add(value)
  }
  return { values: [...values].sort((a, b) => a - b) }
}

/** 解析 5 段表达式；非法输入返回可直接展示给用户的原因。 */
export function parseCronExpression(expr: string): CronParseResult {
  const fields = expr.trim().split(/\s+/).filter((field) => field !== "")
  if (fields.length !== 5) {
    return { ok: false, reason: `expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}` }
  }

  const parsed: number[][] = []
  for (let i = 0; i < FIELDS.length; i += 1) {
    const field = FIELDS[i]!
    const text = fields[i]!
    const result = parseNumberList(text, field.min, field.max)
    if (result.reason) return { ok: false, reason: `${field.name} "${text}": ${result.reason}` }
    parsed.push(result.values)
  }

  const daysOfWeek = [...new Set(parsed[4]!.map((value) => (value === 7 ? 0 : value)))].sort((a, b) => a - b)

  return {
    ok: true,
    spec: {
      expr: fields.join(" "),
      minutes: parsed[0]!,
      hours: parsed[1]!,
      daysOfMonth: parsed[2]!,
      months: parsed[3]!,
      daysOfWeek,
      domRestricted: fields[2] !== "*",
      dowRestricted: fields[4] !== "*",
    },
  }
}

function dayMatches(spec: CronSpec, day: Date): boolean {
  if (!spec.months.includes(day.getMonth() + 1)) return false
  const domMatch = spec.daysOfMonth.includes(day.getDate())
  const dowMatch = spec.daysOfWeek.includes(day.getDay())
  if (!spec.domRestricted && !spec.dowRestricted) return true
  if (spec.domRestricted && spec.dowRestricted) return domMatch || dowMatch
  return spec.domRestricted ? domMatch : dowMatch
}

/** 下一个**严格晚于** `fromMs` 的触发时刻（毫秒，本机时区）；找不到时返回 undefined。 */
export function nextCronTime(spec: CronSpec, fromMs: number): number | undefined {
  const from = new Date(fromMs)
  const baseYear = from.getFullYear()
  const baseMonth = from.getMonth()
  const baseDate = from.getDate()

  for (let offset = 0; offset <= MAX_LOOKAHEAD_DAYS; offset += 1) {
    const day = new Date(baseYear, baseMonth, baseDate + offset)
    if (!dayMatches(spec, day)) continue
    for (const hour of spec.hours) {
      for (const minute of spec.minutes) {
        const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0)
        // 夏令时跳过的本地时刻会被 Date 滚到别的小时，按「不存在则跳过」处理
        if (candidate.getHours() !== hour || candidate.getMinutes() !== minute) continue
        if (candidate.getTime() > fromMs) return candidate.getTime()
      }
    }
  }
  return undefined
}

/** 表达式是否在可预见范围内至少还会触发一次（用于启动期拒绝 `0 0 30 2 *` 这类永不触发的写法）。 */
export function hasUpcomingRun(spec: CronSpec, fromMs: number): boolean {
  return nextCronTime(spec, fromMs) !== undefined
}
