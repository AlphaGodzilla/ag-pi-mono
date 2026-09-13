# pi-mono

pi 扩展单仓（monorepo）。原先分散在 `~/.pi/agent/` 下的 7 个本地扩展目录合并到这里，用 pnpm workspace 统一管理依赖、typecheck 与测试。

## 包一览

| 包 | 目录 | pi 入口 | 说明 |
| --- | --- | --- | --- |
| `@alphagodzilla/pi-channel` | `packages/pi-channel` | `index.ts` | 外部通信 channel 插件：独占飞书/Telegram 凭据与连接，通过 `ag-pi-channel:*` 事件契约对外提供出站/入站传输能力 |
| `@alphagodzilla/pi-cmux` | `packages/pi-cmux` | `index.ts` | cmux 集成（工作区/面板状态），以及权限 ask、`ask_user_question` 问卷弹窗的 cmux 通知 |
| `@alphagodzilla/pi-context-watchdog` | `packages/pi-context-watchdog` | `index.ts` | 上下文余量看门狗：接近上限时注入收尾提示，阈值自动压缩后自动继续 |
| `@alphagodzilla/pi-docs-gate` | `packages/pi-docs-gate` | `extensions/` + `skills/` | 把系统提示词里硬编码的 Pi documentation 段落按需化，并动态渲染 pi-docs skill 路径 |
| `@alphagodzilla/pi-gen-commit-msg-zh` | `packages/pi-gen-commit-msg-zh` | `index.ts` + `skills/` | `/gen-commit-msg-zh` 交互式中文提交信息，附直接提交的规范型 skill |
| `@alphagodzilla/pi-llm-provider-balance` | `packages/pi-llm-provider-balance` | `index.ts` | 状态栏按当前 provider 显示账户余额（derouter / DeepSeek） |
| `@alphagodzilla/pi-remote-notify` | `packages/pi-remote-notify` | `index.ts` | 任务结束后飞书提醒（含工作总结），`/remote-notify` 开关 |
| `@alphagodzilla/pi-tps` | `packages/pi-tps` | `index.ts` | TUI 实时显示生成速度（MIN/MAX/AVG/CUR）与首字延迟 |

## 开发

```bash
pnpm install          # 安装全部 workspace 依赖
pnpm check            # typecheck + test（全部包）
pnpm typecheck        # 只跑类型检查（根单份 tsconfig，一个 tsc 覆盖 packages/**/*.ts）
pnpm -r test          # 只跑有 test 脚本的包
pnpm --filter @alphagodzilla/pi-tps test   # 单包
```

- Node `>=22.18`：测试直接用 `node --test` 跑 `.ts`（依赖内置 type stripping），无需构建。
- 依赖分层：`typescript`、`@types/node`、`@earendil-works/pi-ai|pi-coding-agent|pi-tui`（0.85.1）、`jiti` 放在根 `devDependencies`；各包只声明 `peerDependencies`（`@earendil-works/pi-coding-agent`，`optional`）与自身运行时依赖。
- 若 pnpm 提示 `Ignored build scripts`（esbuild / protobufjs / @google/genai），可忽略：它们只是 pi 包的类型/测试依赖，运行用的是 pi 自带预构建产物；确实需要时执行 `pnpm approve-builds`。
- tsconfig 只有**根一份** `tsconfig.json`（`include: packages/**/*.ts`）：各包不再有 `tsconfig.json`，也没有 `typecheck` 脚本；新增包只要放在 `packages/*` 下就会被自动纳入类型检查。

## 与 pi 的关系（加载方式）

pi 通过 `~/.pi/agent/settings.json` 的 `packages` 数组按路径加载本地包，包内由 `package.json` 的 `pi` manifest 决定加载哪些 `extensions` / `skills`。

当前 `settings.json` **仍指向旧目录**（`pi-llm-provider-balance`、`pi-docs-gate`、`pi-gen-commit-msg-zh`、`pi-remote-notify/index.ts`、`pi-tps`），旧目录也仍保留在 `~/.pi/agent/` 下。要切到本仓，把对应条目改成：

```json
"pi-mono/packages/pi-llm-provider-balance",
"pi-mono/packages/pi-docs-gate",
"pi-mono/packages/pi-gen-commit-msg-zh",
"pi-mono/packages/pi-remote-notify",
"pi-mono/packages/pi-tps"
```

`pi-cmux` 与 `pi-context-watchdog` 目前不在 `packages` 中（也不在自动扫描的 `extensions/` 目录里），因此 pi 不会加载它们；需要启用时再追加 `pi-mono/packages/pi-cmux`、`pi-mono/packages/pi-context-watchdog`。

## 配置与运行数据目录约定

扩展的**用户配置不进仓库**，统一放在 pi 用户目录下的同名子目录：

```
~/.pi/agent/extensions/<扩展名>/config.json      # 扩展名 = 包目录名（不含 scope），如 pi-llm-provider-balance
```

- 该目录可安全用作配置目录：pi 扫描 `extensions/` 时只认 `.ts`/`.js` 文件与含 `index.ts`/`package.json` 的子目录，只放 `config.json` 的子目录会被跳过。
- 解析顺序：**用户配置目录优先**，缺失时回落到包目录内的同名文件（旧位置，兼容用）。
- 运行数据同放该目录：`pi-remote-notify` 的 `state.json`（`/remote-notify` 开关）与 `error.log`。
- 外部通信（飞书 / Telegram）的凭据只放 `pi-channel` 一个包：其它扩展（含 rpiv-mono 里的 `rpiv-ask-user-question`）通过 `ag-pi-channel:*` 事件调用它，不直接持有凭证、不直接依赖 SDK。
- 需要配置的包提供 `config.example.json` 模板（`pi-llm-provider-balance`、`pi-channel`）；`packages/pi-llm-provider-balance/config.json` 仍被 `.gitignore` 排除，仅作为兜底位置的保险。`pi-remote-notify` 已不需要配置（凭证与收件人由 `pi-channel` 提供）。

## 迁移记录

- 本仓为全新 git 仓库，不带原 7 个目录的历史；原目录及其 `.git` 未改动，仍留在 `~/.pi/agent/` 下。
- 包名统一为 `@alphagodzilla/pi-*`，`repository`/`homepage`/`bugs` 指向本单仓。
- 类型检查统一到根目录单份 `tsconfig.json`（`include: packages/**/*.ts`）：原先只有 `pi-llm-provider-balance` 有 tsconfig，迁移时先给每包加了一份，随后按要求改为只保留根一份。
- 迁移时修掉两处此前未暴露的严格类型问题：`pi-tps` 的 `firstDeltaAt` 显式收敛；`pi-remote-notify` 的 `extractWorkSummary` 参数放宽为 `Pick<SessionManager, 'getBranch'>`（`ctx.sessionManager` 是 `ReadonlySessionManager`）。
- 测试/验证脚本去掉本机绝对路径：`jiti` 与 `@earendil-works/pi-*` 改从工作区依赖解析（`PI_DIST` 可覆盖）。
- `pi-remote-notify` 的测试改为把 agent 目录指向临时目录（`PI_CODING_AGENT_DIR`）：原先 toggle 测试会删改真实的 `~/.pi/agent/feishu/remote-notify-state.json`（即 `/remote-notify` 的开关状态），现在不再触碰。
