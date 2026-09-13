/**
 * /remote-notify toggle 开关的持久化。
 *
 * 状态写入 ~/.pi/agent/extensions/pi-remote-notify/state.json（与本扩展的 config.json 同目录），
 * 重启 pi 后保持上次的开关状态。默认关闭；读取兼容旧位置
 * ~/.pi/agent/feishu/remote-notify-state.json（2026-09-13 之前，只读不写）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { logError } from './feishu.ts'

const EXTENSION_NAME = 'pi-remote-notify'

/** 状态文件写在扩展自己的目录（pi 只加载该目录下的 .ts/.js，state.json 会被忽略） */
export function statePath(): string {
  return join(getAgentDir(), 'extensions', EXTENSION_NAME, 'state.json')
}

/** 旧位置：仅作读取兜底，不再写入 */
function legacyStatePath(): string {
  return join(getAgentDir(), 'feishu', 'remote-notify-state.json')
}

export type NotifyState = {
  enabled: boolean
}

export function loadState(): NotifyState {
  for (const file of [statePath(), legacyStatePath()]) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { enabled?: unknown }
      return { enabled: parsed?.enabled === true }
    } catch {
      // 读不到就换下一个位置
    }
  }
  return { enabled: false }
}

export function saveState(state: NotifyState): void {
  try {
    const file = statePath()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ enabled: state.enabled }, null, 2) + '\n', 'utf8')
  } catch (err) {
    logError(`failed to save state: ${err instanceof Error ? err.message : String(err)}`)
  }
}