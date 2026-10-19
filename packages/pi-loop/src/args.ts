/**
 * `/loop` 命令的参数解析。纯函数，不触碰 pi API，便于单测覆盖各种写法：
 *
 *   /loop 5m check the deploy              → 固定间隔
 *   /loop event tasks:created process it   → 事件驱动
 *   /loop finish the release               → 自定节拍（无间隔，按报告推进）
 *   /loop | /loop status | /loop stop      → 状态 / 停止
 */

import { parseDuration } from "./duration.ts"

export type LoopMode = "interval" | "event" | "self"

export interface LoopSpec {
  mode: LoopMode
  /** 每一轮交给主 agent 的任务描述（原样保存，不做改写） */
  task: string
  /** mode === "interval" 时的固定间隔 */
  intervalMs?: number
  /** mode === "event" 时订阅的 pi.events channel */
  channel?: string
  /** 用户原始参数，用于状态面板回显 */
  rawArgs: string
}

export type LoopCommand =
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "stop" }
  | { kind: "start"; spec: LoopSpec }
  | { kind: "error"; message: string }

export const LOOP_USAGE: readonly string[] = [
  "pi-loop 用法:",
  "  /loop 5m <task>              每 5m 一轮（支持 30s / 90s / 2h30m）",
  "  /loop event <channel> <task>  订阅 pi.events 的 channel，每次事件触发一轮",
  "  /loop <task>                  自定节拍：上一轮报告后立即开始下一轮",
  "  /loop status                  查看当前 loop 状态",
  "  /loop stop                    停止 loop 并解锁输入",
  "  /loop-emit <channel> [json]   向事件总线发一条事件（手工触发）",
]

const STOP_WORDS = new Set(["stop", "off", "end", "cancel"])
const HELP_WORDS = new Set(["help", "-h", "--help", "usage"])
const STATUS_WORDS = new Set(["status", "state", "info"])

export function parseLoopCommand(rawArgs: string): LoopCommand {
  const raw = rawArgs ?? ""
  const args = raw.trim()
  if (!args) return { kind: "status" }

  const spaceIndex = args.search(/\s/)
  const head = (spaceIndex === -1 ? args : args.slice(0, spaceIndex)).toLowerCase()
  const rest = spaceIndex === -1 ? "" : args.slice(spaceIndex + 1).trim()

  if (STOP_WORDS.has(head)) return { kind: "stop" }
  if (STATUS_WORDS.has(head)) return { kind: "status" }
  if (HELP_WORDS.has(head)) return { kind: "help" }

  if (head === "event") {
    if (!rest) return { kind: "error", message: "event 模式需要 channel 与 task：/loop event <channel> <task>" }
    const channelEnd = rest.search(/\s/)
    const channel = channelEnd === -1 ? rest : rest.slice(0, channelEnd)
    const task = channelEnd === -1 ? "" : rest.slice(channelEnd + 1).trim()
    if (!channel) return { kind: "error", message: "event 模式缺少 channel" }
    if (!task) return { kind: "error", message: `event 模式缺少 task：/loop event ${channel} <task>` }
    return { kind: "start", spec: { mode: "event", channel, task, rawArgs: args } }
  }

  // 首个 token 是时长 → 固定间隔；否则整条参数就是任务，走自定节拍。
  const duration = parseDuration(head)
  if (duration.ok) {
    if (!rest) return { kind: "error", message: `缺少 task：/loop ${head} <task>` }
    return { kind: "start", spec: { mode: "interval", intervalMs: duration.ms, task: rest, rawArgs: args } }
  }

  return { kind: "start", spec: { mode: "self", task: args, rawArgs: args } }
}
