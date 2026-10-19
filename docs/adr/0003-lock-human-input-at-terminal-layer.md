---
status: accepted
date: 2026-10-19
decision-makers: [用户]
consulted: []
informed: []
---

# loop 期间在终端输入层锁定人类输入，退出键 ctrl+shift+l

## Context and Problem Statement

用户要求「主 agent 开启 loop 后禁用 input 框人类输入」，退出用快捷键，并在页面上提示该快捷键。pi 的交互模式把输入交给屏幕底部的编辑器组件，扩展能触及的只有三处：`ui.setEditorComponent`（整体替换编辑器）、`ui.onTerminalInput`（按键到达焦点组件之前的原始输入）、`input` 事件（提交之后、送进模型之前）。

选择哪一层决定两件事：锁定的彻底程度，以及 Esc 中断、Ctrl+C/Ctrl+D、Ctrl+O 等应用级按键是否还能用。

## Decision Drivers

* 彻底：打字、粘贴、Enter 都不能变成模型输入。
* 不破坏逃生通道：用户必须仍能 Esc 中断回合、Ctrl+C 清空、Ctrl+D 退出 pi。
* 可见：面板常驻显示退出键，不依赖用户记住文档。
* 不替换编辑器组件：替换会丢掉 pi 的原生键位与应用动作（模型切换、工具输出展开等）。

## Considered Options

* 方案 A：`ui.onTerminalInput` 前置过滤 + `input` 事件兜底，配合 `ui.setWidget` 面板与 `registerShortcut` 退出键。
* 方案 B：用 `ui.setEditorComponent` 换成只读编辑器（自己渲染锁定提示）。
* 方案 C：只拦 `input` 事件（提交后丢弃）。

## Decision Outcome

选择「方案 A」，因为它不替换编辑器、不丢原生键位，同时能精确区分「人类文本」与「应用级按键」：`isTextualInput()` 只吞可打印字符、粘贴块与 Enter，其余控制序列透传。`input` 事件再返回 `{ action: "handled" }` 作为非 TUI 模式（RPC）的兜底。

退出键选 `ctrl+shift+l`（L 表 loop），同时注册为 pi 快捷键并在终端层拦截。传统终端无法区分 ctrl+shift+L 与 ctrl+L（同为 `0x0c`），因此循环期间 ctrl+L 也会退出 loop；`exitKeys` 可配置成 `ctrl+x` 等无歧义键位以规避。

### Consequences

* Good, because Esc / Ctrl+C / Ctrl+D / Ctrl+O / 鼠标滚动全部保持原生语义，锁输入不等于锁终端。
* Good, because 面板与 footer 状态由同一次状态变化驱动，退出键提示始终与当前配置一致。
* Bad, because 只吞「文本」需要维护一份按键分类（`isTextualInput`），Kitty CSI-u 与 modifyOtherKeys 两种编码都要覆盖，误判会把整段输入放行或吞掉应用键。
* Bad, because ctrl+shift+字母在传统终端上与 ctrl+字母同码，循环期间 ctrl+L 的模型选择会变成「退出 loop」。
* Bad, because 终端层只在 TUI 模式存在；RPC 模式只有提交后丢弃，用户仍可在编辑器里打字（只是发不出去）。

### Confirmation

* `packages/pi-loop/test/input-lock.test.ts` 覆盖文本、粘贴、Enter、Esc、Ctrl+C、Ctrl+D、方向键、鼠标、Kitty/modifyOtherKeys 的判定，以及退出键的两种编码。
* `packages/pi-loop/test/extension.test.ts` 验证启动后终端监听返回 `{ consume: true }`（文本）、`undefined`（Esc/Ctrl+C/Ctrl+D），按下退出键后面板与监听都被清理。
* 手工验收：`/loop 5s <task>` 后尝试打字与粘贴（无输入进入模型）、按 Esc（中断当前回合）、按 ctrl+shift+l（面板消失、输入恢复）。

## Pros and Cons of the Options

### 方案 A：终端输入层过滤 + input 事件兜底

* Good, because 不替换编辑器，pi 的原生键位与应用动作完整保留。
* Bad, because 依赖 pi-tui 的原始按键编码格式，pi 若改变编码需要同步更新判定。

### 方案 B：替换为只读编辑器

* Good, because 视觉上能画出一块明确的「已锁定」区域，用户不可能误以为能输入。
* Bad, because 替换组件后必须自己转发 Esc、Ctrl+C、Ctrl+D 与扩展快捷键，任何遗漏都会让用户卡死在 loop 里。

### 方案 C：只拦 input 事件

* Good, because 实现最小，不关心终端编码。
* Bad, because 用户仍能在编辑器里正常打字、看到自己的文字被静默丢弃，属于最差的交互反馈。

## More Information

* 判定逻辑与编码说明：`packages/pi-loop/src/input-lock.ts`。
* 面板渲染与提示文案：`packages/pi-loop/src/ui.ts` 的 `renderLoopPanel()`。
* 复查触发点：pi 若提供官方的「编辑器只读」或「输入锁定」API，应改用它并在本 ADR 中记录取代关系。
