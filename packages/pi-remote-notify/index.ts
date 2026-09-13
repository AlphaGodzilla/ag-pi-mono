/**
 * remote-notify —— 任务结束后通过飞书提醒，含最近一次工作总结。
 *
 * 能力（与 pi-cmux 对齐的事件种类，全部通过飞书发送）：
 *  - before_agent_start  任务开始
 *  - agent_settled       任务完成（含最近一次工作总结：请求/工具/结论/耗时）
 *  - session_shutdown    会话结束
 *  - permissions:ui_prompt  权限 ask 弹窗等待
 *  - rpiv:ask-user:prompt   ask_user_question 问卷弹窗等待
 *
 * /remote-notify 为 toggle 命令（开/关/状态），状态持久化到
 * ~/.pi/agent/feishu/remote-notify-state.json，默认关闭。
 *
 * 与 pi-cmux 相互独立：仅订阅事件、不修改/依赖 pi-cmux 的任何代码或状态；
 * 所有飞书发送均为异步 + 异常兜底，不会影响 pi 主流程与其它扩展。
 *
 * 配置（凭证/收件人复用 ~/.pi/agent/feishu/，均可被环境变量覆盖）：
 *  - PI_FEISHU_NOTIFY=0            强制禁用本扩展
 *  - PI_FEISHU_NOTIFY_APP_ID       覆盖 appId
 *  - PI_FEISHU_NOTIFY_APP_SECRET   覆盖 appSecret
 *  - PI_FEISHU_NOTIFY_CHAT_ID      覆盖收件人 chat_id
 *  - PI_FEISHU_NOTIFY_OPEN_ID      覆盖收件人 open_id
 *  - PI_FEISHU_NOTIFY_INCLUDE_SUBAGENTS=1  也通知 subagent 会话（默认跳过）
 *  - PI_FEISHU_NOTIFY_SESSION_END=0 关闭会话结束提醒
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { loadFeishuConfig } from './src/config.ts'
import { loadState, saveState } from './src/state.ts'
import { logError } from './src/feishu.ts'
import registerLifecycle from './src/lifecycle.ts'
import registerPermissionNotify from './src/permissionNotify.ts'
import registerAskUserNotify from './src/askUserNotify.ts'

export default function remoteNotify(pi: ExtensionAPI): void {
  if (process.env.PI_FEISHU_NOTIFY === '0') return

  const state = loadState()
  const getEnabled = () => state.enabled
  const cfg = loadFeishuConfig()

  const report = (ctx: { hasUI?: boolean; ui: { notify(msg: string, level: 'info' | 'warning'): void } }, msg: string, on: boolean) => {
    if (ctx.hasUI) ctx.ui.notify(msg, on ? 'info' : 'warning')
    else console.log(msg)
  }

  pi.registerCommand('remote-notify', {
    description: '切换飞书远程提醒开关（无参数 = 切换；on/off/status）',
    handler: async (args, ctx) => {
      const arg = (args ?? '').trim().toLowerCase()
      if (arg === 'on') {
        state.enabled = true
      } else if (arg === 'off') {
        state.enabled = false
      } else if (arg === 'status') {
        report(ctx, `remote-notify: ${state.enabled ? '已开启' : '已关闭'}`, state.enabled)
        return
      } else {
        state.enabled = !state.enabled
      }
      saveState(state)
      report(ctx, `remote-notify: ${state.enabled ? '已开启（飞书通知）' : '已关闭'}`, state.enabled)
    },
  })

  if (!cfg) {
    logError('未找到可用的飞书配置（ask-question 配置 / feishu 桥接 / 环境变量均不可用），发送功能不可用')
    return
  }

  registerLifecycle(pi, { getEnabled, cfg })
  registerPermissionNotify(pi, { getEnabled, cfg })
  registerAskUserNotify(pi, { getEnabled, cfg })
}
