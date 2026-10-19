/**
 * 面板与文本渲染。所有函数都是「snapshot + theme → 字符串」，方便单测与在
 * widget（`ui.setWidget` 的工厂）里复用。
 */

import type { Theme } from "@earendil-works/pi-coding-agent"
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { formatDuration } from "./duration.ts"
import type { LoopSnapshot } from "./loop-machine.ts"

const PANEL_KEY = "pi-loop"

export function panelKey(): string {
  return PANEL_KEY
}

/** 本地时钟 `HH:MM:SS`，用于「下一轮几点开始」，避免每秒重绘 countdown。 */
export function formatClock(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function padVisible(text: string, width: number): string {
  const truncated = truncateToWidth(text, Math.max(0, width))
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)))
}

function topBorder(title: string, info: string, width: number): string {
  const inner = Math.max(0, width - 2)
  const left = `─ ${title} `
  const right = ` ${info} ─`
  const fill = Math.max(0, inner - left.length - right.length)
  const content = `${left}${"─".repeat(fill)}${right}`.slice(0, inner)
  return `╭${content.padEnd(inner, "─")}╮`
}

function bottomBorder(width: number): string {
  const inner = Math.max(0, width - 2)
  return `╰${"─".repeat(inner)}╯`
}

function row(theme: Theme, content: string, width: number): string {
  const inner = Math.max(0, width - 2)
  return `${theme.fg("border", "│")}${padVisible(content, inner)}${theme.fg("border", "│")}`
}

function rhythmLabel(snapshot: LoopSnapshot): string {
  switch (snapshot.mode) {
    case "interval":
      return `every ${formatDuration(snapshot.intervalMs ?? 0)}`
    case "event":
      return `on event ${snapshot.channel ?? "?"}`
    case "self":
      return "self-paced"
    default:
      return "?"
  }
}

function stateLabel(snapshot: LoopSnapshot): string {
  if (snapshot.cycle === "running") {
    return snapshot.cycleWarning ? `iteration ${snapshot.iteration} (long-running)` : `iteration ${snapshot.iteration} running`
  }
  if (snapshot.mode === "event") {
    return snapshot.queuedEvents > 0 ? `waiting for report (${snapshot.queuedEvents} queued)` : "waiting for event"
  }
  if (snapshot.nextTickAt !== undefined) return `next at ${formatClock(snapshot.nextTickAt)}`
  return "waiting"
}

/**
 * 输入框上方的状态面板。行数控制在 6 行以内（pi 的 widget 上限 10 行），
 * 始终包含退出快捷键提示。
 */
export function renderLoopPanel(snapshot: LoopSnapshot, theme: Theme, width: number, exitKeyLabel: string): string[] {
  const w = Math.max(20, width)
  const lines: string[] = []
  lines.push(theme.fg("borderAccent", topBorder("pi-loop", `${snapshot.completed} done`, w)))
  lines.push(row(theme, `${theme.fg("muted", "task")} ${snapshot.task ?? "?"}`, w))
  lines.push(
    row(theme, `${theme.fg("muted", "rhythm")} ${rhythmLabel(snapshot)} ${theme.fg("dim", "·")} ${stateLabel(snapshot)}`, w),
  )
  if (snapshot.lastSummary) {
    lines.push(row(theme, `${theme.fg("muted", "last")} ${snapshot.lastSummary.replace(/\s+/g, " ")}`, w))
  }
  lines.push(
    row(
      theme,
      theme.fg("warning", `🔒 input locked — press ${exitKeyLabel} to exit the loop`),
      w,
    ),
  )
  lines.push(theme.fg("borderAccent", bottomBorder(w)))
  return lines
}

/** footer 状态栏文本（紧凑，一行）。 */
export function formatStatusLine(snapshot: LoopSnapshot): string {
  if (!snapshot.active) return ""
  const iteration = snapshot.cycle === "running" ? `it ${snapshot.iteration} running` : `${snapshot.completed} done`
  const next = snapshot.nextTickAt !== undefined ? ` · next ${formatClock(snapshot.nextTickAt)}` : ""
  return `loop · ${iteration}${next}`
}

/** `/loop status` 的多行文本。 */
export function formatStatusReport(snapshot: LoopSnapshot, exitKeyLabel: string): string {
  if (!snapshot.active) return "pi-loop: 当前没有运行中的 loop。"
  const elapsed = snapshot.startedAt !== undefined ? formatDuration(Date.now() - snapshot.startedAt) : "?"
  return [
    "pi-loop 状态:",
    `  task      ${snapshot.task ?? "?"}`,
    `  rhythm    ${rhythmLabel(snapshot)}`,
    `  state     ${stateLabel(snapshot)}`,
    `  done      ${snapshot.completed} 轮，运行 ${elapsed}`,
    `  last      ${snapshot.lastSummary ?? "-"}`,
    `  退出键    ${exitKeyLabel}`,
  ].join("\n")
}

export interface LoopNotice {
  title: string
  body: string[]
  tone: "info" | "success" | "warning"
}

/** loop 生命周期提示（开始 / 结束）——同时作为 transcript 里的自定义消息内容与通知文本。 */
export function formatStartNotice(snapshot: LoopSnapshot, exitKeyLabel: string): LoopNotice {
  const rhythm =
    snapshot.mode === "interval"
      ? `every ${formatDuration(snapshot.intervalMs ?? 0)}`
      : snapshot.mode === "event"
        ? `on event ${snapshot.channel ?? "?"}`
        : "self-paced"
  return {
    title: "pi-loop started",
    tone: "success",
    body: [
      `task: ${snapshot.task ?? "?"}`,
      `rhythm: ${rhythm}`,
      `input is locked; press ${exitKeyLabel} to exit the loop`,
    ],
  }
}

export function formatStopNotice(snapshot: LoopSnapshot, reason: string): LoopNotice {
  return {
    title: `pi-loop stopped (${reason})`,
    tone: reason === "done" ? "success" : reason === "error" ? "warning" : "info",
    body: [
      `iterations: ${snapshot.completed}`,
      `task: ${snapshot.task ?? "?"}`,
      snapshot.lastSummary ? `last: ${snapshot.lastSummary}` : "",
      "input unlocked",
    ].filter((line) => line !== ""),
  }
}

export function formatNoticeText(notice: LoopNotice): string {
  return [`[${notice.title}]`, ...notice.body].join("\n")
}

/**
 * transcript 里的自定义消息（迭代指令 / 生命周期提示）：
 * 折叠时只显示标题 + 首行，展开后显示全文。
 */
export function renderLoopMessage(
  input: { title: string; subtitle: string; body: string; tone: "accent" | "success" | "warning" | "muted" },
  expanded: boolean,
  theme: Theme,
  width: number,
): string[] {
  const icon = input.tone === "success" ? "✓" : input.tone === "warning" ? "!" : "↻"
  const color = input.tone === "accent" ? "accent" : input.tone
  const subtitle = input.subtitle.trim() === "" ? "" : ` ${theme.fg("dim", input.subtitle)}`
  const header = `${theme.fg(color, icon)} ${theme.fg("toolTitle", theme.bold(input.title))}${subtitle}`
  const lines = [truncateToWidth(header, Math.max(1, width))]
  const bodyLines = input.body.split("\n")
  if (expanded) {
    for (const line of bodyLines) lines.push(truncateToWidth(`  ${line}`, Math.max(1, width)))
    return lines
  }
  const preview = bodyLines.find((line) => line.trim() !== "") ?? ""
  if (preview.trim() !== "") lines.push(truncateToWidth(`  ${theme.fg("dim", preview)}`, Math.max(1, width)))
  return lines
}
