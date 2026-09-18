/**
 * ag-pi-channel 事件契约 —— 扩展之间（以及跨仓库之间）唯一的通信接口。
 *
 * 设计要点：
 *  - 本插件独占 provider 凭据与连接生命周期，消费方不依赖任何代码，只发/收事件。
 *  - pi 的 EventBus 是单向的（`emit(channel, data): void` + `on(channel, handler)`），
 *    因此请求/响应用「requestId 关联 + result 事件」实现（见 `sendViaBus`）。
 *  - 卡片/键盘等载荷一律是 provider 原生结构，插件不理解其业务语义；
 *    按钮的业务语义留在消费方（例如 ask-user-question 的 `{q,o,c}`）。
 *
 * 通道一览：
 *  - `ag-pi-channel:send`         消费方 → 插件：发文本 / 发卡片 / 更新既有消息
 *  - `ag-pi-channel:send:result`  插件 → 消费方：发送结果（ok / messageId / error）
 *  - `ag-pi-channel:inbound`      插件 → 消费方：收到消息或按钮点击
 *  - `ag-pi-channel:status`       消费方 → 插件：查询连接状态
 *  - `ag-pi-channel:status:result` 插件 → 消费方：状态结果
 *  - `ag-pi-channel:connect`       消费方 → 插件：请确保该 provider 入站就绪（发卡前消除冷启动丢击窗口）
 *  - `ag-pi-channel:connect:result` 插件 → 消费方：入站就绪结果
 *  - `ag-pi-channel:release`       消费方 → 插件：用完了，清掉入站持有（无人持有即断开）
 *  - `ag-pi-channel:release:result` 插件 → 消费方：释放结果
 */

export const CHANNEL_SEND = "ag-pi-channel:send";
export const CHANNEL_SEND_RESULT = "ag-pi-channel:send:result";
export const CHANNEL_INBOUND = "ag-pi-channel:inbound";
export const CHANNEL_STATUS = "ag-pi-channel:status";
export const CHANNEL_STATUS_RESULT = "ag-pi-channel:status:result";
/**
 * 入站就绪请求：插件是惰性连接的（首次发送成功后才 kick 入站），因此「卡片已到飞书、长连接还没握完手」
 * 的窗口里，用户的点击平台无处投递 → 丢掉 + 客户端 3s 超时重试。消费方在发卡前用这个请求把窗口消掉。
 */
export const CHANNEL_CONNECT = "ag-pi-channel:connect";
export const CHANNEL_CONNECT_RESULT = "ag-pi-channel:connect:result";
/**
 * 入站释放请求：`connect` 的反向操作 —— 清掉一次持有，计数归零就断开入站连接。
 * 为什么必须成对：飞书对同一 app 的多条长连接是选一条投递，插件又是全局扩展（每个 pi 进程都加载）。
 * 只 connect 不 release 的进程会长期占着连接，把点击回调从「正在等回复」的进程那里抢走。
 */
export const CHANNEL_RELEASE = "ag-pi-channel:release";
export const CHANNEL_RELEASE_RESULT = "ag-pi-channel:release:result";

export type ChannelProvider = "feishu" | "telegram";

/** 飞书 `receive_id_type`；telegram 只用 `id`（chat id），`type` 忽略。 */
export type FeishuReceiverType = "open_id" | "user_id" | "union_id" | "email" | "chat_id";

export type ChannelTarget = {
	/** provider 的收件人 id：feishu = receive_id；telegram = chat id */
	id: string;
	/** feishu 的 receive_id_type，缺省 `chat_id` */
	type?: FeishuReceiverType;
};

/**
 * 出站请求：**按 provider 判别的联合类型**。
 *
 * 两家的"卡片"不是同一层概念，字段因此分开、不共用一个槽位：
 *  - 飞书：`feishuCard` 就是整条消息（交互卡片自带 header/body，`msg_type: interactive`）
 *  - Telegram：`telegramKeyboard` 只是 reply_markup（键盘），正文必须另给 `text`
 * 这样编译期就能挡住"把飞书卡片发给 telegram"这类错配。
 */
export type ParseMode = "HTML" | "MarkdownV2";

/** 出站请求的公共字段（provider/kind 之外的都在这） */
export type ChannelSendCommon = {
	requestId: string;
	/** 缺省用该 provider 配置里的默认收件人（feishu.defaultReceiver / telegram.defaultChatId） */
	to?: ChannelTarget;
};

/** 飞书：文本消息，或整卡发送 / 整卡替换（patch） */
export type FeishuSendRequest = ChannelSendCommon &
	(
		| { provider: "feishu"; kind: "text"; text: string }
		| {
				provider: "feishu";
				kind: "card";
				/** 飞书交互卡片 JSON（schema 2.0 等），插件原样投递 */
				feishuCard: object;
				/** 传了则整卡替换既有消息（im.v1.message.patch） */
				update?: { messageId: string };
		  }
	);

/**
 * Telegram：键盘只是附件，因此 `kind: "card"` 必须同时给 `text`；
 * `kind: "keyboard"` 仅用于"只替换键盘"的更新（编辑已发消息的按钮）。
 */
export type TelegramSendRequest = ChannelSendCommon &
	(
		| { provider: "telegram"; kind: "text"; text: string; parseMode?: ParseMode; update?: { messageId: string } }
		| {
				provider: "telegram";
				kind: "card";
				text: string;
				/** reply_markup 对象（inline_keyboard 等），插件原样投递 */
				telegramKeyboard: object;
				parseMode?: ParseMode;
				update?: { messageId: string };
		  }
		| { provider: "telegram"; kind: "keyboard"; telegramKeyboard: object; update: { messageId: string } }
	);

export type ChannelSendRequest = FeishuSendRequest | TelegramSendRequest;

/** 分配式 Omit：联合类型逐个成员处理（`Omit<Union, K>` 只会塌成公共键） */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 消费方调用时无需自己生成 requestId */
export type ChannelSendInput = DistributiveOmit<ChannelSendRequest, "requestId"> & { requestId?: string };

export type ChannelSendResult = {
	requestId: string;
	ok: boolean;
	messageId?: string;
	error?: { code: string; message: string };
};

export type ChannelInboundMessage = {
	provider: ChannelProvider;
	kind: "message";
	chatId: string;
	/** feishu 区分 p2p/group；telegram 由 plugin 依 chat id 推断（负数 = 群/频道） */
	chatType?: "p2p" | "group";
	senderId: string;
	messageId: string;
	/** 文本正文；非文本消息为空串 */
	text: string;
	/** `text` 之外的取值（sticker / image / file …）表示这条不是文本消息 */
	contentType: string;
	timestamp?: number;
};

export type ChannelInboundAction = {
	provider: ChannelProvider;
	kind: "action";
	chatId: string;
	chatType?: "p2p" | "group";
	senderId: string;
	messageId: string;
	/** 按钮 value（消费方自定义结构）。若其中带字符串字段 `ackText`，插件用它回 toast/ack。 */
	value: unknown;
	timestamp?: number;
};

export type ChannelInboundEvent = ChannelInboundMessage | ChannelInboundAction;

export type ChannelStatusRequest = {
	requestId: string;
};

export type ChannelProviderStatus = {
	provider: ChannelProvider;
	/** 配置里存在且必填项齐备 */
	configured: boolean;
	/** 长连接/长轮询是否已建立（出站模式未连接时为 false） */
	connected: boolean;
	/** 脱敏后的应用标识（feishu appId / telegram bot id），便于确认用的是哪套凭据 */
	accountMasked?: string;
	error?: string;
};

export type ChannelStatusResult = {
	requestId: string;
	configPath: string;
	providers: ChannelProviderStatus[];
};

export type ChannelConnectRequest = {
	requestId: string;
	provider: ChannelProvider;
};

export type ChannelConnectResult = {
	requestId: string;
	ok: boolean;
	/** 入站通道是否已经就绪（`ok:false` 时为 false） */
	connected: boolean;
	error?: { code: string; message: string };
};

export type ChannelReleaseRequest = {
	requestId: string;
	provider: ChannelProvider;
};

export type ChannelReleaseResult = {
	requestId: string;
	ok: boolean;
	/** 释放之后该 provider 的实际连接状态：还有别的持有者（或未配置）时为 false */
	connected: boolean;
	error?: { code: string; message: string };
};

/** 消费方需要的最小事件总线形状（与 pi 的 EventBus 结构一致）。 */
export type EventsLike = {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
};

/** 从按钮 value 里取可选 ack 文案（`{ ..., ackText: "已选择" }`）。 */
export function readAckText(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = (value as { ackText?: unknown }).ackText;
	return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/**
 * 请求/响应助手：emit `ag-pi-channel:send` 并等 `ag-pi-channel:send:result`。
 *
 * 消费方（pi-remote-notify、rpiv-ask-user-question）都应通过它调用，
 * 以免各自手写关联逻辑；超时或插件未加载时返回 `ok: false`（绝不抛异常）。
 */
export async function sendViaBus(
	events: EventsLike,
	request: ChannelSendInput,
	timeoutMs = 10_000,
): Promise<ChannelSendResult> {
	const requestId = request.requestId ?? globalThis.crypto.randomUUID();
	const payload = { ...request, requestId } as ChannelSendRequest;

	return await new Promise<ChannelSendResult>((resolve) => {
		let settled = false;
		const finish = (result: ChannelSendResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			resolve(result);
		};

		const timer = setTimeout(
			() => finish({ requestId, ok: false, error: { code: "timeout", message: `no result within ${timeoutMs}ms` } }),
			timeoutMs,
		);
		timer.unref?.();

		const unsubscribe = events.on(CHANNEL_SEND_RESULT, (data) => {
			const result = data as ChannelSendResult | undefined;
			if (!result || result.requestId !== requestId) return;
			finish(result);
		});

		events.emit(CHANNEL_SEND, payload);
	});
}

/** 查询插件状态（连接情况 / 配置路径 / 脱敏账号），超时返回 `null`。 */
export async function statusViaBus(events: EventsLike, timeoutMs = 5_000): Promise<ChannelStatusResult | null> {
	const requestId = globalThis.crypto.randomUUID();
	return await new Promise<ChannelStatusResult | null>((resolve) => {
		let settled = false;
		const finish = (result: ChannelStatusResult | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			resolve(result);
		};
		const timer = setTimeout(() => finish(null), timeoutMs);
		timer.unref?.();
		const unsubscribe = events.on(CHANNEL_STATUS_RESULT, (data) => {
			const result = data as ChannelStatusResult | undefined;
			if (!result || result.requestId !== requestId) return;
			finish(result);
		});
		events.emit(CHANNEL_STATUS, { requestId } satisfies ChannelStatusRequest);
	});
}

/**
 * 请求插件把该 provider 的入站通道建好（幂等），超时返回 `null`。
 * `null` 有两种含义：插件未加载，或插件版本还没有 connect 契约 —— 调用方应照常继续（退化为惰性行为）。
 */
export async function connectViaBus(
	events: EventsLike,
	provider: ChannelProvider,
	timeoutMs = 5_000,
): Promise<ChannelConnectResult | null> {
	const requestId = globalThis.crypto.randomUUID();
	return await new Promise<ChannelConnectResult | null>((resolve) => {
		let settled = false;
		const finish = (result: ChannelConnectResult | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			resolve(result);
		};
		const timer = setTimeout(() => finish(null), timeoutMs);
		timer.unref?.();
		const unsubscribe = events.on(CHANNEL_CONNECT_RESULT, (data) => {
			const result = data as ChannelConnectResult | undefined;
			if (!result || result.requestId !== requestId) return;
			finish(result);
		});
		events.emit(CHANNEL_CONNECT, { requestId, provider } satisfies ChannelConnectRequest);
	});
}

/**
 * `connectViaBus` 的反向操作：告诉插件「这个 provider 的入站我用完了」。
 * 与它有同样的超时语义（超时返回 `null`，绝不抛异常）；调用方通常 fire-and-forget 即可。
 */
export async function releaseViaBus(
	events: EventsLike,
	provider: ChannelProvider,
	timeoutMs = 5_000,
): Promise<ChannelReleaseResult | null> {
	const requestId = globalThis.crypto.randomUUID();
	return await new Promise<ChannelReleaseResult | null>((resolve) => {
		let settled = false;
		const finish = (result: ChannelReleaseResult | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			resolve(result);
		};
		const timer = setTimeout(() => finish(null), timeoutMs);
		timer.unref?.();
		const unsubscribe = events.on(CHANNEL_RELEASE_RESULT, (data) => {
			const result = data as ChannelReleaseResult | undefined;
			if (!result || result.requestId !== requestId) return;
			finish(result);
		});
		events.emit(CHANNEL_RELEASE, { requestId, provider } satisfies ChannelReleaseRequest);
	});
}
