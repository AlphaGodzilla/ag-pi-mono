/**
 * 权限 ask 弹窗 → 飞书通知。
 *
 * pi-permission-system 在显示权限对话框前通过事件总线广播 `permissions:ui_prompt`
 * （唯一发射点 LocalUserAuthorizer.authorize），本模块订阅该通道，把权限请求
 * 转发为飞书提醒——pi 在后台/远程时也能及时知道"需要你授权"。
 *
 * payload 结构参考 pi-cmux 的 permissionNotify.ts（不修改/依赖它）。
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { FeishuConfig } from './config.ts'
import { safeNotify } from './feishu.ts'

const PERMISSIONS_UI_PROMPT_CHANNEL = 'permissions:ui_prompt'

interface PermissionUiPromptEvent {
  requestId: string
  source: 'tool_call' | 'skill_input' | 'skill_read'
  surface: string | null
  value: string | null
  agentName: string | null
  message: string
  forwarding: {
    requesterAgentName: string | null
    requesterSessionId: string | null
  } | null
}

function truncate(text: string, limit = 500): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit - 3)}...`
}

export type PermissionNotifyDeps = {
  getEnabled: () => boolean
  cfg: FeishuConfig | null
}

export default function registerPermissionNotify(pi: ExtensionAPI, deps: PermissionNotifyDeps): void {
  const { getEnabled, cfg } = deps
  if (!cfg) return

  pi.events.on(PERMISSIONS_UI_PROMPT_CHANNEL, (data: unknown) => {
    if (!getEnabled()) return
    const event = data as Partial<PermissionUiPromptEvent> | null
    if (!event || typeof event.message !== 'string' || !event.message.trim()) return

    const isSubagent = Boolean(event.forwarding)
    const agentPrefix = event.agentName ? `[${event.agentName}] ` : ''
    const text = [
      `🔐 需要你的授权${isSubagent ? '（子代理）' : ''}`,
      `${agentPrefix}${truncate(event.message)}`,
    ].join('\n')
    safeNotify(cfg, text, 'permission_prompt')
  })
}