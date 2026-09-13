/**
 * pi-channel 扩展入口集成冒烟测试（node --test）。
 *
 * 用 pi 自带的 createEventBus() + 假 pi（捕获 pi.on / registerCommand），验证：
 *  - `ag-pi-channel:status` → `:status:result` 的回报（配置路径 + 两个 provider 状态）
 *  - `ag-pi-channel:send` 在未配置/未知 provider 时回 ok:false（不抛异常、不触网）
 *  - `/channel` 命令的 status / send / reload 分支
 *  - session_start / session_shutdown 生命周期钩子注册
 *
 * 全程不触网：所有场景的 provider 都是「未配置」或 `inbound: false`（不建连接）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { CHANNEL_SEND, sendViaBus, statusViaBus, type ChannelStatusResult, type EventsLike } from "../lib/events.ts";

// sendViaBus / statusViaBus 的超时定时器是 unref 的（避免拖住 pi 进程），所以等待结果期间
// 事件循环可能直接空掉；测试里用一个 ref 的定时器撑住，否则用例会被判为 pending 而取消。
const keepAlive = setInterval(() => {}, 1000);

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PI_DIST = join(PKG_DIR, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");

const AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-channel-index-test-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
const CONFIG_PATH = join(AGENT_DIR, "extensions", "pi-channel", "config.json");

const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	alias: { "@earendil-works/pi-coding-agent": PI_DIST },
});

const { createEventBus } = (await import(PI_DIST)) as { createEventBus: () => EventsLike };
const piChannel = (await jiti.import(join(PKG_DIR, "index.ts"))) as { default: (pi: unknown) => void };

type Notify = { msg: string; level: string };
type FakePi = {
	events: EventsLike;
	handlers: Map<string, (...args: unknown[]) => unknown>;
	commands: Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>;
	notices: Notify[];
};

/** @param events 可注入（默认真 EventBus）；注入一个会抛错的 emit 即可模拟 reload 后的 stale ctx */
function makeFakePi(events: EventsLike = createEventBus()): FakePi {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	const notices: Notify[] = [];
	piChannel.default({
		events,
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(event, handler);
		},
		registerCommand: (name: string, def: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.set(name, def);
		},
		ui: {
			notify: (msg: string, level: string) => notices.push({ msg, level }),
		},
	});
	return { events, handlers, commands, notices };
}

const uiCtx = (notices: Notify[]) => ({
	hasUI: true,
	ui: { notify: (msg: string, level: string) => notices.push({ msg, level }) },
});

test("未配置时：status 回报两个 provider 均未配置，且带上配置路径", async () => {
	rmSync(CONFIG_PATH, { force: true });
	const pi = makeFakePi();
	const status = await statusViaBus(pi.events, 500);

	assert.ok(status, "应收到 status:result");
	const result = status as ChannelStatusResult;
	assert.equal(result.configPath, CONFIG_PATH);
	assert.deepEqual(
		result.providers.map((p) => ({ provider: p.provider, configured: p.configured, connected: p.connected })),
		[
			{ provider: "feishu", configured: false, connected: false },
			{ provider: "telegram", configured: false, connected: false },
		],
	);
});

test("未配置时：send 回 ok:false + not_configured，不抛异常", async () => {
	const pi = makeFakePi();
	const feishu = await sendViaBus(pi.events, { provider: "feishu", kind: "text", text: "hi" }, 500);
	assert.equal(feishu.ok, false);
	assert.equal(feishu.error?.code, "not_configured");

	const telegram = await sendViaBus(pi.events, { provider: "telegram", kind: "text", text: "hi" }, 500);
	assert.equal(telegram.ok, false);
	assert.equal(telegram.error?.code, "not_configured");
});

test("未知 provider：send 回 ok:false（unknown_provider）", async () => {
	const pi = makeFakePi();
	const result = await sendViaBus(
		pi.events,
		{ provider: "whatsapp" as unknown as "feishu", kind: "text", text: "hi" },
		500,
	);
	assert.equal(result.ok, false);
	assert.equal(result.error?.code, "unknown_provider");
});

test("插件未加载时：sendViaBus 超时返回 ok:false（消费方零依赖降级）", async () => {
	const orphan = createEventBus();
	const result = await sendViaBus(orphan, { provider: "feishu", kind: "text", text: "hi" }, 120);
	assert.equal(result.ok, false);
	assert.equal(result.error?.code, "timeout");
});

test("生命周期：惰性启动（不注册 session_start）且注册 session_shutdown；inbound=false 时不建连", async () => {
	const pi = makeFakePi();
	// 惰性：不注册 session_start —— 启动时不允许向飞书/Telegram 建连
	assert.equal(pi.handlers.has("session_start"), false);
	assert.ok(pi.handlers.has("session_shutdown"));

	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(
		CONFIG_PATH,
		JSON.stringify({
			feishu: { appId: "cli_test", appSecret: "secret", inbound: false, defaultReceiver: { type: "chat_id", value: "oc_x" } },
			telegram: { botToken: "123:abc", inbound: false, defaultChatId: "-100" },
		}),
		"utf8",
	);
	const pi2 = makeFakePi();
	await pi2.handlers.get("session_start")?.({}, uiCtx(pi2.notices));

	const status = await statusViaBus(pi2.events, 500);
	assert.ok(status);
	assert.deepEqual(
		status.providers.map((p) => ({ provider: p.provider, configured: p.configured, connected: p.connected })),
		[
			{ provider: "feishu", configured: true, connected: false },
			{ provider: "telegram", configured: true, connected: false },
		],
	);
});

test("惰性启动：工厂初始化后两个 provider 均未连接（启动零建连）", async () => {
	rmSync(CONFIG_PATH, { force: true });
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(
		CONFIG_PATH,
		JSON.stringify({
			feishu: { appId: "cli_test", appSecret: "secret", inbound: true, defaultReceiver: { type: "chat_id", value: "oc_x" } },
			telegram: { botToken: "123:abc", inbound: true, defaultChatId: "-100" },
		}),
		"utf8",
	);
	const pi = makeFakePi();
	const status = await statusViaBus(pi.events, 500);
	assert.ok(status);
	assert.deepEqual(
		status.providers.map((p) => ({ provider: p.provider, configured: p.configured, connected: p.connected })),
		[
			{ provider: "feishu", configured: true, connected: false },
			{ provider: "telegram", configured: true, connected: false },
		],
	);
});

test("reload 后 stale ctx：迟到的发送结果不会把 pi 打崩（unhandledRejection → uncaughtException）", async () => {
	rmSync(CONFIG_PATH, { force: true }); // 未配置 → dispatchSend 直接 respond(not_configured)，不涉及网络
	const bus = createEventBus();
	const staleEvents: EventsLike = {
		on: (channel, handler) => bus.on(channel, handler),
		// 模拟 reload 之后 pi 的 assertActive：任何 emit 都抛（实测崩溃栈就落在 respond 的 emit 上）
		emit: () => {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		},
	};
	makeFakePi(staleEvents);

	const unhandled: unknown[] = [];
	const onUnhandled = (err: unknown) => unhandled.push(err);
	process.on("unhandledRejection", onUnhandled);
	try {
		assert.doesNotThrow(() =>
			bus.emit(CHANNEL_SEND, { requestId: "stale", provider: "feishu", kind: "text", text: "hi" }),
		);
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(unhandled, [], "不应产生 unhandledRejection（以前会让 pi 以 uncaughtException 退出）");
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("/channel 命令：status 输出状态行，send 提示用户，reload 重载配置", async () => {
	rmSync(CONFIG_PATH, { force: true });
	const pi = makeFakePi();
	const command = pi.commands.get("channel");
	assert.ok(command, "应注册 /channel 命令");

	await command.handler("status", uiCtx(pi.notices));
	assert.match(pi.notices.at(-1)?.msg ?? "", /^pi-channel \| 飞书: 未配置 \| Telegram: 未配置/);

	await command.handler("send", uiCtx(pi.notices));
	assert.equal(pi.notices.at(-1)?.level, "warning");
	assert.match(pi.notices.at(-1)?.msg ?? "", /用法/);

	await command.handler("send 测试文本", uiCtx(pi.notices));
	assert.equal(pi.notices.at(-1)?.level, "warning");
	assert.match(pi.notices.at(-1)?.msg ?? "", /未配置任何 provider/);

	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify({ feishu: { appId: "cli_x", appSecret: "s", inbound: false } }), "utf8");
	await command.handler("reload", uiCtx(pi.notices));
	assert.match(pi.notices.at(-1)?.msg ?? "", /飞书: 出站模式/);
});

test.after(() => {
	clearInterval(keepAlive);
	rmSync(AGENT_DIR, { recursive: true, force: true });
});
