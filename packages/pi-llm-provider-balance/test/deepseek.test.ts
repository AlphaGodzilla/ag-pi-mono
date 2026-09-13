// 纯逻辑单元测试：lib/deepseek.ts（DeepSeek 官方余额查询解析）
// 运行：node --test test/  （Node ≥22.18 默认启用 TS type-stripping）
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDeepseekBalance, formatDeepseekBalance } from "../lib/deepseek.ts";

test("extractDeepseekBalance: 正常 CNY 响应（官方示例）", () => {
  const payload = {
    is_available: true,
    balance_infos: [
      { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
    ],
  };
  assert.deepEqual(extractDeepseekBalance(payload), { currency: "CNY", total: 110.0 });
});

test("extractDeepseekBalance: USD 响应", () => {
  const payload = { is_available: true, balance_infos: [{ currency: "USD", total_balance: "42.50" }] };
  assert.deepEqual(extractDeepseekBalance(payload), { currency: "USD", total: 42.5 });
});

test("extractDeepseekBalance: 多币种条目取第一条", () => {
  const payload = {
    is_available: true,
    balance_infos: [
      { currency: "USD", total_balance: "1.00" },
      { currency: "CNY", total_balance: "2.00" },
    ],
  };
  assert.deepEqual(extractDeepseekBalance(payload), { currency: "USD", total: 1.0 });
});

test("extractDeepseekBalance: is_available=false（key 无效/账户不可用）返回 null", () => {
  assert.equal(extractDeepseekBalance({ is_available: false, balance_infos: [] }), null);
  assert.equal(extractDeepseekBalance({ is_available: false }), null);
});

test("extractDeepseekBalance: balance_infos 缺失/为空返回 null", () => {
  assert.equal(extractDeepseekBalance({ is_available: true }), null);
  assert.equal(extractDeepseekBalance({ is_available: true, balance_infos: [] }), null);
});

test("extractDeepseekBalance: 非对象/null/undefined 返回 null", () => {
  assert.equal(extractDeepseekBalance(null), null);
  assert.equal(extractDeepseekBalance(undefined), null);
  assert.equal(extractDeepseekBalance("abc"), null);
  assert.equal(extractDeepseekBalance(42), null);
});

test("extractDeepseekBalance: 币种非法返回 null", () => {
  assert.equal(
    extractDeepseekBalance({ is_available: true, balance_infos: [{ currency: "EUR", total_balance: "1.00" }] }),
    null,
  );
});

test("extractDeepseekBalance: total_balance 非字符串/非法数字返回 null", () => {
  assert.equal(
    extractDeepseekBalance({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: 110 }] }),
    null, // 文档规定为 string；number 视为非法响应
  );
  assert.equal(
    extractDeepseekBalance({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "abc" }] }),
    null,
  );
  assert.equal(
    extractDeepseekBalance({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "NaN" }] }),
    null,
  );
  assert.equal(
    extractDeepseekBalance({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "" }] }),
    null,
  );
});

test("formatDeepseekBalance: CNY → ¥110.00", () => {
  assert.equal(formatDeepseekBalance({ currency: "CNY", total: 110 }), "¥110.00");
  assert.equal(formatDeepseekBalance({ currency: "CNY", total: 0 }), "¥0.00");
  assert.equal(formatDeepseekBalance({ currency: "CNY", total: 9.5 }), "¥9.50");
});

test("formatDeepseekBalance: USD → $42.50；负数防御", () => {
  assert.equal(formatDeepseekBalance({ currency: "USD", total: 42.5 }), "$42.50");
  assert.equal(formatDeepseekBalance({ currency: "CNY", total: -5 }), "-¥5.00");
  // 未知币种按 CNY 前缀兜底
  assert.equal(formatDeepseekBalance({ currency: "EUR", total: 3 }), "¥3.00");
});
