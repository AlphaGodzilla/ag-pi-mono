# 架构决策索引

本目录记录 `ag-pi-mono` 的架构选择：插件边界、运行形态、与其它 pi 扩展的契约。这里不是功能设计文档，当前实现与已确认设计分别见各包 README 与代码。

| 编号 | 标题 | 状态 | 日期 |
| --- | --- | --- | --- |
| [0001](./0001-drive-pi-loop-by-iteration-reports.md) | pi-loop 的循环由每轮报告驱动，主 agent 只做调度与汇总 | accepted | 2026-10-19 |
| [0002](./0002-keep-pi-loop-decoupled-from-pi-interactive-subagents.md) | pi-loop 与 pi-interactive-subagents 保持零耦合，只读运行中注册表 | accepted | 2026-10-19 |
| [0003](./0003-lock-human-input-at-terminal-layer.md) | loop 期间在终端输入层锁定人类输入，退出键 ctrl+shift+l | accepted | 2026-10-19 |

[ADR 模板](./adr-template.md) 使用 MADR 4.0.0 中文模板。新增编号递增，已接受的记录只允许状态与日期随取代关系更新，不改写决策正文。
