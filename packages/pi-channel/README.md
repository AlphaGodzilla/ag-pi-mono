# pi-channel（`@alphagodzilla/pi-channel`）

pi 的**外部通信 channel 插件**：独占 provider 凭据与连接生命周期（飞书长连接 / Telegram 长轮询），通过 `ag-pi-channel:*` 事件契约向其它扩展提供传输能力。消费方**不依赖任何代码**，只发/收事件——包括跨仓库的 `@juicesharp/rpiv-ask-user-question`。

## 事件契约

| 通道 | 方向 | 载荷 |
| --- | --- | --- |
| `ag-pi-channel:send` | 消费方 → 插件 | **按 provider 判别的联合**（两家的"卡片"不是同一层概念，字段不共用）：见下节 |
| `ag-pi-channel:send:result` | 插件 → 消费方 | `{ requestId, ok, messageId?, error?: {code, message} }` |
| `ag-pi-channel:inbound` | 插件 → 消费方 | 消息：`{ kind:"message", chatId, chatType?, senderId, messageId, text, contentType, timestamp? }`；按钮：`{ kind:"action", chatId, senderId, messageId, value }` |
| `ag-pi-channel:status` → `:status:result` | 双向 | 连接状态、配置路径、脱敏账号、最近错误 |

约定：

- **请求/响应用 `requestId` 关联**：pi 的 EventBus 是单向的（`emit(channel, data): void`），所以 result 走独立通道。同仓库消费方用 `sendViaBus()` / `statusViaBus()`；跨仓库消费方复制同一实现即可（契约一致，见 `lib/events.ts`）。
- **卡片/键盘是 provider 原生结构**（飞书卡片 JSON / Telegram `reply_markup`），插件不理解其业务语义；按钮语义留在消费方。
- 按钮 `value` 里带字符串字段 `ackText` 时，插件用它回 ack（飞书 3 秒回调响应 / Telegram `answerCallbackQuery`），缺省「已收到」。
- 出站不要求已连接：飞书走 REST、Telegram 走 Bot API HTTP；`inbound: false` 时只做出站，不建连接。
- 插件缺席或超时 → `ok:false`（`code: "timeout"` / `"not_configured"` / `"plugin_missing"`），消费方据此降级，**绝不抛异常打断主流程**。
- **消费方建议先做 pre-flight**：首次发送前 `await statusViaBus(pi.events, 1_500)`；返回 `null` 即插件未加载，比等 `send` 超时（默认 10s）快得多，也便于据此回落到其它交互路径（`rpiv-ask-user-question` 就是这么做的：通道不可用时改用本地 TUI 问卷并提示用户）。

```ts
// 消费方示例（同仓库）
import { sendViaBus } from "./lib/events.ts";
const result = await sendViaBus(pi.events, { provider: "feishu", kind: "text", text: "任务完成" });
if (!result.ok) logError(`${result.error?.code}: ${result.error?.message}`);
```

### 出站载荷（按 provider 判别，字段不共用）

- **飞书**：`feishuCard` 就是整条消息（`msg_type: interactive`，卡片自带 header/body）
  - `{ provider: "feishu", kind: "text", text }`
  - `{ provider: "feishu", kind: "card", feishuCard, update?: { messageId } }`（带 `update` = 整卡 patch）
- **Telegram**：`telegramKeyboard` 只是 `reply_markup` 附件，正文必须另给 `text`
  - `{ provider: "telegram", kind: "text", text, parseMode?, update? }`
  - `{ provider: "telegram", kind: "card", text, telegramKeyboard, parseMode?, update? }`（发消息或"改正文+键盘"）
  - `{ provider: "telegram", kind: "keyboard", telegramKeyboard, update }`（只换键盘，不动正文）

编译期即可挡住"把飞书卡片发给 telegram"这类错配；插件对两边的原生载荷都只做原样投递（`create` / `patch` / `editMessage*`），不理解其业务语义。

## 配置

唯一来源：`~/.pi/agent/extensions/pi-channel/config.json`（**不在仓库内**；目录约定见仓库根 `AGENTS.md`）。完整示例见 [`config.example.json`](./config.example.json)。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `feishu.appId` / `feishu.appSecret` | ✓ | 飞书自建应用凭证（需开启机器人能力） |
| `feishu.domain` | | `feishu`（缺省）\| `lark` |
| `feishu.inbound` | | 是否建长连接收消息/卡片回调，缺省 `true` |
| `feishu.requireMention` | | 群聊仅 @ 机器人 才算入站，缺省 `true` |
| `feishu.dmMode` | | `open`（缺省）\| `allowlist` \| `pair` \| `disabled`（对齐 SDK `PolicyConfig`） |
| `feishu.defaultReceiver` | | 缺省收件人 `{ type, value }`（消费方不带 `to` 时使用） |
| `telegram.botToken` | ✓ | Bot token |
| `telegram.inbound` | | 是否长轮询收消息/按钮，缺省 `true` |
| `telegram.defaultChatId` | | 缺省收件人 chat id |
| `telegram.proxy` | | 可选 HTTP(S) 代理，如 `http://127.0.0.1:6152` |

## 运行数据

- `~/.pi/agent/extensions/pi-channel/error.log` —— 连接/发送失败日志（绝不写 console，避免污染 TUI/cmux）。

## 命令

| 命令 | 说明 |
| --- | --- |
| `/channel` 或 `/channel status` | 显示两个 provider 的配置/连接状态与配置路径 |
| `/channel reload` | 重载 `config.json` 并重建连接 |
| `/channel send <文本>` | 用缺省收件人做一次真实发送，验证链路 |

## 实现注意（TUI 安全）

- **`session_start` 里的连接是后台的、绝不 `await`**：pi 的 `/reload` 会逐个 `await` 所有扩展的 `session_start` handler（`agent-session.reload()`），而建飞书长连接实测 ~2.6s、Telegram 长轮询 ~0.8s——阻塞会让 TUI 的输入区消失数秒（实测修复前 ≈3s → 修复后 9ms）。连接结果看 `/channel status`；出站不依赖连接。
- **飞书 SDK 的日志必须静音**：SDK 默认把 `[info]` 级日志（含长连接使用说明的整段横幅与 `[ws] ws client ready`）写到 stdout，在 pi TUI 里会**直接渲染进输入区**。因此给 `Client` 与 `createLarkChannel` 都传一个空实现的 `logger`，我们只写自己的 `error.log`。

## 能力来源与迁移

- 飞书与 Telegram 的传输层自 `@juicesharp/rpiv-ask-user-question` 移植（2026-09-13）：`remote/feishu-channel.ts`（长连接、卡片回调 3s ack 注入、ack 后 400ms 再断连）、`remote/tg-channel.ts` + `remote/tg-http.ts`（零依赖 HTTP + 代理、长轮询去重）。
- 凭据从 `~/.config/rpiv-ask-user-question/config.json` 的 `remote.feishu` / `remote.tg` 搬到本插件配置（**本插件是唯一凭据持有者**）。
- 消费方：`pi-remote-notify`（出站提醒）、`rpiv-ask-user-question`（双向问卷；卡片构建与回复解析等业务语义仍留在该包）。

## 测试

```bash
node --test packages/pi-channel/test/*.test.ts
```

43 项（feishu 16 / telegram 21 / 入口集成 6）：注入假 client、假 channel 与假 `getUpdates` fetch，**全程不触网**；入口集成用 pi 自带 `createEventBus()` + 假 pi 验证事件分发、状态回报与 `/channel` 命令。
