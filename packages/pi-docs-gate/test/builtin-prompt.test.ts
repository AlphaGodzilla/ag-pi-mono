/**
 * 与 pi **真实源码**的兼容性测试: 直接调用 pi 包里的提示词构建器(dist/core/system-prompt.js),
 * 断言本扩展在 pi 实际渲染出的提示词上依然有效。
 *
 * 这就是"pi 以后改了提示词怎么办"的答案: 段名/结构一旦变化, 这里会变红, 而不是运行时静默失效。
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { applyDocsGate, findDocsSectionDrift } from "../extensions/index.ts";

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

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? "/Users/hty/.pi/agent";

function buildPiPrompt(cwd: string): string {
	if (!pi) throw new Error("未找到工作区内的 pi 包(先 pnpm install)");
	return pi.buildSystemPrompt({
		cwd,
		selectedTools: ["read", "bash", "edit", "write"],
		toolSnippets: { read: "read a file", bash: "run a command" },
		skills: [],
	});
}

test("兼容性: pi 内置 docs 段被换成按需指针(不依赖 cwd)", { skip: !available }, () => {
	const prompt = buildPiPrompt("/tmp/some-project");
	assert.match(prompt, /<docs>/, "pi 不再渲染 <docs> 段: 本扩展的结构契约变了, 需更新 extensions/index.ts");
	assert.match(prompt, /Pi documentation \(read only/, "pi 已不再写内置 docs 段文案: 本扩展的替换目标可能已失效");

	const next = applyDocsGate(prompt);
	assert.doesNotMatch(next, /Pi documentation \(read only/);
	assert.match(next, /<docs>\n[\s\S]*?请读取 pi-docs skill 获取完整访问指引[\s\S]*?\n<\/docs>/);
	assert.equal(findDocsSectionDrift(next, undefined), undefined);

	// 除 docs 段外, 提示词其余部分保持不变
	const docsRange = (text: string) => {
		const start = text.indexOf("<docs>");
		const end = text.indexOf("</docs>") + "</docs>".length;
		return [text.slice(0, start), text.slice(end)];
	};
	assert.deepEqual(docsRange(next), docsRange(prompt));
	assert.ok(next.length < prompt.length, "替换后应当更短");
});

test("兼容性: 项目目录与配置目录下 docs 段都换成同一份按需指针", { skip: !available }, () => {
	const a = applyDocsGate(buildPiPrompt("/tmp/some-project"));
	const b = applyDocsGate(buildPiPrompt(AGENT_DIR));
	assert.match(a, /请读取 pi-docs skill 获取完整访问指引/);
	assert.match(b, /请读取 pi-docs skill 获取完整访问指引/);
});
