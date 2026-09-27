/**
 * pi-skills-gate 扩展
 *
 * 目标: skills 段只保留 <name> 与 <location>, 不再常驻每个 skill 的 <description> 全文
 * (同一份描述就写在 SKILL.md 的 frontmatter 里, 用户点名 skill 后模型按 <location> 读文件即可看到)。
 *
 * 设计约束: **不把 pi 的提示词文案抄进本插件**。只依赖两类东西:
 *   1) 结构契约 —— pi 把每个 section 包成同名标签(<skills>…</skills>), skill 列表用 Agent Skills
 *      规范的元素(<skill>/<name>/<description>/<location>);
 *   2) 语义关键词 "description" —— 抬头里提到它的那一行在描述被删后已不成立, 换成我们自己的
 *      一句(按 read/bash 选择)。其余一切(标题、路径提示、pi 以后新增的元素/字段)原样沿用 pi 的渲染。
 *
 * 两条路径(为什么必须两条见 README「与其它扩展共存」):
 *   - transcript / 段机制: sections.skills := 从 pi 当前渲染里取出的 skills 段, 只做同样的裁剪;
 *   - 线上请求文本: 在 `forceSystemPrompt ?? event.systemPrompt` 上做同样的裁剪并 return。
 *   两者同源, 因此会话记录与线上请求一致。
 *
 * 漂移检测: pi 若改名 section 或换元素格式, 裁剪会"匹配不到却静默通过"。这里只用**结构化信号**
 * 判断(有可见 skill + 有 read/bash 时本应有该段; 段里本应有 <available_skills>), 命中即告警。
 */
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** section 名与元素名: pi / Agent Skills 规范的结构契约(不是文案) */
const SKILLS_SECTION_TAG = "skills";
const SKILLS_SECTION_RE = /<skills>([\s\S]*?)<\/skills>/;
const AVAILABLE_SKILLS_TAG = "available_skills";
/** 抬头里提到 description 的行(语义关键词, 不比对具体句子) */
const MENTIONS_DESCRIPTION_RE = /\bdescriptions?\b/i;
/** description 元素(含其独占的缩进与换行); 元素内容里的 `<` 已被 pi 转义, 不会提前闭合 */
const DESCRIPTION_ELEMENT_RE = /[ \t]*<description[\s\S]*?<\/description>\r?\n?/g;
/** 漂移判据用的宽松匹配: 只要还有 description 起始标签就算没裁干净 */
const DESCRIPTION_START_RE = new RegExp(`<${AVAILABLE_SKILLS_TAG}>[\\s\\S]*?<description[\\s>]`);
/** 标签之间的空白(换行 + 缩进): 只压列表内部, 不动抬头那几行散文 */
const TAG_GAP_RE = />\s+</g;

/** 共享路径前缀的声明元素(挂在 <skills> 下, 位于 <available_skills> 之前) */
const SKILL_PATHS_TAG = "skill_paths";
const PATH_ELEMENT = "path";
/** 只匹配无属性的 <location>绝对路径</location>; 已带 ref 的形态不再处理(幂等) */
const SKILL_LOCATION_RE = /<location>([^<]*)<\/location>/g;

/** 我们自己的措辞(不是 pi 的文案): 抬头里那句"按描述匹配"的指引换成"按 location 读取" */
const LOCATION_INSTRUCTION_READ =
	"When the user names a skill, use the read tool to load that skill's file from its location.";
const LOCATION_INSTRUCTION_BASH =
	"When the user names a skill, use bash to load that skill's file from its location.";
/** 只有真的抽出了 <skill_paths> 时才会追加的拼接说明(英文, 告诉 agent ref 怎么还原成完整路径) */
const LOCATION_REFS_INSTRUCTION =
	"A <location> that carries a ref attribute is relative: prepend the matching <path id> value from <skill_paths> to get the full path.";

/** 日志路径: pi 配置目录由 pi 自己解析(getAgentDir() 尊重 PI_CODING_AGENT_DIR, 支持 ~ 与任意目录) */
function logPath(): string {
	return join(getAgentDir(), "extensions", "pi-skills-gate", "error.log");
}

export type FileReadTool = "read" | "bash";

/** 与 pi 的内置判断一致: read 优先, 其次 bash; 都没有则不展示 skills 段 */
export function pickFileReadTool(selectedTools: readonly string[]): FileReadTool | undefined {
	if (selectedTools.includes("read")) return "read";
	if (selectedTools.includes("bash")) return "bash";
	return undefined;
}

/**
 * 取一条 skill 路径的"共享前缀"(skill 根目录): 去掉 `<skill 目录>/SKILL.md` 这两段。
 * 例: /home/u/.agents/skills/foo/SKILL.md → /home/u/.agents/skills
 * 只用路径本身推导, 不依赖 pi 的 baseDir, 因此对权限过滤后的文本同样适用。
 */
export function skillPathRoot(path: string): string {
	if (!path.startsWith("/")) return "";
	const segments = path.split("/");
	if (segments.length <= 3) return "/";
	return segments.slice(0, -2).join("/");
}

/**
 * 把 <available_skills> 里重复的路径前缀抽到 <skill_paths> 中, <location> 改成
 * `<location ref="N">相对路径</location>`(相对路径保留前导 `/`, 拼回去即原路径)。
 *
 * 只声明"真省 token"的前缀: 省下的字符数必须大于声明本身的长度, 否则该组保持绝对路径。
 * 幂等: 已含 <skill_paths> 时原样返回; `<location ref=…>` 不会被二次处理。
 */
export function summarizeSkillPaths(body: string): string {
	if (body.includes(`<${SKILL_PATHS_TAG}>`)) return body;

	const groups = new Map<string, string[]>();
	for (const match of body.matchAll(SKILL_LOCATION_RE)) {
		const path = match[1];
		const root = skillPathRoot(path);
		if (!root) continue;
		const members = groups.get(root);
		if (members) members.push(path);
		else groups.set(root, [path]);
	}

	const declared = new Map<string, number>();
	const declarations: string[] = [];
	const wrapperCost = `<${SKILL_PATHS_TAG}></${SKILL_PATHS_TAG}>`.length;
	let overhead = wrapperCost;

	for (const [root, paths] of groups) {
		if (paths.length < 2) continue;
		const id = declared.size + 1;
		const declaration = `<${PATH_ELEMENT} id="${id}">${root}</${PATH_ELEMENT}>`;
		const before = paths.reduce((sum, path) => sum + `<location>${path}</location>`.length, 0);
		const after = paths.reduce(
			(sum, path) => sum + `<location ref="${id}">${path.slice(root.length)}</location>`.length,
			0,
		);
		// 只有省下的字符数大于声明 + 外壳开销时才值得抽出来
		if (before - after <= declaration.length + overhead) continue;
		overhead = 0; // 外壳只算一次
		declared.set(root, id);
		declarations.push(declaration);
	}

	if (declarations.length === 0) return body;

	const next = body.replace(SKILL_LOCATION_RE, (full, path: string) => {
		const root = skillPathRoot(path);
		const id = declared.get(root);
		return id === undefined ? full : `<location ref="${id}">${path.slice(root.length)}</location>`;
	});
	return `<${SKILL_PATHS_TAG}>${declarations.join("")}</${SKILL_PATHS_TAG}>${next}`;
}

/**
 * 裁剪 skills 段**内容**(不含外层 <skills> 标签):
 *   - 删掉 <available_skills> 内的 <description> 元素;
 *   - 把重复的路径前缀抽到 <skill_paths> 里, <location> 只留 ref + 相对路径;
 *     抽了的话, 抬头同一行里追加一句英文说明, 告诉 agent 怎么把 ref 拼回完整路径;
 *   - 压掉列表里标签之间的空白(换行 + 缩进) —— XML 里标签间空白不参与语义, 纯 token 开销;
 *   - 抬头里提到 description 的那一行换成我们的措辞。
 * 幂等; 除此以外一律原样透传(pi 改文案或加字段都不影响)。
 */
export function transformSkillsSection(content: string, fileReadTool?: FileReadTool): string {
	const bodyStart = content.indexOf(`<${AVAILABLE_SKILLS_TAG}>`);
	const header = bodyStart === -1 ? content : content.slice(0, bodyStart);
	const body = bodyStart === -1 ? "" : content.slice(bodyStart);

	// 只压标签之间的空白: 文本节点内部的空白(如 <name> a </name>)不受影响
	const cleanedBody = summarizeSkillPaths(body.replace(DESCRIPTION_ELEMENT_RE, "")).replace(TAG_GAP_RE, "><");
	const instruction =
		fileReadTool === "bash" ? LOCATION_INSTRUCTION_BASH : LOCATION_INSTRUCTION_READ;

	// 抽出了 <skill_paths> 才需要解释拼接规则
	const usesPathRefs = cleanedBody.includes(`<${SKILL_PATHS_TAG}>`);
	const replacement = usesPathRefs ? `${instruction} ${LOCATION_REFS_INSTRUCTION}` : instruction;

	let reworded = false;
	const cleanedHeader = header
		.split("\n")
		.map((line) => {
			if (reworded || !MENTIONS_DESCRIPTION_RE.test(line)) return line;
			reworded = true;
			return replacement;
		})
		.join("\n");

	// 抬头里没有可替换的行(pi 改了那句指引): 把我们的指引单独补一行, 保证拼接规则始终在场
	if (usesPathRefs && !reworded) {
		const trimmedHeader = cleanedHeader.replace(/\s*$/, "");
		return `${trimmedHeader}\n${replacement}\n\n${cleanedBody}`;
	}

	return cleanedHeader + cleanedBody;
}

/** 从提示词里取出 skills 段内容(无该段时 undefined) */
export function extractSkillsSection(prompt: string): string | undefined {
	return SKILLS_SECTION_RE.exec(prompt)?.[1];
}

/** 在整条提示词上裁剪 skills 段(幂等; 无该段时原样返回) */
export function stripSkillDescriptions(prompt: string, fileReadTool?: FileReadTool): string {
	const match = SKILLS_SECTION_RE.exec(prompt);
	if (!match) return prompt;
	const transformed = transformSkillsSection(match[1], fileReadTool);
	return `${prompt.slice(0, match.index)}<${SKILLS_SECTION_TAG}>${transformed}</${SKILLS_SECTION_TAG}>${prompt.slice(match.index + match[0].length)}`;
}

export interface SkillsDriftInput {
	selectedTools: readonly string[];
	skills: readonly { disableModelInvocation?: boolean }[];
}

/**
 * 结构化漂移判据(不比对任何文案): 按 pi 自己的前提推断"本应有 skills 段" —— 有可见 skill
 * 且有 read/bash; 若提示词里没有该段、段里没有 <available_skills>、或仍有 description 元素,
 * 说明 pi 的结构变了, 返回告警原因。
 */
export function findSkillsSectionDrift(
	prompt: string,
	input: SkillsDriftInput,
): string | undefined {
	const hasVisibleSkill = input.skills.some((skill) => !skill.disableModelInvocation);
	if (!hasVisibleSkill || pickFileReadTool(input.selectedTools) === undefined) return undefined;

	if (!prompt.includes(`<${SKILLS_SECTION_TAG}>`)) {
		return `未找到 <${SKILLS_SECTION_TAG}> 段`;
	}
	const section = extractSkillsSection(prompt) ?? "";
	if (!section.includes(`<${AVAILABLE_SKILLS_TAG}>`)) {
		return `skills 段里没有 <${AVAILABLE_SKILLS_TAG}> 块`;
	}
	if (DESCRIPTION_START_RE.test(section)) {
		return `<${AVAILABLE_SKILLS_TAG}> 里仍有未裁掉的 description 元素`;
	}
	return undefined;
}

let driftWarned = false;

/** 漂移告警: TUI/RPC 弹一条通知, 同时落一行日志(仓库约定: 运行数据放 extensions/<包名>/) */
export function warnDrift(ctx: ExtensionContext, reason: string): void {
	if (driftWarned) return;
	driftWarned = true;
	const message = `[pi-skills-gate] skills 段与 pi 的结构不再匹配(${reason}), 描述裁剪可能未生效; 请核对 pi 版本与 index.ts 的匹配规则`;
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

export default function skillsGate(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		const options = event.systemPromptOptions;
		if (!options) return;

		const fileReadTool = pickFileReadTool(options.selectedTools);
		// 起点: 此前扩展(如 pi-permission-system)已产出的提示词, 否则 pi 的当前渲染
		const current = options.forceSystemPrompt ?? event.systemPrompt;

		// 路径 1: transcript / 段机制 —— 段内容取同一来源, 保证会话记录与线上请求一致
		const section = extractSkillsSection(current);
		if (section !== undefined) {
			options.sections.skills = transformSkillsSection(section, fileReadTool).trim();
		}

		// 路径 2: 线上请求文本 —— 在此前扩展产出的文本上继续裁剪
		const next = stripSkillDescriptions(current, fileReadTool);
		if (next !== current) return { systemPrompt: next };

		const drift = findSkillsSectionDrift(current, options);
		if (drift) warnDrift(ctx, drift);
	});
}
