# Spec: pi-tps —— pi TUI 实时显示 LLM 生成速度（TPS）

模块 id: `pi-tps` ｜ 状态: v1.8 已实施（待 TUI 目视验收） ｜ 版本: v1.8 ｜ 日期: 2026-09-09

## Objective

在 pi 的 TUI 中，于 editor 与内置 footer 之间新增**独占一行**的 widget，实时显示当前会话的 LLM 生成速度（tokens/s）与首字延迟：
`TTFT` / `MIN` / `MAX` / `AVG` / `CUR`，文本以 `·` 分隔（与 `pi-llm-provider-balance` 风格一致）；窗口不足时自动折行。

- **目标用户**：仅本机 pi 个人使用者（配置目录 `~/.pi/agent`），单用户、无多租户需求。
- **为什么**：内置 footer 只显示 token 总量、缓存命中与成本，没有速度指标；不同模型/供应商生成速度差异很大，需要可观测。
- **口径（已确认）**：**纯生成速度** = 输出 tokens ÷（首个内容 delta → 响应结束），**不含** TTFT/排队时间。
  流式过程中用字符估算实时刷新 `CUR`，响应结束时用 provider 精确 `usage.output` 校正；`MIN`/`MAX`/`AVG` **只采信精确样本**。
- **样本有效性门槛（v1.5 新增，已确认）**：生成窗口 <500ms **或** 输出 <20 tokens 的响应视为**测量伪影**（无思考的纯工具调用常整块一次到齐，窗口塌缩到几十毫秒），
  不计入 `MIN`/`MAX`/`AVG`，流式中未达门槛时 `CUR` 显示 `--`；TTFT 不受此门槛影响（它本身不含窗口塌缩问题）。
- **首字延迟 TTFT（v1.2 新增，已确认）**：TTFT = 首个内容 delta 时刻 − assistant 消息 `timestamp`（pi 在发起 HTTP 请求前写入），
  即**含网络往返与排队**的端到端首字延迟；显示**最近一次 + 本次会话平均**，单位秒（2 位小数）；等待期不实时计时。
- **统计范围（已确认）**：**仅当前 session 内存统计**；pi 重启或 `/reload` 后清零，不落盘、不跨 session。
- **显示方式（已确认，v1.6 变更）**：`ctx.ui.setWidget("pi-tps", factory, { placement: "belowEditor" })`——独占一行（editor 与 footer 之间），
  `render(width)` 拿到整行宽度后**自适应**：放得下则**左对齐**单行，放不下则折成两行（第一行 TTFT、第二行 TPS，均左对齐）；
  **不再**与其它扩展挤同一条 footer 状态行；因为独占一行，**前后不再加 `·`**，仅在 TTFT 组与 TPS 组之间保留一个 `·` 作分隔。
- **着色（v1.7 变更）**：整行使用 `theme.fg("dim", …)`，与内置 footer 的 pwd/统计行完全一致（否则终端默认前景色更亮，视觉上显得字号更大）；
  仅**流式中的 `CUR`** 用 `accent` 色高亮，空闲时同样回到 dim。
- **明确不做（out of scope）**：自定义 footer（`setFooter`）、`setStatus` 状态行、跨 session 持久化、`/tps-reset` 命令、
  TTFT/首 token 延迟单独显示、按模型分组统计、历史曲线、多 provider 对比、配置文件。

### 验收标准（成功标准）

1. pi TUI 中 editor 与 footer 之间出现一行**左对齐**的 `TTFT … · MIN <x.x> MAX <x.x> AVG <x.x> CUR <x.x> t/s`（前后无 `·`）。
   - 终端宽度不足时**自动折成两行**（第一行 TTFT、第二行 TPS，均左对齐）；单段仍超宽时硬截断，绝不消失。
2. 流式生成期间 `CUR` 实时变化（渲染节流 ≤120ms 间隔，肉眼可见滚动），响应结束后 `CUR` 校正为该响应的精确值；
   未达门槛（估算 tokens<20 或首字至今 <500ms）时 `CUR` 显示 `--`，空闲时 `CUR` 显示最近一次已提交样本。
3. `MIN`/`MAX`/`AVG` 仅在响应结束后更新；样本有效条件：`usage.output ≥ 20`、生成窗口 ≥ 500ms、`stopReason` 不属于 `error`/`aborted`。
   - `AVG` = 本 session 有效样本的算术平均，位置在 `MAX` 与 `CUR` 之间。
   - 窗口 <500ms 或输出 <20 tokens 的样本被丢弃（测量伪影），不计入任何统计；TTFT 仍按 `usage.output > 0` 且非 error/aborted 记录。
4. 无样本时显示 `TTFT -- · MIN -- MAX -- AVG -- CUR -- t/s`，不报错、不崩溃、不闪烁。
5. `node --test` 全绿，覆盖 `lib/tps.ts` 的全部纯逻辑分支。
6. `/reload` 后 widget 正常，不重复、不残留（同一 widget key 覆盖式重建）；连续多轮对话数值单调合理地累积。
7. 非 TUI 模式（`-p` / `--json` / rpc）零副作用、不报错（`ctx.mode !== "tui"` 时直接返回）。
8. 零新增运行时依赖（仅 pi 扩展 API + Node 内置能力）。
9. 已提交样本满足 `MIN ≤ current ≤ MAX`；流式中的实时 CUR 是未提交的估算值，允许暂时越界，响应结束后收敛回区间内。
10. 首字延迟：显示 `TTFT <最近一次>s avg <平均>s`；首个样本提交前显示 `TTFT <实时值>s`（无 avg 段）；无值时 `TTFT --`；口径 = 请求发出 → 首个内容 delta。
11. TTFT 与 TPS 同源于 `isCountable` 响应；TPS 额外要求样本足够大（≥20 tokens 且窗口 ≥500ms），TTFT 不受该门槛限制。

## Tech Stack

- 运行时：pi 自带 Node 运行时（本机 `node v22.19.0`）；语言 TypeScript，由 pi 内置 jiti 直接加载，**无编译步骤**。
- 平台 API：`@earendil-works/pi-coding-agent` 的 `ExtensionAPI` / `ExtensionContext`；事件 `session_start`、
  `message_start`、`message_update`、`message_end`、`session_shutdown`；UI 方法 `ctx.ui.setWidget`。
- 渲染：`@earendil-works/pi-tui` 的 `Component`（`render(width)` 收到整行宽度）+ `truncateToWidth` / `visibleWidth`；
  自行负责左对齐、折行与截断（v1.6 重新引入该依赖）。
- 依赖：**零运行时依赖**；`import type` 仅类型标注，jiti 运行时擦除；`lib/` 不 import 任何 pi 包。
- 配置：无配置文件（v1 零配置），可调常量写在 `index.ts` 顶部。

### 上游契约（实测确认，非假设）

| 事实 | 来源 |
|---|---|
| `setWidget(key, factory, { placement: "belowEditor" })` 的槽位在 editor 之后、footer 之前 | `dist/modes/interactive/interactive-mode.js` 挂载顺序 |
| widget 组件 `render(width)` 收到整行可用宽度（与内置 footer 同宽），可自行左对齐/折行 | `Container.render(width)` 透传宽度 |
| `setWidget(key, undefined)` 清除该 widget | `dist/core/extensions/types.d.ts` |
| **不用 `setStatus` 的原因**：footer 把所有扩展状态按 id 字母序拼成**同一行**并 `truncateToWidth` 截断尾部，且 `sanitizeStatusText` 把换行符替换成空格 → 窄窗口必被截掉、无法折行 | `dist/modes/interactive/components/footer.js:210-217` |
| `·`（U+00B7）仅用作**内部**两组指标的分隔；widget 独占行后**前后不再加** `·`（那是 footer 多扩展拼接时的约定） | `pi-llm-provider-balance/index.ts:201-202`（分隔符字符来源） |
| 内置 footer 的 pwd 行与统计行**全部**用 `theme.fg("dim", …)` 着色 | `dist/modes/interactive/components/footer.js:204/206/207` |
| assistant 消息 `timestamp` 在 HTTP 请求**发出前**写入（可作 TTFT 起点） | `pi-ai/dist/api/openai-completions.js:186`（请求在 213 行） |
| `message_start`(assistant) 在 HTTP 响应头到达时触发，**不是**首 token | `pi-ai/dist/api/openai-completions.js`（`stream.push({type:"start"})`） |
| DeepSeek/OpenAI 兼容流式**中途不带 usage**，仅末尾 chunk 带 | 同上（`chunk.usage` 仅在最终 chunk 处理） |
| Anthropic 流式会中途更新 `usage.output` | `pi-ai/dist/api/anthropic-messages.js` |
| `usage.output` 含 reasoning/thinking tokens | `pi-ai/dist/types.d.ts` 的 `Usage.reasoning` 注释 |

## Commands

| 用途 | 命令（在 `pi-tps/` 目录下执行，或注明路径） |
|---|---|
| 单元测试 | `cd pi-tps && node --test`（Node ≥22.18 默认 TS type-stripping，已实测可用） |
| 离线接线验证 | `cd pi-tps && node scripts/verify-wiring.mjs`（jiti + fake pi 模拟事件流，无需启动 pi） |
| 快速手动加载（不改配置） | `pi -e ~/.pi/agent/pi-tps/index.ts` |
| 正式加载 | 在 `~/.pi/agent/settings.json` 的 `packages` 数组追加 `"pi-tps"`，重启 pi |
| 热重载 | pi TUI 内输入 `/reload` |
| 手动观察验收 | 正常对话，观察 editor 与 footer 之间的 `TTFT · MIN/MAX/AVG/CUR` 行变化 |
| 类型检查（可选，需 devDependency） | `cd pi-tps && npx tsc --noEmit` |

## Project Structure

```
~/.pi/agent/pi-tps/
├── SPEC.md              # 本插件的规格索引（仅索引，不承载业务规格）
├── SPEC-pi-tps.md       # 本模块规格（本文件）
├── plan.md              # 实施计划
├── todo.md              # 任务清单
├── package.json         # pi 包声明：{ "pi": { "extensions": ["./index.ts"] } }
├── index.ts             # 扩展入口：事件接线、节流更新、status 生命周期（胶水层）
├── lib/
│   └── tps.ts           # 纯逻辑：采样器、CJK 感知 token 估算、状态文本格式化（不 import pi）
├── test/
│   └── tps.test.ts      # node:test 单元测试，仅测 lib/tps.ts
├── scripts/
│   └── verify-wiring.mjs # 离线接线验证（jiti + fake pi，不参与 node --test）
└── README.md            # 安装/加载/调参/排障说明
```

- **分层规则**：`lib/tps.ts` 纯函数、无副作用、无 pi 依赖；`index.ts` 只做「订阅事件 → 更新状态 → 触发重绘」。
- 不新增 `src/`、不新增构建产物目录；测试与源码同目录树对应。

## Code Style

- 缩进 2 空格、双引号、句尾分号、箭头函数优先；类型只写在边界处。
- 命名：`camelCase` 变量/函数，`PascalCase` 类型，`SCREAMING_SNAKE` 常量；widget key 固定 `"pi-tps"`。
- 纯函数优先；副作用（时间读取、渲染、计时器）集中在 `index.ts`。
- 所有事件处理器内部 try/catch 兜底，异常不得冒泡到 pi 主循环。

```typescript
// lib/tps.ts —— 纯逻辑，可单测，不 import pi
export interface TpsStats {
  min: number | null;
  max: number | null;
  current: number | null;
  total: number; // 有效样本累加（tokens/s），用于 AVG
  samples: number;
}

export const MIN_SAMPLE_TOKENS = 20;
export const MIN_SAMPLE_WINDOW_MS = 500;

/** tokens / 秒；样本过小（<20 tokens 或窗口 <500ms）视为测量伪影，返回 null。 */
export function computeTps(tokens: number, durationMs: number): number | null {
  if (!Number.isFinite(tokens) || !Number.isFinite(durationMs)) return null;
  if (tokens < MIN_SAMPLE_TOKENS || durationMs < MIN_SAMPLE_WINDOW_MS) return null;
  return tokens / (durationMs / 1000);
}

/** CJK 感知估算：CJK 字符约 0.75 token/字，其余按 chars/4（pi 官方估算口径）。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) (isCjk(ch) ? cjk++ : other++);
  return Math.ceil(cjk * 0.75 + other / 4);
}

export interface LatencyStats {
  lastMs: number | null; // 最近一次 TTFT（毫秒）
  totalMs: number; // 有效样本累加（用于平均）
  samples: number;
}

/** 追加一个 TTFT 样本；无效值（null/非有限/负数）原样返回。 */
export function recordLatency(stats: LatencyStats, ms: number | null): LatencyStats {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return stats;
  return { lastMs: ms, totalMs: stats.totalMs + ms, samples: stats.samples + 1 };
}

/** `TTFT 0.85s avg 1.10s`；首个样本提交前 `TTFT 0.85s`；无值 `TTFT --`。 */
export function formatLatencyText(stats: LatencyStats, liveMs: number | null = null): string {
  const useLive = typeof liveMs === "number" && Number.isFinite(liveMs) && liveMs >= 0;
  const last = useLive ? liveMs : stats.lastMs;
  if (last === null) return "TTFT --";
  const avg = averageLatencyMs(stats);
  return avg === null
    ? `TTFT ${formatSeconds(last)}s`
    : `TTFT ${formatSeconds(last)}s avg ${formatSeconds(avg)}s`;
}

/** 状态文本分段（纯文本、不含分隔符）：`ttft` = `TTFT …`，`tps` = `MIN … MAX … AVG … CUR … t/s`。 */
export function formatStatusSegments(
  tps: TpsStats,
  latency: LatencyStats,
  view: StatusTextView = {},
): { ttft: string; tps: string } {
  const { head, cur } = formatTpsParts(tps, view.liveTps ?? null, view.streaming ?? false);
  return { ttft: formatLatencyText(latency, view.liveTtftMs ?? null), tps: `${head}${cur}` };
}

/** 单行状态文本：`TTFT a s avg b s · MIN x MAX y AVG z CUR w t/s`（前后无 `·`）。 */
export function formatStatusText(
  tps: TpsStats,
  latency: LatencyStats,
  view: StatusTextView = {},
): string {
  const seg = formatStatusSegments(tps, latency, view);
  return `${seg.ttft} · ${seg.tps}`;
}
```

```typescript
// index.ts —— 扩展胶水（节选）
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createStats, formatLatencyText, formatTpsParts } from "./lib/tps.ts";

const WIDGET_KEY = "pi-tps";
const UPDATE_THROTTLE_MS = 120;

export default function (pi: ExtensionAPI) {
  let ctxRef: ExtensionContext | null = null;
  let tuiRef: { requestRender(): void } | null = null;
  let stats = createStats();
  let lastUpdateAt = 0;
  let streaming = false;
  let liveTps: number | null = null;

  const scheduleUpdate = (force = false) => {
    const now = Date.now();
    if (!force && now - lastUpdateAt < UPDATE_THROTTLE_MS) return;
    lastUpdateAt = now;
    tuiRef?.requestRender();
  };

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return; // 非 TUI 模式零副作用
    ctxRef = ctx;
    stats = createStats();
    ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
      tuiRef = tui;
      return {
        render(width: number): string[] {
          const { head, cur } = formatTpsParts(stats, liveTps, streaming);
          const ttft = formatLatencyText(latencyStats, pendingTtftMs);
          // 与内置 footer 一致：整体 dim；仅流式中的 CUR 用 accent
          const dim = (s: string) => theme.fg("dim", s);
          const curText = streaming ? theme.fg("accent", cur) : dim(cur);
          const onePlain = `${ttft} · ${head}${cur}`;
          // 放得下：左对齐单行；放不下：折成两行（均左对齐）
          if (visibleWidth(onePlain) <= width) return [dim(`${ttft} · ${head}`) + curText];
          return [
            truncateToWidth(dim(ttft), width, dim("…")),
            truncateToWidth(dim(head) + curText, width, dim("…")),
          ];
        },
        invalidate() {},
        dispose() { tuiRef = null; },
      };
    }, { placement: "belowEditor" });
  });

  pi.on("message_update", async (event, _ctx) => {
    // 流式：首 delta 打点 → 估算 tokens → 实时 CUR → 节流更新
    // 结束：message_end 用 usage.output 精确校正并更新 MIN/MAX
    scheduleUpdate();
  });
}
```

> 注：以上为风格示例，完整事件接线（首 delta 打点、精确校正、样本过滤、清理）在实现阶段落地。

## Testing Strategy

- 框架：Node 内置 `node:test` + `node:assert/strict`，零依赖（已实测 `node --test` 能发现并执行 `.ts` 测试）。
- 位置：`test/tps.test.ts`，与 `lib/` 同目录树对应；**只测纯逻辑**，不测 pi 事件胶水与 TUI 渲染。
- 覆盖（`lib/tps.ts`）：
  - `computeTps`：正常值；窗口 <500ms 或 tokens <20 → `null`（边界 20/500 通过）；`NaN`/`Infinity`/负值 → `null`。
  - `formatTpsParts`：流式中未达门槛（`streaming=true` 且无有效 live）→ `CUR --`；空闲回退 `stats.current`；实时值覆盖 CUR。
  - `recordSample`：首个样本、min/max 更新、相等值、无效值忽略、`samples` 计数。
  - `estimateTokens`：空串、纯 ASCII、纯中文、中英混排、含 emoji/标点。
  - `formatStatusText` / `formatStatusSegments`：无样本 → `TTFT -- · MIN -- MAX -- AVG -- CUR -- t/s`（前后无 `·`）；分段结果与单行拼接一致；TPS 1 位小数、TTFT 2 位小数；段序 TTFT 在前。
  - `averageTps`：无样本 → null；单/多样本平均值正确；与 `recordSample` 的 `total` 累加一致。
  - `recordLatency` / `formatLatencyText`：首样本、平均值随样本累加、无效值（null/NaN/负数）忽略、无样本占位 `TTFT --`。
- 胶水层（`index.ts`）：`scripts/verify-wiring.mjs` 用 jiti + fake pi/ctx/tui 离线复现事件流，验证 widget 注册（key/placement）、单行左对齐、窄宽度折成两行、流式 CUR 着色、精确校正、样本过滤、节流与清理；**不纳入 `node --test`**（依赖 pi 全局安装路径），也不替代真实 TUI 验收。
- 不测：真实网络流、真实 TUI 布局（这两项用手动验收 + `/reload` 观察）。
- 覆盖率目标：`lib/tps.ts` 分支全覆盖；不引入覆盖率工具。

## Boundaries

### Always（始终做）

- `lib/tps.ts` 保持零 pi 依赖，保证 `node --test` 永远可独立运行。
- 所有事件处理器 try/catch 兜底；任何异常静默降级（保留旧值/不渲染），**绝不打断主 agent**。
- 更新节流：`message_update` 高频触发，`requestRender` 间隔 ≥120ms；`message_end`/`message_start` 强制更新一次。
- widget key 固定 `"pi-tps"`；`session_start` 幂等重建，`session_shutdown` 时 `setWidget(key, undefined)` 清理。
- TTFT 与 TPS 同源于 `isCountable`（输出>0 且非 error/aborted）；TPS **额外**要求窗口 ≥500ms 且输出 ≥20 tokens（过滤窗口塌缩伪影），TTFT 不受该门槛限制。
- 提交前 `node --test` 全绿。

### Ask first（先问再做）

- 修改 `~/.pi/agent/settings.json`（本次已获批准：追加 `"pi-tps"` 到 `packages`）。
- 新增任何运行时依赖或 devDependency（如为类型检查引入 `@earendil-works/pi-coding-agent`）。
- 改变显示口径/位置/格式，或把统计改为跨 session 持久化。
- 新增命令（如 `/tps-reset`）、配置文件或环境变量开关。

### Never（绝不）

- 不读取、不显示、不记录任何敏感信息（API key、token、账户数据）。
- 不修改 pi 核心文件或其它扩展；不深链 pi 内部非导出模块（只用公开 API）。
- 不把统计写入磁盘（v1），不发起任何网络请求。
- 不阻塞、不拖慢 agent（无同步重活、无重试风暴、无未节流渲染）。
- 状态文本最多两行（放不下才折行），不塞入超长内容挤压 viewport。

## Success Criteria

- [x] `node --test` 全绿（`lib/tps.ts` 纯逻辑分支覆盖）
- [x] 离线接线验证 `scripts/verify-wiring.mjs`（widget 注册/placement、单行左对齐 + dim 着色、窄宽度折两行、极窄截断、流式 CUR accent、校正、过滤、节流、清理、非 TUI 兜底）
- [x] 着色与内置 footer 一致：整行 `theme.fg("dim", …)`；仅流式中的 CUR 为 accent
- [x] 流式期间 CUR 实时滚动、结束后用精确 `usage.output` 校正（离线验证）
- [x] MIN/MAX/AVG 只在响应结束后更新；已提交样本满足 `MIN ≤ AVG ≤ MAX`
- [x] AVG = 本 session 有效样本算术平均，位置在 MAX 与 CUR 之间
- [x] 首字延迟：显示 `TTFT <最近一次>s avg <平均>s`，无样本时 `TTFT --`；口径 = 请求发出 → 首个内容 delta
- [x] TTFT 与 TPS 同源于 `isCountable` 响应；TPS 额外要求 ≥20 tokens 且窗口 ≥500ms
- [x] 样本门槛：窗口 <500ms 或输出 <20 tokens 的响应不计入 MIN/MAX/AVG；流式中未达门槛时 CUR 显示 `--`
- [x] 无样本时显示 `TTFT -- · MIN -- MAX -- AVG -- CUR -- t/s` 占位（前后无 `·`）
- [x] 非 TUI 模式零副作用；零新增依赖
- [x] `pi list` 与 pi 包管理器确认 `"pi-tps"` → `pi-tps/index.ts` 已作为启用扩展解析
- [ ] **待用户目视验收**：真实 TUI 中 editor 与 footer 之间出现左对齐的 `TTFT … · MIN … MAX … AVG … CUR … t/s`（前后无 `·`，着色与内置 footer 一致）；窗口收窄时自动折成两行且不消失；真实对话中数值滚动与收敛；`/reload` 后不重复不残留

## Open Questions

1. **模型切换是否重置统计？** v1 默认**不重置**（同一 session 内跨模型样本混合）。若希望切换模型即清零，改为在 `model_select` 事件里 reset。
2. **是否需要 `/tps-reset` 手动清零？** v1 不做（用户选择的是「仅当前 session 内存」而非带命令的选项）。若日常想重测，再加。
3. **`MIN`/`MAX` 是否包含 reasoning/thinking tokens？** 当前口径：包含（`usage.output` 本身含 thinking，且生成速度按实际生成 token 计）。若想只看可见文本速度，需要改用 `output - reasoning` 重算。

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1 | 2026-09-09 | 初版：`setWidget` 独立行（`placement: "belowEditor"`），右对齐 |
| v1.1 | 2026-09-09 | 用户决定改为 `setStatus` 状态行，并采用 `pi-llm-provider-balance` 的分隔风格 `· … ·`；移除 `@earendil-works/pi-tui` 依赖与右对齐逻辑 |
| v1.2 | 2026-09-09 | 新增首字延迟 TTFT（口径：请求发出→首个内容 delta；显示最近一次 + 平均，秒 2 位小数；等待期不实时计时） |
| v1.3 | 2026-09-09 | TPS 段新增 `AVG`（本 session 有效样本算术平均），位置在 `MAX` 与 `CUR` 之间 |
| v1.4 | 2026-09-09 | TTFT 段整体前移到 `MIN` 之前：`· TTFT … · MIN … MAX … AVG … CUR … t/s ·` |
| v1.5 | 2026-09-09 | 新增样本有效性门槛（窗口 <500ms 或输出 <20 tokens 丢弃）：修复无思考的纯工具调用响应整块到齐导致的 `MAX 1308.3` 伪影；流式中未达门槛时 `CUR` 显示 `--` |
| v1.6 | 2026-09-09 | 显示载体从 `setStatus` 改回 `setWidget`（`belowEditor`）：footer 把各扩展状态拼成一行并按宽度截尾，窄窗口必被截掉且无法折行；widget 独占行，`render(width)` 自适应——单行左对齐，放不下折成两行 |
| v1.7 | 2026-09-09 | 着色对齐内置 footer：整行改用 `theme.fg("dim", …)`（默认前景色更亮，视觉上像字号更大），仅流式中的 CUR 保留 accent 高亮 |
| v1.8 | 2026-09-09 | widget 独占行后去掉首尾 `·`：`· TTFT … · MIN … ·` → `TTFT … · MIN …`（`·` 仅作两组指标的内部隔符） |
