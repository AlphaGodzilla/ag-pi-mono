/**
 * pi-docs-gate 扩展
 *
 * 背景: pi 内置默认系统提示词硬编码了一段 "Pi documentation" 指引
 * (README / docs/ / examples/ 路径及按主题查阅文档的规则), 约 600 tokens,
 * 对所有工作目录无差别注入。正常编码时用不到, 属于浪费。
 *
 * 本扩展只做一件事: 系统提示词替换
 *   - 统一从系统提示词中移除内置 "Pi documentation" 段落;
 *   - 仅当 cwd 为 ~/.pi/agent(或其子目录)时, 追加一行轻量提示,
 *     引导模型按需读取 pi-docs skill; 其他目录完全无痕。
 *
 * skill 中的文档路径不做任何运行时改写: pi-docs skill 内部采用
 * 启发式语句(如"运行 npm root -g 自行定位"), agent 每次使用时自行发现
 * 路径, 天然适配任意主机。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { homedir } from "node:os";

/** 需要 pi 文档指引的工作目录(pi 配置目录): 环境变量 PI_CODING_AGENT_DIR 优先, 默认 ~/.pi/agent */
const PI_DOCS_CWD = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

/**
 * 内置 Pi documentation 段落(含前导空行)。
 * 段落以固定文案开头、以 "TUI API details)" 结尾, 删除操作幂等。
 */
const PI_DOCS_SECTION_RE = /\n\nPi documentation \(read only[\s\S]*?TUI API details\)/;

export default function init(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		const prompt = event.systemPrompt;
		if (!prompt) return;

		let next = prompt.replace(PI_DOCS_SECTION_RE, "");
		const cwd = event.systemPromptOptions?.cwd;

		// 在 ~/.pi/agent 目录下工作时, 引导按需加载 pi-docs skill
		if (cwd === PI_DOCS_CWD || cwd?.startsWith(PI_DOCS_CWD + "/")) {
			next += [
				"",
				"当前工作目录为 ~/.pi/agent(pi 配置目录)。",
				"如需 pi 自身文档(README / docs/ / examples/, 以及 extensions.md、skills.md、",
				"prompt-templates.md、tui.md、keybindings.md、sdk.md 等),",
				"请读取 pi-docs skill 获取完整访问指引。",
			].join("\n");
		}

		if (next !== prompt) {
			return { systemPrompt: next };
		}
	});
}
