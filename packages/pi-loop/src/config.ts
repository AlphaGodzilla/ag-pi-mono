/**
 * 配置解析。按仓库约定（`ag-pi-mono/AGENTS.md`）：
 *
 *   ~/.pi/agent/extensions/pi-loop/config.json   ← 用户配置，优先
 *   <包目录>/config.json                          ← 旧位置兜底（只读）
 *   内置默认值                                    ← 两者都不存在时
 *
 * 配置值非法时抛错（fail-fast）：pi 会把扩展加载错误显示出来，而不是带着错误节奏静默运行。
 */

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export interface LoopConfig {
  /** 退出 loop 的快捷键，支持多个（逐个匹配） */
  exitKeys: string[]
  /** 固定间隔模式允许的最小间隔，防止手滑写成 `1ms` 把 token 烧光 */
  minIntervalMs: number
  /** 单轮超过该时长仍未结束时的告警；0 关闭 */
  cycleWarnMs: number
  /** 用户按 Esc 中断当前回合后，自定节拍模式的重试间隔 */
  abortCooldownMs: number
  /** 模型没有调用 loop_report 就结束回合时的兜底推进间隔（自定节拍）*/
  implicitSettleDelayMs: number
  /** 事件驱动模式下积压事件的记录上限（超出只计数） */
  maxQueuedEvents: number
}

export const DEFAULT_LOOP_CONFIG: LoopConfig = {
  exitKeys: ["ctrl+shift+l"],
  minIntervalMs: 1_000,
  cycleWarnMs: 900_000,
  abortCooldownMs: 30_000,
  implicitSettleDelayMs: 3_000,
  maxQueuedEvents: 5,
}

/** 包目录（本文件在 `src/` 下，上一层即包根目录）。 */
export function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..")
}

/** 用户配置路径优先，缺失时回落包目录内的 `config.json`；都不存在时返回 undefined。 */
export function resolveConfigPath(agentDir: string, pkgRoot: string = packageRoot()): string | undefined {
  const userPath = join(agentDir, "extensions", "pi-loop", "config.json")
  if (existsSync(userPath)) return userPath
  const bundledPath = join(pkgRoot, "config.json")
  if (existsSync(bundledPath)) return bundledPath
  return undefined
}

function requireNonNegativeNumber(source: string, key: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`[pi-loop] config ${source}: "${key}" must be a non-negative number (got ${JSON.stringify(value)})`)
  }
  return value
}

/** 把 JSON 原始值校验成 LoopConfig；缺失字段取默认值，非法字段抛错。 */
export function normalizeLoopConfig(raw: unknown, source = "defaults"): LoopConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_LOOP_CONFIG }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`[pi-loop] config ${source}: expected a JSON object`)
  }
  const input = raw as Record<string, unknown>

  const exitKeysRaw = input.exitKeys
  let exitKeys = DEFAULT_LOOP_CONFIG.exitKeys
  if (exitKeysRaw !== undefined) {
    if (
      !Array.isArray(exitKeysRaw) ||
      exitKeysRaw.length === 0 ||
      exitKeysRaw.some((key) => typeof key !== "string" || key.trim() === "")
    ) {
      throw new Error(`[pi-loop] config ${source}: "exitKeys" must be a non-empty array of key ids`)
    }
    exitKeys = exitKeysRaw.map((key) => (key as string).trim())
  }

  return {
    exitKeys,
    minIntervalMs: requireNonNegativeNumber(source, "minIntervalMs", input.minIntervalMs, DEFAULT_LOOP_CONFIG.minIntervalMs),
    cycleWarnMs: requireNonNegativeNumber(source, "cycleWarnMs", input.cycleWarnMs, DEFAULT_LOOP_CONFIG.cycleWarnMs),
    abortCooldownMs: requireNonNegativeNumber(source, "abortCooldownMs", input.abortCooldownMs, DEFAULT_LOOP_CONFIG.abortCooldownMs),
    implicitSettleDelayMs: requireNonNegativeNumber(
      source,
      "implicitSettleDelayMs",
      input.implicitSettleDelayMs,
      DEFAULT_LOOP_CONFIG.implicitSettleDelayMs,
    ),
    maxQueuedEvents: requireNonNegativeNumber(source, "maxQueuedEvents", input.maxQueuedEvents, DEFAULT_LOOP_CONFIG.maxQueuedEvents),
  }
}

export interface LoadedLoopConfig {
  config: LoopConfig
  /** 实际读取的配置文件；使用内置默认值时为空 */
  source?: string
}

export function loadLoopConfig(agentDir: string, pkgRoot: string = packageRoot()): LoadedLoopConfig {
  const path = resolveConfigPath(agentDir, pkgRoot)
  if (!path) return { config: { ...DEFAULT_LOOP_CONFIG } }
  const text = readFileSync(path, "utf8")
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`[pi-loop] config ${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  return { config: normalizeLoopConfig(parsed, path), source: path }
}
