// 手动抓取余额：读同目录 config.json，调真实 API，打印余额。
// 用法：node scripts/manual-fetch.mjs [derouter|deepseek]
//   derouter  — 打印 derouter remaining（默认）
//   deepseek  — 打印 DeepSeek total_balance + currency
// 说明：仅打印余额与错误状态，绝不打印任何 key。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const root = join(dir, '..')
const EXTENSION_NAME = 'pi-llm-provider-balance'

// 与 index.ts 一致：用户配置目录优先，缺失时回落包目录
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')
const userConfig = join(agentDir, 'extensions', EXTENSION_NAME, 'config.json')
const cfgPath = existsSync(userConfig) ? userConfig : join(root, 'config.json')
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))

const source = process.argv[2] === 'deepseek' ? 'deepseek' : 'derouter'
const keyField = source === 'derouter' ? 'derouterClientKey' : 'deepseekApiKey'
const key = (cfg[keyField] ?? '').trim()
if (!key) {
  console.error(`配置缺少 ${keyField}，请先填入真实 key 再运行：${cfgPath}`)
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
