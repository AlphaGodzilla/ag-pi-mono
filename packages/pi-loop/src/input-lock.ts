/**
 * 输入锁定：loop 运行期间，人向输入框提交的文本必须在进入编辑器之前被吞掉。
 *
 * 判断只看**按键本身**，不看编辑器状态，因此可以安全地用作 `ui.onTerminalInput` 的前置过滤器：
 *   - 可打印字符、粘贴内容、Enter → 视为人类输入，吞掉；
 *   - Esc（中断）、Ctrl+C / Ctrl+D（应用级按键）以及鼠标、方向键等控制序列 → 放行，
 *     pi 的默认编辑器继续按原语义处理。
 *
 * 退出快捷键同时按两种编码匹配：
 *   - Kitty / modifyOtherKeys 序列（`\x1b[108;6u`、`\x1b[27;6;108~`）；
 *   - 传统终端把 ctrl+shift+<字母> 压成与 ctrl+<字母> 相同的控制字节（`\x0c`），
 *     这种模糊性无法区分，因此按 ctrl+<字母> 也视为命中（并在 README 中写明）。
 */

const CTRL = 4
const ALT = 2
const SHIFT = 1
const SUPER = 8

interface ParsedKeyId {
  key: string
  ctrl: boolean
  shift: boolean
  alt: boolean
  super: boolean
}

function parseKeyId(keyId: string): ParsedKeyId | undefined {
  const parts = keyId.trim().toLowerCase().split("+")
  const key = parts[parts.length - 1]
  if (!key) return undefined
  return {
    key,
    ctrl: parts.includes("ctrl"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt"),
    super: parts.includes("super"),
  }
}

/** Kitty CSI-u 与 xterm modifyOtherKeys 的解析结果。`mods` 用「1 + 位掩码」编码。 */
export interface ModifierKeySequence {
  code: number
  mods: number
  text?: string
}

export function parseModifierKeySequence(data: string): ModifierKeySequence | undefined {
  const csiU = /^\x1b\[(\d+)(?:;(\d+))?(?:;([^u]*))?u$/.exec(data)
  if (csiU) {
    return {
      code: Number(csiU[1]),
      // kitty 可以把修饰位写成空串（`\x1b[97;;97u`），视作「无修饰」
      mods: csiU[2] ? Number(csiU[2]) : 1,
      ...(csiU[3] ? { text: csiU[3] } : {}),
    }
  }
  const modifyOtherKeys = /^\x1b\[27;(\d+);(\d+)(?:;([^~]*))?~$/.exec(data)
  if (modifyOtherKeys) {
    return {
      code: Number(modifyOtherKeys[2]),
      mods: Number(modifyOtherKeys[1]),
      ...(modifyOtherKeys[3] ? { text: modifyOtherKeys[3] } : {}),
    }
  }
  return undefined
}

/** ctrl+<字母> 在传统终端里发出的单字节控制字符。 */
function legacyControlByte(key: string): string | undefined {
  if (key.length !== 1) return undefined
  const code = key.charCodeAt(0)
  if (code >= 97 && code <= 122) return String.fromCharCode(code - 96)
  return undefined
}

function keyCodepoint(key: string): number | undefined {
  if (key.length !== 1) return undefined
  return key.charCodeAt(0)
}

function modifierBits(parsed: ParsedKeyId): number {
  return (
    (parsed.shift ? SHIFT : 0) | (parsed.alt ? ALT : 0) | (parsed.ctrl ? CTRL : 0) | (parsed.super ? SUPER : 0)
  )
}

function isPrintableCodepoint(code: number): boolean {
  return code >= 0x20 && code !== 0x7f
}

/** 当前按键是否是用户按下的「退出 loop」快捷键。 */
export function matchesExitInput(data: string, exitKeys: readonly string[]): boolean {
  if (!data) return false
  const sequence = parseModifierKeySequence(data)

  for (const keyId of exitKeys) {
    const parsed = parseKeyId(keyId)
    if (!parsed) continue
    const codepoint = keyCodepoint(parsed.key)

    // 1. 传统终端的控制字节（ctrl+letter，含无法区分的 ctrl+shift+letter）
    if (parsed.ctrl) {
      const raw = legacyControlByte(parsed.key)
      if (raw !== undefined && data === raw) return true
    }

    // 2. Kitty / modifyOtherKeys（精确匹配修饰位）
    if (sequence && codepoint !== undefined && sequence.code === codepoint) {
      const expected = modifierBits(parsed) + 1
      if (sequence.mods === expected) return true
    }

    // 3. 传统终端的 alt+key（ESC 前缀）与 shift+letter（大写字符）
    if (parsed.alt && !parsed.ctrl && codepoint !== undefined && data === `\x1b${parsed.key}`) return true
    if (parsed.shift && !parsed.ctrl && !parsed.alt && codepoint !== undefined && data === parsed.key.toUpperCase()) {
      return true
    }
  }
  return false
}

/**
 * 该按键是否会往编辑器里写内容（人类输入）。true 表示应当吞掉。
 *
 * Enter 也算：锁输入期间接受空提交没有意义，只会制造空轮次。
 */
export function isTextualInput(data: string): boolean {
  if (!data) return false
  if (data === "\r" || data === "\n") return true

  // 括号粘贴：整段内容都是人类输入（粘贴块本身带 ESC 前缀）
  if (data.includes("\x1b[200~")) return true

  if (!data.includes("\x1b")) {
    for (const ch of data) {
      const code = ch.codePointAt(0) ?? 0
      if (code < 0x20 || code === 0x7f) return false
    }
    return true
  }

  // Kitty 的 CSI-u / modifyOtherKeys 也可能承载普通可打印字符
  const sequence = parseModifierKeySequence(data)
  if (!sequence) return false
  if (sequence.text) return true
  const mods = sequence.mods - 1
  if ((mods & (CTRL | ALT | SUPER)) !== 0) return false
  return isPrintableCodepoint(sequence.code)
}
