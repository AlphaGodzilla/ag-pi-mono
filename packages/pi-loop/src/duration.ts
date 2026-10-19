/**
 * 时长解析：只接受「数字 + 单位」的串联写法，如 `5m`、`90s`、`2h30m`、`1.5h`。
 *
 * 不猜测用户的意图：像 `5`、`5 minutes`、`1w` 这样的写法一律返回失败原因，
 * 由命令处理器把原因直接展示给用户，而不是退化成默认值。
 */

const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

/** `ms` 必须排在 `m` 之前，否则 `5ms` 会被切成长度单位 `m` + 残留 `s`。 */
const TOKEN = /(\d+(?:\.\d+)?)(ms|d|h|m|s)/g

export type DurationResult = { ok: true; ms: number } | { ok: false; reason: string }

export function parseDuration(input: string): DurationResult {
  const text = input.trim().toLowerCase()
  if (!text) return { ok: false, reason: "duration is empty" }

  let total = 0
  let consumed = 0
  for (const match of text.matchAll(TOKEN)) {
    const index = match.index ?? 0
    if (index !== consumed) {
      return { ok: false, reason: `unexpected "${text.slice(consumed, index)}" in duration "${input.trim()}"` }
    }
    consumed = index + match[0].length
    total += Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS]
  }

  if (consumed === 0) {
    return { ok: false, reason: `"${input.trim()}" is not a duration; use forms like 30s, 5m, 1h30m` }
  }
  if (consumed !== text.length) {
    return { ok: false, reason: `unexpected "${text.slice(consumed)}" in duration "${input.trim()}"` }
  }
  if (!Number.isFinite(total) || total <= 0) {
    return { ok: false, reason: `duration "${input.trim()}" must be greater than zero` }
  }
  return { ok: true, ms: Math.round(total) }
}

/** 人类可读的时长，用于状态面板与报告回执（`1500ms` → `1.5s`，`5400000` → `1h30m`）。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?"
  if (ms === 0) return "0s"
  if (ms < 1_000) return `${Math.round(ms)}ms`
  const totalSeconds = Math.round(ms / 1_000)
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  if (seconds > 0 && days === 0) parts.push(`${seconds}s`)
  return parts.length > 0 ? parts.join("") : "0s"
}
