// 纯逻辑：derouter 余额解析与格式化
// 约定：本文件不 import pi API、无网络、无定时器，可独立单测。

export interface BalancePayload {
  budget: number;
  spent: number;
  remaining: number;
}

/** 从 API 响应中提取 remaining；任何非法输入返回 null。 */
export function extractRemaining(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) return null;
  const remaining = (payload as Record<string, unknown>).remaining;
  if (typeof remaining !== "number" || !Number.isFinite(remaining)) return null;
  return remaining;
}

/** 格式化为货币文案，如 150 -> "$150.00"；负数形如 "-$12.50"。 */
export function formatRemaining(remaining: number): string {
  const sign = remaining < 0 ? "-" : "";
  return `${sign}$${Math.abs(remaining).toFixed(2)}`;
}

/** 构造认证请求头；key 空白时抛错，防止静默发无认证请求。 */
export function buildAuthHeaders(clientKey: string): Record<string, string> {
  const key = clientKey.trim();
  if (!key) throw new Error("derouter client key is empty");
  return { Authorization: `Bearer ${key}` };
}
