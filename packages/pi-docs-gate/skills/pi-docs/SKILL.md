---
name: pi-docs
description: pi 自身文档(README、docs/、examples/ 及 extensions.md、themes.md、skills.md、prompt-templates.md、tui.md、keybindings.md、sdk.md、custom-provider.md、models.md、packages.md、environment-variables.md)的完整访问指引。触发场景:当前工作目录为 ~/.pi/agent(pi 配置目录)、或用户询问 pi 本身的功能(其 SDK、扩展、主题、skills、prompt 模板、TUI、快捷键、自定义模型供应商、环境变量)时,必须读取本 skill 获取文档路径与查阅规则。
---

# pi-docs

pi 自身文档的按需访问指引。默认系统提示词已移除 Pi documentation 段落,需要时通过本 skill 加载。

## 文档位置(启发式自行定位,不写死路径)

pi 以全局 npm 包形式安装(`@earendil-works/pi-coding-agent`),真实目录随本机的 node/nvm 版本、用户名而不同,不要假设任何固定路径。每次需要读取文档前,按以下步骤现场定位:

1. 运行 `npm root -g`(npm 全局安装根目录);
2. pi 包根目录 = `<上一步输出>/@earendil-works/pi-coding-agent`,先用 `ls` 确认其下存在 `package.json`、`README.md`、`docs/`、`examples/`;
3. 以该包根目录为基准解析文档:
   - 主文档: `<包根>/README.md`
   - 附加文档: `<包根>/docs`
   - 示例: `<包根>/examples`(extensions、custom tools、SDK)
4. 兜底:若 `npm` 不可用,由 `which node` 推导——node 可执行文件的上级上级目录 + `/lib/node_modules/@earendil-works/pi-coding-agent`;仍找不到时,可运行 `node -p "require.resolve('@earendil-works/pi-coding-agent/package.json')"` 定位。

## 查阅规则

- 读取 pi 文档或示例时,`docs/...` 以 Additional docs 为基准、`examples/...` 以 Examples 为基准解析,**不是当前工作目录**
- 按主题查阅对应文档:
  - 扩展 → `docs/extensions.md`、`examples/extensions/`
  - 主题 → `docs/themes.md`
  - skills → `docs/skills.md`
  - prompt 模板 → `docs/prompt-templates.md`
  - TUI 组件 → `docs/tui.md`
  - 快捷键 → `docs/keybindings.md`
  - SDK 集成 → `docs/sdk.md`
  - 自定义供应商 → `docs/custom-provider.md`
  - 添加模型 → `docs/models.md`
  - pi packages → `docs/packages.md`
  - 环境变量 → `docs/environment-variables.md`
- 处理 pi 相关主题时,先读对应文档和示例,实现前遵循文档中的 .md 交叉引用
- 始终完整读取 pi 的 .md 文件,并跟随文档内链接(如 `tui.md` 中的 TUI API 细节)
