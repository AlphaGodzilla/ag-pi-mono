/**
 * 生命周期事件 → 飞书通知（任务开始 / 任务完成含总结 / 会话结束）。
 *
 * 与 pi-cmux 对齐的事件种类：before_agent_start（开始）、agent_settled（完成，
 * 比 agent_end 更贴合"任务彻底结束"，避免 retry/compaction 重复提醒）、
 * session_shutdown（结束）。均为独立事件订阅，不修改/依赖 pi-cmux。
 *
 * 发送经 pi-channel 的 `ag-pi-channel:send` 事件（凭据/投递由 pi-channel 负责）。
 *
 * 关键约束：事件 handler 必须绝对安全——任何异常都被 try/catch 兜底并写入
 * 日志文件，绝不抛入 pi 事件分发链；不向 stdout/stderr 输出任何内容，避免
 * 污染 TUI / 干扰 cmux 的 busy/idle 状态判断。
 *
 * subagent 会话默认跳过（与 pi-cmux 的 PI_CMUX_INCLUDE_SUBAGENTS 语义一致），
 * 可用 PI_FEISHU_NOTIFY_INCLUDE_SUBAGENTS=1 开启。
 */
import { join } from 'node:path'
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { logError } from './log.ts'
import { retire, safeNotify } from './notify.ts'
import { extractWorkSummary, formatTaskDoneSummary } from './summary.ts'

const SUBAGENT_SESSION_DIR = join(getAgentDir(), 'subagents', 'sessions')

function truncate(text: string, limit: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit - 3)}...`
}

function isSubagentSession(ctx: ExtensionContext): boolean {
  const file = ctx.sessionManager.getSessionFile()
  return Boolean(file && file.startsWith(SUBAGENT_SESSION_DIR))
}

function isSubagentPrompt(prompt: string): boolean {
  return prompt.trimStart().startsWith('You are a subagent helping another pi agent.')
}

function sessionKey(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionFile() ?? ctx.cwd
}

export type LifecycleDeps = {
  getEnabled: () => boolean
}

export default function registerLifecycle(pi: ExtensionAPI, deps: LifecycleDeps): void {
  const { getEnabled } = deps
  const startTimes = new Map<string, number>()
  const includeSubagents = process.env.PI_FEISHU_NOTIFY_INCLUDE_SUBAGENTS === '1'

  const shouldNotify = (ctx: ExtensionContext, prompt?: string): boolean => {
    if (!getEnabled()) return false
    if (includeSubagents) return true
    if (isSubagentSession(ctx)) return false
    if (prompt && isSubagentPrompt(prompt)) return false
    return true
  }

  /** 同步兜底：事件 handler 内的任何异常都写日志，绝不冒泡到 pi 的事件分发链。 */
  const guard = (fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      logError(`handler error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 任务开始
  pi.on('before_agent_start', async (event, ctx) => {
    guard(() => {
      const key = sessionKey(ctx)
      startTimes.set(key, Date.now())
      if (!shouldNotify(ctx, event.prompt)) return
      const text = ['🟢 任务开始', `📍 目录: ${ctx.cwd}`, `📝 ${truncate(event.prompt ?? '(空请求)', 300)}`].join('\n')
      safeNotify(pi.events, text, 'task_start')
    })
  })

  // 任务完成（含最近一次工作总结）
  pi.on('agent_settled', async (_event, ctx) => {
    guard(() => {
      const key = sessionKey(ctx)
      const started = startTimes.get(key)
      const elapsedSec = started ? Math.max(1, Math.round((Date.now() - started) / 1000)) : 0
      startTimes.delete(key)
      if (!shouldNotify(ctx)) return

      let summary: ReturnType<typeof extractWorkSummary>
      try {
        summary = extractWorkSummary(ctx.sessionManager)
      } catch (err) {
        logError(`extract summary failed: ${err instanceof Error ? err.message : String(err)}`)
        summary = { prompt: '', finalAnswer: '', tools: [], errors: [] }
      }
      safeNotify(pi.events, formatTaskDoneSummary(summary, ctx.cwd, elapsedSec), 'task_done')
    })
  })

  // 会话结束（尽力发送，可用 PI_FEISHU_NOTIFY_SESSION_END=0 关闭）
  pi.on('session_shutdown', async (event, ctx) => {
    // reload/quit 后本实例作废：其 `pi`/event bus 都已失效，继续发通知只会白等 10s 超时
    // （new/resume/fork 不退休——同一实例还要给后续会话发通知）。
    const reason = (event as { reason?: unknown } | undefined)?.reason
    if (reason === 'reload' || reason === 'quit') retire()
    guard(() => {
      if (process.env.PI_FEISHU_NOTIFY_SESSION_END === '0') return
      if (!getEnabled()) return
      const text = ['🔚 会话结束', `📍 目录: ${ctx.cwd}`].join('\n')
      safeNotify(pi.events, text, 'session_end')
    })
  })
}
