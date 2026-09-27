/**
 * 与 pi **真实源码**的兼容性测试: 直接调用 pi 包里的提示词构建器(dist/core/system-prompt.js),
 * 断言本扩展在 pi 实际渲染出的提示词上依然有效。
 *
 * 这就是"pi 以后改了提示词怎么办"的答案: 一旦 pi 的段名/元素结构变了, 这里会变红,
 * 而不是在运行时静默失效。
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { findSkillsSectionDrift, stripSkillDescriptions } from "../index.ts";

// 工作区内 pnpm 链接的 pi 包(devDependency); 没装依赖时跳过本文件
const piPkgDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"node_modules",
	"@earendil-works",
	"pi-coding-agent",
);
const systemPromptPath = join(piPkgDir, "dist", "core", "system-prompt.js");
const available = existsSync(systemPromptPath);
const pi = available ? await import(pathToFileURL(systemPromptPath).href) : undefined;

const SKILLS = [
	{ name: "alpha", description: "Alpha 的描述, 内置渲染会写成 <description>。", filePath: "/tmp/alpha/SKILL.md", disableModelInvocation: false },
	{ name: "hidden", description: "不该出现。", filePath: "/tmp/hidden/SKILL.md", disableModelInvocation: true },
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

test("兼容性: pi 内置提示词里 description 元素被裁掉, 其余内容保持 pi 原文", { skip: !available }, () => {
	const prompt = buildPiPrompt();
	assert.match(prompt, /<skills>/, "pi 仍未渲染 <skills> 段: 本扩展的结构契约变了, 需更新 index.ts");
	assert.match(prompt, /<description>/, "pi 已不再输出 <description>: 本扩展的裁剪目标可能已失效");

	const next = stripSkillDescriptions(prompt, "read");
	assert.doesNotMatch(next, /<description/, "裁剪后仍有 description 元素");
	assert.doesNotMatch(next, /Alpha 的描述/, "description 内容仍残留");
	assert.match(next, /<name>alpha<\/name>/);
	assert.match(next, /<location>\/tmp\/alpha\/SKILL\.md<\/location>/);
	assert.doesNotMatch(next, /hidden/, "disable-model-invocation 的 skill 本就不该出现");

	// 列表里标签之间的空白被压掉(pi 原文是缩进 + 换行的多行形态)
	const blockOf = (text: string) =>
		text.slice(text.indexOf("<available_skills>"), text.indexOf("</available_skills>") + "</available_skills>".length);
	assert.doesNotMatch(blockOf(next), />\s+</, "列表里仍存在标签间空白");
	assert.match(blockOf(prompt), />\s+</, "pi 原文已不是多行缩进形态, 该断言需更新");

	// 抬头(列表之前的部分)里除"提到 description 的那一行"外, 必须与 pi 原文逐行一致
	// —— 证明我们没有复制/改写 pi 的文案
	const headerOf = (text: string) => text.slice(0, text.indexOf("<available_skills>")).split("\n");
	const promptHeader = headerOf(prompt);
	const nextHeader = headerOf(next);
	assert.equal(promptHeader.length, nextHeader.length, "抬头行数不应变化");
	const mismatched = promptHeader.filter((line, index) => line !== nextHeader[index]);
	assert.equal(mismatched.length, 1, `抬头应当只改一行, 实际改了 ${mismatched.length} 行: ${JSON.stringify(mismatched)}`);
	assert.match(mismatched[0], /\bdescriptions?\b/i, "被改的那一行应当是提到 description 的指引行");
	assert.match(next, /When the user names a skill, use the read tool/);


	// 共享前缀被抽到 <skill_paths>: ref + 相对路径必须能拼回 pi 给的原始 filePath
	const manySkills = {
		ROOT: "/Users/testuser/.pi/agent/skills",
		names: ["alpha", "beta", "gamma", "delta", "epsilon"],
	};
	if (!pi) throw new Error("未找到工作区内的 pi 包(先 pnpm install)");
	const manyPrompt = pi.buildSystemPrompt({
		cwd: "/tmp/some-project",
		selectedTools: ["read", "bash", "edit", "write"],
		toolSnippets: { read: "read a file", bash: "run a command" },
		skills: manySkills.names.map((name) => ({
			name,
			description: `${name} 的描述`,
			filePath: `${manySkills.ROOT}/${name}/SKILL.md`,
			disableModelInvocation: false,
		})),
	});
	const manyNext = stripSkillDescriptions(manyPrompt, "read");
	assert.match(manyNext, new RegExp(`<skill_paths><path id="1">${manySkills.ROOT}</path></skill_paths>`));

	const roots = new Map(
		[...manyNext.matchAll(/<path id="(\d+)">([^<]+)<\/path>/g)].map((match) => [match[1], match[2]]),
	);
	const reconstructed = [...manyNext.matchAll(/<location ref="(\d+)">([^<]+)<\/location>/g)].map(
		([, id, relative]) => `${roots.get(id) ?? ""}${relative}`,
	);
	assert.deepEqual(
		reconstructed.sort(),
		manySkills.names.map((name) => `${manySkills.ROOT}/${name}/SKILL.md`).sort(),
		"ref + 相对路径没有拼回原路径",
	);
	// 抽出 <skill_paths> 时, 抬头必须给出英文拼接说明(在 pi 真实提示词上验证)
	assert.match(
		manyNext,
		/prepend the matching <path id> value from <skill_paths> to get the full path\./,
		"缺少拼接说明",
	);
	assert.match(manyNext, /When the user names a skill, use the read tool[^\n]*<skill_paths>/);
	assert.equal(
		findSkillsSectionDrift(manyNext, { selectedTools: ["read", "bash", "edit", "write"], skills: manySkills.names.map(() => ({ disableModelInvocation: false })) }),
		undefined,
	);
	// 裁剪后不应再触发漂移告警
	assert.equal(
		findSkillsSectionDrift(next, { selectedTools: ["read", "bash", "edit", "write"], skills: SKILLS }),
		undefined,
	);
});

test("兼容性: 基线 —— pi 原始提示词确实会被本扩展改动(锚点未失效)", { skip: !available }, () => {
	const prompt = buildPiPrompt();
	const next = stripSkillDescriptions(prompt, "read");
	assert.notEqual(next, prompt, "pi 的 skills 段没被改动: 匹配锚点可能已失效");
	assert.ok(next.length < prompt.length, "裁剪后应当更短");
});
