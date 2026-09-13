# Spec Index: pi-tps

本目录（`~/.pi/agent/pi-tps/`）承载 pi-tps 插件的全部规格、计划与任务产物。
`SPEC.md` 仅作索引，不承载业务规格；具体规格在下列子文件中。

| 文件 | 一句话说明 |
|---|---|
| `SPEC-pi-tps.md` | pi-tps 模块规格：在 pi TUI 的 editor 与 footer 之间实时显示 LLM 生成速度 MIN/MAX/CUR（tokens/s） |
| `plan.md` | 实施计划：模块拆分、构建顺序、风险与验证检查点 |
| `todo.md` | 任务清单：可独立完成、带验收与验证步骤的原子任务 |

## Phase 0 范围判定

**单能力，不做 capability map。** 理由：本需求只有一条端到端可验收的能力——「在状态区显示当前会话的 TPS 统计」；
统计与显示无法独立交付（显示无数据即无意义，统计无显示无用户价值），故按单模块 `pi-tps` 处理。
模块内部按「纯逻辑 `lib/` + 扩展胶水 `index.ts`」分层，这是**内部分层**，不是模块依赖图。

依赖方向（单向，无环）：`index.ts` → `lib/tps.ts`（lib 不 import 任何 pi 包，保证 `node --test` 可独立运行）。

## 历史文件

无。本目录为新建，未覆盖、未改写任何既有规格文件；`~/.pi/agent/docs/spec/SPEC.md`（derouter-balance 规格）保持原样未动。
