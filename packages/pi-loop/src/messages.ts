/**
 * 交给主 agent 的文本（迭代指令、系统提示词补充、`loop_report` 回执）。
 *
 * 这些字符串决定了主 agent 在 loop 里的行为，因此单独成模块并加以注释：
 * 每一轮都要求它「只做调度与汇总」——把实际工作交给 subagent，自己只负责下发、
 * 判读结果、写摘要、然后调用 `loop_report` 推进节奏。
 */

import { formatDuration } from "./duration.ts"
import type { IterationRequest, LoopSnapshot, ReportOutcome } from "./loop-machine.ts"

function rhythmPhrase(snapshot: LoopSnapshot | IterationRequest): string {
  if (snapshot.mode === "interval") return `every ${formatDuration(snapshot.intervalMs ?? 0)}`
  if (snapshot.mode === "event") return `on event "${snapshot.channel ?? "?"}"`
  if (snapshot.mode === "cron") return `cron "${snapshot.cronExpr ?? "?"}"`
  return "self-paced (next iteration starts after the report)"
}

function triggerPhrase(request: IterationRequest): string {
  if (request.trigger === "event") return "event"
  if (request.trigger === "kickoff") return "loop start"
  return "interval timer"
}

function stringifyPayload(payload: unknown): string {
  if (typeof payload === "string") return payload
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    return String(payload)
  }
}

/** 每轮注入给主 agent 的消息（作为自定义消息进入上下文，并触发一次回合）。 */
export function formatIterationMessage(request: IterationRequest): string {
  const lines: string[] = []
  lines.push(`[pi-loop] iteration ${request.iteration} · ${rhythmPhrase(request)} · trigger: ${triggerPhrase(request)}`)
  lines.push("")
  lines.push("You are the loop ORCHESTRATOR for this iteration. pi owns the rhythm; you own dispatch and summary.")
  lines.push("")
  lines.push("1. Dispatch: call the `subagent` tool for the task below — always, even when the task looks small. The")
  lines.push("   iteration's work must run in its own subagent pane, and the agent shows up with its live status in the")
  lines.push("   Subagents widget above the editor; that is the loop's contract. Pick the agent template by the kind of")
  lines.push("   work (read-only reconnaissance vs. code changes); call `subagents_list` first if you are unsure which")
  lines.push("   templates exist. Never invent an agent name. Keep the id from the launch acknowledgement.")
  lines.push("2. Do not do the task yourself and do not duplicate it in this session. After spawning, end your turn —")
  lines.push("   the subagent result is steered back to you automatically. Never poll `subagents_status` and never")
  lines.push("   fabricate or assume a result before it arrives.")
  lines.push("3. Close the iteration: when the result arrives, judge it, write a short summary for the user (a few")
  lines.push("   lines), then call `loop_report` with { summary, keepGoing }.")
  lines.push("4. `loop_report` is rejected while a subagent is still running. Wait for the remaining results, then")
  lines.push("   report once. Use keepGoing=false only when the task is finished or cannot progress — that stops the")
  lines.push("   loop and unlocks human input.")
  lines.push("5. Human input is locked while the loop runs. Never ask the user a question (`ask_user_question` cannot")
  lines.push("   be answered); report a blocker with keepGoing=false instead.")
  lines.push("6. If the `subagent` tool does not exist in this session, do the task yourself and report as usual.")
  lines.push("")
  lines.push("Iteration task:")
  lines.push(request.task)
  if (request.events.count > 0) {
    lines.push("")
    lines.push(
      request.events.count === 1
        ? `Event payload (${request.trigger === "event" ? `channel "${request.channel ?? "?"}"` : "queued"}):`
        : `Event payloads: ${request.events.count} events arrived, ${request.events.count} coalesced into this iteration. Last payload:`,
    )
    lines.push(stringifyPayload(request.events.last))
  }
  return lines.join("\n")
}

/** loop 运行期间追加到系统提示词的段落（段名即标签名 `pi-loop`）。 */
export function formatLoopSection(snapshot: LoopSnapshot, exitKeyLabel: string): string {
  return [
    "pi-loop is ACTIVE in this session: the session runs as an unattended loop.",
    `- Task: ${snapshot.task ?? "?"} (${rhythmPhrase(snapshot)}).`,
    "- You are the orchestrator only: delegate each iteration's work to a subagent through the `subagent` tool, then",
    "  judge and summarize the result. Always dispatch — even trivial work — so the iteration shows up as a subagent",
    "  pane with its live status in the Subagents widget. Never perform the iteration's work in this session yourself.",
    "- Every iteration must end with a `loop_report` call (summary + keepGoing). It is rejected while a subagent is",
    "  still running, so report only after the results are in.",
    `- Human input is locked until the loop ends (the user exits with ${exitKeyLabel} or your report sets`,
    "  keepGoing=false). Do not ask the user questions; report blockers through loop_report instead.",
  ].join("\n")
}

/** `loop_report` 成功后的回执：告诉主 agent 下一步该做什么。 */
export function formatReportAccepted(outcome: Extract<ReportOutcome, { ok: true }>, snapshot: LoopSnapshot): string {
  if (outcome.stopped) {
    return [
      `Loop iteration ${outcome.iteration} recorded. keepGoing=false: the loop is stopped and human input is unlocked.`,
      "Do not schedule or start any further work for this loop; report the final summary to the user and end your turn.",
    ].join(" ")
  }
  if (snapshot.mode === "event") {
    return [
      `Loop iteration ${outcome.iteration} recorded. The loop is event-driven (channel "${snapshot.channel ?? "?"}"):`,
      "the next iteration starts when the next event arrives. End your turn now.",
    ].join(" ")
  }
  if (outcome.nextTickAt !== undefined) {
    const delay = Math.max(0, outcome.nextTickAt - Date.now())
    return [
      `Loop iteration ${outcome.iteration} recorded. Next iteration in ${formatDuration(delay)}` +
        ` (at ${new Date(outcome.nextTickAt).toLocaleTimeString()}).`,
      "End your turn now; the next iteration arrives as a new message.",
    ].join(" ")
  }
  return `Loop iteration ${outcome.iteration} recorded. End your turn now; the next iteration arrives as a new message.`
}

/** `loop_report` 被拒时的回执：要求主 agent 等待或忽略。 */
export function formatReportRejected(outcome: Extract<ReportOutcome, { ok: false }>): string {
  switch (outcome.reason) {
    case "subagents-running":
      return [
        `loop_report was NOT recorded: ${outcome.runningSubagents ?? 0} subagent(s) from this iteration are still running.`,
        "Wait for their results (they arrive automatically as steer messages), summarize, then call loop_report again.",
        "Do not spawn replacements and do not poll.",
      ].join(" ")
    case "not-in-iteration":
      return [
        "loop_report was NOT recorded: this iteration is already closed and no iteration is waiting for a report.",
        "Do nothing further — the next iteration arrives as a new message.",
      ].join(" ")
    case "no-loop":
      return "loop_report was NOT recorded: no pi-loop loop is active in this session. Ignore loop_report and continue normally."
  }
}

/**
 * 一轮结束却没有派发 subagent 时的补救指令（每轮最多一次）。
 *
 * 只在 `subagent` 工具确实可用时发出：这时「没有派发」意味着主 agent 自己把活干了，
 * 页面上的 subagent pane 与状态栏都不会出现，与 loop 的约定不符。
 */
export function formatDispatchNudge(snapshot: LoopSnapshot): string {
  return [
    `[pi-loop] iteration ${snapshot.iteration} ended without dispatching a subagent.`,
    "",
    "The loop's contract is that each iteration's work runs in a subagent pane (visible with its live status in the",
    "Subagents widget) and that you only dispatch, judge, and summarize. Do this now:",
    "1. call the `subagent` tool with the iteration task below;",
    "2. end your turn — the result is steered back automatically;",
    "3. when it arrives, summarize and call `loop_report` (keepGoing=false if the task is done).",
    "",
    "If a subagent genuinely cannot be used here, call `loop_report` with keepGoing=false and explain why.",
    "",
    "Iteration task:",
    snapshot.task ?? "?",
  ].join("\n")
}
