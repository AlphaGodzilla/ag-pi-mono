/**
 * rpiv-ask-user-question 弹窗 → cmux 系统通知集成。
 *
 * 当 @juicesharp/rpiv-ask-user-question 的 ask_user_question 工具弹出
 * 问卷等待用户输入时，通过 cmux 发送系统通知——pi 挂在后台时提醒用户
 * 回来作答。
 *
 * 原理：rpiv 插件在显示问卷前通过 pi 事件总线广播 `rpiv:ask-user:prompt`
 * （events.ts 公开契约，稳定，channel 名不可变），本模块订阅该通道，
 * 将问卷请求转发为 cmux 系统通知（`cmux notify`）。
 *
 * 与 permissionNotify.ts 的区别：后者订阅 `permissions:ui_prompt`
 * （pi-permission-system 的权限 ask 对话框），两者是不同通道、不同弹窗，
 * 互不覆盖。
 *
 * 行为：
 *  - 仅在 cmux 环境中生效（isCmuxEnvironment 探测 socket + CLI）
 *  - 通知标题标注问题数量，正文为第一个问题的原文（截断到 220 字符）
 *  - 可用环境变量 PI_CMUX_ASK_NOTIFY=0 关闭本功能
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { isCmuxEnvironment, notifyCmux } from './cmux.ts'

/** @juicesharp/rpiv-ask-user-question 公开事件通道（events.ts 稳定契约）。 */
const RPIV_ASK_USER_PROMPT_CHANNEL = 'rpiv:ask-user:prompt'

/** 与 rpiv events.ts 的 AskUserPromptEventPayload 保持兼容的投影。 */
interface AskUserPromptEventPayload {
  questions?: ReadonlyArray<{
    question?: unknown
    header?: unknown
    multiSelect?: unknown
    options?: unknown
  }> | null
}

function truncate(text: string, limit = 220): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit - 3)}...`
}

export default function registerAskUserNotify(pi: ExtensionAPI): void {
  if (!isCmuxEnvironment()) return
  if (process.env.PI_CMUX_ASK_NOTIFY === '0') return

  pi.events.on(RPIV_ASK_USER_PROMPT_CHANNEL, (data: unknown) => {
    const event = data as AskUserPromptEventPayload | null
    const questions = event?.questions
    if (!Array.isArray(questions) || questions.length === 0) return

    const first = questions.find((q) => typeof q?.question === 'string' && q.question.trim())
    if (!first) return

    const count = questions.length
    const body = truncate(first.question as string)

    void notifyCmux(pi, {
      title: count > 1 ? `Pi needs your input (${count} questions)` : 'Pi needs your input',
      subtitle: 'Questionnaire waiting',
      body,
    })
  })
}
