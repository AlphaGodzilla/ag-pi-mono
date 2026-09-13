/**
 * 飞书文本消息发送（纯 REST，不建立长连接）。
 *
 * 调用方式参考 rpiv-ask-user-question 的 remote/feishu-channel.ts：
 * 使用官方 SDK 的语义方法 `im.v1.message.create` + 原生 `receive_id_type`，
 * 凭证走 config.json（appId/appSecret），不做任何本地缓存之外的额外状态。
 *
 * 与 ask-question 的区别：remote-notify 只需要"发送"能力，因此直接用
 * `new Client(...)` 走 REST API，不创建/连接 websocket 长连接，避免与
 * 现有 feishu gateway 的长连接资源相互影响。
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { Client, type Logger } from '@larksuiteoapi/node-sdk'
import type { FeishuConfig } from './config.ts'

/** 静音 logger：SDK 默认会向 stdout 打印 '[info]: [client ready]'，
 *  在 pi TUI / cmux 环境下会污染界面、干扰 busy/idle 状态判断，故全部置空。 */
const silentLogger: Logger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
}

function truncate(text: string, limit: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit - 3)}...`
}

/**
 * 发送一条飞书文本消息到配置的收件人（chat_id 或 open_id）。
 * 发送失败时抛出异常（含飞书错误码/信息），由调用方捕获记录，不中断主流程。
 */
export async function sendFeishuText(cfg: FeishuConfig, text: string): Promise<void> {
  const client = new Client({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    domain: cfg.domain,
    logger: silentLogger,
  })
  await client.im.v1.message.create({
    params: { receive_id_type: cfg.receiveIdType },
    data: {
      receive_id: cfg.receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text: truncate(text, 2000) }),
    },
  })
}

/** 统一兜底：记录发送错误，绝不抛出未捕获异常，也绝不向 stdout/stderr 输出（避免污染 TUI/cmux 界面）。 */
export function safeNotify(cfg: FeishuConfig | null, text: string, tag: string): void {
  if (!cfg) return
  void sendFeishuText(cfg, text).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    logError(`[${tag}] send failed: ${message}`)
  })
}

/** 写入 ~/.pi/agent/feishu/remote-notify-error.log（绝不写 console，避免污染 TUI/cmux）。 */
export function logError(line: string): void {
  try {
    const file = join(getAgentDir(), 'feishu', 'remote-notify-error.log')
    appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch {
    // 日志写入失败也静默，绝不影响主流程
  }
}