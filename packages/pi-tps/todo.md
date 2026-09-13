# Tasks: pi-tps v1

对应规格：`SPEC-pi-tps.md` ｜ 计划：`plan.md` ｜ 状态：v1.8 已实施（T1-T3 完成，T4 待目视验收）

> 任务按依赖排序，每个任务单次会话内可完成、改动文件 ≤5 个、带独立验收与验证命令。

---

- [x] **T1 纯逻辑 `lib/tps.ts` + 单元测试**（已完成：`node --test` 23/23）
  - Acceptance：
    - `computeTps(tokens, durationMs)`：正常返回 `tokens/(durationMs/1000)`；`tokens<=0`、`durationMs<=0`、`NaN`、`Infinity` 返回 `null`。
    - `createStats()` 返回 `{ min: null, max: null, current: null, samples: 0 }`。
    - `recordSample(stats, tps)`：首个有效样本同时设置 min/max/current；后续只更新对应极值与 current；`samples` 递增；`null`/非有限值原样返回 stats。
    - `estimateTokens(text)`：空串→0；纯 ASCII 按 `ceil(len/4)`；CJK 字符按 0.75/字并向上取整；中英混排为两者相加后取整。
    - `formatStatusText(stats, latency)`：全 `null` → `TTFT -- · MIN -- MAX -- AVG -- CUR -- t/s`（前后无 `·`）；TPS 1 位小数、TTFT 2 位小数。
    - 文件零 import（除类型），不依赖任何 pi 包。
  - Verify：`cd pi-tps && node --test` 全绿（≥15 个断言）。
  - Files：`lib/tps.ts`、`test/tps.test.ts`

- [x] **T2 扩展胶水 `index.ts`**（已完成：离线接线验证 13/13；v1.6 起改用 widget + 自适应折行）
  - Acceptance：
    - `session_start`：`ctx.mode !== "tui"` 直接返回；否则保存 ctx 并 `setWidget("pi-tps", factory, { placement: "belowEditor" })`。
    - `render(width)`：放得下 → 左对齐单行 `TTFT … · MIN … MAX … AVG … CUR … t/s`；放不下 → 折两行（TTFT / TPS，均左对齐），单段超宽硬截断。
    - 仅流式中的 CUR 用 accent 色，其余继承默认色。
    - `message_start`(assistant)：重置本轮流式状态（首 delta 时间、pendingTtftMs、liveTps），记录 `requestAt = message.timestamp`（非有限值回退 `Date.now()`），强制刷新一次。
    - `message_update`(assistant)：首个流式更新时记录 `firstDeltaAt` 与 `pendingTtftMs = now - requestAt`，并**立即**刷新一次（不受节流限制）；`usage.output > 0` 时用精确值，否则 `estimateTokensFromContent` 估算；计算实时 CUR；其余更新节流（≥120ms）。
    - `message_end`(assistant)：TPS 样本需 `isCountable` 且 `usage.output ≥ 20` 且窗口 ≥ 500ms 才 `recordSample`；TTFT 只要 `isCountable` 就提交（不受门槛限制）。
    - `session_shutdown`：`ctx.ui.setWidget("pi-tps", undefined)` 清理。
    - 每个处理器 try/catch 兜底，异常不冒泡。
  - Verify：`node scripts/verify-wiring.mjs` 13/13；真实 pi 中 editor 与 footer 之间出现左对齐的 `TTFT … · MIN … MAX … AVG … CUR … t/s`，窗口变窄时折两行。
  - Files：`index.ts`、`scripts/verify-wiring.mjs`

- [x] **T3 接入 pi（package.json + settings.json）**（已完成：`pi list` 解析通过）
  - Acceptance：
    - `package.json` 含 `{ "type": "module", "main": "index.ts", "pi": { "extensions": ["./index.ts"] } }`。
    - `~/.pi/agent/settings.json` 的 `packages` 数组追加 `"pi-tps"`（不删改其它条目）。
    - 正常启动 pi 即自动加载；`/reload` 后仍只有一行、无重复。
  - Verify：启动 pi → 出现 TPS 行；`/reload` → 行数不变；`grep -n '"pi-tps"' settings.json` 命中一次。
  - Files：`package.json`、`~/.pi/agent/settings.json`

- [ ] **T4 手动验收与文档**（README 已完成；真实 TUI 目视验收待用户执行）
  - Acceptance：
    - 真实对话（含中文与工具调用）中：流式期间 CUR 变化；结束后 CUR 校正；MIN/MAX 合理收敛；`MIN ≤ CUR ≤ MAX` 恒成立。
    - 无样本时占位；异常响应（如中断）不污染 MIN/MAX、不崩溃。
    - `-p "hi"` 非 TUI 模式下无报错、无副作用。
    - `README.md` 说明安装/加载/热重载/调参常量/已知限制。
  - Verify：`node --test` 仍全绿；`pi -p "hi"` 退出码 0；目视验收勾选 `SPEC-pi-tps.md` 的 Success Criteria。
  - Files：`README.md`、`SPEC-pi-tps.md`（勾选成功标准）

- [x] **T5（v1.1 变更）显示方式 setWidget → setStatus**
  - Acceptance：状态写入 footer 状态行（模型名下方），文本前后各带 `·` 分隔；移除 `@earendil-works/pi-tui` 依赖与右对齐逻辑；单测与接线验证同步更新。
  - Verify：`node --test` 23/23；`node scripts/verify-wiring.mjs` 9/9。
  - Files：`index.ts`、`lib/tps.ts`、`test/tps.test.ts`、`scripts/verify-wiring.mjs`、`SPEC-pi-tps.md`、`README.md`、`plan.md`

- [x] **T6（v1.2 新增）首字延迟 TTFT**
  - Acceptance：口径 = 请求发出（`message.timestamp`）→ 首个内容 delta；显示最近一次 + 本 session 平均（秒，2 位小数）；首个样本提交前无 `avg` 段；等待期沿用旧值不实时计时；样本与 TPS 同源（`isCountable`）。
  - Verify：`node --test` 34/34；`node scripts/verify-wiring.mjs` 10/10（含 `TTFT 0.10s` 首字即时可见、`TTFT 0.50s avg 0.30s` 平均累加）。
  - Files：`lib/tps.ts`、`test/tps.test.ts`、`index.ts`、`scripts/verify-wiring.mjs`、`SPEC-pi-tps.md`、`README.md`、`plan.md`

- [x] **T7（v1.3 新增）TPS 段增加 AVG**
  - Acceptance：`TpsStats` 增加 `total` 累加；新增 `averageTps()`；显示位置在 `MAX` 与 `CUR` 之间；无样本时 `AVG --`；AVG 只统计已提交有效样本（不含流式中的实时 CUR）。
  - Verify：`node --test` 37/37；`node scripts/verify-wiring.mjs` 10/10（`AVG 50.0` → `AVG 125.0` 随样本累加）。
  - Files：`lib/tps.ts`、`test/tps.test.ts`、`scripts/verify-wiring.mjs`、`SPEC-pi-tps.md`、`README.md`、`plan.md`

- [x] **T8（v1.4 变更）TTFT 段前移到 MIN 之前**
  - Acceptance：状态文本段序为 `· TTFT … · MIN … MAX … AVG … CUR … t/s ·`；`lib/tps.ts` 的 `formatStatusText` 与 `index.ts` 的 `renderStatus` 同步（后者自行拼串以给 CUR 着色）。
  - Verify：`node --test` 37/37；`node scripts/verify-wiring.mjs` 10/10（占位串与各轮状态串段序均前移）。
  - Files：`lib/tps.ts`、`index.ts`、`test/tps.test.ts`、`scripts/verify-wiring.mjs`、`SPEC-pi-tps.md`、`README.md`、`plan.md`

- [x] **T9（v1.5 修复）样本有效性门槛，消除 MAX 1308.3 伪影**
  - 根因：无思考的纯工具调用响应整块一次到齐，首字→结束窗口仅几十 ms（49 tok ÷ 1308.3 = 37.5ms），而端到端实测仅 18–65 t/s。
  - Acceptance：`computeTps` 对 `tokens < 20` 或窗口 `< 500ms` 返回 `null`（常量 `MIN_SAMPLE_TOKENS` / `MIN_SAMPLE_WINDOW_MS`）；TPS 样本被丢弃但 TTFT 仍记录；流式中未达门槛 `CUR` 显示 `--`（空闲回退最近样本）。
  - Verify：`node --test` 39/39（含门槛边界与 `49 tok / 37ms` 回归）；`node scripts/verify-wiring.mjs` 11/11（含伪影回归用例）。
  - Files：`lib/tps.ts`、`index.ts`、`test/tps.test.ts`、`scripts/verify-wiring.mjs`、`SPEC-pi-tps.md`、`README.md`、`plan.md`

- [x] **T10（v1.6 修复）窄窗口文本被隐藏 → 改回 widget 并自适应折行**
  - 根因：`setStatus` 的文本由 footer 拼成一行并按终端宽度 `truncateToWidth` 截尾，且 `sanitizeStatusText` 把换行替换成空格——窄窗口必然被截掉、无法折行。
  - Acceptance：改用 `setWidget(belowEditor)` 独占行；`render(width)` 放得下左对齐单行、放不下折两行（TTFT / TPS）；单段超宽硬截断；CUR 流式仍为 accent 色。
  - Verify：`node --test` 43/43（新增 `formatStatusSegments` 4 例）；`node scripts/verify-wiring.mjs` 13/13（宽屏单行/窄屏两行/极窄截断）。
  - Files：`index.ts`、`lib/tps.ts`、`test/tps.test.ts`、`scripts/verify-wiring.mjs`、`SPEC-pi-tps.md`、`README.md`、`plan.md`

- [x] **T11（v1.7 修复）widget 文本比内置 footer 更亮/更大 → 对齐 dim 着色**
  - 根因：内置 footer 的 pwd/统计行全部套 `theme.fg("dim", …)`（`footer.js:204/206/207`），而 widget 用终端默认前景色，更亮故视觉上显得字号更大。
  - Acceptance：widget 整行改用 `theme.fg("dim", …)`；仅流式中的 CUR 保留 accent 高亮，空闲回 dim。
  - Verify：`node --test` 43/43；`node scripts/verify-wiring.mjs` 13/13（新增 dim 着色断言）。
  - Files：`index.ts`、`scripts/verify-wiring.mjs`、`SPEC-pi-tps.md`、`README.md`、`plan.md`

- [x] **T12（v1.8 调整）去掉首尾 `·`**
  - 理由：`·` 是 footer 多扩展拼接时的分隔约定；widget 独占一行后首尾不再需要，仅保留 TTFT 与 TPS 之间的一个。
  - Acceptance：`· TTFT … · MIN … ·` → `TTFT … · MIN …`；折行后两行同样无首尾 `·`。
  - Verify：`node --test` 43/43；`node scripts/verify-wiring.mjs` 13/13（期望串同步更新）。
  - Files：`lib/tps.ts`、`index.ts`、`test/tps.test.ts`、`scripts/verify-wiring.mjs`、`SPEC-pi-tps.md`、`README.md`、`plan.md`
