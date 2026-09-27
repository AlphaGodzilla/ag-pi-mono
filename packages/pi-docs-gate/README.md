# pi-docs-gate

一个 [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) 扩展:把内置系统提示词里硬编码的 **Pi documentation 段落**(约 600 tokens)换成**一行按需指针** —— 任何工作目录下都只留「需要 pi 自身文档就读 pi-docs skill」这一句,不再常驻整段路径与查阅规则。结构化段与线上提示词文本**两条路径同时生效**(原因见「注意事项」)。配套的 `pi-docs` skill 承载完整的文档访问指引。

## 背景

pi 内置默认系统提示词(`dist/core/system-prompt.js` 的 `buildSystemPrompt()`)硬编码了一段约 600 tokens 的 "Pi documentation" 指引(README / docs / examples 路径及按主题查阅文档的规则),对所有工作目录**无差别注入**。正常编码时这段内容完全用不到,白白占用上下文窗口。

## 工作原理

```
系统提示词构建
    │
    ▼
before_agent_start hook
    │
    └─ 任意 cwd ─→ docs 段 = 一行按需指针("如需 pi 自身文档…请读取 pi-docs skill")
                  原段 ~600 tokens 内容不再进入上下文
    │
两条路径: sections.docs(transcript/段机制) + 提示词文本替换(线上请求实际生效)
```

- **替换而非删除**:按**段结构**替换——pi 把每个 section 包成同名标签(这里是 `<docs>…</docs>`),本扩展整段换掉,不匹配段落里的任何句子,因此 pi 改写段落文案不影响生效(插件里不复制 pi 的文案)。pi 只支持覆盖同名段、不支持删除,所以线上保留 `<docs>` 标签本体,内容换成指针那句。
- **不按 cwd 分支**:任何工作目录都换成同一份按需指针。pi 文档是「需要时才读」的能力,常驻整段只在真的查阅 pi 自身时才划算;换成指针后需要时模型按 skill 的 location 去读 `pi-docs`(该 skill 通常就在 skills 列表里)。`SYSTEM.md`(customPrompt 模式)下 pi 本就不写 docs 段,本扩展也不注入,免得往用户自定义提示词里塞内容。
- **配置目录解析(用于日志落盘)**:调 `getAgentDir()`(pi 公开导出),不自己拼环境变量 —— 因此 `PI_CODING_AGENT_DIR` 指向**任意目录**都成立,`~/xxx` 这类写法会被 pi 正确展开,相对路径会绝对化;每次调用实时解析(不是启动快照),比较前还做一次规范化(绝对化 + 存在时取 realpath,避免 `/tmp` 与 `/private/tmp` 判成两个目录)。
- **两条路径都要做**(实测于 pi 0.87.1):只覆盖 `sections.docs` 时,transcript 里是指针段,但**只要有任何扩展返回 `systemPrompt`(本机 `@gotgenes/pi-permission-system` 每轮都返回),线上 payload 里就还是内置的 ~600 tokens 段落**;所以同时在其结果文本上做一次幂等替换,并 `return { systemPrompt }`。文本起点取 `forceSystemPrompt ?? event.systemPrompt`(链式叠加,不丢别人的工具面/权限过滤),因此本包必须排在会返回 `systemPrompt` 的扩展之后加载。
- **skill 兜底**:包内 `skills/pi-docs/SKILL.md`(由 package manifest 注册)承载完整的文档指引(启发式路径定位 + 按主题查阅规则),利用 skill 的 progressive disclosure 机制——全文仅在需要时通过 `read` 加载;其 description 默认常驻提示词,若启用 `pi-skills-gate` 则连这段描述也不再常驻,改为按 `<location>` 读取。

## 路径策略:启发式自发现(零渲染、零写盘)

skill 的"文档位置"一节**不写死任何主机路径**,也不做任何运行时改写/注入——它只给出一组启发式步骤,让 agent 在每次需要时**自行定位**:

1. 运行 `npm root -g` 得到全局 node_modules 目录;
2. 拼接 `@earendil-works/pi-coding-agent` 并用 `ls` 验证 `package.json`、`README.md`、`docs/`、`examples/` 存在;
3. 以该包根为基准解析文档(`<包根>/README.md`、`<包根>/docs`、`<包根>/examples`);
4. 兜底:由 `which node` 推导或 `require.resolve(...)` 定位。

因此 skill 内容与主机无关:仓库内一份静态文件,任意机器直接可用;agent 每次使用时按当前主机现场发现路径。

## 文件

| 文件 | 作用 |
| --- | --- |
| `extensions/index.ts` | 扩展主逻辑:两条路径覆盖 docs 段(导出纯函数 `applyDocsGate()`) |
| `test/docs-gate.test.ts` | 纯函数单测(指针替换/与 cwd 无关/幂等/customPrompt 模式/配置目录解析/漂移判据) |
| `test/builtin-prompt.test.ts` | **与 pi 真实源码的兼容性测试**:调用 pi 包里的 `buildSystemPrompt()`,断言 docs 段被换掉且其余内容逐行不变 |
| `skills/pi-docs/SKILL.md` | 配套 skill,承载完整文档指引(启发式路径定位 + 查阅规则) |
| `compare-system-prompt.mjs` | 开发工具:对比扩展开启前后的系统提示词,产物输出到本目录 |
| `package.json` | 标准 pi package manifest(`pi.extensions` + `pi.skills` 声明) |
| `README.md` | 本说明 |

## 安装 / 生效

本目录是**标准 pi package**(`package.json` 含 `pi` manifest 与 `pi-package` keyword,声明 `extensions` 与 `skills` 资源),不放在 `extensions/`,通过 `settings.json` 注册目录即可按 package 规则加载:

1. 本包位于 `~/.pi/agent/ag-pi-mono/packages/pi-docs-gate`。
2. 在 `~/.pi/agent/settings.json` 的 `packages` 数组中声明:

   ```json
   "packages": [
     ...
     "ag-pi-mono/packages/pi-docs-gate"
   ]
   ```

3. 重启 pi(或新开会话)后生效。
也可按标准流程分发:`pi install git:github.com/AlphaGodzilla/ag-pi-mono`(npm/git 安装会自动读取 manifest 加载扩展与 skill)。

## 行为对照

| 场景 | 系统提示词中的表现 |
| --- | --- |
| 任意工作目录(普通项目 / pi 配置目录都一样) | 内置 ~600 tokens 段落消失,该段只剩一句按需指针「如需 pi 自身文档…请读取 pi-docs skill」(约 40 tokens) |
| 模型在任意目录被问到 pi 自身功能 | 按指针去读 `pi-docs` skill(其 location 来自 skills 列表),再按需读 pi 的 README / docs |
| `SYSTEM.md`(customPrompt 模式) | pi 本就不写 docs 段,本扩展不动它 |

## 配置

| 常量 | 位置 | 说明 |
| --- | --- | --- |
| `agentDir()` | `extensions/index.ts` | pi 配置目录的解析入口: 调 `getAgentDir()` + 规范化(绝对化/realpath), 支持任意 `PI_CODING_AGENT_DIR`(含 `~`、相对路径), 实时解析 |
| `docsHint()` | `extensions/index.ts` | 替换内置 docs 段的按需指针文本(我们自己的措辞;之前版本里的 `(none)` 占位已取消) |
| `DOCS_SECTION_TAG` | `extensions/index.ts` 顶部 | docs 段的标签名(`docs`)。两条路径都按它做结构定位;pi 若改段名或删掉该段,由漂移告警 + 兼容性测试兜住 |

## 卸载

从 `~/.pi/agent/settings.json` 的 `packages` 移除 `"ag-pi-mono/packages/pi-docs-gate"`(或删除该包目录)即可恢复内置段落;包内 `pi-docs` skill 随包一并卸载(静态文件,无任何残留状态)。

## 注意事项

- **两条路径的取舍**:`sections.docs` 负责 transcript 记录,文本替换 + `return { systemPrompt }` 负责线上请求。任何扩展只要返回 `systemPrompt`(本机 `@gotgenes/pi-permission-system` 每轮都返回),sections 的修改就不会出现在发往 provider 的请求里,所以本包必须排在这些扩展**之后**加载(`settings.json` 的 `packages` 顺序 = 加载顺序)。
- **不比对任何文案**:插件里没有 pi 的段落原文,只按 `<docs>` 段结构整体替换,所以 pi 改写字句不影响生效;唯一的结构假设是 section 名 `docs`。
- **漂移检测与兼容性测试**:运行时若在非 customPrompt 模式下找不到 `<docs>` 段,视为 pi 结构变了 → TUI 弹告警并写 **pi 配置目录**下的 `extensions/pi-docs-gate/error.log`(目录由 pi 的 `getAgentDir()` 解析,支持任意 `PI_CODING_AGENT_DIR`;每进程一次);开发期则由 `test/builtin-prompt.test.ts` 直接跑 pi 包里的 `buildSystemPrompt()`,pi 一改结构 `pnpm test` 就变红。
- 使用 `SYSTEM.md`(customPrompt 模式)时内置段落本就不存在,扩展自动跳过,无副作用。
- 根目录 `before/after-system-prompt*.md` 是本机系统提示词快照(开发产物,含本机信息属预期),不参与运行链路;需要时重新运行 `compare-system-prompt.mjs` 生成。
- 若 `~/.agents/skills/pi-docs/SKILL.md` 存在旧副本,保持与包内一致的静态内容即可;扩展本身不读写任何 skill 文件。
