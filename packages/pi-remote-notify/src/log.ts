/**
 * 错误日志：写入 ~/.pi/agent/extensions/pi-remote-notify/error.log。
 *
 * 日志写入失败也静默，绝不向 stdout/stderr 输出——避免污染 TUI、
 * 干扰 pi-cmux 的 busy/idle 状态判断。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'

const EXTENSION_NAME = 'pi-remote-notify'

export function logError(line: string): void {
  try {
    const file = join(getAgentDir(), 'extensions', EXTENSION_NAME, 'error.log')
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch {
    // 日志写入失败也静默，绝不影响主流程
  }
}
