/**
 * pi-docs-gate 扩展
 *
 * 目标: 把内置 "Pi documentation" 段落(约 600 tokens, 对所有工作目录无差别注入)换成**一行按需指针**
 * —— 告诉模型 pi 自身文档可以按需读 pi-docs skill, 不再常驻整段路径与查阅规则。
 *
 * 为什么任意目录都这么做: pi 文档指引是"需要时才用"的能力(progressive disclosure),
 * 常驻整段只在真的查阅 pi 自身时才划算。换成指针后任何工作目录都不再常驻, 需要时模型仍可加载。
 *
 * 设计约束: **不把 pi 的提示词文案抄进本插件**。段内容按结构定位(pi 把每个 section 包成同名标签),
 * 不匹配段落里的任何句子; 替换文本是我们自己写的一句。
 *
 * 两条路径(为什么必须两条见 README「注意事项」):
 *   - transcript / 段机制: sections.docs := 我们的指针文本;
 *   - 线上请求文本: 在 `forceSystemPrompt ?? event.systemPrompt` 上把 <docs>…</docs> 整段换成
 *     同样的文本并 return。
 *
 * 漂移检测: pi 若给 section 改名, 两条路径都会"匹配不到却静默通过"。这里用结构化信号判断
 * (非 customPrompt 模式下 pi 一定会写 docs 段), 命中即告警。
 *
 * 只改 pi 写出来的段, 不凭空添加: SYSTEM.md / --system-prompt(customPrompt)模式下 pi 本就不写
 * docs 段, 本插件也不注入, 免得往用户自定义的提示词里塞内容。
 *
 * skill 中的文档路径不做任何运行时改写: pi-docs skill 内部采用启发式语句
 * (如"运行 npm root -g 自行定位"), agent 每次使用时自行发现路径, 天然适配任意主机。
 */
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * pi 配置目录: 直接问 pi 自己(getAgentDir()), 不自己拼 `PI_CODING_AGENT_DIR ?? ~/.pi/agent`。
 * 这样天然支持任意目录 —— 环境变量给出的 `~/xxx`、相对路径都会被 pi 正确展开; 而且是**实时解析**,
 * 不是启动时的快照。另做一次规范化(绝对化 + 存在时取 realpath), 避免 /tmp 与 /private/tmp 这类
 * 同一目录的不同写法导致比较失败。当前只用于日志路径。
 */
export function agentDir(): string {
	return canonical(getAgentDir());
}

function canonical(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}

/** section 名: pi 的 SystemPromptSections 契约(结构, 不是文案) */
const DOCS_SECTION_TAG = "docs";
const DOCS_SECTION_RE = /<docs>([\s\S]*?)<\/docs>/;

/** 替换内置 docs 段的按需指针(我们自己的措辞) */
function docsHint(): string {
	return [
		"如需 pi 自身文档(README / docs / examples, 以及 extensions.md、skills.md、",
		"prompt-templates.md、tui.md、keybindings.md、sdk.md 等), 请读取 pi-docs skill 获取完整访问指引。",
	].join("\n");
}

function logPath(): string {
	return join(agentDir(), "extensions", "pi-docs-gate", "error.log");
}

/**
 * 在提示词文本上把内置 docs 段换成按需指针(幂等):
 *   - 有 <docs>…</docs> 段 → 整段换成指针文本;
 *   - 没有该段(SYSTEM.md / --system-prompt 的 customPrompt 模式)→ 原样返回, 不凭空注入。
 */
export function applyDocsGate(prompt: string): string {
	const match = DOCS_SECTION_RE.exec(prompt);
	if (!match) return prompt;
	const content = docsHint();
	return `${prompt.slice(0, match.index)}<${DOCS_SECTION_TAG}>\n${content}\n</${DOCS_SECTION_TAG}>${prompt.slice(match.index + match[0].length)}`;
}

/**
 * 结构化漂移判据(不比对任何文案): 非 customPrompt 模式下 pi 一定会写 <docs> 段,
 * 提示词里却没有 → 段名/结构变了(或本插件已不可能生效)。
 */
export function findDocsSectionDrift(prompt: string, customPrompt: string | undefined): string | undefined {
	if (customPrompt) return undefined;
	if (!prompt.includes(`<${DOCS_SECTION_TAG}>`)) {
		return `未找到 <${DOCS_SECTION_TAG}> 段`;
	}
	return undefined;
}

let driftWarned = false;

/** 漂移告警: TUI/RPC 弹一条通知, 同时落一行日志(仓库约定: 运行数据放 extensions/<包名>/) */
export function warnDrift(ctx: ExtensionContext, reason: string): void {
	if (driftWarned) return;
	driftWarned = true;
	const message = `[pi-docs-gate] docs 段与 pi 的结构不再匹配(${reason}), 按需化可能未生效; 请核对 pi 版本与 extensions/index.ts 的匹配规则`;
	try {
		if (ctx.hasUI) ctx.ui.notify(message, "warning");
	} catch {
		// 通知失败不影响运行
	}
	try {
		const path = logPath();
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${new Date().toISOString()} ${message}\n`);
	} catch {
		// 日志失败不影响运行
	}
}

export default function init(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		const options = event.systemPromptOptions;
		if (!options) return;

		// 起点: 此前扩展(如 pi-permission-system)已产出的提示词, 否则 pi 的当前渲染
		const current = options.forceSystemPrompt ?? event.systemPrompt;

		// 路径 1: transcript / 段机制(pi 只支持覆盖同名段, 不能删除)
		if (!options.customPrompt) options.sections.docs = docsHint();

		// 路径 2: 线上请求文本 —— 在此前扩展产出的文本上继续替换
		const next = applyDocsGate(current);
		if (next !== current) return { systemPrompt: next };

		const drift = findDocsSectionDrift(current, options.customPrompt);
		if (drift) warnDrift(ctx, drift);
	});
}
