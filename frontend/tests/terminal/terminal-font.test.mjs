import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SYSTEM_TERMINAL_CJK_FALLBACK,
  WINDOWS_TERMINAL_CJK_FALLBACK,
  resolveTerminalFontFamily,
  withCjkFallback
} from "../../src/domains/terminal/domain/terminalFont"
import { loadTerminalFonts } from '../../src/domains/terminal/application/terminalFontLoading'

test('Linux 缺失的桌面字体先回落内置等宽字体，避免 CJK 的比例 Latin 字形撑宽单元格', () => {
  for (const preset of [...SETTINGS_PRESETS, 'monospace', '"Missing Font", ui-monospace']) {
    const result = familyList(resolveTerminalFontFamily(preset, 'linux'))
    const mono = result.findIndex(name => /jetbrains mono/i.test(name))
    const cjk = result.indexOf('"Noto Sans SC Variable"')
    assert.ok(mono >= 0 && mono < cjk)
    assert.equal(result.at(-1), 'monospace')
    assert.equal(result.includes('ui-monospace'), false)
    assert.equal(result.filter(name => /jetbrains mono/i.test(name)).length, 1)
  }
})

test('Linux 保留指定等宽字体优先级，macOS 和 Windows 的字体策略保持兼容', () => {
  assert.match(resolveTerminalFontFamily('Fira Code, monospace', 'linux'), /^Fira Code, "JetBrains Mono",/)
  assert.match(resolveTerminalFontFamily('"Ubuntu Mono", "DejaVu Sans Mono", monospace', 'linux'), /^"Ubuntu Mono", "DejaVu Sans Mono", "JetBrains Mono",/)
  for (const preset of SETTINGS_PRESETS) {
    assert.equal(resolveTerminalFontFamily(preset, 'windows'), withCjkFallback(preset, WINDOWS_TERMINAL_CJK_FALLBACK))
    assert.equal(resolveTerminalFontFamily(preset, 'macos'), withCjkFallback(preset, SYSTEM_TERMINAL_CJK_FALLBACK))
  }
})

test('字体加载等到普通与粗体就绪，不会只等待此前已经完成的 fonts.ready', async () => {
  const calls = [], releases = []
  const fonts = { load(font, sample) { calls.push({ font, sample }); return new Promise(resolve => releases.push(resolve)) } }
  let ready = false
  const loading = loadTerminalFonts('"Fira Code", monospace', 15, ['normal', 'bold', 'normal'], fonts).then(() => { ready = true })
  assert.deepEqual(calls.map(call => call.font), ['normal 15px "Fira Code", monospace', 'bold 15px "Fira Code", monospace'])
  assert.ok(calls.every(call => call.sample.includes('W') && call.sample.includes('汉')))
  releases[0]([])
  await Promise.resolve()
  assert.equal(ready, false)
  releases[1]([])
  await loading
  assert.equal(ready, true)
})

test('字体资源失败仍允许终端通过后备字体打开', async () => {
  await loadTerminalFonts('Missing, monospace', 13, ['normal'], { load: async () => { throw new Error('font unavailable') } })
})

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
