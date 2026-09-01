import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SYSTEM_TERMINAL_CJK_FALLBACK,
  WINDOWS_TERMINAL_CJK_FALLBACK,
  withCjkFallback
} from '../src/lib/terminalFont.ts'

/** 设置面板里的全部终端字体预设(SettingsSidebar.vue 的 option value)。 */
const SETTINGS_PRESETS = [
  '"Cascadia Mono", "Cascadia Code", "JetBrains Mono", Consolas, monospace',
  'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  'Cascadia Mono, Cascadia Code, Consolas, monospace',
  'Consolas, Lucida Console, monospace',
  'JetBrains Mono, Consolas, monospace',
  'Fira Code, Consolas, monospace',
  'Menlo, Monaco, Consolas, monospace'
]

const familyList = (value) => value.split(',').map((segment) => segment.trim())

test('每个预设都拿到 CJK 兜底,且兜底排在 generic 关键字之前', () => {
  for (const preset of SETTINGS_PRESETS) {
    const result = withCjkFallback(preset, WINDOWS_TERMINAL_CJK_FALLBACK)
    const families = familyList(result)

    assert.equal(
      families[families.length - 1],
      'monospace',
      `generic 关键字必须留在末位,否则 CSS 失去最终兜底: ${result}`
    )
    for (const fallback of WINDOWS_TERMINAL_CJK_FALLBACK) {
      const at = families.indexOf(`"${fallback}"`)
      assert.ok(at >= 0, `${fallback} 未插入: ${result}`)
      assert.ok(
        at < families.length - 1,
        `${fallback} 排在 generic 关键字之后就永远轮不到: ${result}`
      )
    }
  }
})

test('原有 Latin 字体的相对顺序不变', () => {
  const result = withCjkFallback(SETTINGS_PRESETS[0], WINDOWS_TERMINAL_CJK_FALLBACK)
  assert.match(
    result,
    /^"Cascadia Mono", "Cascadia Code", "JetBrains Mono", Consolas, /,
    `Latin 段必须原样保留在最前,否则等宽列对齐会变: ${result}`
  )
})

test('重复调用稳定,不会越加越长', () => {
  const once = withCjkFallback(SETTINGS_PRESETS[1], WINDOWS_TERMINAL_CJK_FALLBACK)
  assert.equal(withCjkFallback(once, WINDOWS_TERMINAL_CJK_FALLBACK), once)
})

test('已列出的族名不重复插入,大小写不敏感', () => {
  const result = withCjkFallback('Consolas, "microsoft yahei ui", monospace', WINDOWS_TERMINAL_CJK_FALLBACK)
  assert.equal(familyList(result).filter((f) => /yahei/i.test(f)).length, 1)
  assert.ok(result.includes('"Noto Sans SC Variable"'))
})

test('末尾不是 generic 关键字时直接追加', () => {
  assert.equal(
    withCjkFallback('Consolas', ['PingFang SC']),
    'Consolas, "PingFang SC"'
  )
})

test('空输入原样返回', () => {
  assert.equal(withCjkFallback('', WINDOWS_TERMINAL_CJK_FALLBACK), '')
  assert.equal(withCjkFallback('   ', WINDOWS_TERMINAL_CJK_FALLBACK), '   ')
})

test('含空格的族名带引号,纯 ASCII 标识符保持原样', () => {
  const result = withCjkFallback('Consolas, monospace', ['PingFang SC'])
  assert.equal(result, 'Consolas, "PingFang SC", monospace')
})

test('macOS 兜底为 PingFang SC', () => {
  const result = withCjkFallback(SETTINGS_PRESETS[1], SYSTEM_TERMINAL_CJK_FALLBACK)
  assert.equal(result, 'ui-monospace, SFMono-Regular, Menlo, Consolas, "PingFang SC", monospace')
})

test('各 generic 关键字都被识别为末位兜底', () => {
  for (const generic of ['monospace', 'sans-serif', 'serif', 'system-ui', 'ui-monospace']) {
    const result = withCjkFallback(`Consolas, ${generic}`, ['PingFang SC'])
    assert.equal(result, `Consolas, "PingFang SC", ${generic}`)
  }
})
