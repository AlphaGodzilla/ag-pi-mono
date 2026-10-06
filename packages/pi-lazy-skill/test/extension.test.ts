/**
 * 扩展接线的单元测试: 用一个假的 pi API 捕获 registerTool / before_agent_start, 验证
 * 两条路径(段机制 + 文本)都生效、load_skill 的返回内容、以及漂移告警会落日志。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { contentText } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, Skill, ToolDefinition } from "@earendil-works/pi-coding-agent";

import lazySkill from "../index.ts";

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
	skill("grilling", "/tmp/skills/grilling/SKILL.md"),
	skill("scaffold", "/tmp/skills/scaffold/SKILL.md"),
	skill("hidden", "/tmp/skills/hidden/SKILL.md", true),
];

/** pi 的提示词就是各段用空行拼接, skills 段由 pi 自己包上同名标签 */
function promptWithSkills(): string {
	return [
		"<preamble>\nYou are an expert coding assistant.\n</preamble>",
		"<skills>\nThe following skills provide specialized instructions.\n<available_skills>\n<skill><name>grilling</name><location>/tmp/skills/grilling/SKILL.md</location></skill>\n</available_skills>\n</skills>",
		"<cwd>\n/tmp/some-project\n</cwd>",
	].join("\n\n");
}

interface PromptOptions {
	selectedTools: string[];
	sections: Record<string, string>;
	skills: Skill[];
	forceSystemPrompt?: string;
}

function makeOptions(overrides: Partial<PromptOptions> = {}): PromptOptions {
	return { selectedTools: TOOLS, sections: {}, skills: SKILLS, ...overrides };
}

/** 捕获扩展注册的 tool 与 before_agent_start handler */
function setup() {
	let tool: ToolDefinition<any, any, any> | undefined;
	let handler: ((event: any, ctx: any) => any) | undefined;
	const fake = {
		registerTool: (definition: ToolDefinition<any, any, any>) => {
			tool = definition;
		},
		on: (event: string, registered: (event: any, ctx: any) => any) => {
			if (event === "before_agent_start") handler = registered;
		},
	};
	lazySkill(fake as unknown as ExtensionAPI);
	assert.ok(tool, "load_skill 未注册");
	assert.ok(handler, "before_agent_start 未注册");
	return { tool: tool as ToolDefinition<any, any, any>, handler: handler as (event: any, ctx: any) => any };
}

const CTX = { hasUI: false } as unknown as ExtensionContext;

function textOf(result: AgentToolResult): string {
	return contentText(result.content);
}

test("注册 load_skill 工具: 描述与指引都引导用 read 工具读文件", () => {
	const { tool } = setup();
	assert.equal(tool.name, "load_skill");
	assert.match(tool.description, /read the returned file with the read tool/);
	assert.match((tool.promptGuidelines ?? []).join("\n"), /read that file with the read tool/);
	assert.match(tool.promptSnippet ?? "", /read that file with the read tool/);
});

test("before_agent_start: 清空 options.skills 与 sections.skills, 并从文本里删掉 <skills> 段", () => {
	const { handler } = setup();
	const options = makeOptions({ sections: { skills: "leftover" } });
	const result = handler({ systemPrompt: promptWithSkills(), systemPromptOptions: options }, CTX) as
		| { systemPrompt?: string }
		| undefined;

	assert.deepEqual(options.skills, [], "options.skills 未被清空");
	assert.equal("skills" in options.sections, false, "sections.skills 未被清除");
	assert.ok(result?.systemPrompt, "没有返回替换后的提示词");
	assert.doesNotMatch(result.systemPrompt, /<skills>/, "返回的文本里仍有 <skills> 段");
	assert.doesNotMatch(result.systemPrompt, /grilling/, "返回的文本里仍残留 skill");
	assert.match(result.systemPrompt, /<cwd>\n\/tmp\/some-project\n<\/cwd>/);
});

test("before_agent_start: 在前一扩展 forceSystemPrompt 的文本上继续删除", () => {
	const { handler } = setup();
	const forced = `LEADING-TEXT\n\n${promptWithSkills()}`;
	const options = makeOptions({ forceSystemPrompt: forced });
	const result = handler({ systemPrompt: "SHOULD-NOT-BE-USED", systemPromptOptions: options }, CTX) as {
		systemPrompt?: string;
	};

	assert.ok(result?.systemPrompt);
	assert.match(result.systemPrompt, /^LEADING-TEXT/);
	assert.doesNotMatch(result.systemPrompt, /<skills>/);
});

test("load_skill: 命中给出路径并引导 read; 省略名字/未命中给出可用名单", async () => {
	const { tool, handler } = setup();
	handler({ systemPrompt: promptWithSkills(), systemPromptOptions: makeOptions() }, CTX);

	const hit = await tool.execute("call-1", { name: "  Grilling  " }, undefined, undefined, CTX);
	assert.match(textOf(hit), /Skill "grilling" file: \/tmp\/skills\/grilling\/SKILL\.md/);
	assert.match(textOf(hit), /read tool/);

	const list = await tool.execute("call-2", {}, undefined, undefined, CTX);
	assert.match(textOf(list), /Available skills: grilling, scaffold/);
	assert.doesNotMatch(textOf(list), /hidden|描述/, "名单只给可见 skill 的名字");

	const miss = await tool.execute("call-3", { name: "nope" }, undefined, undefined, CTX);
	assert.match(textOf(miss), /No skill named "nope" is available\./);
	assert.match(textOf(miss), /Available skills: grilling, scaffold/);
});

test("per-session 隔离: 两个 factory 实例(session)的 skill 名单互不共享", async () => {
	const a = setup();
	const b = setup();

	// a 先跑一轮, 写入自己的名单
	a.handler({ systemPrompt: promptWithSkills(), systemPromptOptions: makeOptions() }, CTX);

	// b 还没跑 before_agent_start: 它的闭包仍是空的, 不会读到 a 的 skill
	const bBefore = await b.tool.execute("b-1", {}, undefined, undefined, CTX);
	assert.match(textOf(bBefore), /No skills are available in this session\./);

	// b 跑自己的 before_agent_start, 写入 b 的名单
	const bSkills = [skill("only-b", "/tmp/skills/only-b/SKILL.md")];
	b.handler({ systemPrompt: promptWithSkills(), systemPromptOptions: makeOptions({ skills: bSkills }) }, CTX);

	// 各查各的, 互不覆盖
	assert.match(textOf(await a.tool.execute("a-1", { name: "grilling" }, undefined, undefined, CTX)), /grilling\/SKILL\.md/);
	assert.match(textOf(await b.tool.execute("b-2", { name: "only-b" }, undefined, undefined, CTX)), /only-b\/SKILL\.md/);
	assert.match(textOf(await a.tool.execute("a-2", { name: "only-b" }, undefined, undefined, CTX)), /No skill named "only-b"/);
	assert.match(textOf(await b.tool.execute("b-3", { name: "grilling" }, undefined, undefined, CTX)), /No skill named "grilling"/);
});

test("模拟 /reload: factory 再次执行后按刷新后的 skill 列表工作", async () => {
	const first = setup();
	first.handler({ systemPrompt: promptWithSkills(), systemPromptOptions: makeOptions() }, CTX);
	assert.match(textOf(await first.tool.execute("f-1", { name: "grilling" }, undefined, undefined, CTX)), /grilling\/SKILL\.md/);

	// /reload 会 clearExtensionCache → 重新执行 factory → 新闭包 + 新 tool 定义
	const reloaded = setup();
	// 刷新前: 新闭包是空的
	assert.match(textOf(await reloaded.tool.execute("r-0", {}, undefined, undefined, CTX)), /No skills are available/);
	// 刷新后的 pi 会在下一轮 before_agent_start 给出新的 skill 列表
	const freshSkills = [skill("fresh", "/tmp/skills/fresh/SKILL.md")];
	reloaded.handler({ systemPrompt: promptWithSkills(), systemPromptOptions: makeOptions({ skills: freshSkills }) }, CTX);
	assert.match(textOf(await reloaded.tool.execute("r-1", { name: "fresh" }, undefined, undefined, CTX)), /fresh\/SKILL\.md/);
	assert.match(textOf(await reloaded.tool.execute("r-2", { name: "grilling" }, undefined, undefined, CTX)), /No skill named "grilling"/);
});

test("漂移: 本应有 skills 段却缺失时告警并写 error.log", () => {
	const { handler } = setup();
	const agentDir = mkdtempSync(join(tmpdir(), "pi-lazy-skill-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const notifications: string[] = [];
	const ctx = {
		hasUI: true,
		ui: { notify: (message: string) => notifications.push(message) },
	} as unknown as ExtensionContext;
	try {
		const result = handler({ systemPrompt: "<cwd>\n/tmp\n</cwd>", systemPromptOptions: makeOptions() }, ctx);
		assert.equal(result, undefined, "没有 skills 段可删时不应返回替换文本");
		assert.equal(notifications.length, 1, "应弹一条漂移告警");
		assert.match(notifications[0], /pi-lazy-skill/);
		const log = readFileSync(join(agentDir, "extensions", "pi-lazy-skill", "error.log"), "utf-8");
		assert.match(log, /skills 段与 pi 的结构不再匹配/);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});
