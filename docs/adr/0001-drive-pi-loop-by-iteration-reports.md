---
status: accepted
date: 2026-10-19
decision-makers: [用户]
consulted: []
informed: []
---

# pi-loop 的循环由每轮报告驱动，主 agent 只做调度与汇总

## Context and Problem Statement

用户要求新增 `/loop` 能力，用法对齐 Claude Code 的 `/loop`：`/loop 5m check the deploy`、`/loop event tasks:created process the backlog`、`/loop finish the release`。同时要求主 agent 在 loop 期间只负责调度与汇总，具体工作交给 subagent；人类输入框在 loop 期间锁定，只能按快捷键退出。

`pi-loop` 实现前，本仓没有任何「定时唤醒主会话」的扩展；pi 的事件钩子只提供回合与消息边界（`before_agent_start`、`agent_settled`、`turn_end` 等），没有「工作项完成」的概念。因此必须先确定：循环的推进信号是什么，以及一轮里谁干活。这两个选择决定扩展的失败模式（重复派活、报告与结果错位、无人值守时空转）。

## Decision Drivers

* 无人值守：无人看管时不得因为模型忘记调用某个工具就让循环静默停摆。
* 结果与摘要不得错位：异步 subagent 的结果是稍后 steer 回来的，摘要必须覆盖本轮真实结果。
* 节奏可预测：固定间隔不得与上一轮重叠，也不得把新迭代塞进正在跑的回合。
* 主 agent 上下文可控：每轮只注入一小段调度指令，不把整个任务历史重发。

## Considered Options

* 方案 A：报告驱动 —— 每轮由扩展注入指令（派活 → 结果回来后写摘要 → 调 `loop_report`），报告到达后按模式排下一轮；模型漏调报告时以 `agent_settled` 作隐式报告兜底。
* 方案 B：回合驱动 —— 不引入报告工具，任何 `agent_settled` 之后按间隔排下一轮。
* 方案 C：扩展自己派 subagent 并收集结果 —— 扩展通过事件契约直接启动 subagent，主 agent 只收到最终摘要。

## Decision Outcome

选择「方案 A」，因为只有它同时满足三个硬性约束：报告是「本轮结果已落地」的唯一可靠信号（避免摘要早于结果）；隐式报告兜底让漏调工具只退化为「按回合边界推进」而不是停摆；主 agent 仍是唯一的调度者，扩展不必知道 subagent 的启动参数与结果格式。

配合的约束：

* 还有 subagent 在跑时拒绝继续类报告（`subagents-running`），要求等结果回来再报告。
* 主会话不空闲时到点的迭代推迟派发（轮询等待），不向正在跑的回合 steer 新任务。
* 用户 Esc 中断的回合按冷却时间推进，不立即重开。
* 进度写入 `keepGoing: false` 是模型结束循环的唯一途径；用户另有快捷键与命令。

### Consequences

* Good, because 任务内容与派活方式留在主 agent 手里（它可以按工作类型选模板、拆并行 subagent），扩展不必复制 agent 选择逻辑。
* Good, because 报告回执可以明确指出下一步（下一轮时间 / 未记录原因），模型不需要猜。
* Good, because 状态机是纯逻辑且定时器、时钟、发送全部可注入，测试覆盖了全部推进分支。
* Bad, because 每轮多一次模型回合与一次工具调用（`loop_report`），固定短间隔的循环 token 成本高于纯定时器方案。
* Bad, because 循环的语义正确性依赖主 agent 遵守注入指令；扩展只能强制「不并发、等结果」，不能强制「真的派了 subagent」。
* Bad, because 不跨会话持久化：`/reload` 与会话切换会丢掉循环。

### Confirmation

* `packages/pi-loop/test/loop-machine.test.ts` 覆盖三种模式的推进、拒绝条件、隐式报告、中断冷却与忙碌推迟。
* `packages/pi-loop/test/extension.test.ts` 验证注入的迭代消息包含「派 subagent、不要自己做、必须 loop_report」三类约束。
* 手工验收：`/loop 5s <task>` 后观察面板与 `loop_iteration` 消息，确认每轮先出现 subagent 启动回执、结果 steer 回来后才出现 `loop_report` 回执。

## Pros and Cons of the Options

### 方案 A：报告驱动 + 隐式报告兜底

* Good, because 报告把「结果已落地」变成显式协议，避免摘要与结果错位。
* Good, because `agent_settled` 兜底消除了「模型忘调工具 → 循环停摆」这一主要失败模式。
* Bad, because 协议需要模型配合，注入指令与系统提示词段落必须写清，属于需要维护的提示词资产。

### 方案 B：回合驱动

* Good, because 实现最简，不需要新工具，也不会因为漏调工具停摆。
* Bad, because 主 agent 派完 subagent 后回合立即结束，此时按间隔排下一轮会在结果回来前就开跑，产生重复派活或空转。

### 方案 C：扩展直接派 subagent

* Good, because 扩展完全掌握节奏与并发，不依赖主 agent 遵守协议。
* Bad, because 需要与 pi-interactive-subagents 建立可写的事件契约（改动其代码），且扩展必须自己决定 agent 模板、模型层级与任务提示，与「主 agent 只做调度」的要求相反。

## More Information

* 与 pi-interactive-subagents 的耦合边界见 [ADR-0002](./0002-keep-pi-loop-decoupled-from-pi-interactive-subagents.md)，输入锁定形态见 [ADR-0003](./0003-lock-human-input-at-terminal-layer.md)。
* 复查触发点：pi 若提供原生的定时唤醒或「工作项完成」事件，可简化本状态机。
