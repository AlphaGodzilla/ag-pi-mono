# remote-notify

pi 扩展：**任务结束后通过飞书提醒你**，提醒内容包含**最近一次工作的总结**（请求、用到的工具、结论、耗时）。

离开终端 / 远程办公时，pi 在后台跑任务，任务一结束飞书立刻推给你工作总结；需要你授权或回答问卷时也会提醒你回来操作。

> **投递由 pi-channel 负责**：本插件只发 `ag-pi-channel:send` 事件，飞书凭证与连接归 [pi-channel](../pi-channel) 插件（`~/.pi/agent/extensions/pi-channel/config.json`）。本插件**不再需要、也不再读取自己的 config.json**。

## 功能特性

- ✅ 任务结束自动推送飞书通知，内含**最近一次工作总结**（不额外调 LLM，零成本）
- ✅ `/remote-notify` 开关命令，状态持久化，重启不丢
- ✅ 事件种类与 pi-cmux 对齐：任务开始 / 完成 / 会话结束 + 权限 ask + 问卷 ask
- ✅ 不持有凭证、不直接调飞书 SDK：发送只 emit `ag-pi-channel:send` 事件
- ✅ 与 pi-cmux 完全隔离：不修改其代码、不占其连接，互不影响

## 依赖关系

| 组件 | 职责 |
| --- | --- |
| **pi-channel**（投递方） | 持有飞书 appId / appSecret / 默认收件人（`~/.pi/agent/extensions/pi-channel/config.json`），实际调用飞书 API |
| **remote-notify**（本插件） | 订阅 pi 事件，把通知文本经 `ag-pi-channel:send` 事件交给 pi-channel |

- 两者通过 pi 的事件总线通信（`ag-pi-channel:send` / `ag-pi-channel:send:result`），**不是代码或包依赖**，可独立安装/升级。
- **pi-channel 缺席或未配置时**：每次发送等 10s 超时后降级——错误写入本插件 `error.log`，不抛异常、不污染界面，pi 主流程完全不受影响。

## 目录结构

```
~/.pi/agent/extensions/pi-remote-notify/
├── index.ts              # 入口：组合注册 + /remote-notify 命令
├── package.json          # 无 dependencies（不再依赖飞书 SDK）
├── README.md
├── src/
│   ├── channel.ts        # pi-channel 事件契约本地副本（通道常量 / 类型 / sendViaBus）
│   ├── notify.ts         # 经事件契约发送：异步 + 异常兜底
│   ├── log.ts            # error.log 写入（绝不写 console）
│   ├── state.ts          # toggle 开关持久化（默认关闭）
│   ├── summary.ts        # 最近一次工作总结提取/格式化
│   ├── lifecycle.ts      # 任务开始 / 完成 / 会话结束
│   ├── permissionNotify.ts  # 权限 ask 弹窗通知
│   └── askUserNotify.ts     # ask_user_question 问卷通知
└── test/                 # 独立测试 + pi-cmux 共存验证
```

## 快速开始

```bash
# 1. 先配置 pi-channel（凭证 + 默认收件人），见其 config.example.json：
#    ~/.pi/agent/extensions/pi-channel/config.json

# 2. 在 pi 中重载扩展
/reload

# 3. 开启飞书提醒
/remote-notify on

# 4. 跑一个任务，任务结束后飞书收到「✅ 任务完成」+ 总结
```

本插件自身没有任何 npm 依赖，不需要 `npm install`。

## 配置

- **本插件没有配置文件**：原先的 `~/.pi/agent/extensions/pi-remote-notify/config.json` 与 `config.example.json` 已随迁移删除。
- **凭证与默认收件人**全部由 pi-channel 提供，见 `~/.pi/agent/extensions/pi-channel/config.json`（`feishu.appId` / `feishu.appSecret` / `feishu.defaultReceiver`）。
- 通知不指定收件人（事件里不带 `to`），使用 pi-channel 配置里的**默认收件人**，因此配好 `feishu.defaultReceiver` 即可。
- 旧来源（`~/.pi/agent/feishu/`、`~/.config/rpiv-ask-user-question/config.json` 的 `remote.feishu`，以及 `PI_FEISHU_NOTIFY_APP_ID` / `_APP_SECRET` / `_CHAT_ID` / `_OPEN_ID` / `_DOMAIN`）**不再读取**。

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `PI_FEISHU_NOTIFY=0` | 强制禁用本扩展 |
| `PI_FEISHU_NOTIFY_INCLUDE_SUBAGENTS=1` | 也通知 subagent 会话（默认跳过） |
| `PI_FEISHU_NOTIFY_SESSION_END=0` | 关闭会话结束提醒 |

### 运行数据

| 文件 | 说明 |
| --- | --- |
| `~/.pi/agent/extensions/pi-remote-notify/state.json` | `/remote-notify` 开关状态（旧位置 `~/.pi/agent/feishu/remote-notify-state.json` 仍可读，不再写入） |
| `~/.pi/agent/extensions/pi-remote-notify/error.log` | 发送失败 / pi-channel 缺席超时等错误日志（绝不写 console，避免污染 TUI） |

## 使用

### 命令

| 命令 | 说明 |
| --- | --- |
| `/remote-notify` | 切换开关（默认关闭） |
| `/remote-notify on` | 开启 |
| `/remote-notify off` | 关闭 |
| `/remote-notify status` | 查看当前状态 |

开关状态持久化到 `~/.pi/agent/extensions/pi-remote-notify/state.json`（旧位置 `~/.pi/agent/feishu/remote-notify-state.json` 仍可读），重启 pi 后保持上次状态。

### 触发的事件与通知内容

| 事件 | 飞书内容 |
| --- | --- |
| `before_agent_start` | 🟢 任务开始 + 请求摘要 |
| `agent_settled` | ✅ 任务完成 + **最近一次工作总结** |
| `session_shutdown` | 🔚 会话结束 |
| `permissions:ui_prompt` | 🔐 需要你授权（权限 ask 弹窗） |
| `rpiv:ask-user:prompt` | ❓ 需要你回答（ask_user_question 问卷弹窗） |

任务完成通知示例：

```
✅ 任务完成
📍 目录: /Users/hty/projects/foo
📝 请求: 重构登录模块并补充单元测试
🛠 工具: read×5, write×3, bash×2
💬 结论: 登录模块重构完成，全部测试通过。
⏱ 耗时: 42s
```

## 工作原理

- **事件订阅**：独立订阅上述事件，多扩展可同时监听，互不干扰
- **总结提取**：从 `ctx.sessionManager.getBranch()`（root→leaf 顺序）取**最后一个 user 消息**起，汇总请求原文 / 工具调用计数（`toolCall`）/ 最终 assistant 结论 / 出错工具（`toolResult.isError`）/ 耗时；**不额外调 LLM**
- **任务完成时机**：用 `agent_settled`（agent 完全空闲、不再自动重试/续跑），比 `agent_end` 更贴合"任务彻底结束"，避免 retry/compaction 重复提醒
- **发送机制**：`src/notify.ts` 调 `sendViaBus(pi.events, { provider: 'feishu', kind: 'text', text }, 10_000)`，由 pi-channel 应答 `ag-pi-channel:send:result`；`ok: false`（含超时）时把 `error.code` / `error.message` 写进本插件 `error.log`
- **异常兜底**：所有发送异步 + catch，绝不抛出未捕获异常影响 pi 主流程

## 与 pi-cmux / pi-channel 的关系

- **pi-cmux**：不修改、不依赖其任何代码/状态，二者独立订阅事件、独立运行
- **pi-channel**：唯一的投递方；本插件只发事件，不建立长连接、不接触凭证
- subagent 会话默认跳过（`PI_FEISHU_NOTIFY_INCLUDE_SUBAGENTS=1` 开启，与 pi-cmux 的 `PI_CMUX_INCLUDE_SUBAGENTS` 语义一致）

## 测试

测试在 pi-mono 仓库内运行（测试会与同仓的 pi-channel / pi-cmux 做契约与共存检查）：

```bash
cd pi-mono

# 独立测试：注册、toggle 持久化、摘要提取、
# 事件契约（假装 pi-channel 应答 / 缺席降级）
pnpm --filter @alphagodzilla/pi-remote-notify test
```

测试用 `PI_CODING_AGENT_DIR` 指向临时目录、不使用任何真实凭证、绝不触网。

## 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 不发通知 | `/remote-notify status` 是否已开启；查看本插件 `error.log` 是否有 `send failed`；`/channel status` 确认 pi-channel 已配置 |
| `error.log` 出现 `send failed: timeout` | pi-channel 未安装/未加载（10s 无应答降级）。安装 pi-channel 后 `/reload` |
| `error.log` 出现 `not_configured` | pi-channel 未配置飞书（缺 `feishu.appId` / `appSecret` / 默认收件人） |
| 飞书发送报错（app 被删 / token 失败 / bot 不在会话） | 属于 pi-channel 的故障，见其 `error.log` 与文档 |
| 子代理任务也提醒 | 默认跳过 subagent；如需包含设 `PI_FEISHU_NOTIFY_INCLUDE_SUBAGENTS=1` |
| 会话结束不提醒 | 默认开启；`PI_FEISHU_NOTIFY_SESSION_END=0` 会关闭 |
| 发送报错但 pi 无感 | 正常——错误只记录到 `error.log`（从不写 console），不影响主流程 |
