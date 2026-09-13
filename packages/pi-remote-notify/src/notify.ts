/**
 * 经 pi-channel 事件契约发送飞书文本通知。
 *
 * 本扩展不再持有飞书凭证、不直接调 SDK：发送统一 emit `ag-pi-channel:send`，
 * 由 pi-channel 插件负责凭据、默认收件人与实际投递。
 *
 * 关键约束：
 *  - 异步 fire-and-forget，绝不阻塞或抛异常进 pi 主流程；
 *  - pi-channel 未加载 / 未配置 / 发送失败（含超时）时只写本扩展 error.log；
 *  - 绝不写 console，避免污染 TUI / 干扰 pi-cmux 的 busy/idle 状态判断。
 */
import { sendViaBus, type EventsLike } from './channel.ts'
import { logError } from './log.ts'

/** 等待 pi-channel 应答的最长时间；插件缺席时等超时后降级为日志。 */
export const SEND_TIMEOUT_MS = 10_000

/** 发送一条文本通知；任何失败都只记日志，绝不抛出、绝不写 console。 */
export function safeNotify(events: EventsLike, text: string, tag: string): void {
  void sendViaBus(events, { provider: 'feishu', kind: 'text', text }, SEND_TIMEOUT_MS)
    .then((result) => {
      if (!result.ok) {
        const code = result.error?.code ?? 'unknown'
        const message = result.error?.message ?? '(no message)'
        logError(`[${tag}] send failed: ${code}: ${message}`)
      }
    })
    .catch((err: unknown) => {
      logError(`[${tag}] send failed: ${err instanceof Error ? err.message : String(err)}`)
    })
}
