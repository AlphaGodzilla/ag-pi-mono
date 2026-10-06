# pi-lazy-skill

一个 [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) 扩展：把系统提示词里的 **skills 段整段删掉**，改为注册一个 `load_skill` 工具——模型需要时按 skill 名字拿到 skill 文件（通常是 `SKILL.md`）的绝对路径，再用 `read` 工具读取内容。

与 `pi-skills-gate` 的区别：后者只删 `<description>`、保留 `<name>` + `<location>`；本扩展连 `<skills>` 段一起删掉，skill 的常驻成本降到 **0**。

## 背景

pi 启动时扫描 skills 目录，把每个 skill 的 **name + description + 路径**写进系统提示词（`dist/core/skills.js` 的 `formatSkillsForPrompt()`）。这份清单常驻上下文，用来让模型自行判断"该不该加载这个 skill"。

如果工作流是**用户点名叫某个 skill、模型再去读文件**，这份清单（尤其 description 全文，以及 N 个 skill 的绝对路径）就是纯开销——同一份文字已经写在 `SKILL.md` 的 frontmatter 里，模型读到文件时自然能看到。本扩展把它按需化：段删掉，路径改为一次工具调用取回。

## 工作原理

```
before_agent_start
    │
    ├─ 路径 1(段机制/transcript)          ├─ 路径 2(线上请求文本)
    │   options.skills = []               │   stripSkillsSection(forceSystemPrompt ?? event.systemPrompt)
    │   delete options.sections.skills    │   → return { systemPrompt }
    │                                     │
    ▼                                     ▼
  pi 不再生成 <skills> 段              从前一扩展产出的文本里删掉 <skills>…</skills>
```

- **两条路径都做**：`options.skills = []` 走 pi 的结构化段机制（transcript 里记录为「skills 段被移除」）；文本路径保证**发往 provider 的请求**里也没有该段。原因见下节。
- **段机制是官方做法**：pi 只在 `selectedTools` 含 `read`/`bash` 且 `skills.length > 0` 时生成 `promptSections.skills`（`dist/core/system-prompt.js`）。把 `skills` 置空即不再生成；空串覆盖 `sections.skills` 不生效（`if (content)` 会跳过），所以必须清 `skills` 本身。另外顺手 `delete options.sections.skills`，清掉其它扩展可能塞回来的同名段。
- **不复制 pi 的文案**：插件只依赖两样东西——① 结构契约（section 包成同名标签 `<skills>…</skills>`）；② 结构化数据（`systemPromptOptions.skills` 里每个 `Skill` 的 `name` / `filePath` / `disableModelInvocation`）。段内文案一律不解析，路径直接取 `Skill.filePath`，所以 pi 改文案或加字段都不影响。
- **删除只吃一侧空行**：pi 用空行拼接各段，段本身是 `<skills>\n…\n</skills>`。删除时保证相邻两段之间仍恰好留一个分段分隔符，不会把它们粘在一起（幂等）。
- **文本起点取在改写之前**：`event.systemPrompt` 是 getter，会按**改写后的** options 重渲染；若先 `options.skills = []` 再取，就永远拿不到含 skills 段的原文，漂移检测也会失真。因此先快照 `forceSystemPrompt ?? event.systemPrompt`，再改写 options。
- **链式叠加**：文本起点取 `systemPromptOptions.forceSystemPrompt ?? event.systemPrompt`（前一环是别的扩展已产出的提示词，后一环是 pi 的当前渲染），只做增量删除，不会丢掉别人做的工具面 / 权限过滤。
- **漂移检测**：按 pi 自己的前提推断「本应有 skills 段」（有可见 skill 且有 read/bash），若快照里没有 `<skills>`，视为 pi 结构变了 → TUI 弹告警并写 **pi 配置目录**下的 `extensions/pi-lazy-skill/error.log`（目录由 pi 的 `getAgentDir()` 解析，`PI_CODING_AGENT_DIR` 指向任意目录都支持；每进程一次），不会静默失效。
- **与内置前提一致**：标了 `disable-model-invocation: true` 的 skill 不进入 `load_skill` 的名单（与它本就不进提示词一致，仍可用 `/skill:name` 直接调用）。
- **按 session 隔离 + `/reload` 刷新**：skill 名单存在 **factory 闭包**里（`let skills`），不放模块作用域。pi 每个 session 建立 runtime 时都会重新执行一次扩展 factory（`dist/core/resource-loader.js` → `loadExtensionsCached` → `initializeExtension` → `factory(api)`；缓存的是模块/factory 本身，不是闭包），所以每个 session 拿到自己的闭包、自己的 tool 定义与名单，**互不覆盖**。`/reload` 走同一条路（`clearExtensionCache()` → 重新求值 → factory 再执行），新闭包从空开始，下一轮 `before_agent_start` 从重载后的 `systemPromptOptions.skills` 重新写入 —— 新加/删除的 skill 立刻反映到 `load_skill`。

## `load_skill` 工具

| 入参 | 说明 |
| --- | --- |
| `name`（可选） | skill 名字。省略时返回可用名单 |

行为：

- **命中** → 返回 `Skill.filePath` 绝对路径，并明确引导：`Read that file with the read tool to load the skill's instructions, then follow them.`
- **未命中 / 省略 `name`** → 只返回可用 skill 的**名字**列表（不带 description），让模型能重试或自行发现。
- 名字匹配先精确、再大小写不敏感（`Grilling` 也能命中 `grilling`）。
- 工具描述、`promptSnippet`（Available tools 段）与 `promptGuidelines`（Rules 段）三处都引导模型「先 `load_skill` 拿路径，再用 `read` 读文件」，因此模型不需要任何常驻 skills 清单也能正确走完流程。

## 与其它扩展共存（实测于 pi 0.87.1）

`before_agent_start` 有两种改法，优先级并不对等：

| 改法 | 效果 |
| --- | --- |
| 写 `systemPromptOptions.*`（如 `skills = []`） | 结构化段覆盖；进 transcript，但**只要有任何扩展返回 `systemPrompt`，它就不出现在发往 provider 的请求里** |
| 返回 `systemPrompt` / 设 `forceSystemPrompt` | 整条提示词替换成不透明文本，**最后返回的那个生效** |

本机 `@gotgenes/pi-permission-system` 的 `before_agent_start` 每轮都返回 `{ systemPrompt }`（工具面重排 + skill 权限过滤），且它读取的是 `event.systemPrompt`（pi 在 handler 阶段渲染的是**基础选项**，含内置 skills 段）。只清 `options.skills` 的话，结果就是「会话文件里 skills 段已经没了，线上 payload 又变回带 skills 段的内置版本」。

因此本扩展两条路径都做，并且文本路径从 `forceSystemPrompt` 接着删——在其结果上删段，既不丢它的权限过滤，又能让线上提示词真正生效。代价是：**本包必须排在会返回 `systemPrompt` 的扩展之后加载**（`settings.json` 的 `packages` 数组顺序 = 加载顺序；npm 包在前、`ag-pi-mono` 包在后，现状即满足）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.ts` | 扩展主逻辑（闭包内的 registerTool + 两路径 + 漂移告警）与纯函数 `stripSkillsSection()` / `findSkillByName()` / `findSkillsDrift()` |
| `test/lazy-skill.test.ts` | 纯函数单测（删段/幂等/名字解析/工具输出/漂移判据） |
| `test/extension.test.ts` | 接线单测（假 pi API 捕获 `registerTool` / `before_agent_start`，含 per-session 隔离、模拟 `/reload` 刷新、漂移落日志到临时目录） |
| `test/builtin-prompt.test.ts` | **与 pi 真实源码的兼容性测试**：调用 pi 包里的 `buildSystemPrompt()`，断言 skills 段被整段删除、其余段逐字保留（pi 改结构 = 这里变红） |
| `package.json` | 标准 pi package manifest（`pi.extensions` 声明） |
| `README.md` | 本说明 |

无配置文件：启用/停用即 `settings.json` 的 `packages` 增删。

## 安装 / 生效

本目录是**标准 pi package**，不放在 `extensions/` 下，通过 `settings.json` 注册目录加载：

1. 本包位于 `~/.pi/agent/ag-pi-mono/packages/pi-lazy-skill`；
2. 在 `~/.pi/agent/settings.json` 的 `packages` 数组中声明：

   ```json
   "packages": [
     ...
     "ag-pi-mono/packages/pi-lazy-skill"
   ]
   ```

3. 重启 pi（或新开会话）后生效。

也可按标准流程分发：`pi install git:github.com/AlphaGodzilla/ag-pi-mono`。

> 与 `pi-skills-gate` 同时启用没有意义（本扩展删得更彻底，且两者都会改写 skills 段）；建议二选一。

## 行为对照

| 场景 | 结果 |
| --- | --- |
| 本扩展开启 | 会话文件与线上 payload 都没有 `<skills>` 段；skill 名字/描述/路径零常驻 |
| 本扩展关闭 | pi 内置行为：`<skills>` 段列出每个 skill 的 name + description 全文 + 绝对路径 |
| 用户点名某个 skill | 模型调用 `load_skill(name)` 拿到 `SKILL.md` 路径 → 用 `read` 读取 → 按内容执行 |
| 模型不知道有哪些 skill | 调用 `load_skill`（省略 `name`）拿到**只有名字**的名单，再按名字取路径 |

## 卸载

从 `settings.json` 的 `packages` 移除 `"ag-pi-mono/packages/pi-lazy-skill"` 即可恢复内置 skills 段；本包无任何运行状态或配置残留。

## 注意事项

- **模型失去自动路由信息**：段被删后，模型不再有"这个 skill 适用于什么场景"的常驻线索，需要你点名（`/skill:name` 或对话里说明用哪个 skill）。这是本扩展的既定取舍。
- **加载顺序**：本包必须排在会返回 `systemPrompt` 的扩展（如 `@gotgenes/pi-permission-system`）之后，否则对方会用含 skills 段的文本覆盖本包的结果。
- **验证线上提示词**：临时加一个扩展，在 `before_provider_request` 里把 `event.payload` 落盘（`JSON.stringify` 追加写文件），然后 `pi -p "hi" --session-id test --session-dir /tmp/pi-sess` 跑一次，检查 payload 里没有 `<skills>` / `<available_skills>`。只看会话文件不足以说明问题——它记录的是 sections，不一定等于线上 payload。
- **兼容性由测试守住**：`test/builtin-prompt.test.ts` 直接跑 pi 包里的 `buildSystemPrompt()`，断言「skills 段被整段删除」且「其余段逐字保留」。pi 若换段名或元素格式，`pnpm test` 会变红，而不是等线上提示词悄悄变回去。
