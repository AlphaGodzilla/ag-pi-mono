# pi-gen-commit-msg-zh

pi 扩展包:生成中文 git commit message。原为 `extensions/gen-commit-msg-zh` 扩展,现改为标准 pi 插件包,通过 `settings.json` 的 `packages` 字段启用。

## 包含资源

| 资源 | 路径 | 说明 |
| --- | --- | --- |
| 扩展 | `index.ts` + `prompt.md` | 注册 `/gen-commit-msg-zh` 命令:生成 commit message 后弹「提交 / 调整消息 / 放弃」三选交互(人工审核) |
| skill | `skills/gen-commit-msg-zh/SKILL.md` | 规范型 skill,启动时被 pi 扫描注入 description;自然语言触发(如"帮我提交"),生成消息后**直接提交,无需人工三选审核** |

## 安装

```bash
pi install ./pi-gen-commit-msg-zh
# 或直接在 ~/.pi/agent/settings.json 的 packages 数组加入:
#   "pi-gen-commit-msg-zh"
```

相对路径以 settings.json 所在目录为基准。修改后 `/reload` 或重启 pi 生效。

## 两条入口的分工

- `/gen-commit-msg-zh [附加要求]` —— 只读探查 → 生成并展示消息 → 弹三选(提交 / 调整 / 放弃),适合需要人工把关的场景
- skill 自然触发 —— 用户说"提交一下"时,agent 读取 SKILL.md,按同一套 Format/类型规范生成消息并直接 commit,不弹交互

两者共享同一套消息规范(Conventional type + 中文标题与要点、不加广告尾注、sandbox 下多 `-m` 提交)。
