/**
 * context-watchdog 扩展
 *
 * 背景: pi 本体的自动压缩检查只在 agent run 结束后(或提交新 prompt 前)进行。
 * 当最后一次任务还在进行中(工具调用循环未结束)时, 即使上下文已超过
 * `contextWindow - reserveTokens`, 也不会触发压缩, 上下文会继续膨胀。
 *
 * 本扩展在每轮 turn 结束时监控实时上下文消耗:
 *   - 满足 `contextTokens > contextWindow - reserveTokens` 时视为到达触发时机
 *   - 若此时 LLM 仍在运行(本轮 turn 结束、但 agent run 未结束),
 *     则代替用户向 LLM 注入一条"收尾"消息, 提示尽快完成手头工作
 *   - 每个 agent run 只注入一次, 不重复打扰
 *
 * 压缩完成后(仅 threshold 自动压缩): 在 agent_settled 时自动向 LLM 发送"继续"
 * 消息, 让 LLM 基于压缩摘要继续之前未完成的工作(overflow 压缩 pi 会自动重试,
 * manual 压缩是用户主动操作, 均不自动继续)。
 *
 * 压缩本身仍由 pi 本体在 run 结束后自动执行(阈值检查), 本扩展只负责提前告知 LLM。
 *
 * pi-goal 协同: 目标模式(goal active)下 pi-goal 自带压缩后的继续机制
 * (agent_settled → dispatchContinuationIfSettled)。若本扩展此时再发"继续"消息,
 * 会与 pi-goal 的 fire-and-forget 继续调用竞争, 同时通过 isStreaming===false 检查
 * 导致双开 run, 触发 "Agent is already processing a prompt" 错误。
 * 故目标模式下本扩展不注入继续消息, 只保留非目标模式的自动继续行为。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_RESERVE_TOKENS = 16384;

	/**
	 * 解析 pi 全局配置目录(与 pi 本体 getAgentDir() 一致):
	 * 优先环境变量 PI_CODING_AGENT_DIR, 缺省 ~/.pi/agent。
	 */
	function resolveAgentDir(): string {
		const envDir = process.env.PI_CODING_AGENT_DIR;
		return envDir ? envDir : join(homedir(), ".pi", "agent");
	}

	/** 从单个 settings.json 读取合法的 compaction.reserveTokens, 无/非法返回 undefined */
	function readReserveTokensFromFile(file: string): number | undefined {
		try {
			if (!existsSync(file)) return undefined;
			const raw = JSON.parse(readFileSync(file, "utf8")) as {
				compaction?: { reserveTokens?: unknown };
			};
			const rt = raw?.compaction?.reserveTokens;
			return typeof rt === "number" && Number.isFinite(rt) && rt > 0 ? rt : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * 触发阈值 reserveTokens:
	 * 项目 .pi/settings.json 优先, 回退全局 ~/.pi/agent/settings.json, 缺省 16384。
	 * 与 pi 本体 SettingsManager(全局+项目 deepMerge, 项目覆盖全局)的取值一致。
	 * 缓存键为 cwd+两文件 mtime, 配置改动后自动重读, 不同项目互不串值。
	 */
	const reserveTokensCache = new Map<string, { value: number }>();
	function getReserveTokens(cwd: string): number {
		const projectFile = join(cwd, ".pi", "settings.json");
		const globalFile = join(resolveAgentDir(), "settings.json");
		const mtimeKey = [projectFile, globalFile]
			.map((f) => {
				try { return statSync(f).mtimeMs; } catch { return 0; }
			})
			.join(":");
		// 键里带 cwd: 不同项目文件 mtime 可能相同(快速创建), 避免串值
		const cacheKey = `${cwd}|${mtimeKey}`;
		const cached = reserveTokensCache.get(cacheKey);
		if (cached) return cached.value;
		const project = readReserveTokensFromFile(projectFile);
		const value = project ?? readReserveTokensFromFile(globalFile) ?? DEFAULT_RESERVE_TOKENS;
		reserveTokensCache.set(cacheKey, { value });
		return value;
	}

/** 注入给 LLM 的收尾消息(以 user 角色进入上下文) */
const WRAPUP_MESSAGE = [
	"（系统提示）当前会话上下文已接近上限, 随后将自动压缩。",
	"请立即收尾当前工作:",
	"1. 完成手头正在进行的修改或工具调用, 不要开启新任务;",
	"2. 简述当前进度与关键结论, 便于压缩后继续;",
	"3. 尽快给出最终答复。",
].join("\n");

/** 压缩完成后注入给 LLM 的继续消息(以 user 角色进入上下文, 触发新 run) */
const CONTINUE_MESSAGE = [
	"（系统提示）上下文压缩已完成。",
	"请阅读压缩摘要中保留的进度, 继续完成之前未完成的工作, 直至达成目标。",
].join("\n");

// ---- pi-goal 目标模式检测 ----
// pi-goal 在会话中写入两类标记(不参与 LLM 上下文, 仅用于状态持久化):
//   - custom_message 条目, customType = "goal-contract", details.state 为 "active"|"inactive";
//   - custom 条目, customType = "goal-state", data.goal.status 反映当前目标状态。
// getBranch() 返回原始分支全量条目(不受压缩裁剪影响), 两类标记始终可见。
const GOAL_CONTRACT_TYPE = "goal-contract";
const GOAL_STATE_TYPE = "goal-state";

/**
 * 判断当前会话是否处于 pi-goal 的目标模式(goal active)。
 * goal-contract 是权威信号, 以最新一条为准; 无 contract 时退回 goal-state。
 */
function isGoalModeActive(ctx: {
	sessionManager: { getBranch?: () => unknown[]; getEntries?: () => unknown[] };
}): boolean {
	const sm = ctx.sessionManager;
	const entries = sm.getBranch?.() ?? sm.getEntries?.() ?? [];
	let contractState: string | undefined;
	let contractIndex = -1;
	let goalStatus: string | undefined;
	let goalIndex = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as
			| { type?: string; customType?: string; details?: unknown; data?: unknown; message?: unknown }
			| undefined;
		if (!entry || typeof entry !== "object") continue;
		if (entry.type === "custom_message" && entry.customType === GOAL_CONTRACT_TYPE) {
			if (contractIndex === -1) {
				contractIndex = i;
				const state = (entry.details as { state?: unknown } | undefined)?.state;
				if (typeof state === "string") contractState = state;
			}
		} else if (entry.type === "message") {
			const msg = entry.message as { customType?: unknown; details?: unknown } | undefined;
			if (msg?.customType === GOAL_CONTRACT_TYPE && contractIndex === -1) {
				contractIndex = i;
				const state = (msg.details as { state?: unknown } | undefined)?.state;
				if (typeof state === "string") contractState = state;
			}
		} else if (entry.type === "custom" && entry.customType === GOAL_STATE_TYPE) {
			if (goalIndex === -1) {
				goalIndex = i;
				const data = entry.data as { goal?: { status?: unknown } | null } | undefined;
				if (typeof data?.goal?.status === "string") goalStatus = data.goal.status;
			}
		}
	}
	if (contractIndex === -1 && goalIndex === -1) return false;
	// 两个信号都出现时, 以时间上更新的一条为准(goal-state 与 contract 在状态迁移时成对写入)
	if (goalIndex > contractIndex) return goalStatus === "active";
	return contractState === "active";
}

/**
 * 模块级状态: 跨扩展实例共享, 按会话(sessionId)隔离。
 * - pi 的 /reload 可能重复执行工厂函数, 若用闭包变量, 每个 handler 各持一个标志, 一次 run 内可能重复发送;
 * - 若用单一全局标志, 多会话并发(RPC 等)时会交叉干扰。
 * 双重职责(两个标志永远同值, 故合一):
 * 1. 防重复: turn_end 检查"本 run 已注入过收尾"则跳过;
 * 2. 标记: session_compact 检查"本 run 是否注入过收尾", 决定压缩后是否自动继续。
 * agent_start 重置, 保证每个 run 独立计数。
 */
const notifiedBySession = new Map<string, boolean>();

/**
 * 模块级状态: 标记"刚发生 threshold 自动压缩, 待 agent_settled 时通知 LLM 继续"。
 * 同样按会话隔离。压缩在 run 结束后发生, agent_settled 时 run 已完全结束,
 * 此时发送继续消息会直接启动新 run, 无队列竞态。
 */
const pendingContinueBySession = new Map<string, boolean>();

export default function contextWatchdog(pi: ExtensionAPI): void {

	pi.on("agent_start", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		notifiedBySession.set(sessionId, false);
	});

	pi.on("turn_end", async (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (notifiedBySession.get(sessionId)) return;
		// 本轮响应失败(如上下文溢出)或已取消时, 交由 pi 的 overflow recovery / 用户处理
		if (_event.message.role === "assistant" && (_event.message.stopReason === "error" || _event.message.stopReason === "aborted")) return;
		// 本轮无工具调用 = LLM 已给出最终答复(run 即将自然结束), 不打扰; 只有仍在干活才提示收尾
		if (_event.message.role === "assistant" && _event.message.content.some((c) => c.type === "toolCall")) {
			// LLM 已结束(agent_end 已发出)时无需提示, 压缩由 pi 本体负责
			if (ctx.isIdle()) return;

			const usage = ctx.getContextUsage();
			if (!usage || usage.tokens === null) return;
			// 触发时机: contextTokens > contextWindow - reserveTokens
			if (usage.tokens <= usage.contextWindow - getReserveTokens(ctx.cwd)) return;

			notifiedBySession.set(sessionId, true);
			// steer: 消息会在下一轮 assistant 响应前注入, LLM 立即看到并收尾
			await pi.sendUserMessage(WRAPUP_MESSAGE, { deliverAs: "steer" });
			ctx.ui.notify(
				`上下文已达 ${Math.round(usage.percent ?? 0)}% (${usage.tokens} tokens), 已提示 LLM 收尾`,
				"info",
			);
		}
	});

	// ---- 压缩完成后自动通知 LLM 继续 ----
	pi.on("session_compact", (_event, ctx) => {
		// 仅"注入过收尾消息的 run"的 threshold 自动压缩才继续:
		// overflow 时 pi 会自动 compact-and-retry 继续, manual 是用户主动操作;
		// 未注入收尾的 run 是自然结束(任务已完成), 压缩后不自动继续
	if (_event.reason === "threshold" && !_event.willRetry && notifiedBySession.get(ctx.sessionManager.getSessionId())) {
		// pi-goal 目标模式下由其自身在 agent_settled 继续, 本扩展不注入继续消息, 避免双开 run 竞态
		if (isGoalModeActive(ctx)) return;
		pendingContinueBySession.set(ctx.sessionManager.getSessionId(), true);
	}
	});

	pi.on("agent_settled", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
	if (!pendingContinueBySession.get(sessionId)) return;
	pendingContinueBySession.set(sessionId, false); // 消费标志, 只触发一次
	// 防御: 压缩后到 settled 之间目标模式被激活时同样不注入(pi-goal 自行继续)
	if (isGoalModeActive(ctx)) return;
	// run 已完全结束(isStreaming=false): 发送消息会直接启动新 run, LLM 基于摘要继续工作
	void pi.sendUserMessage(CONTINUE_MESSAGE, { deliverAs: "followUp" });
	});
}
