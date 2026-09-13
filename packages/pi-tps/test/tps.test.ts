/**
 * lib/tps.ts 纯逻辑单元测试（node --test）。
 * 只覆盖纯函数，不涉及 pi 运行时与 TUI。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  averageLatencyMs,
  averageTps,
  CJK_TOKENS_PER_CHAR,
  computeTps,
  createLatencyStats,
  createStats,
  estimateTokens,
  estimateTokensFromContent,
  formatLatencyText,
  formatSeconds,
  formatStatusSegments,
  formatStatusText,
  formatTpsParts,
  formatValue,
  isCjk,
  MIN_SAMPLE_TOKENS,
  MIN_SAMPLE_WINDOW_MS,
  recordLatency,
  recordSample,
  STATUS_DOT,
  type LatencyStats,
  type TpsStats,
} from "../lib/tps.ts";

// ---------- createStats ----------

test("createStats: 初始为空统计", () => {
  assert.deepEqual(createStats(), { min: null, max: null, current: null, total: 0, samples: 0 });
});

// ---------- computeTps ----------

test("computeTps: 正常换算 tokens/秒（含门槛边界）", () => {
  assert.equal(computeTps(100, 2000), 50);
  assert.equal(computeTps(30, 1000), 30);
  assert.equal(computeTps(MIN_SAMPLE_TOKENS, MIN_SAMPLE_WINDOW_MS), 40); // 边界值通过
});

test("computeTps: 样本过小（窗口塌缩伪影）返回 null", () => {
  assert.equal(computeTps(MIN_SAMPLE_TOKENS - 1, 5000), null); // 输出 < 20 tokens
  assert.equal(computeTps(1000, MIN_SAMPLE_WINDOW_MS - 1), null); // 窗口 < 500ms
  assert.equal(computeTps(49, 37), null); // 实测伪影：49 tok / 37ms ≈ 1308 t/s
});

test("computeTps: 非法输入返回 null", () => {
  assert.equal(computeTps(0, 1000), null);
  assert.equal(computeTps(100, 0), null);
  assert.equal(computeTps(-1, 1000), null);
  assert.equal(computeTps(100, -5), null);
  assert.equal(computeTps(Number.NaN, 1000), null);
  assert.equal(computeTps(100, Number.NaN), null);
  assert.equal(computeTps(Number.POSITIVE_INFINITY, 1000), null);
  assert.equal(computeTps(100, Number.POSITIVE_INFINITY), null);
});

// ---------- recordSample ----------

test("recordSample: 首个样本同时设置 min/max/current", () => {
  const stats = recordSample(createStats(), 30);
  assert.deepEqual(stats, { min: 30, max: 30, current: 30, total: 30, samples: 1 });
});

test("recordSample: 后续样本只更新对应极值与 current", () => {
  let stats = recordSample(createStats(), 30);
  stats = recordSample(stats, 10);
  assert.deepEqual(stats, { min: 10, max: 30, current: 10, total: 40, samples: 2 });

  stats = recordSample(stats, 50);
  assert.deepEqual(stats, { min: 10, max: 50, current: 50, total: 90, samples: 3 });

  stats = recordSample(stats, 30);
  assert.deepEqual(stats, { min: 10, max: 50, current: 30, total: 120, samples: 4 });
});

test("recordSample: 相等值不破坏极值", () => {
  let stats = recordSample(createStats(), 25);
  stats = recordSample(stats, 25);
  assert.deepEqual(stats, { min: 25, max: 25, current: 25, total: 50, samples: 2 });
});

test("recordSample: 无效样本原样返回（同一引用）", () => {
  const stats = recordSample(createStats(), 30);
  for (const bad of [null, Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
    assert.equal(recordSample(stats, bad), stats);
  }
});

test("recordSample: 不可变更新，不修改入参", () => {
  const original = createStats();
  const next = recordSample(original, 42);
  assert.deepEqual(original, { min: null, max: null, current: null, total: 0, samples: 0 });
  assert.notEqual(next, original);
});

test("averageTps: 无样本返回 null", () => {
  assert.equal(averageTps(createStats()), null);
});

test("averageTps: 单样本等于该样本", () => {
  assert.equal(averageTps(recordSample(createStats(), 30)), 30);
});

test("averageTps: 多样本为算术平均", () => {
  let stats = recordSample(createStats(), 30);
  stats = recordSample(stats, 10);
  stats = recordSample(stats, 50);
  stats = recordSample(stats, 30);
  assert.equal(averageTps(stats), 30); // (30+10+50+30)/4
  assert.equal(stats.total, 120);
});

// ---------- isCjk / estimateTokens ----------

test("isCjk: 汉字、全角标点为真，ASCII/emoji 为假", () => {
  assert.equal(isCjk("你"), true);
  assert.equal(isCjk("好"), true);
  assert.equal(isCjk("，"), true); // 全角逗号
  assert.equal(isCjk("a"), false);
  assert.equal(isCjk("1"), false);
  assert.equal(isCjk(" "), false);
  assert.equal(isCjk("🙂"), false);
});

test("estimateTokens: 空串为 0", () => {
  assert.equal(estimateTokens(""), 0);
});

test("estimateTokens: 纯 ASCII 按 chars/4 向上取整", () => {
  assert.equal(estimateTokens("hello"), Math.ceil(5 / 4));
  assert.equal(estimateTokens("abcdefgh"), 2);
});

test("estimateTokens: 中文按 0.75 token/字 向上取整", () => {
  assert.equal(estimateTokens("你好"), Math.ceil(2 * CJK_TOKENS_PER_CHAR));
  assert.equal(estimateTokens("你好世界"), Math.ceil(4 * CJK_TOKENS_PER_CHAR));
});

test("estimateTokens: 中英混排相加后取整", () => {
  const expected = Math.ceil(2 * CJK_TOKENS_PER_CHAR + 3 / 4);
  assert.equal(estimateTokens("你好abc"), expected);
});

test("estimateTokens: emoji 按非 CJK 计数", () => {
  assert.equal(estimateTokens("🙂"), Math.ceil(1 / 4));
});

// ---------- estimateTokensFromContent ----------

test("estimateTokensFromContent: 空/未定义内容为 0", () => {
  assert.equal(estimateTokensFromContent([]), 0);
  assert.equal(estimateTokensFromContent(undefined), 0);
});

test("estimateTokensFromContent: text 与 thinking 块", () => {
  assert.equal(estimateTokensFromContent([{ type: "text", text: "hello" }]), Math.ceil(5 / 4));
  assert.equal(
    estimateTokensFromContent([{ type: "thinking", thinking: "你好" }]),
    Math.ceil(2 * CJK_TOKENS_PER_CHAR),
  );
});

test("estimateTokensFromContent: toolCall 计 name + arguments", () => {
  const expected = estimateTokens("read") + estimateTokens('{"path":"a.ts"}');
  assert.equal(
    estimateTokensFromContent([{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }]),
    expected,
  );
});

test("estimateTokensFromContent: 未知块类型忽略，缺字段不抛错", () => {
  assert.equal(estimateTokensFromContent([{ type: "image" }]), 0);
  assert.equal(estimateTokensFromContent([{ type: "text" }]), 0);
  assert.equal(estimateTokensFromContent([{ type: "toolCall" }]), 0);
});

// ---------- formatValue / formatTpsParts / formatTpsLine ----------

test("formatValue: 保留 1 位小数，非法值显示 --", () => {
  assert.equal(formatValue(12.34), "12.3");
  assert.equal(formatValue(12.36), "12.4"); // 避开 12.35 的二进制浮点歧义
  assert.equal(formatValue(0), "0.0");
  assert.equal(formatValue(null), "--");
  assert.equal(formatValue(undefined), "--");
  assert.equal(formatValue(Number.NaN), "--");
  assert.equal(formatValue(Number.POSITIVE_INFINITY), "--");
});

test("formatStatusText: 无样本显示占位（含 TTFT 占位与分隔符）", () => {
  assert.equal(
    formatStatusText(createStats(), createLatencyStats()),
    "TTFT -- · MIN -- MAX -- AVG -- CUR -- t/s",
  );
});

test("formatStatusText: 有样本显示 1 位小数（TPS）与 2 位小数（TTFT）", () => {
  const stats: TpsStats = { min: 10, max: 50, current: 30, total: 90, samples: 3 };
  const latency = recordLatency(createLatencyStats(), 850);
  assert.equal(
    formatStatusText(stats, latency),
    "TTFT 0.85s avg 0.85s · MIN 10.0 MAX 50.0 AVG 30.0 CUR 30.0 t/s",
  );
});

test("formatTpsParts: 实时值覆盖 CUR，非法实时值回退（空闲）", () => {
  const stats: TpsStats = { min: 10, max: 50, current: 30, total: 90, samples: 3 };
  assert.equal(formatTpsParts(stats, 42.56).cur, "CUR 42.6 t/s");
  assert.equal(formatTpsParts(stats, null).cur, "CUR 30.0 t/s");
  assert.equal(formatTpsParts(stats, Number.NaN).cur, "CUR 30.0 t/s");
  assert.equal(formatTpsParts(stats, 0).cur, "CUR 30.0 t/s");
  assert.equal(formatTpsParts(stats, 42.56).head, "MIN 10.0 MAX 50.0 AVG 30.0 ");
});

test("formatTpsParts: 流式中未达门槛时 CUR 显示 --", () => {
  const stats: TpsStats = { min: 10, max: 50, current: 30, total: 90, samples: 3 };
  assert.equal(formatTpsParts(stats, null, true).cur, "CUR -- t/s");
  assert.equal(formatTpsParts(stats, null, false).cur, "CUR 30.0 t/s");
  assert.equal(formatTpsParts(stats, 42.5, true).cur, "CUR 42.5 t/s");
});

test("formatStatusText: 与分段拼接结果一致（分隔符 = U+00B7）", () => {
  const stats: TpsStats = { min: 10, max: 50, current: 30, total: 90, samples: 3 };
  const latency = recordLatency(createLatencyStats(), 850);
  const { head, cur } = formatTpsParts(stats, 42.5);
  assert.equal(
    formatStatusText(stats, latency, { liveTps: 42.5 }),
    `${formatLatencyText(latency)} ${STATUS_DOT} ${head}${cur}`,
  );
  assert.equal(STATUS_DOT, "\u00b7");
});

// ---------- formatStatusSegments ----------

test("formatStatusSegments: 无样本的分段", () => {
  const seg = formatStatusSegments(createStats(), createLatencyStats());
  assert.equal(seg.ttft, "TTFT --");
  assert.equal(seg.tps, "MIN -- MAX -- AVG -- CUR -- t/s");
});

test("formatStatusSegments: 有样本时与单行拼接一致", () => {
  const stats: TpsStats = { min: 10, max: 50, current: 30, total: 90, samples: 3 };
  const latency = recordLatency(createLatencyStats(), 850);
  const seg = formatStatusSegments(stats, latency);
  assert.equal(seg.ttft, "TTFT 0.85s avg 0.85s");
  assert.equal(seg.tps, "MIN 10.0 MAX 50.0 AVG 30.0 CUR 30.0 t/s");
  assert.equal(formatStatusText(stats, latency), `${seg.ttft} ${STATUS_DOT} ${seg.tps}`);
});

test("formatStatusSegments: live 值透传（流式中 CUR 与 TTFT）", () => {
  const stats: TpsStats = { min: 10, max: 50, current: 30, total: 90, samples: 3 };
  const latency = recordLatency(createLatencyStats(), 800);
  const seg = formatStatusSegments(stats, latency, {
    liveTps: 42.5,
    liveTtftMs: 2500,
    streaming: true,
  });
  assert.equal(seg.ttft, "TTFT 2.50s avg 0.80s");
  assert.equal(seg.tps, "MIN 10.0 MAX 50.0 AVG 30.0 CUR 42.5 t/s");
});

test("formatStatusSegments: 流式中未达门槛 CUR 显示 --", () => {
  const stats: TpsStats = { min: 10, max: 50, current: 30, total: 90, samples: 3 };
  const seg = formatStatusSegments(stats, createLatencyStats(), { liveTps: null, streaming: true });
  assert.equal(seg.tps, "MIN 10.0 MAX 50.0 AVG 30.0 CUR -- t/s");
});

// ---------- LatencyStats / recordLatency / formatLatencyText ----------

test("createLatencyStats: 初始为空统计", () => {
  assert.deepEqual(createLatencyStats(), { lastMs: null, totalMs: 0, samples: 0 });
});

test("recordLatency: 首个样本设置 last 并累加 total", () => {
  const stats = recordLatency(createLatencyStats(), 850);
  assert.deepEqual(stats, { lastMs: 850, totalMs: 850, samples: 1 });
});

test("recordLatency: 后续样本更新 last、累加 total、平均随之变化", () => {
  let stats = recordLatency(createLatencyStats(), 800);
  stats = recordLatency(stats, 1200);
  assert.deepEqual(stats, { lastMs: 1200, totalMs: 2000, samples: 2 });
  assert.equal(averageLatencyMs(stats), 1000);
});

test("recordLatency: 无效样本原样返回（同一引用）", () => {
  const stats = recordLatency(createLatencyStats(), 850);
  for (const bad of [null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.equal(recordLatency(stats, bad), stats);
  }
  assert.equal(recordLatency(stats, 0).lastMs, 0, "0ms 是合法值");
});

test("averageLatencyMs: 无样本返回 null", () => {
  assert.equal(averageLatencyMs(createLatencyStats()), null);
});

test("formatSeconds: 毫秒转秒保留 2 位小数", () => {
  assert.equal(formatSeconds(0), "0.00");
  assert.equal(formatSeconds(850), "0.85");
  assert.equal(formatSeconds(1234), "1.23");
});

test("formatLatencyText: 无样本显示 TTFT --", () => {
  assert.equal(formatLatencyText(createLatencyStats()), "TTFT --");
});

test("formatLatencyText: 最近一次 + 平均", () => {
  let stats = recordLatency(createLatencyStats(), 800);
  stats = recordLatency(stats, 1200);
  assert.equal(formatLatencyText(stats), "TTFT 1.20s avg 1.00s");
});

test("formatLatencyText: 流式中的 liveMs 覆盖 last，平均仍取已提交样本", () => {
  const stats = recordLatency(createLatencyStats(), 800);
  assert.equal(formatLatencyText(stats, 2500), "TTFT 2.50s avg 0.80s");
  assert.equal(formatLatencyText(stats, null), "TTFT 0.80s avg 0.80s");
  assert.equal(formatLatencyText(stats, Number.NaN), "TTFT 0.80s avg 0.80s");
});

test("formatLatencyText: 首个样本提交前只显示实时值（无 avg 段）", () => {
  assert.equal(formatLatencyText(createLatencyStats(), 250), "TTFT 0.25s");
  assert.equal(formatLatencyText(createLatencyStats()), "TTFT --");
});

test("formatStatusText: liveTtftMs 透传到 TTFT 段", () => {
  const stats: TpsStats = { min: 10, max: 50, current: 30, total: 90, samples: 3 };
  const latency = recordLatency(createLatencyStats(), 800);
  assert.equal(
    formatStatusText(stats, latency, { liveTtftMs: 2500 }),
    "TTFT 2.50s avg 0.80s · MIN 10.0 MAX 50.0 AVG 30.0 CUR 30.0 t/s",
  );
});
