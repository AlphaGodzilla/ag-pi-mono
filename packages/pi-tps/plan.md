# Plan: pi-tps v1

对应规格：`SPEC-pi-tps.md` ｜ 状态：v1.8 已实施（T1-T3 完成，T4 待目视验收） ｜ 日期：2026-09-09

## 1. 组件与依赖

| 组件 | 职责 | 依赖 |
|---|---|---|
| `lib/tps.ts` | 纯逻辑：TPS 计算、样本累积（min/max/avg/cur）、TTFT 统计（最近一次 + 平均）、CJK 感知 token 估算、状态文本格式化（含 `· … ·`） | 无（零 import） |
| `test/tps.test.ts` | `node:test` 单元测试，只覆盖 `lib/tps.ts` | `lib/tps.ts`、`node:test` |
| `index.ts` | 扩展胶水：事件订阅、流式状态机、TTFT 打点、widget 注册与 `render(width)` 自适应折行、节流刷新 | `lib/tps.ts`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`（渲染工具） |
| `scripts/verify-wiring.mjs` | 离线接线验证（jiti + fake pi），不参与 `node --test` | `index.ts`、jiti |
| `package.json` | pi 包声明，让 settings.json 的 `"pi-tps"` 能被解析 | 无 |
| `README.md` | 安装/加载/调参/排障说明 | 无 |

依赖方向单向：`index.ts → lib/tps.ts`；`lib` 不反向依赖，也不依赖任何 pi 包（保证测试可脱离 pi 运行）。
无环，无跨模块接口协商需求。

## 2. 实施顺序（严格串行，每步可验证）

```
T1 lib/tps.ts + test/tps.test.ts   ← 纯逻辑先行（TDD：先写失败测试）
      │
T2 index.ts（事件接线 + widget 注册 + 自适应折行 + 清理）
      │
T3 接入：package.json → settings.json packages 追加 "pi-tps"
      │
T4 手动验收 + README
```

- **T1 必须最先**：统计与格式化的正确性是全部验收标准的根基；纯函数可离线验证，不依赖 pi 运行时。
- **T2 依赖 T1**：胶水层只调用已验证的纯函数。
- **T3 依赖 T2**：没有可加载的入口就谈不上接入。
- **T4 依赖 T3**：只有真正加载进 pi 才能观察流式行为。
- 可并行项：无（单模块小插件，并行收益为负）。

## 3. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 流式估算偏差（中文按 chars/4 会低估 2–4 倍） | CUR 在流式中明显低于结束值，观感像"跳变" | CJK 感知估算（CJK≈0.75 token/字）；结束时用精确 `usage.output` 校正；MIN/MAX 只采信精确值 |
| **窗口塌缩伪影**：无思考的纯工具调用整块一次到齐，首字→结束仅几十 ms，`usage.output` 却有几十 token → 虚高到上千 t/s（实测 MAX 1308.3） | MIN/MAX/AVG 被污染且 MAX 只增不减 | v1.5 样本门槛：窗口 <500ms 或输出 <20 tokens 丢弃；流式中未达门槛 CUR 显示 `--`；接线验证含回归用例（49 tok / 37 ms） |
| `message_update` 高频触发导致更新抖动/卡顿 | 拖慢 TUI | 更新节流 120ms；只在 `message_end`/`message_start` 强制更新 |
| 首次响应前无数据 | 用户以为插件没生效 | 显示 `TTFT -- · MIN -- MAX -- AVG -- CUR -- t/s` 占位 |
| 多次 session_start / `/reload` 造成重复或残留 | 出现两段 TPS | widget key 固定 `"pi-tps"`（覆盖式重建）+ `session_shutdown` 时 `setWidget(key, undefined)` |
| 窄窗口把文本挤掉（v1.6 前的 status 方案） | 信息不可见 | 改回 widget 独占行，`render(width)` 自适应折行；`setStatus` 因 footer 单行截尾而不可用 |
| 非流式/非 DeepSeek provider 中途无 usage | 实时值只有估算 | 检测到 `usage.output > 0` 时直接用精确值（Anthropic 等）；否则估算 |
| 无 delta 的响应（异常/非流式） | 采样时长含 TTFT，污染 MIN/MAX；TTFT 也无法测得 | 无首 delta 则**跳过该样本**（TPS 与 TTFT 都不计入） |
| assistant `timestamp` 缺失/异常（第三方 provider） | TTFT 无法计算或为负 | 非有限值回退 `Date.now()`；计算值 <0 时 `recordLatency` 忽略 |
| pi 升级导致 UI API 变化 | 插件失效 | 只用公开 API（`ctx.ui.setWidget` + `render(width)` + 事件），不深链 `dist/` 内部模块 |

## 4. 验证检查点

| 检查点 | 时机 | 判定 |
|---|---|---|
| CP1 | T1 完成 | ✅ `node --test` 39/39 全绿（含样本门槛与 TTFT） |
| CP2 | T2 完成 | ✅ `scripts/verify-wiring.mjs` 13/13 离线接线验证通过（含折行/极窄截断与伪影回归） |
| CP3 | T3 完成 | ✅ `pi list` + pi 包管理器确认 `pi-tps` → `index.ts` 已解析（`/reload` 去重待目视） |
| CP4 | T4 完成 | ⏳ 待用户在真实 TUI 对话中目视验收（TPS 与 TTFT 滚动与收敛） |

## 5. 交付物

- 代码：`index.ts`、`lib/tps.ts`、`package.json`
- 测试：`test/tps.test.ts`（23 用例）、`scripts/verify-wiring.mjs`（11 项离线接线验证）
- 配置：`~/.pi/agent/settings.json` 的 `packages` 追加 `"pi-tps"`（唯一的外部改动，已完成）
- 文档：本目录 `SPEC.md` / `SPEC-pi-tps.md` / `plan.md` / `todo.md` + `README.md`
