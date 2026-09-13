# remote-notify

pi 扩展：**任务结束后通过飞书提醒你**，提醒内容包含**最近一次工作的总结**（请求、用到的工具、结论、耗时）。

离开终端 / 远程办公时，pi 在后台跑任务，任务一结束飞书立刻推给你工作总结；需要你授权或回答问卷时也会提醒你回来操作。

## 功能特性

- ✅ 任务结束自动推送飞书通知，内含**最近一次工作总结**（不额外调 LLM，零成本）
- ✅ `/remote-notify` 开关命令，状态持久化，重启不丢
- ✅ 事件种类与 pi-cmux 对齐：任务开始 / 完成 / 会话结束 + 权限 ask + 问卷 ask
- ✅ 与 pi-cmux 完全隔离：不修改其代码、不占其连接，互不影响
- ✅ 发送走官方 SDK 纯 REST，不建立长连接，不干扰现有飞书桥接

## 目录结构

```
~/.pi/agent/extensions/remote-notify/
├── index.ts              # 入口：组合注册 + /remote-notify 命令
├── package.json          # 依赖 @larksuiteoapi/node-sdk
├── README.md
├── src/
│   ├── config.ts         # 配置加载（凭证/收件人，多来源优先级）
│   ├── state.ts          # toggle 开关持久化（默认关闭）
│   ├── feishu.ts         # 飞书文本发送（官方 SDK，纯 REST）
│   ├── summary.ts        # 最近一次工作总结提取/格式化
│   ├── lifecycle.ts      # 任务开始 / 完成 / 会话结束
│   ├── permissionNotify.ts  # 权限 ask 弹窗通知
│   └── askUserNotify.ts     # ask_user_question 问卷通知
└── test/                 # 独立测试 + pi-cmux 共存验证
```

## 快速开始

扩展位于自动发现目录 `~/.pi/agent/extensions/remote-notify/`，`/reload` 即可加载，无需注册到 `packages`。

```bash
# 1. 安装依赖（首次或 node_modules 丢失时执行）
cd ~/.pi/agent/extensions/remote-notify
npm install

# 2. 在 pi 中重载扩展
#    在 pi 交互界面执行：
/reload

# 3. 开启飞书提醒
/remote-notify on

# 4. 跑一个任务，任务结束后飞书收到「✅ 任务完成」+ 总结
```

## 配置

### 凭证来源与优先级

加载顺序（先命中的生效）：

1. **环境变量**（`PI_FEISHU_NOTIFY_*`，显式覆盖）
2. **ask-question 插件配置** `~/.config/rpiv-ask-user-question/config.json`（默认，已验证可用）
3. **现有飞书桥接** `~/.pi/agent/feishu/`（兜底）

三者都不可用时不发送（插件静默禁用，不影响其它扩展）。

### 方式 A：ask-question 配置（推荐，默认）

复用 rpiv-ask-user-question 插件的飞书应用凭证。文件 `~/.config/rpiv-ask-user-question/config.json`：

```jsonc
{
  "remote": {
    "feishu": {
      "appId": "cli_xxxxxxxxxxxxxxxx",
      "appSecret": "xxxxxxxxxxxxxxxxxxxx",
      "receivers": [{ "type": "chat_id", "value": "oc_xxxxxxxxxxxxxxxxxxx" }]
    }
  }
}
```

- `appId` / `appSecret`：飞书开放平台**自建应用**凭证（应用需开启**机器人能力**）
- `receivers[0]`：通知收件人，`type` 为飞书原生 `receive_id_type`（`chat_id` / `open_id` / `user_id` / `union_id` / `email`），插件取第一个
- 只读取 `remote.feishu` 三项，其它字段不影响

### 方式 B：现有飞书桥接（兜底）

若方式 A 缺失/非法，回退读取 `~/.pi/agent/feishu/`：

- `config.json` → `appId` / `appSecret` / `domain`（`feishu` | `lark`）
- `bridge.json` → 第一个 route 的 `chatId`（p2p 会话），无则取 p2p key 中的 `open_id`

> ⚠️ 注意：`~/.pi/agent/feishu/config.json` 里的应用此前已被删除（错误码 `10217 app has been deleted`），因此默认走方式 A。

### 方式 C：环境变量（可选覆盖）

| 变量 | 作用 |
| --- | --- |
| `PI_FEISHU_NOTIFY=0` | 强制禁用本扩展 |
| `PI_FEISHU_NOTIFY_APP_ID` | 覆盖应用 appId |
| `PI_FEISHU_NOTIFY_APP_SECRET` | 覆盖应用 appSecret |
| `PI_FEISHU_NOTIFY_CHAT_ID` | 覆盖收件人（chat_id） |
| `PI_FEISHU_NOTIFY_OPEN_ID` | 覆盖收件人（open_id） |
| `PI_FEISHU_NOTIFY_DOMAIN` | 覆盖域名（`feishu` | `lark`） |
| `PI_FEISHU_NOTIFY_INCLUDE_SUBAGENTS=1` | 也通知 subagent 会话（默认跳过） |
| `PI_FEISHU_NOTIFY_SESSION_END=0` | 关闭会话结束提醒 |

## 使用

### 命令

| 命令 | 说明 |
| --- | --- |
| `/remote-notify` | 切换开关（默认关闭） |
| `/remote-notify on` | 开启 |
| `/remote-notify off` | 关闭 |
| `/remote-notify status` | 查看当前状态 |

开关状态持久化到 `~/.pi/agent/feishu/remote-notify-state.json`，重启 pi 后保持上次状态。

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
- **发送机制**：`@larksuiteoapi/node-sdk` 的 `new Client({ appId, appSecret, domain }).im.v1.message.create`，纯 REST；参考 rpiv-ask-user-question 的 `feishu-channel.ts`
- **异常兜底**：所有发送异步 + catch，绝不抛出未捕获异常影响 pi 主流程

## 与 pi-cmux 的关系

- **不修改、不依赖 pi-cmux 的任何代码/状态**，二者独立订阅事件、独立运行
- 发送走纯 REST，**不建立 websocket 长连接**，不与 feishu gateway 抢连接资源
- subagent 会话默认跳过（`PI_FEISHU_NOTIFY_INCLUDE_SUBAGENTS=1` 开启，与 pi-cmux 的 `PI_CMUX_INCLUDE_SUBAGENTS` 语义一致）

## 测试

```bash
cd ~/.pi/agent/extensions/remote-notify

# 独立测试：加载注册、命令 toggle 持久化、摘要提取、关闭态不发送
node test/run-test.mjs

# 共存验证：pi-cmux + remote-notify 同时加载互不干扰
node test/coexist-check.mjs
```

## 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 不发通知 | 检查 `/remote-notify status` 是否已开启；确认凭证来源可读（见上文配置） |
| `10217 app has been deleted` | 该飞书应用已被删除，换用有效凭证（默认走 ask-question 配置） |
| token 获取失败 | 检查 `appId` / `appSecret` 是否正确、应用是否开启机器人能力 |
| 发送报错"bot 不在会话" | 收件人 chat_id 需是机器人所在会话；用 `PI_FEISHU_NOTIFY_CHAT_ID` 覆盖 |
| 子代理任务也提醒 | 默认跳过 subagent；如需包含设 `PI_FEISHU_NOTIFY_INCLUDE_SUBAGENTS=1` |
| 会话结束不提醒 | 默认开启；`PI_FEISHU_NOTIFY_SESSION_END=0` 会关闭 |
| 发送报错但 pi 无感 | 正常——错误仅记录到 pi 日志（console），不影响主流程 |

## 环境变量汇总

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `PI_FEISHU_NOTIFY` | 启用 | `0` 强制禁用 |
| `PI_FEISHU_NOTIFY_APP_ID` / `_APP_SECRET` | ask-question 配置 | 覆盖凭证 |
| `PI_FEISHU_NOTIFY_CHAT_ID` / `_OPEN_ID` | ask-question 配置 | 覆盖收件人 |
| `PI_FEISHU_NOTIFY_DOMAIN` | 配置内 domain | 覆盖域名 |
| `PI_FEISHU_NOTIFY_INCLUDE_SUBAGENTS` | `0` | `1` 包含 subagent |
| `PI_FEISHU_NOTIFY_SESSION_END` | 开启 | `0` 关闭会话结束提醒 |
