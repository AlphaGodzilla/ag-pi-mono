/**
 * pi-tps 纯逻辑层：TPS 计算、样本累积、token 估算、状态行格式化。
 *
 * 本文件不 import 任何 pi 包，可用 `node --test` 独立验证（见 SPEC-pi-tps.md）。
 */

export interface TpsStats {
  min: number | null;
  max: number | null;
  current: number | null;
  /** 有效样本累加（tokens/s），用于 AVG */
  total: number;
  samples: number;
}

/** 极简内容块结构，与 pi-ai 的 TextContent / ThinkingContent / ToolCall 结构兼容。 */
export interface PartialBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: unknown;
}

export const CJK_TOKENS_PER_CHAR = 0.75;
export const OTHER_CHARS_PER_TOKEN = 4;

const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3000, 0x303f], // CJK 标点
  [0x3400, 0x4dbf], // 扩展 A
  [0x4e00, 0x9fff], // 基本区
  [0xf900, 0xfaff], // 兼容表意文字
  [0xff00, 0xffef], // 全角形式
  [0x20000, 0x2fa1f], // 扩展 B 及以后（代理对）
];

export function isCjk(char: string): boolean {
  const code = char.codePointAt(0);
  if (code === undefined) return false;
  for (const [lo, hi] of CJK_RANGES) {
    if (code >= lo && code <= hi) return true;
  }
  return false;
}

export function createStats(): TpsStats {
  return { min: null, max: null, current: null, total: 0, samples: 0 };
}

/** 样本有效性门槛：窗口 <500ms 或输出 <20 tokens 的响应视为测量伪影（窗口塌缩），不计入统计。 */
export const MIN_SAMPLE_TOKENS = 20;
export const MIN_SAMPLE_WINDOW_MS = 500;

/**
 * tokens / 秒。
 * 非法输入或样本过小（tokens < MIN_SAMPLE_TOKENS 或窗口 < MIN_SAMPLE_WINDOW_MS）返回 null。
 */
export function computeTps(tokens: number, durationMs: number): number | null {
  if (!Number.isFinite(tokens) || !Number.isFinite(durationMs)) return null;
  if (tokens < MIN_SAMPLE_TOKENS || durationMs < MIN_SAMPLE_WINDOW_MS) return null;
  return tokens / (durationMs / 1000);
}

/** 提交一个精确样本（不可变更新）；无效样本原样返回。 */
export function recordSample(stats: TpsStats, tps: number | null): TpsStats {
  if (tps === null || !Number.isFinite(tps) || tps <= 0) return stats;
  return {
    min: stats.min === null ? tps : Math.min(stats.min, tps),
    max: stats.max === null ? tps : Math.max(stats.max, tps),
    current: tps,
    total: stats.total + tps,
    samples: stats.samples + 1,
  };
}

/** 平均 TPS（tokens/s）；无样本返回 null。 */
export function averageTps(stats: TpsStats): number | null {
  return stats.samples > 0 ? stats.total / stats.samples : null;
}

/** CJK 感知 token 估算：CJK≈0.75 token/字，其余按 chars/4（pi 官方估算口径）。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (isCjk(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk * CJK_TOKENS_PER_CHAR + other / OTHER_CHARS_PER_TOKEN);
}

/** 估算流式 partial message 的累计输出 tokens（text / thinking / toolCall 参数）。 */
export function estimateTokensFromContent(blocks: readonly PartialBlock[] | undefined): number {
  if (!blocks) return 0;
  let total = 0;
  for (const block of blocks) {
    if (block.type === "text") {
      total += estimateTokens(block.text ?? "");
    } else if (block.type === "thinking") {
      total += estimateTokens(block.thinking ?? "");
    } else if (block.type === "toolCall") {
      total += estimateTokens(block.name ?? "");
      total += estimateTokens(safeJson(block.arguments));
    }
  }
  return total;
}

function safeJson(value: unknown): string {
  try {
    return value === undefined ? "" : JSON.stringify(value);
  } catch {
    return "";
  }
}

export function formatValue(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "--";
}

/**
 * 状态文本分段：`head`（MIN/MAX/AVG）+ `cur`（CUR + t/s）。
 * `liveTps` 为流式实时估算值；`streaming` 为 true 时未达门槛（liveTps 无效）显示 `--`，
 * 空闲（streaming=false）时回退到最近一次已提交样本 `stats.current`。
 * 分段返回是为了让调用方只给流式中的 CUR 着色（其余保持默认色）。
 */
export function formatTpsParts(
  stats: TpsStats,
  liveTps: number | null = null,
  streaming = false,
): { head: string; cur: string } {
  const useLive = typeof liveTps === "number" && Number.isFinite(liveTps) && liveTps > 0;
  const cur = useLive ? liveTps : streaming ? null : stats.current;
  return {
    head: `MIN ${formatValue(stats.min)} MAX ${formatValue(stats.max)} AVG ${formatValue(averageTps(stats))} `,
    cur: `CUR ${formatValue(cur)} t/s`,
  };
}

/** 状态文本分隔符，与 pi-llm-provider-balance 一致（U+00B7 MIDDLE DOT）。 */
export const STATUS_DOT = "·";

/** 首字延迟（TTFT）统计：最近一次 + 本次会话平均。 */
export interface LatencyStats {
  /** 最近一次 TTFT（毫秒），无样本为 null */
  lastMs: number | null;
  /** 有效样本累加（毫秒），用于平均 */
  totalMs: number;
  samples: number;
}

export function createLatencyStats(): LatencyStats {
  return { lastMs: null, totalMs: 0, samples: 0 };
}

/** 追加一个 TTFT 样本（毫秒）；无效值（null/非有限/负数）原样返回。 */
export function recordLatency(stats: LatencyStats, ms: number | null): LatencyStats {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return stats;
  return { lastMs: ms, totalMs: stats.totalMs + ms, samples: stats.samples + 1 };
}

/** 平均 TTFT（毫秒）；无样本返回 null。 */
export function averageLatencyMs(stats: LatencyStats): number | null {
  return stats.samples > 0 ? stats.totalMs / stats.samples : null;
}

/** 毫秒 → 秒（2 位小数）。 */
export function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(2);
}

/**
 * `TTFT 0.85s avg 1.10s`；尚无已提交样本但有实时值时 `TTFT 0.85s`；无任何值时 `TTFT --`。
 * `liveMs` 为流式中已测得但尚未提交的首字延迟（等待期为 null → 回退到最近一次已提交值）；
 * 平均值只统计已提交样本。
 */
export function formatLatencyText(stats: LatencyStats, liveMs: number | null = null): string {
  const useLive = typeof liveMs === "number" && Number.isFinite(liveMs) && liveMs >= 0;
  const last = useLive ? liveMs : stats.lastMs;
  if (last === null) return "TTFT --";
  const avg = averageLatencyMs(stats);
  if (avg === null) return `TTFT ${formatSeconds(last)}s`;
  return `TTFT ${formatSeconds(last)}s avg ${formatSeconds(avg)}s`;
}

/**
 * 单行状态文本：`TTFT a s avg b s · MIN x MAX y AVG z CUR w t/s`。
 * `·` 仅作 TTFT 组与 TPS 组的内部隔符；widget 独占一行，前后不再加 `·`。
 */
export interface StatusTextView {
  /** 流式中的实时估算值（未达门槛时传 null） */
  liveTps?: number | null;
  /** 流式中已测得、尚未提交的 TTFT（毫秒） */
  liveTtftMs?: number | null;
  /** 是否处于流式响应中（true 时 CUR 未达门槛显示 --） */
  streaming?: boolean;
}

/** 状态文本分段（纯文本、不含分隔符）：`ttft` = `TTFT …`，`tps` = `MIN … MAX … AVG … CUR … t/s`。 */
export function formatStatusSegments(
  stats: TpsStats,
  latency: LatencyStats,
  view: StatusTextView = {},
): { ttft: string; tps: string } {
  const { head, cur } = formatTpsParts(stats, view.liveTps ?? null, view.streaming ?? false);
  return { ttft: formatLatencyText(latency, view.liveTtftMs ?? null), tps: `${head}${cur}` };
}

/** 单行状态文本：`TTFT a s avg b s · MIN x MAX y AVG z CUR w t/s`（前后无 `·`）。 */
export function formatStatusText(
  stats: TpsStats,
  latency: LatencyStats,
  view: StatusTextView = {},
): string {
  const seg = formatStatusSegments(stats, latency, view);
  return `${seg.ttft} ${STATUS_DOT} ${seg.tps}`;
}
