/**
 * index.ts 纯逻辑单元测试(node --test)。
 * 只覆盖文本变换, 不涉及 pi 运行时; 与 pi 内置提示词的兼容性见 builtin-prompt.test.ts。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	findSkillsSectionDrift,
	pickFileReadTool,
	skillPathRoot,
	stripSkillDescriptions,
	summarizeSkillPaths,
	transformSkillsSection,
} from "../index.ts";

const TOOLS = ["read", "bash", "edit", "write"];

/** 形状取自 Agent Skills 规范 / pi 的 skills 段: 抬头若干行 + <available_skills> 列表 */
function sectionFixture(headerLines: string[], skills: Array<{ name: string; description: string; location: string }>): string {
	return [
		...headerLines,
		"",
		"<available_skills>",
		...skills.flatMap((skill) => [
			"  <skill>",
			`    <name>${skill.name}</name>`,
			`    <description>${skill.description}</description>`,
			`    <location>${skill.location}</location>`,
			"  </skill>",
		]),
		"</available_skills>",
	].join("\n");
}

const HEADER = [
	"A line we never touch.",
	"Load a skill's file when the task matches its description.",
	"A path line we never touch.",
];

test("pickFileReadTool: read 优先, 其次 bash, 都没有则 undefined", () => {
	assert.equal(pickFileReadTool(TOOLS), "read");
	assert.equal(pickFileReadTool(["bash", "edit"]), "bash");
	assert.equal(pickFileReadTool(["edit", "write"]), undefined);
});

test("transformSkillsSection: 删掉 description 元素, 只改写提到 description 的那一行", () => {
	const next = transformSkillsSection(
		sectionFixture(HEADER, [{ name: "grilling", description: "Grill the user relentlessly.", location: "/tmp/grilling/SKILL.md" }]),
		"read",
	);
	assert.doesNotMatch(next, /<description/);
	assert.doesNotMatch(next, /Grill the user relentlessly/);
	// pi 的其它行(标题/路径提示)原样保留 —— 本插件不复制也不改写它们
	assert.match(next, /A line we never touch\./);
	assert.match(next, /A path line we never touch\./);
	// 只有那一行换成我们的措辞
	assert.match(next, /When the user names a skill, use the read tool/);
	assert.match(next, /<name>grilling<\/name>/);
	assert.match(next, /<location>\/tmp\/grilling\/SKILL\.md<\/location>/);
});

test("transformSkillsSection: 只有 bash 时用 bash 措辞", () => {
	const next = transformSkillsSection(sectionFixture(HEADER, []), "bash");
	assert.match(next, /use bash to load/);
	assert.doesNotMatch(next, /use the read tool/);
});

test("transformSkillsSection: 幂等(连续两次结果相同)", () => {
	const once = transformSkillsSection(sectionFixture(HEADER, [{ name: "a", description: "d", location: "/a/SKILL.md" }]), "read");
	assert.equal(transformSkillsSection(once, "read"), once);
});

test("transformSkillsSection: 多行 description 与其独占缩进/换行一并删除", () => {
	const next = transformSkillsSection(
		["<available_skills>", "  <skill>", "    <name>a</name>", "    <description>line1", 'line2 & <x></description>', "    <location>/a/SKILL.md</location>", "  </skill>", "</available_skills>"].join("\n"),
		"read",
	);
	assert.doesNotMatch(next, /<description>|line1|line2/);
	assert.match(next, /<name>a<\/name><location>\/a\/SKILL\.md<\/location>/);
});

test("transformSkillsSection: 压掉列表里标签之间的空白(换行+缩进), 但不动文本节点内部", () => {
	const next = transformSkillsSection(
		sectionFixture(HEADER, [{ name: " a ", description: "d", location: "/a/SKILL.md" }]),
		"read",
	);
	const list = next.slice(next.indexOf("<available_skills>"));
	assert.doesNotMatch(list, />\s+</, "标签之间不应再有空白");
	assert.match(list, /^<available_skills><skill><name> a <\/name><location>\/a\/SKILL\.md<\/location><\/skill><\/available_skills>/);
	// 抬头是散文, 仍然保留换行
	assert.match(next, /A line we never touch\.\n/);
	// 幂等
	assert.equal(transformSkillsSection(next, "read"), next);
});

test("stripSkillDescriptions: 只裁剪 <skills> 段, 段外内容不动; 无该段时原样返回", () => {
	const prompt = [
		"<tools>",
		"- x: <description>keep me</description>",
		"</tools>",
		"<skills>",
		...HEADER,
		"<available_skills>",
		"  <skill>",
		"    <name>a</name>",
		"    <description>drop me</description>",
		"    <location>/a/SKILL.md</location>",
		"  </skill>",
		"</available_skills>",
		"</skills>",
	].join("\n");

	const next = stripSkillDescriptions(prompt, "read");
	assert.match(next, /keep me/);
	assert.doesNotMatch(next, /drop me/);
	assert.match(next, /<cwd>|<\/skills>/);

	const noSection = "<tools>\n- x: y\n</tools>";
	assert.equal(stripSkillDescriptions(noSection, "read"), noSection);
});

test("findSkillsSectionDrift: 本应有该段却缺失/结构不对时给出原因, 否则 undefined", () => {
	const visibleSkills = [{ disableModelInvocation: false }];
	const hiddenSkills = [{ disableModelInvocation: true }];

	// 正常: description 已裁掉
	const clean = "<skills>\n<available_skills>\n<skill><name>a</name><location>/a</location></skill>\n</available_skills>\n</skills>";
	assert.equal(findSkillsSectionDrift(clean, { selectedTools: TOOLS, skills: visibleSkills }), undefined);

	// 段缺失
	assert.ok(findSkillsSectionDrift("<tools></tools>", { selectedTools: TOOLS, skills: visibleSkills }));

	// 段在但列表结构变了
	assert.ok(findSkillsSectionDrift("<skills>\n<foo/>\n</skills>", { selectedTools: TOOLS, skills: visibleSkills }));

	// 仍有 description(元素格式变了, 没被裁掉)
	const leftover = '<skills>\n<available_skills>\n<description attr="x">d</description>\n</available_skills>\n</skills>';
	assert.ok(findSkillsSectionDrift(leftover, { selectedTools: TOOLS, skills: visibleSkills }));

	// 本就不该有该段: 全隐藏 / 没有 read-bash
	assert.equal(findSkillsSectionDrift("<tools></tools>", { selectedTools: TOOLS, skills: hiddenSkills }), undefined);
	assert.equal(findSkillsSectionDrift("<tools></tools>", { selectedTools: ["edit"], skills: visibleSkills }), undefined);
});

test("skillPathRoot: 去掉 <skill 目录>/SKILL.md 两段, 非绝对路径返回空", () => {
	assert.equal(skillPathRoot("/home/u/.agents/skills/foo/SKILL.md"), "/home/u/.agents/skills");
	assert.equal(skillPathRoot("/home/u/.agents/skills/group/sub/SKILL.md"), "/home/u/.agents/skills/group");
	assert.equal(skillPathRoot("/a/SKILL.md"), "/");
	assert.equal(skillPathRoot("relative/dir/SKILL.md"), "");
});

test("summarizeSkillPaths: 共享前缀抽到 <skill_paths>, ref+相对路径拼回原路径", () => {
	// 用贴近真实的规模: 同一个 skill 根下 5 个 skill, 前缀 27 字符
	const root = "/Users/hty/.pi/agent/skills";
	const names = ["alpha", "beta", "gamma", "delta", "epsilon"];
	const original = names.map((name) => `${root}/${name}/SKILL.md`);
	const body = [
		"<available_skills>",
		...original.map((path, index) => `<skill><name>${names[index]}</name><location>${path}</location></skill>`),
		"</available_skills>",
	].join("\n");

	const next = summarizeSkillPaths(body);
	assert.ok(next.startsWith(`<skill_paths><path id="1">${root}</path></skill_paths>`));
	assert.ok(next.indexOf("<skill_paths>") < next.indexOf("<available_skills>"));
	assert.doesNotMatch(next, new RegExp(`<location>${root}`));

	// 不变量: ref 指向的前缀 + 相对路径, 必须逐条等于原路径
	const roots = new Map(
		[...next.matchAll(/<path id="(\d+)">([^<]+)<\/path>/g)].map((match) => [match[1], match[2]]),
	);
	const reconstructed = [...next.matchAll(/<location ref="(\d+)">([^<]+)<\/location>/g)].map(
		([, id, relative]) => `${roots.get(id) ?? ""}${relative}`,
	);
	assert.deepEqual(reconstructed, original);

	// 幂等
	assert.equal(summarizeSkillPaths(next), next);
});

test("summarizeSkillPaths: 不划算或无共享前缀时不声明(保持原样)", () => {
	// 前缀太短: 省下的字符数不够抵消声明开销
	const short = [
		"<available_skills>",
		"<skill><name>a</name><location>/s/a/SKILL.md</location></skill>",
		"<skill><name>b</name><location>/s/b/SKILL.md</location></skill>",
		"</available_skills>",
	].join("\n");
	assert.equal(summarizeSkillPaths(short), short);

	// 每个 skill 各自一个前缀: 没有共享组
	const unique = [
		"<available_skills>",
		"<skill><name>a</name><location>/home/u/aaa/a/SKILL.md</location></skill>",
		"<skill><name>b</name><location>/home/u/bbb/b/SKILL.md</location></skill>",
		"</available_skills>",
	].join("\n");
	assert.equal(summarizeSkillPaths(unique), unique);
});

test("summarizeSkillPaths: 已带 ref 的 location 不重复处理", () => {
	const body = '<available_skills><skill><name>a</name><location ref="1">/a/SKILL.md</location></skill></available_skills>';
	assert.equal(summarizeSkillPaths(body), body);
});

test("transformSkillsSection: 抽出 <skill_paths> 时在抬头追加英文拼接说明(没抽就不加)", () => {
	const root = "/Users/hty/.pi/agent/skills";
	const names = ["alpha", "beta", "gamma", "delta", "epsilon"];
	const content = [
		"A title line pi wrote.",
		"Load a skill's file when the task matches its description.",
		"",
		"<available_skills>",
		...names.map((name) => `<skill><name>${name}</name><location>${root}/${name}/SKILL.md</location></skill>`),
		"</available_skills>",
	].join("\n");

	const next = transformSkillsSection(content, "read");
	assert.match(next, /<skill_paths>/);
	assert.match(next, /prepend the matching <path id> value from <skill_paths> to get the full path\./);
	// 说明与"按 location 读取"的指引在同一行, 抬头行数不变
	assert.equal(next.split("<available_skills>")[0].split("\n").length, content.split("<available_skills>")[0].split("\n").length);
	assert.match(next, /When the user names a skill, use the read tool[^\n]*<skill_paths>/);

	// 抽不出前缀时不追加该说明
	const noRefs = transformSkillsSection(
		["A title line pi wrote.", "Load a skill's file when the task matches its description.", "", "<available_skills>", '<skill><name>a</name><location>/s/a/SKILL.md</location></skill>', "</available_skills>"].join("\n"),
		"read",
	);
	assert.doesNotMatch(noRefs, /<skill_paths>/);
	assert.doesNotMatch(noRefs, /prepend the matching/);
	assert.match(noRefs, /When the user names a skill, use the read tool/);
});
