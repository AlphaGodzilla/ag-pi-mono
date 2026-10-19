import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  MessageEndEvent,
  MessageEndEventResult,
} from "@earendil-works/pi-coding-agent";

const PREMATURE_STREAM_CLOSE =
  "stream error: stream disconnected before completion: stream closed before response.completed";
// OpenAI 兼容网关（如 opencode-go）在首个带 finish_reason 的 chunk 之前断开连接。
const GATEWAY_PREMATURE_STREAM_CLOSE =
  "upstream stream closed before any chunk carried finish_reason";
// 部分通道把原始错误包装成 `Error: ...` 再上报，比较前只剥掉这一层前缀。
const LEADING_ERROR_LABEL = /^error:\s*/i;
const TRANSPORT_ERROR_PREFIX = "Network error [pi-stream-recovery]: ";

/** 原签名保持精确匹配；新增签名忽略大小写，并容忍 `Error:` 包装前缀。 */
function isPrematureStreamClose(errorMessage: string | undefined): boolean {
  const text = errorMessage?.trim();
  if (text === PREMATURE_STREAM_CLOSE) return true;
  return text?.replace(LEADING_ERROR_LABEL, "").trim().toLowerCase() === GATEWAY_PREMATURE_STREAM_CLOSE;
}

/** 只补齐已确认的断流分类；原文、失败状态和工具内容保持不变。 */
export function normalizeStreamError(
  message: MessageEndEvent["message"],
  cancelled = false,
  classify: typeof isRetryableAssistantError = isRetryableAssistantError,
): MessageEndEventResult | undefined {
  if (
    cancelled ||
    message.role !== "assistant" ||
    message.stopReason !== "error" ||
    !isPrematureStreamClose(message.errorMessage) ||
    classify(message)
  ) {
    return undefined;
  }

  return {
    message: {
      ...message,
      errorMessage: TRANSPORT_ERROR_PREFIX + message.errorMessage,
    },
  };
}

export default function streamRecovery(pi: ExtensionAPI): void {
  pi.on("message_end", (event, ctx) =>
    normalizeStreamError(event.message, ctx.signal?.aborted === true),
  );
}
