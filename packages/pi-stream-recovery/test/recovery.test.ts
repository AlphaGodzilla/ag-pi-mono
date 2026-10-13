import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const ERROR = "stream error: stream disconnected before completion: stream closed before response.completed";
const ENTRY = fileURLToPath(new URL("../index.ts", import.meta.url));

async function harness(options: {
  enabled?: boolean;
  plugin?: boolean;
  maxRetries?: number;
  baseDelayMs?: number;
  mode?: ExtensionContext["mode"];
} = {}) {
  const dir = mkdtempSync("/tmp/pi-stream-recovery-");
  try {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      cacheWarming: "off",
      retry: {
        enabled: options.enabled ?? true,
        maxRetries: options.maxRetries ?? 2,
        baseDelayMs: options.baseDelayMs ?? 1,
        maxAgentDelayMs: 20,
        provider: { maxRetries: 0 },
      },
    });
    // 所有配置/凭据访问限制在本测试的 /tmp 目录；不发现宿主资源、不访问网络。
    const modelRuntime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const faux = fauxProvider({ provider: "stream-recovery-test", api: "stream-recovery-test" });
    modelRuntime.registerNativeProvider(faux.provider);
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager,
      noExtensions: true,
      noContextFiles: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalExtensionPaths: options.plugin === false ? [] : [ENTRY],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    let toolExecutions = 0;
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      modelRuntime,
      model: faux.getModel(),
      thinkingLevel: "off",
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(dir),
      tools: ["record"],
      customTools: [{
        name: "record",
        label: "Record",
        description: "Test side effect counter",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          toolExecutions++;
          return { content: [{ type: "text", text: "recorded" }], details: undefined };
        },
      }],
    });
    await session.bindExtensions({ mode: options.mode ?? "json" });
    const events: AgentSessionEvent[] = [];
    session.subscribe((event) => events.push(structuredClone(event)));
    return {
      loader,
      session, faux, events,
      toolExecutions: () => toolExecutions,
      close: () => {
        session.dispose();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function failure(errorMessage = ERROR): AssistantMessage {
  return fauxAssistantMessage(fauxToolCall("record", {}, { id: "partial-tool" }), {
    stopReason: "error", errorMessage,
  });
}

test("真实 SDK：断流后自动恢复；失败工具不执行、不进入重试上下文，原始记录保留", async () => {
  const h = await harness();
  try {
    h.faux.setResponses([failure(), (context) => {
      assert.equal(context.messages.some((m) => m.role === "assistant" && m.stopReason === "error"), false);
      return fauxAssistantMessage("recovered");
    }]);
    await h.session.prompt("run");
    assert.equal(h.faux.state.callCount, 2);
    assert.equal(h.toolExecutions(), 0);
    assert.equal(h.session.getLastAssistantText(), "recovered");
    assert.equal(h.events.filter((e) => e.type === "auto_retry_start").length, 1);
    assert.ok(h.events.some((e) => e.type === "auto_retry_end" && e.success));
    const entries = h.session.sessionManager.getBranch();
    assert.ok(entries.some((e) => e.type === "message" && e.message.role === "assistant" &&
      e.message.errorMessage === `Network error [pi-stream-recovery]: ${ERROR}`));
    assert.ok(entries.some((e) => e.type === "context_edit"));
    assert.equal(entries.filter((e) => e.type === "message" && e.message.role === "user").length, 1);
  } finally { h.close(); }
});

test("真实 SDK：连续断流消耗原生重试预算，耗尽后停止，不自动发继续", async () => {
  const h = await harness({ maxRetries: 2 });
  try {
    h.faux.setResponses([failure(), failure(), failure(), fauxAssistantMessage("must not run")]);
    await h.session.prompt("run");
    assert.equal(h.faux.state.callCount, 3);
    assert.deepEqual(h.events.filter((e) => e.type === "auto_retry_start").map((e) => e.delayMs), [1, 2]);
    assert.ok(h.events.some((e) => e.type === "auto_retry_end" && !e.success && e.attempt === 2));
    assert.equal(h.toolExecutions(), 0);
    assert.equal(h.session.messages.filter((m) => m.role === "user").length, 1);
  } finally { h.close(); }
});

for (const options of [{ enabled: false }, { maxRetries: 0 }, { plugin: false }]) {
  test(`真实 SDK：关闭/零预算/无插件不重试 ${JSON.stringify(options)}`, async () => {
    const h = await harness(options);
    try {
      h.faux.setResponses([failure(), fauxAssistantMessage("must not run")]);
      await h.session.prompt("run");
      assert.equal(h.faux.state.callCount, 1);
      assert.equal(h.events.filter((e) => e.type === "auto_retry_start").length, 0);
    } finally { h.close(); }
  });
}

test("真实 SDK：overloaded 沿用原生处理，未知错误不重试", async () => {
  const h = await harness();
  try {
    h.faux.setResponses([failure("Our servers are currently overloaded."), fauxAssistantMessage("ok")]);
    await h.session.prompt("run");
    const failedMessage = h.events.find((e) => e.type === "message_end" && e.message.role === "assistant" && e.message.stopReason === "error");
    assert.ok(failedMessage?.type === "message_end" && failedMessage.message.role === "assistant");
    assert.equal(failedMessage.message.errorMessage, "Our servers are currently overloaded.");
    h.faux.setResponses([failure("Unauthorized (401)"), fauxAssistantMessage("must not run")]);
    await h.session.prompt("run again");
    assert.equal(h.faux.state.callCount, 3);
  } finally { h.close(); }
});

test("真实 SDK：退避期间取消后不再请求模型", async () => {
  const h = await harness({ baseDelayMs: 20 });
  try {
    let abort: Promise<void> | undefined;
    h.session.subscribe((event) => {
      if (event.type === "auto_retry_start") queueMicrotask(() => { abort = h.session.abort(); });
    });
    h.faux.setResponses([failure(), fauxAssistantMessage("must not run")]);
    await h.session.prompt("run");
    await abort;
    assert.equal(h.faux.state.callCount, 1);
    assert.ok(h.events.some((e) => e.type === "auto_retry_end" && !e.success));
  } finally { h.close(); }
});

test("真实 SDK：已完成工具结果保留，失败响应中的工具不重放", async () => {
  const h = await harness();
  try {
    h.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("record", {}, { id: "completed-tool" }), { stopReason: "toolUse" }),
      failure(),
      (context) => {
        assert.ok(context.messages.some((m) => m.role === "toolResult" && m.toolCallId === "completed-tool"));
        assert.equal(context.messages.some((m) => m.role === "assistant" && m.stopReason === "error"), false);
        return fauxAssistantMessage("done");
      },
    ]);
    await h.session.prompt("run");
    assert.equal(h.faux.state.callCount, 3);
    assert.equal(h.toolExecutions(), 1);
  } finally { h.close(); }
});

for (const mode of ["tui", "rpc", "print"] as const) {
  test(`真实 SDK：${mode} 模式无需 UI 也能恢复`, async () => {
    const h = await harness({ mode });
    try {
      h.faux.setResponses([failure(), fauxAssistantMessage("ok")]);
      await h.session.prompt("run");
      assert.equal(h.faux.state.callCount, 2);
    } finally { h.close(); }
  });
}

test("真实 SDK：连续 reload 后只有一份扩展，恢复不重复调度", async () => {
  const h = await harness();
  try {
    await h.session.reload();
    await h.session.reload();
    assert.equal(h.loader.getExtensions().extensions.length, 1);
    h.faux.setResponses([failure(), fauxAssistantMessage("ok")]);
    await h.session.prompt("run");
    assert.equal(h.faux.state.callCount, 2);
    assert.equal(h.events.filter((e) => e.type === "auto_retry_start").length, 1);
  } finally { h.close(); }
});

test("真实 SDK：并发会话不共享重试预算或恢复状态", async () => {
  const a = await harness({ maxRetries: 0 });
  let b: Awaited<ReturnType<typeof harness>> | undefined;
  try {
    b = await harness({ maxRetries: 2 });
    a.faux.setResponses([failure(), fauxAssistantMessage("must not run")]);
    b.faux.setResponses([failure(), fauxAssistantMessage("ok")]);
    await Promise.all([a.session.prompt("run a"), b.session.prompt("run b")]);
    assert.equal(a.faux.state.callCount, 1);
    assert.equal(b.faux.state.callCount, 2);
    assert.equal(a.events.filter((e) => e.type === "auto_retry_start").length, 0);
    assert.equal(b.events.filter((e) => e.type === "auto_retry_start").length, 1);
  } finally {
    a.close();
    b?.close();
  }
});
