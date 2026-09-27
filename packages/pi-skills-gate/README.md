# pi-skills-gate

一个 [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) 扩展：把内置 **skills 段落**里的 `<description>` 全文去掉，每个 skill 只保留 `<name>` 与 `<location>`。

## 背景

pi 启动时扫描 skills 目录，并把每个 skill 的 **name + description + 路径**写进系统提示词（`dist/core/skills.js` 的 `formatSkillsForPrompt()`）。description 全文常驻上下文，用来让模型自行判断"该不该加载这个 skill"。

如果工作流是**用户点名叫某个 skill、模型再按 `<location>` 读文件**，这份 description 就是纯开销——同一份文字已经写在 `SKILL.md` 的 frontmatter 里，模型读到文件时自然能看到。本扩展把这部分常驻描述去掉，只留定位信息。

## 工作原理

```
before_agent_start
    │
    ▼
┌──────────────────────────────────────┐
│  覆盖内置 skills 段(systemPromptOptions.sections.skills) │
│                                      │
│  <skills>                            │
│    The following skills provide ...  │
│    <available_skills>                │
│      <skill>                         │
│        <name>grilling</name>         │
│        <location>.../SKILL.md</location>   ← 无 description
│      </skill>                        │
│    </available_skills>               │
│  </skills>                           │
└──────────────────────────────────────┘
```

- **两条路径都做**：`sections.skills`（transcript / 段机制）+ 最终提示词文本上的裁剪（`return { systemPrompt }`，线上请求实际生效）。原因见下节。
- **段覆盖是官方机制**：pi 先写内置 `promptSections.skills`，随后应用自定义 sections 并覆盖同名段（`dist/core/system-prompt.js` 的 `buildSystemPromptSections()`），不需要正则改文本；`<skills>…</skills>` 外层仍由 pi 补。
- **不复制 pi 的文案**：插件只依赖两样东西——① 结构契约（section 包成同名标签 `<skills>…</skills>`，skill 列表用 Agent Skills 规范元素 `<skill>/<name>/<description>/<location>`）；② 语义关键词 `description`。pi 的标题行、路径提示行、以后新增的元素/字段**一律原样沿用 pi 自己的渲染**（段内容直接取自 pi 当前渲染的提示词），我们只删元素、只改写「提到 description 的那一行」。
- **文本裁剪幂等**：① 删掉 `<available_skills>` 内每个 `<description>` 元素（含其独占缩进与换行）；② 把重复的路径前缀抽到 `<skill_paths>`（见下）；③ 压掉列表里标签之间的空白（换行 + 缩进 → `></`，XML 里标签间空白不参与语义，纯 token 开销；文本节点内部空白如 `<name> a </name>` 不动）；④ 抬头里提到 description 的那一行换成我们自己的措辞（`When the user names a skill, use the read tool/bash to load that skill's file from its location.`）。
- **路径前缀去重**：`<location>` 的绝对路径按「skill 根目录」（`<skill 目录>/SKILL.md` 往上两级，纯路径推导、不依赖 pi 的 `baseDir`）分组，同组 ≥2 个且**省下的字符数大于声明长度**时才抽出：

  ```xml
  <skill_paths><path id="1">/Users/hty/.pi/agent/skills</path></skill_paths>
  <available_skills><skill><name>grilling</name><location ref="1">/grilling/SKILL.md</location></skill>…
  ```

  相对路径保留前导 `/`，所以「`<path>` 的值 + `ref` 指向的相对路径」直接拼接即原路径（测试里断言了这条不变量）；不划算或没有共享前缀的条目保持绝对路径，单成员前缀不声明。
- **告诉模型怎么拼**：只有真的抽出了 `<skill_paths>` 时，才在抬头那句指引的同一行追加一句英文说明（不增加行数）：`A <location> that carries a ref attribute is relative: prepend the matching <path id> value from <skill_paths> to get the full path.` —— 没抽前缀的安装里不会出现这句。
- **链式叠加**：文本起点取 `systemPromptOptions.forceSystemPrompt ?? event.systemPrompt`（前一环是别的扩展已产出的提示词，后一环是 pi 的当前渲染），因此只做增量裁剪，不会丢掉别人做的工具面 / 权限过滤。
- **漂移检测**：按 pi 自己的前提推断「本应有 skills 段」（有可见 skill 且有 read/bash），若提示词里没有该段 / 段里没有 `<available_skills>` / 仍有 description 元素，就视为 pi 结构变了 → TUI 弹告警并写 **pi 配置目录**下的 `extensions/pi-skills-gate/error.log`（目录由 pi 的 `getAgentDir()` 解析，`PI_CODING_AGENT_DIR` 指向任意目录、写 `~/xxx` 都支持；每进程一次），不会静默失效。
- **与内置前提一致**：没有 `read`/`bash` 工具时不生成该段；标了 `disable-model-invocation: true` 的 skill 不展示（仍可用 `/skill:name` 调用）。
## 与其它扩展共存（实测于 pi 0.87.1）

`before_agent_start` 有两种改法，优先级并不对等：

| 改法 | 效果 |
| --- | --- |
| 写 `systemPromptOptions.sections.*` | 结构化段覆盖；进 transcript，但**只要有任何扩展返回 `systemPrompt`，它就不出现在发往 provider 的请求里** |
| 返回 `systemPrompt` / 设 `forceSystemPrompt` | 整条提示词替换成不透明文本，**最后返回的那个生效** |

本机 `@gotgenes/pi-permission-system` 的 `before_agent_start` 每轮都返回 `{ systemPrompt }`（工具面重排 + skill 权限过滤），且它读取的是 `event.systemPrompt`（pi 在 handler 阶段渲染的是**基础选项**，含内置 description）。只写 sections 的话，结果就是「会话文件里 skills 段已经干净，线上 payload 又变回带 description 的内置版本」。

因此本扩展两条路径都做，并且文本路径从 `forceSystemPrompt` 接着改——在其结果上删 description，既不丢它的权限过滤，又能让线上提示词真正生效。代价是：**本包必须排在会返回 `systemPrompt` 的扩展之后加载**（`settings.json` 的 `packages` 数组顺序 = 加载顺序；npm 包在前、`ag-pi-mono` 包在后，现状即满足）。

顺带一提：`disable-model-invocation: true` 的 skill 不会出现在段里，权限类扩展也就看不到它们；需要用权限控制 skill 可见性时，不要用这个开关。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.ts` | 扩展主逻辑（两路径 + 漂移告警）+ 纯函数 `transformSkillsSection()` / `stripSkillDescriptions()` / `findSkillsSectionDrift()` |
| `test/skills-section.test.ts` | 纯函数单测（元素删除、措辞改写、幂等、段外不受影响、漂移判据） |
| `test/builtin-prompt.test.ts` | **与 pi 真实源码的兼容性测试**：调用 pi 包里的 `buildSystemPrompt()`，断言裁剪仍有效、且除那一行外与 pi 原文逐行一致（pi 改结构 = 这里变红） |
| `package.json` | 标准 pi package manifest（`pi.extensions` 声明） |
| `README.md` | 本说明 |

无配置文件：启用/停用即 `settings.json` 的 `packages` 增删。

## 安装 / 生效

本目录是**标准 pi package**，不放在 `extensions/` 下，通过 `settings.json` 注册目录加载：

1. 本包位于 `~/.pi/agent/ag-pi-mono/packages/pi-skills-gate`；
2. 在 `~/.pi/agent/settings.json` 的 `packages` 数组中声明（顺序无所谓，与 `pi-docs-gate` 无耦合）：

   ```json
   "packages": [
     ...
     "ag-pi-mono/packages/pi-skills-gate"
   ]
   ```

3. 重启 pi（或新开会话）后生效。

也可按标准流程分发：`pi install git:github.com/AlphaGodzilla/ag-pi-mono`。

## 行为对照

| 场景 | 结果 |
| --- | --- |
| 本扩展开启 | 会话文件（transcript）与线上 payload 的 skills 段都无 `<description>`；`<location>` 用 `<skill_paths>` 的 `ref` + 相对路径表示（无共享前缀的保持绝对路径） |
| 本扩展关闭 | pi 内置行为：每行一个 `<skill>`，含 `<description>` 全文与多条完整绝对路径 |
| 用户点名某个 skill | 模型按 `<location>`（必要时拼上 `<skill_paths>` 里的前缀）读 `SKILL.md`，描述随文件一并看到 |

本机实测（`~/.pi/agent`，33 个可见 skill）：系统提示词 32086 字符 → **20055 字符**（约 -37.5%）：`<description>` 33 处 → 0；docs 段 ~600 tokens → `<docs>(none)</docs>`；2 个共享前缀（`~/.pi/agent/skills` 9 个、`~/.agents/skills` 24 个）被抽到 `<skill_paths>`，其余单成员路径保持绝对。

## 卸载

从 `settings.json` 的 `packages` 移除 `"ag-pi-mono/packages/pi-skills-gate"` 即可恢复内置 skills 段；本包无任何运行状态或配置残留。

## 注意事项

- **模型失去自动路由信息**：删掉 description 后，模型不再有"这个 skill 适用于什么场景"的常驻线索，需要你点名（`/skill:name` 或对话里说明用哪个 skill）。这是本扩展的既定取舍。
- **抬头文案**：段内第二条指引按「用户点名 + 按 location 读取」的工作流措辞，与 pi 内置的 "when the task matches its description" 不同（后者在描述被删后已不成立）。要保留原文案就改 `index.ts` 的 `LOCATION_INSTRUCTION_*`，并删掉 `stripSkillDescriptions()` 里的措辞替换。
- **加载顺序**：本包必须排在会返回 `systemPrompt` 的扩展（如 `@gotgenes/pi-permission-system`）之后，否则对方会用含 description 的文本覆盖本包的裁剪结果。
- **权限类扩展**：`@gotgenes/pi-permission-system` 的 skill 过滤是从 `<skill>` 块的 name/description/location 三件套解析的；本包不删 name/location，因此它的过滤依旧有效（顺序正确时）。
- **验证线上提示词**：临时加一个扩展，在 `before_provider_request` 里把 `event.payload` 落盘（`JSON.stringify` 追加写文件），然后 `pi -p "hi" --session-id test --session-dir /tmp/pi-sess` 跑一次，检查 payload 里 `<available_skills>` 块没有 `<description>`。只看会话文件不足以说明问题——它记录的是 sections，不一定等于线上 payload。
- **兼容性由测试守住**：`test/builtin-prompt.test.ts` 直接跑 pi 包里的 `buildSystemPrompt()`，断言「description 被裁掉」且「除提到 description 的那一行外与 pi 原文逐行一致」。pi 若换元素格式或段名，`pnpm test` 会变红，而不是等线上提示词悄悄变回去。
- **想彻底不要整个 skills 段**：置空 `systemPromptOptions.skills`，而不是设 `sections.skills = ""`——构建时 `if (content)` 会跳过空串，空串覆盖不生效。
