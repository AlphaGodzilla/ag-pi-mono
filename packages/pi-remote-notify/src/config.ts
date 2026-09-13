/**
 * remote-notify 配置加载。
 *
 * 凭证与收件人默认复用 ask-question 插件（rpiv-ask-user-question）的飞书配置
 * `~/.config/rpiv-ask-user-question/config.json` 的 `remote.feishu`（已验证可用）；
 * 若缺失/非法则回退到现有飞书桥接 `~/.pi/agent/feishu/`（config.json + bridge.json）。
 * 均可用 PI_FEISHU_NOTIFY_* 环境变量覆盖。
 *
 * 任何来源缺失/非法时返回 null（发送功能静默禁用，不影响其它扩展）。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { Domain } from '@larksuiteoapi/node-sdk'

export type FeishuConfig = {
  appId: string
  appSecret: string
  domain: Domain
  receiveId: string
  receiveIdType: 'chat_id' | 'open_id' | 'user_id' | 'union_id' | 'email'
}

const FEISHU_DIR = join(getAgentDir(), 'feishu')
const ASK_QUESTION_CONFIG = join(homedir(), '.config', 'rpiv-ask-user-question', 'config.json')

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

function resolveDomain(raw: string | undefined): Domain {
  return raw === 'lark' ? Domain.Lark : Domain.Feishu
}

/** 从 ask-question 的 remote.feishu 配置解析（appId/appSecret + 第一个 receiver）。 */
function fromAskQuestion(): Pick<FeishuConfig, 'appId' | 'appSecret' | 'receiveId' | 'receiveIdType'> | null {
  const cfg = readJson<{
    remote?: {
      feishu?: {
        appId?: string
        appSecret?: string
        receivers?: Array<{ type?: string; value?: string }>
      }
    }
  }>(ASK_QUESTION_CONFIG)
  const f = cfg?.remote?.feishu
  if (!f?.appId || !f?.appSecret) return null

  const receiver = (f.receivers ?? []).find((r) => r?.type && r?.value)
  if (!receiver?.type || !receiver?.value) return null

  return {
    appId: f.appId,
    appSecret: f.appSecret,
    receiveId: receiver.value,
    receiveIdType: receiver.type as FeishuConfig['receiveIdType'],
  }
}

/** 从现有飞书桥接解析（config.json 凭证 + bridge.json 会话），兜底来源。 */
function fromFeishuBridge(): Pick<FeishuConfig, 'appId' | 'appSecret' | 'receiveId' | 'receiveIdType'> | null {
  const cfg = readJson<{ appId?: string; appSecret?: string; domain?: string }>(join(FEISHU_DIR, 'config.json'))
  if (!cfg?.appId || !cfg?.appSecret) return null

  const bridge = readJson<{ routes?: Record<string, { chatId?: string; chatType?: string }> }>(
    join(FEISHU_DIR, 'bridge.json'),
  )
  const routes = bridge?.routes
  const firstKey = routes ? Object.keys(routes)[0] : undefined
  const firstRoute = firstKey ? routes?.[firstKey] : undefined
  if (firstRoute?.chatId) {
    return { appId: cfg.appId, appSecret: cfg.appSecret, receiveId: firstRoute.chatId, receiveIdType: 'chat_id' }
  }
  if (firstKey) {
    const m = /^p2p:(ou_[A-Za-z0-9]+)$/.exec(firstKey)
    if (m) return { appId: cfg.appId, appSecret: cfg.appSecret, receiveId: m[1], receiveIdType: 'open_id' }
  }
  return null
}

export function loadFeishuConfig(): FeishuConfig | null {
  // 环境变量优先（显式覆盖）
  const envAppId = process.env.PI_FEISHU_NOTIFY_APP_ID
  const envAppSecret = process.env.PI_FEISHU_NOTIFY_APP_SECRET
  const envChatId = process.env.PI_FEISHU_NOTIFY_CHAT_ID
  const envOpenId = process.env.PI_FEISHU_NOTIFY_OPEN_ID
  const envDomain = process.env.PI_FEISHU_NOTIFY_DOMAIN

  if (envAppId && envAppSecret) {
    const receiveId = envChatId ?? envOpenId ?? ''
    if (!receiveId) return null
    return {
      appId: envAppId,
      appSecret: envAppSecret,
      domain: resolveDomain(envDomain),
      receiveId,
      receiveIdType: envChatId ? 'chat_id' : 'open_id',
    }
  }

  // ask-question 配置（已验证可用）优先，现有桥接兜底
  const source = fromAskQuestion() ?? fromFeishuBridge()
  if (!source) return null

  const domain = resolveDomain(envDomain ?? readJson<{ domain?: string }>(join(FEISHU_DIR, 'config.json'))?.domain)
  return { ...source, domain }
}