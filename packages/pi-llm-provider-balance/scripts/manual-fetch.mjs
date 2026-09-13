// 手动抓取余额：读同目录 config.json，调真实 API，打印余额。
// 用法：node scripts/manual-fetch.mjs [derouter|deepseek]
//   derouter  — 打印 derouter remaining（默认）
//   deepseek  — 打印 DeepSeek total_balance + currency
// 说明：仅打印余额与错误状态，绝不打印任何 key。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const root = join(dir, '..')
const cfg = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))

const source = process.argv[2] === 'deepseek' ? 'deepseek' : 'derouter'
const keyField = source === 'derouter' ? 'derouterClientKey' : 'deepseekApiKey'
const key = (cfg[keyField] ?? '').trim()
if (!key) {
  console.error(`config.json 缺少 ${keyField}，请先填入真实 key 再运行`)
  process.exit(1)
}

const API_URL = source === 'derouter'
  ? 'https://cf-api.derouter.ai/sub-key/balance'
  : 'https://api.deepseek.com/user/balance'

let res
try {
  res = await fetch(API_URL, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000), // 10s 超时即放弃，避免接口无响应时挂死
  })
} catch (err) {
  if (err?.name === 'TimeoutError') {
    console.error(`请求 ${source} 接口超时（10s），已放弃`)
  } else {
    console.error(`请求 ${source} 接口失败: ${err instanceof Error ? err.message : String(err)}`)
  }
  process.exit(1)
}
if (!res.ok) {
  console.error(`HTTP ${res.status}: ${await res.text()}`)
  process.exit(1)
}
const payload = await res.json()
if (source === 'derouter') {
  console.log('remaining:', payload.remaining)
} else {
  const info = payload.balance_infos?.[0]
  console.log('is_available:', payload.is_available)
  console.log(`balance: ${info?.currency ?? '?'} ${info?.total_balance ?? '?'} (granted ${info?.granted_balance ?? '?'} / topped_up ${info?.topped_up_balance ?? '?'})`)
}
