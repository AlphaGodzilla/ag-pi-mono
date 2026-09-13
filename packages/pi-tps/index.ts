/**
 * pi-tps —— 在 pi TUI 中实时显示 LLM 生成速度（MIN / MAX / AVG / CUR，tokens/s）与首字延迟（TTFT）。
 *
 * 规格：SPEC-pi-tps.md ｜ 计划：plan.md ｜ 任务：todo.md T2
 *
 * - 位置：editor 与内置 footer 之间（widget `placement: "belowEditor"`），独占行，不接管内置 footer。
 * - 自适应：`render(width)` 放得下则**左对齐单行**，放不下折成**两行**（第一行 TTFT、第二行 TPS），均左对齐；
 *   单段仍超宽时硬截断——绝不像 `setStatus` 那样被 footer 截掉（footer 把所有扩展状态拼成一行并按宽度截尾）。
 * - 口径：纯生成速度 = 输出 tokens ÷（首个流式更新 → 响应结束），不含 TTFT；
 *   流式中用 CJK 感知估算实时刷新 CUR，结束时用精确 usage.output 校正；MIN/MAX/AVG 只采信精确样本。
 * - 范围：仅当前 session 内存统计，session 重建 / `/reload` 后清零。
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
  computeTps,
  createLatencyStats,
  createStats,
  estimateTokensFromContent,
  formatLatencyText,
  formatTpsParts,
  recordLatency,
  recordSample,
  STATUS_DOT,
  type LatencyStats,
  type TpsStats,
} from "./lib/tps.ts";

const WIDGET_KEY = "pi-tps";
const UPDATE_THROTTLE_MS = 120;

interface TuiLike {
  requestRender(): void;
}

export default function (pi: ExtensionAPI) {
  let ctxRef: ExtensionContext | null = null;
  let tuiRef: TuiLike | null = null;
  let stats: TpsStats = createStats();
  let latencyStats: LatencyStats = createLatencyStats();
  let lastUpdateAt = 0;

  // 当前这一轮流式响应的瞬时状态
  let streaming = false;
  let requestAt: number | null = null;
  let firstDeltaAt: number | null = null;
  let pendingTtftMs: number | null = null;
  let liveTps: number | null = null;

  const resetTurn = (): void => {
    streaming = false;
    firstDeltaAt = null;
    pendingTtftMs = null;
    liveTps = null;
  };

  /** 节流更新：流式期间 message_update 频率很高，强制更新只用于开始/结束。 */
  const scheduleUpdate = (force = false): void => {
    const now = Date.now();
    if (!force && now - lastUpdateAt < UPDATE_THROTTLE_MS) return;
    lastUpdateAt = now;
    tuiRef?.requestRender();
  };

  /** 注册 widget：单行放得下就左对齐一行，放不下折成两行（均左对齐）。 */
  const registerWidget = (ctx: ExtensionContext): void => {
    ctx.ui.setWidget(
      WIDGET_KEY,
      (tui, theme) => {
        tuiRef = tui;
        return {
          render(width: number): string[] {
            const { head, cur } = formatTpsParts(stats, liveTps, streaming);
            const ttft = formatLatencyText(latencyStats, pendingTtftMs);
            // 与内置 footer 的 pwd/统计行保持一致：整体 dim；仅流式中的 CUR 用 accent 高亮
            const dim = (s: string) => theme.fg("dim", s);
            const curText = streaming ? theme.fg("accent", cur) : dim(cur);

            const onePlain = `${ttft} ${STATUS_DOT} ${head}${cur}`;
            if (visibleWidth(onePlain) <= width) {
              return [dim(`${ttft} ${STATUS_DOT} ${head}`) + curText];
            }

            // 折成两行：第一行 TTFT、第二行 TPS；单行仍超宽时硬截断
            const ttftLine = dim(ttft);
            const tpsLinePlain = `${head}${cur}`;
            const tpsLine = dim(head) + curText;
            return [
              visibleWidth(ttftLine) <= width ? ttftLine : truncateToWidth(ttftLine, width, dim("…")),
              visibleWidth(tpsLinePlain) <= width ? tpsLine : truncateToWidth(tpsLinePlain, width, dim("…")),
            ];
          },
          invalidate(): void {},
          dispose(): void {
            tuiRef = null;
          },
        };
      },
      { placement: "belowEditor" },
    );
  };

  pi.on("session_start", async (_event, ctx) => {
    try {
      if (ctx.mode !== "tui") return; // 非 TUI 模式零副作用
      ctxRef = ctx;
      stats = createStats();
      latencyStats = createLatencyStats();
      resetTurn();
      registerWidget(ctx);
      scheduleUpdate(true);
    } catch {
      // 静默降级：UI 异常不得影响主 agent
    }
  });

  pi.on("message_start", async (event, _ctx) => {
    try {
      if (ctxRef === null) return; // 非 TUI（或 widget 已清理）：零开销
      if (event.message.role !== "assistant") return;
      streaming = true;
      firstDeltaAt = null;
      pendingTtftMs = null;
      liveTps = null;
      // assistant 消息的 timestamp 在 HTTP 请求发出前写入（pi-ai），作为 TTFT 起点
      const ts = event.message.timestamp;
      requestAt = typeof ts === "number" && Number.isFinite(ts) ? ts : Date.now();
      scheduleUpdate(true);
    } catch {
      // ignore
    }
  });

  pi.on("message_update", async (event, _ctx) => {
    try {
      if (ctxRef === null) return;
      const message = event.message;
      if (message.role !== "assistant") return;

      const now = Date.now();
      // 首个流式更新 = 首个 token：既作为生成速度起点（不含 TTFT），也定格本次首字延迟
      const isFirstDelta = firstDeltaAt === null;
      if (isFirstDelta) {
        firstDeltaAt = now;
        pendingTtftMs = requestAt !== null ? now - requestAt : null;
      }

      // 部分 provider（如 Anthropic）流式中就带精确 usage；其余用字符估算
      const tokens =
        message.usage.output > 0 ? message.usage.output : estimateTokensFromContent(message.content);
      // 上一分支保证非 null；显式收敛一次（TS 不跨别名条件收窄 let）
      const deltaStartAt = firstDeltaAt!;
      liveTps = computeTps(tokens, now - deltaStartAt);
      // 首字到达立即刷新一次，让 TTFT 马上可见
      scheduleUpdate(isFirstDelta);
    } catch {
      // ignore
    }
  });

  pi.on("message_end", async (event, _ctx) => {
    try {
      if (ctxRef === null) return;
      const message = event.message;
      if (message.role !== "assistant") return;

      if (streaming && firstDeltaAt !== null && isCountable(message)) {
        const tps = computeTps(message.usage.output, Date.now() - firstDeltaAt);
        if (tps !== null) stats = recordSample(stats, tps);
        // TTFT 与 TPS 同源；TTFT 不受样本门槛限制（它不含窗口塌缩问题）
        if (pendingTtftMs !== null) latencyStats = recordLatency(latencyStats, pendingTtftMs);
      }
      resetTurn();
      scheduleUpdate(true);
    } catch {
      // ignore
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    } catch {
      // ignore
    }
    tuiRef = null;
    resetTurn();
  });
}

/** 样本有效条件：有输出 tokens，且不是错误/中断的响应。 */
function isCountable(message: AssistantMessage): boolean {
  return (
    message.usage.output > 0 &&
    message.stopReason !== "error" &&
    message.stopReason !== "aborted"
  );
}
