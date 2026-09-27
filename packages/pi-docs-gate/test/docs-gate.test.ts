/**
 * extensions/index.ts 纯逻辑单元测试(node --test)。
 * 只覆盖提示词文本变换, 不涉及 pi 运行时; 与 pi 内置提示词的兼容性见 builtin-prompt.test.ts。
 */
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { agentDir, applyDocsGate, findDocsSectionDrift } from "../extensions/index.ts";

/** 以临时值跑一段断言, 用完恢复 PI_CODING_AGENT_DIR(pi 的 getAgentDir() 是实时解析的) */
function withAgentDir(dir: string, fn: (resolved: string) => void): void {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		fn(agentDir());
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
}

/** 任意文案都算数: 本扩展按 <docs> 段结构定位, 不匹配段落内容 */
function promptWithDocs(body: string): string {
	return ["<rules>", "- Be concise", "</rules>", "", "<docs>", body, "</docs>", "", "<cwd>", "/tmp/project", "</cwd>"].join("\n");
}

const HINT_MARK = "请读取 pi-docs skill 获取完整访问指引";

test("agentDir: 跟随任意 PI_CODING_AGENT_DIR(绝对路径 / 波浪号), 用于日志落盘位置", () => {
	withAgentDir("/tmp/pi-agent-arbitrary", (resolved) => {
		assert.equal(resolved, "/tmp/pi-agent-arbitrary");
	});
	withAgentDir("~/pi-agent-tilde", (resolved) => {
		// pi 的 getAgentDir() 会把 ~ 展开, 本插件沿用它的解析
		assert.equal(resolved, join(homedir(), "pi-agent-tilde"));
	});
});

test("applyDocsGate: 任意目录都把内置 docs 段换成按需指针(不再按 cwd 分支)", () => {
	const next = applyDocsGate(promptWithDocs("Pi documentation (read only …) 一大段内置文案"));
	assert.match(next, new RegExp(`<docs>\\n[\\s\\S]*${HINT_MARK}[\\s\\S]*\\n</docs>`));
	assert.doesNotMatch(next, /Pi documentation \(read only/);
	assert.doesNotMatch(next, /\(none\)/);
	// 其余段不受影响
	assert.match(next, /<rules>/);
	assert.match(next, /<cwd>/);
});

test("applyDocsGate: 与 cwd 无关(同一输入给任何 cwd 都是同一结果)", () => {
	const once = applyDocsGate(promptWithDocs("body"));
	const twice = applyDocsGate(promptWithDocs("body"));
	assert.equal(once, twice);
	assert.ok(once.includes(HINT_MARK));
});

test("applyDocsGate: 幂等(连续两次结果相同)", () => {
	const once = applyDocsGate(promptWithDocs("body"));
	assert.equal(applyDocsGate(once), once);
});

test("applyDocsGate: 无 docs 段(customPrompt 模式)不凭空注入", () => {
	const custom = "<rules>\n- Be concise\n</rules>";
	assert.equal(applyDocsGate(custom), custom);
});

test("findDocsSectionDrift: 非 customPrompt 模式缺 <docs> 段即报告, customPrompt 模式不报", () => {
	assert.equal(findDocsSectionDrift(promptWithDocs("body"), undefined), undefined);
	assert.ok(findDocsSectionDrift("<rules></rules>", undefined));
	assert.equal(findDocsSectionDrift("<rules></rules>", "自定义系统提示"), undefined);
});
