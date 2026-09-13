// 生命周期 + provider 路由单测（对应 pi 缓存工厂复用的进程内单例语义）。
// 场景：同一模块被多个 session 实例的 factory 调用，断言：
//  1. 多个 session_start 只创建 1 个共享定时器（不重复创建）
//  2. 有其它存活会话时 session_shutdown 不清定时器；无存活显示目标（模块作废：
//     quit / reload / 跨 cwd 会话替换 / 会话结束）时清定时器，新 session_start 重建
//  3. 所有 session 渲染同一份共享余额数据（数据共享）；任一实例触发刷新后广播
//  4. 余额源按 ctx.model.provider 路由：deepseek → DeepSeek 官方余额、
//     映射表内 cpa_* → derouter、未映射 provider → 不显示（清除状态栏项）
//  5. model_select（切换模型）触发对应源即时刷新
// 注意：
//  - fetch mock 按 URL 分发（derouter / DeepSeek 各自返回对应响应），不发真实网络请求
//  - 模块级 displays/timer 跨用例共享：每个用例 finally 必须 shutdown 全部 harness，
//    保证 displays 清空、timer 被清，用例间状态干净
import { test } from "node:test";
import assert from "node:assert/strict";

const DEROUTER_URL = "https://cf-api.derouter.ai/sub-key/balance";
const DEEPSEEK_URL = "https://api.deepseek.com/user/balance";

// 测试逃生舱：在 index.ts 模块加载前注入 key（index.ts 动态 import，执行晚于本行），
// 使测试不依赖真实 config.json 中的 key 值。
process.env.DEROUTER_BALANCE_CLIENT_KEY = "sk-test-derouter";
process.env.DEROUTER_BALANCE_DEEPSEEK_API_KEY = "sk-test-deepseek";
let fakeRemaining = 123.45
let fakeDsTotal = "110.00"
let intervalCalls = 0
let clearCalls = 0
/** 定时器回调（setInterval spy 捕获）与 fetch 调用记录，供轮询行为断言 */
let intervalCallback: (() => void) | null = null
let fetchCalls: string[] = []

// ---- 沙箱工具：可注入 fetch / setInterval / clearInterval 间谍 ----
const originalFetch = globalThis.fetch
const originalSetInterval = globalThis.setInterval
const originalClearInterval = globalThis.clearInterval

function installSpies() {
  intervalCalls = 0
  clearCalls = 0
  intervalCallback = null
  fetchCalls = []
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    fetchCalls.push(url)
    if (url.startsWith(DEROUTER_URL)) {
      return {
        ok: true,
        json: async () => ({ remaining: fakeRemaining }),
      }
    }
    if (url.startsWith(DEEPSEEK_URL)) {
      return {
        ok: true,
        json: async () => ({
          is_available: true,
          balance_infos: [{ currency: "CNY", total_balance: fakeDsTotal, granted_balance: "10.00", topped_up_balance: "100.00" }],
        }),
      }
    }
    throw new Error(`unexpected fetch URL: ${url}`)
  }) as unknown as typeof fetch
  // 不真正调度定时器，只计数并捕获回调（供手动触发 tick 的用例）
  globalThis.setInterval = ((fn: () => void) => {
    intervalCalls++
    intervalCallback = fn
    return 1
  }) as unknown as typeof setInterval
  globalThis.clearInterval = (() => {
    clearCalls++
  }) as unknown as typeof clearInterval
}

function restoreGlobals() {
  globalThis.fetch = originalFetch
  globalThis.setInterval = originalSetInterval
  globalThis.clearInterval = originalClearInterval
}

const flush = () => new Promise((r) => setImmediate(r))

interface Harness {
  handlers: Map<string, (event: unknown, ctx: unknown) => Promise<void>>
  statuses: Array<{ id: string; text: string | undefined }>
  refreshCmd: (() => Promise<void>) | null
  shutdown: (reason?: string) => Promise<void>
  start: (reason?: string) => Promise<void>
  /** mock 的 session ctx（含 model.provider），供事件 handler 直接触发 */
  ctx: unknown
}

/** makeHarness(factory, provider) —— provider 决定 ctx.model.provider（余额路由依据） */
async function makeHarness(factory: (pi: any) => void, provider = "cpa_mybitx"): Promise<Harness> {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>()
  const statuses: Array<{ id: string; text: string | undefined }> = []
  let refreshCmd: (() => Promise<void>) | null = null

  const pi = {
    on: (ev: string, h: (event: unknown, ctx: unknown) => Promise<void>) => handlers.set(ev, h),
    registerCommand: (name: string, opts: { handler: () => Promise<void> }) => {
      if (name === "derouter-refresh" || name === "balance-refresh") refreshCmd = opts.handler
    },
  }
  const ctx = {
    model: { provider }, // mock：只有 provider 参与余额源路由
    ui: {
      theme: { fg: (_c: string, t: string) => t }, // 真实现只包 ANSI 色码，可见文本不变
      setStatus: (id: string, text: string | undefined) => statuses.push({ id, text }),
    },
  }
  factory(pi)
  const start = (reason = "startup") => handlers.get("session_start")!({ type: "session_start", reason }, ctx)
  const shutdown = (reason = "new") => handlers.get("session_shutdown")!({ type: "session_shutdown", reason }, ctx)
  return { handlers, statuses, refreshCmd, shutdown, start, ctx }
}

test("单例生命周期：单定时器 + 数据共享 + 存活会话不清定时器", async () => {
  installSpies()
  const live: Harness[] = []
  try {
    const { default: factory } = await import("../index.ts")
    assert.equal(typeof factory, "function")

    // 两个 session 实例共享同一工厂闭包（对应 pi 缓存工厂复用）
    const a = await makeHarness(factory, "cpa_mybitx")
    const b = await makeHarness(factory, "cpa_arb")
    live.push(a, b)

    // session A 启动（本文件首个用例，模块 timer 为空）→ 创建共享定时器 + 首拉
    await a.start("startup")
    assert.equal(intervalCalls, 1, "第一个 session 应恰好创建 1 个定时器")

    // session B 启动（resume 切换场景）→ 不应再创建定时器
    await b.start("resume")
    assert.equal(intervalCalls, 1, "第二个 session 不应重复创建定时器")

    // 等异步首拉完成（fetch mock 按 URL 返回）
    await flush()
    await flush()

    // 两个 session 都应渲染同一份共享数据（各自 provider 都路由到 derouter）
    const textA = a.statuses.map((s) => s.text)
    const textB = b.statuses.map((s) => s.text)
    assert.ok(textA.includes("· Derouter: $123.45"), `A 应渲染共享余额，实际: ${textA.join(" | ")}`)
    assert.ok(textB.includes("· Derouter: $123.45"), `B 应渲染共享余额，实际: ${textB.join(" | ")}`)

    // session A 退出（会话切换 reason=new）→ B 仍存活 → 不清理共享定时器
    await a.shutdown("new")
    assert.equal(clearCalls, 0, "仍有存活会话时 session_shutdown 不应清理共享定时器")

    // 第三个 session 启动 → 仍不新建定时器（复用 B 的）
    const c = await makeHarness(factory, "cpa_mybitx_anthropic")
    live.push(c)
    await c.start("new")
    assert.equal(intervalCalls, 1, "后续 session 应继续复用同一定时器")

    // 任一实例手动刷新 → 广播到所有存活实例
    // 先等 c 进入会话时的首拉完成（避免与手动刷新共用 refreshing 去重而跳过）
    await flush()
    await flush()
    fakeRemaining = 200
    await c.refreshCmd!()
    await flush()
    await flush()
    assert.ok(
      b.statuses.some((s) => s.text === "· Derouter: $200.00"),
      `B 应收到广播更新，实际: ${b.statuses.map((s) => s.text).join(" | ")}`,
    )
    assert.ok(
      c.statuses.some((s) => s.text === "· Derouter: $200.00"),
      `C 应收到广播更新，实际: ${c.statuses.map((s) => s.text).join(" | ")}`,
    )
  } finally {
    // 全部 shutdown → displays 清空 → 共享定时器被清，保证后续用例状态干净
    await Promise.all(live.map((h) => h.shutdown("quit")))
    restoreGlobals()
  }
})

test("单例生命周期：失败保旧值 + 错误标记（共享 store）", async () => {
  installSpies()
  const live: Harness[] = []
  try {
    const { default: factory } = await import("../index.ts")
    const h = await makeHarness(factory, "cpa_mybitx")
    live.push(h)
    await h.start("startup") // timer 已清（上例 finally）→ 重建 + 首拉
    await flush()
    await flush()
    // 初始成功：$50.00（显式重置，避免依赖上例结尾的 fakeRemaining）
    fakeRemaining = 50
    await h.refreshCmd!()
    await flush()
    await flush()
    assert.ok(h.statuses.some((s) => s.text === "· Derouter: $50.00"))

    // 模拟失败：所有 fetch 抛错 → 保留旧值 + error 标记
    globalThis.fetch = (async () => {
      throw new Error("network down")
    }) as unknown as typeof fetch
    await h.refreshCmd!()
    await flush()
    await flush()
    assert.ok(
      h.statuses.some((s) => s.text === "· Derouter: $50.00 ⚠"),
      `失败后应保留旧值+标记，实际: ${h.statuses.map((s) => s.text).join(" | ")}`,
    )
  } finally {
    await Promise.all(live.map((h) => h.shutdown("quit")))
    restoreGlobals()
  }
})

test("provider 路由：deepseek → DeepSeek 余额、未映射 → 清除不显示", async () => {
  installSpies()
  const live: Harness[] = []
  try {
    const { default: factory } = await import("../index.ts")
    fakeRemaining = 77

    // provider=deepseek：start 首拉（timer 已清 → 重建 + refreshAll 两源），应显示 DeepSeek ¥110.00（CNY）
    const h1 = await makeHarness(factory, "deepseek")
    live.push(h1)
    await h1.start("startup")
    await flush()
    await flush()
    assert.ok(
      h1.statuses.some((s) => s.text === "· DeepSeek: ¥110.00"),
      `deepseek provider 应显示 DeepSeek 余额，实际: ${h1.statuses.map((s) => s.text).join(" | ")}`,
    )

    // provider=anthropic（不在映射表）：不显示本插件状态项（清除），且无任何 unavailable 占位
    const h2 = await makeHarness(factory, "anthropic")
    live.push(h2)
    await h2.start("resume")
    assert.equal(h2.statuses[h2.statuses.length - 1]?.text, undefined, "未映射 provider 应清除状态栏项")
    assert.ok(
      !h2.statuses.some((s) => (s.text ?? "").includes("unavailable")),
      `未映射 provider 不应显示任何占位，实际: ${h2.statuses.map((s) => s.text ?? "(cleared)").join(" | ")}`
    )

    // provider=cpa_mybitx：切回 derouter 源（共享数据已就绪，$77.00）
    const h3 = await makeHarness(factory, "cpa_mybitx")
    live.push(h3)
    await h3.start("resume")
    await flush() // 等 h3 进入会话的首拉（derouter）完成后再断言
    await flush()
    assert.ok(
      h3.statuses.some((s) => s.text === "· Derouter: $77.00"),
      `cpa provider 应显示 Derouter 余额，实际: ${h3.statuses.map((s) => s.text).join(" | ")}`,
    )
  } finally {
    await Promise.all(live.map((h) => h.shutdown("quit")))
    restoreGlobals()
  }
})

test("模型切换即时刷新：model_select 触发对应源刷新，无需等定时器/手动命令", async () => {
  installSpies()
  const live: Harness[] = []
  try {
    const { default: factory } = await import("../index.ts")

    // start 首拉（timer 已清 → 重建 + refreshAll）得到初始值 ¥110.00
    const h = await makeHarness(factory, "deepseek")
    live.push(h)
    await h.start("startup")
    await flush()
    await flush()
    assert.ok(h.statuses.some((s) => s.text === "· DeepSeek: ¥110.00"))

    // 余额变化后仅触发 model_select（模拟用户在 deepseek 内切换模型）：
    // 不调 refreshCmd、不依赖定时器，应即时刷新出 ¥55.00
    fakeDsTotal = "55.00"
    const select = h.handlers.get("model_select")!
    await select(
      { type: "model_select", model: { provider: "deepseek" }, previousModel: undefined, source: "set" },
      h.ctx,
    )
    await flush()
    await flush()
    assert.ok(
      h.statuses.some((s) => s.text === "· DeepSeek: ¥55.00"),
      `model_select 后应即时刷新出 ¥55.00，实际: ${h.statuses.map((s) => s.text).join(" | ")}`,
    )

    // 未映射 provider 的 model_select：不发起刷新（无源可刷），仅渲染 unavailable
    const h2 = await makeHarness(factory, "anthropic")
    live.push(h2)
    await h2.start("resume")
    const select2 = h2.handlers.get("model_select")!
    await select2(
      { type: "model_select", model: { provider: "anthropic" }, previousModel: undefined, source: "set" },
      h2.ctx,
    )
    assert.equal(h2.statuses[h2.statuses.length - 1]?.text, undefined, "未映射 provider 的 model_select 应保持清除")
  } finally {
    await Promise.all(live.map((h) => h.shutdown("quit")))
    restoreGlobals()
  }
})

test("定时器清理判据：displays 清空即清（任何 reason），仍有存活会话则保留，新 session_start 重建", async () => {
  installSpies()
  const live: Harness[] = []
  try {
    const { default: factory } = await import("../index.ts")

    // 两个并发存活会话：只建 1 个定时器
    const h1 = await makeHarness(factory, "cpa_mybitx")
    const h2 = await makeHarness(factory, "cpa_mybitx_anthropic")
    live.push(h1, h2)
    await h1.start("startup")
    await h2.start("resume")
    assert.equal(intervalCalls, 1, "并发会话应共享 1 个定时器")

    // 关掉 h1（reason=new 会话切换）：h2 仍存活 → 不清
    await h1.shutdown("new")
    assert.equal(clearCalls, 0, "仍有存活会话时不应清定时器")

    // 关掉最后一个 h2（reason=quit）：displays 清空 → 清定时器
    live.splice(live.indexOf(h2), 1)
    await h2.shutdown("quit")
    assert.equal(clearCalls, 1, "无存活显示目标时 quit 应清定时器")

    // 新会话（模拟 reload 后 / 跨 cwd 替换后的新模块 session_start）→ 重建
    const h3 = await makeHarness(factory, "cpa_arb")
    live.push(h3)
    await h3.start("startup")
    assert.equal(intervalCalls, 2, "清理后新 session 应重建定时器")

    // reload reason 同样清（displays 清空）
    live.splice(live.indexOf(h3), 1)
    await h3.shutdown("reload")
    assert.equal(clearCalls, 2, "reload 应清定时器（防止每次 /reload 泄漏一个 interval）")

    // 单会话场景下 reason=new（会话切换）也清：本模块实例已无任何 UI 消费者，
    // 之后的新 session_start 会重建并首拉（等价于切换会话即刷新）
    const h4 = await makeHarness(factory, "cpa_mybitx")
    live.push(h4)
    await h4.start("startup")
    assert.equal(intervalCalls, 3, "reload 后新 session 应再次重建定时器")
    live.splice(live.indexOf(h4), 1)
    await h4.shutdown("new")
    assert.equal(clearCalls, 3, "单会话切换（displays 清空）也应清定时器")

    const h5 = await makeHarness(factory, "deepseek")
    live.push(h5)
    await h5.start("resume")
    assert.equal(intervalCalls, 4, "切换后的新 session 应重建定时器并首拉")
  } finally {
    await Promise.all(live.map((h) => h.shutdown("quit")))
    restoreGlobals()
  }
})

test("定时轮询只刷活跃源：未映射 provider 零请求，映射 provider 只刷对应源", async () => {
  installSpies()
  const live: Harness[] = []
  try {
    const { default: factory } = await import("../index.ts")

    // 1) 未映射 provider（anthropic）：session_start 首拉与定时 tick 都不发请求
    const h1 = await makeHarness(factory, "anthropic")
    live.push(h1)
    await h1.start("startup")
    await flush()
    assert.equal(fetchCalls.length, 0, "未映射 provider 的 session_start 应零请求")
    intervalCallback?.()
    await flush()
    await flush()
    assert.equal(fetchCalls.length, 0, "未映射 provider 的定时 tick 应零请求")

    // 2) 映射 provider（deepseek）：首拉与 tick 都只刷 deepseek，不刷其它已配置源（derouter）
    const h2 = await makeHarness(factory, "deepseek")
    live.push(h2)
    await h2.start("resume")
    await flush()
    await flush()
    assert.deepEqual(fetchCalls, [DEEPSEEK_URL], "映射 provider 首拉只刷对应源")
    fetchCalls.length = 0
    intervalCallback?.()
    await flush()
    await flush()
    assert.deepEqual(fetchCalls, [DEEPSEEK_URL], "定时 tick 只刷活跃源，不刷其它已配置源")

    // 3) 切到未映射 provider：活跃源贡献被注销，后续 tick 零请求
    const select = h2.handlers.get("model_select")!
    await select(
      { type: "model_select", model: { provider: "anthropic" }, previousModel: undefined, source: "set" },
      h2.ctx,
    )
    fetchCalls.length = 0
    intervalCallback?.()
    await flush()
    await flush()
    assert.equal(fetchCalls.length, 0, "切到未映射 provider 后定时 tick 应零请求")
  } finally {
    await Promise.all(live.map((h) => h.shutdown("quit")))
    restoreGlobals()
  }
})

test("reload 无定时器泄漏：旧模块实例清定时器，重新 import 的新实例重建且可正常刷新", async () => {
  installSpies()
  const live: Harness[] = []
  try {
    // 旧模块实例（pi 在 /reload 前已缓存的闭包）
    const oldModule = await import("../index.ts")
    const a = await makeHarness(oldModule.default, "cpa_mybitx")
    live.push(a)
    await a.start("startup")
    assert.equal(intervalCalls, 1, "旧实例应建立 1 个定时器")
    await flush()
    await flush()
    assert.equal(fetchCalls.length, 1, "旧实例首拉应只请求 1 次（derouter）")

    // pi 执行 /reload：先对旧实例发 session_shutdown(reason=reload)
    await a.shutdown("reload")
    assert.equal(clearCalls, 1, "reload 应清掉旧模块实例的定时器")

    // 旧实例的定时器回调即使被误触发也应零请求（instanceSources 已注销、timer 已清）
    const oldCallback = intervalCallback
    fetchCalls.length = 0
    oldCallback?.()
    await flush()
    await flush()
    assert.equal(fetchCalls.length, 0, "旧实例 shutdown 后其 tick 应零请求")

    // pi 重新 import 扩展模块（模拟 clearExtensionCache 后的重新求值）→ 新实例 + session_start
    const newModule = await import(`../index.ts?reload=${Date.now()}`)
    const b = await makeHarness(newModule.default, "cpa_mybitx")
    live.push(b)
    await b.start("startup")
    assert.equal(intervalCalls, 2, "新模块实例应重建独立定时器")
    await flush()
    await flush()

    // 新实例功能正常：手动刷新后渲染新值
    fakeRemaining = 42
    await b.refreshCmd!()
    await flush()
    await flush()
    assert.ok(
      b.statuses.some((s) => s.text === "· Derouter: $42.00"),
      `新实例应能正常刷新渲染，实际: ${b.statuses.map((s) => s.text).join(" | ")}`
    )
  } finally {
    await Promise.all(live.map((h) => h.shutdown("quit")))
    restoreGlobals()
  }
})
