/**
 * Permission-ask → cmux 系统通知集成。
 *
 * 当 pi-permission-system 弹出 ask 对话框时，通过 cmux 发送系统通知。
 *
 * 原理：pi-permission-system 在显示对话框前会通过 pi 的事件总线广播
 * `permissions:ui_prompt`（唯一发射点：LocalUserAuthorizer.authorize），
 * 本模块订阅该通道，将权限请求转发为 cmux 系统通知（`cmux notify`）。
 *
 * 行为：
 *  - 仅在 cmux 环境中生效（CMUX_WORKSPACE_ID + CMUX_SURFACE_ID）
 *  - 转发子代理（subagent）的 ask 在标题中标注 "(Subagent)"，与
 *    权限对话框自身的标题约定一致
 *  - 正文取 ask 文案:优先旧版事件的 message,否则从 v26 的 request.value + matchedPattern 组装（截断到 220 字符）
 *  - 可用环境变量 PI_CMUX_PERMISSION_NOTIFY=0 关闭本功能
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { isCmuxEnvironment, notifyCmux } from './cmux.ts'

/** pi-permission-system 广播通道名（permission-events.ts 公开契约，稳定）。 */
const PERMISSIONS_UI_PROMPT_CHANNEL = 'permissions:ui_prompt'

/** 与 @gotgenes/pi-permission-system 的 PermissionUiPromptEvent 保持兼容的投影。 */
interface PermissionUiPromptEvent {
  requestId: string
  source: 'tool_call' | 'skill_input' | 'skill_read'
  surface: string | null
  value: string | null
  agentName: string | null
  /** ≤ v25：对话框原文（v26.0.0 起已移除，移入 request）。 */
  message?: string
  /** ≥ v26：结构化请求事实（ADR 0011 不变核），message 的替代。 */
  request?: Partial<PromptRequestFacts>
  forwarding: {
    requesterAgentName: string | null
    requesterSessionId: string | null
  } | null
}

/** pi-permission-system v26+ 的 PromptRequestFacts（ADR 0011 §3 不变核，投影）。 */
interface PromptRequestFacts {
  surface: string
  value: string
  matchedPattern: string | null
  executedUnit: string | null
  requester: {
    agentName: string | null
    forwarded: boolean
    sessionId: string | null
  }
}

function truncate(text: string, limit = 220): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit - 3)}...`
}

/**
 * 从 ui_prompt 事件中提取通知正文。
 *
 * pi-permission-system v26.0.0 起移除了顶层 `message`(breaking change),
 * 改为结构化 `request: PromptRequestFacts`。这里优先读旧结构的 `message`,
 * 否则从 `request` 的 value + matchedPattern 组装,向后兼容两种载荷。
 */
function resolveBody(event: Partial<PermissionUiPromptEvent>): string | null {
  if (typeof event.message === 'string' && event.message.trim()) {
    return event.message
  }
  const request = event.request
  if (request && typeof request.value === 'string' && request.value.trim()) {
    const parts = [request.value.trim()]
    if (typeof request.matchedPattern === 'string' && request.matchedPattern.trim()) {
      parts.push(`(rule: ${request.matchedPattern.trim()})`)
    }
    return parts.join(' ')
  }
  if (typeof event.value === 'string' && event.value.trim()) {
    return event.value
  }
  return null
}

export default function registerPermissionNotify(pi: ExtensionAPI): void {
  if (!isCmuxEnvironment()) return
  if (process.env.PI_CMUX_PERMISSION_NOTIFY === '0') return

  pi.events.on(PERMISSIONS_UI_PROMPT_CHANNEL, (data: unknown) => {
    const event = data as Partial<PermissionUiPromptEvent> | null
    if (!event) return
    const body = resolveBody(event)
    if (!body) return

    const isSubagent = Boolean(event.forwarding) || Boolean(event.request?.requester?.forwarded)
    const title = isSubagent ? 'Permission Required (Subagent)' : 'Permission Required'
    const subtitle = event.surface ? `Surface: ${event.surface}` : undefined
    const agentPrefix = event.agentName ? `[${event.agentName}] ` : ''

    void notifyCmux(pi, {
      title,
      subtitle,
      body: `${agentPrefix}${truncate(body)}`,
    })
  })
}
