/**
 * 飞书 provider 单测（node --test）。
 *
 * 注入假 client / 假 channel（`FeishuProviderDeps`），全程不触网、不加载真 SDK 连接；
 * 覆盖出站三条路径、入站归一化、卡片回调 ack 注入与连接生命周期。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Domain } from "@larksuiteoapi/node-sdk";
import type { FeishuChannelConfig } from "../lib/config.ts";
import type { ChannelInboundEvent } from "../lib/events.ts";
import {
	classifyFeishuError,
	createFeishuProvider,
	FeishuChannelError,
	type FeishuChannelLike,
	type FeishuClientLike,
} from "../lib/feishu.ts";

type Call = { api: string; args: unknown };

/** provider.send 的入参（按 provider 判别的联合）；JS 调用方兜底用例用它做断言 */
type FeishuReq = Parameters<ReturnType<typeof createFeishuProvider>["send"]>[0];

function makeCfg(over: Partial<FeishuChannelConfig> = {}): FeishuChannelConfig {
	return {
		appId: "cli_test",
		appSecret: "secret",
		domain: "feishu",
		inbound: false,
		requireMention: true,
		dmMode: "open",
		defaultReceiver: { type: "chat_id", value: "oc_default" },
		...over,
	};
}

function makeClient() {
	const calls: Call[] = [];
	const client: FeishuClientLike = {
		im: {
			v1: {
				message: {
					create: async (args) => {
						calls.push({ api: "create", args });
						return { data: { message_id: "om_created" } };
					},
					patch: async (args) => {
						calls.push({ api: "patch", args });
						return {};
					},
				},
			},
		},
	};
	return { client, calls };
}

function makeChannel() {
	const handlers: Record<string, Array<(payload: unknown) => void>> = { message: [], cardAction: [] };
	const lifecycle: string[] = [];
	const dispatcher = { invoke: async (_data: unknown) => "original-result" };
	const channel: FeishuChannelLike = {
		connect: async () => {
			lifecycle.push("connect");
			// 模拟真 SDK：WS client（含 eventDispatcher）在 connect 时才创建——
			// 这样"ack 注入必须在 connect 之后"这条约束才有测试兜底。
			(channel as { rawWsClient?: unknown }).rawWsClient = { eventDispatcher: dispatcher };
		},
		disconnect: async () => {
			lifecycle.push("disconnect");
		},
		on: (event, handler) => {
			handlers[event]?.push(handler);
			return () => {
				handlers[event] = (handlers[event] ?? []).filter((h) => h !== handler);
			};
		},
	};
	return { channel, handlers, lifecycle, dispatcher };
}

function providerWith(client = makeClient().client, channel = makeChannel().channel) {
	const opts: Array<{ appId: string; appSecret: string; domain: Domain }> = [];
	const provider = createFeishuProvider({
		createClient: (o) => {
			opts.push(o);
			return client;
		},
		createChannel: () => channel,
		log: () => {},
	});
	return { provider, opts };
}

// ---------- 出站 ----------

test("send 文本：走 im.v1.message.create，默认收件人取 config.defaultReceiver", async () => {
	const { client, calls } = makeClient();
	const { provider } = providerWith(client);
	const res = await provider.send({ requestId: "r1", provider: "feishu", kind: "text", text: "你好" }, makeCfg());

	assert.equal(res.messageId, "om_created");
	assert.equal(calls.length, 1);
	const args = calls[0]?.args as { params: { receive_id_type: string }; data: { receive_id: string; msg_type: string; content: string } };
	assert.equal(args.params.receive_id_type, "chat_id");
	assert.equal(args.data.receive_id, "oc_default");
	assert.equal(args.data.msg_type, "text");
	assert.deepEqual(JSON.parse(args.data.content), { text: "你好" });
});

test("send 文本：显式 to 覆盖收件人与 receive_id_type", async () => {
	const { client, calls } = makeClient();
	const { provider } = providerWith(client);
	await provider.send(
		{ requestId: "r1", provider: "feishu", kind: "text", text: "hi", to: { id: "ou_x", type: "open_id" } },
		makeCfg(),
	);
	const args = calls[0]?.args as { params: { receive_id_type: string }; data: { receive_id: string } };
	assert.equal(args.params.receive_id_type, "open_id");
	assert.equal(args.data.receive_id, "ou_x");
});

test("send 文本：飞书不接受 parseMode（契约按 provider 判别）", async () => {
	const { client, calls } = makeClient();
	const { provider } = providerWith(client);
	// @ts-expect-error 飞书文本请求没有 parseMode 字段；JS 调用方多传时运行时忽略
	await provider.send({ requestId: "r1", provider: "feishu", kind: "text", text: "hi", parseMode: "HTML" }, makeCfg());
	const args = calls[0]?.args as { data: { content: string } };
	assert.deepEqual(JSON.parse(args.data.content), { text: "hi" });
});

test("send 卡片：msg_type=interactive，content 为卡片 JSON 原样", async () => {
	const { client, calls } = makeClient();
	const { provider } = providerWith(client);
	const card = { schema: "2.0", body: { elements: [] } };
	await provider.send({ requestId: "r1", provider: "feishu", kind: "card", feishuCard: card }, makeCfg());
	const args = calls[0]?.args as { data: { msg_type: string; content: string } };
	assert.equal(args.data.msg_type, "interactive");
	assert.deepEqual(JSON.parse(args.data.content), card);
});

test("send：没有 to 也没有默认收件人 → no_target", async () => {
	const { provider } = providerWith();
	await assert.rejects(
		() => provider.send({ requestId: "r1", provider: "feishu", kind: "text", text: "x" }, makeCfg({ defaultReceiver: undefined })),
		(err: unknown) => err instanceof FeishuChannelError && err.code === "no_target",
	);
});

test("send：card 请求缺 feishuCard → invalid_request（JS 调用方兜底）", async () => {
	const { provider } = providerWith();
	await assert.rejects(
		() => provider.send({ requestId: "r1", provider: "feishu", kind: "card" } as unknown as FeishuReq, makeCfg()),
		(err: unknown) => err instanceof FeishuChannelError && err.code === "invalid_request",
	);
});

test("send update：走 im.v1.message.patch 并回显 messageId", async () => {
	const { client, calls } = makeClient();
	const { provider } = providerWith(client);
	const card = { schema: "2.0", body: { elements: [{ tag: "markdown" }] } };
	const res = await provider.send(
		{ requestId: "r1", provider: "feishu", kind: "card", feishuCard: card, update: { messageId: "om_old" } },
		makeCfg(),
	);
	assert.equal(res.messageId, "om_old");
	const args = calls[0]?.args as { path: { message_id: string }; data: { content: string } };
	assert.equal(args.path.message_id, "om_old");
	assert.deepEqual(JSON.parse(args.data.content), card);
});

test("send：缺 appId/appSecret → not_configured", async () => {
	const { provider } = providerWith();
	await assert.rejects(
		() => provider.send({ requestId: "r1", provider: "feishu", kind: "text", text: "x" }, makeCfg({ appId: "" })),
		(err: unknown) => err instanceof FeishuChannelError && err.code === "not_configured",
	);
});

test("send：domain 映射到 SDK 的 Domain 枚举（lark → Domain.Lark）", async () => {
	const seen: Array<{ appId: string; domain: Domain }> = [];
	const client = makeClient().client;
	const provider = createFeishuProvider({
		createClient: (o) => {
			seen.push({ appId: o.appId, domain: o.domain });
			return client;
		},
		log: () => {},
	});
	await provider.send(
		{ requestId: "r1", provider: "feishu", kind: "text", text: "x" },
		makeCfg({ appId: "cli_lark", domain: "lark" }),
	);
	await provider.send(
		{ requestId: "r2", provider: "feishu", kind: "text", text: "x" },
		makeCfg({ appId: "cli_feishu", domain: "feishu" }),
	);
	assert.deepEqual(seen, [
		{ appId: "cli_lark", domain: Domain.Lark },
		{ appId: "cli_feishu", domain: Domain.Feishu },
	]);
});

// ---------- 入站 ----------

test("connect：inbound=false 不建长连接，send 仍可用", async () => {
	let created = 0;
	const p = createFeishuProvider({
		createChannel: () => {
			created++;
			return makeChannel().channel;
		},
		createClient: () => {
			const { client } = makeClient();
			return client;
		},
		log: () => {},
	});
	await p.connect(makeCfg({ inbound: false }), () => {});
	assert.equal(created, 0);
	assert.equal(p.status().connected, false);
	assert.equal(created, 0);
	// 出站仍可用（client 已建）
	const res = await p.send({ requestId: "r1", provider: "feishu", kind: "text", text: "x" }, makeCfg({ inbound: false }));
	assert.equal(res.messageId, "om_created");
});

test("connect：inbound=true 建连接、订阅并归一化 message / cardAction", async () => {
	const { channel, handlers, lifecycle } = makeChannel();
	const { provider } = providerWith(undefined, channel);
	const received: ChannelInboundEvent[] = [];
	await provider.connect(makeCfg({ inbound: true }), (evt) => received.push(evt));

	assert.deepEqual(lifecycle, ["connect"]);
	assert.equal(provider.status().connected, true);
	assert.equal(provider.status().accountMasked, "cli_…"); // maskAccount：≤14 位取前 4 位 + …
	assert.equal(handlers.message?.length, 1);
	assert.equal(handlers.cardAction?.length, 1);

	handlers.message?.[0]?.({
		content: "回答 A",
		chatId: "oc_group",
		chatType: "group",
		senderId: "ou_user",
		messageId: "om_1",
		rawContentType: "text",
		createTime: 1700000000000,
	});
	assert.deepEqual(received[0], {
		provider: "feishu",
		kind: "message",
		chatId: "oc_group",
		chatType: "group",
		senderId: "ou_user",
		messageId: "om_1",
		text: "回答 A",
		contentType: "text",
		timestamp: 1700000000000,
	});

	handlers.message?.[0]?.({
		content: "",
		chatId: "oc_group",
		chatType: "p2p",
		senderId: "ou_user",
		messageId: "om_2",
		rawContentType: "sticker",
	});
	assert.equal(received[1]?.kind, "message");
	assert.equal((received[1] as { text: string }).text, "");
	assert.equal((received[1] as { contentType: string }).contentType, "sticker");

	handlers.cardAction?.[0]?.({
		chatId: "oc_group",
		messageId: "om_1",
		action: { value: { q: "0", o: "2", ackText: "已选择" } },
		operator: { openId: "ou_user" },
	});
	assert.deepEqual(received[2], {
		provider: "feishu",
		kind: "action",
		chatId: "oc_group",
		senderId: "ou_user",
		messageId: "om_1",
		value: { q: "0", o: "2", ackText: "已选择" },
	});
});

test("connect：重复调用幂等（不会重复建连）", async () => {
	const { channel, lifecycle } = makeChannel();
	let created = 0;
	const provider = createFeishuProvider({
		createChannel: () => {
			created++;
			return channel;
		},
		log: () => {},
	});
	await provider.connect(makeCfg({ inbound: true }), () => {});
	await provider.connect(makeCfg({ inbound: true }), () => {});
	assert.equal(created, 1);
	assert.deepEqual(lifecycle, ["connect"]);
});

test("卡片回调 ack 注入：用 value.ackText 作 toast，缺省「已收到」，非卡片事件透传", async () => {
	const { channel, dispatcher } = makeChannel();
	const { provider } = providerWith(undefined, channel);
	await provider.connect(makeCfg({ inbound: true }), () => {});

	const cardData = (ackText?: string) => ({
		header: { event_type: "card.action.trigger" },
		event: { action: { value: ackText === undefined ? {} : { ackText } } },
	});

	const withAck = await dispatcher.invoke(cardData("已取消"));
	assert.deepEqual(withAck, { toast: { type: "success", content: "已取消" } });

	const withoutAck = await dispatcher.invoke(cardData());
	assert.deepEqual(withoutAck, { toast: { type: "success", content: "已收到" } });

	const other = await dispatcher.invoke({ header: { event_type: "im.message.receive_v1" } });
	assert.equal(other, "original-result");
});

test("close：等待 400ms 冲刷 ack 后 disconnect，状态归零", async () => {
	const { channel, lifecycle } = makeChannel();
	const { provider } = providerWith(undefined, channel);
	await provider.connect(makeCfg({ inbound: true }), () => {});
	const startedAt = Date.now();
	await provider.close();
	assert.deepEqual(lifecycle, ["connect", "disconnect"]);
	assert.ok(Date.now() - startedAt >= 380, "close 应先等待 ack 帧冲刷（~400ms）");
	assert.equal(provider.status().connected, false);
});

test("close：未连接时是空操作", async () => {
	const { provider } = providerWith();
	await provider.close();
	assert.equal(provider.status().connected, false);
});

// ---------- 错误分类 ----------

test("classifyFeishuError：保留 code，其它错误归为 unknown", () => {
	assert.deepEqual(classifyFeishuError(new FeishuChannelError("10217", "app has been deleted")), {
		code: "10217",
		message: "app has been deleted",
	});
	assert.deepEqual(classifyFeishuError(new Error("boom")), { code: "unknown", message: "boom" });
	assert.deepEqual(classifyFeishuError("nope"), { code: "unknown", message: "nope" });
});
