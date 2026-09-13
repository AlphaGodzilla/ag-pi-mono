# pi-tps

pi 扩展：在 pi TUI 中实时显示 LLM 生成速度（**MIN / MAX / AVG / CUR**，tokens/s）与**首字延迟 TTFT**。

```
/spec 用这个目录帮我写一个插件…
TTFT 0.85s avg 1.10s · MIN 12.4 MAX 48.7 AVG 25.0 CUR 31.2 t/s   ← 本扩展（editor 与 footer 之间，独占行，左对齐）
~/.pi/agent
↑1.4k ↓186 R41k CH98.6% 1.4%/1.0M (auto)  (deepseek) deepseek-v4.1-flash • xhigh
« • DeepSeek: ¥361.87 • yolo
```

窗口变窄时**自动折成两行**（不再被 footer 截掉）：

```
TTFT 0.85s avg 1.10s
MIN 12.4 MAX 48.7 AVG 25.0 CUR 31.2 t/s
```

- 规格：`SPEC-pi-tps.md` ｜ 计划：`plan.md` ｜ 任务：`todo.md` ｜ 索引：`SPEC.md`

## 安装 / 加载

已接入 `~/.pi/agent/settings.json` 的 `packages`：

```json
"packages": [ ..., "pi-tps" ]
```

- 启动 pi 自动加载；修改代码后可在 pi TUI 内 `/reload` 热重载。
- 临时试跑（不改配置）：`pi -e ~/.pi/agent/pi-tps/index.ts`
- 校验包解析：`pi list | grep -A1 pi-tps`

## 口径与语义

| 项 | 定义 |
|---|---|
| **CUR** | 当前值。流式生成中用「已生成 token 估算 ÷ 首个流式更新至今」实时刷新；响应结束后校正为该响应的精确值 |
| **MIN / MAX / AVG** | 本 session 内**已完成响应**的最小 / 最大 / 平均 TPS；只采信精确样本 |
| **AVG 口径** | 每条有效响应的 TPS 各算 1 票，**等权算术平均**（`Σtps / 样本数`），非按 token 加权；不含流式中的实时 CUR |
| **时长口径** | 纯生成速度：**首个流式更新 → 响应结束**，不含 TTFT / 排队时间 |
| **tokens** | `usage.output`（含 reasoning / thinking tokens） |
| **有效样本** | `usage.output ≥ 20` 且生成窗口 ≥ 500ms 且 `stopReason` 不是 `error` / `aborted` |
| **样本门槛（v1.5）** | 窗口 <500ms 或输出 <20 tokens 视为**测量伪影**（无思考的纯工具调用常整块一次到齐，窗口塌缩到几十毫秒 → 虚高到上千 t/s），不计入 MIN/MAX/AVG；流式中未达门槛时 `CUR` 显示 `--` |
| **TTFT** | 首字延迟：**请求发出 → 首个内容 delta**（含网络往返与排队）。显示**最近一次 + 本次会话平均**，单位秒（2 位小数）；等待期不实时计时 |
| **TTFT 样本** | 与 TPS 同源于 `isCountable` 响应；TTFT 不受样本门槛限制（它不含窗口塌缩问题） |
| **统计范围** | 仅当前 session 内存；重启 pi 或 `/reload` 后清零，不落盘 |

流式估算采用 CJK 感知启发式（CJK≈0.75 token/字，其余 chars/4），结束时会用 provider 返回的精确 `usage.output` 校正，因此流式中的 CUR 是近似值、MIN/MAX/AVG 是精确值。无样本时显示 `TTFT -- · MIN -- MAX -- AVG -- CUR -- t/s`。

## 命令

```bash
cd ~/.pi/agent/pi-tps
node --test                  # 纯逻辑单元测试（39 个用例）
node scripts/verify-wiring.mjs   # 离线接线验证（jiti + fake pi，无需启动 pi）
```

## 可调常量

| 常量 | 默认 | 说明 |
|---|---|---|
| `WIDGET_KEY` | `"pi-tps"` | widget 标识（同 key 覆盖式重建），勿改 |
| `UPDATE_THROTTLE_MS` | `120` | 流式期间最小更新间隔（毫秒） |

样本门槛在 `lib/tps.ts`：`MIN_SAMPLE_TOKENS`（20）、`MIN_SAMPLE_WINDOW_MS`（500）；估算权重：`CJK_TOKENS_PER_CHAR`（0.75）、`OTHER_CHARS_PER_TOKEN`（4）。

## 结构

```
pi-tps/
├── index.ts                  # 扩展入口：事件接线、节流更新、status 生命周期
├── lib/tps.ts                # 纯逻辑：TPS/TTFT 统计、样本门槛、token 估算、状态文本格式化
├── test/tps.test.ts          # node:test 单元测试（只测纯逻辑，39 用例）
├── scripts/verify-wiring.mjs # 离线接线验证（开发期，不参与 node --test，11 项）
├── package.json              # pi 包声明
├── README.md                 # 本文档
└── SPEC.md / SPEC-pi-tps.md / plan.md / todo.md   # 规格索引 / 模块规格 / 计划 / 任务
```

## 已知限制

- **仅 TUI**：`-p` / `--json` / rpc 模式下不写入状态（零副作用）。
- **仅当前 session**：不做跨 session 持久化；切换 session 后统计重新开始。
- **模型切换不重置**：同一 session 内跨模型样本会混合统计（如需切换即清零，可在 `model_select` 事件中重置）。
- **流式中 CUR 为估算**：DeepSeek 等 OpenAI 兼容协议流式中不返回 usage，估算与最终精确值可能有偏差（中文偏差已通过 CJK 权重降低）。
- **TTFT 等待期不跳动**：首字到达前沿用上一次的值（首次为 `TTFT --`）；首个样本提交前只显示 `TTFT 0.85s`，提交后追加 `avg`。
- **显示位置**：`ctx.ui.setWidget("pi-tps", …)`，独占一行（editor 与内置 footer 之间），左对齐；窗口不够宽时折成两行（TTFT / TPS）。不接管 pwd、token 统计、模型名与其它扩展状态；因独占一行，文本**前后不再加 `·`**，仅在 TTFT 与 TPS 之间保留一个作分隔。
- **着色**：整行使用 `theme.fg("dim", …)`，与内置 footer 的 pwd/统计行一致（用默认前景色会更亮，看起来像字号更大）；仅**流式中的 CUR** 用 accent 高亮。
- **为何不用 `setStatus`**：footer 会把所有扩展状态拼成**同一行**并按宽度截尾，窄窗口下必然被截掉且无法换行（换行符会被替换成空格）。

## 排障

| 现象 | 排查 |
|---|---|
| 看不到 TPS 行 | `pi list` 确认 `pi-tps` 已解析；`/reload`；确认在 TUI 模式（非 `-p`） |
| 数字一直是 `--` | 还没完成过一轮**达到门槛**的响应（≥20 tokens 且窗口 ≥500ms）；或响应被判定为无效（error / aborted） |
| 流式过程中 CUR 长时间是 `--` | 未达门槛：已估算 tokens <20 或首字至今 <500ms；达标后自动出现 |
| 窗口变窄后文本换成两行 | 预期行为：单行放不下时自动折成两行（TTFT / TPS），不会被隐藏 |
| MAX 高得离谱（如 >500 t/s） | v1.5 前的老样本残留（`/reload` 后清零）；若仍出现请回报：说明你的中转可能把所有响应都整块缓冲 |
| 出现两段 TPS 文本 | 旧版本残留；`/reload` 会用同一 widget key 覆盖，仍异常时重启 pi |
| 流式 CUR 与结束值差异大 | 估算偏差，属预期；MIN/MAX/AVG 与结束后的 CUR 均为精确值 |
