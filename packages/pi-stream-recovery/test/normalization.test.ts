import assert from "node:assert/strict";
import { test } from "node:test";
import { isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
  MessageEndEventResult,
} from "@earendil-works/pi-coding-agent";
import streamRecovery, { normalizeStreamError } from "../index.ts";

const ERROR = "stream error: stream disconnected before completion: stream closed before response.completed";
const GATEWAY_ERROR = "upstream stream closed before any chunk carried finish_reason";

function failed(errorMessage = ERROR): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "test",
    content: [{ type: "toolCall", id: "partial-write", name: "write", arguments: { path: "file" } }],
    stopReason: "error",
    errorMessage,
    usage: {
      input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 123,
  };
}

test("归一化后进入原生重试分类，保留原文和所有其他字段，不修改输入", () => {
  const message = failed();
  const original = structuredClone(message);
  assert.equal(isRetryableAssistantError(message), false);
  const replacement = normalizeStreamError(message)?.message;
  assert.ok(replacement?.role === "assistant");
  assert.equal(isRetryableAssistantError(replacement), true);
  assert.equal(replacement.errorMessage, `Network error [pi-stream-recovery]: ${ERROR}`);
  assert.deepEqual({ ...replacement, errorMessage: message.errorMessage }, original);
  assert.equal(replacement.content, message.content);
  assert.equal(replacement.usage, message.usage);
  assert.deepEqual(message, original);
});

test("只忽略原文两端空白，仍保留原文；重复调用不再次添加前缀", () => {
  const message = failed(` \n${ERROR}\n `);
  const replacement = normalizeStreamError(message)?.message;
  assert.ok(replacement?.role === "assistant");
  assert.equal(replacement.errorMessage, `Network error [pi-stream-recovery]: ${message.errorMessage}`);
  assert.equal(normalizeStreamError(replacement), undefined);
});

test("网关提前断流（upstream stream closed ... finish_reason）同样归一化", () => {
  assert.equal(isRetryableAssistantError(failed(GATEWAY_ERROR)), false);
  for (const text of [
    GATEWAY_ERROR,
    `  ${GATEWAY_ERROR}\n`,
    `Error: ${GATEWAY_ERROR}`,
    `error:${GATEWAY_ERROR}`,
    GATEWAY_ERROR.toUpperCase(),
  ]) {
    const message = failed(text);
    const replacement = normalizeStreamError(message)?.message;
    assert.ok(replacement?.role === "assistant", text);
    assert.equal(replacement.errorMessage, `Network error [pi-stream-recovery]: ${text}`);
    assert.equal(isRetryableAssistantError(replacement), true);
    assert.equal(normalizeStreamError(replacement), undefined);
  }
});

test("网关断流签名不做模糊匹配，其他措辞仍不处理", () => {
  for (const error of [
    "upstream stream closed",
    "upstream stream closed before any chunk",
    "stream closed before any chunk carried finish_reason",
    "upstream stream closed before any chunk carried finish_reason: retry later",
    "Error: upstream: stream closed before any chunk carried finish_reason",
    "WebSocket upstream stream closed before any chunk carried finish_reason",
  ]) {
    assert.equal(normalizeStreamError(failed(error)), undefined, error);
  }
});

test("原生已支持时不替换消息", () => {
  let calls = 0;
  assert.equal(normalizeStreamError(failed(), false, (message) => {
    calls++;
    assert.equal(message.errorMessage, ERROR);
    return true;
  }), undefined);
  assert.equal(calls, 1);
});

test("取消、非失败响应和其他角色均不处理", () => {
  assert.equal(normalizeStreamError(failed(), true), undefined);
  for (const stopReason of ["stop", "toolUse", "aborted", "length"] as const) {
    assert.equal(normalizeStreamError({ ...failed(), stopReason }), undefined);
  }
  assert.equal(normalizeStreamError({ role: "user", content: ERROR, timestamp: 1 }), undefined);
  assert.equal(normalizeStreamError({
    role: "toolResult", toolCallId: "test", toolName: "write",
    content: [{ type: "text", text: ERROR }], isError: true, timestamp: 1,
  }), undefined);
});

test("白名单外的错误不处理，包括额度、认证、上下文和普通网络错误", () => {
  for (const error of [
    "", "Our servers are currently overloaded.", "OpenAI API error (503): busy",
    "insufficient_quota", "billing error", "Unauthorized (401)",
    "maximum context length exceeded", "connection closed", "stream error",
    "WebSocket stream closed before response.completed",
    `${ERROR}: insufficient_quota`, `Unauthorized: ${ERROR}`, `${ERROR} extra detail`,
  ]) {
    assert.equal(normalizeStreamError(failed(error)), undefined, error);
  }
  assert.equal(normalizeStreamError({ ...failed(), errorMessage: undefined }), undefined);
});

test("扩展仅注册 message_end，不需要 UI、定时器或消息注入", () => {
  let handler: ((event: MessageEndEvent, ctx: ExtensionContext) => MessageEndEventResult | undefined) | undefined;
  let registrations = 0;
  const pi = {
    on(event: string, callback: typeof handler) {
      assert.equal(event, "message_end");
      handler = callback;
      registrations++;
      return () => {};
    },
  } as unknown as ExtensionAPI;
  streamRecovery(pi);
  assert.equal(registrations, 1);
  assert.ok(handler);
  const event: MessageEndEvent = { type: "message_end", message: failed() };
  assert.ok(handler(event, { signal: undefined } as ExtensionContext));
  const controller = new AbortController();
  controller.abort();
  assert.equal(handler(event, { signal: controller.signal } as ExtensionContext), undefined);
});
