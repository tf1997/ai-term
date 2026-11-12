// Shared by the CDP test and the Ubuntu WebKitGTK smoke runner.
export async function runTerminalFontChecks() {
  const assert = (condition, message) => { if (!condition) throw new Error(message) }
  const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  async function until(predicate) {
    const deadline = Date.now() + 15000
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${predicate}`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    await frames()
  }
  const panes = () => [...document.querySelectorAll('.terminal-pane')].map(element => element.__vueParentComponent.setupState)
  await until(() => panes()[0]?.terminal)
  const app = document.querySelector('.app-shell').__vueParentComponent.setupState
  const first = panes()[0].terminal
  assert(navigator.platform.toLowerCase().includes('linux'), 'Exercise Linux platform defaults')
  assert(first.options.fontFamily.startsWith('JetBrains Mono'), 'Ubuntu defaults to bundled monospace')
  assert(first.options.fontFamily.indexOf('JetBrains Mono') < first.options.fontFamily.indexOf('Noto Sans'), 'Latin monospace precedes CJK fallback')

  function metrics(terminal) {
    const canvas = document.createElement('canvas')
    canvas.width = 260; canvas.height = 40
    const ctx = canvas.getContext('2d')
    ctx.font = `normal ${terminal.options.fontSize}px ${terminal.options.fontFamily}`
    ctx.fillText('Wim0O1Il{} 汉字', 0, 25)
    let hash = 0
    for (const pixel of ctx.getImageData(0, 0, 260, 40).data) hash = ((hash * 31) + pixel) | 0
    const cell = terminal._core._renderService.dimensions.css.cell
    return { family: terminal.options.fontFamily, size: terminal.options.fontSize, cellWidth: cell.width, cellHeight: cell.height, cols: terminal.cols, w: ctx.measureText('W').width, i: ctx.measureText('i').width, hash }
  }
  const original = metrics(first)
  document.querySelector('.terminal-new-tab').click()
  await until(() => panes().length === 2 && panes().every(pane => pane.terminal))
  const terminals = panes().map(pane => pane.terminal)
  document.querySelector('button[title="打开设置中心"]').click()
  await until(() => document.querySelector('.settings-tab[aria-label="终端外观"]'))
  document.querySelector('.settings-tab[aria-label="终端外观"]').click()
  await until(() => document.querySelector('select[aria-label="选择终端字体"]'))
  const select = document.querySelector('select[aria-label="选择终端字体"]')
  const choose = value => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) }
  assert(select.options.length === 3, 'Linux offers two bundled faces and the system monospace stack')
  choose('Fira Code, Consolas, monospace')
  await until(() => terminals.every(terminal => terminal.options.fontFamily.startsWith('Fira Code')))
  const fira = metrics(terminals[1])
  assert(original.hash !== fira.hash, 'Switching faces changes the rendered glyphs, not just the option string')
  assert([...document.fonts].some(face => face.family.replaceAll('"', '') === 'Fira Code' && face.status === 'loaded'), 'Fira Code asset is loaded')
  assert(Math.abs(fira.w - fira.i) < .05, 'Latin characters remain monospaced')
  assert(Math.abs(fira.cellWidth - fira.w) <= 1, 'Grid width tracks the loaded font without large letter spacing')
  assert(fira.cellWidth / fira.size < .75, 'Latin cells are not widened by a proportional/CJK fallback')
  assert(fira.cellHeight / fira.size <= 1.4, 'Linux line spacing stays compact with the bundled font metrics')
  assert(JSON.parse(localStorage.getItem('ai-term:user-settings:v1')).terminalFontFamily.startsWith('Fira Code'), 'Font choice is saved immediately')

  const size = document.querySelector('.terminal-settings-panel input[type="number"]')
  size.value = '18'; size.dispatchEvent(new Event('input', { bubbles: true })); size.dispatchEvent(new Event('change', { bubbles: true }))
  await until(() => terminals.every(terminal => terminal.options.fontSize === 18))
  const larger = metrics(terminals[1])
  assert(larger.cellWidth > fira.cellWidth && larger.cols < fira.cols, 'Changing size remeasures and refits the grid')
  assert(panes()[0].terminal === first, 'Font changes preserve the original terminal instance')

  choose('"Ubuntu Mono", "DejaVu Sans Mono", "Liberation Mono", monospace')
  await until(() => terminals.every(terminal => terminal.options.fontFamily.startsWith('"Ubuntu Mono"')))
  const system = metrics(terminals[1])
  assert(Math.abs(system.w - system.i) < .05, 'System font option also uses monospace Latin glyphs')
  choose('JetBrains Mono, Consolas, monospace')
  await until(() => terminals.every(terminal => terminal.options.fontFamily.startsWith('JetBrains Mono')))

  // A slow earlier choice must not overwrite a later selection or touch a disposed tab.
  const originalLoad = document.fonts.load.bind(document.fonts), releases = []
  document.fonts.load = (font, sample) => font.includes('Fira Code')
    ? new Promise(resolve => releases.push(() => resolve(originalLoad(font, sample))))
    : originalLoad(font, sample)
  try {
    choose('Fira Code, Consolas, monospace')
    await until(() => releases.length >= 4)
    choose('JetBrains Mono, Consolas, monospace')
    document.querySelector('.session-tab-strip .tab:not(.active) .tab-close').click()
    await until(() => panes().length === 1)
    for (const release of releases) release()
    await frames(); await new Promise(resolve => setTimeout(resolve, 100))
    assert(panes()[0].terminal.options.fontFamily.startsWith('JetBrains Mono'), 'Latest choice wins after delayed font loads')
  } finally { document.fonts.load = originalLoad }

  const remaining = panes()[0].terminal
  app.updateUserSettings({ ...app.appSettings, terminalFontFamily: 'Missing-Ubuntu-Font, monospace', terminalFontSize: 13 })
  await until(() => remaining.options.fontFamily.startsWith('Missing-Ubuntu-Font') && remaining.options.fontSize === 13)
  const missing = metrics(remaining)
  assert(missing.hash === original.hash, 'Missing local faces fall back to the bundled font, including its glyph shape')
  app.updateUserSettings({ ...app.appSettings, terminalFontFamily: 'JetBrains Mono, Consolas, monospace' })
  await until(() => remaining.options.fontFamily.startsWith('JetBrains Mono'))
  await new Promise(resolve => remaining.write('\r\nWWWW iiii 0000 终端字体测试\r\nfont-size: 13px | letter-spacing: 0\r\n', resolve))
  return { platform: navigator.platform, userAgent: navigator.userAgent, original, fira, larger, system, missing, checks: ['immediate apply and persistence', 'loaded font glyphs differ', 'monospace metrics and compact spacing', 'size refit', 'background tabs', 'system fonts', 'latest selection wins', 'unmount during font load', 'missing font fallback'] }
}
