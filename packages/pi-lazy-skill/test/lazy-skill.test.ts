/**
 * index.ts 纯逻辑单元测试(node --test)。
 * 只覆盖文本变换与名字解析, 不涉及 pi 运行时; 与 pi 内置提示词的兼容性见 builtin-prompt.test.ts。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Skill } from "@earendil-works/pi-coding-agent";

import {
	findSkillByName,
	findSkillsDrift,
	formatSkillFound,
	formatSkillList,
	formatSkillMissing,
	pickFileReadTool,
	stripSkillsSection,
	visibleSkills,
} from "../index.ts";

const TOOLS = ["read", "bash", "edit", "write"];

function skill(name: string, filePath: string, disableModelInvocation = false): Skill {
	return {
		name,
		description: `${name} 的描述`,
		filePath,
		baseDir: filePath.replace(/\/[^/]+$/, ""),
		sourceInfo: { path: filePath, source: "test", scope: "temporary", origin: "top-level" },
		disableModelInvocation,
	};
}

const SKILLS = [
	skill("grilling", "/Users/testuser/.pi/agent/skills/grilling/SKILL.md"),
	skill("scaffold", "/Users/testuser/.pi/agent/skills/scaffold/SKILL.md"),
];

/** pi 的提示词就是各段用空行拼接, skills 段由 pi 自己包上同名标签 */
function promptWithSkills(): string {
	return [
		"<preamble>\nYou are an expert coding assistant.\n</preamble>",
		"<docs>\nPi documentation...\n</docs>",
		"<skills>\nThe following skills provide specialized instructions.\n<available_skills>\n<skill><name>grilling</name><location>/Users/testuser/.pi/agent/skills/grilling/SKILL.md</location></skill>\n</available_skills>\n</skills>",
		"<cwd>\n/tmp/some-project\n</cwd>",
	].join("\n\n");
}

test("pickFileReadTool: read 优先, 其次 bash, 都没有则 undefined", () => {
	assert.equal(pickFileReadTool(TOOLS), "read");
	assert.equal(pickFileReadTool(["bash", "edit"]), "bash");
	assert.equal(pickFileReadTool(["edit", "write"]), undefined);
});

test("visibleSkills: 去掉 disable-model-invocation 的 skill", () => {
	const hidden = skill("hidden", "/tmp/hidden/SKILL.md", true);
	assert.deepEqual(
		visibleSkills([...SKILLS, hidden]).map((entry) => entry.name),
		["grilling", "scaffold"],
	);
});

test("findSkillByName: 精确优先, 其次大小写不敏感, 未命中为 undefined", () => {
	assert.equal(findSkillByName(SKILLS, "grilling")?.filePath, SKILLS[0].filePath);
	assert.equal(findSkillByName(SKILLS, "  Grilling  ")?.name, "grilling");
	assert.equal(findSkillByName(SKILLS, "nope"), undefined);
	assert.equal(findSkillByName(SKILLS, "   "), undefined);
});

test("stripSkillsSection: 段在中间时只留一个分段分隔符, 其余段原样", () => {
	const prompt = promptWithSkills();
	const next = stripSkillsSection(prompt);
	assert.doesNotMatch(next, /<skills>/);
	assert.doesNotMatch(next, /grilling/);
	assert.doesNotMatch(next, /\n{3,}/, "不应留下多余空行");
	assert.match(next, /<preamble>\nYou are an expert coding assistant\.\n<\/preamble>\n\n<docs>/);
	assert.match(next, /<\/docs>\n\n<cwd>\n\/tmp\/some-project\n<\/cwd>/);
	assert.equal(next.endsWith("<cwd>\n/tmp/some-project\n</cwd>"), true);
});

test("stripSkillsSection: 段在开头/结尾/整条只有该段", () => {
	assert.equal(stripSkillsSection("<skills>\nx\n</skills>\n\n<cwd>\n/tmp\n</cwd>"), "<cwd>\n/tmp\n</cwd>");
	assert.equal(stripSkillsSection("<cwd>\n/tmp\n</cwd>\n\n<skills>\nx\n</skills>"), "<cwd>\n/tmp\n</cwd>");
	assert.equal(stripSkillsSection("<skills>\nx\n</skills>"), "");
});

test("stripSkillsSection: 无该段时原样返回, 且幂等; 多个段一并删除", () => {
	const plain = "<preamble>\nhi\n</preamble>";
	assert.equal(stripSkillsSection(plain), plain);

	const prompt = promptWithSkills();
	const once = stripSkillsSection(prompt);
	assert.equal(stripSkillsSection(once), once, "第二次不应再改动");

	const doubled = `${prompt}\n\n<skills>\nsecond\n</skills>`;
	const stripped = stripSkillsSection(doubled);
	assert.doesNotMatch(stripped, /<skills>/);
	assert.doesNotMatch(stripped, /second/);
	assert.match(stripped, /<\/cwd>$/);
});

test("stripSkillsSection: 只删 <skills>, 不动名字里含 skills 的其它标签", () => {
	const prompt = "<docs>\nskills guide\n</docs>\n\n<skills_extra>\nkeep me\n</skills_extra>";
	assert.equal(stripSkillsSection(prompt), prompt);
});

test("formatSkillFound: 给出绝对路径并引导用 read 工具读取", () => {
	const text = formatSkillFound(SKILLS[0]);
	assert.match(text, /Skill "grilling" file: \/Users\/testuser\/\.pi\/agent\/skills\/grilling\/SKILL\.md/);
	assert.match(text, /read tool/);
});

test("formatSkillList / formatSkillMissing: 只暴露名字, 不暴露描述", () => {
	const list = formatSkillList(SKILLS);
	assert.match(list, /Available skills: grilling, scaffold/);
	assert.doesNotMatch(list, /描述/);
	assert.match(formatSkillList([]), /No skills are available/);

	const missing = formatSkillMissing("nope", SKILLS);
	assert.match(missing, /No skill named "nope" is available\./);
	assert.match(missing, /Available skills: grilling, scaffold/);
	assert.equal(formatSkillMissing("nope", []), 'No skill named "nope" is available.');
});

test("findSkillsDrift: 只有本应有 skills 段却找不到时才告警", () => {
	const prompt = promptWithSkills();
	assert.equal(findSkillsDrift(prompt, { selectedTools: TOOLS, skills: SKILLS }), undefined);
	// 没有可见 skill / 没有 read|bash: pi 本就不生成该段
	assert.equal(findSkillsDrift("<cwd>\n/tmp\n</cwd>", { selectedTools: TOOLS, skills: [] }), undefined);
	assert.equal(
		findSkillsDrift("<cwd>\n/tmp\n</cwd>", { selectedTools: TOOLS, skills: [skill("x", "/tmp/x/SKILL.md", true)] }),
		undefined,
	);
	assert.equal(
		findSkillsDrift("<cwd>\n/tmp\n</cwd>", { selectedTools: ["edit", "write"], skills: SKILLS }),
		undefined,
	);
	assert.match(
		findSkillsDrift("<cwd>\n/tmp\n</cwd>", { selectedTools: TOOLS, skills: SKILLS }) ?? "",
		/未找到 <skills> 段/,
	);
});
