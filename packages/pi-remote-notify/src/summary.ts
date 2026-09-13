/**
 * 从当前会话分支中提取"最近一次工作"的摘要。
 *
 * 取分支中最后一个 user 消息（最近一次请求）作为起点，到分支末尾为止：
 *  - prompt：本次请求原文
 *  - tools：assistant 消息中 toolCall 的工具名及调用次数
 *  - finalAnswer：最后一条 assistant 文本回复（结论）
 *  - errors：本次工作中出现错误的工具名
 *
 * entry 结构遵循 pi 的 session-format.md（SessionManager.getBranch 返回 root→leaf）。
 */
import type { SessionManager } from '@earendil-works/pi-coding-agent'

// 只依赖只读的分支读取能力：pi 的 ExtensionContext 暴露的是 ReadonlySessionManager
type SessionBranchReader = Pick<SessionManager, 'getBranch'>
type ContentBlock = {
  type?: string
  text?: string
  name?: string
}

type SessionEntry = {
  type?: string
  message?: {
    role?: string
    content?: unknown
    isError?: boolean
    toolName?: string
  }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const block = part as ContentBlock
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

function extractToolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const names: string[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const block = part as ContentBlock
    if (block.type === 'toolCall' && typeof block.name === 'string') names.push(block.name)
  }
  return names
}

export type WorkSummary = {
  prompt: string
  finalAnswer: string
  tools: Array<{ name: string; count: number }>
  errors: string[]
}

export function extractWorkSummary(sm: SessionBranchReader): WorkSummary {
  const branch = (sm.getBranch() ?? []) as SessionEntry[]

  // 最近的 user 消息索引（root→leaf 顺序，从后往前找）
  let startIdx = -1
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]
    if (entry?.type === 'message' && entry.message?.role === 'user') {
      startIdx = i
      break
    }
  }
  const slice = startIdx >= 0 ? branch.slice(startIdx) : branch

  let prompt = ''
  let finalAnswer = ''
  const toolCount = new Map<string, number>()
  const errors: string[] = []

  for (const entry of slice) {
    if (entry?.type !== 'message' || !entry.message) continue
    const { role, content } = entry.message

    if (role === 'user') {
      if (!prompt) prompt = extractText(content).trim()
    } else if (role === 'assistant') {
      for (const name of extractToolNames(content)) {
        toolCount.set(name, (toolCount.get(name) ?? 0) + 1)
      }
      const text = extractText(content).trim()
      if (text) finalAnswer = text
    } else if (role === 'toolResult' && entry.message.isError) {
      const name = entry.message.toolName
      if (name && !errors.includes(name)) errors.push(name)
    }
  }

  const tools = [...toolCount.entries()].map(([name, count]) => ({ name, count }))
  return { prompt, finalAnswer, tools, errors }
}

function truncate(text: string, limit: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit - 3)}...`
}

/** 组装"任务完成"的飞书文本通知。 */
export function formatTaskDoneSummary(s: WorkSummary, cwd: string, elapsedSec: number): string {
  const lines: string[] = ['✅ 任务完成']
  lines.push(`📍 目录: ${cwd}`)
  if (s.prompt) lines.push(`📝 请求: ${truncate(s.prompt, 200)}`)
  if (s.tools.length > 0) {
    const toolText = s.tools
      .slice(0, 8)
      .map((t) => (t.count > 1 ? `${t.name}×${t.count}` : t.name))
      .join(', ')
    lines.push(`🛠 工具: ${toolText}${s.tools.length > 8 ? ' …' : ''}`)
  }
  if (s.finalAnswer) lines.push(`💬 结论: ${truncate(s.finalAnswer, 500)}`)
  if (s.errors.length > 0) lines.push(`⚠️ 出错工具: ${s.errors.join(', ')}`)
  lines.push(`⏱ 耗时: ${elapsedSec}s`)
  return lines.join('\n')
}