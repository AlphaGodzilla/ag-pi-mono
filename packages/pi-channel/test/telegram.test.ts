/**
 * pi-channel Telegram 传输层测试（node --test）。
 *
 * 全部通过注入 fake TgFetch 完成，绝不触网。
 * PI_CODING_AGENT_DIR 指向临时目录：致命错误路径调用 logError() 时只写临时 error.log，
 * 不触碰真实用户目录。
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TelegramChannelConfig } from "../lib/config.ts";
import { maskAccount } from "../lib/config.ts";
import type { ChannelInboundEvent } from "../lib/events.ts";
import { classifyTelegramError, createTelegramProvider, type TgFetch } from "../lib/telegram.ts";

const AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-channel-telegram-test-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
after(() => rmSync(AGENT_DIR, { recursive: true, force: true }));

type ApiCall = { method: string; body: Record<string, unknown> };
type ApiReply = { status?: number; body: unknown };

/** 把 Telegram API 的 JSON 响应包成 TgFetchResponse，按 URL 路径上的方法名分发给 handler。 */
function makeFetch(handler: (method: string, body: Record<string, unknown>) => ApiReply | Promise<ApiReply>): {
	fetch: TgFetch;
	calls: ApiCall[];
} {
	const calls: ApiCall[] = [];
	const fetchImpl: TgFetch = async (url, init) => {
		const method = new URL(url).pathname.split("/").pop() ?? "";
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
		calls.push({ method, body });
		const reply = await handler(method, body);
		const status = reply.status ?? 200;
		return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(reply.body) };
	};
	return { fetch: fetchImpl, calls };
}

/** 所有方法都成功的 fake（getUpdates 返回空列表）。 */
function okFetch(): { fetch: TgFetch; calls: ApiCall[] } {
	return makeFetch((method) => ({ body: { ok: true, result: method === "getUpdates" ? [] : true } }));
}

function tgCfg(over: Partial<TelegramChannelConfig> = {}): TelegramChannelConfig {
	return { botToken: "TEST_TOKEN", inbound: true, ...over };
}

/** provider.send 的入参（按 provider 判别的联合）；测试里用宽松构造器 + 断言，避免逐字段写全 */
type TgRequest = Parameters<ReturnType<typeof createTelegramProvider>["send"]>[0];

function sendReq(over: Record<string, unknown> = {}): TgRequest {
	return { requestId: "req-1", provider: "telegram", kind: "text", text: "hello", ...over } as unknown as TgRequest;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 1_000): Promise<void> {
	const started = Date.now();
	while (!cond()) {
		if (Date.now() - started > timeoutMs) throw new Error("timeout waiting for condition");
		await sleep(5);
	}
}

test("send: 文本走 sendMessage，chat_id 取 to.id，并返回 messageId", async () => {
	const { fetch, calls } = makeFetch(() => ({ body: { ok: true, result: { message_id: 5, chat: { id: -100123 } } } }));
	const provider = createTelegramProvider({ fetch });
	const sent = await provider.send(sendReq({ to: { id: "-100123" } }), tgCfg());
	assert.deepEqual(sent, { messageId: "5" });
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.method, "sendMessage");
	assert.equal(calls[0]?.body.chat_id, "-100123");
	assert.equal(calls[0]?.body.text, "hello");
	assert.equal(Object.hasOwn(calls[0]?.body ?? {}, "reply_markup"), false);
});

test("send: 不带 to 时回落到 cfg.defaultChatId", async () => {
	const { fetch, calls } = makeFetch(() => ({ body: { ok: true, result: { message_id: 7, chat: { id: -777 } } } }));
	const provider = createTelegramProvider({ fetch });
	await provider.send(sendReq(), tgCfg({ defaultChatId: "-777" }));
	assert.equal(calls[0]?.body.chat_id, "-777");
});

test("send: to 与 defaultChatId 都没有时抛 no_target，不发请求", async () => {
	const { fetch, calls } = okFetch();
	const provider = createTelegramProvider({ fetch });
	await assert.rejects(
		provider.send(sendReq(), tgCfg()),
		(err: unknown) => {
			assert.equal(classifyTelegramError(err).code, "no_target");
			assert.equal(provider.classifyError(err).code, "no_target");
			return true;
		},
	);
	assert.equal(calls.length, 0);
});

test("send: 卡片走 sendMessage 并把 card 序列化进 reply_markup", async () => {
	const card = { inline_keyboard: [[{ text: "A", callback_data: '{"q":"0","o":"1"}' }]] };
	const { fetch, calls } = makeFetch(() => ({ body: { ok: true, result: { message_id: 6, chat: { id: -100123 } } } }));
	const provider = createTelegramProvider({ fetch });
	const sent = await provider.send(sendReq({ kind: "card", text: "pick one", telegramKeyboard: card }), tgCfg({ defaultChatId: "-100123" }));
	assert.deepEqual(sent, { messageId: "6" });
	assert.equal(calls[0]?.method, "sendMessage");
	assert.equal(calls[0]?.body.reply_markup, JSON.stringify(card));
});

test("send: update + 仅键盘走 editMessageReplyMarkup（kind=keyboard），返回请求里的 messageId", async () => {
	const card = { inline_keyboard: [] };
	const { fetch, calls } = okFetch();
	const provider = createTelegramProvider({ fetch });
	const sent = await provider.send(
		sendReq({ to: { id: "-100123" }, kind: "keyboard", update: { messageId: "42" }, telegramKeyboard: card }),
		tgCfg(),
	);
	assert.deepEqual(sent, { messageId: "42" });
	assert.equal(calls[0]?.method, "editMessageReplyMarkup");
	assert.equal(calls[0]?.body.chat_id, "-100123");
	assert.equal(calls[0]?.body.message_id, "42");
	assert.equal(calls[0]?.body.reply_markup, JSON.stringify(card));
});

test("send: update + 仅 text 走 editMessageText", async () => {
	const { fetch, calls } = okFetch();
	const provider = createTelegramProvider({ fetch });
	const sent = await provider.send(
		sendReq({ to: { id: "-100123" }, update: { messageId: "42" }, text: "done" }),
		tgCfg(),
	);
	assert.deepEqual(sent, { messageId: "42" });
	assert.equal(calls[0]?.method, "editMessageText");
	assert.equal(calls[0]?.body.text, "done");
	assert.equal(Object.hasOwn(calls[0]?.body ?? {}, "reply_markup"), false);
});

test("send: update + text + card 走 editMessageText 并同时更新键盘", async () => {
	const card = { inline_keyboard: [] };
	const { fetch, calls } = okFetch();
	const provider = createTelegramProvider({ fetch });
	await provider.send(sendReq({ to: { id: "-100123" }, kind: "card", update: { messageId: "42" }, text: "done", telegramKeyboard: card }), tgCfg());
	assert.equal(calls[0]?.method, "editMessageText");
	assert.equal(calls[0]?.body.text, "done");
	assert.equal(calls[0]?.body.reply_markup, JSON.stringify(card));
});

test("send: kind=keyboard 但缺 update 时抛 invalid_request，不发请求", async () => {
	const { fetch, calls } = okFetch();
	const provider = createTelegramProvider({ fetch });
	await assert.rejects(
		provider.send(sendReq({ kind: "keyboard", update: undefined, telegramKeyboard: { inline_keyboard: [] } }), tgCfg({ defaultChatId: "-1" })),
		(err: unknown) => {
			assert.equal(classifyTelegramError(err).code, "invalid_request");
			return true;
		},
	);
	assert.equal(calls.length, 0);
});

test("send: Bot API 返回 ok:false 时抛 tg_sendMessage 并带 description", async () => {
	const { fetch } = makeFetch(() => ({
		status: 400,
		body: { ok: false, error_code: 400, description: "Bad Request: chat not found" },
	}));
	const provider = createTelegramProvider({ fetch });
	await assert.rejects(
		provider.send(sendReq({ to: { id: "1" } }), tgCfg()),
		(err: unknown) => {
			const classified = provider.classifyError(err);
			assert.equal(classified.code, "tg_sendMessage");
			assert.ok(classified.message.includes("chat not found"));
			return true;
		},
	);
});

test("classifyTelegramError: 识别带 code 的错误，其余归为 unknown", () => {
	const coded = Object.assign(new Error("conflict"), { code: "tg_getUpdates" });
	assert.deepEqual(classifyTelegramError(coded), { code: "tg_getUpdates", message: "conflict" });
	assert.deepEqual(classifyTelegramError(new Error("boom")), { code: "unknown", message: "boom" });
	assert.deepEqual(classifyTelegramError("boom"), { code: "unknown", message: "boom" });
});

test("connect: cfg.inbound === false 时不轮询", async () => {
	const { fetch, calls } = okFetch();
	const provider = createTelegramProvider({ fetch, pollTimeoutSec: 1, retryDelayMs: 5 });
	await provider.connect(tgCfg({ inbound: false }), () => {
		throw new Error("inbound should not fire");
	});
	await sleep(20);
	assert.equal(calls.length, 0);
	assert.deepEqual(provider.status(), { connected: false });
});

test("长轮询: message 归一化为 ChannelInboundMessage，并缓存脱敏账号", async (t) => {
	let polls = 0;
	const { fetch } = makeFetch((method) => {
		if (method === "getUpdates") {
			polls += 1;
			return {
				body: {
					ok: true,
					result:
						polls === 1
							? [
									{
										update_id: 1,
										message: {
											message_id: 111,
											from: { id: 42, is_bot: false, first_name: "Alice" },
											chat: { id: -100123, type: "supergroup" },
											text: "hello",
											date: 1_700_000_000,
										},
									},
								]
							: [],
				},
			};
		}
		if (method === "getMe") return { body: { ok: true, result: { id: 123456789, is_bot: true } } };
		return { body: { ok: true, result: true } };
	});
	const provider = createTelegramProvider({ fetch, pollTimeoutSec: 1, retryDelayMs: 5 });
	t.after(() => provider.close());

	const events: ChannelInboundEvent[] = [];
	await provider.connect(tgCfg(), (evt) => events.push(evt));
	await waitFor(() => events.length === 1);
	assert.deepEqual(events[0], {
		provider: "telegram",
		kind: "message",
		chatId: "-100123",
		chatType: "group",
		senderId: "42",
		messageId: "111",
		text: "hello",
		contentType: "text",
		timestamp: 1_700_000_000_000,
	});
	assert.deepEqual(provider.status(), { connected: true, accountMasked: maskAccount("123456789") });
});

test("长轮询: 非文本消息给出对应的 contentType 与空 text", async (t) => {
	const base = { from: { id: 42 }, chat: { id: -100123 }, date: 1 };
	let polls = 0;
	const { fetch } = makeFetch((method) => {
		if (method === "getUpdates") {
			polls += 1;
			return {
				body: {
					ok: true,
					result:
						polls === 1
							? [
									{ update_id: 11, message: { ...base, message_id: 1, sticker: { file_id: "s" } } },
									{ update_id: 12, message: { ...base, message_id: 2, photo: [{ file_id: "p" }] } },
									{ update_id: 13, message: { ...base, message_id: 3, document: { file_id: "d" } } },
									{ update_id: 14, message: { ...base, message_id: 4, chat: { id: 7 } } },
								]
							: [],
				},
			};
		}
		return { body: { ok: true, result: true } };
	});
	const provider = createTelegramProvider({ fetch, pollTimeoutSec: 1, retryDelayMs: 5 });
	t.after(() => provider.close());

	const events: ChannelInboundEvent[] = [];
	await provider.connect(tgCfg(), (evt) => events.push(evt));
	await waitFor(() => events.length === 4);
	assert.deepEqual(
		events.map((evt) => (evt.kind === "message" ? evt.contentType : "?")),
		["sticker", "photo", "document", "other"],
	);
	assert.deepEqual(
		events.map((evt) => (evt.kind === "message" ? evt.chatType : "?")),
		["group", "group", "group", "p2p"],
	);
	assert.deepEqual(
		events.map((evt) => (evt.kind === "message" ? evt.text : "?")),
		["", "", "", ""],
	);
});

test("长轮询: callback_query 归一化并自动 ack（自定义 ackText / 默认文案）", async (t) => {
	const cardValue = { q: "0", o: "2", ackText: "已选 B" };
	let polls = 0;
	const { fetch, calls } = makeFetch((method) => {
		if (method === "getUpdates") {
			polls += 1;
			return {
				body: {
					ok: true,
					result:
						polls === 1
							? [
									{
										update_id: 21,
										callback_query: {
											id: "cb_1",
											from: { id: 42 },
											message: { message_id: 222, chat: { id: -100123 }, date: 1_700_000_000 },
											data: JSON.stringify(cardValue),
										},
									},
									{
										update_id: 22,
										callback_query: {
											id: "cb_2",
											from: { id: 42 },
											message: { message_id: 333, chat: { id: 42 }, date: 1_700_000_001 },
											data: "plain",
										},
									},
								]
							: [],
				},
			};
		}
		return { body: { ok: true, result: true } };
	});
	const provider = createTelegramProvider({ fetch, pollTimeoutSec: 1, retryDelayMs: 5 });
	t.after(() => provider.close());

	const events: ChannelInboundEvent[] = [];
	await provider.connect(tgCfg(), (evt) => events.push(evt));
	await waitFor(() => events.length === 2);
	assert.deepEqual(events[0], {
		provider: "telegram",
		kind: "action",
		chatId: "-100123",
		chatType: "group",
		senderId: "42",
		messageId: "222",
		value: cardValue,
		timestamp: 1_700_000_000_000,
	});
	assert.deepEqual(events[1], {
		provider: "telegram",
		kind: "action",
		chatId: "42",
		chatType: "p2p",
		senderId: "42",
		messageId: "333",
		value: "plain",
		timestamp: 1_700_000_001_000,
	});
	await waitFor(() => calls.filter((c) => c.method === "answerCallbackQuery").length === 2);
	const acks = calls.filter((c) => c.method === "answerCallbackQuery");
	assert.equal(acks[0]?.body.callback_query_id, "cb_1");
	assert.equal(acks[0]?.body.text, "已选 B");
	assert.equal(acks[1]?.body.callback_query_id, "cb_2");
	assert.equal(acks[1]?.body.text, "已收到");
});

test("长轮询: ack 失败只记日志，不影响 inbound 投递", async (t) => {
	const logged: string[] = [];
	let polls = 0;
	const { fetch } = makeFetch((method) => {
		if (method === "getUpdates") {
			polls += 1;
			return {
				body: {
					ok: true,
					result:
						polls === 1
							? [
									{
										update_id: 31,
										callback_query: {
											id: "cb_fail",
											from: { id: 42 },
											message: { message_id: 444, chat: { id: -100123 }, date: 1 },
											data: "x",
										},
									},
								]
							: [],
				},
			};
		}
		if (method === "answerCallbackQuery") {
			return { status: 400, body: { ok: false, error_code: 400, description: "Bad Request" } };
		}
		return { body: { ok: true, result: true } };
	});
	const provider = createTelegramProvider({ fetch, log: (m) => logged.push(m), pollTimeoutSec: 1, retryDelayMs: 5 });
	t.after(() => provider.close());

	const events: ChannelInboundEvent[] = [];
	await provider.connect(tgCfg(), (evt) => events.push(evt));
	await waitFor(() => events.length === 1);
	await waitFor(() => logged.some((m) => m.includes("answerCallbackQuery failed")));
	assert.equal(events[0]?.kind, "action");
});

test("长轮询: 401 致命错误后停止轮询", async (t) => {
	const logged: string[] = [];
	const { fetch, calls } = makeFetch(() => ({
		status: 401,
		body: { ok: false, error_code: 401, description: "Unauthorized" },
	}));
	const provider = createTelegramProvider({ fetch, log: (m) => logged.push(m), pollTimeoutSec: 1, retryDelayMs: 5 });
	t.after(() => provider.close());

	await provider.connect(tgCfg(), () => {
		throw new Error("no inbound expected");
	});
	await waitFor(() => provider.status().connected === false);
	const settled = calls.filter((c) => c.method === "getUpdates").length;
	await sleep(30);
	assert.equal(calls.filter((c) => c.method === "getUpdates").length, settled);
	assert.ok(logged.some((m) => m.includes("fatal (401)")));
});

test("长轮询: 409 冲突（reload 新旧实例重叠）退避重试，冲突消失后继续轮询", async (t) => {
	const logged: string[] = [];
	let polls = 0;
	const { fetch, calls } = makeFetch((method) => {
		if (method !== "getUpdates") return { body: { ok: true, result: true } };
		polls += 1;
		if (polls === 1) {
			return {
				status: 409,
				body: { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" },
			};
		}
		return { body: { ok: true, result: [] } };
	});
	const provider = createTelegramProvider({
		fetch,
		log: (m) => logged.push(m),
		pollTimeoutSec: 1,
		retryDelayMs: 5,
		conflictRetryMs: 5,
	});
	t.after(() => provider.close());

	await provider.connect(tgCfg(), () => {});
	await waitFor(() => calls.filter((c) => c.method === "getUpdates").length >= 2);
	assert.ok(logged.some((m) => m.includes("conflict (409)")), "应记录 409 冲突");
	assert.ok(!logged.some((m) => m.includes("polling stopped")), "409 不应停掉轮询");
	assert.equal(provider.status().connected, true);
});

test("长轮询: 瞬时错误退避后继续重试", async (t) => {
	let polls = 0;
	const { fetch } = makeFetch((method) => {
		if (method === "getUpdates") {
			polls += 1;
			if (polls === 1) return { status: 500, body: { ok: false, error_code: 500, description: "Internal" } };
			if (polls > 2) return { body: { ok: true, result: [] } };
			return {
				body: {
					ok: true,
					result: [
						{
							update_id: 41,
							message: {
								message_id: 555,
								from: { id: 42 },
								chat: { id: -100123 },
								text: "after retry",
								date: 1_700_000_000,
							},
						},
					],
				},
			};
		}
		return { body: { ok: true, result: true } };
	});
	const provider = createTelegramProvider({ fetch, pollTimeoutSec: 1, retryDelayMs: 5 });
	t.after(() => provider.close());

	const events: ChannelInboundEvent[] = [];
	await provider.connect(tgCfg(), (evt) => events.push(evt));
	await waitFor(() => events.length === 1);
	assert.ok(polls >= 2);
	assert.equal(events[0]?.kind === "message" ? events[0].text : "", "after retry");
});

test("close: 停止轮询，connected 变 false 且不再发 getUpdates", async () => {
	let polls = 0;
	const { fetch, calls } = makeFetch((method) => {
		if (method === "getUpdates") {
			polls += 1;
			return { body: { ok: true, result: [] } };
		}
		return { body: { ok: true, result: true } };
	});
	const provider = createTelegramProvider({ fetch, pollTimeoutSec: 1, retryDelayMs: 5 });
	await provider.connect(tgCfg(), () => undefined);
	assert.equal(provider.status().connected, true);
	await waitFor(() => polls >= 2);

	await provider.close();
	assert.equal(provider.status().connected, false);
	const settled = calls.filter((c) => c.method === "getUpdates").length;
	await sleep(30);
	assert.equal(calls.filter((c) => c.method === "getUpdates").length, settled);
});

test("connect: 重复调用幂等，不会起第二个轮询循环", async (t) => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let getUpdatesCalls = 0;
	const { fetch } = makeFetch(async (method) => {
		if (method === "getUpdates") {
			getUpdatesCalls += 1;
			await gate;
			return { body: { ok: true, result: [] } };
		}
		return { body: { ok: true, result: true } };
	});
	const provider = createTelegramProvider({ fetch, pollTimeoutSec: 1, retryDelayMs: 5 });
	t.after(async () => {
		release?.();
		await provider.close();
	});

	await provider.connect(tgCfg(), () => undefined);
	await provider.connect(tgCfg(), () => undefined);
	await sleep(20);
	assert.equal(getUpdatesCalls, 1);
	assert.equal(provider.status().connected, true);
});

test("connect: getMe 失败时 accountMasked 留空，轮询照常", async (t) => {
	let polls = 0;
	const { fetch } = makeFetch((method) => {
		if (method === "getMe") return { status: 401, body: { ok: false, error_code: 401, description: "Unauthorized" } };
		if (method === "getUpdates") {
			polls += 1;
			return {
				body: {
					ok: true,
					result:
						polls === 1
							? [
									{
										update_id: 51,
										message: { message_id: 1, from: { id: 42 }, chat: { id: 42 }, text: "hi", date: 1 },
									},
								]
							: [],
				},
			};
		}
		return { body: { ok: true, result: true } };
	});
	const provider = createTelegramProvider({ fetch, pollTimeoutSec: 1, retryDelayMs: 5 });
	t.after(() => provider.close());

	const events: ChannelInboundEvent[] = [];
	await provider.connect(tgCfg(), (evt) => events.push(evt));
	assert.equal(provider.status().accountMasked, undefined);
	await waitFor(() => events.length === 1);
});
