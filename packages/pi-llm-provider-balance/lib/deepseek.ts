// 纯逻辑：DeepSeek 账户余额解析与格式化（https://api-docs.deepseek.com/zh-cn/api/get-user-balance）
// 约定：本文件不 import pi API、无网络、无定时器，可独立单测。
//
// 接口：GET https://api.deepseek.com/user/balance  (Authorization: Bearer <key>)
// 响应示例：
//   {
//     "is_available": true,
//     "balance_infos": [
//       { "currency": "CNY", "total_balance": "110.00",
//         "granted_balance": "10.00", "topped_up_balance": "100.00" }
//     ]
//   }
// 注意：余额字段是字符串；currency 只可能是 CNY / USD。

export interface DeepseekBalance {
  /** 币种：CNY 或 USD（接口枚举值，其余币种视为非法响应） */
  currency: 'CNY' | 'USD'
  /** 总的可用余额（赠金 + 充值），已转为 number */
  total: number
}

/**
 * 从 API 响应中提取账户总余额。
 * is_available 非 true（key 无效/账户不可用）、balance_infos 为空、
 * 币种非 CNY/USD、total_balance 非法 → 一律返回 null。
 */
export function extractDeepseekBalance(payload: unknown): DeepseekBalance | null {
  if (typeof payload !== 'object' || payload === null) return null
  const rec = payload as Record<string, unknown>
  if (rec.is_available !== true) return null
  const infos = rec.balance_infos
  if (!Array.isArray(infos) || infos.length === 0) return null
  const first = infos[0]
  if (typeof first !== 'object' || first === null) return null
  const info = first as Record<string, unknown>
  const currency = info.currency
  if (currency !== 'CNY' && currency !== 'USD') return null
  const raw = info.total_balance
  if (typeof raw !== 'string' || raw.trim() === '') return null  // 空串 Number('')===0，需显式拒绝
  const total = Number(raw)
  if (!Number.isFinite(total)) return null
  return { currency, total }
}

/**
 * 格式化为货币文案：CNY → "¥110.00"、USD → "$110.00"；负数形如 "-¥5.00"。
 * （防御负数：接口余额不应为负，但解析层不做假设）
 */
export function formatDeepseekBalance(balance: { currency: string; total: number }): string {
  const prefix = balance.currency === 'USD' ? '$' : '¥'
  const sign = balance.total < 0 ? '-' : ''
  return `${sign}${prefix}${Math.abs(balance.total).toFixed(2)}`
}
