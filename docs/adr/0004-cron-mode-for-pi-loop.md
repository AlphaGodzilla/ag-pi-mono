---
status: accepted
date: 2026-10-19
decision-makers: [用户]
consulted: []
informed: []
---

# pi-loop 增加 cron 模式：绝对钟点触发、忙时跳过

## Context and Problem Statement

`/loop` 原有三种节奏都是相对的：`interval` 在**每轮报告之后**等固定间隔，真实周期随轮次耗时漂移；`event` 由外部事件驱动；`self` 立即推进。用户需要「每天 9 点」「每个整点」这类钟点语义，用 `interval` 无法表达——`/loop 1h` 在 9:03 启动就永远落在 :03。

需要新增一种按本机时区**绝对钟点**触发的节奏，并确定三件事：表达式语法范围、到点时上一轮仍在跑时的行为、以及它与既有 `abortCooldownMs` / `implicitSettleDelayMs` 的关系。

## Decision Drivers

* 与 crontab 的心智模型一致，用户不必学习新语法。
* 不引入运行时依赖（本仓各包只声明 peerDependencies，运行在 pi 进程内）。
* 无人值守时不得因为「补跑」把积压的轮次一次性打满。
* 与既有报告驱动模型兼容：仍然每轮一次报告，只是「下一次何时开始」改由时钟决定。

## Considered Options

* 方案 A：5 段 cron 表达式 + 本机时区，到点时上一轮未结束就**跳过该次**。
* 方案 B：5 段 cron + 「结束后补跑一次」（错过的那次在当前轮结束后立即执行）。
* 方案 C：不新增模式，用户用 `/loop 5m` 近似，或由外部系统发 `/loop-emit` 事件触发。

## Decision Outcome

选择「方案 A」，因为跳过的语义不会在长时间任务后制造突发轮次队列，且与 crontab 的默认行为一致（cron 本身也不补跑）；而补跑会在「每小时一次、单轮 3 小时」的场景下变成连续重跑。

配套约定：

* 语法只收 5 段（分 时 日 月 周），支持 `*`、`*/n`、`a-b`、`a-b/n`、`a,b`、`a/n`；不支持 `@daily` 等宏与秒级字段，避免把 crontab 方言的差异带进来。
* 「日」与「周」同时被限制时取**或**（Vixie cron 语义），并在单测里固定该行为。
* `cron` 启动时**不**立即开跑，等下一个钟点；`interval` / `self` 仍是启动即跑。
* 报告里的 `nextDelayMs` 可以覆盖一次；`abortCooldownMs` 与 `implicitSettleDelayMs` **不适用于** cron（绝对钟点优先）。
* 定时器按 `maxTimerChunkMs`（默认 5 分钟）分段续期：`setTimeout` 超过 2^31-1ms 会立即触发，而「每月 1 号」这类间隔可能超过 24.8 天。
* 启动时若表达式在 8 年内都不会触发（如 `0 0 30 2 *`）直接拒绝，而不是留下一个永不触发的循环。

### Consequences

* Good, because 钟点语义可预测：`"*/5 * * * *"` 就是 `:00/:05/:10…`，与轮次耗时无关。
* Good, because 解析与「下一个触发时刻」是纯函数（`src/cron.ts`），单测覆盖区间、列表、步长、闰年、跨周与 Vixie 或语义。
* Good, because 无新增依赖，表达式错误在启动时就以字段级原因拒绝。
* Bad, because 跳过的语义意味着「每小时一次」在长任务下实际频率低于预期，用户需要自己判断。
* Bad, because 只收 5 段而拒绝宏与秒级字段，用户从别处复制 `@daily` 或 6 段写法时必须改写。
* Bad, because 时区固定为本机时区，跨机器/换时区的行为不显式声明；夏令时跳过的时刻直接跳过，可能少一次。

### Confirmation

* `packages/pi-loop/test/cron.test.ts`：解析（合法/非法/字段级原因）、下次触发（严格晚于、跨小时/跨天/跨周、闰年 2 月 29 日、永不触发返回 undefined）、Vixie 或语义。
* `packages/pi-loop/test/loop-machine.test.ts`：cron 启动不抢跑、报告后按绝对钟点排下一次、中断不套用 `abortCooldownMs`、长间隔按 chunk 续期。
* 手工验收：`/loop cron "*/1 * * * *" echo` 观察面板 `next at HH:MM:00`，确认整分触发而非「启动时刻 + 1 分钟」。

## Pros and Cons of the Options

### 方案 A：绝对钟点 + 忙时跳过

* Good, because 与 crontab 默认行为一致，不会制造突发队列。
* Bad, because 长任务会静默降低实际频率。

### 方案 B：绝对钟点 + 补跑一次

* Good, because 不会漏掉整点，适合「每小时必须跑一次」的监控类任务。
* Bad, because 需要额外的「已错过但待补」状态，并会在长任务后立即重跑，可能与「无人值守」目标冲突。

### 方案 C：不新增模式

* Good, because 零实现成本。
* Bad, because 相对间隔无法表达钟点语义；`/loop 5m` 从 9:03 启动会一直落在 :03。

## More Information

* 解析与时刻计算：`packages/pi-loop/src/cron.ts`；命令解析：`src/args.ts` 的 `splitCronArgs`。
* 与报告驱动模型的关系见 [ADR-0001](./0001-drive-pi-loop-by-iteration-reports.md)：cron 只替换「下一次何时开始」，不改变一轮的推进信号。
* 复查触发点：若需要补跑语义或秒级精度，新增开关并另写 ADR 取代本条的对应部分。
