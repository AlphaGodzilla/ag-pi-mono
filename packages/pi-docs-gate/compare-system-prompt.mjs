/**
 * 对比 pi-docs-gate 扩展开启前后的系统提示词差异
 *
 * 用法: node compare-system-prompt.mjs
 * 输出: ./pi-docs-gate/*.md(开启前/开启后×两种 cwd)+ 终端 diff
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, sep } from "node:path";
import { execSync } from "node:child_process";
import { homedir } from "node:os";

// ---- 运行主机环境动态探测(与扩展 index.ts 同一套逻辑, 跨机器可跑) ----
const PI_PKG_NAME = "@earendil-works/pi-coding-agent";
function findPiPackageDir() {
	const candidates = [];
	const prefix = dirname(dirname(process.execPath));
	candidates.push(join(prefix, "lib", "node_modules", PI_PKG_NAME));
	try {
		const root = execSync("npm root -g", { encoding: "utf8" }).trim();
		if (root) candidates.push(join(root, PI_PKG_NAME));
	} catch {}
	for (const dir of candidates) {
		const pkgFile = join(dir, "package.json");
		if (!existsSync(pkgFile)) continue;
		try {
			const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
			if (pkg.name === PI_PKG_NAME) return dir;
		} catch {}
	}
	return null;
}
const piPkgDir = findPiPackageDir();
if (!piPkgDir) {
	console.error("未找到 pi 包安装目录(execPath 推导与 npm root -g 均未命中), 无法继续");
	process.exit(1);
}
const { buildSystemPrompt } = await import(join(piPkgDir, "dist", "core", "system-prompt.js"));

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const PI_DOCS_CWD = AGENT_DIR;

// ---------- 1. 向上查找 AGENTS.md(模拟 resource-loader 的 loadContextFileFromDir) ----------
function findAgentsFile(startDir) {
	let dir = resolve(startDir);
	while (true) {
		for (const name of ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]) {
			const p = join(dir, name);
			if (existsSync(p) && statSync(p).isFile()) {
				return { path: p, content: readFileSync(p, "utf-8") };
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

// ---------- 2. 扫描 skill 目录, 提取 name/description/filePath ----------
function parseFrontmatter(filePath) {
	const raw = readFileSync(filePath, "utf-8");
	const m = raw.match(/^---\n([\s\S]*?)\n---/);
	if (!m) return null;
	const fm = {};
	for (const line of m[1].split("\n")) {
		const kv = line.match(/^(\w+):\s*(.*)$/);
		if (kv) fm[kv[1]] = kv[2].trim();
	}
	return fm;
}

function scanSkills(dirs) {
	const skills = [];
	const seen = new Set();
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const sk = join(dir, entry.name, "SKILL.md");
			if (!existsSync(sk)) continue;
			const fm = parseFrontmatter(sk);
			if (!fm?.name) continue;
			const key = fm.name;
			if (seen.has(key)) continue;
			seen.add(key);
			skills.push({ name: fm.name, description: fm.description ?? "", filePath: sk, disableModelInvocation: false });
		}
	}
	return skills;
}

// ---------- 3. 工具 snippets(取自当前会话系统提示词中实际注入的描述) ----------
const toolSnippets = {
	read: "Read a text file; each line returned as HASH│content. No line numbers — use the HASH as the anchor in replace calls. Images → visual attachments; Binary/directory → rejected; UTF-16/UTF-32 (BOM) → rejected; empty → HASH│ (replace to insert); pageable with offset/limit; BOM stripped; non-UTF-8 shown as U+FFFD.",
	bash: "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.",
	write: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
	replace: "Replace a range of lines in a text file, targeted by the 3-char HASH anchors from read's HASH│content output.",
	undo_last_replace: "Undo the last replace on a file, reverting it to its previous state.",
	ask_user_question: "Ask the user one or more structured questions during execution. Use when you need to gather user preferences, clarify ambiguous instructions, or get decisions on implementation choices.",
	firecrawl_load: "Find and enable Firecrawl tools relevant to a web scraping, crawling, URL discovery, crawl-status, or search task.",
	write_plan: "将当前 markdown 计划写入本次 plan 会话的计划文件。每当计划内容有新增或修改时都应调用本工具。",
};

// ---------- 4. pi-docs-gate 扩展逻辑(与 extensions/pi-docs-gate/index.ts 保持一致) ----------
const PI_DOCS_SECTION_RE = /\n\nPi documentation \(read only[\s\S]*?TUI API details\)/;

function applyGate(prompt, cwd) {
	let next = prompt.replace(PI_DOCS_SECTION_RE, "");
	if (cwd === PI_DOCS_CWD || cwd?.startsWith(PI_DOCS_CWD + "/")) {
		next += [
			"",
			"当前工作目录为 ~/.pi/agent(pi 配置目录)。",
			"如需 pi 自身文档(README / docs/ / examples/, 以及 extensions.md、skills.md、",
			"prompt-templates.md、tui.md、keybindings.md、sdk.md 等),",
			"请读取 pi-docs skill 获取完整访问指引。",
		].join("\n");
	}
	return next;
}

// ---------- 5. 构建 ----------
function buildPrompt(cwd) {
	const contextFiles = [];
	const agents = findAgentsFile(cwd);
	if (agents) contextFiles.push(agents);

	const globalSkills = scanSkills([
		join(AGENT_DIR, "skills"),
		join(AGENT_DIR, "pi-docs-gate", "skills"), // pi-docs skill 随包(pi-docs-gate/skills)
		join(homedir(), ".claude", "skills"),
		join(cwd, ".pi", "skills"),
	]);

	return buildSystemPrompt({
		cwd,
		selectedTools: Object.keys(toolSnippets),
		toolSnippets,
		promptGuidelines: [],
		appendSystemPrompt: undefined,
		contextFiles,
		skills: globalSkills,
	});
}

const cwdPiAgent = AGENT_DIR;
const cwdOther = join(homedir(), "Desktop", "some-project"); // 普通编码目录示例(目录不存在也能对比, 只是无项目上下文; 可改为本机任意项目)

const beforePiAgent = buildPrompt(cwdPiAgent);
const afterPiAgent = applyGate(beforePiAgent, cwdPiAgent);
const beforeOther = buildPrompt(cwdOther);
const afterOther = applyGate(beforeOther, cwdOther);

// ---------- 6. 输出 ----------
const outDir = join(AGENT_DIR, "pi-docs-gate");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "before-system-prompt.md"), beforePiAgent);
writeFileSync(join(outDir, "after-system-prompt-cwd-pi-agent.md"), afterPiAgent);
writeFileSync(join(outDir, "before-system-prompt-cwd-other.md"), beforeOther);
writeFileSync(join(outDir, "after-system-prompt-cwd-other.md"), afterOther);

console.log("=== 生成文件 ===");
console.log(`  ${outDir}/before-system-prompt.md`);
console.log(`  ${outDir}/after-system-prompt-cwd-pi-agent.md`);
console.log(`  ${outDir}/before-system-prompt-cwd-other.md`);
console.log(`  ${outDir}/after-system-prompt-cwd-other.md`);
console.log(`  before 长度: ${beforePiAgent.length} chars (${beforeOther.length} @ other cwd)`);
console.log(`  after(pi-agent cwd): ${afterPiAgent.length} chars`);
console.log(`  after(other cwd): ${afterOther.length} chars`);
console.log(`  token 节省(其他目录): ~${Math.round((beforeOther.length - afterOther.length) / 4)} tokens(按 4 chars/token 估算)`);

function showDiff(a, b, label) {
	console.log(`\n=== diff: ${label} ===`);
	try {
		console.log(execSync(`diff -u ${a} ${b}`, { encoding: "utf-8" }));
	} catch (e) {
		console.log(e.stdout); // diff 非零退出码是正常差异
	}
}

showDiff(join(outDir, "before-system-prompt.md"), join(outDir, "after-system-prompt-cwd-pi-agent.md"), "开启前 vs 开启后 (cwd = ~/.pi/agent)");
showDiff(join(outDir, "before-system-prompt-cwd-other.md"), join(outDir, "after-system-prompt-cwd-other.md"), "开启前 vs 开启后 (cwd = 其他目录)");
