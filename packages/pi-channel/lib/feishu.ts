/**
 * 飞书 provider：出站（文本 / 卡片 / 更新卡片）+ 入站（长连接：消息与卡片回调）。
 *
 * 传输层自 `rpiv-ask-user-question/remote/feishu-channel.ts` 移植；问题卡片、收件人策略、
 * 取消词等业务语义留在消费方。两处 SDK 行为必须保留：
 *  1. `card.action.trigger` 要求 3s 内回响应，而 SDK 的 Channel 会丢弃我们监听器的返回值
 *     （`pushAction` 不传播 handler 结果），只能在 WS dispatcher 层注入通用响应；
 *     ack 文案取自按钮 `value.ackText`（缺省「已收到」）。
 *  2. 该 ack 是排队帧，监听器解析后立刻 disconnect 会丢帧 → close 前给 socket 400ms 冲刷。
 *
 * 出站刻意走裸 `Client`（`im.v1.message.create` / `patch`，与 SDK 的 `Channel.send` /
 * `updateCard` 同一底层调用），这样无需长连接也能发消息、更新卡片，并拿到 `message_id`。
 */
import { Client, createLarkChannel, Domain, type Logger, type LarkChannel } from "@larksuiteoapi/node-sdk";
import { maskAccount, type FeishuChannelConfig } from "./config.ts";
import { readAckText, type ChannelInboundEvent, type FeishuSendRequest } from "./events.ts";
import { logDebug, logError } from "./log.ts";

/**
 * SDK 默认把自己 `[info]` 级别的日志打到 stdout —— 包括长连接使用说明的整段横幅与
 * `[ws] ws client ready`。在 pi TUI 里这些会直接渲染进输入区（实测截图确认），因此**一律改道**：
 * 全部走 `logDebug`（默认关闭；只有配置 `debug: true` 时才写 debug.log）—— TUI 永远零输出，
 * 而排障时（SDK safety 的去重/排队/丢弃、长连接时序）有证据可查。
 */
const sdkLogger: Logger = {
	error: (...msg) => logDebug(`[sdk:error] ${formatLogArgs(msg)}`),
	warn: (...msg) => logDebug(`[sdk:warn] ${formatLogArgs(msg)}`),
	info: (...msg) => logDebug(`[sdk:info] ${formatLogArgs(msg)}`),
	debug: (...msg) => logDebug(`[sdk:debug] ${formatLogArgs(msg)}`),
	trace() {},
};

/** 诊断日志参数序列化：Error 取 message，对象尽力 JSON，其余 String。 */
function formatLogArgs(args: unknown[]): string {
	return args
		.map((a) => {
			if (a instanceof Error) return a.message;
			if (typeof a === "string") return a;
			try {
				return JSON.stringify(a);
			} catch {
				return String(a);
			}
		})
		.join(" ");
}

/** 出站所需的最小 client 形状（测试注入假实现，避免真 SDK 请求）。 */
export type FeishuClientLike = {
	im: {
		v1: {
			message: {
				create: (args: {
					params: { receive_id_type: string };
					data: { receive_id: string; msg_type: string; content: string };
				}) => Promise<{ data?: { message_id?: string } }>;
				patch: (args: { path: { message_id: string }; data: { content: string } }) => Promise<unknown>;
			};
		};
	};
};

/** 入站所需的最小 Channel 形状（`rawWsClient` 用于注入卡片回调响应）。 */
export type FeishuChannelLike = {
	connect: () => Promise<void>;
	disconnect: () => Promise<void>;
	on: (event: "message" | "cardAction", handler: (payload: unknown) => void) => () => void;
	rawWsClient?: unknown;
};

export type FeishuProviderDeps = {
	createClient?: (opts: { appId: string; appSecret: string; domain: Domain }) => FeishuClientLike;
	createChannel?: (opts: {
		appId: string;
		appSecret: string;
		domain: Domain;
		policy: { requireMention: boolean; dmMode: FeishuChannelConfig["dmMode"] };
	}) => FeishuChannelLike;
	log?: (msg: string) => void;
};

export class FeishuChannelError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

/** 归一化任意错误为 `{ code, message }`（与 telegram provider 对称）。 */
export function classifyFeishuError(err: unknown): { code: string; message: string } {
	if (err instanceof Error && "code" in err && typeof (err as { code: unknown }).code === "string") {
		return { code: (err as { code: string }).code, message: err.message };
	}
	return { code: "unknown", message: err instanceof Error ? err.message : String(err) };
}

export type FeishuProvider = {
	send(req: FeishuSendRequest, cfg: FeishuChannelConfig): Promise<{ messageId: string }>;
	connect(cfg: FeishuChannelConfig, onInbound: (evt: ChannelInboundEvent) => void): Promise<void>;
	close(): Promise<void>;
	status(): { connected: boolean; accountMasked?: string };
	classifyError(err: unknown): { code: string; message: string };
};

function resolveDomain(domain: "feishu" | "lark"): Domain {
	return domain === "lark" ? Domain.Lark : Domain.Feishu;
}

/** 飞书长连接消息事件（SDK Channel 归一化后的形状，仅取用到的字段）。 */
type RawMessage = {
	content?: unknown;
	chatId?: unknown;
	chatType?: unknown;
	senderId?: unknown;
	messageId?: unknown;
	rawContentType?: unknown;
	createTime?: unknown;
};

/** 飞书长连接卡片回调事件（仅取用到的字段）。 */
type RawCardAction = {
	chatId?: unknown;
	messageId?: unknown;
	action?: { value?: unknown };
	operator?: { openId?: unknown };
};

function asString(v: unknown): string {
	return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function asChatType(v: unknown): "p2p" | "group" | undefined {
	return v === "p2p" || v === "group" ? v : undefined;
}

/**
 * 在 WS dispatcher 层注入卡片回调响应（见文件头坑 1）。
 * ack 文案取按钮 value.ackText，缺省「已收到」；非卡片事件原样透传。
 *
 * ack 必须**立刻**回，不能等分发链跑完：`origInvoke` 里还要过 SDK 的 safety 流水线
 * （按 chatId 串行排队 + 去重锁）与消费方处理，任何一段慢都会烧穿飞书 3s 窗口 ——
 * 客户端超时后会回滚卡片更新，用户看到的就是「点了没反应、要连点几次」。
 * 分发因此改为后台跑（与 ack 解耦）；分发失败自己吞掉并写 error.log —— 未处理的拒绝会让 pi 直接退出。
 */
function installCardCallbackResponder(channel: FeishuChannelLike, log: (msg: string) => void): void {
	const ws = channel.rawWsClient as
		| { eventDispatcher?: { invoke?: (...args: unknown[]) => Promise<unknown> } }
		| undefined;
	const dispatcher = ws?.eventDispatcher;
	if (!dispatcher || typeof dispatcher.invoke !== "function") {
		log("card callback responder not installed: rawWsClient.eventDispatcher.invoke unavailable");
		return;
	}
	const origInvoke = dispatcher.invoke.bind(dispatcher);
	dispatcher.invoke = async (data: unknown, opts?: unknown) => {
		const header = (data as { header?: { event_type?: string } } | null)?.header;
		if (header?.event_type !== "card.action.trigger") return origInvoke(data, opts);
		const startedAt = Date.now();
		const value = (data as { event?: { action?: { value?: unknown } } } | null)?.event?.action?.value;
		const ackText = readAckText(value) ?? "已收到";
		logDebug(`[card] callback received (ack=${ackText})`);
		// 分发丢到后台：失败必须自己吞掉（未处理的拒绝会让 pi 直接退出），只写 error.log。
		void Promise.resolve()
			.then(() => origInvoke(data, opts))
			.then(
				() => logDebug(`[card] dispatch finished in ${Date.now() - startedAt}ms`),
				(err) => {
					logDebug(
						`[card] dispatch failed after ${Date.now() - startedAt}ms: ${err instanceof Error ? err.message : String(err)}`
					);
					log(`card action dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
				},
			);
		logDebug(`[card] ack returned in ${Date.now() - startedAt}ms`);
		return { toast: { type: "success", content: ackText } };
	};
	logDebug("[card] callback responder installed");
}

export function createFeishuProvider(deps: FeishuProviderDeps = {}): FeishuProvider {
	const log = deps.log ?? logError;
	const makeClient = deps.createClient ?? ((opts) => new Client({ ...opts, logger: sdkLogger }) as unknown as FeishuClientLike);
	const makeChannel =
		deps.createChannel ??
		((opts) =>
			createLarkChannel({
				appId: opts.appId,
				appSecret: opts.appSecret,
				domain: opts.domain,
				policy: opts.policy,
				logger: sdkLogger,
			}) as unknown as FeishuChannelLike);

	/** 出站 client 按 appId 缓存：同一进程内不同应用各自一份 */
	const clients = new Map<string, FeishuClientLike>();
	let channel: FeishuChannelLike | undefined;
	let channelKey: string | undefined;
	let unsubscribes: Array<() => void> = [];
	let handler: ((evt: ChannelInboundEvent) => void) | undefined;
	let connected = false;
	let accountMasked: string | undefined;

	function clientFor(cfg: FeishuChannelConfig): FeishuClientLike {
		const key = cfg.appId;
		let client = clients.get(key);
		if (!client) {
			client = makeClient({ appId: cfg.appId, appSecret: cfg.appSecret, domain: resolveDomain(cfg.domain) });
			clients.set(key, client);
		}
		accountMasked = maskAccount(cfg.appId);
		return client;
	}

	function assertConfigured(cfg: FeishuChannelConfig): void {
		if (!cfg.appId || !cfg.appSecret) {
			throw new FeishuChannelError("not_configured", "feishu appId/appSecret missing from config");
		}
	}

	function subscribe(next: (evt: ChannelInboundEvent) => void): void {
		if (!channel) return;
		for (const off of unsubscribes) off();
		unsubscribes = [
			channel.on("message", (payload) => {
				if (!handler) return;
				handler(mapMessage(payload as RawMessage));
			}),
			channel.on("cardAction", (payload) => {
				if (!handler) return;
				handler(mapCardAction(payload as RawCardAction));
			}),
		];
		handler = next;
	}

	async function send(req: FeishuSendRequest, cfg: FeishuChannelConfig): Promise<{ messageId: string }> {
		assertConfigured(cfg);
		// 类型上已排除（kind=card 必带 feishuCard）；这里是 JS 调用方（跨扩展事件）的兜底
		if (req.kind === "card" && req.feishuCard === undefined) {
			throw new FeishuChannelError("invalid_request", "feishu card request needs feishuCard");
		}
		const client = clientFor(cfg);

		// 飞书只有交互卡片能更新（im.v1.message.patch 作用于卡片 content）
		if (req.kind === "card" && req.update) {
			await client.im.v1.message.patch({
				path: { message_id: req.update.messageId },
				data: { content: JSON.stringify(req.feishuCard) },
			});
			return { messageId: req.update.messageId };
		}

		const target = req.to?.id ?? cfg.defaultReceiver?.value;
		const targetType = req.to?.type ?? cfg.defaultReceiver?.type ?? "chat_id";
		if (!target) {
			throw new FeishuChannelError("no_target", "feishu send needs to.id or cfg.defaultReceiver");
		}

		let msgType: string;
		let content: unknown;
		if (req.kind === "card") {
			// 卡片自带正文：feishuCard 就是整条消息的 content
			msgType = "interactive";
			content = req.feishuCard;
		} else {
			msgType = "text";
			content = { text: req.text };
		}

		const response = await client.im.v1.message.create({
			params: { receive_id_type: targetType },
			data: { receive_id: target, msg_type: msgType, content: JSON.stringify(content) },
		});
		const messageId = response?.data?.message_id;
		if (!messageId) {
			throw new FeishuChannelError("feishu_send", "message_id missing from create response");
		}
		return { messageId };
	}

	async function connect(cfg: FeishuChannelConfig, onInbound: (evt: ChannelInboundEvent) => void): Promise<void> {
		assertConfigured(cfg);
		handler = onInbound;
		clientFor(cfg);
		// 出站模式：不建立长连接（仍可 send）
		if (cfg.inbound === false) return;

		const key = `${cfg.appId}:${cfg.requireMention}:${cfg.dmMode}`;
		if (!channel || channelKey !== key) {
			await close();
			channel = makeChannel({
				appId: cfg.appId,
				appSecret: cfg.appSecret,
				domain: resolveDomain(cfg.domain),
				policy: { requireMention: cfg.requireMention, dmMode: cfg.dmMode },
			});
			channelKey = key;
			subscribe(onInbound);
			const connectStartedAt = Date.now();
			logDebug(`[ws] connecting feishu (${maskAccount(cfg.appId)})`);
			await channel.connect();
			logDebug(`[ws] ready in ${Date.now() - connectStartedAt}ms`);
			// ack 注入必须放在 connect() **之后**：SDK 在 connect 时才创建 WS dispatcher，
			// 之前装拿不到 eventDispatcher.invoke，会打出 "card callback responder not installed"，
			// 卡片点击的 3s ack（toast）随之失效（ask-user-question 的老实现也是先 connect 再装）。
			installCardCallbackResponder(channel, log);
			connected = true;
			return;
		}
		subscribe(onInbound);
	}

	async function close(): Promise<void> {
		if (!channel) return;
		const current = channel;
		channel = undefined;
		channelKey = undefined;
		connected = false;
		for (const off of unsubscribes) off();
		unsubscribes = [];
		// 让排队的卡片回调 ack 先发出去（见文件头坑 2）
		await new Promise((resolve) => setTimeout(resolve, 400));
		try {
			await current.disconnect();
		} catch (err) {
			log(`feishu disconnect failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return {
		send,
		connect,
		close,
		status: () => ({ connected, accountMasked }),
		classifyError: classifyFeishuError,
	};
}

function mapMessage(msg: RawMessage): ChannelInboundEvent {
	const contentType = asString(msg.rawContentType) || "unknown";
	return {
		provider: "feishu",
		kind: "message",
		chatId: asString(msg.chatId),
		chatType: asChatType(msg.chatType),
		senderId: asString(msg.senderId),
		messageId: asString(msg.messageId),
		text: contentType === "text" ? asString(msg.content) : "",
		contentType,
		timestamp: typeof msg.createTime === "number" ? msg.createTime : undefined,
	};
}

function mapCardAction(evt: RawCardAction): ChannelInboundEvent {
	// card.action.trigger 不带 chatType，消费方需自行按策略过滤
	return {
		provider: "feishu",
		kind: "action",
		chatId: asString(evt.chatId),
		senderId: asString(evt.operator?.openId),
		messageId: asString(evt.messageId),
		value: evt.action?.value,
	};
}

/** 供 index.ts 复用的类型导出（避免 index 重复声明 SDK 形状）。 */
export type { LarkChannel };
