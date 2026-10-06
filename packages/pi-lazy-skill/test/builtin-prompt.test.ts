/**
 * 与 pi **真实源码**的兼容性测试: 直接调用 pi 包里的提示词构建器(dist/core/system-prompt.js),
 * 断言本扩展在 pi 实际渲染出的提示词上依然有效 —— <skills> 段能被整段删除, 其余内容一字不动。
 *
 * 这就是"pi 以后改了提示词怎么办"的答案: 一旦 pi 的段名/结构变了, 这里会变红,
 * 而不是在运行时静默失效。
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Skill } from "@earendil-works/pi-coding-agent";

import { findSkillByName, findSkillsDrift, stripSkillsSection } from "../index.ts";

// 工作区内 pnpm 链接的 pi 包(devDependency); 没装依赖时跳过本文件
let systemPromptPath: string | undefined;
try {
	const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	systemPromptPath = join(dirname(entry), "core", "system-prompt.js");
} catch {
	systemPromptPath = undefined;
}
const available = systemPromptPath !== undefined && existsSync(systemPromptPath);
const pi = available ? await import(pathToFileURL(systemPromptPath as string).href) : undefined;

function skill(name: string, description: string, filePath: string, disableModelInvocation = false): Skill {
	return {
		name,
		description,
		filePath,
		baseDir: filePath.replace(/\/[^/]+$/, ""),
		sourceInfo: { path: filePath, source: "test", scope: "temporary", origin: "top-level" },
		disableModelInvocation,
	};
}

const SKILLS = [
	skill("grilling", "Grill the user relentlessly.", "/tmp/skills/grilling/SKILL.md"),
	skill("scaffold", "Scaffold a new project.", "/tmp/skills/scaffold/SKILL.md"),
	skill("hidden", "不该出现。", "/tmp/skills/hidden/SKILL.md", true),
];

function buildPiPrompt(): string {
	if (!pi) throw new Error("未找到工作区内的 pi 包(先 pnpm install)");
	return pi.buildSystemPrompt({
		cwd: "/tmp/some-project",
		selectedTools: ["read", "bash", "edit", "write"],
		toolSnippets: { read: "read a file", bash: "run a command" },
		skills: SKILLS,
	});
}

test("兼容性: pi 渲染出的 <skills> 段被整段删除, 其余段逐字保留", { skip: !available }, () => {
	const prompt = buildPiPrompt();
	assert.match(prompt, /<skills>/, "pi 仍未渲染 <skills> 段: 本扩展的结构契约变了, 需更新 index.ts");
	assert.match(prompt, /<available_skills>/, "pi 的 skills 段结构变了");
	assert.match(prompt, /<description>/, "pi 已不再输出 <description>: 本扩展的假设可能已失效");

	const next = stripSkillsSection(prompt);
	assert.doesNotMatch(next, /<skills>/, "删除后仍有 <skills> 段");
	assert.doesNotMatch(next, /<available_skills>/, "删除后仍残留 <available_skills>");
	assert.doesNotMatch(next, /grilling|scaffold/, "删除后仍残留 skill 名字/描述");
	assert.doesNotMatch(next, /hidden/, "disable-model-invocation 的 skill 本就不该出现");
	assert.doesNotMatch(next, /\n{3,}/, "不应留下多余空行");

	// 除 skills 段外逐字保留: 手工按"删段 + 留一个分隔符"重建期望值
	const start = prompt.indexOf("<skills>");
	const end = prompt.indexOf("</skills>", start) + "</skills>".length;
	const expected = `${prompt.slice(0, start).replace(/\n+$/, "")}\n\n${prompt.slice(end).replace(/^\n+/, "")}`;
	assert.equal(next, expected);

	// 幂等
	assert.equal(stripSkillsSection(next), next);

	// 删除后不再是"本应有该段却找不到"的漂移
	assert.equal(findSkillsDrift(prompt, { selectedTools: ["read", "bash", "edit", "write"], skills: SKILLS }), undefined);
	assert.match(
		findSkillsDrift(next, { selectedTools: ["read", "bash", "edit", "write"], skills: SKILLS }) ?? "",
		/未找到 <skills> 段/,
	);
});

test("兼容性: load_skill 返回的路径与 pi 渲染进提示词的 <location> 一致", { skip: !available }, () => {
	const prompt = buildPiPrompt();
	const location = /<location>([^<]+)<\/location>/.exec(prompt)?.[1];
	assert.equal(location, SKILLS[0].filePath, "pi 渲染的 skill 路径与 Skill.filePath 不一致");
	assert.equal(findSkillByName(SKILLS, "grilling")?.filePath, location);
});

test("兼容性: 基线 —— pi 原始提示词确实会被本扩展改动(锚点未失效)", { skip: !available }, () => {
	const prompt = buildPiPrompt();
	const next = stripSkillsSection(prompt);
	assert.notEqual(next, prompt, "pi 的 skills 段没被改动: 匹配锚点可能已失效");
	assert.ok(next.length < prompt.length, "删除 skills 段后应当更短");
});
