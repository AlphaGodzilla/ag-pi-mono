# pi-llm-provider-balance

pi 扩展：在状态栏按当前 provider 显示对应账户的余额。

同一进程内所有会话共享一套定时轮询与余额数据；余额来源由当前会话所用模型的
provider 决定（如 `cpa_arb`/`cpa_mybitx`/`cpa_mybitx_anthropic` → derouter 中转
账户余额，`deepseek` → DeepSeek 官方账户余额），对应关系可在配置中自行增删。

## 能力

- **按 provider 路由余额源**：状态栏显示当前模型所属 provider 对应的账户余额
  （`Derouter: $77.15`、`DeepSeek: ¥110.00` 等）；provider 不在映射表中时清除本插件
  状态栏项、不显示任何内容，避免余额张冠李戴与无意义占位
- **定时刷新**：默认每 600s（可配置）轮询当前活跃会话 provider 对应的源；provider 未映射
  （不在映射表）或无活跃会话时该周期零请求跳过；所有会话共享定时器与刷新结果
- **切换即刷新**：切换模型 / provider（`model_select`）时立即刷新新 provider
  对应的余额源，不必等下一个轮询周期；每次进入会话也会立即刷新其对应源
- **手动刷新**：`/derouter-refresh`（历史名）与 `/balance-refresh`（别名）立即刷新
  全部已配置余额源
- **失败降级**：各余额源独立缓存，拉取失败保留旧值并加 `⚠` 标记；从未成功显示
  `unavailable`；绝不抛出异常影响主 agent
- **进程内单例**：同一 pi 进程内所有会话共享一个定时器与一份余额数据，会话切换
  只替换状态栏目标；模块作废（quit / reload / 跨 cwd 会话替换）时自动清理定时器，
  无定时器泄漏

## 加载

本扩展是标准 pi 包（`package.json` 含 `pi.extensions` manifest 与 `pi-package` 关键词），
可通过本地目录、git 或 npm 安装：

**本地开发**：在 `~/.pi/agent/settings.json` 的 `packages` 中以目录登记（pi 按包规则
读取 `pi.extensions` 声明加载 `index.ts`）：

```json
{
  "packages": [
    "pi-llm-provider-balance"
  ]
}
```

修改后执行 `/reload` 或重启 pi 生效。

**远程安装**（仓库已含标准包结构，可从 git 安装）：

```bash
pi install git:github.com/AlphaGodzilla/pi-llm-provider-balance
```

## 配置

配置文件放在 pi 用户目录下（**不在仓库内**）：

```
~/.pi/agent/extensions/pi-llm-provider-balance/config.json
```

查不到它时回落到**包目录内的 `config.json`**（旧位置/开发期用）；两处都没有则降级为空配置，仅显示
unavailable，不影响 pi 启动。完整示例见 [`config.example.json`](./config.example.json)：

```json
{
  "derouterClientKey": "sk-ant-YOUR_CLIENT_KEY",
  "refreshIntervalMs": 60000,
  "deepseekApiKey": "sk-YOUR_DEEPSEEK_API_KEY",
  "providerBalanceSources": {
    "cpa_arb": "derouter",
    "cpa_mybitx": "derouter",
    "cpa_mybitx_anthropic": "derouter",
    "deepseek": "deepseek"
  }
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `derouterClientKey` | 使用 derouter 源时 | derouter 账户 client key |
| `refreshIntervalMs` | 否 | 轮询间隔（毫秒），默认 600000 |
| `deepseekApiKey` | 使用 deepseek 源时 | DeepSeek API key（查询官方账户余额） |
| `providerBalanceSources` | 否 | provider → 余额源映射表；缺省整个字段时保持旧行为（一律按 derouter）；字段存在但某 provider 不在表中时该 provider 不显示本插件状态项（清除） |

安全：key 只在本模块内用于请求头，绝不打印 / 写日志 / 注入 LLM 上下文。

### 新增余额源

当前支持两种源类型：`derouter`（derouter 中转账户，`remaining`，美元）与
`deepseek`（DeepSeek 官方账户，`total_balance`，CNY/USD 按接口返回自适应）。
新增源需在 `index.ts` 中扩展 `BalanceSource`、拉取与格式化逻辑，并补 `lib/` 纯逻辑
与测试——映射表本身则无需改代码，只动配置。

## 状态栏语义

| 显示 | 含义 |
| --- | --- |
| `· Derouter: $77.15` | 当前 provider 对应 derouter 源，余额 77.15 美元 |
| `· DeepSeek: ¥110.00` | 当前 provider 对应 DeepSeek 官方账户，余额 110.00 元 |
| `· Derouter: $50.00 ⚠` | 最近一次刷新失败，显示的是上一次成功值 |
| `· DeepSeek: unavailable` | 该源从未成功拉取（key 未配置 / 无效 / 接口失败） |
| （不显示） | 当前 provider 未配置余额源（不在映射表）时清除本插件状态项，状态栏不出现任何内容 |

前缀 `· ` 用于与状态栏中的相邻状态分隔（pi footer 对扩展状态仅以空格拼接、无分隔符，
且扩展 API 无法感知邻居，故只在自己文本**前面**加分隔点；整行自然成为 `· A · B · C`，
既不与相邻扩展的分隔点连成双点，被截尾时也不会残留孤立的 `·`）

## 开发

```
pi-llm-provider-balance/
├── index.ts                  # 扩展入口：事件、单例、定时器、渲染
├── package.json              # 标准 pi 包声明（pi.extensions manifest + pi-package 关键词）
├── config.example.json       # 配置示例（真实配置在 ~/.pi/agent/extensions/pi-llm-provider-balance/config.json）
├── lib/
│   ├── balance.ts            # derouter 余额解析/格式化（纯逻辑）
│   └── deepseek.ts           # DeepSeek 余额解析/格式化（纯逻辑）
├── scripts/manual-fetch.mjs  # 手动抓取验证：node scripts/manual-fetch.mjs [derouter|deepseek]
└── test/                     # node:test 单测（Node ≥22.18）
```

运行测试（不触网，fetch 按 URL mock）：

```bash
node --test test/*.test.ts
```

手动验证真实接口（需要用户配置或包目录的 `config.json` 中已填对应 key，仅打印余额不打印 key）：

```bash
node scripts/manual-fetch.mjs derouter
node scripts/manual-fetch.mjs deepseek
```

## 设计要点（改动前必读）

- **纯逻辑与副作用分离**：`lib/` 下解析/格式化函数不得 import pi API、不触网、
  无定时器，可独立单测；网络、单例、渲染只在 `index.ts`。
- **单例机制**：pi 对扩展工厂做缓存（同 cwd 未 `/reload` 时复用同一闭包），模块级
  `stores/displays/timer` 天然跨会话共享；仅 `/reload` 或切换项目 cwd 才重新求值。
- **定时器清理判据**：`session_shutdown` 后若 `displays` 清空（模块已无任何 UI
  消费者——quit / reload / 跨 cwd 会话替换均如此），即 `clearInterval`，新会话的
  `session_start` 会重建并首拉；仍有其它存活会话则保留。不要改回按
  shutdown reason 白名单清理——跨 cwd 替换时旧模块收不到 reload 通知。
- **轮询策略**：定时 tick 只刷新 `instanceSources`（各会话当前 provider 对应的源，未映射会话不贡献），
  无活跃源时零请求跳过；只有手动命令才全刷 `configuredSources()`。不要改回 tick 全刷——那会让
  未映射 provider（如官方直连）期间每周期都在后台空转发请求。
- **测试隔离**：模块级状态跨用例共享，每个测试用例必须在 `finally` 中 shutdown
  全部 harness，保证 displays 清空、定时器被清。
