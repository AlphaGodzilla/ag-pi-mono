---
status: accepted
date: 2026-10-19
decision-makers: [用户]
consulted: []
informed: []
---

# pi-loop 与 pi-interactive-subagents 保持零耦合，只读运行中注册表

## Context and Problem Statement

用户要求 `pi-loop` 与 `pi-interactive-subagents` 联动：loop 期间主 agent 派出的 subagent 结果必须回到同一轮里被汇总，且本轮还在等 subagent 时不能收尾。两个扩展都在同一 pi 进程里运行，但属于不同仓库（`ag-pi-mono/packages/pi-loop` 与本地 fork `~/.pi/pi-interactive-subagents`）。

需要决定联动形态：是给 pi-interactive-subagents 增加事件契约（可写耦合），还是只读它已有的进程内状态。这个选择决定升级路径与失效模式：跨仓库事件契约一旦漂移，两边的错误都会被吞在异步路径里。

## Decision Drivers

* 不修改上游 fork：pi-interactive-subagents 是本机 fork，改动会带来持续同步成本。
* 失效可见：联动缺失时必须退化为可用行为，而不是抛错或静默卡住。
* 最少契约：只依赖「运行中 subagent 数量」这一条信息，不复制它的启动/结果格式。

## Considered Options

* 方案 A：只读 `globalThis.__piSubagentRunningRegistry`（pi-interactive-subagents 自己用于兄弟扩展的注册表）。
* 方案 B：在 pi-interactive-subagents 里新增 `pi.events` 契约（如 `ag-pi-loop:spawn` / `ag-pi-loop:result`），由 pi-loop 直接派发并接收结果。
* 方案 C：订阅 pi-interactive-subagents 已有的 `subagents:created` / `subagents:completed` 事件通道。

## Decision Outcome

选择「方案 A」，因为它是唯一既不改上游、又能拿到「此刻还有几个 subagent 在跑」的方案：该注册表是 pi-interactive-subagents 主动共享给同进程兄弟扩展的 Map，读取它属于既有事实而非新契约。插件缺席时读取结果为 0，pi-loop 退化为「按报告 / 回合边界推进」，功能可用但不具备「等结果」的强保证。

读取被封装在 `packages/pi-loop/src/subagents.ts`：校验对象形状（`size` 数字 + `get`/`values` 方法），任何不符都按 0 处理。

### Consequences

* Good, because 两个仓库可以独立升级：pi-loop 不 import、不修改 pi-interactive-subagents。
* Good, because 只有一处读取点，插件改名或注册表消失时退化行为明确且有单测。
* Bad, because 依赖一个未文档化的进程内全局变量：pi-interactive-subagents 若改名或改为独立进程，联动会静默退化为弱保证。
* Bad, because 只能拿到「数量」，拿不到 subagent 与迭代的对应关系；多轮混跑时无法区分「本轮」与「上一轮遗留」的 subagent。

### Confirmation

* `packages/pi-loop/test/extension.test.ts` 用假的 `globalThis.__piSubagentRunningRegistry` 验证 `loop_report` 在 subagent 在跑时被拒、清空后放行。
* `packages/pi-loop/src/subagents.ts` 对非 Map 形状返回 0；`runningSubagentCount()` 在未安装插件时为 0。
* 手工验收：安装 pi-interactive-subagents 后执行 `/loop 30s <task>`，确认面板在 subagent 运行期间保持 `iteration N running`，结果回来后同一轮才出现 `loop_report` 回执。

## Pros and Cons of the Options

### 方案 A：只读运行中注册表

* Good, because 零改动上游，契约面最小（一个数字）。
* Bad, because 依赖实现细节，属于「可用则用、缺失则退化」的软耦合。

### 方案 B：新增事件契约

* Good, because 调度与结果收集完全确定，不依赖主 agent 遵守提示词协议。
* Bad, because 需要维护 fork 补丁，且与 [ADR-0001](./0001-drive-pi-loop-by-iteration-reports.md) 中「主 agent 是唯一调度者」的结论冲突。

### 方案 C：订阅既有 `subagents:*` 事件

* Good, because 使用 pi-interactive-subagents 已暴露的事件总线，比读全局变量更「正当」。
* Bad, because 这些通道当前由 rpiv 系列消费者使用，payload 结构并非为「本轮是否结束」设计；用它推断收尾时机需要额外状态对齐，反而更脆弱。

## More Information

* 注册表常量与读取逻辑：`packages/pi-loop/src/subagents.ts` 的 `RUNNING_REGISTRY_GLOBAL_KEY`、`runningSubagentCount()`。
* 复查触发点：pi-interactive-subagents 若提供正式的多 agent 状态 API 或事件契约，本 ADR 应被取代。
