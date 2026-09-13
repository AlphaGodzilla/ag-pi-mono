/**
 * ask_user_question 问卷弹窗 → 飞书通知。
 *
 * @juicesharp/rpiv-ask-user-question 在弹出问卷等待输入前通过事件总线广播
 * `rpiv:ask-user:prompt`（events.ts 稳定契约），本模块订阅该通道，把问卷请求
 * 转发为飞书提醒。与 permissionNotify 是不同通道、不同弹窗，互不覆盖。
 *
 * 发送经 pi-channel 的 `ag-pi-channel:send` 事件（凭据/投递由 pi-channel 负责）。
 *
 * payload 结构参考 pi-cmux 的 askUserNotify.ts（不修改/依赖它）。
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { safeNotify } from './notify.ts'

const RPIV_ASK_USER_PROMPT_CHANNEL = 'rpiv:ask-user:prompt'

interface AskUserPromptEventPayload {
  questions?: ReadonlyArray<{
    question?: unknown
    header?: unknown
    multiSelect?: unknown
    options?: unknown
  }> | null
}

function truncate(text: string, limit = 500): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit - 3)}...`
}

export type AskUserNotifyDeps = {
  getEnabled: () => boolean
}

export default function registerAskUserNotify(pi: ExtensionAPI, deps: AskUserNotifyDeps): void {
  const { getEnabled } = deps

  pi.events.on(RPIV_ASK_USER_PROMPT_CHANNEL, (data: unknown) => {
    if (!getEnabled()) return
    const event = data as AskUserPromptEventPayload | null
    const questions = event?.questions
    if (!Array.isArray(questions) || questions.length === 0) return

    const first = questions.find((q) => typeof q?.question === 'string' && q.question.trim())
    if (!first) return

    const count = questions.length
    const text = [
      count > 1 ? `❓ 需要你回答（${count} 个问题）` : '❓ 需要你回答',
      truncate(first.question as string),
    ].join('\n')
    safeNotify(pi.events, text, 'ask_user_prompt')
  })
}