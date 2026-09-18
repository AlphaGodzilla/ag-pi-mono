/**
 * pi-channel —— 外部通信 channel 插件（飞书 / Telegram）。
 *
 * 职责：独占 provider 凭据与连接生命周期，向其它扩展（以及跨仓库的 rpiv-ask-user-question）
 * 提供 `ag-pi-channel:*` 事件契约，消费方无需关心 provider 内部实现。
 *
 * - 出站：订阅 `ag-pi-channel:send`，按 provider 分发；结果回 `ag-pi-channel:send:result`
 * - 入站：长连接/长轮询收到消息与按钮点击后发 `ag-pi-channel:inbound`
 * - 状态：订阅 `ag-pi-channel:status`，回 `ag-pi-channel:status:result`
 * - 就绪：订阅 `ag-pi-channel:connect`，把该 provider 的入站通道建好再回 `ag-pi-channel:connect:result`
 * - 释放：订阅 `ag-pi-channel:release`，清掉入站持有；无人持有时断开该 provider 的入站连接
 * - 命令：`/channel`（status / reload / send <text>）
 *
 * 配置与运行数据都在 `~/.pi/agent/extensions/pi-channel/`（config.json / error.log），
 * 见仓库根 AGENTS.md「配置与运行数据一律放 extensions 目录」。
 *
 * 所有发送与连接错误都收敛成 result / 日志，绝不抛给 pi 主流程。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	isFeishuConfigured,
	isTelegramConfigured,
	loadChannelConfig,
	resolveConfigPath,
	type ChannelConfig,
} from "./lib/config.ts";
import {
	CHANNEL_CONNECT,
	CHANNEL_CONNECT_RESULT,
	CHANNEL_RELEASE,
	CHANNEL_RELEASE_RESULT,
	CHANNEL_INBOUND,
	CHANNEL_SEND,
	CHANNEL_SEND_RESULT,
	CHANNEL_STATUS,
	CHANNEL_STATUS_RESULT,
	type ChannelConnectRequest,
	type ChannelConnectResult,
	type ChannelReleaseRequest,
	type ChannelReleaseResult,
	type ChannelInboundEvent,
	type ChannelProvider,
	type ChannelProviderStatus,
	type ChannelSendRequest,
	type ChannelSendResult,
} from "./lib/events.ts";
import { createFeishuProvider, classifyFeishuError, type FeishuProvider } from "./lib/feishu.ts";
import { createTelegramProvider, classifyTelegramError, type TelegramProvider } from "./lib/telegram.ts";
import { logError, setDebugEnabled } from "./lib/log.ts";

/** 命令与状态提示里用的短标签 */
const PROVIDER_LABELS: Record<ChannelProvider, string> = { feishu: "飞书", telegram: "Telegram" };

type UiCtx = { hasUI?: boolean; ui: { notify(msg: string, level: "info" | "warning"): void } };

export default function piChannel(pi: ExtensionAPI): void {
	let cfg: ChannelConfig = loadChannelConfig();
	// 诊断开关（顶层 `debug`）：开则写 debug.log（SDK 日志 + 时序），默认关、TUI 零输出。
	setDebugEnabled(cfg.debug);
	/** reload/quit 之后本实例作废：其捕获的 `pi` 变成 stale，任何 emit 都会抛错并让 pi 退出 */
	let retired = false;
	const feishu: FeishuProvider = createFeishuProvider();
	const telegram: TelegramProvider = createTelegramProvider();
	/** 最近一次连接/发送失败原因，供 /channel status 展示 */
	const lastErrors = new Map<ChannelProvider, string>();

	/**
	 * 向用户输出。命令的 ctx 在 `/reload` 之后同样会被 pi 判定 stale（它只保证 reload 前的命令 ctx 有效），
	 * 而这里的调用点可能在命令的**异步续体**里（等发送结果之后）——因此先判 `retired`，再 try/catch 吞错，
	 * 否则 notify 抛错会变成 unhandledRejection → pi uncaughtException 退出（与 `respond` 的 stale 崩溃同类）。
	 */
	const report = (ctx: UiCtx, msg: string, level: "info" | "warning" = "info"): void => {
		if (retired) return;
		try {
			if (ctx.hasUI) ctx.ui.notify(msg, level);
			else console.log(msg);
		} catch (err) {
			logError(`notify failed (stale command ctx after reload?): ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	function noteError(provider: ChannelProvider, err: unknown): string {
		const { code, message } = provider === "feishu" ? classifyFeishuError(err) : classifyTelegramError(err);
		const text = `${code}: ${message}`;
		lastErrors.set(provider, text);
		logError(`[${provider}] ${text}`);
		return text;
	}

	async function dispatchSend(req: ChannelSendRequest): Promise<ChannelSendResult> {
		// 先取出 requestId：下面的 provider 收窄会让「未知 provider」分支变成 never
		const requestId = req.requestId;
		const respond = (result: ChannelSendResult): ChannelSendResult => {
			safeEmit(CHANNEL_SEND_RESULT, result);
			return result;
		};
		try {
			if (req.provider === "feishu") {
				if (!isFeishuConfigured(cfg)) {
					return respond({
						requestId: req.requestId,
						ok: false,
						error: { code: "not_configured", message: `feishu not configured in ${resolveConfigPath()}` },
					});
				}
				const { messageId } = await feishu.send(req, cfg.feishu);
				// 刻意**不**在这里唤醒入站：自动 kick 会让任何用过飞书的进程常驻一条长连接，而飞书对同一 app 的多连接
				// 是选一条投递——多进程下回调会被投到没有待答问卷的实例上（见 inboundHolds 的注释）。
				// 需要入站（收回复 / 按钮点击）的消费方用 `ag-pi-channel:connect` 显式要，用完 `release`。
				lastErrors.delete("feishu");
				return respond({ requestId: req.requestId, ok: true, messageId });
			}
			if (req.provider === "telegram") {
				if (!isTelegramConfigured(cfg)) {
					return respond({
						requestId: req.requestId,
						ok: false,
						error: { code: "not_configured", message: `telegram not configured in ${resolveConfigPath()}` },
					});
				}
				const { messageId } = await telegram.send(req, cfg.telegram);
				// 同上：不在发送后自动 kick 入站。
				lastErrors.delete("telegram");
				return respond({ requestId: req.requestId, ok: true, messageId });
			}
			return respond({
				requestId,
				ok: false,
				error: { code: "unknown_provider", message: `unsupported provider: ${String((req as { provider?: unknown }).provider)}` },
			});
		} catch (err) {
			return respond({ requestId: req.requestId, ok: false, error: { code: "send_failed", message: noteError(req.provider, err) } });
		}
	}

	/**
	 * 安全 emit：实例作废（reload/quit）后静默丢弃；即使 pi 判定 ctx stale 抛错也必须吞掉。
	 * 这些调用点全在**异步续体**里（发送完成/失败、长连接收到事件之后），抛出去就是
	 * unhandledRejection → pi 以 uncaughtException 直接退出（实测崩溃栈就落在这一行）。
	 */
	function safeEmit(channel: string, data: unknown): void {
		if (retired) return;
		try {
			pi.events.emit(channel, data);
		} catch (err) {
			logError(`emit ${channel} failed (stale ctx after reload?): ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	const emitInbound = (evt: ChannelInboundEvent): void => {
		safeEmit(CHANNEL_INBOUND, evt);
	};

	async function connectAll(): Promise<void> {
		if (retired) return; // 作废实例不再重建连接（例如 reload 期间还在跑的 /channel reload）
		if (isFeishuConfigured(cfg)) {
			try {
				await feishu.connect(cfg.feishu, emitInbound);
				lastErrors.delete("feishu");
			} catch (err) {
				noteError("feishu", err);
			}
		}
		if (isTelegramConfigured(cfg)) {
			try {
				await telegram.connect(cfg.telegram, emitInbound);
				lastErrors.delete("telegram");
			} catch (err) {
				noteError("telegram", err);
			}
		}
	}

	/**
	 * 入站**持有**状态：只有消费方显式 `connect` 过（且还没 `release`）的 provider 才允许持有入站连接。
	 * 为什么这么严：飞书对同一个 app 的多条长连接是**选一条投递**，而插件是全局扩展——每个 pi 进程都会加载。
	 * 若「发送成功就自动 kick 入站」（拆分初期的做法），任何用过飞书的进程都会常驻一条长连接，于是回调会被投递到
	 * 没有待答问卷的进程上：那边照样回 ack（toast），点击却被静默吞掉（实测：4 个 pi 进程时第 2 题要点 4 次以上）。
	 * 现在只有「正在等回复」的进程持有连接，`release` 后立刻回到不连接状态（≈ 拆分前 connect→用完 close 的语义）。
	 */
	const inboundHolds = new Map<ChannelProvider, number>();

	/**
	 * 消费方在需要收回复/点击前请求入站就绪（长连接建好再回 `ok`），把「消息已送达、长连接还没握完手」的窗口消掉。
	 * 成功即记一次持有（计数），失败以带 code 的错误拒绝：`not_configured` / `outbound_only` / `retired`。
	 */
	async function ensureInboundReady(provider: ChannelProvider): Promise<void> {
		if (retired) throw connectError("retired", "pi-channel instance retired (extension reloaded)");
		if (provider === "feishu") {
			if (!isFeishuConfigured(cfg)) throw connectError("not_configured", "feishu not configured");
			if (cfg.feishu.inbound === false) throw connectError("outbound_only", "feishu inbound disabled (inbound: false)");
			await feishu.connect(cfg.feishu, emitInbound);
		} else {
			if (!isTelegramConfigured(cfg)) throw connectError("not_configured", "telegram not configured");
			if (cfg.telegram.inbound === false) throw connectError("outbound_only", "telegram inbound disabled (inbound: false)");
			await telegram.connect(cfg.telegram, emitInbound);
		}
		inboundHolds.set(provider, (inboundHolds.get(provider) ?? 0) + 1);
	}

	/**
	 * 消费方用完入站：释放一次持有；计数归零才真正关闭该 provider 的入站连接（幂等，没连接时直接返回）。
	 * 关闭走 provider 自己的 `close()`（飞书会先等 400ms 冲刷末条 ack 再断连）。
	 */
	async function releaseInbound(provider: ChannelProvider): Promise<void> {
		const remaining = Math.max(0, (inboundHolds.get(provider) ?? 0) - 1);
		if (remaining === 0) inboundHolds.delete(provider);
		else inboundHolds.set(provider, remaining);
		if (remaining > 0) return;
		await (provider === "feishu" ? feishu.close() : telegram.close());
	}

	/** 带 `code` 的错误：消费方与 `classify*Error` 都靠这个字段分类，不靠 message 文本。 */
	function connectError(code: string, message: string): Error {
		return Object.assign(new Error(message), { code });
	}

	/** 入站就绪请求：任何失败都收敛成 `ok:false` + code，绝不外抛。 */
	async function dispatchConnect(req: ChannelConnectRequest): Promise<void> {
		try {
			await ensureInboundReady(req.provider);
			safeEmit(CHANNEL_CONNECT_RESULT, {
				requestId: req.requestId,
				ok: true,
				connected: true,
			} satisfies ChannelConnectResult);
		} catch (err) {
			const { code, message } =
				req.provider === "feishu" ? classifyFeishuError(err) : classifyTelegramError(err);
			safeEmit(CHANNEL_CONNECT_RESULT, {
				requestId: req.requestId,
				ok: false,
				connected: false,
				error: { code, message },
			} satisfies ChannelConnectResult);
		}
	}

	/**
	 * 入站释放请求：`ok:true` 表示释放已受理，`connected` 是释放后该 provider 的实际连接状态
	 * （还有别的持有者时为 true）。任何异常同样只回 `ok:false`，绝不外抛。
	 */
	async function dispatchRelease(req: ChannelReleaseRequest): Promise<void> {
		const connectedNow = () => (req.provider === "feishu" ? feishu.status().connected : telegram.status().connected);
		try {
			await releaseInbound(req.provider);
			safeEmit(CHANNEL_RELEASE_RESULT, {
				requestId: req.requestId,
				ok: true,
				connected: connectedNow(),
			} satisfies ChannelReleaseResult);
		} catch (err) {
			const { code, message } =
				req.provider === "feishu" ? classifyFeishuError(err) : classifyTelegramError(err);
			safeEmit(CHANNEL_RELEASE_RESULT, {
				requestId: req.requestId,
				ok: false,
				connected: connectedNow(),
				error: { code, message },
			} satisfies ChannelReleaseResult);
		}
	}

	async function closeAll(): Promise<void> {
		await Promise.allSettled([feishu.close(), telegram.close()]);
	}

	function providerStatuses(): ChannelProviderStatus[] {
		const feishuStatus = feishu.status();
		const telegramStatus = telegram.status();
		return [
			{
				provider: "feishu",
				configured: isFeishuConfigured(cfg),
				connected: feishuStatus.connected,
				accountMasked: feishuStatus.accountMasked,
				error: lastErrors.get("feishu"),
			},
			{
				provider: "telegram",
				configured: isTelegramConfigured(cfg),
				connected: telegramStatus.connected,
				accountMasked: telegramStatus.accountMasked,
				error: lastErrors.get("telegram"),
			},
		];
	}

	function statusLine(): string {
		const parts = providerStatuses().map((s) => {
			const label = PROVIDER_LABELS[s.provider];
			if (!s.configured) return `${label}: 未配置`;
			const state = s.connected ? "已连接" : "出站模式";
			const account = s.accountMasked ? ` ${s.accountMasked}` : "";
			return `${label}: ${state}${account}`;
		});
		const debug = cfg.debug ? " | 诊断 debug.log 已开启" : "";
		return `pi-channel | ${parts.join(" | ")} | 配置 ${resolveConfigPath()}${debug}`;
	}

	// ---- 事件契约 ----
	pi.events.on(CHANNEL_SEND, (data) => {
		// fire-and-forget 也要兜住：dispatchSend 内部已不外抛（safeEmit 吞异常），这里是最后一道保险
		void dispatchSend(data as ChannelSendRequest).catch((err) =>
			logError(`dispatchSend failed: ${err instanceof Error ? err.message : String(err)}`),
		);
	});

	pi.events.on(CHANNEL_STATUS, (data) => {
		const requestId = (data as { requestId?: unknown })?.requestId;
		if (typeof requestId !== "string") return;
		safeEmit(CHANNEL_STATUS_RESULT, { requestId, configPath: resolveConfigPath(), providers: providerStatuses() });
	});

	pi.events.on(CHANNEL_CONNECT, (data) => {
		const req = data as Partial<ChannelConnectRequest> | undefined;
		if (typeof req?.requestId !== "string") return;
		if (req.provider !== "feishu" && req.provider !== "telegram") return;
		// fire-and-forget：dispatchConnect 内部已把失败收敛成 result，不外抛
		void dispatchConnect(req as ChannelConnectRequest).catch((err) =>
			logError(`dispatchConnect failed: ${err instanceof Error ? err.message : String(err)}`),
		);
	});

	pi.events.on(CHANNEL_RELEASE, (data) => {
		const req = data as Partial<ChannelReleaseRequest> | undefined;
		if (typeof req?.requestId !== "string") return;
		if (req.provider !== "feishu" && req.provider !== "telegram") return;
		void dispatchRelease(req as ChannelReleaseRequest).catch((err) =>
			logError(`dispatchRelease failed: ${err instanceof Error ? err.message : String(err)}`),
		);
	});

	// ---- 连接生命周期 ----
	// 刻意**不注册** `session_start` 连接钩子：连 provider 的时间点由消费方的 `ag-pi-channel:connect` 请求决定，
	// 避免启动即向飞书/Telegram 建连（`/channel reload` 命令是显式重连路径）。
	// 注：pi 的 /reload 会逐个 await session_start handler，所以真要做连接也该是 fire-and-forget。

	pi.on("session_shutdown", async (event) => {
		// new/resume/fork 不拆连接：同一进程内后续会话还要用。
		// reload 会替换扩展模块实例，旧实例的连接必须关掉——否则 Telegram 出现两个 poller 抢同一
		// token（实测 409 冲突、新实例入站失效），飞书也会多留一条长连接。
		// reload 路径刻意**不 await**：关连接有 ~0.4-1s 收尾（飞书 ack 冲刷 + tg 宽限），等待会重新
		// 拉长 /reload 的输入区缺失窗口；后台关闭 + 409 退避重试兜底即可。
		const reason = (event as { reason?: unknown } | undefined)?.reason;
		// reload/quit 之后本实例的 `pi` 即作废（再 emit 会抛 stale ctx 错并让 pi 退出）→ 先退休再收尾；
		// new/resume/fork 不退休（同一实例继续服务后续会话）。
		if (reason === "quit" || reason === "reload") {
			retired = true;
		}
		if (reason === "quit") await closeAll();
		else if (reason === "reload") void closeAll();
	});

	// ---- 命令 ----
	pi.registerCommand("channel", {
		description: "外部通信 channel：status（状态）/ reload（重载配置并重连）/ send <text>（测试发送）",
		handler: async (args, ctx) => {
			const [sub, ...rest] = (args ?? "").trim().split(/\s+/);
			if (sub === "reload") {
				cfg = loadChannelConfig();
				setDebugEnabled(cfg.debug); // 诊断开关热生效：改完配置 `/channel reload` 即可
				await closeAll();
				await connectAll();
				report(ctx as UiCtx, statusLine());
				return;
			}
			if (sub === "send") {
				const text = rest.join(" ").trim();
				if (!text) {
					report(ctx as UiCtx, "用法：/channel send <文本>", "warning");
					return;
				}
				const provider: ChannelProvider | undefined = isFeishuConfigured(cfg) ? "feishu" : isTelegramConfigured(cfg) ? "telegram" : undefined;
				if (!provider) {
					report(ctx as UiCtx, `pi-channel 未配置任何 provider（${resolveConfigPath()}）`, "warning");
					return;
				}
				const result = await dispatchSend({
					requestId: globalThis.crypto.randomUUID(),
					provider,
					kind: "text",
					text,
				});
				if (!result.ok) {
					report(ctx as UiCtx, `发送失败：${result.error?.code} ${result.error?.message}`, "warning");
					return;
				}
				// 手动测试命令：发送成功后显式唤醒入站，方便接着测「回复 / 点击」链路。
				// （程序化发送不再自动唤醒 —— 见 dispatchSend 的注释。）
				void ensureInboundReady(provider).catch((err) => noteError(provider, err));
				report(ctx as UiCtx, `已发送（${PROVIDER_LABELS[provider]}，messageId=${result.messageId ?? "-"}）`);
				return;
			}
			// 默认 status
			report(ctx as UiCtx, statusLine());
		},
	});

	if (!isFeishuConfigured(cfg) && !isTelegramConfigured(cfg)) {
		logError(`no provider configured; create ${resolveConfigPath()} (see config.example.json)`);
	}
}
