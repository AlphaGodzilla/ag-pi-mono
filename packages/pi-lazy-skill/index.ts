/**
 * pi-lazy-skill 扩展
 *
 * 目标: 系统提示词里不再保留 <skills> 段 —— 每个 skill 的 name/description/location
 * 全部移出常驻上下文; 改为注册一个 load_skill 工具, 模型需要时按 skill 名字拿到
 * skill 文件(通常是 SKILL.md)的绝对路径, 再用 read 工具读取内容。这是比
 * pi-skills-gate(只删 description、保留 name/location)更彻底的按需化。
 *
 * 设计约束: **不把 pi 的提示词文案抄进本插件**。只依赖两类东西:
 *   1) 结构契约 —— pi 把 section 包成同名标签(<skills>…</skills>);
 *   2) 结构化数据 —— before_agent_start 的 systemPromptOptions.skills 里每个 Skill 的
 *      name / filePath / disableModelInvocation 字段。
 * 段内文案一律不解析、不复制: 整段直接删除, 路径直接取 Skill.filePath。
 *
 * 两条路径(为什么必须两条见 README「与其它扩展共存」):
 *   - transcript / 段机制: `options.skills = []` 让 pi 不再生成 skills 段(并清掉别的
 *     扩展可能塞回的 sections.skills);
 *   - 线上请求文本: 在 `forceSystemPrompt ?? event.systemPrompt` 上删除 <skills> 段并 return。
 *   `current` 必须在改写 options 之前取, 否则 event.systemPrompt 的 getter 会按已清空的
 *   skills 重新渲染, 既拿不到原始文本、也让漂移检测失真。
 *
 * 漂移检测: pi 若改名 section 标签, 文本删除会"匹配不到却静默通过"。这里只用**结构化信号**
 * 判断(有可见 skill + 有 read/bash 时本应有该段), 命中即告警。
 *
 * 状态隔离: skill 名单存在 **factory 闭包**里, 不放模块作用域。pi 每个 session 创建 runtime 时
 * 都会重新执行一次扩展 factory(dist/core/resource-loader.js → loadExtensionsCached →
 * initializeExtension → factory(api)), 缓存的是模块/factory 本身而不是闭包, 因此每个 session
 * 拿到自己的闭包、自己的 tool 定义、自己的 skill 名单 —— 天然按 session 隔离, 互不覆盖。
 * `/reload` 走同一条路(clearExtensionCache → 重新求值 → factory 再执行), 所以刷新也是天然的:
 * 新闭包为空, 下一轮 before_agent_start 从重载后的 systemPromptOptions.skills 重新写入。
 */
import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** section 名与元素名: pi / Agent Skills 规范的结构契约(不是文案) */
const SKILLS_SECTION_TAG = "skills";
const SKILLS_SECTION_START = `<${SKILLS_SECTION_TAG}>`;
/** 整段 <skills>…</skills>(非贪婪; 段内不会有嵌套的 <skills>) */
const SKILLS_BLOCK_RE = /<skills>[\s\S]*?<\/skills>/g;
/** 删除时用的占位符: 先标记位置, 再把标记与相邻空行归并成 pi 的分段分隔符 */
const STRIP_MARKER = "\u0000";

export type FileReadTool = "read" | "bash";

/** 与 pi 的内置判断一致: read 优先, 其次 bash; 都没有则不展示 skills 段 */
export function pickFileReadTool(selectedTools: readonly string[]): FileReadTool | undefined {
	if (selectedTools.includes("read")) return "read";
	if (selectedTools.includes("bash")) return "bash";
	return undefined;
}

/** pi 实际会写进提示词的那部分 skill: disable-model-invocation 的不在提示词里 */
export function visibleSkills(skills: readonly Skill[]): Skill[] {
	return skills.filter((skill) => !skill.disableModelInvocation);
}

/**
 * 在整条提示词上删除 <skills> 段(幂等; 无该段时原样返回)。
 *
 * pi 用空行("\n\n")拼接各段, 段本身形如 `<skills>\n…\n</skills>`。删除时只吃掉
 * 段与其一侧的空行, 保证相邻两段之间仍恰好留一个分段分隔符, 不会把别人粘在一起。
 */
export function stripSkillsSection(prompt: string): string {
	if (!prompt.includes(SKILLS_SECTION_START)) return prompt;
	const marked = prompt.replace(SKILLS_BLOCK_RE, STRIP_MARKER);
	return marked
		.replace(/\n{2,}\u0000\n{2,}/g, "\n\n") // 两侧都有 → 留一个分隔符
		.replace(/\n{2,}\u0000/g, "") // 段在末尾
		.replace(/\u0000\n{2,}/g, "") // 段在开头
		.replace(/\u0000/g, ""); // 整条只有该段
}

/** 按名字找 skill: 先精确, 再大小写不敏感(用户/模型可能写成 Grilling) */
export function findSkillByName(skills: readonly Skill[], name: string): Skill | undefined {
	const wanted = name.trim();
	if (!wanted) return undefined;
	const lower = wanted.toLowerCase();
	return skills.find((skill) => skill.name === wanted) ?? skills.find((skill) => skill.name.toLowerCase() === lower);
}

/** load_skill 命中: 给出绝对路径 + 引导模型用 read 工具读文件 */
export function formatSkillFound(skill: Skill): string {
	return [
		`Skill "${skill.name}" file: ${skill.filePath}`,
		"Read that file with the read tool to load the skill's instructions, then follow them.",
	].join("\n");
}

/** load_skill 未给名字: 返回可用 skill 名单(只有名字, 不带描述) */
export function formatSkillList(skills: readonly Skill[]): string {
	if (skills.length === 0) return "No skills are available in this session.";
	return [
		`Available skills: ${skills.map((skill) => skill.name).join(", ")}`,
		"Call load_skill with one of these names to get its file path, then read that file with the read tool.",
	].join("\n");
}

/** load_skill 名字对不上: 明确说没有, 并把可用名单一并给出便于重试 */
export function formatSkillMissing(name: string, skills: readonly Skill[]): string {
	const head = `No skill named "${name}" is available.`;
	return skills.length === 0 ? head : [head, formatSkillList(skills)].join("\n");
}

export interface SkillsDriftInput {
	selectedTools: readonly string[];
	skills: readonly { disableModelInvocation?: boolean }[];
}

/**
 * 结构化漂移判据(不比对任何文案): 按 pi 自己的前提推断"本应有 skills 段" —— 有可见
 * skill 且有 read/bash; 若提示词里没有该段, 说明 pi 的结构变了(或标签改名), 返回告警原因。
 */
export function findSkillsDrift(prompt: string, input: SkillsDriftInput): string | undefined {
	const hasVisibleSkill = input.skills.some((skill) => !skill.disableModelInvocation);
	if (!hasVisibleSkill || pickFileReadTool(input.selectedTools) === undefined) return undefined;
	if (!prompt.includes(SKILLS_SECTION_START)) {
		return `未找到 <${SKILLS_SECTION_TAG}> 段`;
	}
	return undefined;
}

/** 日志路径: pi 配置目录由 pi 自己解析(getAgentDir() 尊重 PI_CODING_AGENT_DIR) */
function logPath(): string {
	return join(getAgentDir(), "extensions", "pi-lazy-skill", "error.log");
}

/** 漂移告警: TUI/RPC 弹一条通知, 同时落一行日志(仓库约定: 运行数据放 extensions/<包名>/) */
export function warnDrift(ctx: ExtensionContext, reason: string): void {
	const message = `[pi-lazy-skill] skills 段与 pi 的结构不再匹配(${reason}), <skills> 段可能未被删除; 请核对 pi 版本与 index.ts 的匹配规则`;
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

const LOAD_SKILL_TOOL_NAME = "load_skill";

interface LoadSkillDetails {
	available: string[];
	name?: string;
	path?: string;
}

const loadSkillParams = Type.Object({
	name: Type.Optional(
		Type.String({
			description: "Skill name to resolve. Omit to list the available skill names.",
		}),
	),
});

export default function lazySkill(pi: ExtensionAPI) {
	// 本 session 的可见 skill 名单: 只属于这次 factory 执行的闭包, 与其它 session 互不影响。
	// 每一轮 before_agent_start 从 pi 当前的 systemPromptOptions.skills 重新写入。
	let skills: Skill[] = [];
	// 漂移告警每个 session 只弹一次
	let driftWarned = false;

	// 工具也定义在闭包里: 每个 session 拿到自己的 tool 定义, execute 读的是本 session 的名单
	pi.registerTool(
		defineTool<typeof loadSkillParams, LoadSkillDetails>({
			name: LOAD_SKILL_TOOL_NAME,
			label: "Load Skill",
			description:
				"Resolve a skill name to the absolute path of that skill's file. Skills are not listed in the system prompt: call this tool when the user names a skill, then read the returned file with the read tool before following its instructions. Call it without a name to list the available skill names.",
			promptSnippet: "load_skill: resolve a skill name to its file path (read that file with the read tool)",
			promptGuidelines: [
				"Skills are not listed in the system prompt: when the user names a skill, call load_skill to get the skill file path, then read that file with the read tool and follow its instructions.",
			],
			parameters: loadSkillParams,
			async execute(_toolCallId, params) {
				const available = skills.map((skill) => skill.name);
				const name = params.name?.trim();
				if (!name) {
					return {
						content: [{ type: "text", text: formatSkillList(skills) }],
						details: { available } satisfies LoadSkillDetails,
					};
				}
				const skill = findSkillByName(skills, name);
				if (!skill) {
					return {
						content: [{ type: "text", text: formatSkillMissing(name, skills) }],
						details: { available, name } satisfies LoadSkillDetails,
					};
				}
				return {
					content: [{ type: "text", text: formatSkillFound(skill) }],
					details: { available, name: skill.name, path: skill.filePath } satisfies LoadSkillDetails,
				};
			},
		}),
	);

	pi.on("before_agent_start", (event, ctx) => {
		const options = event.systemPromptOptions;
		if (!options) return;

		// 起点: 此前扩展(如 pi-permission-system)已产出的提示词, 否则 pi 的当前渲染。
		// 必须在改写 options 之前取: event.systemPrompt 是 getter, 会按改写后的 options 重渲染。
		const current = options.forceSystemPrompt ?? event.systemPrompt;
		// 在任何改写之前记下 pi 的 skill 列表, 供 load_skill 查询(每轮刷新, /reload 后自然取到新值)
		skills = visibleSkills(options.skills ?? []);

		// 路径 1: transcript / 段机制 —— 让 pi 不再生成 skills 段
		options.skills = [];
		delete options.sections[SKILLS_SECTION_TAG];

		// 路径 2: 线上请求文本 —— 在此前扩展产出的文本上继续删除 <skills> 段
		const next = stripSkillsSection(current);
		if (next !== current) return { systemPrompt: next };

		const drift = findSkillsDrift(current, { selectedTools: options.selectedTools, skills });
		if (drift && !driftWarned) {
			driftWarned = true;
			warnDrift(ctx, drift);
		}
	});
}
