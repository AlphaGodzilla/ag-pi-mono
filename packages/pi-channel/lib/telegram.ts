/**
 * pi-channel Telegram 传输层。
 *
 * 由 rpiv-ask-user-question 的 remote/tg-http.ts + remote/tg-channel.ts 移植而来，
 * 只保留「怎么跟 Telegram 说话」：HTTP 客户端、Bot API 调用、长轮询、事件归一化。
 * 问答题卡片、按钮业务语义、@用户过滤、取消词等策略留在消费方。
 *
 * 两个沿用自移植源、不要改回去的设计：
 *  - 默认 HTTP 客户端用 node:https 自建（见 createProxyAwareFetch）：Node 的全局 fetch
 *    （undici）不读代理设置，在必须走代理才能连 Telegram 的网络里会 TLS reset，
 *    而同一环境下 curl 正常。
 *  - getUpdates 用长轮询 + offset：offset = update_id + 1 既推进游标，也让 Telegram
 *    不再重复投递旧 update（即去重）。
 */
import { execFileSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import type { TelegramChannelConfig } from "./config.ts";
import { maskAccount } from "./config.ts";
import type { ChannelInboundEvent, ChannelSendRequest } from "./events.ts";
import { readAckText } from "./events.ts";
import { logError } from "./log.ts";

const API_BASE = "https://api.telegram.org";
/** Telegram getUpdates 服务端长轮询上限是 50 秒。 */
const DEFAULT_POLL_TIMEOUT_SEC = 50;
const DEFAULT_RETRY_DELAY_MS = 1_000;
/** close() 等待在途请求的上限；超过就放弃等待，让轮询循环自己看到 active=false 后退出。 */
const CLOSE_GRACE_MS = 1_000;
/** callback_query 未携带 ackText 时的默认回执文案。 */
const ACK_FALLBACK_TEXT = "已收到";

/** fetch 的最小子集：够本模块用，又不必绑定 undici 的完整类型。 */
export type TgFetchResponse = {
	ok: boolean;
	status: number;
	text: () => Promise<string>;
};

/** 传输注入点：生产用 createProxyAwareFetch()，测试注入 fake，绝不触网。 */
export type TgFetch = (
	url: string,
	init?: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<TgFetchResponse>;

interface TgProxyInfo {
	host: string;
	port: number;
}

let macProxyCache: TgProxyInfo | undefined;
let macProxyChecked = false;

/** 读 macOS 系统 HTTP(S) 代理并缓存（每进程最多执行一次 scutil）；其它平台返回 undefined。 */
function macSystemProxy(): TgProxyInfo | undefined {
	if (macProxyChecked) return macProxyCache;
	macProxyChecked = true;
	if (process.platform !== "darwin") return undefined;
	try {
		const out = execFileSync("scutil", ["--proxy"], { encoding: "utf8", timeout: 2_000 });
		const host = /HTTPSProxy\s*:\s*([^\s]+)/.exec(out)?.[1];
		const port = /HTTPSPort\s*:\s*(\d+)/.exec(out)?.[1];
		if (host && port) macProxyCache = { host, port: Number(port) };
	} catch {
		// 取不到系统代理就直连
	}
	return macProxyCache;
}

/** 代理优先级：显式配置 → HTTPS_PROXY 等环境变量 → macOS 系统代理 → undefined（直连）。 */
function resolveProxy(explicit?: string): TgProxyInfo | undefined {
	const candidates: string[] = [];
	if (explicit) candidates.push(explicit);
	for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY"]) {
		const value = process.env[key];
		if (value) candidates.push(value);
	}
	for (const raw of candidates) {
		if (!raw) continue;
		try {
			const u = new URL(raw.includes("://") ? raw : `http://${raw}`);
			const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
			if (u.hostname && port > 0) return { host: u.hostname, port };
		} catch {
			// 候选格式非法——试下一个
		}
	}
	return macSystemProxy();
}

/** 构造 fetch-like 客户端；解析到代理时先 CONNECT 建隧道再升级 TLS。 */
function createProxyAwareFetch(explicitProxy?: string): TgFetch {
	return (input, init = {}) =>
		new Promise<TgFetchResponse>((resolve, reject) => {
			const url = new URL(input);
			const method = init.method ?? "GET";
			const signal = init.signal;

			const run = (tlsSocket?: TLSSocket) => {
				const req = httpsRequest(
					url,
					{
						method,
						headers: init.headers,
						createConnection: tlsSocket ? () => tlsSocket : undefined,
					},
					(res) => {
						let raw = "";
						res.setEncoding("utf8");
						res.on("data", (chunk: string) => {
							raw += chunk;
						});
						res.on("end", () => {
							const status = res.statusCode ?? 0;
							resolve({
								ok: status >= 200 && status < 300,
								status,
								text: async () => raw,
							});
						});
					},
				);
				signal?.addEventListener("abort", () => req.destroy(), { once: true });
				req.on("error", reject);
				if (init.body) req.write(init.body);
				req.end();
			};

			const proxy = resolveProxy(explicitProxy);
			if (!proxy) {
				run();
				return;
			}
			const connectReq = httpRequest({
				host: proxy.host,
				port: proxy.port,
				method: "CONNECT",
				path: `${url.hostname}:${url.port || 443}`,
			});
			connectReq.on("connect", (res, socket) => {
				if (res.statusCode !== 200) {
					socket.destroy();
					reject(new Error(`Proxy CONNECT to ${proxy.host}:${proxy.port} failed: HTTP ${res.statusCode}`));
					return;
				}
				const tlsSocket = tlsConnect({ socket, servername: url.hostname });
				tlsSocket.on("secureConnect", () => run(tlsSocket));
				tlsSocket.on("error", reject);
			});
			connectReq.on("error", reject);
			connectReq.end();
		});
}

export type TelegramProviderDeps = {
	fetch?: TgFetch;
	log?: (msg: string) => void;
	/** getUpdates 长轮询秒数。默认 50（Telegram 上限）；测试用 1。 */
	pollTimeoutSec?: number;
	/** 瞬时错误后的重试退避。默认 1000ms。 */
	retryDelayMs?: number;
};

export type TelegramProvider = {
	send(req: ChannelSendRequest, cfg: TelegramChannelConfig): Promise<{ messageId: string }>;
	/** 启动长轮询接收入站事件；幂等，重复调用不会起第二个轮询循环。 */
	connect(cfg: TelegramChannelConfig, onInbound: (evt: ChannelInboundEvent) => void): Promise<void>;
	close(): Promise<void>;
	status(): { connected: boolean; accountMasked?: string };
	classifyError(err: unknown): { code: string; message: string };
};

/** 带机器可读 `code` 的传输错误；classifyTelegramError 能识别它。 */
class TgChannelError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

/** 把未知错误归一成 `{ code, message }`；没有 code 的算 unknown。 */
export function classifyTelegramError(err: unknown): { code: string; message: string } {
	if (err instanceof Error && "code" in err && typeof (err as { code: unknown }).code === "string") {
		return { code: (err as { code: string }).code, message: err.message };
	}
	return { code: "unknown", message: err instanceof Error ? err.message : String(err) };
}

type TgApiResponse = {
	ok?: unknown;
	error_code?: unknown;
	description?: unknown;
	result?: unknown;
};

/** JSON.parse 结果先收窄成普通对象，避免 `null` / 数组正文让后续字段访问抛异常。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Telegram 的 id/时间戳都是十进制数字；同时容忍字符串形式（fake / 代理改写）。 */
function asFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string" && value.trim().length > 0) {
		const n = Number(value);
		return Number.isFinite(n) ? n : undefined;
	}
	return undefined;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** 把按钮 data 解析成 value：JSON 对象原样透传，其余（非 JSON / 非对象）保持原字符串。 */
function parseCallbackValue(raw: string): unknown {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed !== null && typeof parsed === "object") return parsed;
	} catch {
		// 不是 JSON —— 走下面的原字符串
	}
	return raw;
}

/** 解析 Telegram JSON 响应；非 JSON 正文返回空对象，由调用方按 HTTP status 分类。 */
function parseApiResponse(raw: string): TgApiResponse {
	try {
		const record = asRecord(JSON.parse(raw) as unknown);
		if (record !== undefined) return record;
	} catch {
		// 非 JSON（例如网关错误页）
	}
	return {};
}

/** 读响应正文；底层流出错按空正文处理，交给状态码/JSON 解析分类。 */
async function readResponseText(res: TgFetchResponse): Promise<string> {
	try {
		return await res.text();
	} catch {
		return "";
	}
}

function describeFailure(data: TgApiResponse): string {
	return typeof data.description === "string" && data.description.length > 0 ? data.description : "unknown";
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

class TelegramProviderImpl implements TelegramProvider {
	private readonly injectedFetch: TgFetch | undefined;
	private readonly log: (msg: string) => void;
	private readonly pollTimeoutSec: number;
	private readonly retryDelayMs: number;

	private active = false;
	private polling = false;
	private loop: Promise<void> | undefined;
	private offset: number | undefined;
	private accountMasked: string | undefined;
	private onInbound: ((evt: ChannelInboundEvent) => void) | undefined;
	/** 在途 HTTP 请求（长轮询 / send / ack / getMe）；close() 逐个 abort。 */
	private readonly inflight = new Set<AbortController>();

	private defaultFetch: TgFetch | undefined;
	private proxyFetch: { proxy: string; fetch: TgFetch } | undefined;

	constructor(deps: TelegramProviderDeps) {
		this.injectedFetch = deps.fetch;
		this.log = deps.log ?? (() => undefined);
		this.pollTimeoutSec = deps.pollTimeoutSec ?? DEFAULT_POLL_TIMEOUT_SEC;
		this.retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
	}

	async send(req: ChannelSendRequest, cfg: TelegramChannelConfig): Promise<{ messageId: string }> {
		const target = req.to?.id ?? cfg.defaultChatId;
		if (!target) {
			throw new TgChannelError("no_target", "telegram send needs to.id or cfg.defaultChatId");
		}

		if (req.update) {
			const { messageId } = req.update;
			// 有 text 时用 editMessageText：它也能带 reply_markup，一次请求同时改正文与键盘，
			// 比 editMessageReplyMarkup 表达力更强；只有 card（改键盘）时才退而用后者。
			if (req.text !== undefined) {
				const body: Record<string, unknown> = { chat_id: target, message_id: messageId, text: req.text };
				if (req.card !== undefined) body.reply_markup = JSON.stringify(req.card);
				if (req.parseMode !== undefined) body.parse_mode = req.parseMode;
				await this.callApi(cfg, "editMessageText", body);
				return { messageId };
			}
			if (req.card !== undefined) {
				await this.callApi(cfg, "editMessageReplyMarkup", {
					chat_id: target,
					message_id: messageId,
					reply_markup: JSON.stringify(req.card),
				});
				return { messageId };
			}
			throw new TgChannelError("invalid_request", "telegram update needs text and/or card");
		}

		const body: Record<string, unknown> = { chat_id: target, text: req.text ?? "" };
		if (req.parseMode !== undefined) body.parse_mode = req.parseMode;
		if (req.kind === "card") body.reply_markup = JSON.stringify(req.card);
		const result = await this.callApi(cfg, "sendMessage", body);
		const messageId = asFiniteNumber(asRecord(result)?.message_id);
		if (messageId === undefined) {
			throw new TgChannelError("tg_sendMessage", "Telegram sendMessage returned no message_id");
		}
		return { messageId: String(messageId) };
	}

	async connect(cfg: TelegramChannelConfig, onInbound: (evt: ChannelInboundEvent) => void): Promise<void> {
		// 出站模式：不建立长轮询，直接返回
		if (cfg.inbound === false) return;
		// 幂等：已在轮询就不再起第二个循环
		if (this.polling) return;

		this.active = true;
		this.polling = true;
		this.onInbound = onInbound;
		this.loop = this.pollLoop(cfg).catch((err: unknown) => {
			this.log(`telegram poll loop crashed: ${errorText(err)}`);
			this.polling = false;
		});
		// getMe 只用于 status().accountMasked 的脱敏展示；拿不到就不填，不影响轮询
		await this.refreshAccount(cfg);
	}

	async close(): Promise<void> {
		this.active = false;
		for (const controller of this.inflight) controller.abort();
		this.inflight.clear();
		this.onInbound = undefined;

		const loop = this.loop;
		this.loop = undefined;
		if (loop !== undefined) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					loop,
					new Promise<void>((resolve) => {
						timer = setTimeout(resolve, CLOSE_GRACE_MS);
					}),
				]);
			} finally {
				if (timer !== undefined) clearTimeout(timer);
			}
		}
		this.polling = false;
	}

	status(): { connected: boolean; accountMasked?: string } {
		const connected = this.active && this.polling;
		return this.accountMasked === undefined ? { connected } : { connected, accountMasked: this.accountMasked };
	}

	classifyError(err: unknown): { code: string; message: string } {
		return classifyTelegramError(err);
	}

	// ---- 轮询 ----

	private async pollLoop(cfg: TelegramChannelConfig): Promise<void> {
		while (this.active) {
			const outcome = await this.pollOnce(cfg);
			if (outcome === "stop") break;
			// 让出宏任务：fake fetch / 立即返回的 getUpdates 会让循环退化成微任务空转，
			// 饿死 close() 与等待超时等定时器。
			await sleep(0);
		}
		this.polling = false;
	}

	/** 轮询一轮：返回 "stop" 表示致命错误或已 close，循环应退出。 */
	private async pollOnce(cfg: TelegramChannelConfig): Promise<"continue" | "stop"> {
		const query = new URLSearchParams({
			timeout: String(this.pollTimeoutSec),
			allowed_updates: JSON.stringify(["message", "callback_query"]),
		});
		if (this.offset !== undefined) query.set("offset", String(this.offset));

		const controller = new AbortController();
		this.inflight.add(controller);
		let res: TgFetchResponse;
		try {
			res = await this.fetchFor(cfg)(`${API_BASE}/bot${cfg.botToken}/getUpdates?${query.toString()}`, {
				signal: controller.signal,
			});
		} catch (err) {
			if (!this.active) return "stop"; // close() abort 掉在途请求
			this.log(`getUpdates request failed: ${errorText(err)} — retrying`);
			await sleep(this.retryDelayMs);
			return "continue";
		} finally {
			this.inflight.delete(controller);
		}

		const data = parseApiResponse(await readResponseText(res));
		if (data.ok !== true) {
			const code = asFiniteNumber(data.error_code) ?? res.status;
			const desc = describeFailure(data);
			if (code === 401 || code === 409) {
				// 401 = token 错 / 409 = 同一 token 有另一个 poller：重试没有意义，停下来
				const reason = code === 401 ? "bad bot token" : "another poller is using this bot token";
				const line = `telegram getUpdates fatal (${code}) — ${reason}: ${desc}; polling stopped`;
				this.log(line);
				logError(line);
				return "stop";
			}
			this.log(`getUpdates transient error (${code}): ${desc} — retrying`);
			await sleep(this.retryDelayMs);
			return "continue";
		}

		const updates = Array.isArray(data.result) ? data.result : [];
		for (const raw of updates) {
			if (!this.active) break;
			const update = asRecord(raw);
			if (update === undefined) continue;
			const updateId = asFiniteNumber(update.update_id);
			if (updateId !== undefined) this.offset = updateId + 1;
			this.processUpdate(update, cfg);
		}
		return "continue";
	}

	private processUpdate(update: Record<string, unknown>, cfg: TelegramChannelConfig): void {
		const message = asRecord(update.message);
		if (message !== undefined) {
			this.normalizeMessage(message);
			return;
		}
		const callback = asRecord(update.callback_query);
		if (callback !== undefined) this.normalizeCallback(callback, cfg);
	}

	private normalizeMessage(message: Record<string, unknown>): void {
		const chat = asRecord(message.chat);
		const from = asRecord(message.from);
		const chatId = asFiniteNumber(chat?.id);
		const senderId = asFiniteNumber(from?.id);
		const messageId = asFiniteNumber(message.message_id);
		if (chatId === undefined || senderId === undefined || messageId === undefined) {
			// 正常消息必有 chat/from/message_id；缺字段说明结构异常，跳过而不是投递脏数据
			this.log("skip malformed telegram message update");
			return;
		}
		const text = typeof message.text === "string" ? message.text : undefined;
		const contentType =
			text !== undefined
				? "text"
				: message.sticker !== undefined
					? "sticker"
					: message.photo !== undefined
						? "photo"
						: message.document !== undefined
							? "document"
							: "other";
		this.dispatch({
			provider: "telegram",
			kind: "message",
			chatId: String(chatId),
			chatType: chatId < 0 ? "group" : "p2p",
			senderId: String(senderId),
			messageId: String(messageId),
			text: text ?? "",
			contentType,
			timestamp: (asFiniteNumber(message.date) ?? 0) * 1000,
		});
	}

	private normalizeCallback(callback: Record<string, unknown>, cfg: TelegramChannelConfig): void {
		const from = asRecord(callback.from);
		const msg = asRecord(callback.message);
		const chat = asRecord(msg?.chat);
		const chatId = asFiniteNumber(chat?.id);
		const senderId = asFiniteNumber(from?.id);
		const messageId = asFiniteNumber(msg?.message_id);
		const callbackId = typeof callback.id === "string" && callback.id.length > 0 ? callback.id : undefined;
		if (chatId === undefined || senderId === undefined || messageId === undefined || callbackId === undefined) {
			this.log("skip malformed telegram callback_query update");
			return;
		}
		const rawData = typeof callback.data === "string" && callback.data.length > 0 ? callback.data : undefined;
		const value = rawData === undefined ? undefined : parseCallbackValue(rawData);

		// 自动 ack 是 fire-and-forget：失败只记日志，绝不能影响下面的 inbound 投递
		void this.callApi(cfg, "answerCallbackQuery", {
			callback_query_id: callbackId,
			text: readAckText(value) ?? ACK_FALLBACK_TEXT,
		}).catch((err: unknown) => {
			const line = `answerCallbackQuery failed: ${errorText(err)}`;
			this.log(line);
			logError(line);
		});

		this.dispatch({
			provider: "telegram",
			kind: "action",
			chatId: String(chatId),
			chatType: chatId < 0 ? "group" : "p2p",
			senderId: String(senderId),
			messageId: String(messageId),
			value,
			timestamp: (asFiniteNumber(msg?.date) ?? 0) * 1000,
		});
	}

	/** 消费方回调抛异常不能打断轮询，只记日志。 */
	private dispatch(evt: ChannelInboundEvent): void {
		try {
			this.onInbound?.(evt);
		} catch (err) {
			this.log(`inbound handler failed: ${errorText(err)}`);
		}
	}

	/** 取 Bot API 的 bot id 并脱敏缓存；失败静默（status().accountMasked 留空）。 */
	private async refreshAccount(cfg: TelegramChannelConfig): Promise<void> {
		try {
			const result = await this.callApi(cfg, "getMe");
			const id = asFiniteNumber(asRecord(result)?.id);
			if (id !== undefined) this.accountMasked = maskAccount(String(id));
		} catch (err) {
			this.log(`getMe failed: ${errorText(err)}`);
		}
	}

	// ---- HTTP ----

	/** 注入的 fake 优先；否则按 cfg.proxy 缓存一个代理感知客户端，缺省用环境/系统代理。 */
	private fetchFor(cfg: TelegramChannelConfig): TgFetch {
		if (this.injectedFetch !== undefined) return this.injectedFetch;
		if (cfg.proxy !== undefined) {
			if (this.proxyFetch?.proxy !== cfg.proxy) {
				this.proxyFetch = { proxy: cfg.proxy, fetch: createProxyAwareFetch(cfg.proxy) };
			}
			return this.proxyFetch.fetch;
		}
		this.defaultFetch ??= createProxyAwareFetch();
		return this.defaultFetch;
	}

	/** POST 一个 Bot API 方法并解析响应；HTTP / 解析 / ok:false 都归一成 `tg_<method>` 错误。 */
	private async callApi(cfg: TelegramChannelConfig, method: string, body?: Record<string, unknown>): Promise<unknown> {
		const controller = new AbortController();
		this.inflight.add(controller);
		let res: TgFetchResponse;
		try {
			const init: { method: string; body?: string; headers?: Record<string, string>; signal: AbortSignal } = {
				method: "POST",
				signal: controller.signal,
			};
			if (body !== undefined) {
				init.headers = { "Content-Type": "application/json" };
				init.body = JSON.stringify(body);
			}
			res = await this.fetchFor(cfg)(`${API_BASE}/bot${cfg.botToken}/${method}`, init);
		} catch (err) {
			throw new TgChannelError(`tg_${method}`, `Telegram ${method} request failed: ${errorText(err)}`);
		} finally {
			this.inflight.delete(controller);
		}

		const data = parseApiResponse(await readResponseText(res));
		if (data.ok !== true) {
			throw new TgChannelError(
				`tg_${method}`,
				`Telegram ${method} failed (${asFiniteNumber(data.error_code) ?? res.status}): ${describeFailure(data)}`,
			);
		}
		return data.result;
	}
}

export function createTelegramProvider(deps: TelegramProviderDeps = {}): TelegramProvider {
	return new TelegramProviderImpl(deps);
}
