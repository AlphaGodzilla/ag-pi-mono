/**
 * gen-commit-msg-zh 扩展
 *
 * 由 prompts/gen-commit-msg-zh.md 模板升级而来。命令仍叫 /gen-commit-msg-zh,
 * 支持携带附加提示词运行。
 *
 * 用户故事:
 *  1. /gen-commit-msg-zh [附加提示词] —— 把模板正文 + 附加提示词发给 LLM 并触发一轮,
 *     由 LLM 自行运行 git 只读命令获取上下文, 生成并在对话框展示 commit message,
 *     本轮不做任何 git 写操作。
 *  2. LLM 对话停止后弹三选:
 *     A) 提交  —— 交给 LLM: 无暂存则 git add 后提交, 已有暂存则直接提交
 *     B) 调整消息 —— 输入新的提示词, 重新生成并再次三选
 *     C) 放弃  —— 不做任何提交
 *  3. commit 由 LLM 经 bash 执行, 扩展只负责编排(发 prompt / 交互 / followUp / notify),
 *     不解析消息、不执行 git。
 *
 * 阶段状态机 phase 决定 agent_end 行为:
 *  - "idle":     普通对话, agent_end 不干预
 *  - "generate": 刚发过生成 prompt, agent_end 弹三选
 *  - "commit":   刚发过提交指令, agent_end 只 notify 收尾, 不再弹交互
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));

// 读取模板正文, 读不到时用 fallback(极简, 仅保证可用)
function loadPrompt(): string {
	try {
		const text = fs.readFileSync(path.join(EXTENSION_DIR, "prompt.md"), "utf8").trim();
		if (text) return text;
	} catch {
		/* 用 fallback */
	}
	return "请自行运行 git 只读命令了解改动, 生成一条中文 commit message 并展示, 本轮不要执行任何 git 写命令, 等待用户选择。";
}

const BASE_PROMPT = loadPrompt();

type Phase = "idle" | "generate" | "commit";

interface CommitState {
	phase: Phase;
}

export default function genCommitMsgExtension(pi: ExtensionAPI): void {
	let phase: Phase = "idle";

	function persistState(): void {
		pi.appendEntry<CommitState>("gen-commit-msg-zh", { phase });
	}

	// 组装并发送生成 prompt: 模板正文 + 附加提示词(可空)
	function startGeneration(extra: string): void {
		const trimmed = extra.trim();
		const content = trimmed ? `${BASE_PROMPT}\n\n### 用户附加要求\n\n${trimmed}` : BASE_PROMPT;
		phase = "generate";
		persistState();
		pi.sendMessage(
			{ customType: "gen-commit-msg-generate", display: true, content },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	// ---- /gen-commit-msg-zh 命令 ----
	pi.registerCommand("gen-commit-msg-zh", {
		description: "生成中文 git commit message 并交互提交",
		handler: async (args, ctx) => {
			startGeneration(args);
			ctx.ui.notify("正在生成 commit message…", "info");
		},
	});

	// ---- 一轮结束: 按 phase 决定交互 ----
	pi.on("agent_end", async (_event, ctx) => {
		if (phase === "generate") {
			if (!ctx.hasUI) {
				// 无 UI(print/json)模式: 无法交互, 直接回到 idle, 由用户/LLM 自行处理
				phase = "idle";
				persistState();
				return;
			}
			const choice = await ctx.ui.select("commit message 已生成, 接下来做什么?", [
				"A) 提交",
				"B) 调整消息(输入新的提示词)",
				"C) 放弃",
			]);

			if (choice?.startsWith("A")) {
				phase = "commit";
				persistState();
				ctx.ui.notify("正在执行提交…", "info");
				pi.sendMessage(
					{
						customType: "gen-commit-msg-commit",
						display: true,
						content:
							"用户已选择提交。请先运行 `git status`(或 `git diff --staged --stat`)判断是否已有暂存改动:\n" +
							"- 若**无**已暂存改动: 执行 `git add -A`(若我在上文附加要求中指定了提交范围, 则按该范围 add)后再提交;\n" +
							"- 若**已有**暂存改动: 不要再 add, 直接对已暂存内容提交。\n" +
							"用你上面生成的 commit message 执行 `git commit`; sandbox 环境用多个 `-m`(首个为标题, 其余为正文), 不要加任何广告尾注。",
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			} else if (choice?.startsWith("B")) {
				const extra = await ctx.ui.input("如何调整 commit message?", "例如: 标题改用 fix 类型 / 补充某项说明");
				if (extra && extra.trim()) {
					ctx.ui.notify("按你的调整重新生成…", "info");
					startGeneration(extra);
				} else {
					// 未输入内容: 视为放弃调整, 留在 generate 让下轮再问? 这里回到 idle 更直观
					phase = "idle";
					persistState();
					ctx.ui.notify("未输入调整内容, 已取消。可再次运行 /gen-commit-msg-zh", "info");
				}
			} else {
				// C) 放弃 或 取消(Esc)
				phase = "idle";
				persistState();
				ctx.ui.notify("已放弃, 未做任何提交", "info");
			}
			return;
		}

		if (phase === "commit") {
			// 提交执行轮结束: 不再弹交互, 仅收尾
			phase = "idle";
			persistState();
			if (ctx.hasUI) ctx.ui.notify("提交流程已结束, 请查看上方结果", "info");
			return;
		}

		// phase === "idle": 普通对话轮, 不干预
	});

	// ---- 会话启动/恢复: 还原 phase ----
	pi.on("session_start", async (_event, ctx) => {
		const entry = ctx.sessionManager
			.getEntries()
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "gen-commit-msg-zh")
			.pop() as { data?: CommitState } | undefined;

		if (entry?.data?.phase) phase = entry.data.phase;
	});
}
