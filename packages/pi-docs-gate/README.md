# pi-docs-gate

一个 [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) 扩展:把内置系统提示词中硬编码的 **Pi documentation 段落**按需化——正常编码时移除,仅在 `~/.pi/agent` 目录下工作时提示加载。配套的 `pi-docs` skill 承载完整的文档访问指引。

## 背景

pi 内置默认系统提示词(`dist/core/system-prompt.js` 的 `buildSystemPrompt()`)硬编码了一段约 600 tokens 的 "Pi documentation" 指引(README / docs / examples 路径及按主题查阅文档的规则),对所有工作目录**无差别注入**。正常编码时这段内容完全用不到,白白占用上下文窗口。

## 工作原理

```
系统提示词构建
    │
    ▼
┌─────────────────────────────┐
│  before_agent_start hook    │
│                             │
│  1. 正则移除内置段落:        │
│     /\n\nPi documentation   │
│      \(read only[\s\S]*?    │
│      TUI API details\)/     │
│     (幂等, 不存在则不匹配)   │
│                             │
│  2. cwd == ~/.pi/agent 时   │
│     追加轻量提示, 引导       │
│     读取 pi-docs skill      │
└─────────────────────────────┘
```

- **移除段落**:系统提示词中的 "Pi documentation ... TUI API details)" 整段(含前导空行)被删除,删除操作幂等,可安全重复执行。
- **按需提示**:仅当当前工作目录为 `~/.pi/agent`(或其子目录)时,追加一行轻量提示,引导模型按需读取 `pi-docs` skill。
- **skill 兜底**:包内 `skills/pi-docs/SKILL.md`(由 package manifest 注册)承载完整的文档指引(启发式路径定位 + 按主题查阅规则),利用 skill 的 progressive disclosure 机制——描述常驻系统提示词(约 200 tokens),全文仅在需要时通过 `read` 加载。

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
| `extensions/index.ts` | 扩展主逻辑(`before_agent_start`: 移除内置段落 + pi 配置目录下追加引导) |
| `skills/pi-docs/SKILL.md` | 配套 skill,承载完整文档指引(启发式路径定位 + 查阅规则) |
| `compare-system-prompt.mjs` | 开发工具:对比扩展开启前后的系统提示词,产物输出到本目录 |
| `package.json` | 标准 pi package manifest(`pi.extensions` + `pi.skills` 声明) |
| `README.md` | 本说明 |

## 安装 / 生效

本目录是**标准 pi package**(`package.json` 含 `pi` manifest 与 `pi-package` keyword,声明 `extensions` 与 `skills` 资源),不放在 `extensions/`,通过 `settings.json` 注册目录即可按 package 规则加载:

1. 项目位于 `~/.pi/agent/pi-docs-gate`。
2. 在 `~/.pi/agent/settings.json` 的 `packages` 数组中声明:

   ```json
   "packages": [
     ...
     "pi-docs-gate"
   ]
   ```

3. 重启 pi(或新开会话)后生效。

也可按标准流程分发:`pi install git:github.com/user/pi-docs-gate`(npm/git 安装会自动读取 manifest 加载扩展与 skill)。

## 行为对照

| 场景 | 系统提示词中的表现 |
| --- | --- |
| 正常编码(其他目录) | 无 Pi documentation 段,零浪费 |
| `~/.pi/agent` 下工作 | 一行提示 + pi-docs skill 描述,模型按需加载完整指引 |
| 任意目录询问 pi 自身功能 | 模型依据 skill 描述按需加载文档指引 |

## 配置

| 常量 | 位置 | 说明 |
| --- | --- | --- |
| `PI_DOCS_CWD` | `extensions/index.ts` 顶部 | 需要文档指引的工作目录。动态推导:环境变量 `PI_CODING_AGENT_DIR` 优先,否则 `~/.pi/agent`,跨机器自动正确 |
| `PI_DOCS_SECTION_RE` | `extensions/index.ts` 顶部 | 内置段落匹配正则,若 pi 升级后段落文案变化导致删除失败,在此调整 |

## 卸载

删除 `~/.pi/agent/pi-docs-gate/` 目录并从 `settings.json` 的 `packages` 移除 `"pi-docs-gate"` 声明即可恢复内置段落;包内 `pi-docs` skill 随包一并卸载(静态文件,无任何残留状态)。

## 注意事项

- 内置段落以固定文案开头、以 `TUI API details)` 结尾,正则基于这两个锚点匹配;若 pi 未来大幅改写该段落,需要同步更新 `PI_DOCS_SECTION_RE`。
- 使用 `SYSTEM.md`(customPrompt 模式)时内置段落本就不存在,扩展自动跳过,无副作用。
- 根目录 `before/after-system-prompt*.md` 是本机系统提示词快照(开发产物,含本机信息属预期),不参与运行链路;需要时重新运行 `compare-system-prompt.mjs` 生成。
- 若 `~/.agents/skills/pi-docs/SKILL.md` 存在旧副本,保持与包内一致的静态内容即可;扩展本身不读写任何 skill 文件。
