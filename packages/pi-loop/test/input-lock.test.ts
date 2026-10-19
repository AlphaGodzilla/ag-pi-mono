import assert from "node:assert/strict"
import { test } from "node:test"

import { isTextualInput, matchesExitInput, parseModifierKeySequence } from "../src/input-lock.ts"

const EXIT_KEYS = ["ctrl+shift+l"]

test("文本输入被识别为人类输入（需要吞掉）", () => {
  for (const data of ["a", "hello", "你", " ", "\r", "\n", "3 bugs", "\x1b[200~pasted text\x1b[201~"]) {
    assert.equal(isTextualInput(data), true, `expected ${JSON.stringify(data)} to be textual`)
  }
})

test("应用级按键与控制序列放行", () => {
  for (const data of [
    "\x1b", // Esc
    "\x03", // Ctrl+C
    "\x04", // Ctrl+D
    "\x0f", // Ctrl+O
    "\x1b[Z", // Shift+Tab
    "\x1b[A", // Up
    "\x1b[<0;10;5M", // 鼠标
    "\x1b[13;2u", // Kitty shift+enter
  ]) {
    assert.equal(isTextualInput(data), false, `expected ${JSON.stringify(data)} to pass through`)
  }
})

test("Kitty 承载的可打印字符仍然算人类输入", () => {
  assert.equal(isTextualInput("\x1b[97u"), true) // a
  assert.equal(isTextualInput("\x1b[97;2u"), true) // shift+a
  assert.equal(isTextualInput("\x1b[97;;97u"), true) // 带关联文本
  assert.equal(isTextualInput("\x1b[27;1;97~"), true) // modifyOtherKeys 的 a
})

test("退出快捷键：传统终端的 ctrl+shift+L 被压成 0x0c 时命中", () => {
  assert.equal(matchesExitInput("\x0c", EXIT_KEYS), true)
})

test("退出快捷键：Kitty 与 modifyOtherKeys 的精确修饰位", () => {
  assert.equal(matchesExitInput("\x1b[108;6u", EXIT_KEYS), true) // ctrl+shift+l
  assert.equal(matchesExitInput("\x1b[27;6;108~", EXIT_KEYS), true)
  assert.equal(matchesExitInput("\x1b[108;5u", EXIT_KEYS), false, "ctrl+l 单独不算（非传统编码路径）")
  assert.equal(matchesExitInput("\x1b[108;2u", EXIT_KEYS), false, "shift+l 不算")
})

test("退出快捷键：其它常见键位写法也能匹配", () => {
  assert.equal(matchesExitInput("\x1b[27;5;120~", ["ctrl+x"]), true) // ctrl+x
  assert.equal(matchesExitInput("\x18", ["ctrl+x"]), true) // 传统 ctrl+x
  assert.equal(matchesExitInput("\x1bx", ["alt+x"]), true) // 传统 alt+x
  assert.equal(matchesExitInput("X", ["shift+x"]), true) // 传统 shift+x
  assert.equal(matchesExitInput("l", EXIT_KEYS), false)
})

test("普通输入不会误判为退出快捷键", () => {
  for (const data of ["l", "L", "\x1b", "\r", "hello", "\x1b[108;2u"]) {
    assert.equal(matchesExitInput(data, EXIT_KEYS), false, `expected ${JSON.stringify(data)} not to exit`)
  }
})

test("修饰序列解析：缺少修饰位时视作无修饰", () => {
  assert.deepEqual(parseModifierKeySequence("\x1b[108u"), { code: 108, mods: 1 })
  assert.deepEqual(parseModifierKeySequence("\x1b[108;6u"), { code: 108, mods: 6 })
  assert.deepEqual(parseModifierKeySequence("\x1b[27;6;108~"), { code: 108, mods: 6 })
  assert.equal(parseModifierKeySequence("\x1b[A"), undefined)
})
