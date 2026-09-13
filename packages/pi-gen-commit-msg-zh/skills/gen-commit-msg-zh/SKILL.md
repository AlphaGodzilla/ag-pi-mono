---
name: gen-commit-msg-zh
description: 生成中文 git commit message 并直接提交(无需人工三选审核)。当用户在当前仓库要求"提交/commit/生成提交信息/提交代码/commit message"时使用:先自行运行只读 git 命令获取上下文,按下方规范生成消息后直接 git commit。不要用于:无提交意图的纯代码讨论;需要先人工确认消息内容的交互流程(请用 /gen-commit-msg-zh 命令,该命令走提交/调整/放弃三选)。
---

# gen-commit-msg-zh

面向 pi agent 的中文 git 提交规范 skill:生成 commit message **无需人工审核,直接作为提交消息落地**。

## 与 /gen-commit-msg-zh 命令的分工

| 入口 | 触发方式 | 行为 |
| --- | --- | --- |
| 本 skill | 自然语言(如"帮我提交""commit 一下") | 生成消息后**直接执行 git commit**,不弹三选 |
| `/gen-commit-msg-zh` 命令 | 显式命令(可带附加要求) | 只生成并展示,由扩展弹「提交 / 调整消息 / 放弃」三选 |

## 何时使用

- 用户在当前 git 仓库要求提交改动、生成提交信息(触发词:提交、commit、commit message、提交代码、commit 一下、发个 commit)
- 用户要求"按仓库风格提交",而仓库有可提交的改动

## 何时不要用

- 用户只是在讨论改动、要求 review,没有表达提交意图 —— 不要擅自提交
- 用户明确想要"先生成给我看/等我确认" —— 此时只生成展示,或提示用 `/gen-commit-msg-zh`(三选交互版)
- 当前目录不是 git 仓库

## 核心原则

1. **先探查,不臆测**:一切上下文来自你自己运行的只读 git 命令,禁止凭空假设改动内容
2. **暂存优先**:有已暂存改动则以暂存内容为准;无暂存则按用户请求范围(默认全部)add 后提交
3. **一次落地**:消息生成后直接 commit,不再回头问"要不要调整"——除非用户主动提出
4. **不加广告尾注**,不添加 "Generated with ..." 之类内容
5. 标题为英文 type 前缀 + 中文描述,正文要点用中文

## 工作流程

1. **只读探查**(必要时用 `git status`、`git diff --staged`、无暂存时 `git diff`、`git branch --show-current`、`git log --oneline -10` 参考近期风格)
2. **列出修改的文件**,按下方 Format 生成 commit message(标题 + 中文要点正文)
3. **确定 add 范围**:
   - 已有暂存改动 → 不再 add,直接对已暂存内容提交
   - 无暂存改动 → `git add -A`;若用户指定了提交范围(如"只提交 src/"),按该范围 add
4. **执行提交**:`git commit` 用多个 `-m`(首个为标题,其余为正文要点;sandbox 环境同样适用),不加任何广告尾注
5. **收尾**:报告提交成功与 commit hash;若无任何可提交改动,如实说明并停下

## Format

```
<type>:<space><message title in Chinese>

<bullet points in Chinese summarizing what was updated>
```

### Example Titles

```
feat(auth): 添加 JWT 登录流程
fix(ui): 修复侧边栏空指针问题
refactor(api): 拆分用户控制器逻辑
docs(readme): 添加使用说明章节
```

### Example with Title and Body

```
feat(auth): 添加 JWT 登录流程

- 实现了 JWT 令牌验证逻辑
- 为验证组件添加了文档说明
```

### Rules

- title 全小写、末尾无句号
- Title 清晰概括,不超过 50 个中文字符
- Body(可选)解释 *why* 而非仅 *what*
- Bullet 要点简洁、高层,不堆细节

Avoid:

- 模糊标题如 "update"、"fix stuff"
- 过长或主题分散的标题
- bullet 里写过多细节

### Allowed Types

| Type     | Description                           |
| -------- | ------------------------------------- |
| feat     | New feature                           |
| fix      | Bug fix                               |
| chore    | Maintenance (e.g., tooling, deps)     |
| docs     | Documentation changes                 |
| refactor | Code restructure (no behavior change) |
| test     | Adding or refactoring tests           |
| style    | Code formatting (no logic change)     |
| perf     | Performance improvements              |
11. **Controller 独立但共用 Tag**：新增 `AdminTotpController`，使用与 `AdminAuthController` 完全相同的 Tag name/description，order 使用 140/150/160/170。
## 红旗 —— 立即停下

- 还没跑任何只读 git 命令就想生成消息 —— 先探查
- 探查阶段就执行 `git add` / `git commit` —— 探查只允许只读命令
- 有已暂存改动却 add 了未暂存文件 —— 暂存内容为准,用户没指定就别扩大范围
- 用户只让生成消息你却执行了提交 —— 按用户意图区分,拿不准时只生成并询问
- 生成消息时出现广告尾注 / 英文长标题 / 无 type 前缀

## 自检清单

- [ ] 已运行只读 git 命令获取真实状态,未臆测
- [ ] 消息符合 Format:type 前缀 + 中文标题 + 简洁中文要点
- [ ] 提交范围与用户意图一致(暂存优先 / 指定范围 / 默认 -A)
- [ ] 未添加任何广告尾注
- [ ] 提交后报告了结果(成功 + hash,或"无改动可提交")
