// 纯逻辑单元测试：lib/balance.ts
// 运行：node --test test/  （Node ≥22.18 默认启用 TS type-stripping）
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractRemaining, formatRemaining, buildAuthHeaders } from "../lib/balance.ts";

test("extractRemaining: 正常数字对象", () => {
  assert.equal(extractRemaining({ remaining: 150.0 }), 150.0);
  assert.equal(extractRemaining({ budget: 200, spent: 50, remaining: 149.99 }), 149.99);
});

test("extractRemaining: 字段缺失返回 null", () => {
  assert.equal(extractRemaining({ budget: 200, spent: 50 }), null);
});

test("extractRemaining: null/undefined/非对象返回 null", () => {
  assert.equal(extractRemaining(null), null);
  assert.equal(extractRemaining(undefined), null);
  assert.equal(extractRemaining("abc"), null);
  assert.equal(extractRemaining(42), null);
});

test("extractRemaining: remaining 非 number / NaN / Infinity 返回 null", () => {
  assert.equal(extractRemaining({ remaining: "150" }), null);
  assert.equal(extractRemaining({ remaining: NaN }), null);
  assert.equal(extractRemaining({ remaining: Infinity }), null);
  assert.equal(extractRemaining({ remaining: null }), null);
});

test("formatRemaining: 150.0000 → $150.00", () => {
  assert.equal(formatRemaining(150.0), "$150.00");
  assert.equal(formatRemaining(150.006), "$150.01"); // 四舍五入（150.005 因浮点精度会得到 150.00）
});

test("formatRemaining: 0 / 负数 / 多位小数", () => {
  assert.equal(formatRemaining(0), "$0.00");
  assert.equal(formatRemaining(-12.5), "-$12.50");
  assert.equal(formatRemaining(1234.5), "$1234.50");
});

test("buildAuthHeaders: key 注入为 Bearer <key>", () => {
  const headers = buildAuthHeaders("sk-ant-abc123");
  assert.equal(headers.Authorization, "Bearer sk-ant-abc123");
});

test("buildAuthHeaders: 空 key 抛错", () => {
  assert.throws(() => buildAuthHeaders(""));
  assert.throws(() => buildAuthHeaders("   "));
});
