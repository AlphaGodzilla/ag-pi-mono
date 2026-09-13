/**
 * 配置路径解析测试（node --test）。
 *
 * 覆盖 resolveConfigPath / loadConfig 的查找顺序：
 *   1. ~/.pi/agent/extensions/pi-llm-provider-balance/config.json（用户配置，优先）
 *   2. 包目录 config.json（旧位置，兜底）
 *
 * 隔离手法：PI_CODING_AGENT_DIR 指向临时目录（getAgentDir() 每次调用都读该环境变量），
 * 全程不触碰真实配置，也不发真实网络请求。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_NAME = "pi-llm-provider-balance";

// 关掉 key 的环境变量逃生舱，确保断言看到的是配置文件里的值
delete process.env.DEROUTER_BALANCE_CLIENT_KEY;
delete process.env.DEROUTER_BALANCE_DEEPSEEK_API_KEY;

/** 临时 agent 目录（本模块 import 前就要设好，模块级 cfg 会在 import 时求值一次） */
const AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-balance-config-test-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

const USER_CONFIG = join(AGENT_DIR, "extensions", EXT_NAME, "config.json");
const { resolveConfigPath, loadConfig } = await import("../index.ts");

function writeUserConfig(content: string): void {
  mkdirSync(dirname(USER_CONFIG), { recursive: true });
  writeFileSync(USER_CONFIG, content, "utf8");
}

test("用户配置存在时：优先解析到 ~/.pi/agent/extensions/<扩展名>/config.json", () => {
  writeUserConfig(JSON.stringify({ derouterClientKey: "sk-from-user-config" }));
  assert.equal(resolveConfigPath(), USER_CONFIG);
});

test("用户配置存在时：loadConfig 读到的就是用户配置的值", () => {
  writeUserConfig(
    JSON.stringify({
      derouterClientKey: "sk-from-user-config",
      deepseekApiKey: "sk-ds-from-user-config",
      providerBalanceSources: { deepseek: "deepseek" },
    }),
  );
  const cfg = loadConfig();
  assert.equal(cfg.derouterClientKey, "sk-from-user-config");
  assert.equal(cfg.deepseekApiKey, "sk-ds-from-user-config");
  assert.deepEqual(cfg.providerBalanceSources, { deepseek: "deepseek" });
});

test("用户配置缺失时：回落到包目录 config.json", () => {
  rmSync(USER_CONFIG);
  assert.equal(resolveConfigPath(), join(PKG_DIR, "config.json"));
});

test("用户配置非法 JSON 时：退化为空配置且不抛异常", () => {
  writeUserConfig("{ not json");
  const cfg = loadConfig();
  assert.equal(cfg.derouterClientKey, "");
});

test("环境变量逃生舱仍可覆盖配置文件里的 key", () => {
  writeUserConfig(JSON.stringify({ derouterClientKey: "sk-from-user-config" }));
  process.env.DEROUTER_BALANCE_CLIENT_KEY = "sk-from-env";
  try {
    assert.equal(loadConfig().derouterClientKey, "sk-from-env");
  } finally {
    delete process.env.DEROUTER_BALANCE_CLIENT_KEY;
  }
});

test.after(() => {
  rmSync(AGENT_DIR, { recursive: true, force: true });
});
