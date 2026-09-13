// pi-llm-provider-balance —— 在 pi 状态栏显示当前 provider 对应账户的余额。
//
// 能力：
//  - 进程内单例：同一 pi 进程内所有 session 共享一组定时器与余额数据
//  - session 切换（/new /resume /fork）只替换状态栏目标，不重建/重置定时器
//  - 每 refreshIntervalMs（默认 60s）轮询当前活跃会话 provider 对应的源；未映射 provider 时
//    零请求跳过（所有 session 共享结果与定时器）
//  - 切换模型/提供商（model_select）时立即刷新新 provider 对应的余额源，不等下一个轮询周期
//  - 余额源由当前会话的 provider 决定（provider → 源映射见 config.json 的
//    providerBalanceSources，如 cpa_arb/cpa_mybitx/cpa_mybitx_anthropic → derouter、
//    deepseek → deepseek 官方账户）；provider 不在映射表时不显示本插件状态项（清除）
//  - /derouter-refresh 命令手动立即刷新全部已配置源（含 /balance-refresh 别名）
//  - 各源失败保留旧值 + 错误标记；从未成功显示 unavailable；绝不抛出影响主 agent
//
// 单例机制：pi 对扩展工厂做缓存（同 cwd 未 /reload 时复用同一闭包，见
// loader.js loadExtensionsCached），因此本文件模块级状态（stores/timer/displays）
// 天然跨 session 实例共享；仅 /reload 或切换项目 cwd 才重新求值模块（预期行为）。
// 定时器清理判据是“本模块已无活跃显示目标”（session_shutdown 后 displays 清空）：
// 模块作废（quit / reload / 跨 cwd 会话替换）或会话结束时清 interval；
// 仍有其它存活会话则保留。切换会话后由新 session_start 重建并首拉一次。
//
// 配置文件查找顺序（先命中先用）：
//   1. ~/.pi/agent/extensions/pi-llm-provider-balance/config.json（用户配置，推荐；不在仓库内）
//   2. 本包目录 config.json（开发期/旧位置，兜底）
// 格式 ——
//   {
//     "derouterClientKey": "...",              // derouter client key（必需，否则 derouter 源不可用）
//     "refreshIntervalMs": 600000,             // 可选，轮询间隔
//     "deepseekApiKey": "...",                 // DeepSeek API key（查询官方账户余额用）
//     "providerBalanceSources": {              // 可选，provider → 余额源对应关系
//       "cpa_arb": "derouter",
//       "cpa_mybitx": "derouter",
//       "cpa_mybitx_anthropic": "derouter",
//       "deepseek": "deepseek"
//     }
//   }
// 安全：client key / api key 只在本模块内用于请求头，绝不打印/写日志/注入 LLM 上下文。
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractRemaining, formatRemaining, buildAuthHeaders } from './lib/balance.ts'
import { extractDeepseekBalance, formatDeepseekBalance } from './lib/deepseek.ts'

const STATUS_ID = 'pi-llm-provider-balance'
const DEROUTER_API_URL = 'https://cf-api.derouter.ai/sub-key/balance'
const DEEPSEEK_API_URL = 'https://api.deepseek.com/user/balance'
const DEFAULT_INTERVAL_MS = 60_000
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url))
const EXTENSION_NAME = 'pi-llm-provider-balance'

/**
 * 配置文件路径：优先用户配置目录，缺失时回落到包目录内（旧位置）。
 * 用户配置目录刻意放在 ~/.pi/agent/extensions/<扩展名>/ —— pi 只把该目录下的 .ts/.js
 * 以及含 index.ts/package.json 的子目录当扩展加载，只放 config.json 的子目录会被跳过。
 */
export function resolveConfigPath(): string {
  const userConfig = join(getAgentDir(), 'extensions', EXTENSION_NAME, 'config.json')
  return existsSync(userConfig) ? userConfig : join(EXTENSION_DIR, 'config.json')
}

/** 余额源类型：derouter 中转账户 / DeepSeek 官方账户 */
type BalanceSource = 'derouter' | 'deepseek'

const SOURCE_LABELS: Record<BalanceSource, string> = {
  derouter: 'Derouter',
  deepseek: 'DeepSeek',
}

interface ExtensionConfig {
  derouterClientKey: string
  refreshIntervalMs?: number
  deepseekApiKey?: string
  /** provider 名 → 余额源；不在表中的 provider 不显示本插件状态项（清除） */
  providerBalanceSources?: Record<string, BalanceSource>
}

export function loadConfig(): ExtensionConfig {
  let cfg: ExtensionConfig
  try {
    const raw = readFileSync(resolveConfigPath(), 'utf8')
    cfg = JSON.parse(raw) as ExtensionConfig
  } catch {
    // 配置缺失/非法：退化为空 key，refresh 走错误态，不阻塞启动
    cfg = { derouterClientKey: '' }
  }
  // 测试逃生舱：环境变量可覆盖 key（node --test 注入用，不触碰 config.json），
  // 正常运行不设这两个变量时行为与 config.json 完全一致。
  const clientKey = process.env.DEROUTER_BALANCE_CLIENT_KEY
  const deepseekKey = process.env.DEROUTER_BALANCE_DEEPSEEK_API_KEY
  if (clientKey !== undefined) cfg.derouterClientKey = clientKey
  if (deepseekKey !== undefined) cfg.deepseekApiKey = deepseekKey
  return cfg
}

// ---- 进程内共享单例状态（跨 session 实例共享） ----
const cfg = loadConfig()
/** 每个余额源独立缓存：金额 + 币种（deepseek 用）+ 失败标记 */
const stores: Record<BalanceSource, { amount: number | null; currency: 'CNY' | 'USD' | null; lastError: boolean }> = {
  derouter: { amount: null, currency: null, lastError: false },
  deepseek: { amount: null, currency: null, lastError: false },
}
const displays = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
const refreshing = new Set<BalanceSource>()
/** 各会话实例的活跃源贡献（实例标识 → 源）：定时轮询只刷这些源，未映射会话不贡献 */
const instanceSources = new Map<object, BalanceSource>()

/** 映射表引用的全部源（仅手动全刷用；定时轮询只刷活跃会话对应的源） */
function configuredSources(): BalanceSource[] {
  const seen = new Set<BalanceSource>()
  for (const value of Object.values(cfg.providerBalanceSources ?? {})) {
    if (value === 'derouter' || value === 'deepseek') seen.add(value)
  }
  return [...seen]
}


async function fetchDerouter(clientKey: string): Promise<number> {
  const res = await fetch(DEROUTER_API_URL, {
    headers: buildAuthHeaders(clientKey),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    throw new Error(`derouter API HTTP ${res.status}`)
  }
  const remaining = extractRemaining(await res.json())
  if (remaining === null) {
    throw new Error('derouter response missing remaining')
  }
  return remaining
}

async function fetchDeepseek(apiKey: string): Promise<{ currency: 'CNY' | 'USD'; total: number }> {
  const key = apiKey.trim()
  if (!key) throw new Error('deepseek api key is empty')
  const res = await fetch(DEEPSEEK_API_URL, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    throw new Error(`deepseek API HTTP ${res.status}`)
  }
  const balance = extractDeepseekBalance(await res.json())
  if (balance === null) {
    throw new Error('deepseek response missing usable balance')
  }
  return balance
}

/** 单源拉取并写回共享 store；失败保留旧值并置 lastError。 */
async function refreshSource(source: BalanceSource): Promise<void> {
  if (refreshing.has(source)) return
  refreshing.add(source)
  const store = stores[source]
  try {
    if (source === 'derouter') {
      store.amount = await fetchDerouter(cfg.derouterClientKey)
    } else {
      const balance = await fetchDeepseek(cfg.deepseekApiKey ?? '')
      store.amount = balance.total
      store.currency = balance.currency
    }
    store.lastError = false
  } catch {
    store.lastError = true
  } finally {
    refreshing.delete(source)
    broadcast()
  }
}

/** 并发刷新全部已配置源；仅手动命令（/derouter-refresh、/balance-refresh）走这里。 */
async function refreshAll(): Promise<void> {
  await Promise.all(configuredSources().map((s) => refreshSource(s)))
}

/**
 * 定时轮询入口：只刷新当前活跃会话 provider 对应的源。
 * 活跃源为空（provider 未映射 / 无存活会话）时零请求跳过，避免无消费者时后台空转。
 */
async function refreshActiveSources(): Promise<void> {
  const sources = [...new Set(instanceSources.values())]
  await Promise.all(sources.map((s) => refreshSource(s)))
}

/** 当前 provider 对应的余额源；不在映射表返回 null（不显示本插件状态项）。 */
function sourceForProvider(provider: string | undefined): BalanceSource | null {
  if (!provider) return null
  const mapping = cfg.providerBalanceSources
  if (mapping === undefined) {
    // 旧版配置（无 providerBalanceSources 字段）：保持升级前行为，一律按 derouter
    return 'derouter'
  }
  const source = mapping[provider]
  return source === 'derouter' || source === 'deepseek' ? source : null
}

function formatAmount(source: BalanceSource): string {
  const store = stores[source]
  if (source === 'deepseek' && store.currency !== null) {
    return formatDeepseekBalance({ currency: store.currency, total: store.amount ?? 0 })
  }
  return formatRemaining(store.amount ?? 0)
}

function renderTo(ctx: ExtensionContext): void {
  const theme = ctx.ui.theme
  const err = (t: string) => (theme ? theme.fg('error', t) : t)
  const source = sourceForProvider(ctx.model?.provider)
  // 当前 provider 未配置余额源（如官方直连 / 未映射 provider / 暂无模型）：
  // 清除本插件状态栏项，不显示任何占位，避免误导
  if (source === null) {
    try {
      ctx.ui.setStatus(STATUS_ID, undefined)
    } catch {
      // 会话已切换/UI 已失效：忽略，绝不向主 agent 抛出
    }
    return
  }
  const label = SOURCE_LABELS[source]
  const store = stores[source]
  let core: string
  if (store.amount === null) {
    // 该源从未成功拉取（key 缺失/接口失败/尚未首拉完成）
    core = `${label}: ${err('unavailable')}`
  } else {
    const base = `${label}: ${formatAmount(source)}`
    core = store.lastError ? base + err(' ⚠') : base
  }
  // 状态栏各扩展状态项由 pi footer 仅以空格拼接、无分隔符，且扩展 API 无法感知左右邻居。
  // 故采用「前缀式」分隔：只在自己文本前加 '· '、不加尾部，整行自然成为 `· A · B · C`，
  // 避免与相邻扩展的 '·' 连成双点，被截尾时也不会残留孤立的 '·'。
  const text = `· ${core}`
  try {
    ctx.ui.setStatus(STATUS_ID, text)
  } catch {
    // 会话已切换/UI 已失效：忽略，绝不向主 agent 抛出
  }
}

function broadcast(): void {
  for (const display of displays) {
    try {
      display()
    } catch {
      // 单个显示目标异常不影响其它目标
    }
  }
}

export default function (pi: ExtensionAPI): void {
  // 每个 session 实例持有自己的显示目标（本实例的 ctx）；
  // displays 集合在模块级共享，broadcast 时各实例渲染到各自状态栏。
  let currentCtx: ExtensionContext | null = null
  const instanceTag = {} // 本实例在模块级 instanceSources 中的键
  /** 更新本实例的活跃源贡献：null = 注销（未映射 provider / 会话结束） */
  const syncSource = (source: BalanceSource | null) => {
    if (source === null) instanceSources.delete(instanceTag)
    else instanceSources.set(instanceTag, source)
  }
  const display = () => {
    if (currentCtx) renderTo(currentCtx)
  }

  pi.on('session_start', (_event, c) => {
    currentCtx = c
    displays.add(display)
    renderTo(c) // 立即用共享数据渲染本 session 状态栏
    const source = sourceForProvider(c.model?.provider)
    syncSource(source) // 登记本实例的活跃源：定时轮询只刷这些源
    if (!timer) {
      // 单例：仅第一个 session 创建定时器；后续切换只复用，不重建、不重置
      timer = setInterval(() => { void refreshActiveSources() }, cfg.refreshIntervalMs ?? DEFAULT_INTERVAL_MS)
    }
    if (source) void refreshSource(source) // 进入会话即刷新其源；未映射 provider 零请求
  })

  pi.on('session_shutdown', () => {
    // 摘除本实例的显示目标;不触碰 stores(进程内单例,跨 session 共享)
    displays.delete(display)
    currentCtx = null
    syncSource(null) // 注销本实例的源贡献：注销后无活跃源的定时轮询零请求
    // 清理判据不看 shutdown reason，而看本模块是否还有活跃显示目标：
    //  displays 清空 = 本模块实例已无任何 UI 消费者 —— 模块作废（quit / reload /
    //  跨 cwd 会话替换时 loader 直接清缓存重新 import，旧实例收不到 reload 通知）
    //  或会话已结束，共享定时器再无用途，必须清除，否则空转泄漏（每周期发网络请求）。
    //  仍有其它 display 存活（多活跃会话之一关闭）则保留，单例语义不变。
    //  会话切换（new/resume/fork）短暂清空后由新 session_start 重建并首拉一次，
    //  等价于“切换会话即刷新余额”。
    if (displays.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  })

  pi.on('model_select', (_event, c) => {
    // 模型/提供商切换：立即用新 provider 渲染（旧缓存/未映射态），
    // 同步更新本实例活跃源（未映射则注销，定时轮询不再刷旧源），
    // 并即时刷新新 provider 对应的余额源，不等下一个轮询周期（refreshing 去重防并发）
    currentCtx = c
    renderTo(c)
    const source = sourceForProvider(c.model?.provider)
    syncSource(source)
    if (source) void refreshSource(source)
  })

  const refreshHandler = async () => { await refreshAll() }
  pi.registerCommand('derouter-refresh', {
    description: '立即刷新当前配置的全部余额源（derouter/DeepSeek）并更新状态栏',
    handler: refreshHandler,
  })
  pi.registerCommand('balance-refresh', {
    description: '立即刷新当前配置的全部余额源（derouter-refresh 的别名）',
    handler: refreshHandler,
  })
}
