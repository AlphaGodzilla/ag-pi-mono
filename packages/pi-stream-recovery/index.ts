import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  MessageEndEvent,
  MessageEndEventResult,
} from "@earendil-works/pi-coding-agent";

const PREMATURE_STREAM_CLOSE =
  "stream error: stream disconnected before completion: stream closed before response.completed";
const TRANSPORT_ERROR_PREFIX = "Network error [pi-stream-recovery]: ";

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
    message.errorMessage?.trim() !== PREMATURE_STREAM_CLOSE ||
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
