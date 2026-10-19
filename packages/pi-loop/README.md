# @alphagodzilla/pi-loop

pi 扩展：让会话以**无人值守的循环**运行，用法对齐 Claude Code 的 `/loop`。循环期间人类输入框被锁死，页面常驻显示退出快捷键；每一轮由主 agent 调度 pi-interactive-subagents 派 subagent 干活，主 agent 自己只负责下发任务、判读结果、写摘要并推动节奏。

本文面向要使用或维护本扩展的人与模型。全文顺序：快速开始 → 三种模式 → 一轮的生命周期 → 与 pi-interactive-subagents 的联动 → 输入锁定与退出 → 命令与工具 → 配置 → 状态面板 → 边界与限制 → 开发。

## 快速开始

```bash
# 登记：在 pi 的 settings.json 的 packages 里加一行（相对 agentDir 解析）
#   "../ag-pi-mono/packages/pi-loop"
/loop 5m check the deploy             # 每 5 分钟一轮
/loop event tasks:created process the backlog   # 每来一个 tasks:created 事件跑一轮
/loop finish the release              # 自定节拍：上一轮报告后立刻开下一轮
/loop status                          # 查看状态
```

启动后输入框被锁定，编辑器上方出现 `pi-loop` 面板并常驻提示退出键（默认 `ctrl+shift+l`）。按该键（或执行 `/loop stop`）退出并恢复输入。

## 三种模式

| 模式 | 触发 | 下一次何时开始 |
| --- | --- | --- |
| `interval`（`/loop 5m <task>`） | 启动即跑第一轮 | 每轮报告后重新计时；报告可用 `nextDelayMs` 覆盖本次间隔 |
| `event`（`/loop event <channel> <task>`） | 等待 `pi.events` 上同名 channel 的事件 | 报告后等下一个事件；轮内到达的事件排队合并，本轮结束立即补跑一轮 |
| `self`（`/loop <task>`） | 启动即跑第一轮 | 报告后立即开下一轮（`nextDelayMs` 可加延时） |

三种模式都**不重叠**：上一轮没结束（没收到报告、回合也没 settle）时不会开下一轮。主会话还在跑的时候到点的 tick 会推迟到空闲后再派发。

## 一轮的生命周期

```
/loop 5m <task>
   │
   ├─ 锁输入 + 面板 + （事件模式）订阅 channel
   ├─ pi 发一条 loop_iteration 消息 → 触发主 agent 一个回合
   │     └─ 主 agent：调 subagent 派活 → 结束回合
   ├─ subagent 在后台跑 → 结果自动 steer 回主 agent → 新回合
   │     └─ 主 agent：判读结果 + 写摘要 → 调 loop_report
   ├─ loop_report 通过 → 按模式排下一轮（间隔 / 立即 / 等事件）
   └─ loop_report({ keepGoing: false }) 或 退出快捷键 / `/loop stop` → 解锁输入
```

每轮注入的指令（`src/messages.ts`）要求主 agent：

1. **必须**用 `subagent` 工具把本轮工作派出去——就是手动派 subagent 的同一条路径，页面上会出现新的 subagent pane，主 agent 的 Subagents 状态栏里出现该 agent 的实时状态。即使任务看起来很小也照样派，按工作类型选模板，不确定就先 `subagents_list`；
2. 自己不做本轮的活、不重复派同一个活、不轮询 `subagents_status`；
3. 结果回来后写几行摘要，再调 `loop_report`；
4. 任务完成或无法推进时用 `keepGoing: false` 结束循环。

loop 运行期间还会把一段 `pi-loop` 段落注入系统提示词，重复同样的约束，避免主 agent 在长会话里忘掉协议。

**派发校验**：轮次结束时如果 `subagent` 工具可用、但这一轮的会话分支里没有任何 `subagent` 工具结果（说明主 agent 自己把活干了），扩展补一条「先派 subagent」的提醒；同一轮最多提醒一次，之后按隐式报告推进，不会卡死。会话里没有 `subagent` 工具时不做这项校验。

若主 agent 忘了调 `loop_report` 就结束回合，扩展按**隐式报告**推进：`interval` 模式等一个间隔，`self` 模式等 `implicitSettleDelayMs`（默认 3s，避免忙等）。用户按 Esc 中断的回合按 `abortCooldownMs`（默认 30s）冷却，不跟用户抢。

回合以 `error` 结束（pi 的有界重试已耗尽，例如鉴权失败或 provider 起不来）时直接停掉循环并解锁输入，不在无人看管时反复失败重试。

## 与 pi-interactive-subagents 的联动

联动是**零耦合**的，本扩展不修改也不 import pi-interactive-subagents 的代码，只读它放在同一进程的 `globalThis.__piSubagentRunningRegistry`（一个 Map，元素即运行中的 subagent）。该注册表提供两个能力：

- 本轮还有 subagent 在跑时，`loop_report({ keepGoing: true })` 被拒，要求等结果回来再报告——避免「摘要」和「结果」错位；
- 回合结束（`agent_settled`）时若仍有 subagent 在跑，不视为本轮结束，等结果 steer 回来的那一轮再收尾。

pi-interactive-subagents 缺席时 `runningSubagentCount()` 返回 0，循环退化为「按报告 / 回合边界推进」，其余行为不变。

循环期间 `ask_user_question` 工具被 `tool_call` 钩子 block：输入已锁，问卷没人能回答，模型应当改用 `loop_report` 报告阻塞。

## 输入锁定与退出

锁定分两层，都是为了让「人」在循环期间无法插话：

1. **终端层**（`ui.onTerminalInput`）：可打印字符、粘贴内容、Enter 被吞掉；Esc、Ctrl+C、Ctrl+D、方向键、鼠标等控制序列透传，pi 的默认编辑器保持原有语义。
2. **input 事件**：若仍有输入进入（例如 RPC 来源），返回 `{ action: "handled" }` 丢弃，并每 3 秒最多提示一次退出键。

退出方式：

| 方式 | 说明 |
| --- | --- |
| `ctrl+shift+l`（默认） | 全局快捷键；终端层也会拦截。Kitty 协议下是 `\x1b[108;6u`，传统终端把 ctrl+shift+字母压成 ctrl+字母（`\x0c`），同样命中 |
| `/loop stop` | 命令；但输入被锁时无法手打，主要用于脚本或解锁后 |
| `loop_report({ keepGoing: false })` | 主 agent 结束循环（任务完成 / 无法推进） |

退出后：面板与 footer 状态清除、终端监听解绑、输入恢复，并在 transcript 里留一条 `pi-loop stopped (...)` 记录。

> 传统终端无法区分 ctrl+shift+L 与 ctrl+L，因此循环期间 `ctrl+l`（模型选择）也会退出 loop。需要避开这个歧义时把 `exitKeys` 改成 `ctrl+x` 这类键。

## 命令与工具

| 名称 | 说明 |
| --- | --- |
| `/loop <interval> <task>` | 固定间隔启动；间隔支持 `30s`、`5m`、`1h30m`、`1.5h` |
| `/loop event <channel> <task>` | 事件驱动启动 |
| `/loop <task>` | 自定节拍启动 |
| `/loop` / `/loop status` | 未运行时显示用法，运行时显示状态 |
| `/loop stop` | 停止并解锁输入 |
| `/loop-emit <channel> [json]` | 向 `pi.events` 发一条事件，用于手工触发事件模式；payload 不是合法 JSON 时按 `{ text }` 发送 |

`loop_report` 工具参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `summary` | string（必填） | 面向用户的 2~5 行摘要 |
| `keepGoing` | boolean，默认 `true` | `false` 结束循环并解锁输入 |
| `nextDelayMs` | number，可选 | 覆盖本次推进间隔 |

`loop_report` 的返回值会明确告诉主 agent 下一步：本轮已记录 / 下一轮何时开始，或未记录的原因（`subagents-running`、`not-in-iteration`、`no-loop`）。

## 配置

配置读取顺序（与 `ag-pi-mono/AGENTS.md` 的约定一致）：

1. `~/.pi/agent/extensions/pi-loop/config.json`（用户配置，优先）
2. `<包目录>/config.json`（旧位置，只读兜底）
3. 内置默认值

字段非法时扩展加载直接报错（fail-fast），不会带着错误节奏静默运行。模板见 `config.example.json`：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `exitKeys` | `["ctrl+shift+l"]` | 退出快捷键，可多个；第一个同时注册为 pi 快捷键 |
| `minIntervalMs` | `1000` | 固定间隔下限，防止手滑把 token 烧光 |
| `cycleWarnMs` | `900000` | 单轮超过该时长只告警（面板标记 long-running），不打断回合；`0` 关闭 |
| `abortCooldownMs` | `30000` | 用户 Esc 中断回合后，自定节拍模式的重试间隔 |
| `implicitSettleDelayMs` | `3000` | 模型忘调 `loop_report` 时，自定节拍模式的兜底推进间隔 |
| `maxQueuedEvents` | `5` | 事件模式下积压事件的记录上限，超出只计数 |

环境变量 `PI_LOOP_DISABLED=1` 强制禁用本扩展。

## 状态面板

编辑器上方的面板（最多 5 行）常驻显示：任务、节奏与当前状态（`iteration N running` / `next at HH:MM:SS` / `waiting for event`）、上一轮摘要、以及 `🔒 input locked — press <exitKey> to exit the loop`。footer 状态栏同步显示紧凑版本（`loop · it 3 running · next 12:03:45`）。

一轮派发出去后，页面上同时能看到：新的 subagent pane（由 pi-interactive-subagents 打开、不抢焦点）、主 agent 的 `Subagents` 状态栏里该 agent 的实时状态（`starting` / `active` / `waiting` / `stalled`）、以及本扩展的 `pi-loop` 面板。两者用的是不同的 widget key，互不覆盖。

transcript 里有两类自定义消息，折叠时只显示一行，`Ctrl+O` 展开看全文：`loop_iteration`（每轮的下发内容）与 `loop_notice`（启动 / 结束）。

## 边界与限制

- 循环状态只存在当前会话内存里：`/reload`、会话切换、退出都会清掉定时器与监听（`session_shutdown` 里幂等清理），不会跨会话恢复。
- 事件模式的 channel 来自 `pi.events` 总线：任何扩展都可以 `pi.events.emit(channel, payload)` 触发；`/loop-emit` 只是同一总线的手工入口，不提供文件或 HTTP 触发。
- 一轮只派一次活依赖主 agent 遵守注入的指令；扩展能强制的是「等 subagent 结束再收尾」与「不并发开轮」，不能替主 agent 决定任务内容。
- 主 agent 派活需要 pi-interactive-subagents 的 `subagent` 工具；没有它时指令退化为「自己做并报告」。
- 输入锁定只在 TUI 模式下有终端层拦截；RPC / JSON 模式只有 `input` 事件拦截。

## 开发

```bash
pnpm --filter @alphagodzilla/pi-loop test   # 单包测试（node --test，直接跑 .ts）
pnpm check                                  # 全仓 typecheck + test
```

模块划分：

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 扩展接线：命令、快捷键、`loop_report` 工具、事件钩子、面板与输入锁定 |
| `src/loop-machine.ts` | 循环状态机（纯逻辑，定时器 / 时钟 / send 全部可注入） |
| `src/args.ts` / `src/duration.ts` | `/loop` 参数与时长解析 |
| `src/messages.ts` | 每轮指令、系统提示词段落、`loop_report` 回执 |
| `src/input-lock.ts` | 键序列解析：哪些键算人类输入、哪个键是退出键 |
| `src/ui.ts` | 面板、状态行、transcript 自定义消息渲染 |
| `src/config.ts` | 配置解析与路径优先级 |
| `src/subagents.ts` | 只读 pi-interactive-subagents 的运行中注册表 |
