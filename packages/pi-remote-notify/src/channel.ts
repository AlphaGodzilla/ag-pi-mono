/**
 * pi-channel 事件契约的本地副本（薄封装）。
 *
 * pi-remote-notify 与 pi-channel 是两个独立扩展：本包不依赖 pi-channel 的代码，
 * 只通过 pi 的 EventBus 用通道名通信，因此这里复制契约常量、类型与请求/响应
 * helper。**内容必须与 pi-channel/lib/events.ts 保持一致**，改契约时两边同步。
 *
 * 通道：
 *  - `ag-pi-channel:send`           消费方 → 插件：发文本 / 发卡片 / 更新既有消息
 *  - `ag-pi-channel:send:result`    插件 → 消费方：发送结果（ok / messageId / error）
 *  - `ag-pi-channel:status`         消费方 → 插件：查询连接状态
 *  - `ag-pi-channel:status:result`  插件 → 消费方：状态结果
 */
export const CHANNEL_SEND = 'ag-pi-channel:send'
export const CHANNEL_SEND_RESULT = 'ag-pi-channel:send:result'
export const CHANNEL_STATUS = 'ag-pi-channel:status'
export const CHANNEL_STATUS_RESULT = 'ag-pi-channel:status:result'

export type ChannelProvider = 'feishu' | 'telegram'

/** 飞书 `receive_id_type`；telegram 只用 `id`（chat id），`type` 忽略。 */
export type FeishuReceiverType = 'open_id' | 'user_id' | 'union_id' | 'email' | 'chat_id'

export type ChannelTarget = {
  /** provider 的收件人 id：feishu = receive_id；telegram = chat id */
  id: string
  /** feishu 的 receive_id_type，缺省 `chat_id` */
  type?: FeishuReceiverType
}

/**
 * 出站请求：**按 provider 判别的联合类型**。
 *
 * 两家的“卡片”不是同一层概念，字段因此分开、不共用一个槽位：
 *  - 飞书：`feishuCard` 就是整条消息（交互卡片自带 header/body，`msg_type: interactive`）
 *  - Telegram：`telegramKeyboard` 只是 reply_markup（键盘），正文必须另给 `text`
 * 这样编译期就能挡住“把飞书卡片发给 telegram”这类错配。
 */
export type ParseMode = 'HTML' | 'MarkdownV2'

/** 出站请求的公共字段（provider/kind 之外的都在这） */
export type ChannelSendCommon = {
  requestId: string
  /** 缺省用该 provider 配置里的默认收件人（feishu.defaultReceiver / telegram.defaultChatId） */
  to?: ChannelTarget
}

/** 飞书：文本消息，或整卡发送 / 整卡替换（patch） */
export type FeishuSendRequest = ChannelSendCommon &
  (
    | { provider: 'feishu'; kind: 'text'; text: string }
    | {
        provider: 'feishu'
        kind: 'card'
        /** 飞书交互卡片 JSON（schema 2.0 等），插件原样投递 */
        feishuCard: object
        /** 传了则整卡替换既有消息（im.v1.message.patch） */
        update?: { messageId: string }
      }
  )

/**
 * Telegram：键盘只是附件，因此 `kind: "card"` 必须同时给 `text`；
 * `kind: "keyboard"` 仅用于“只替换键盘”的更新（编辑已发消息的按钮）。
 */
export type TelegramSendRequest = ChannelSendCommon &
  (
    | { provider: 'telegram'; kind: 'text'; text: string; parseMode?: ParseMode; update?: { messageId: string } }
    | {
        provider: 'telegram'
        kind: 'card'
        text: string
        /** reply_markup 对象（inline_keyboard 等），插件原样投递 */
        telegramKeyboard: object
        parseMode?: ParseMode
        update?: { messageId: string }
      }
    | { provider: 'telegram'; kind: 'keyboard'; telegramKeyboard: object; update: { messageId: string } }
  )

export type ChannelSendRequest = FeishuSendRequest | TelegramSendRequest

/** 分配式 Omit：联合类型逐个成员处理（`Omit<Union, K>` 只会塌成公共键） */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** 消费方调用时无需自己生成 requestId */
export type ChannelSendInput = DistributiveOmit<ChannelSendRequest, 'requestId'> & { requestId?: string }

export type ChannelSendResult = {
  requestId: string
  ok: boolean
  messageId?: string
  error?: { code: string; message: string }
}

export type ChannelStatusRequest = {
  requestId: string
}

export type ChannelProviderStatus = {
  provider: ChannelProvider
  configured: boolean
  connected: boolean
  accountMasked?: string
  error?: string
}

export type ChannelStatusResult = {
  requestId: string
  configPath: string
  providers: ChannelProviderStatus[]
}

/** 消费方需要的最小事件总线形状（与 pi 的 EventBus 结构一致）。 */
export type EventsLike = {
  emit(channel: string, data: unknown): void
  on(channel: string, handler: (data: unknown) => void): () => void
}

/** 请求/响应助手：emit `ag-pi-channel:send` 并等 `ag-pi-channel:send:result`；超时或插件未加载时返回 ok:false，绝不抛异常。 */
export async function sendViaBus(
  events: EventsLike,
  request: ChannelSendInput,
  timeoutMs = 10_000,
): Promise<ChannelSendResult> {
  const requestId = request.requestId ?? globalThis.crypto.randomUUID()
  const payload = { ...request, requestId } as ChannelSendRequest

  return await new Promise<ChannelSendResult>((resolve) => {
    let settled = false
    const finish = (result: ChannelSendResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      resolve(result)
    }

    const timer = setTimeout(
      () => finish({ requestId, ok: false, error: { code: 'timeout', message: `no result within ${timeoutMs}ms` } }),
      timeoutMs,
    )
    timer.unref?.()

    const unsubscribe = events.on(CHANNEL_SEND_RESULT, (data) => {
      const result = data as ChannelSendResult | undefined
      if (!result || result.requestId !== requestId) return
      finish(result)
    })

    events.emit(CHANNEL_SEND, payload)
  })
}

/** 查询插件状态（连接情况 / 配置路径 / 脱敏账号），超时返回 null。 */
export async function statusViaBus(events: EventsLike, timeoutMs = 5_000): Promise<ChannelStatusResult | null> {
  const requestId = globalThis.crypto.randomUUID()
  return await new Promise<ChannelStatusResult | null>((resolve) => {
    let settled = false
    const finish = (result: ChannelStatusResult | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      resolve(result)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    timer.unref?.()
    const unsubscribe = events.on(CHANNEL_STATUS_RESULT, (data) => {
      const result = data as ChannelStatusResult | undefined
      if (!result || result.requestId !== requestId) return
      finish(result)
    })
    events.emit(CHANNEL_STATUS, { requestId } satisfies ChannelStatusRequest)
  })
}
