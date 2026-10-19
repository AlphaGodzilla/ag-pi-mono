import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { DEFAULT_LOOP_CONFIG, loadLoopConfig, normalizeLoopConfig, resolveConfigPath } from "../src/config.ts"

function tempAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-loop-config-"))
}

function writeUserConfig(agentDir: string, value: unknown): string {
  const dir = join(agentDir, "extensions", "pi-loop")
  mkdirSync(dir, { recursive: true })
  const path = join(dir, "config.json")
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value))
  return path
}

test("没有配置文件时用默认值（退出键 ctrl+shift+l）", () => {
  const agentDir = tempAgentDir()
  const loaded = loadLoopConfig(agentDir, join(agentDir, "no-such-package"))
  assert.deepEqual(loaded.config, DEFAULT_LOOP_CONFIG)
  assert.equal(loaded.source, undefined)
  assert.deepEqual(loaded.config.exitKeys, ["ctrl+shift+l"])
})

test("用户配置目录优先于包目录", () => {
  const agentDir = tempAgentDir()
  const pkgRoot = join(agentDir, "pkg")
  mkdirSync(pkgRoot, { recursive: true })
  writeFileSync(join(pkgRoot, "config.json"), JSON.stringify({ exitKeys: ["ctrl+x"], minIntervalMs: 5000 }))
  const userPath = writeUserConfig(agentDir, { exitKeys: ["alt+q"] })

  assert.equal(resolveConfigPath(agentDir, pkgRoot), userPath)
  const loaded = loadLoopConfig(agentDir, pkgRoot)
  assert.equal(loaded.source, userPath)
  assert.deepEqual(loaded.config.exitKeys, ["alt+q"])
  assert.equal(loaded.config.minIntervalMs, DEFAULT_LOOP_CONFIG.minIntervalMs)
})

test("用户配置缺失时回落包目录内的 config.json", () => {
  const agentDir = tempAgentDir()
  const pkgRoot = join(agentDir, "pkg")
  mkdirSync(pkgRoot, { recursive: true })
  writeFileSync(join(pkgRoot, "config.json"), JSON.stringify({ cycleWarnMs: 0 }))
  const loaded = loadLoopConfig(agentDir, pkgRoot)
  assert.equal(loaded.source, join(pkgRoot, "config.json"))
  assert.equal(loaded.config.cycleWarnMs, 0)
})

test("非法值必须报错，而不是静默取默认值（fail-fast）", () => {
  assert.throws(() => normalizeLoopConfig({ exitKeys: [] }, "test"), /exitKeys/)
  assert.throws(() => normalizeLoopConfig({ exitKeys: [" "] }, "test"), /exitKeys/)
  assert.throws(() => normalizeLoopConfig({ minIntervalMs: "5" }, "test"), /minIntervalMs/)
  assert.throws(() => normalizeLoopConfig({ cycleWarnMs: -1 }, "test"), /cycleWarnMs/)
  assert.throws(() => normalizeLoopConfig([], "test"), /JSON object/)
})

test("配置文件不是合法 JSON 时报错并指出路径", () => {
  const agentDir = tempAgentDir()
  const path = writeUserConfig(agentDir, "{ not json")
  assert.throws(() => loadLoopConfig(agentDir, join(agentDir, "pkg")), new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
})
