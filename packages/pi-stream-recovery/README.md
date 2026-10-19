# pi-stream-recovery

本扩展将指定的“响应完成前断流”错误接入 pi 原生自动重试，避免每次断流后都需要手动输入“继续”。它只补齐错误分类，不创建重试循环、不切换模型，也不注入用户消息。

## 处理范围

仅处理 `assistant` 消息、`stopReason: "error"` 且错误文本符合以下白名单的情况：

```text
stream error: stream disconnected before completion: stream closed before response.completed
upstream stream closed before any chunk carried finish_reason
```

第一条按去空白后的原文精确比对。第二条由 OpenAI 兼容网关（如 opencode-go）在首个携带 `finish_reason` 的 chunk 之前断开连接时上报，比对时忽略大小写、文本两端空白，并允许文本前带一层 `Error:` 标签。两条签名命中任意一条即按同一规则归一化，替换后仍保留完整原文：

```text
Network error [pi-stream-recovery]: <完整原始错误>
```

`message_end` 的返回值替换失败消息的 `errorMessage`。角色、失败状态、工具内容、usage 和时间戳均保持不变；输入消息不被扩展直接修改。pi 在持久化和自动重试判断之前应用替换，随后使用其原生重试预算与退避策略。

以下情况不处理：

- 用户已经取消当前操作，或响应状态为 `aborted`。
- 非白名单错误，包括普通网络错误、认证失败、额度耗尽和上下文溢出。
- 当前运行时已经把该错误判定为可重试；pi 原生支持后，扩展自动跳过归一化。
- 非 assistant 消息或非失败响应。

扩展覆盖 agent 对话中的 assistant 响应，不覆盖压缩摘要、分支摘要或其它扩展内部的嵌套模型调用。它不解决上游连接关闭的原因，也不能缩短断流被检测之前的等待时间。

## 启用与配置

通过 agent 目录下 `settings.json` 的 `packages` 加载本地包。相对路径以该 agent 目录为基准。

`~/.pi/agent/settings.json`：

```json
{
  "packages": ["../ag-pi-mono/packages/pi-stream-recovery"]
}
```

`~/.pi/agent2/settings.json`：

```json
{
  "packages": ["../agent/ag-pi-mono/packages/pi-stream-recovery"]
}
```

将路径追加到现有数组，不覆盖其它包。修改后执行 `/reload` 或重新启动 pi。

扩展没有独立配置、状态文件、定时器或重试预算。实际是否重试、次数和等待时间由 pi 的合并配置决定，项目 `.pi/settings.json` 可以覆盖 agent 配置。例如：

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 5,
    "baseDelayMs": 4000,
    "maxAgentDelayMs": 60000,
    "provider": { "maxRetries": 0 }
  }
}
```

上述示例表示首次请求之外最多重试 5 次，退避等待依次为 4、8、16、32、60 秒。关闭 `retry.enabled` 或把 `maxRetries` 设为 0 时，扩展仍会归一化错误，但 pi 不会自动重试。重试耗尽后停止；扩展不会另发“继续”绕过上限。取消行为和重试提示由 pi 原生机制负责。

依赖运行时公开的 `message_end` 消息替换契约与 `isRetryableAssistantError` 分类函数，不调用私有 API、不修改 pi 安装文件。重试分类依据规范化后的错误文本，因此升级 pi 时应运行集成测试确认这两个公开契约仍然成立。

## 工具安全

扩展始终保留 `stopReason: "error"`。pi 不执行该失败响应中的工具调用，并在安排重试时保留失败记录、从后续模型上下文中排除失败响应。先前已完成的工具结果仍保留。

扩展不直接重放任何工具；后续模型仍可能重新发起操作，因此有外部副作用的工具必须自行提供幂等或状态核验保障，不能据此认为业务操作恰好执行一次。

## 测试

在仓库根目录运行：

```bash
pnpm --filter @alphagodzilla/pi-stream-recovery test
pnpm check
```

测试使用真实 pi SDK 与模拟 provider，不请求上游服务。配置和临时文件仅使用独立的 `/tmp` 目录，不读取宿主凭据或发现其它扩展。

覆盖错误归一化、原文保留、原生支持时跳过、取消与白名单边界，以及自动恢复、预算耗尽、重试关闭、部分工具调用不执行、已完成工具结果保留、TUI/JSON/RPC/print 模式、重复 reload 与并发会话隔离。

## 停用

从对应 `settings.json` 的 `packages` 数组移除本包路径，然后执行 `/reload` 或重新启动 pi。停用不修改历史 session，也不改变原生重试配置。
