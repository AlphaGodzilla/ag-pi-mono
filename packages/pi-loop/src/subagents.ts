/**
 * 与 pi-interactive-subagents 的零耦合对接。
 *
 * pi-interactive-subagents 在**同一进程**里把「本会话已启动且仍在跑的 subagent」放在
 * `globalThis.__piSubagentRunningRegistry`（一个 Map）上，供它自己的兄弟扩展读取。
 * pi-loop 只读这个注册表，用来判断「本轮是否还在等 subagent 结果」，因此：
 *
 *   - 不需要修改或依赖 pi-interactive-subagents 的任何代码；
 *   - 插件缺席时返回 0，loop 退化为「按报告/回合边界推进」，不会报错。
 */

export const RUNNING_REGISTRY_GLOBAL_KEY = "__piSubagentRunningRegistry"

interface RunningRegistryLike {
  readonly size: number
}

function isRegistryLike(value: unknown): value is RunningRegistryLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RunningRegistryLike).size === "number" &&
    typeof (value as { get?: unknown }).get === "function" &&
    typeof (value as { values?: unknown }).values === "function"
  )
}

/** 当前仍在运行的 subagent 数量；没有注册表（未装 pi-interactive-subagents）时返回 0。 */
export function runningSubagentCount(globalObj: object = globalThis): number {
  const registry = (globalObj as Record<string, unknown>)[RUNNING_REGISTRY_GLOBAL_KEY]
  return isRegistryLike(registry) ? registry.size : 0
}
