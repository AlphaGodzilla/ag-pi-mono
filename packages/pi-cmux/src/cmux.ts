import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

type PiExecResult = {
  stdout?: string
  stderr?: string
  code?: number
  killed?: boolean
}

export type CmuxNotifyOptions = {
  title: string
  subtitle?: string
  body?: string
  workspace?: string
  surface?: string
  signal?: AbortSignal
}

const CMUX_TIMEOUT_MS = 3000

/** cmux 服务 socket 的默认位置（无 CMUX_SOCKET_PATH 时使用）。 */
const DEFAULT_CMUX_SOCKET_PATH = join(homedir(), '.local', 'state', 'cmux', 'cmux.sock')

/** PATH 中找不到 cmux CLI 时的兜底绝对路径（macOS 用户级安装标准位置）。 */
const FALLBACK_CMUX_BINARY = '/Applications/cmux.app/Contents/Resources/bin/cmux'

function cmuxBinaryInPath(env: NodeJS.ProcessEnv = process.env): boolean {
  const pathEntries = (env.PATH ?? '').split(':').filter(Boolean)
  return pathEntries.some((dir) => existsSync(join(dir, 'cmux')))
}

/** 解析可执行的 cmux 命令：优先 PATH，找不到则回退到安装绝对路径。 */
function resolveCmuxCommand(env: NodeJS.ProcessEnv = process.env): string {
  return cmuxBinaryInPath(env) ? 'cmux' : FALLBACK_CMUX_BINARY
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function normalizeExecResult(value: unknown): PiExecResult {
  if (!value || typeof value !== 'object') return {}
  return {
    stdout: readString('stdout' in value ? value.stdout : undefined),
    stderr: readString('stderr' in value ? value.stderr : undefined),
    code: readNumber('code' in value ? value.code : undefined),
    killed: readBoolean('killed' in value ? value.killed : undefined),
  }
}

export function isCmuxEnvironment(env: NodeJS.ProcessEnv = process.env) {
  if (env.CMUX_WORKSPACE_ID && env.CMUX_SURFACE_ID) return true
  // 宽松判定：pi 进程可能未继承 CMUX_* 环境变量（由 shell-integration 注入），
  // 此时只要 cmux 服务 socket 可达且 CLI 可用，仍视为 cmux 环境。
  const socketPath = env.CMUX_SOCKET_PATH || DEFAULT_CMUX_SOCKET_PATH
  return existsSync(socketPath) && (cmuxBinaryInPath(env) || existsSync(FALLBACK_CMUX_BINARY))
}

export async function runCmux(
  pi: ExtensionAPI,
  args: string[],
  options: { signal?: AbortSignal; timeout?: number; requireCmuxEnv?: boolean } = {}
) {
  if (options.requireCmuxEnv !== false && !isCmuxEnvironment()) {
    return { ok: false, skipped: true, reason: 'not in cmux', stdout: '', stderr: '' }
  }

  try {
    const result = normalizeExecResult(await pi.exec(resolveCmuxCommand(), args, {
      signal: options.signal,
      timeout: options.timeout ?? CMUX_TIMEOUT_MS,
    }))

    const stdout = result.stdout ?? ''
    const stderr = result.stderr ?? ''
    const code = result.code ?? 0

    return {
      ok: code === 0 && !result.killed,
      skipped: false,
      code,
      killed: Boolean(result.killed),
      stdout,
      stderr,
      reason: code === 0 && !result.killed ? undefined : stderr || stdout || `cmux exited with code ${code}`,
    }
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      code: undefined,
      killed: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

export function getCmuxWorkspace(env: NodeJS.ProcessEnv = process.env) {
  return env.CMUX_WORKSPACE_ID
}

export function getCmuxSurface(env: NodeJS.ProcessEnv = process.env) {
  return env.CMUX_SURFACE_ID
}

export async function notifyCmux(pi: ExtensionAPI, options: CmuxNotifyOptions) {
  const args = ['notify', '--title', options.title]

  if (options.subtitle) args.push('--subtitle', options.subtitle)
  if (options.body) args.push('--body', options.body)
  if (options.workspace) args.push('--workspace', options.workspace)
  if (options.surface) args.push('--surface', options.surface)

  return runCmux(pi, args, { signal: options.signal })
}

export async function notifyCmuxNeedsFeedback(
  pi: ExtensionAPI,
  body: string,
  options: { title?: string; subtitle?: string; signal?: AbortSignal } = {}
) {
  return notifyCmux(pi, {
    title: options.title ?? 'Pi needs feedback',
    subtitle: options.subtitle ?? 'Action required',
    body,
    signal: options.signal,
  })
}

export async function notifyCmuxDone(
  pi: ExtensionAPI,
  body: string,
  options: { title?: string; subtitle?: string; signal?: AbortSignal } = {}
) {
  return notifyCmux(pi, {
    title: options.title ?? 'Pi',
    subtitle: options.subtitle ?? 'Done',
    body,
    signal: options.signal,
  })
}

export async function setCmuxStatus(
  pi: ExtensionAPI,
  key: string,
  value: string,
  options: { icon?: string; color?: string; signal?: AbortSignal } = {}
) {
  const args = ['set-status', key, value]
  if (options.icon) args.push('--icon', options.icon)
  if (options.color) args.push('--color', options.color)
  return runCmux(pi, args, { signal: options.signal })
}

export async function clearCmuxStatus(pi: ExtensionAPI, key: string, options: { signal?: AbortSignal } = {}) {
  return runCmux(pi, ['clear-status', key], { signal: options.signal })
}
