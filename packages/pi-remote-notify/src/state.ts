/**
 * /remote-notify toggle 开关的持久化。
 *
 * 状态写入 ~/.pi/agent/feishu/remote-notify-state.json（与现有飞书桥接同目录），
 * 重启 pi 后保持上次的开关状态。默认关闭。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { logError } from './feishu.ts'

const STATE_FILE = join(getAgentDir(), 'feishu', 'remote-notify-state.json')

export type NotifyState = {
  enabled: boolean
}

export function loadState(): NotifyState {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { enabled?: unknown }
    return { enabled: parsed?.enabled === true }
  } catch {
    return { enabled: false }
  }
}

export function saveState(state: NotifyState): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify({ enabled: state.enabled }, null, 2) + '\n', 'utf8')
  } catch (err) {
    logError(`failed to save state: ${err instanceof Error ? err.message : String(err)}`)
  }
}