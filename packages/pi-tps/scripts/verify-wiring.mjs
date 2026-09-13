/**
 * 离线接线验证（开发期，不参与 `node --test`）：
 * 用 jiti + fake pi/ctx/tui 复现 pi 的扩展加载与事件流，验证 index.ts 的
 * widget 注册（key/placement）、单行左对齐、窄宽度折两行、流式 CUR 着色、
 * 精确校正、样本过滤、更新节流、清理与非 TUI 兜底。
 *
 * 用法：node scripts/verify-wiring.mjs
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// pi 核心包与 jiti 均从工作区 devDependencies 解析（全局安装仅作兜底）
const globalPiRoot = path.join(
  execSync("npm root -g").toString().trim(),
  "@earendil-works",
  "pi-coding-agent",
);

function resolveModule(specifier, fallback) {
  try {
    return fileURLToPath(import.meta.resolve(specifier));
  } catch {
    return fallback;
  }
}

const extensionPath = path.resolve(import.meta.dirname, "..", "index.ts");
const PI_CORE = resolveModule("@earendil-works/pi-coding-agent", path.join(globalPiRoot, "dist/index.js"));
const PI_TUI = resolveModule("@earendil-works/pi-tui", path.join(globalPiRoot, "node_modules/@earendil-works/pi-tui/dist/index.js"));
const PI_AI = resolveModule("@earendil-works/pi-ai/compat", path.join(globalPiRoot, "node_modules/@earendil-works/pi-ai/dist/compat.js"));

const { createJiti } = await import("jiti");
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  // 与 pi loader 的 getAliases() 保持一致
  alias: {
    "@earendil-works/pi-coding-agent": PI_CORE,
    "@earendil-works/pi-tui": PI_TUI,
    "@earendil-works/pi-ai": PI_AI,
  },
});

const mod = await jiti.import(extensionPath);
const factory = mod.default ?? mod;
assert.equal(typeof factory, "function", "factory 必须是函数");

const handlers = new Map();
const pi = {
  on(event, handler) {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  },
};

let widget = null;
let clearCalls = 0;
let renderRequests = 0;
const ctx = {
  mode: "tui",
  ui: {
    setWidget(key, content, options) {
      if (content === undefined) {
        clearCalls++;
        widget = null;
        return;
      }
      widget = { key, content, options };
    },
  },
};
const emit = async (event, payload, context = ctx) => {
  for (const handler of handlers.get(event) ?? []) await handler(payload, context);
};

const realNow = Date.now;
let clock = 1_000_000;
Date.now = () => clock;

const ANSI = /\u001b\[[0-9;]*m/g;
const strip = (s) => s.replace(ANSI, "");
const theme = {
  fg(color, text) {
    if (color === "accent") return `\u001b[35m${text}\u001b[0m`;
    if (color === "dim") return `\u001b[2m${text}\u001b[0m`;
    return text;
  },
};
const tui = { requestRender: () => renderRequests++ };

const assistant = (over = {}) => ({
  role: "assistant",
  content: [{ type: "text", text: "" }],
  usage: {
    input: 10,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 10,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: clock,
  ...over,
});

let component = null;
const rawLines = (width = 80) => component.render(width);
const plainLines = (width = 80) => rawLines(width).map(strip);

try {
  factory(pi);

  // ---- 1. session_start 注册 widget ----
  await emit("session_start", { type: "session_start", reason: "startup" });
  assert.ok(widget, "session_start 应注册 widget");
  assert.equal(widget.key, "pi-tps");
  assert.equal(widget.options?.placement, "belowEditor", "必须放在 belowEditor");

  component = widget.content(tui, theme);
  assert.equal(typeof component.render, "function");
  assert.equal(typeof component.invalidate, "function");
  assert.equal(typeof component.dispose, "function");
  console.log("✓ session_start：widget 注册于 belowEditor，组件接口完整");

  // ---- 2. 宽屏：单行左对齐 ----
  assert.deepEqual(plainLines(80), ["TTFT -- · MIN -- MAX -- AVG -- CUR -- t/s"]);
  assert.ok(!rawLines(80)[0].startsWith(" "), "必须左对齐（无前导空格）");
  assert.ok(rawLines(80)[0].includes("\u001b[2m"), "应与内置 footer 一致使用 dim 着色");
  console.log(`✓ 宽屏(80)：${JSON.stringify(plainLines(80)[0])}（单行左对齐 + dim）`);

  // ---- 3. 窄屏：折成两行，均左对齐 ----
  assert.deepEqual(plainLines(40), [
    "TTFT --",
    "MIN -- MAX -- AVG -- CUR -- t/s",
  ]);
  assert.ok(plainLines(40).every((l) => !l.startsWith(" ")), "折行后两行也必须左对齐");
  console.log(`✓ 窄屏(40)：折成两行 → ${JSON.stringify(plainLines(40))}`);

  // ---- 4. 极窄：单段超宽时硬截断，绝不消失 ----
  const narrow = plainLines(16);
  assert.equal(narrow.length, 2);
  assert.ok(narrow.every((l) => l.length <= 16), "极窄下每行都不得超宽");
  console.log(`✓ 极窄(16)：${JSON.stringify(narrow)}（硬截断）`);

  // ---- 5. 流式：首字到达显示 TTFT；未达门槛 CUR 为 -- ----
  const rendersBefore = renderRequests;
  await emit("message_start", { type: "message_start", message: assistant() });
  assert.equal(renderRequests, rendersBefore + 1, "message_start 应强制刷新");

  clock += 100;
  await emit("message_update", {
    type: "message_update",
    message: assistant({ content: [{ type: "text", text: "你好" }] }),
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "你好" },
  });
  assert.deepEqual(plainLines(80), ["TTFT 0.10s · MIN -- MAX -- AVG -- CUR -- t/s"]);
  console.log(`✓ 首字到达：${JSON.stringify(plainLines(80)[0])}（TTFT 立即可见，CUR 未达门槛）`);

  clock += 900; // 样本达到门槛（≥20 tokens 且 ≥500ms）后才显示 CUR
  const longText = "The quick brown fox jumps over the lazy dog. ".repeat(3); // 135 字符 ≈ 34 tokens
  await emit("message_update", {
    type: "message_update",
    message: assistant({ content: [{ type: "text", text: longText }] }),
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: longText },
  });
  assert.match(plainLines(80)[0], /^TTFT 0\.10s · MIN -- MAX -- AVG -- CUR \d+\.\d t\/s$/);
  assert.ok(rawLines(80)[0].includes("\u001b[35m"), "流式中 CUR 应为 accent 色");
  console.log(`✓ 流式实时：${JSON.stringify(plainLines(80)[0])}（accent 色，估算值）`);

  // ---- 6. 节流：120ms 内的多次 update 不重复刷新 ----
  const rendersAtStream = renderRequests;
  for (let i = 0; i < 5; i++) {
    clock += 10;
    await emit("message_update", {
      type: "message_update",
      message: assistant({ content: [{ type: "text", text: longText + "x".repeat(i + 2) }] }),
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
    });
  }
  assert.equal(renderRequests, rendersAtStream, "120ms 内不得重复刷新（节流生效）");
  console.log("✓ 节流：120ms 内 5 次 update 无额外 requestRender");

  // ---- 7. 结束：精确校正 ----
  clock += 1050; // 首个 delta 到结束共 2s
  await emit("message_end", {
    type: "message_end",
    message: assistant({
      content: [{ type: "text", text: longText }],
      usage: { ...assistant().usage, output: 100 },
    }),
  });
  assert.deepEqual(plainLines(80), ["TTFT 0.10s avg 0.10s · MIN 50.0 MAX 50.0 AVG 50.0 CUR 50.0 t/s"]);
  assert.ok(!rawLines(80)[0].includes("\u001b[35m"), "空闲时不应带 accent 色");
  console.log(`✓ 首轮结束：${JSON.stringify(plainLines(80)[0])}（100 tokens / 2s）`);

  // ---- 8. 第二轮：更快的响应刷新 MAX/AVG ----
  clock += 100;
  await emit("message_start", { type: "message_start", message: assistant() });
  clock += 500;
  await emit("message_update", {
    type: "message_update",
    message: assistant({ content: [{ type: "text", text: "x" }] }),
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
  });
  clock += 1000; // 首个 delta 到结束 = 1s
  await emit("message_end", {
    type: "message_end",
    message: assistant({ usage: { ...assistant().usage, output: 200 } }),
  });
  assert.deepEqual(plainLines(80), [
    "TTFT 0.50s avg 0.30s · MIN 50.0 MAX 200.0 AVG 125.0 CUR 200.0 t/s",
  ]);
  console.log(`✓ 第二轮：${JSON.stringify(plainLines(80)[0])}（200 tokens / 1s）`);

  // ---- 9. 回归：窗口塌缩伪影（49 tok / 37ms ≈ 1308 t/s）必须被丢弃 ----
  const beforeArtifact = plainLines(80)[0];
  clock += 100;
  await emit("message_start", { type: "message_start", message: assistant() });
  clock += 10;
  await emit("message_update", {
    type: "message_update",
    message: assistant({ content: [{ type: "text", text: "x".repeat(196) }] }), // ≈49 tokens
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
  });
  assert.deepEqual(plainLines(80), [
    "TTFT 0.01s avg 0.30s · MIN 50.0 MAX 200.0 AVG 125.0 CUR -- t/s",
  ]);
  clock += 37; // 窗口仅 37ms
  await emit("message_end", {
    type: "message_end",
    message: assistant({ usage: { ...assistant().usage, output: 49 } }),
  });
  assert.ok(
    plainLines(80)[0].includes("MIN 50.0 MAX 200.0 AVG 125.0 CUR 200.0 t/s"),
    `窗口塌缩样本不得进入 MIN/MAX/AVG（before=${beforeArtifact}）`,
  );
  console.log("✓ 伪影过滤：49 tok / 37ms（≈1308 t/s）已丢弃，MIN/MAX/AVG 不变");

  // ---- 10. 样本过滤：error / aborted / output=0 ----
  const beforeSkip = plainLines(80)[0];
  for (const bad of [
    assistant({ usage: { ...assistant().usage, output: 999 }, stopReason: "error" }),
    assistant({ usage: { ...assistant().usage, output: 999 }, stopReason: "aborted" }),
    assistant({ usage: { ...assistant().usage, output: 0 } }),
  ]) {
    clock += 100;
    await emit("message_start", { type: "message_start", message: bad });
    clock += 200;
    await emit("message_update", {
      type: "message_update",
      message: bad,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
    });
    clock += 300;
    await emit("message_end", { type: "message_end", message: bad });
  }
  assert.ok(
    plainLines(80)[0].includes("MIN 50.0 MAX 200.0 AVG 125.0 CUR 200.0 t/s"),
    "error/aborted/零输出样本必须被跳过",
  );
  console.log("✓ 样本过滤：error / aborted / 零输出均未污染 MIN/MAX");

  // ---- 11. 非 assistant 消息不影响状态 ----
  const beforeUser = plainLines(80)[0];
  await emit("message_start", { type: "message_start", message: { role: "user", content: "hi" } });
  await emit("message_end", { type: "message_end", message: { role: "user", content: "hi" } });
  assert.deepEqual(plainLines(80), [beforeUser]);
  console.log("✓ 非 assistant 消息：状态不变");

  // ---- 12. session_shutdown 清理 ----
  await emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  assert.equal(clearCalls, 1, "session_shutdown 应清除 widget");
  console.log("✓ session_shutdown：setWidget(key, undefined) 已调用");

  // ---- 13. 非 TUI 模式零副作用 ----
  widget = null;
  clearCalls = 0;
  await emit(
    "session_start",
    { type: "session_start", reason: "startup" },
    { ...ctx, mode: "print" },
  );
  assert.equal(widget, null, "非 TUI 模式不得注册 widget");
  console.log("✓ 非 TUI 模式（print）：零副作用");

  console.log("\n全部接线验证通过 ✅");
} finally {
  Date.now = realNow;
}
