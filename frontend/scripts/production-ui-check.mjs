import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8').replace(/\r\n?/g, '\n')
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

const appShell = read('src/components/AppShell.vue')
const main = read('src/main.ts')
const terminalPane = read('src/components/TerminalPane.vue')
const aiPanel = read('src/components/AiPanel.vue')
const aiMarkdownMessage = read('src/components/AiMarkdownMessage.vue')
const aiMarkdown = read('src/lib/aiMarkdown.ts')
const shellCommand = read('src/lib/shellCommand.ts')
const aiConfig = read('src/components/AiConfigPanel.vue')
const fileTransfer = read('src/components/FileTransferPanel.vue')
const scriptPanel = read('src/components/ScriptPanel.vue')
const scriptExecution = read('src/lib/scriptExecution.ts')
const scriptRisk = read('src/lib/scriptRisk.ts')
const scriptReadiness = read('src/lib/scriptReadiness.ts')
const sidebar = read('src/components/ConnectionSidebar.vue')
const settingsSidebar = read('src/components/SettingsSidebar.vue')
const tauri = read('src/lib/tauri.ts')
const workspacePanel = read('src/components/WorkspacePanel.vue')
const workspaceTypes = read('src/types/workspace.ts')
const commandHistoryPanel = read('src/components/CommandHistoryPanel.vue')
const uiIcon = read('src/components/UiIcon.vue')
const contextMenu = read('src/components/ContextMenu.vue')
const styles = read('src/styles.css')
const indexHtml = read('index.html')
const tauriConfig = read('../src-tauri/tauri.conf.json')
const sqlite = read('../src-tauri/src/domain/storage/sqlite.rs')
const schema = read('../src-tauri/src/domain/storage/schema.sql')
const aiChat = read('../src-tauri/src/domain/ai/chat.rs')
const sftpBackend = read('../src-tauri/src/domain/connection/sftp.rs')
const sshBackend = read('../src-tauri/src/domain/terminal/ssh.rs')
const localFilesystem = read('../src-tauri/src/domain/filesystem/local.rs')
const commands = read('../src-tauri/src/app/commands.rs')
const credentials = read('../src-tauri/src/domain/auth/credentials.rs')
const tauriLib = read('../src-tauri/src/lib.rs')

assert(
  styles.includes('--font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC"') &&
    styles.includes('--font-sans: "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Noto Sans SC"') &&
    styles.includes('font-synthesis: none;') &&
    styles.includes('font-kerning: normal;') &&
    !styles.includes('letter-spacing: -.005em;') &&
    !/font-weight:\s*(?:650|700|720|750|760|800);/.test(styles) &&
    !/font-size:\s*(?:9(?:\.5)?|10\.5|11\.5|12\.5)px;/.test(styles) &&
    main.includes("import('@fontsource/jetbrains-mono/600.css')") &&
    terminalPane.includes('lineHeight: 1.12') &&
    terminalPane.includes("fontWeight: '400' as const") &&
    terminalPane.includes("fontWeightBold: '600' as const"),
  'macOS must keep native typography while Windows uses native UI fonts, real bundled terminal weights, and integer type metrics.'
)

assert(
  uiIcon.includes("| 'info'") &&
    uiIcon.includes("name === 'info'") &&
    appShell.includes('title="&#20851;&#20110; AI Term"') &&
    appShell.includes('aria-label="&#20851;&#20110; AI Term"') &&
    appShell.includes('<UiIcon name="info" />') &&
    !/title="(?:&#20851;&#20110;|关于|鍏充簬) AI Term"[\s\S]*?<UiIcon name="ai" \/>/.test(appShell),
  'About rail button must use a dedicated info icon instead of reusing the AI icon.'
)
assert(
  styles.includes('[role="button"],') &&
    styles.includes('.terminal-target-summary,') &&
    styles.includes('-webkit-user-select: none;') &&
    styles.includes('user-select: none;') &&
    styles.includes('input,') &&
    styles.includes('textarea,') &&
    styles.includes('pre,') &&
    styles.includes('code,') &&
    styles.includes('.xterm-host *') &&
    styles.includes('.message-body *') &&
    styles.includes('user-select: text;') &&
    appShell.includes('themeToggleButton') &&
    appShell.includes('handleThemeTogglePointerDown') &&
    appShell.includes("addEventListener('pointerdown', handleThemeTogglePointerDown, true)") &&
    appShell.includes("addEventListener('mousedown', handleThemeTogglePointerDown, true)") &&
    appShell.includes("addEventListener('click', handleThemeTogglePointerDown, true)") &&
    appShell.includes('lastThemeToggleAt') &&
    appShell.includes('stopImmediatePropagation') &&
    appShell.includes('selectableTextSelector') &&
    appShell.includes('handleAppSelectStart') &&
    appShell.includes("document.addEventListener('selectstart', handleAppSelectStart, true)") &&
    appShell.includes("document.removeEventListener('selectstart', handleAppSelectStart, true)") &&
    appShell.includes('handleAppDragStart') &&
    appShell.includes("document.addEventListener('dragstart', handleAppDragStart, true)") &&
    appShell.includes('clearChromeSelection(target?: EventTarget | null)') &&
    appShell.includes('selectionEndpointElement') &&
    appShell.includes('clearChromeSelection(event.target)'),
  'Interactive chrome must prevent accidental drag text selection while terminal, code, and form text remain selectable.'
)

function cssRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = styles.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`))
  return match?.[1] ?? ''
}

function assertCssRuleIncludes(selector, snippets, message) {
  const rule = cssRule(selector)
  assert(snippets.every((snippet) => rule.includes(snippet)), message)
}

function cssDeclarationBlocks(selector, options = {}) {
  const start = options.afterMarker ? styles.indexOf(options.afterMarker) : 0
  assert(start !== -1, `Missing CSS marker: ${options.afterMarker}`)
  const end = options.beforeMarker ? styles.indexOf(options.beforeMarker, start + 1) : styles.length
  assert(end !== -1, `Missing CSS marker: ${options.beforeMarker}`)
  const source = styles.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '')
  const blocks = []
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const rawSelector = match[1].replace(/\s+/g, ' ').trim()
    if (rawSelector.includes('@media')) continue
    if (options.excludeThemeLight && rawSelector.includes('theme-light')) continue
    const selectors = rawSelector.split(',').map((item) => item.trim())
    if (!selectors.includes(selector)) continue
    const declarations = new Map()
    for (const declaration of match[2].split(';')) {
      const separator = declaration.indexOf(':')
      if (separator === -1) continue
      declarations.set(declaration.slice(0, separator).trim(), declaration.slice(separator + 1).trim())
    }
    blocks.push(declarations)
  }
  return blocks
}

function lastCssDeclaration(selector, property, options = {}) {
  let value = undefined
  for (const declarations of cssDeclarationBlocks(selector, options)) {
    if (declarations.has(property)) value = declarations.get(property)
  }
  return value
}

function assertLastCssDeclarations(selector, expected, message, options = {}) {
  for (const [property, value] of Object.entries(expected)) {
    const actual = lastCssDeclaration(selector, property, options)
    assert(
      actual === value,
      `${message}: expected ${selector} ${property}: ${value}, got ${actual}`
    )
  }
}



const layoutParityProperties = [
  'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'margin-inline', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'padding-inline', 'padding-block',
  'gap', 'row-gap', 'column-gap', 'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row', 'align-items', 'align-self', 'justify-content', 'justify-items', 'place-items',
  'flex', 'flex-direction', 'flex-wrap', 'order', 'overflow', 'overflow-x', 'overflow-y', 'transform', 'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-radius', 'box-shadow',
  'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform',
]

function normalizeLayoutParityValue(property, value) {
  if (!value) return value
  if (!property.startsWith('border')) return value
  return value
    .replace(/#[0-9a-fA-F]{3,8}\b/g, '<color>')
    .replace(/rgba?\([^)]*\)/g, '<color>')
    .replace(/hsla?\([^)]*\)/g, '<color>')
    .replace(/var\(--[\w-]+\)/g, '<color>')
    .replace(/\b(?:transparent|currentColor|black|white|red|green|blue)\b/g, '<color>')
    .replace(/\s+/g, ' ')
    .trim()
}

function assertLightThemeLayoutParity(pairs, options = {}) {
  const allowed = new Set(options.allowedDifferences ?? [])
  const properties = options.properties ?? layoutParityProperties
  const mismatches = []

  for (const [baseSelector, lightSelector] of pairs) {
    for (const property of properties) {
      const light = lastCssDeclaration(lightSelector, property)
      if (light === undefined) continue

      const base = lastCssDeclaration(baseSelector, property, { excludeThemeLight: true })
      if (base === undefined) continue

      const key = baseSelector + ' -> ' + lightSelector + ' -> ' + property
      if (allowed.has(key)) continue

      if (normalizeLayoutParityValue(property, base) !== normalizeLayoutParityValue(property, light)) {
        mismatches.push(key + ': base=' + base + ', light=' + light)
      }
    }
  }

  assert(
    mismatches.length === 0,
    'Light theme layout must match the dark-theme structure for key shell/workspace surfaces: ' + mismatches.join('; ')
  )
}

function lightThemeCustomProperties() {
  const variables = new Map()
  for (const declarations of cssDeclarationBlocks('.app-shell.theme-light')) {
    for (const [property, value] of declarations.entries()) {
      if (property.startsWith('--light-')) variables.set(property, value)
    }
  }
  return variables
}

function resolveCssColor(value, variables, seen = new Set()) {
  const trimmed = value.trim()
  const variable = trimmed.match(/^var\((--[\w-]+)(?:,\s*([^)]+))?\)$/)
  if (!variable) return trimmed

  const [, name, fallback] = variable
  assert(!seen.has(name), `CSS color variable cycle detected: ${name}`)
  if (variables.has(name)) {
    seen.add(name)
    const resolved = resolveCssColor(variables.get(name), variables, seen)
    seen.delete(name)
    return resolved
  }
  assert(fallback, `Missing CSS color variable: ${name}`)
  return resolveCssColor(fallback, variables, seen)
}

function parseCssColor(value, variables = new Map()) {
  const color = resolveCssColor(value, variables).toLowerCase()
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/)
  if (hex) {
    const raw = hex[1].length === 3
      ? hex[1].split('').map((part) => part + part).join('')
      : hex[1]
    return {
      r: Number.parseInt(raw.slice(0, 2), 16),
      g: Number.parseInt(raw.slice(2, 4), 16),
      b: Number.parseInt(raw.slice(4, 6), 16),
    }
  }

  const rgb = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*(?:[\d.]+))?\)$/)
  if (rgb) {
    return {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
    }
  }

  throw new Error(`Unsupported CSS color format in UI check: ${value}`)
}

function relativeLuminance({ r, g, b }) {
  return [r, g, b]
    .map((channel) => {
      const normalized = channel / 255
      return normalized <= 0.03928
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4
    })
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
}

function contrastRatio(foreground, background, variables = new Map()) {
  const foregroundLuminance = relativeLuminance(parseCssColor(foreground, variables))
  const backgroundLuminance = relativeLuminance(parseCssColor(background, variables))
  const lighter = Math.max(foregroundLuminance, backgroundLuminance)
  const darker = Math.min(foregroundLuminance, backgroundLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

function assertContrast(foreground, background, minimum, message, variables = new Map()) {
  const ratio = contrastRatio(foreground, background, variables)
  assert(
    ratio >= minimum,
    `${message}: expected ${minimum}:1, got ${ratio.toFixed(2)}:1 for ${foreground} on ${background}`
  )
}
function earlyLightThemeStructuralDeclarations() {
  const cutoff = styles.indexOf('/* Light theme layout parity. */')
  assert(cutoff !== -1, 'Light theme layout parity marker must exist')
  const structural = new Set([
    'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'margin-inline', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'padding-inline', 'padding-block',
    'gap', 'row-gap', 'column-gap', 'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row', 'align-items', 'align-self', 'justify-content', 'justify-items', 'place-items',
    'flex', 'flex-direction', 'flex-wrap', 'order', 'overflow', 'overflow-x', 'overflow-y', 'transform', 'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-radius', 'box-shadow', 'backdrop-filter', 'transition', 'content',
    'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform',
  ])
  const hits = []
  for (const match of styles.slice(0, cutoff).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim()
    if (!selector.includes('theme-light')) continue
    for (const declaration of match[2].split(';')) {
      const separator = declaration.indexOf(':')
      if (separator === -1) continue
      const property = declaration.slice(0, separator).trim()
      if (structural.has(property)) hits.push(selector + ' -> ' + property)
    }
  }
  return hits
}

function disallowedDeclarationsInRange(afterMarker, beforeMarker, allowedProperties) {
  const start = styles.indexOf(afterMarker)
  assert(start !== -1, `Missing CSS marker: ${afterMarker}`)
  const end = beforeMarker ? styles.indexOf(beforeMarker, start + 1) : styles.length
  assert(end !== -1, `Missing CSS marker: ${beforeMarker}`)
  const source = styles.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '')
  const hits = []
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].replace(/\s+/g, ' ').trim()
    if (selector.includes('@media')) continue
    for (const declaration of match[2].split(';')) {
      const separator = declaration.indexOf(':')
      if (separator === -1) continue
      const property = declaration.slice(0, separator).trim()
      if (!allowedProperties.has(property)) hits.push(selector + " -> " + property)
    }
  }
  return hits
}

function darkLightThemeSurfaceDeclarations() {
  const hits = []
  const isDarkSurfaceColor = (value) => {
    const hex = value.match(/#([0-9a-fA-F]{3,8})\b/)
    if (hex) {
      const raw = hex[1].length === 3
        ? hex[1].split('').map((part) => part + part).join('')
        : hex[1]
      const r = Number.parseInt(raw.slice(0, 2), 16)
      const g = Number.parseInt(raw.slice(2, 4), 16)
      const b = Number.parseInt(raw.slice(4, 6), 16)
      return r < 45 && g < 45 && b < 55
    }

    const rgb = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/)
    if (!rgb) return false
    const alpha = rgb[4] === undefined ? 1 : Number(rgb[4])
    return Number(rgb[1]) < 45 && Number(rgb[2]) < 45 && Number(rgb[3]) < 55 && alpha > 0.35
  }

  for (const match of styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim()
    if (!selector.includes('theme-light')) continue
    for (const declaration of match[2].split(';')) {
      const separator = declaration.indexOf(':')
      if (separator === -1) continue
      const property = declaration.slice(0, separator).trim()
      const value = declaration.slice(separator + 1).trim()
      if (!/^background(?:-|$)|^border/.test(property)) continue
      if (isDarkSurfaceColor(value)) hits.push(selector + ' -> ' + property + ': ' + value)
    }
  }

  return hits
}

function assertStylesMarkersInOrder(markers, message) {
  let previousIndex = -1
  for (const marker of markers) {
    const index = styles.indexOf(marker)
    assert(index !== -1, `${message}: missing ${marker}`)
    assert(index > previousIndex, `${message}: ${marker} is out of order`)
    previousIndex = index
  }
}

function staticComponentClasses() {
  const classes = new Set()
  const sources = [
    appShell,
    terminalPane,
    aiPanel,
    aiConfig,
    fileTransfer,
    scriptPanel,
    sidebar,
    settingsSidebar,
    workspacePanel,
    commandHistoryPanel,
    contextMenu,
  ]
  for (const source of sources) {
    for (const match of source.matchAll(/class="([^"]+)"/g)) {
      for (const token of match[1].split(/\s+/)) {
        if (token && !/[{}()[\]:]/.test(token)) {
          classes.add(token)
        }
      }
    }
  }
  return classes
}

function darkSurfaceStaticClassesMissingLightCover() {
  const usedClasses = staticComponentClasses()
  const lightCoveredClasses = new Set()
  for (const match of styles.matchAll(/([^{}]*theme-light[^{}]*)\{[^{}]*\}/g)) {
    for (const classMatch of match[1].matchAll(/\.([a-zA-Z0-9_-]+)/g)) {
      lightCoveredClasses.add(classMatch[1])
    }
  }

  const darkSurfaceDeclaration = /(?:background|border(?:-[a-z]+)?|color)\s*:\s*[^;]*(?:#0[0-9a-fA-F]|#1[0-9a-fA-F]|#2[0-9a-fA-F]|#e[0-9a-fA-F]|#f[0-9a-fA-F]|rgba\((?:0|1\d|2\d|3\d),|rgba\((?:2[0-5]{2}|24\d|23\d),)/
  const missing = new Set()
  for (const match of styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].replace(/\s+/g, ' ').trim()
    const body = match[2]
    if (/theme-light|@media|:root|body|button|input|textarea|select/.test(selector)) {
      continue
    }
    if (!darkSurfaceDeclaration.test(body)) {
      continue
    }
    for (const classMatch of selector.matchAll(/\.([a-zA-Z0-9_-]+)/g)) {
      const className = classMatch[1]
      if (usedClasses.has(className) && !lightCoveredClasses.has(className)) {
        missing.add(className)
      }
    }
  }
  return [...missing].sort()
}

const missingStaticLightCovers = darkSurfaceStaticClassesMissingLightCover()
assert(
  missingStaticLightCovers.length === 0,
  `Static component classes with dark surface styles must have light theme coverage: ${missingStaticLightCovers.join(', ')}`
)

assertStylesMarkersInOrder(
  [
    '/* Application light theme. */',
    '/* Design-taste light theme refinement. */',
    '/* Rail parity and SFTP directory polish. */',
    '/* Workspace separation polish. */',
    '/* Light theme surface hardening. */',
    '/* Light theme layout parity. */',
    '/* Light theme dark-surface cleanup. */',
    '/* Light theme state surface cleanup. */',
    '/* Light theme status indicator cleanup. */',
    '/* Command history preview modal. */',
    '/* Light theme shell structure parity contract. */',
    '/* Light theme color-only surface contract. */',
  ],
  'Light theme final override layers must stay after earlier decorative theme layers'
)

const earlyLightThemeStructure = earlyLightThemeStructuralDeclarations()
assert(
  earlyLightThemeStructure.length === 0,
  'Light theme rules before the layout parity layer must only recolor existing structure: ' + earlyLightThemeStructure.join(', ')
)

const surfaceContractAllowedProperties = new Set([
  'border-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'background', 'background-color', 'color', 'caret-color', 'outline-color',
])
const surfaceContractDisallowed = disallowedDeclarationsInRange(
  '/* Light theme color-only surface contract. */',
  '/* End light theme color-only surface contract. */',
  surfaceContractAllowedProperties,
)
assert(
  surfaceContractDisallowed.length === 0,
  'Light theme color-only surface contract must not change layout or geometry: ' + surfaceContractDisallowed.join(', ')
)

const darkLightSurfaces = darkLightThemeSurfaceDeclarations()
assert(
  darkLightSurfaces.length === 0,
  'Light theme must not retain dark background or border surfaces: ' + darkLightSurfaces.join(', ')
)

assert(
  appShell.includes('root.dataset.theme = theme') &&
    appShell.includes("root.classList.toggle('theme-light', theme === 'light')") &&
    appShell.includes("root.classList.toggle('theme-dark', theme === 'dark')") &&
    styles.includes(':root[data-theme="light"]') &&
    styles.includes(':root[data-theme="light"] body') &&
    styles.includes('color-scheme: light;') &&
    styles.includes('--light-border: #e3e9ed;') &&
    styles.includes('--light-surface: #ffffff;') &&
    styles.includes('--light-text: #111827;') &&
    styles.includes('background: #f6f8fc;'),
  'Light theme must sync document root theme state so window edges and teleported overlays follow the active theme.'
)

assert(
  styles.includes('--shell-gap: 10px;') &&
    styles.includes('--shell-gap-tight: 8px;') &&
    styles.includes('padding: var(--shell-gap) var(--shell-gap) var(--shell-gap-tight) var(--shell-gap);') &&
    styles.includes('margin: 0 var(--shell-gap) var(--shell-gap) var(--shell-gap);') &&
    styles.includes('.workspace-bar {\n  padding: var(--shell-gap);') &&
    styles.includes('--shell-gap: 8px;') &&
    styles.includes('--shell-gap-tight: 6px;'),
  'Terminal, quick-command bar, and workspace tabs must share the same shell spacing tokens across themes and responsive widths.'
)

assert(
  appShell.includes("WORKSPACE_WIDTH_STORAGE_KEY = 'ai-term:workspace-width:v1'") &&
    appShell.includes('workspaceLayoutStyle') &&
    appShell.includes('beginWorkspaceResize') &&
    appShell.includes('handleWorkspaceResizeKeydown') &&
    appShell.includes('class="workspace-resizer"') &&
    appShell.includes('role="separator"') &&
    appShell.includes('tabindex="0"') &&
    sidebar.includes('<span class="section-title">连接</span>') &&
    sidebar.includes('placeholder="搜索主机、用户或标签"') &&
    settingsSidebar.includes('<span class="section-title">设置</span>') &&
    settingsSidebar.includes('<span>AI 配置</span>') &&
    aiPanel.includes('normalizeGeneratedSessionTitle') &&
    aiPanel.includes('formatSessionDisplayTitle') &&
    aiPanel.includes('return `${title} 命令`') &&
    styles.includes('/* Quiet workspace redesign: terminal-first geometry with restrained operational chrome. */') &&
    styles.includes('/* Compact settings navigation and second-pass workspace cleanup. */') &&
    styles.includes('/* AI workspace final density pass. */') &&
    styles.includes('.app-shell .settings-sidebar {\n  grid-template-rows: 46px minmax(0, 1fr);') &&
    styles.includes('.settings-center > .settings-section') &&
    styles.includes('flex: 1 1 auto;') &&
    styles.includes('.assistant-panel .message:not(.ai):not(.error)') &&
    styles.includes('.assistant-panel .ai-code-meta .command-risk-status') &&
    styles.includes('.assistant-panel .message-collapse-footer') &&
    styles.includes('.app-shell.theme-light .assistant-panel .message.ai') &&
    styles.includes('.tab:hover .terminal-target-toggle') &&
    styles.includes('.terminal-target-summary.active') &&
    styles.includes('.workspace-tabs button.active::after') &&
    styles.includes('body.workspace-resizing'),
  'The quiet workspace redesign must keep compact shell geometry, a resizable right workspace, flat navigation, and lightweight AI messages.'
)

assert(
  styles.includes('/* Native terminal code surface and completion menu. */') &&
    styles.includes('background: rgba(226, 232, 240, .26) !important;') &&
    styles.includes('overflow: hidden;') &&
    styles.includes('.xterm-host .xterm-selection {') &&
    styles.includes('z-index: 4 !important;') &&
    styles.includes('pointer-events: none;') &&
    styles.includes('Native xterm selection is replaced by ai-term-selection-overlay.') &&
    styles.includes('opacity: 0 !important;') &&
    styles.includes('.xterm-host .ai-term-selection-overlay') &&
    styles.includes('.xterm-host .ai-term-selection-line') &&
    styles.includes('.app-shell.theme-light .xterm-host .ai-term-selection-line') &&
    styles.includes('.app-shell.theme-light .xterm-host .xterm-selection div') &&
    styles.includes('background: rgba(16, 185, 129, .20) !important;') &&
    styles.includes('background: rgba(104, 211, 145, .09);') &&
    styles.includes('.terminal-completion button:hover::before') &&
    styles.includes('background: #68d391;') &&
    styles.includes('outline: 1px solid rgba(16, 185, 129, .34);') &&
    styles.includes('.xterm-host .xterm-rows * {') &&
    styles.includes('.xterm-host .xterm-rows *::selection') &&
    styles.includes('color: inherit !important;') &&
    styles.includes('.xterm-host .xterm-accessibility-tree:not(.debug) *::selection') &&
    styles.includes('background: transparent !important;') &&
    styles.includes('-webkit-user-select: none;') &&
    !styles.includes('0 24px 70px') &&
    !styles.includes('rgba(96, 165, 250, .42)') &&
    !styles.includes('rgba(30, 64, 175, .28)'),
  'Terminal surface must stay grounded without heavy shadows, use neutral selection colors in both themes, and keep the green accent for focus and completion states.'
)

assert(
  styles.includes('/* AI panel reading rhythm polish. */') &&
    styles.includes('.assistant-panel .message {') &&
    styles.includes('.assistant-panel .message.ai {') &&
    styles.includes('.assistant-panel .message.error {') &&
    styles.includes('.app-shell.theme-light .assistant-panel .message.ai {') &&
    styles.includes('.ai-code-run.text-button.primary-action:hover') &&
    styles.includes('.app-shell.theme-light .ai-code-run.text-button.primary-action:hover'),
  'AI assistant panel must keep compact message rhythm, neutral cards, green command actions, and matching light-theme surfaces.'
)

const lightThemeLayoutParityPairs = [
  ['.app-shell', '.app-shell.theme-light'],
  ['.app-shell.left-collapsed', '.app-shell.theme-light.left-collapsed'],
  ['.app-shell.right-collapsed', '.app-shell.theme-light.right-collapsed'],
  ['.app-shell.left-collapsed.right-collapsed', '.app-shell.theme-light.left-collapsed.right-collapsed'],
  ['.titlebar', '.app-shell.theme-light .titlebar'],
  ['.left-collapsed .titlebar', '.app-shell.theme-light.left-collapsed .titlebar'],
  ['.sidebar', '.app-shell.theme-light .sidebar'],
  ['.terminal-stack', '.app-shell.theme-light .terminal-stack'],
  ['.terminal-wrap', '.app-shell.theme-light .terminal-wrap'],
  ['.terminal-frame', '.app-shell.theme-light .terminal-frame'],
  ['.quick-command-bar', '.app-shell.theme-light .quick-command-bar'],
  ['.workspace-panel', '.app-shell.theme-light .workspace-panel'],
  ['.right-panel', '.app-shell.theme-light .right-panel'],
  ['.workspace-bar', '.app-shell.theme-light .workspace-bar'],
  ['.workspace-tabs', '.app-shell.theme-light .workspace-tabs'],
  ['.workspace-tabs button', '.app-shell.theme-light .workspace-tabs button'],
  ['.app-rail', '.app-shell.theme-light .app-rail'],
  ['.rail-button', '.app-shell.theme-light .rail-button'],
  ['.rail-button.active', '.app-shell.theme-light .rail-button.active'],
  ['.rail-button.active::before', '.app-shell.theme-light .rail-button.active::before'],
  ['.rail-button .ui-icon', '.app-shell.theme-light .rail-button .ui-icon'],
  ['.server-list', '.app-shell.theme-light .server-list'],
  ['.search-input', '.app-shell.theme-light .search-input'],
  ['.server-card', '.app-shell.theme-light .server-card'],
  ['.file-row', '.app-shell.theme-light .file-row'],
]

assertLightThemeLayoutParity(lightThemeLayoutParityPairs, {
  allowedDifferences: [
    '.terminal-frame -> .app-shell.theme-light .terminal-frame -> box-shadow',
  ],
})

const lightThemeContentSelectors = [
  '.settings-card',
  '.settings-option',
  '.settings-search',
  '.settings-config-list',
  '.settings-status-card',
  '.message-list',
  '.message',
  '.message-title',
  '.message-body',
  '.history-list',
  '.history-row',
  '.file-list',
  '.file-row',
  '.script-chat-list',
  '.script-draft-card',
  '.script-preview',
  '.script-library-row',
  '.script-reply-message',
  '.terminal-target-card',
  '.selected-target',
  '.assistant-compose',
  '.panel-head',
  '.context-strip',
  '.workspace-section-head',
  '.local-pathbar',
  '.sftp-pathbar',
]
const lightThemeContentParityPairs = lightThemeContentSelectors.flatMap((selector) => [
  [selector, '.theme-light ' + selector],
  [selector, '.app-shell.theme-light ' + selector],
])
assertLightThemeLayoutParity(lightThemeContentParityPairs)

const lightThemeVars = lightThemeCustomProperties()
assertContrast('var(--light-text)', 'var(--light-surface)', 4.5, 'Light theme primary text must remain readable on cards', lightThemeVars)
assertContrast('var(--light-text)', 'var(--light-bg)', 4.5, 'Light theme primary text must remain readable on the app background', lightThemeVars)
assertContrast('var(--light-muted)', 'var(--light-surface)', 4.5, 'Light theme secondary text must remain readable on cards', lightThemeVars)
assertContrast('var(--light-muted)', '#fbfcfd', 4.5, 'Light theme secondary text must remain readable on soft headers', lightThemeVars)
assertContrast('var(--light-danger)', '#fff6f7', 4.5, 'Light theme danger text must remain readable on warning surfaces', lightThemeVars)
assertContrast('#be123c', '#fff1f2', 4.5, 'Light theme destructive action text must remain readable on danger chips', lightThemeVars)


const lightThemeShellGeometryPattern = /\.app-shell\.theme-light[^{}]*\{[^{}]*\b(?:grid-template-columns|grid-template-rows|grid-column|grid-row|position|top|right|bottom|left|z-index|width|height|min-width|min-height|max-width|max-height|margin|margin-inline|margin-top|margin-right|margin-bottom|margin-left|padding|padding-inline|padding-top|padding-right|padding-bottom|padding-left|gap|row-gap|column-gap|border-radius|font-size|font-weight|transform)\s*:/
assert(
  !lightThemeShellGeometryPattern.test(styles),
  'Light theme must inherit base shell/workspace layout; remove geometry overrides from .app-shell.theme-light rules.'
)

assert(
  !styles.includes('/* Light theme structural cleanup. */') &&
    !styles.includes('/* Light theme responsive parity. */') &&
    !styles.includes('/* Light theme typography and interaction parity. */') &&
    !styles.includes('/* Light theme right workspace 1280 parity contract. */') &&
    !styles.includes('/* Light theme right workspace 1080 parity contract. */') &&
    !styles.includes('/* Light theme workspace structure parity contract. */') &&
    !styles.includes('.app-shell.theme-light {\n  grid-template-columns: 56px 280px minmax(440px, 1fr) 320px;') &&
    !styles.includes('.app-shell.theme-light:not(.right-collapsed) {\n  grid-template-columns: 56px 270px minmax(0, 1fr) 0;') &&
    !styles.includes('.app-shell.theme-light .workspace-tabs {\n  grid-template-columns: repeat(4, minmax(54px, 1fr));') &&
    !styles.includes('.app-shell.theme-light:not(.right-collapsed) .right-panel') &&
    !styles.includes('.app-shell.theme-light .app-rail {\n  gap') &&
    !styles.includes('.app-shell.theme-light .rail-button {\n  width') &&
    !styles.includes('.app-shell.theme-light .server-card {\n  min-height') &&
    !styles.includes('.app-shell.theme-light .quick-command-bar {\n  margin'),
  'Light theme must not duplicate layout geometry; shared app layout should come from base rules.'
)

assert(
  styles.includes('grid-template-columns: calc(var(--rail-width) + var(--sidebar-width)) minmax(0, 1fr);') &&
    styles.includes('grid-template-columns: var(--rail-width) minmax(0, 1fr);') &&
    styles.includes('padding: 8px 8px 6px 0;') &&
    styles.includes('margin: 0 8px 6px 0;') &&
    !styles.includes('grid-template-columns: 336px minmax(0, 1fr);') &&
    !styles.includes('grid-template-columns: 326px minmax(0, 1fr);') &&
    !styles.includes('grid-template-columns: 278px minmax(0, 1fr);') &&
    !styles.includes('grid-template-columns: 56px minmax(0, 1fr);'),
  'Titlebar divider and terminal content edge must align to the same rail/sidebar grid boundary.'
)

assertLastCssDeclarations(
  '.rail-button',
  { 'box-shadow': 'none' },
  'Left rail buttons must stay flat without decorative shadows',
  { afterMarker: '/* Rail parity and SFTP directory polish. */', beforeMarker: '/* Workspace separation polish. */' }
)
assertLastCssDeclarations(
  '.rail-button.active',
  { 'box-shadow': 'none' },
  'Active left rail buttons must stay flat without decorative shadows',
  { afterMarker: '/* Rail parity and SFTP directory polish. */', beforeMarker: '/* Workspace separation polish. */' }
)
assert(
  !styles.includes('box-shadow .22s cubic-bezier(.16, 1, .3, 1)'),
  'Left rail button transitions must not animate decorative shadows.'
)

assertLastCssDeclarations(
  '.history-preview-modal',
  {
    display: 'grid',
    'grid-template-rows': 'auto minmax(0, 1fr) auto',
    overflow: 'hidden',
    padding: '0',
  },
  'Long command history entries must use a dedicated preview modal instead of expanding inline',
  { afterMarker: '/* Command history preview modal. */', beforeMarker: '/* Light theme shell structure parity contract. */' }
)
assertLastCssDeclarations(
  '.history-preview-body code',
  {
    'white-space': 'pre-wrap',
    'overflow-wrap': 'anywhere',
    'word-break': 'break-word',
  },
  'History command preview must wrap long commands inside the modal without breaking the list layout',
  { afterMarker: '/* Command history preview modal. */', beforeMarker: '/* Light theme shell structure parity contract. */' }
)
assertLastCssDeclarations(
  '.app-shell.theme-light .assistant-panel',
  {
    background: '#fff',
    color: 'var(--light-text)',
  },
  'Light theme AI panel must not retain dark workspace surfaces',
  { afterMarker: '/* Light theme color-only surface contract. */' }
)

assertLastCssDeclarations(
  '.app-shell.theme-light .files-panel',
  {
    background: '#fff',
    color: 'var(--light-text)',
  },
  'Light theme SFTP panel must not retain dark workspace surfaces',
  { afterMarker: '/* Light theme color-only surface contract. */' }
)

assertLastCssDeclarations(
  '.app-shell.theme-light .terminal-completion',
  {
    'border-color': 'var(--light-border)',
    background: '#fff',
    color: 'var(--light-text)',
  },
  'Light theme terminal completion popover must use light surfaces',
  { afterMarker: '/* Light theme color-only surface contract. */' }
)

assertLastCssDeclarations(
  '.app-shell.theme-light .transfer-browser',
  {
    background: 'var(--light-border)',
  },
  'Light theme SFTP file browser divider must be light, not dark',
  { afterMarker: '/* Light theme color-only surface contract. */' }
)
assertLastCssDeclarations(
  '.app-shell.theme-light .script-risk-modal',
  {
    'border-color': '#dbe3ee',
    background: '#ffffff',
    color: '#172033',
  },
  'Light theme risk modal must use a neutral product surface instead of an all-red panel',
  { afterMarker: '/* Light theme color-only surface contract. */' }
)

assertLastCssDeclarations(
  '.app-shell.theme-light .script-risk-ai',
  {
    'border-color': '#bfe9d3',
    background: '#f0fbf5',
  },
  'Light theme risk AI helper must use the green product theme instead of an unrelated blue surface',
  { afterMarker: '/* Light theme color-only surface contract. */' }
)

assertLastCssDeclarations(
  '.app-shell.theme-light .script-risk-preview',
  {
    'border-color': '#d7e0eb',
    background: '#f8fafc',
    color: '#172033',
  },
  'Light theme risk command preview must use a readable neutral code surface',
  { afterMarker: '/* Light theme color-only surface contract. */' }
)

assertLastCssDeclarations(
  '.app-shell.theme-light .script-risk-chip.high',
  {
    'border-color': '#eea8b4',
    background: '#fff1f3',
  },
  'Light theme high-risk chip must keep danger emphasis without washing out text',
  { afterMarker: '/* Light theme color-only surface contract. */' }
)

assertLastCssDeclarations(
  '.app-shell.theme-light .script-risk-line.flagged',
  {
    'border-left-color': '#e11d48',
    background: '#fff7f8',
    color: '#172033',
  },
  'Light theme flagged command line must be softly highlighted while preserving code contrast',
  { afterMarker: '/* Light theme color-only surface contract. */' }
)

assertLastCssDeclarations(
  '.app-shell.theme-light .script-risk-line-label',
  {
    background: '#fff1f3',
    color: '#be123c',
  },
  'Light theme risk line pill must stay legible on the command preview surface',
  { afterMarker: '/* Light theme color-only surface contract. */' }
)

assertLastCssDeclarations(
  '.app-shell.theme-light .script-risk-actions',
  {
    'border-top-color': '#e5ebf2',
    background: '#fbfcfd',
  },
  'Light theme risk modal actions must use a neutral footer instead of a pink footer',
  { afterMarker: '/* Light theme color-only surface contract. */' }
)
assertLastCssDeclarations(
  '.app-shell.theme-dark .script-risk-modal',
  {
    'border-color': '#2a3446',
    background: '#0b1018',
    color: '#e5edf7',
  },
  'Dark theme risk modal must use a neutral product surface instead of an all-red panel',
  { afterMarker: '/* Light theme color-only surface contract. */' }
)

assertLastCssDeclarations(
  '.app-shell.theme-dark .script-risk-ai',
  {
    'border-color': '#1f6d4a',
    background: '#0d1f19',
  },
  'Dark theme risk AI helper must use the green product theme instead of an unrelated blue surface',
  { afterMarker: '/* Light theme color-only surface contract. */' }
)

assertLastCssDeclarations(
  '.app-shell.theme-dark .script-risk-preview',
  {
    'border-color': '#253044',
    background: '#070b12',
    color: '#e2e8f0',
  },
  'Dark theme risk command preview must use a readable neutral code surface',
  { afterMarker: '/* Light theme color-only surface contract. */' }
)

assertLastCssDeclarations(
  '.app-shell.theme-dark .script-risk-line.flagged',
  {
    'border-left-color': '#fb7185',
    background: '#201119',
    color: '#f8fafc',
  },
  'Dark theme flagged command line must use restrained danger emphasis instead of a saturated red block',
  { afterMarker: '/* Light theme color-only surface contract. */' }
)

assertLastCssDeclarations(
  '.app-shell.theme-dark .script-risk-actions',
  {
    'border-top-color': '#293246',
    background: '#090e16',
  },
  'Dark theme risk modal actions must use a neutral footer',
  { afterMarker: '/* Light theme color-only surface contract. */' }
)

assertCssRuleIncludes(
  '.assistant-panel',
  ['flex: 1 1 auto;', 'min-height: 0;', 'overflow: hidden;'],
  'AI assistant panel must constrain the message list so long chats scroll instead of stretching the workspace.'
)

assertCssRuleIncludes(
  '.message-list',
  ['overflow-y: auto;', 'overflow-x: hidden;', 'overscroll-behavior: contain;'],
  'AI message list must own vertical scrolling and keep long chats readable.'
)

assertCssRuleIncludes(
  '.message-list',
  ['display: flex;', 'flex-direction: column;'],
  'AI message list must stack messages by content height so extra messages overflow into scrolling instead of shrinking each card.'
)

assertCssRuleIncludes(
  '.message',
  ['flex: 0 0 auto;', 'height: auto;'],
  'AI message cards must keep their natural height when the conversation grows.'
)

assert(
  aiPanel.includes('collapsedMessages') &&
    aiPanel.includes('function isMessageCollapsed') &&
    aiPanel.includes('collapsed: isMessageCollapsed(message)') &&
    !aiPanel.includes('collapsed: !isMessageExpanded(message)'),
  'AI messages must be expanded by default; only messages collapsed by the user should be compact.'
)

assert(
  !aiPanel.includes('executeGeneratedCommand()') &&
    !aiPanel.includes('executableCommands(message)') &&
    aiMarkdownMessage.includes('shellCommandForPart(part)') &&
    aiMarkdownMessage.includes('codeBlockLabel(part.language, part.content)') &&
    aiMarkdownMessage.includes("shellCommandFromCodeBlock(part.language, part.content)") &&
    shellCommand.includes('explicitShellLanguages') &&
    shellCommand.includes('shellSessionLanguages') &&
    shellCommand.includes('normalizeCodeLanguage') &&
    shellCommand.includes('hasShellSignal') &&
    shellCommand.includes("'bat'") &&
    shellCommand.includes("'cmd'") &&
    shellCommand.includes("'powershell'"),
  'AI execute buttons must appear on recognized shell-like code blocks, including bash, shell sessions, and Windows bat/cmd/powershell blocks.'
)

assert(
  scriptRisk.includes('Windows 删除') &&
    scriptRisk.includes('PowerShell 删除') &&
    scriptRisk.includes('Windows 重启关机') &&
    scriptRisk.includes('Windows 软件升级') &&
    scriptRisk.includes('Windows 网络配置') &&
    scriptRisk.includes('Windows 磁盘操作') &&
    scriptRisk.includes('normalizeRiskScanLine') &&
    scriptRisk.includes('未检测到危险命令'),
  'Script risk scanning must include Windows bat/cmd/PowerShell dangerous commands in the same risk pipeline.'
)

assert(
  sftpBackend.includes('fn terminate_sftp_process') &&
    sftpBackend.includes('SFTP_CHILD_EXIT_GRACE') &&
    !sftpBackend.includes('let _ = process.child.wait();'),
  'SFTP backend must not block indefinitely while waiting for killed child processes; failed auth, cancel, and timeout paths must return so the UI clears loading.'
)
assert(
  sftpBackend.includes('NATIVE_SFTP_POOL_TTL') &&
    sftpBackend.includes('NATIVE_SFTP_POOL_MAX') &&
    sftpBackend.includes('run_cached_native_sftp_routes') &&
    sftpBackend.includes('run_cached_native_sftp_route') &&
    sftpBackend.includes('native_sftp_cache_key') &&
    sftpBackend.includes('take_cached_native_sftp_connection') &&
    sftpBackend.includes('store_cached_native_sftp_connection') &&
    sftpBackend.includes('clear_cached_native_sftp_routes') &&
    sftpBackend.includes('pool.remove(&cache_key)') &&
    sftpBackend.includes('run_cached_native_sftp_routes(') &&
    sftpBackend.includes('|connection, _route| list_directory_native(connection, remote_path)'),
  'SFTP probing must discard the target route from the native pool, while normal directory listing should reuse the newly verified target-specific session.'
)
assert(
  sftpBackend.includes('NATIVE_SFTP_COPY_BUFFER_SIZE: usize = 1024 * 1024') &&
    sftpBackend.includes('vec![0u8; NATIVE_SFTP_COPY_BUFFER_SIZE]') &&
    sftpBackend.includes('fn run_native_sftp_route<T>') &&
    sftpBackend.includes('take_cached_native_sftp_connection(cache_key)') &&
    sftpBackend.includes('store_cached_native_sftp_connection(cache_key.to_string(), connection)') &&
    commands.includes('SFTP_PROGRESS_EMIT_INTERVAL') &&
    commands.includes('SftpProgressThrottle') &&
    commands.includes('throttle.flush()'),
  'Native SFTP transfers must use a deep heap-backed pipeline, reuse idle sessions without holding the pool lock, and throttle progress IPC while preserving the final update.'
)
assert(
  sshBackend.includes('SSH_RELAY_BUFFER_SIZE: usize = 64 * 1024') &&
    sshBackend.includes('thread::sleep(SSH_DATA_RETRY_DELAY)') &&
    sshBackend.includes('thread::sleep(SSH_IO_RETRY_DELAY)') &&
    sshBackend.includes('write_all_retry_handles_partial_writes_without_flushing') &&
    !sshBackend.includes('writer.flush()?'),
  'Bastion forwarding must use larger relay buffers, retry active writes promptly, avoid busy idle polling, and never discard inbound channel data through ssh2 Channel.flush.'
)
assert(
  sftpBackend.includes('fn try_native_sftp_probe') &&
    sftpBackend.includes('should_retry_native_probe_at_root') &&
    sftpBackend.includes('try_native_list_directory(profile, "."') &&
    sftpBackend.includes('try_native_list_directory(profile, "/"') &&
    sftpBackend.includes('!should_fallback_native_sftp_error(&error)'),
  'Bastion SFTP probing must try the native route first, recover an invalid default cwd at the absolute root, and keep security failures terminal.'
)
assert(
  sftpBackend.includes('fn sftp_line_ending()') &&
    sftpBackend.includes('cfg!(windows)') &&
    sftpBackend.includes('should_send_sftp_commands') &&
    sftpBackend.includes('connected to ') &&
    sftpBackend.includes('SFTP_READY_GRACE'),
  'SFTP backend must handle Windows OpenSSH PTY differences: CRLF input and readiness fallback instead of relying only on a visible sftp> prompt.'
)
assert(
  sftpBackend.includes('terminal_status_response') &&
    sftpBackend.includes('"\\x1b[6n"') &&
    sftpBackend.includes('b"\\x1b[1;1R"'),
  'SFTP backend must answer Windows OpenSSH cursor-position requests (ESC[6n) so sftp.exe does not hang in the PTY.'
)
assert(
  commands.includes('SFTP_COMMAND_TIMEOUT') &&
    commands.includes('tokio::time::timeout') &&
    commands.includes('SFTP directory listing timed out') &&
    commands.includes('token.store(true'),
  'SFTP directory listing command must have a Tauri-level hard timeout so the frontend never stays stuck on loading when Windows sftp.exe or PTY hangs.'
)
assert(
  sftpBackend.includes('const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);') &&
    commands.includes('const SFTP_COMMAND_TIMEOUT: Duration = Duration::from_secs(45);'),
  'SFTP backend command timeout must fire before the Tauri-level hard timeout so failures include captured sftp.exe output.'
)
assert(
  appShell.includes('selectedProfile = computed(() =>') &&
    appShell.includes('return undefined') &&
    !appShell.includes('?? profiles.value[0]'),
  'AppShell must pass an undefined profile when no connection is selected so the terminal opens locally by default.'
)

assert(
  appShell.includes('function openLocalTerminal()') &&
    appShell.includes("selectedProfileId.value = ''") &&
    appShell.includes('@click="openLocalTerminal"'),
  'AppShell must provide an explicit local terminal action that clears the selected profile and reconnects locally.'
)

assert(
  terminalPane.includes('if (props.profile)') &&
    terminalPane.includes('await connectLocal()') &&
    terminalPane.includes("status.value = 'local'"),
  'TerminalPane must automatically attach a local terminal when no connection profile is configured.'
)
assert(
  terminalPane.indexOf('sessionId = requestedSessionId') > -1 &&
    terminalPane.indexOf('await attachTerminalEvents()', terminalPane.indexOf('sessionId = requestedSessionId')) > -1 &&
    terminalPane.indexOf('await attachTerminalEvents()', terminalPane.indexOf('sessionId = requestedSessionId')) < terminalPane.indexOf('connectLocalTerminal(size.cols, size.rows, requestedSessionId)') &&
    tauri.includes('connectLocalTerminal(cols: number, rows: number, sessionId?: string)') &&
    commands.includes('session_id: Option<String>'),
  'Local terminal startup must pre-bind a session-scoped listener before spawning the shell so first-launch prompt output is not lost.'
)

assert(
  terminalPane.includes('connectProfile') &&
    terminalPane.includes('connectedSessionId = await connectProfile(profile.id, size.cols, size.rows)') &&
    terminalPane.includes('if (!await attachTerminalEvents())') &&
    terminalPane.includes('isCurrentConnectionAttempt(attempt)') &&
    terminalPane.includes('terminalInputReady = true') &&
    !terminalPane.includes('Remote SSH profile editing is ready'),
  'TerminalPane must attach remote SSH profiles through the Tauri backend and only enable input for the current connected attempt.'
)

assert(
  !terminalPane.includes('Remote SSH is not enabled for this build yet.'),
  'TerminalPane must not show a disabled-remote placeholder.'
)

assert(
  terminalPane.includes('dataDisposable = terminal.onData((data) => {') &&
    terminalPane.includes('if (terminalInputDestinationAvailable()) {') &&
    terminalPane.includes('forwardInteractiveTerminalInput(data)') &&
    !terminalPane.includes('dataDisposable = terminal.onData((data) => {\n    terminal?.write(data)'),
  'TerminalPane must only forward keyboard input after a destination is writable and must not echo it locally.'
)

assert(
  terminalPane.includes('const pendingPreReadyTerminalInput: PendingTerminalInput[] = []') &&
    terminalPane.includes('function bufferPreReadyTerminalInput(data: string)') &&
    terminalPane.includes('bufferPreReadyTerminalInput(data)') &&
    terminalPane.includes('function flushPreReadyTerminalInput()') &&
    terminalPane.includes('flushPreReadyTerminalInput()') &&
    terminalPane.includes('item.generation === terminalInputGeneration') &&
    terminalPane.includes('pendingPreReadyTerminalInput.length = 0') &&
    terminalPane.includes('terminal?.focus()') &&
    terminalPane.includes('terminalHost.value?.focus()'),
  'TerminalPane must preserve generation-scoped keystrokes during connection readiness checks and restore focus when a terminal tab becomes active.'
)

assert(
  terminalPane.includes('currentRenderedCommandLine') &&
    terminalPane.includes('currentRenderedCommandLinePosition') &&
    terminalPane.includes('submittedTerminalCommand') &&
    terminalPane.includes("if (inputCommandReliable && terminalInputContext === 'shell') return fallback.trim()") &&
    terminalPane.indexOf("if (inputCommandReliable && terminalInputContext === 'shell') return fallback.trim()", terminalPane.indexOf('function submittedTerminalCommand')) <
      terminalPane.indexOf('const renderedLine = currentRenderedCommandLine()', terminalPane.indexOf('function submittedTerminalCommand')) &&
    terminalPane.includes('deferredCommandCapture') &&
    terminalPane.includes('scheduleDeferredCommandCapture') &&
    terminalPane.includes('deferredCommandCaptureTimers') &&
    terminalPane.includes('candidate === previousCandidate') &&
    terminalPane.includes("terminalInputContext === 'sensitive'") &&
    terminalPane.includes("terminal?.buffer.active.type === 'alternate'") &&
    terminalPane.includes('shellPromptText') &&
    terminalPane.includes('pendingTrackedCommands') &&
    terminalPane.includes('pendingDeferredCommandCaptures') &&
    terminalPane.includes("terminalInputContext === 'shell'") &&
    terminalPane.includes('batch.commits.forEach(runTerminalInputCommit)') &&
    terminalPane.includes('commitTrackedCommands(submittedCommands)') &&
    !terminalPane.includes('recordCommand(inputCommandBuffer)'),
  'Command history and script recording must capture reliable input immediately, defer lagging terminal echoes until stable, and exclude sensitive or alternate-screen input.'
)

assert(
  terminalPane.includes('commandHistory: CommandHistoryEntry[]') &&
    terminalPane.includes('handleCompletionInput(data)') &&
    terminalPane.includes('terminalCompletionOpen') &&
    terminalPane.includes('completionSuggestions') &&
    terminalPane.includes('selectedCompletionIndex') &&
    terminalPane.includes('systemCommandSuggestions') &&
    terminalPane.includes('historyCommandSuggestions') &&
    terminalPane.includes('acceptCompletionSuggestion') &&
    terminalPane.includes('completionSourceLabel') &&
    terminalPane.includes('handleDocumentPointerDown') &&
    terminalPane.includes('terminalBodyWrap.value?.contains(target)') &&
    terminalPane.includes('COMPLETION_DEBOUNCE_MS = 400') &&
    terminalPane.includes('COMPLETION_LIMIT = 6') &&
    !terminalPane.includes('completionKeyboardMode') &&
    terminalPane.includes('scheduleCompletionSuggestions') &&
    terminalPane.includes('recoverTrackedTerminalInputFromRenderedLine') &&
    terminalPane.includes('updateCompletionAfterInput') &&
    terminalPane.includes('completionSuppressedForHistoryNavigation') &&
    terminalPane.includes('isHistoryNavigationInput(data)') &&
    terminalPane.includes('!completionSuppressedForHistoryNavigation') &&
    !terminalPane.includes('moveCompletionSelection') &&
    terminalPane.includes("data === '\\x1bOA'") &&
    terminalPane.includes("data === '\\x1bOB'") &&
    terminalPane.includes('const inputResult = trackUserInput(data)') &&
    terminalPane.includes("data === '\\x1b[A'") &&
    terminalPane.includes("data === '\\x1b[B'") &&
    terminalPane.includes("data === '\\x1b[D'") &&
    terminalPane.includes("data === '\\x1b[C'") &&
    terminalPane.includes("terminalInputContext === 'shell'") &&
    terminalPane.includes("resetTrackedTerminalInput('sensitive')") &&
    terminalPane.includes('inputCommandReliable') &&
    terminalPane.includes('terminalCompletionOpen.value = completionSuggestions.value.length > 0') &&
    terminalPane.includes('inputCommandBuffer.trimStart()') &&
    terminalPane.includes('positionTerminalCompletion') &&
    terminalPane.includes('terminal.buffer.active.cursorX') &&
    terminalPane.includes('terminal.buffer.active.cursorY') &&
    terminalPane.includes("completionPlacement.value = placement") &&
    terminalPane.includes('completionPositionStyle.value = {') &&
    terminalPane.includes('ref="terminalCompletion"') &&
    terminalPane.includes(':data-side="completionPlacement"') &&
    terminalPane.includes('<mark>{{ suggestion.command.slice(0, completionPrefixLength) }}</mark>') &&
    terminalPane.includes('class="completion-meta"') &&
    terminalPane.includes(':aria-selected="index === selectedCompletionIndex"') &&
    !terminalPane.includes("event.key === 'Tab'") &&
    !terminalPane.includes('handleTerminalCustomKeyEvent') &&
    !terminalPane.includes('terminal.attachCustomKeyEventHandler') &&
    terminalPane.includes('convertEol: false') &&
    !terminalPane.includes("event.code === 'Space'") &&
    !terminalPane.includes('<kbd>Ctrl</kbd><kbd>Space</kbd>') &&
    terminalPane.includes('class="terminal-completion"') &&
    appShell.includes(':command-history="commandHistoryForTab(tab)"') &&
    !appShell.includes('key.startsWith(`${tab.connectionId}:`)') &&
    appShell.includes('writeSyncedTerminalInput(event.data, event.terminalId)') &&
    styles.includes('.terminal-completion') &&
    !styles.includes('.terminal-completion-head') &&
    !styles.includes('.terminal-completion-empty') &&
    styles.includes('.terminal-body-wrap {\n  position: relative;') &&
    styles.includes('display: block;\n  overflow: hidden;') &&
    styles.includes('.terminal-completion {\n  position: absolute;') &&
    styles.includes('max-height: 206px;') &&
    styles.includes('backdrop-filter: none;') &&
    !styles.includes('.terminal-completion kbd') &&
    styles.includes('.terminal-completion button.selected') &&
    styles.includes('.terminal-completion button.selected::before') &&
    styles.includes('.terminal-completion mark') &&
    styles.includes('.terminal-completion .completion-source.session') &&
    styles.includes('.theme-light .terminal-completion mark') &&
    styles.includes('.theme-light .terminal-completion .completion-source.system') &&
    styles.includes('.terminal-native-code') &&
    styles.includes('.xterm-host .xterm-rows') &&
    styles.includes('.xterm-host {\n  width: 100%;') &&
    styles.includes('display: grid;\n  overflow: hidden;\n  box-sizing: border-box;\n  padding: 0;') &&
    styles.includes('.xterm-host .xterm {\n  width: 100%;\n  min-width: 0;') &&
    styles.includes('box-sizing: border-box;\n  background: #03070c;\n  padding: 16px 6px 16px 18px;') &&
    terminalPane.includes("import { FitAddon } from '@xterm/addon-fit'") &&
    terminalPane.includes('terminal.loadAddon(fitAddon)') &&
    terminalPane.includes('fitAddon.fit()') &&
    terminalPane.includes('terminalHostIsMeasurable') &&
    terminalPane.includes('scheduleTerminalSizeSync(true)') &&
    appShell.includes(':active="tab.id === activeTerminalId"') &&
    !terminalPane.includes('measureTerminalCell') &&
    terminalPane.includes('scrollTerminalToBottom') &&
    terminalPane.includes('terminal.buffer.active') &&
    terminalPane.includes('writeTerminalView(event.data)') &&
    !terminalPane.includes('Math.floor(element.clientHeight / 18)'),
  'TerminalPane must provide native-feeling terminal code styling, command completion, official fitted sizing, active-tab resize guards, and bottom-pinned output.'
)

assert(
  terminalPane.includes("type TerminalInputContext = 'shell' | 'sensitive' | 'unknown'") &&
    terminalPane.includes('inputCommandCursor') &&
    terminalPane.includes('deleteTrackedTerminalWord') &&
    terminalPane.includes('code === 3') &&
    terminalPane.includes('code === 21') &&
    terminalPane.includes('code === 23') &&
    terminalPane.includes("terminalInputContext === 'shell' && inputCommandReliable") &&
    terminalPane.includes("resetTrackedTerminalInput('unknown')") &&
    terminalPane.includes("resetTrackedTerminalInput('sensitive')") &&
    terminalPane.includes('writeSyncedTerminalInput') &&
    terminalPane.includes('terminal.paste(text)') &&
    terminalPane.includes("text.replace(/\\r?\\n/g, '\\r')") &&
    appShell.includes('writeSyncedTerminalInput: (data: string, sourceTerminalId: string) => boolean'),
  'Terminal input tracking must handle common line editing, use native bracketed paste with normalized line endings, avoid recording sensitive prompts, and keep mirrored terminal buffers synchronized.'
)

const terminalForwardInputBlock = terminalPane.slice(
  terminalPane.indexOf('function forwardInteractiveTerminalInput'),
  terminalPane.indexOf('function sendInteractiveTerminalInput')
)
const terminalDirectInputBlock = terminalPane.slice(
  terminalPane.indexOf('function writeTerminalInput(data: string)'),
  terminalPane.indexOf('async function pasteClipboardToTerminal')
)
const terminalTrackInputBlock = terminalPane.slice(
  terminalPane.indexOf('function trackUserInput'),
  terminalPane.indexOf('function terminalInputSafeForSync')
)
const appTerminalSyncBlock = appShell.slice(
  appShell.indexOf('function syncTerminalInputToTargets'),
  appShell.indexOf('function handleTerminalInputWriteFailure')
)
const appSelectTerminalBlock = appShell.slice(
  appShell.indexOf('function selectTerminalTab'),
  appShell.indexOf('function setSessionTabButton')
)

assert(
  workspaceTypes.includes('export interface TerminalInputSyncState') &&
    workspaceTypes.includes('export interface TerminalInputWriteFailureEvent') &&
    workspaceTypes.includes("'interactive' | 'direct' | 'synced' | 'command'") &&
    terminalPane.includes('const terminalInputQueue: TerminalInputBatch[] = []') &&
    terminalPane.includes('const terminalInputPumpGenerations = new Set<number>()') &&
    terminalPane.includes('const pendingTerminalProtocolResponses: string[] = []') &&
    terminalPane.includes('async function pumpTerminalInputQueue(generation = terminalInputGeneration)') &&
    terminalPane.includes('await terminalWrite(batch.sessionId, batch.data)') &&
    terminalPane.includes('failedTerminalInputGeneration = batch.generation') &&
    terminalPane.includes("emit('terminalInputWriteFailed'") &&
    terminalPane.includes('function terminalBackendInputReady()') &&
    terminalPane.includes('function handleTerminalProtocolResponse(data: string)') &&
    terminalPane.includes("enqueueTerminalInput(data, 'direct')") &&
    terminalPane.includes('if (handleTerminalProtocolResponse(data)) return') &&
    terminalPane.includes('function writePreparedTerminalInput') &&
    terminalPane.includes("source: 'interactive'") &&
    terminalForwardInputBlock.includes('onWritten: () => {') &&
    terminalForwardInputBlock.includes('deferredCaptures.forEach(scheduleDeferredCommandCapture)') &&
    terminalForwardInputBlock.includes("emit('terminalInput', event)") &&
    !terminalForwardInputBlock.includes('writeTerminalInput(data)') &&
    terminalDirectInputBlock.includes("resetTrackedTerminalInput('unknown')") &&
    terminalPane.includes('const beforeState = terminalInputSyncState()') &&
    terminalPane.includes('safeToSync: terminalInputSafeForSync(data, beforeState, afterState)') &&
    !terminalTrackInputBlock.includes('inputCommandReliable = true') &&
    appShell.includes('terminalInputSyncStatesMatch') &&
    appShell.includes('pauseTerminalSyncTargets') &&
    appShell.includes('pausedTerminalSyncIds') &&
    appTerminalSyncBlock.indexOf('event.terminalId !== activeTerminalId.value') <
      appTerminalSyncBlock.indexOf("event.data === '\\x03'") &&
    appTerminalSyncBlock.includes('!pausedTerminalSyncIdSet.value.has(terminalId)') &&
    !appSelectTerminalBlock.includes('pausedTerminalSyncIds.value = []') &&
    appShell.includes('@terminal-input-write-failed="handleTerminalInputWriteFailure"'),
  'Terminal input must use a ready-gated per-pane FIFO, mirror only successful active-pane writes, and pause unsafe or divergent targets.'
)

assert(
  terminalPane.includes('function parseShellPrompt(value: string)') &&
    terminalPane.includes('function recognizedShellPrompt(lastLine: string)') &&
    terminalPane.includes("learned.kind === 'bare'") &&
    terminalPane.includes('shellCommandAwaitingPrompt') &&
    terminalPane.includes("terminal?.buffer.active.type === 'alternate'") &&
    terminalPane.includes("learned.sigil === candidate.sigil") &&
    !terminalPane.includes('|.*[$#%>') &&
    terminalPane.includes('function previousTrackedTextBoundary') &&
    terminalPane.includes('function nextTrackedTextBoundary') &&
    terminalPane.includes("if (data.startsWith('\\x1b[200~') || data.endsWith('\\x1b[201~')) return false"),
  'Terminal tracking must preserve Unicode code points, distrust ambiguous bare prompt output, and never broadcast bracketed paste based on assumed shell modes.'
)


assert(
  terminalPane.includes('stripCommandInputControlSequences(data)') &&
    terminalPane.includes('skipInputControlSequence') &&
    terminalPane.includes('pendingInputControlSequence') &&
    terminalPane.includes('isPendingCsiInputSequence') &&
    terminalPane.includes("pendingInputControlSequence.startsWith('\\x1b[')") &&
    terminalPane.includes('isPendingCsiInputSequence && pendingInputControlSequence.length > 2 && code >= 0x40 && code <= 0x7e') &&
    terminalPane.includes('!isPendingCsiInputSequence && code >= 0x40 && code <= 0x7e') &&
    terminalPane.includes("char === '\\x1b'") &&
    terminalPane.includes('code >= 0x40 && code <= 0x7e') &&
    terminalPane.includes('const commandInput = stripCommandInputControlSequences(data)'),
  'TerminalPane command history must strip full CSI terminal control sequences such as ESC[5;1R, ESC[I, and ESC[O before recording commands.'
)

assert(
  terminalPane.includes('onTerminalData(activeSessionId') &&
    tauri.includes('terminalDataEventName(sessionId: string)'),
  'Terminal data listeners must use session-scoped event names.'
)

assert(
  terminalPane.includes('onTerminalClosed(activeSessionId') &&
    terminalPane.includes("status.value = 'idle'") &&
    tauri.includes('terminalClosedEventName(sessionId: string)'),
  'TerminalPane must listen for terminal close events and stop showing the local shell as live after it exits.'
)

assert(
  terminalPane.includes('statusChanged: [terminalId: string, status: TerminalRuntimeStatus]') &&
    terminalPane.includes('type TerminalRuntimeStatus') &&
    terminalPane.includes('watch(status, (value) => emitTerminalStatus(value), { immediate: true })') &&
    terminalPane.includes('function enterLocalShellErrorMode(error: unknown)') &&
    terminalPane.includes('isTauriUnavailableError(error)') &&
    terminalPane.includes('enterPreviewMode()') &&
    terminalPane.includes('enterLocalShellErrorMode(error)') &&
    terminalPane.includes('Local shell failed to start:') &&
    appShell.includes('status: TerminalRuntimeStatus') &&
    appShell.includes('updateTerminalStatus') &&
    appShell.includes('@status-changed="updateTerminalStatus"') &&
    appShell.includes('terminalStatusClass(tab.status)') &&
    appShell.includes(':class="terminalStatusClass(tab.status)"') &&
    !appShell.includes('class="status-dot live"') &&
    tauri.includes('terminalSessionActive') &&
    commands.includes('terminal_session_active') &&
    commands.includes('remove_terminal_session_after_exit') &&
    terminalPane.includes('verifyTerminalSessionStillActive') &&
    terminalPane.includes('await verifyTerminalSessionStillActive(connectedSessionId)') &&
    terminalPane.includes('window.setTimeout(resolve, 150)'),
  'Terminal tabs must reflect real terminal runtime status, local shell spawn failures must enter error, and quick shell exits must be detected even if the close event is missed.'
)

const remoteConnectionBlock = terminalPane.slice(
  terminalPane.indexOf('async function connectRemote'),
  terminalPane.indexOf('async function connectLocal')
)
const localConnectionBlock = terminalPane.slice(
  terminalPane.indexOf('async function connectLocal'),
  terminalPane.indexOf('function enterLocalShellErrorMode')
)
const inputGenerationBlock = terminalPane.slice(
  terminalPane.indexOf('function advanceTerminalInputGeneration'),
  terminalPane.indexOf('function terminalBackendInputReady')
)

assert(
  inputGenerationBlock.includes('terminalInputReady = false') &&
    remoteConnectionBlock.includes('const attempt = startConnectionAttempt()') &&
    remoteConnectionBlock.indexOf('connectedSessionId = await connectProfile') <
      remoteConnectionBlock.indexOf('if (!await attachTerminalEvents())') &&
    remoteConnectionBlock.indexOf('const active = await verifyTerminalSessionStillActive(connectedSessionId)') <
      remoteConnectionBlock.indexOf('terminalInputReady = true') &&
    localConnectionBlock.indexOf('sessionId = requestedSessionId') <
      localConnectionBlock.indexOf('connectLocalTerminal(size.cols, size.rows, requestedSessionId)') &&
    localConnectionBlock.indexOf('const active = await verifyTerminalSessionStillActive(connectedSessionId)') <
      localConnectionBlock.indexOf('terminalInputReady = true') &&
    terminalPane.includes("status.value !== 'preview' && !terminalBackendInputReady()") &&
    terminalPane.includes('if (terminal && terminalBackendInputReady())'),
  'Terminal input must stay detached during connection setup and become writable only after listeners, liveness, attempt, and session checks succeed.'
)

assert(
  terminalPane.includes('function restartLocalTerminal()') &&
    terminalPane.includes('connectLocal()') &&
    terminalPane.includes('New Local Shell'),
  'TerminalPane must provide an in-terminal action to start a new local shell after disconnect or shell exit.'
)

assert(
  terminalPane.includes('No active shell') &&
    !terminalPane.includes('Starting local terminal...'),
  'TerminalPane idle state must not claim a local terminal is starting when no shell is attached.'
)

assert(
  terminalPane.includes('activeSession = ref') &&
    terminalPane.includes('activeSessionProfile') &&
    !terminalPane.includes("profile ? `${profile.gateway.host") &&
    !terminalPane.includes("profile ? `${profile.target.username"),
  'TerminalPane must render active terminal session metadata, not the currently selected profile draft.'
)

assert(
  !appShell.includes("selectedProfile?.name ?? 'Local Terminal'"),
  'The session tab must not show a selected profile as if it were the active terminal session.'
)

assert(
  aiConfig.includes('v-model="draft.baseUrl"') &&
    aiConfig.includes('v-model="draft.model"') &&
    aiConfig.includes('v-model="draft.apiKey"') &&
    aiConfig.includes("emit('save'"),
  'AI configuration must be editable and emit a save event instead of rendering readonly sample data.'
)

assert(
  fileTransfer.includes('type="file"') &&
    fileTransfer.includes('triggerUpload') &&
    fileTransfer.includes('remoteDropActive') &&
    fileTransfer.includes('handleRemoteDragEnter') &&
    fileTransfer.includes('handleRemoteDrop') &&
    fileTransfer.includes('uploadDroppedLocalPaths') &&
    fileTransfer.includes('onTauriFileDrop') &&
    fileTransfer.includes('onTauriFileDropHover') &&
    fileTransfer.includes('onTauriFileDropCancelled') &&
    fileTransfer.includes('remoteDropZone') &&
    fileTransfer.includes('isRemoteDropZoneVisible') &&
    fileTransfer.includes('dataTransferLocalPaths') &&
    fileTransfer.includes('isDuplicateDroppedPaths') &&
    fileTransfer.includes('remote-drop-overlay') &&
    fileTransfer.includes("@drop=\"handleRemoteDrop\"") &&
    fileTransfer.includes("itemKind: 'item'") &&
    fileTransfer.includes('sftpListDirectory') &&
    fileTransfer.includes('sftpUploadFile') &&
    fileTransfer.includes('sftpUploadPath') &&
    fileTransfer.includes('sftpDownloadFile') &&
    fileTransfer.includes('sftpDownloadPath') &&
    fileTransfer.includes('sftpDeletePath') &&
    fileTransfer.includes('localHomeDirectory') &&
    fileTransfer.includes('localListDirectory') &&
    fileTransfer.includes('localOpenPath') &&
    !fileTransfer.includes('@tauri-apps/api/shell') &&
    !fileTransfer.includes('openShellPath') &&
    fileTransfer.includes('await localOpenPath(entry.path)') &&
    fileTransfer.includes('await localOpenPath(task.targetPath)') &&
    fileTransfer.includes('localEntries') &&
    fileTransfer.includes('selectedLocalEntry') &&
    fileTransfer.includes('selectedRemoteEntry') &&
    fileTransfer.includes('openLocalFileLocation') &&
    fileTransfer.includes('openLocalContextMenu') &&
    fileTransfer.includes('openRemoteContextMenu') &&
    fileTransfer.includes('fileContextMenu') &&
    fileTransfer.includes('file-type-icon') &&
    fileTransfer.includes('cancelTask') &&
    fileTransfer.includes('activeTask') &&
    fileTransfer.includes('cancelActiveTask') &&
    fileTransfer.includes('sftpProbe') &&
    fileTransfer.includes('sftpProbeByHost') &&
    fileTransfer.includes('probeSelectedTarget') &&

    fileTransfer.includes('selectedTarget') &&
    fileTransfer.includes("transferMode = ref<'sftp' | 'terminal'>") &&
    fileTransfer.includes('uploadFilesThroughTerminal') &&
    fileTransfer.includes('downloadThroughTerminal') &&
    fileTransfer.includes('identifyCurrentTerminalTarget') &&
    fileTransfer.includes('currentTerminalTarget') &&
    fileTransfer.includes('useTerminalTargetForSftp') &&
    fileTransfer.includes('openCurrentTerminalSftp') &&
    fileTransfer.includes('useConfiguredTargetForSftp') &&
    fileTransfer.includes('active: boolean') &&
    fileTransfer.includes('initializeRemoteBrowserIfActive') &&
    fileTransfer.includes('() => props.activationSequence') &&
    fileTransfer.includes('options.useForSftp && !props.active') &&
    workspacePanel.includes(':active="!collapsed && activeWorkspaceTab === \'sftp\'"') &&
    !fileTransfer.includes('hasRemoteShellSnapshot') &&
    fileTransfer.includes('useForSftp') &&
    fileTransfer.includes('writeTerminalInput') &&
    fileTransfer.includes('remoteReady') &&
    tauri.includes("invoke<LocalDirectoryResponse>('local_list_directory'") &&
    tauri.includes("invoke<void>('local_open_path'") &&
    tauri.includes("listen<string[]>('tauri://file-drop'") &&
    tauri.includes("listen<string[]>('tauri://file-drop-hover'") &&
    tauri.includes("listen('tauri://file-drop-cancelled'") &&
    commands.includes('pub async fn local_open_path') &&
    commands.includes('open_path as open_local_path_impl') &&
    localFilesystem.includes('pub fn open_path') &&
    localFilesystem.includes('open_platform_path') &&
    localFilesystem.includes('explorer.exe') &&
    localFilesystem.includes('CREATE_NO_WINDOW') &&
    localFilesystem.includes('xdg-open') &&
    tauri.includes("invoke<boolean>('cancel_task'") &&
    tauri.includes("invoke<SftpListResponse>('sftp_list_directory'") &&
    tauri.includes("invoke<SftpTransferResponse>('sftp_upload_path'") &&
    tauri.includes("invoke<SftpTransferResponse>('sftp_download_path'") &&
    tauri.includes("invoke<SftpProbeResponse>('sftp_probe'") &&

    styles.includes('.sftp-workbench-active .right-panel') &&
    styles.includes('grid-column: 3 / 5;') &&
    styles.includes('grid-template-columns: minmax(320px, 1fr) minmax(320px, 1fr);') &&
    styles.includes('.file-type-icon.folder') &&
    styles.includes('.remote-pane.drop-active') &&
    styles.includes('.remote-drop-overlay') &&
    styles.includes('.theme-light .remote-drop-overlay') &&
    styles.includes('.file-context-menu') &&
    appShell.includes('sftpWorkbenchActive') &&
    appShell.includes('isSftpProfile(profile)') &&
    appShell.includes("workspacePanelTab.value = 'sftp'") &&
    workspacePanel.includes('workspaceTabChanged') &&
    workspacePanel.includes('@write-terminal-input=') &&
    terminalPane.includes('writeTerminalInput') &&
    terminalPane.includes('enterSftpProfileMode') &&
    terminalPane.includes('SFTP profile is ready') &&
    !fileTransfer.includes('profile ? `Ready'),
  'FileTransferPanel must expose real SFTP, current-terminal target detection, and terminal-channel small-file transfer flows without treating a selected profile draft as an active remote transfer session.'
)

assert(
  fileTransfer.includes("const begin = `AI_TERM_IDENT_BEGIN_${id}`") &&
    fileTransfer.includes("const end = `AI_TERM_IDENT_END_${id}`") &&
    fileTransfer.includes('findIdentityMarker') &&
    fileTransfer.includes('findStandaloneIdentityMarker') &&
    fileTransfer.includes('^${escapeRegExp(marker)}') &&
    fileTransfer.includes('[\\\\t ]*$') &&
    fileTransfer.includes('markerCandidates') &&
    fileTransfer.includes('identityMarkerId') &&
    fileTransfer.includes('raw.matchAll(/(user|hostname|ips|pwd)=/g)') &&
    !fileTransfer.includes('`__AI_TERM_IDENT_BEGIN_${id}__`') &&
    appShell.includes('function isActiveTerminalOnlyInput') &&
    appShell.includes("data.includes('AI_TERM_IDENT_')") &&
    appShell.includes("data.includes('AI_TERM_DOWNLOAD_')") &&
    appShell.includes("data.includes('AI_TERM_UPLOAD_')") &&
    appShell.includes('writeInputToActiveTerminal(data)'),
  'SFTP terminal identity detection must parse robust plain markers and send terminal-channel probes only to the active terminal snapshot.'
)

assert(
  workspacePanel.includes('const sftpTabActivationSequence = ref(0)') &&
    workspacePanel.includes('sftpTabActivationSequence.value += 1') &&
    workspacePanel.includes(':activation-sequence="sftpTabActivationSequence"') &&
    fileTransfer.includes('activationSequence: number') &&
    fileTransfer.includes('const isBastionConnection = computed') &&
    fileTransfer.includes('() => props.activationSequence') &&
    fileTransfer.includes('function activateSftpTab()') &&
    fileTransfer.includes('selectedBastionTargetIsCurrent.value') &&
    fileTransfer.includes("@click=\"selectTransferMode('sftp')\"") &&
    !fileTransfer.includes('watch(transferMode') &&
    !fileTransfer.includes('onMounted(() => {\n  initializeRemoteBrowserIfActive()') &&
    fileTransfer.includes('host: isBastionConnection.value ? terminalTarget.ip : terminalTarget.host') &&
    fileTransfer.includes(': probe.path || terminalTarget.pwd ||') &&
    fileTransfer.includes('resetTerminalIdentityProbeForRetry') &&
    fileTransfer.includes('已停止 SFTP 探测。'),
  'Bastion SFTP must retain a successful target across tab activations, prefer the SFTP-reported path, and only detect the terminal target when needed.'
)

assert(
  appShell.includes('connectionGeneration: number') &&
    appShell.includes('connectionGeneration: !wasConnected && isConnected') &&
    appShell.includes('? tab.connectionGeneration + 1') &&
    appShell.includes(':terminal-status="activeTerminal?.status ?? \'idle\'"') &&
    appShell.includes(':terminal-connection-generation="activeTerminal?.connectionGeneration ?? 0"') &&
    workspacePanel.includes('terminalStatus:') &&
    workspacePanel.includes('terminalConnectionGeneration: number') &&
    workspacePanel.includes(':terminal-status="terminalStatus"') &&
    workspacePanel.includes(':terminal-connection-generation="terminalConnectionGeneration"') &&
    fileTransfer.includes('terminalStatus: TerminalRuntimeStatus') &&
    fileTransfer.includes('terminalConnectionGeneration: number') &&
    fileTransfer.includes('requiresExplicitBastionProbe') &&
    fileTransfer.includes('bastionAutoProbeAttempted') &&
    fileTransfer.includes('targetConnectionGeneration') &&
    fileTransfer.includes('remoteRequestEpoch') &&
    fileTransfer.includes('connectionRole = props.profile?.connectionRole') &&
    fileTransfer.includes('cancelActiveRemoteTaskForStateChange()') &&
    fileTransfer.includes('normalizeInterruptedBastionProbeForStateSave()') &&
    fileTransfer.includes('() => props.active') &&
    fileTransfer.includes('invalidateBastionTarget') &&
    fileTransfer.includes('if (!bastionAutoProbeAttempted.value)') &&
    fileTransfer.includes('openCurrentTerminalSftp({ automatic: true })') &&
    fileTransfer.includes('if (!isBastionConnection.value || !terminalDetectionReady.value') &&
    fileTransfer.includes("invalidateBastionTarget('终端连接已断开；上次 SFTP 目标已失效") &&
    fileTransfer.includes('isCurrentRemoteRequest(requestEpoch, requestStateKey, requestGeneration)') &&
    fileTransfer.includes('if (detectionEpoch !== remoteRequestEpoch) return') &&
    fileTransfer.includes('activeTask.value?.id !== taskId') &&
    fileTransfer.indexOf('activeTask.value?.id !== taskId') < fileTransfer.indexOf('const response = await action(taskId)') &&
    fileTransfer.includes('if (!isBastionConnection.value)') &&
    fileTransfer.includes('if (isBastionConnection.value)') &&
    fileTransfer.includes('openCurrentTerminalSftp') &&
    fileTransfer.includes('v-if="isBastionConnection"') &&
    !fileTransfer.includes('maybeAutoProbeCurrentTerminalSftp') &&
    !fileTransfer.includes('配置目标 SFTP 失败，正在自动识别当前终端服务器...'),
  'Direct connections must use configured SFTP only; bastion targets may be probed explicitly and must be invalidated across terminal disconnects or connection generations.'
)

assert(
  workspaceTypes.includes('interface TerminalOutputDeltaEvent extends TerminalOutputEvent') &&
    appShell.includes('terminalOutputEvents') &&
    appShell.includes('terminalOutputSequence') &&
    appShell.includes('activeTerminalOutputEvent') &&
    appShell.includes('@focus-terminal="focusActiveTerminalFromWorkspace"') &&
    terminalPane.includes('function focusTerminal()') &&
    terminalPane.includes('focusTerminal,') &&
    workspacePanel.includes('sftpPanelVisited') &&
    workspacePanel.includes("if (tab === 'sftp') {") &&
    workspacePanel.includes('v-if="sftpPanelVisited"') &&
    workspacePanel.includes(`v-show="activeWorkspaceTab === 'sftp'"`) &&
    workspacePanel.includes(':terminal-id="terminalId"') &&
    workspacePanel.includes(':terminal-output-event="terminalOutputEvent"') &&
    workspacePanel.includes('@focus-terminal="emit(\'focusTerminal\')"') &&
    fileTransfer.includes('terminalId: string') &&
    fileTransfer.includes('terminalOutputEvent?: TerminalOutputDeltaEvent') &&
    fileTransfer.includes('transferStateByTerminal') &&
    fileTransfer.includes('saveTransferState(previousKey)') &&
    fileTransfer.includes('restoreTransferState(key)') &&
    fileTransfer.includes('PendingIdentityProbe') &&
    fileTransfer.includes('pendingIdentify.value.output') &&
    fileTransfer.includes('identityProbeText') &&
    fileTransfer.includes('snapshot.slice(-160_000)') &&
    appShell.includes('nextSnapshot.slice(-80_000)') &&
    fileTransfer.includes('sftp-terminal-switch') &&
    fileTransfer.includes('切换到终端') &&
    styles.includes('.sftp-terminal-switch'),
  'SFTP workspace must stay mounted across tab switches, parse terminal identity from output deltas, and expose a clear switch-back-to-terminal action.'
)
assert(
  fileTransfer.includes('lastTransfer') &&
    fileTransfer.includes('transfer-target-strip') &&
    fileTransfer.includes('sftpHeaderSummary') &&
    fileTransfer.includes('localPaneSummary') &&
    fileTransfer.includes('remotePaneSummary') &&
    fileTransfer.includes('formatRemoteModified') &&
    fileTransfer.includes('REMOTE_DIRECTORY_CACHE_TTL_MS') &&
    fileTransfer.includes('remoteDirectoryCache') &&
    fileTransfer.includes('remoteDirectoryRequests') &&
    fileTransfer.includes('cachedRemoteDirectory') &&
    fileTransfer.includes('invalidateRemoteDirectoryCache') &&
    fileTransfer.includes('const directoryLoading = ref(false)') &&
    fileTransfer.includes('const remoteBusy = computed(() => loading.value || directoryLoading.value || identifying.value)') &&
    fileTransfer.includes(':aria-busy="directoryLoading"') &&
    fileTransfer.includes('class="transfer-pane-summary"') &&
    fileTransfer.includes('directoryLoading && entries.length === 0') &&
    fileTransfer.includes('await sftpListDirectory(props.connectionId, requestedPath, targetOverride.value)') &&
    !fileTransfer.includes("const taskId = startRemoteTask(cached ? '刷新远端目录' : '读取远端目录')") &&
    !fileTransfer.includes("status.value = '正在读取目录...'") &&
    fileTransfer.includes('options: LoadDirectoryOptions') &&
    fileTransfer.includes('await loadDirectory(currentPath.value, { force: true })') &&
    fileTransfer.includes('@click="loadDirectory(currentPath, { force: true })"') &&
    fileTransfer.includes('sftp-title-copy') &&
    fileTransfer.includes('transfer-route-item') &&
    fileTransfer.includes('transfer-pane-title') &&
    fileTransfer.includes('transfer-pane-path') &&
    fileTransfer.includes('file-meta') &&
    fileTransfer.includes(`UiIcon :name="entry.isDir ? 'folder' : 'file'"`) &&
    fileTransfer.includes('name="arrow-up"') &&
    fileTransfer.includes('role="tablist"') &&
    fileTransfer.includes(':aria-selected=') &&
    fileTransfer.includes(':title="entry.name"') &&
    fileTransfer.includes("entry.permissions || '权限未知'") &&
    fileTransfer.includes('transfer-progress') &&
    fileTransfer.includes('transfer-task-stats') &&
    fileTransfer.includes('transferAmountLabel') &&
    fileTransfer.includes('transferSpeedLabel') &&
    fileTransfer.includes('transferRemainingLabel') &&
    fileTransfer.includes('transferCompletionLabel') &&
    fileTransfer.includes('openLastTransferLocation') &&
    fileTransfer.includes('copyLastTransferPath') &&
    fileTransfer.includes('joinLocalPath') &&
    fileTransfer.includes('onSftpTransferProgress') &&
    tauri.includes('localPath?: string') &&
    tauri.includes('remotePath?: string') &&
    tauri.includes('targetPath?: string') &&
    tauri.includes('transferredBytes?: number') &&
    tauri.includes('bytesPerSecond?: number') &&
    tauri.includes('estimatedCompletionEpochMs?: number') &&
    tauri.includes('onSftpTransferProgress') &&
    styles.includes('.transfer-target-strip') &&
    styles.includes('.sftp-panel-head') &&
    styles.includes('.sftp-title-copy') &&
    styles.includes('.transfer-target-strip .transfer-route-item') &&
    styles.includes('.transfer-pane-title') &&
    styles.includes('.transfer-pane-summary') &&
    styles.includes('.remote-pane.directory-loading .file-row') &&
    styles.includes('.transfer-pane-path') &&
    styles.includes('.file-meta') &&
    styles.includes('.file-type-icon .ui-icon') &&
    styles.includes('.file-row:hover .file-type-icon.folder') &&
    !styles.includes('.file-type-icon.folder::before') &&
    !styles.includes('.file-type-icon.file::after') &&
    styles.includes('.file-row:hover .file-actions') &&
    styles.includes('rgba(86, 230, 163, .12)') &&
    styles.includes('.theme-light .transfer-target-strip .transfer-route-item') &&
    styles.includes('.theme-light .file-meta span') &&
    styles.includes('.theme-light .transfer-pane-head') &&
    !styles.includes('\n.transfer-pane-head {\n  border-bottom-color: var(--light-border);\n  background: #fafcfb;\n}') &&
    styles.includes('/* Dark theme SFTP polish. */') &&
    styles.includes('.app-shell.theme-dark .sftp-transfer-workbench') &&
    styles.includes('.app-shell.theme-dark .transfer-pane-head') &&
    styles.includes('.app-shell.theme-dark .file-list') &&
    styles.includes('.app-shell.theme-dark .transfer-progress span') &&
    styles.includes('.app-shell.theme-dark .workspace-tabs button.active') &&
    styles.includes('.transfer-progress') &&
    styles.includes('.transfer-task-stats') &&
    styles.includes('@keyframes transfer-progress-slide') &&
    sftpBackend.includes('SftpProgressUpdate') &&
    sftpBackend.includes('transferred_bytes: Option<u64>') &&
    sftpBackend.includes('bytes_per_second: Option<u64>') &&
    sftpBackend.includes('format_duration_compact') &&
    sftpBackend.includes('extract_sftp_progress_percent') &&
    sftpBackend.includes('download_target_path') &&
    commands.includes('SftpTransferEvent') &&
    commands.includes('estimated_completion_epoch_ms') &&
    commands.includes('upload_path_with_progress') &&
    commands.includes('download_path_with_progress'),
  'SFTP file and folder transfers must show clear local/remote targets, structured speed/size/ETA progress, final paths, and actions to locate or copy completed downloads/uploads.'
)
assert(
  appShell.includes('draftWorkspaceSessionIds') &&
    appShell.includes('createDraftWorkspaceSession') &&
    appShell.includes('ensureActiveAiSession') &&
    appShell.includes('ensurePersistedWorkspaceSession') &&
    appShell.includes('persistWorkspaceSessionForMessage') &&
    appShell.includes('saveCommandHistoryForTerminal') &&
    appShell.includes('const tab = terminalTabs.value.find((item) => item.id === event.terminalId)') &&
    appShell.includes('workspaceSessionId: COMMAND_HISTORY_SESSION_ID') &&
    appShell.includes('commandHistoryByConnection') &&
    appShell.includes('loadCommandHistoryForConnection') &&
    !appShell.includes('await ensurePersistedWorkspaceSession(entry.connectionId, entry.workspaceSessionId') &&
    appShell.includes('connectProfileFromSidebar') &&
    !appShell.includes('const session = await createWorkspaceSession(profile.id)'),
  'Global AI sessions must start as frontend drafts while command history stays scoped to the emitting connection, independently of AI conversation selection.'
)

assert(
  scriptPanel.includes("type ScriptPanelMode = 'library' | 'generate'") &&
    scriptPanel.includes("type ScriptLibraryView = 'list' | 'detail'") &&
    scriptPanel.includes('class="script-library"') &&
    scriptPanel.includes('class="script-library-editor"') &&
    scriptPanel.includes('class="script-draft-card"') &&
    scriptPanel.includes('class="script-replies-panel script-conversation"') &&
    scriptPanel.includes('hasScriptReplies && showScriptComposer') &&
    scriptPanel.includes('v-if="showScriptComposer"') &&
    scriptPanel.includes('sendActiveScriptRequest') &&
    scriptPanel.includes('highlightShellScript') &&
    scriptPanel.includes('syncScriptEditorScroll') &&
    scriptPanel.includes('placeholder="在这里粘贴、生成或编写 Shell 脚本..."') &&
    scriptPanel.includes('recordingActionLabel') &&
    scriptPanel.includes("'重新录制' : '开始录制'") &&
    scriptPanel.includes('v-if="!props.recording.isRecording"') &&
    scriptPanel.includes('<UiIcon name="stop" />停止录制') &&
    scriptPanel.includes('ContextMenu') &&
    scriptPanel.includes('openScriptEditorMenu') &&
    scriptPanel.includes('title="更多操作"') &&
    scriptPanel.includes('class="text-button script-run-button"') &&
    styles.includes('.script-conversation .script-reply-message') &&
    styles.includes('.script-panel > .script-ai-compose') &&
    scriptPanel.includes(':disabled="!canExecuteDraft"') &&
    scriptPanel.includes(':disabled="!canExecuteSelectedScript"') &&
    scriptPanel.includes(':disabled="!canExecuteExpandedScript"'),
  'Script workspace must retain library and AI generation flows while using explicit recording states, compact editor actions, and guarded run buttons.'
)

assert(
  shellCommand.includes('export function detectShellScriptLanguage') &&
    shellCommand.includes(`ShellScriptLanguage = 'bash' | 'powershell' | 'cmd' | 'shell'`) &&
    scriptPanel.includes('bashTokenPattern') &&
    scriptPanel.includes('powershellTokenPattern') &&
    scriptPanel.includes('cmdTokenPattern') &&
    scriptPanel.includes('highlightShellLine(line, language)') &&
    !scriptPanel.includes('script-language-badge') &&
    styles.includes('.script-editor-shell .script-code-overlay') &&
    styles.includes('display: block') &&
    styles.includes('-webkit-text-fill-color: transparent'),
  'Script editors must use auto-detected Bash, PowerShell, and CMD syntax highlighting without adding language badges to the toolbar.'
)

assert(
    shellCommand.includes('normalizeShellScript(content)') &&
    scriptExecution.includes('export function prepareScriptForExecution') &&
    scriptExecution.includes("language === 'powershell' || language === 'cmd') return source") &&
    scriptExecution.includes("!state.quote && state.arithmeticDepth === 0 && /^\\s*#/.test(line)") &&
    scriptExecution.includes('state.heredocs.push(...result.heredocs)') &&
    scriptPanel.includes("import { buildBashScriptTerminalInput, prepareScriptForExecution } from '../lib/scriptExecution'") &&
    scriptPanel.includes('prepareScriptForExecution(content, language)') &&
    scriptPanel.includes('buildBashScriptTerminalInput(prepared)') &&
    !scriptPanel.includes("bash -s <<'AI_TERM_SCRIPT'") &&
    (scriptPanel.match(/wrap="off"/g) ?? []).length >= 3 &&
    scriptPanel.includes('@scroll="syncDraftLineRail"') &&
    scriptPanel.includes('@scroll="syncSelectedScriptLineRail"') &&
    scriptPanel.includes('@scroll="syncExpandedScriptLineRail"'),
  'Script source comments must remain editable, be filtered only at execution, and keep all editor layers synchronized without soft wrapping.'
)

assertLastCssDeclarations(
  '.script-editor-shell',
  {
    '--script-editor-line-height': '18px',
    '--script-editor-scrollbar-gutter': '0px'
  },
  'Script editor must define one explicit line-height metric for every visual layer.'
)

assertLastCssDeclarations(
  ':root[data-platform="windows"] .script-editor-shell',
  { '--script-editor-scrollbar-gutter': '10px' },
  'Windows script editors must compensate mirror layers for native scrollbar geometry.'
)

for (const selector of [
  '.script-editor-shell .script-line-rail',
  '.script-editor-shell .script-code-overlay',
  ':root .script-editor-shell textarea'
]) {
  assertLastCssDeclarations(
    selector,
    {
      'font-family': 'var(--font-mono)',
      'font-size': 'var(--font-sm)',
      'line-height': 'var(--script-editor-line-height)',
      'padding-top': '10px'
    },
    'Script line numbers, syntax highlighting, and input text must share identical vertical geometry.'
  )
}

for (const selector of [
  '.script-editor-shell .script-line-rail',
  '.script-editor-shell .script-code-overlay'
]) {
  assertLastCssDeclarations(
    selector,
    { 'padding-bottom': 'calc(24px + var(--script-editor-scrollbar-gutter))' },
    'Script mirror layers must retain enough scroll range to follow a textarea with native scrollbars.'
  )
}

assertLastCssDeclarations(
  ':root .script-editor-shell textarea',
  { 'padding-bottom': '24px' },
  'The textarea keeps its content padding while only mirror layers receive scrollbar compensation.'
)

assertLastCssDeclarations(
  '.script-editor-shell .script-code-overlay .shell-token',
  {
    font: 'inherit',
    'font-feature-settings': 'inherit',
    'font-kerning': 'inherit',
    'font-variant-ligatures': 'inherit',
    'letter-spacing': 'inherit'
  },
  'Syntax colors must not change glyph metrics used by the native textarea caret.'
)

assert(
  scriptPanel.includes('normalizeScriptEditorContent(content)') &&
    scriptPanel.includes("content.replace(/\\r\\n?/g, '\\n')") &&
    lastCssDeclaration('.script-editor-shell .script-code-overlay', 'text-rendering') !== 'geometricPrecision',
  'Script editor mirrors must normalize line endings and preserve platform-native text rendering.'
)

assert(
  scriptReadiness.includes('analyzeScriptReadiness') &&
    scriptReadiness.includes("'empty-value' | 'todo' | 'placeholder'") &&
    scriptReadiness.includes('EMPTY_ASSIGNMENT_PATTERN') &&
    scriptReadiness.includes('TODO_PATTERN') &&
    scriptReadiness.includes('PLACEHOLDER_PATTERN') &&
    scriptPanel.includes("import { analyzeScriptReadiness, scriptReadinessStatusForContent }") &&
    scriptPanel.includes('draftScriptReadiness') &&
    scriptPanel.includes('selectedScriptReadiness') &&
    scriptPanel.includes('scriptRiskDisplayLabel') &&
    scriptPanel.includes("return '未发现高风险'") &&
    scriptReadiness.includes("label: '填写完整'") &&
    scriptPanel.includes('脚本尚未填写完整') &&
    scriptPanel.includes("'has-risk': draftScriptRiskStatus.level === 'medium' || draftScriptRiskStatus.level === 'high'") &&
    scriptPanel.includes("'high-risk-run': draftScriptRiskStatus.level === 'high'") &&
    scriptPanel.includes('draftEditorCursor') &&
    scriptPanel.includes('selectedEditorCursor') &&
    scriptPanel.includes('Shell &middot; UTF-8 &middot; LF') &&
    scriptPanel.includes('script-dirty-dot') &&
    styles.includes('/* Script workbench final density and readiness pass. */') &&
    styles.includes('.script-readiness-status.readiness-pending') &&
    styles.includes('.script-editor-tools .script-run-button') &&
    styles.includes('.script-file-tab.has-risk .script-editor-risk') &&
    styles.includes('.script-file-tab .script-editor-risk.risk-high') &&
    styles.includes('.script-editor-tools .script-run-button.high-risk-run') &&
    styles.includes('grid-template-columns: 34px minmax(0, 1fr)') &&
    styles.includes('.app-shell.theme-light .script-readiness-status.readiness-pending') &&
    styles.includes('.app-shell.theme-light .shell-token.comment'),
  'Script editor must separate readiness from risk, block incomplete scripts across execution paths, show real cursor/save state, and preserve dark/light readability.'
)
assert(
  sidebar.includes('v-model="selectedProfile.target.host"') &&
    sidebar.includes('v-model="selectedProfile.target.username"') &&
    sidebar.includes('v-model.number="selectedProfile.target.port"') &&
    sidebar.includes('v-model="selectedProfile.connectionRole"') &&
    appShell.includes("normalized.connectionRole = normalized.connectionRole === 'bastion' ? 'bastion' : 'direct'") &&
    appShell.includes("normalized.gateway = {") &&
    appShell.includes("normalized.jumpMode = 'direct'") &&
    appShell.includes("normalized.fileTransferMode = 'auto'") &&
    !sidebar.includes('v-model="selectedProfile.gateway.host"'),
  'ConnectionSidebar must keep direct target connection fields editable and AppShell must normalize away legacy gateway fields.'
)

assert(
  sidebar.includes("return 'SSH 端口'") &&
    !sidebar.includes('服务器端口') &&
    appShell.includes("normalizePort(normalized.target.port, 'SSH port', 22)"),
  'Connection editor must label the target SSH port explicitly in the simplified direct editor.'
)

assert(
  sidebar.includes('v-model="selectedProfile.target.password"') &&
    sidebar.includes('passwordFieldType') &&
    sidebar.includes('v-model="selectedProfile.target.authMode"') &&
    appShell.includes("password: ''") &&
    !sidebar.includes('v-model="selectedProfile.gateway.password"'),
  'ConnectionSidebar must let users enter direct SSH passwords while backend storage moves them into the system credential store.'
)

assert(
  sidebar.includes('showTargetPassword') &&
    sidebar.includes('passwordFieldType') &&
    sidebar.includes('password-input-wrap') &&
    sidebar.includes('password-visibility-button') &&
    !sidebar.includes('showGatewayPassword') &&
    uiIcon.includes("'eye'") &&
    uiIcon.includes("'eye-off'") &&
    styles.includes('.password-visibility-button'),
  'Connection editor target password field must support an explicit show/hide eye button for saved credentials.'
)

assert(
  sidebar.includes('系统凭据管理器') &&
    settingsSidebar.includes('系统凭据管理器') &&
    aiConfig.includes('系统凭据管理器') &&
    !sidebar.includes('明文保存') &&
    !aiConfig.includes('明文保存'),
  'Credential UI copy must describe system credential storage instead of plaintext SQLite storage.'
)

assert(
  credentials.includes('pub struct SystemCredentialStore') &&
    credentials.includes('CredWriteW') &&
    credentials.includes('secret-tool') &&
    credentials.includes('security') &&
    sqlite.includes('with_system_credentials') &&
    sqlite.includes('with_credential_store') &&
    sqlite.includes('credential_store') &&
    sqlite.includes('Option::<String>::None') &&
    tauriLib.includes('SqliteConfigStore::with_system_credentials'),
  'Sensitive SSH passwords and AI API keys must be saved through the system credential store, with SQLite retaining only credential references.'
)

assert(
  sidebar.includes('SSH 主机') &&
    sidebar.includes('登录用户名') &&
    sidebar.includes('堡垒机用户名 或 堡垒机用户名/服务器IP/服务器用户名') &&
    sidebar.includes('SSH 密码') &&
    sidebar.includes('SSH 端口') &&
    !sidebar.includes('value="interactive-menu"') &&
    !sidebar.includes('sftp-gateway'),
  'ConnectionSidebar must expose a simplified direct SSH/SFTP editor without the old bastion mode selector.'
)

assert(
  sidebar.includes('function profileReady') &&
    sidebar.includes('function shouldShowTargetPassword') &&
    sidebar.includes('targetUsernamePlaceholder') &&
    sidebar.includes('SSH / SFTP') &&
    sidebar.includes('连接服务器') &&
    !sidebar.includes('function needsGateway') &&
    !sidebar.includes('function needsMenuProfile') &&
    !sidebar.includes('setSftpRoute'),
  'ConnectionSidebar must keep the connection editor focused on direct SSH/SFTP fields.'
)

assert(
  sidebar.includes("emit('save'") &&
    sidebar.includes('modal-backdrop') &&
    sidebar.includes('role="dialog"') &&
    appShell.includes('@save="saveSelectedProfile"'),
  'ConnectionSidebar must provide a modal save action wired to profile persistence.'
)

assert(
  sidebar.includes("connect: [profileId: string]") &&
    sidebar.includes('@dblclick=') &&
    sidebar.includes('@click.stop=') &&
    sidebar.includes("emit('connect', profile.id)") &&
    appShell.includes('@connect="connectProfileFromSidebar"'),
  'ConnectionSidebar must own the primary connect action and support double-clicking a connection card.'
)

assert(
  sidebar.includes("copy: [profileId: string]") &&
    sidebar.includes("emit('openMenu', $event, profile.id)") &&
    sidebar.includes('title="更多操作"') &&
    !sidebar.includes("emit('copy', profile.id)") &&
    appShell.includes('function copySelectedProfile') &&
    appShell.includes('@copy="copySelectedProfile"') &&
    appShell.includes("id: 'copy'") &&
    appShell.includes('nextConnectionProfileId') &&
    appShell.includes('nextConnectionProfileName') &&
    styles.includes('.server-card .card-actions') &&
    styles.includes('grid-template-columns: repeat(2, 26px);'),
  'ConnectionSidebar must keep profile duplication available through the compact more menu instead of crowding every connection card.'
)

assert(
  !sidebar.includes('selected-summary') &&
    !settingsSidebar.includes('settings-summary') &&
    !sidebar.includes('sidebar-footer') &&
    !settingsSidebar.includes('sidebar-footer') &&
    styles.includes('grid-template-rows: 58px 62px minmax(0, 1fr);') &&
    styles.includes('grid-template-rows: 58px minmax(0, 1fr);'),
  'Left sidebars must avoid the old lower preview/footer blocks and let lists own the available space.'
)

assert(
  contextMenu.includes('role="menu"') &&
    contextMenu.includes('role="menuitem"') &&
    appShell.includes('openConnectionContextMenu') &&
    appShell.includes('openAiConfigContextMenu') &&
    appShell.includes('openTerminalTabContextMenu') &&
    appShell.includes('openTerminalAreaContextMenu') &&
    sidebar.includes('openMenu') &&
    settingsSidebar.includes('openMenu') &&
    styles.includes('.context-menu'),
  'The client UI must provide custom right-click context menus for connections, AI configs, and terminal surfaces.'
)

assert(
  !appShell.includes('structuredClone(') &&
    appShell.includes('cloneConnectionProfile') &&
    appShell.includes('connectionDraft') &&
    appShell.includes('connectingProfileId') &&
    appShell.includes('connectionError') &&
    sidebar.includes('connectingProfileId') &&
    sidebar.includes('connectionError'),
  'Connection flow must safely clone Vue profile objects and show visible connecting/error feedback.'
)

assert(
  !appShell.includes('@click="connectSelectedProfile"') &&
    !appShell.includes('@click="saveSelectedProfile"'),
  'Profile save/connect controls must live in the left connection sidebar, not the global top toolbar.'
)

assert(
  appShell.includes("jumpMode: 'direct'") &&
    appShell.includes("connectionRole: 'direct'") &&
    appShell.includes("menuProfileId: ''"),
  'New connection drafts must default to ordinary direct SSH instead of requiring bastion fields.'
)

assert(
  !sidebar.includes('????') &&
    sidebar.includes('SSH 主机') &&
    sidebar.includes('登录用户名') &&
    sidebar.includes('SSH 密码') &&
    sidebar.includes('SSH 端口'),
  'Connection editor labels must not contain mojibake placeholders.'
)

assert(
  tauri.includes('listConnectionProfiles') &&
    tauri.includes('saveConnectionProfile') &&
    tauri.includes('deleteConnectionProfile') &&
    appShell.includes('await listConnectionProfiles()') &&
    appShell.includes('await saveConnectionProfile(normalizedProfile)') &&
    appShell.includes('await deleteConnectionProfile(profileId)') &&
    sidebar.includes("delete: [profileId: string]") &&
    sidebar.includes("emit('save'") &&
    appShell.includes("id: 'delete'") &&
    appShell.includes('@save="saveSelectedProfile"'),
  'Connection profiles must support SQLite-backed create/read/update/delete through Tauri commands.'
)

assert(
  appShell.includes('terminalTabs = ref') &&
    appShell.includes('activeTerminalId') &&
    appShell.includes('createTerminalTab') &&
    appShell.includes('closeTerminalTab') &&
    appShell.includes('session-tabs'),
  'AppShell must manage multiple terminal tabs instead of a single fixed terminal.'
)

assert(
  appShell.includes('leftCollapsed') &&
    appShell.includes('rightCollapsed') &&
    appShell.includes('leftPanelMode') &&
    appShell.includes('toggleConnectionsPanel') &&
    appShell.includes('toggleSettingsPanel') &&
    appShell.includes('isLeftPanelActive') &&
    appShell.includes('leftPanelButtonTitle') &&
    !appShell.includes('sidebar-collapse-button') &&
    !styles.includes('.sidebar-collapse-button') &&
    !appShell.includes('toggle-left') &&
    !appShell.includes('toggle-right') &&
    !appShell.includes('top-actions') &&
    appShell.includes('workspace-open-handle') &&
    appShell.includes('@close="rightCollapsed = true"') &&
    workspacePanel.includes("emit('close')") &&
    workspacePanel.includes('workspace-close'),
  'Terminal workspace must allow hiding both the left connection sidebar and the right workspace.'
)

assert(
  workspacePanel.includes("activeWorkspaceTab = ref<'history' | 'ai' | 'scripts' | 'sftp'>") &&
    workspacePanel.includes("activeWorkspaceTab === 'history'") &&
    workspacePanel.includes("activeWorkspaceTab === 'ai'") &&
    workspacePanel.includes("activeWorkspaceTab === 'scripts'") &&
    workspacePanel.includes("activeWorkspaceTab === 'sftp'") &&
    workspacePanel.includes('selectWorkspaceSession') &&
    workspacePanel.includes('createWorkspaceSession') &&
    workspacePanel.includes('renameWorkspaceSession') &&
    workspacePanel.includes('deleteWorkspaceSession') &&
    aiPanel.includes('session-history-popover') &&
    aiPanel.includes('historyPopover') &&
    aiPanel.includes('historyButton') &&
    aiPanel.includes('handleDocumentPointerDown') &&
    aiPanel.includes("document.addEventListener('pointerdown'") &&
    aiPanel.includes('filteredSessions') &&
    aiPanel.includes('sessionSearch') &&
    aiPanel.includes("emit('createSession')") &&
    aiPanel.includes("emit('renameSession'") &&
    aiPanel.includes('openRenameSessionDialog') &&
    aiPanel.includes('submitRenameSession') &&
    aiPanel.includes('rename-modal') &&
    !aiPanel.includes('window.prompt') &&
    aiPanel.includes("emit('deleteSession'") &&
    aiPanel.includes('generateAiSessionTitle') &&
    aiPanel.includes('maybeGenerateSessionTitle') &&
    aiPanel.includes("emit('updateSessionTitle'") &&
    appShell.includes('updateWorkspaceSessionTitle') &&
    appShell.includes('isAutoWorkspaceSessionName') &&
    workspacePanel.includes('CommandHistoryPanel') &&
    workspacePanel.includes('AiPanel'),
  'Right workspace must expose history, AI, SFTP, and AI session history controls.'
)

assert(
  terminalPane.includes('terminalOutput:') &&
    terminalPane.includes('terminalSelection:') &&
    terminalPane.includes('commandRecorded:') &&
    terminalPane.includes('defineExpose') &&
    terminalPane.includes('executeCommand') &&
    terminalPane.includes('onSelectionChange') &&
    terminalPane.includes('getSelectionPosition') &&
    terminalPane.includes('copySelectionToClipboard') &&
    terminalPane.includes('normalizedTerminalSelectionText') &&
    terminalPane.includes('polishTerminalSelection') &&
    terminalPane.includes('scheduleTerminalSelectionPolish') &&
    terminalPane.includes('terminalSelectionOverlay') &&
    terminalPane.includes('terminalSelectionDragging') &&
    terminalPane.includes('handleTerminalSelectionPointerMove') &&
    terminalPane.includes('startTerminalSelectionDrag') &&
    terminalPane.includes('stopTerminalSelectionDrag') &&
    terminalPane.includes("window.addEventListener('pointermove', handleTerminalSelectionPointerMove, true)") &&
    terminalPane.includes("window.removeEventListener('pointermove', handleTerminalSelectionPointerMove, true)") &&
    terminalPane.includes('clearTerminalSelectionOverlay') &&
    terminalPane.includes('terminalSelectionCellToViewport') &&
    terminalPane.includes('terminal?.buffer.active.viewportY') &&
    terminalPane.includes('cell.y - viewportY') &&
    terminalPane.includes('rawStart') &&
    terminalPane.includes('rawEnd') &&
    terminalPane.includes('isReverseSelection') &&
    terminalPane.includes('isReverseMultiLineSelection') &&
    terminalPane.includes('TerminalSelectionViewportCell') &&
    terminalPane.includes('terminalPointerViewportCell') &&
    terminalPane.includes('terminalSelectionDragStart') &&
    terminalPane.includes('terminalSelectionDragCurrent') &&
    terminalPane.includes('isPointerReverseSelection') &&
    terminalPane.includes('startTerminalSelectionDrag(event)') &&
    terminalPane.includes('ai-term-selection-overlay') &&
    terminalPane.includes('ai-term-selection-line') &&
    terminalPane.includes("host.classList.add('ai-term-selection-polished')") &&
    terminalPane.includes('pasteClipboardToTerminal') &&
    terminalPane.includes("@tauri-apps/api/clipboard") &&
    terminalPane.includes('readClipboardText') &&
    terminalPane.includes('writeClipboardText') &&
    terminalPane.includes("addEventListener('pointerdown', handleTerminalPointerDown, true)") &&
    terminalPane.includes("addEventListener('contextmenu', handleTerminalContextMenu, true)") &&
    terminalPane.includes('requestTerminalPaste') &&
    terminalPane.includes('terminalInput: [event: TerminalInputEvent]') &&
    terminalPane.includes("emit('terminalInput'") &&
    appShell.includes('terminalSelections') &&
    appShell.includes('updateTerminalSelection') &&
    appShell.includes('@terminal-input="syncTerminalInputToTargets"'),
  'TerminalPane must expose terminal output, selection context, command history events, selection auto-copy, right-click paste, and an executeCommand bridge.'
)

assert(
  aiConfig.includes('v-model="draft.baseUrl"') &&
    aiConfig.includes('v-model="draft.model"') &&
    aiConfig.includes('v-model="draft.apiKey"') &&
    aiConfig.includes("emit('save'"),
  'AI configuration must be editable and emit a save event instead of rendering readonly sample data.'
)

assert(
    workspacePanel.includes(':terminal-snapshot="terminalSnapshot"') &&
    workspacePanel.includes(':terminal-selection="terminalSelection"') &&
    workspacePanel.includes(':command-history="commandHistory"') &&
    workspacePanel.includes(':workspace-session-id="workspaceSessionId"') &&
    workspacePanel.includes('@execute-command=') &&
    appShell.includes('executeCommandOnTargetTerminals'),
  'AI workspace must receive current terminal content and command history and execute generated commands through the selected terminal targets.'
)

assert(
  !terminalPane.includes('class="status-bar"') &&
    !terminalPane.includes('local-shell') &&
    !terminalPane.includes('gateway:{{') &&
    styles.includes('grid-template-rows: minmax(0, 1fr) min-content;'),
  'Terminal pane must not render the old bottom local status footer.'
)

assert(
  appShell.includes('selectedTerminalIds') &&
    appShell.includes('targetTerminalIds') &&
    appShell.includes('multiTerminalInputEnabled') &&
    appShell.includes('activeTerminalTitle') &&
    appShell.includes('terminalTargetLabel') &&
    appShell.includes('terminalTargetTitle') &&
    appShell.includes('normalizedTerminalTargetIds') &&
    appShell.includes('setTerminalTargets') &&
    !appShell.includes('selectedTerminalIds.value = [id]') &&
    appShell.includes('toggleTerminalTarget') &&
    appShell.includes('selectAllTerminalTargets') &&
    appShell.includes('resetTerminalTargetsToActive') &&
    appShell.includes('syncTerminalInputToTargets') &&
    appShell.includes('writeInputToTargetTerminals') &&
    appShell.includes('for (const delay of COMMAND_EXECUTION_RETRY_DELAYS_MS)') &&
    appShell.includes("readiness === 'ready' && pane?.writeTerminalInput(data)") &&
    appShell.includes("readiness === 'line-busy'") &&
    appShell.includes('等待提示符超时') &&
    appShell.includes('脚本已部分发送') &&
    appShell.includes('terminal-target-toggle') &&
    appShell.includes('terminal-target-summary') &&
    appShell.includes('仅同步当前终端') &&
    appShell.includes('{{ terminalTargetLabel }}') &&
    appShell.includes(':title="terminalTargetTitle"') &&
    styles.includes('.terminal-target-toggle') &&
    styles.includes('.terminal-target-summary') &&
    styles.includes('.tab.target.active') &&
    styles.includes('.tab.target.sync-paused') &&
    styles.includes('box-shadow: inset 0 -2px 0 var(--workbench-accent);') &&
    styles.includes('max-width: min(260px, 28vw);') &&
    aiPanel.includes('executionTargetLabel') &&
    aiPanel.includes('executionTargetTitle') &&
    scriptPanel.includes('executionTargetLabel') &&
    scriptPanel.includes('executionTargetTitle'),
  'Terminal tabs must keep the active terminal anchored and visually distinct while selecting multiple targets for synchronized input, AI command execution, and script execution.'
)

assert(
  aiPanel.includes('chatWithAiProvider') &&
    aiPanel.includes('terminalSnapshot,') &&
    aiPanel.includes('terminalSelection?: TerminalSelectionEvent') &&
    aiPanel.includes('selectedTerminalContext') &&
    aiPanel.includes('formatSelectedLineRange') &&
    aiPanel.includes('buildQuestionWithSelectedTerminalText') &&
    aiPanel.includes('selected-terminal-note') &&
    !aiPanel.includes('selected-context-chip') &&
    !styles.includes('.selected-context-chip') &&
    aiPanel.includes('const commandHistory = props.commandHistory.map') &&
    aiPanel.includes('contextStatusLabel') &&
    aiPanel.includes('已压缩至') &&
    aiPanel.includes('messages: AiMessage[]') &&
    aiPanel.includes('const requestConnectionId = props.connectionId') &&
    aiPanel.includes('const requestWorkspaceSessionId = props.workspaceSessionId') &&
    aiPanel.includes('conversationMessages') &&
    aiPanel.includes('MAX_AI_CONVERSATION_MESSAGES') &&
    aiPanel.includes('pendingAiCommandCrossConnection') &&
    aiPanel.includes('executionTargetConnectionIds') &&
    appShell.includes('aiMessagesBySession') &&
    appShell.includes('commandHistoryByConnection') &&
    appShell.includes('const workspaceSessions = ref<WorkspaceSession[]>([])') &&
    appShell.includes("const activeAiSessionId = ref('')") &&
    appShell.includes('loadCommandHistoryForConnection') &&
    appShell.includes('loadAiSessionState') &&
    appShell.includes('loadWorkspaceSessionList') &&
    appShell.includes('createWorkspaceSession') &&
    appShell.includes('renameWorkspaceSession') &&
    appShell.includes('deleteWorkspaceSessionForActiveConnection') &&
    appShell.includes('saveCommandHistoryRecord') &&
    appShell.includes('saveAiConversationMessage') &&
    tauri.includes("invoke<UpdateScript[]>('list_update_scripts'") &&
    tauri.includes("invoke<void>('save_update_script'") &&
    tauri.includes("invoke<boolean>('delete_update_script'") &&
    tauri.includes("invoke<WorkspaceSession[]>('list_workspace_sessions'") &&
    tauri.includes("invoke<void>('save_workspace_session'") &&
    tauri.includes("invoke<boolean>('delete_workspace_session'") &&
    tauri.includes("invoke<AiSessionTitleResponse>('generate_ai_session_title'") &&
    tauri.includes("invoke<CommandHistoryEntry[]>('list_command_history'") &&
    tauri.includes("invoke<void>('save_command_history_record'") &&
    tauri.includes("invoke<AiMessage[]>('list_ai_conversation_messages'") &&
    tauri.includes("invoke<void>('save_ai_conversation_message'") &&
    tauri.includes('export function listWorkspaceSessions()') &&
    tauri.includes('export function listCommandHistory(connectionId: string)') &&
    tauri.includes('export function listAiConversationMessages(workspaceSessionId: string)') &&
    tauri.includes('export function listUpdateScripts()') &&
    appShell.includes('activeAiMessages') &&
    appShell.includes('setAiContextForTerminal') &&
    aiChat.includes('parse_model_error') &&
    aiChat.includes('build_context_bundle') &&
    aiChat.includes('build_system_prompt') &&
    aiChat.includes('conversation_messages_for_payload') &&
    aiChat.includes('accepts_plain_text_model_answer') &&
    aiPanel.includes('chatWithAiProviderStream') &&
    aiPanel.includes('cancelTask') &&
    aiPanel.includes('stopCurrentAnswer') &&
    aiPanel.includes('onAiChatStream') &&
    aiPanel.includes("event.kind === 'chunk'") &&
    aiPanel.includes('streaming: true') &&
    aiPanel.includes('handleComposerKeydown') &&
    aiPanel.includes('event.ctrlKey || event.metaKey') &&
    aiPanel.includes('event.isComposing') &&
    aiPanel.includes('scrollMessagesToLatest') &&
    aiPanel.includes('ref="messageList"') &&
    aiPanel.includes('thinking-row') &&
    appShell.includes('updateAiMessage') &&
    aiPanel.includes("import AiMarkdownMessage from './AiMarkdownMessage.vue'") &&
    aiMarkdownMessage.includes("import { parseMessageParts, renderMarkdown, type MessagePart } from '../lib/aiMarkdown'") &&
    aiPanel.includes('parseMessageParts') &&
    aiMarkdownMessage.includes('renderMarkdown') &&
    aiMarkdown.includes('export function parseMessageParts') &&
    aiMarkdown.includes('export function renderMarkdown') &&
    aiMarkdown.includes('parseMarkdownTable') &&
    aiMarkdown.includes('splitMarkdownTableRow') &&
    aiMarkdown.includes('isMarkdownTableSeparatorCell') &&
    aiMarkdown.includes('safeMarkdownUrl') &&
    aiMarkdown.includes('normalizeCodeFenceInfo') &&
    aiMarkdown.includes('```+|~~~+') &&
    shellCommand.includes('shellCommandFromCodeBlock') &&
    aiMarkdownMessage.includes('v-html="renderMarkdown(part.content)"') &&
    aiPanel.includes('answerElapsedSeconds') &&
    aiPanel.includes('formatAnswerDuration') &&
    aiPanel.includes('message-duration') &&
    styles.includes('.markdown-content') &&
    styles.includes('.markdown-table-wrap') &&
    styles.includes('.markdown-table th') &&
    styles.includes('.app-shell.theme-light .markdown-table-wrap') &&
    styles.includes('.message-duration') &&
    aiPanel.includes('contextSummaryLabel') &&
    aiPanel.includes('contextOpen') &&
    aiPanel.includes('ai-context-strip') &&
    aiMarkdownMessage.includes('ai-code-preview-modal') &&
    aiMarkdownMessage.includes('预览完整代码') &&
    aiMarkdownMessage.includes('shouldShowCodePreview') &&
    aiMarkdownMessage.includes('commandRiskLabel') &&
    aiMarkdownMessage.includes('isPlainTextResult') &&
    aiMarkdownMessage.includes('ai-result-block') &&
    aiPanel.includes("message.role === 'assistant' ? 'AI' : '我'") &&
    aiPanel.includes('展开完整回复') &&
    styles.includes('.ai-code-preview-modal') &&
    styles.includes('.ai-context-strip') &&
    styles.includes('.ai-result-block') &&
    styles.includes('.message-collapse-footer') &&
    aiPanel.includes('extractPrimaryShellCommand') &&
    aiPanel.includes('../lib/scriptRisk') &&
    aiPanel.includes('aiCommandRiskConfirmOpen') &&
    aiPanel.includes('pendingAiCommandExecution') &&
    aiMarkdownMessage.includes('commandRiskStatus') &&
    aiPanel.includes('executeGeneratedCommand') &&
    aiMarkdownMessage.includes('shellCommandForPart(part)') &&
    aiMarkdownMessage.includes('codeBlockLabel(part.language, part.content)') &&
    aiPanel.includes('confirmPendingAiCommandExecution') &&
    aiMarkdownMessage.includes('class="command-risk-status"') &&
    aiPanel.includes('script-risk-modal') &&
    !aiPanel.includes('isDangerousCommand') &&
    !aiPanel.includes('window.confirm') &&
    styles.includes('.message.collapsed') &&
    styles.includes('.code-block') &&
    tauri.includes('chatWithAiProvider'),
  'AI assistant must call the Tauri backend with terminal context/history and support compressed context plus model error details.'
)

assert(
  workspacePanel.includes('ScriptPanel') &&
    workspacePanel.includes('<ScriptPanel') &&
    workspacePanel.includes('scriptPanelVisited') &&
    workspacePanel.includes("if (tab === 'scripts') scriptPanelVisited.value = true") &&
    workspacePanel.includes('v-if="scriptPanelVisited"') &&
    workspacePanel.includes(`v-if="activeWorkspaceTab === 'ai'"`) &&
    !workspacePanel.includes('"-if=') &&
    workspacePanel.includes(`v-show="activeWorkspaceTab === 'scripts'"`) &&
    !workspacePanel.includes(`v-else-if="activeWorkspaceTab === 'scripts'"`) &&
    workspacePanel.includes('@write-terminal-input="emit(\'writeTerminalInput\', $event)"') &&
    workspacePanel.includes('@start-recording="emit(\'startScriptRecording\')"') &&
    workspacePanel.includes('@stop-recording="emit(\'stopScriptRecording\')"') &&
    appShell.includes('scriptRecordingsByTerminal') &&
    appShell.includes('startScriptRecording') &&
    appShell.includes('stopScriptRecording') &&
    appShell.includes('appendRecordingOutput') &&
    appShell.includes('appendRecordingCommand') &&
    scriptPanel.includes('sendScriptRequest') &&
    scriptPanel.includes('openLibraryMode') &&
    scriptPanel.includes('collapsedMessages') &&
    scriptPanel.includes('shouldCollapseMessage') &&
    scriptPanel.includes('librarySearchInput') &&
    scriptPanel.includes('script-library-body') &&
    scriptPanel.includes('loadSelectedScript') &&
    scriptPanel.includes('toggleScriptEditor') &&
    scriptPanel.includes('saveDraftScript') &&
    scriptPanel.includes('optimizeSelectedScript') &&
    scriptPanel.includes('applyDraftScript') &&
    scriptPanel.includes('saveSelectedScript') &&
    scriptPanel.includes('@click="saveSelectedScript"') &&
    scriptPanel.includes('saveMessageScript') &&
    scriptPanel.includes('openRenameScriptDialog') &&
    scriptPanel.includes('renameScript') &&
    scriptPanel.includes('scriptNameDraft') &&
    !scriptPanel.includes('window.prompt') &&
    scriptPanel.includes('generateAiScriptTitle') &&
    scriptPanel.includes('generateScriptTitle') &&
    scriptPanel.includes('isAutoScriptName') &&
    scriptPanel.includes('executeMessageScript') &&
    scriptPanel.includes('buildScriptPrompt') &&
    scriptPanel.includes('MAX_SCRIPT_SOURCE_COMMANDS') &&
    scriptPanel.includes('recordedOutput') &&
    scriptPanel.includes('const sourceCommands = computed(() => recordedCommands.value)') &&
    scriptPanel.includes('terminalSnapshot: recordedOutput.value') &&
    !scriptPanel.includes('recordedOutput.value || props.terminalSnapshot') &&
    !scriptPanel.includes('props.commandHistory') &&
    !scriptPanel.includes('compactHistoryCommands') &&
    !scriptPanel.includes('CommandHistoryEntry') &&
    scriptPanel.includes('chatWithAiProviderStream') &&
    scriptPanel.includes('cancelTask') &&
    scriptPanel.includes('stopScriptGeneration') &&
    scriptPanel.includes('onAiChatStream') &&
    scriptPanel.includes("import { parseMessageParts, renderMarkdown, type MessagePart } from '../lib/aiMarkdown'") &&
    scriptPanel.includes('answerElapsedSeconds') &&
    scriptPanel.includes('answerDurations') &&
    scriptPanel.includes('durationSeconds') &&
    scriptPanel.includes('formatAnswerDuration') &&
    scriptPanel.includes('messageAnswerDuration') &&
    scriptPanel.includes('createdAt: new Date().toISOString()') &&
    scriptPanel.includes('parseMessageParts(message.text)') &&
    scriptPanel.includes('v-html="renderMarkdown(part.content)"') &&
    scriptPanel.includes('message-duration') &&
    scriptPanel.includes("message.role === 'assistant' && message.streaming") &&
    scriptPanel.includes('@click="stopScriptGeneration"') &&
    scriptPanel.includes('name="stop"') &&
    scriptPanel.includes("import { codeBlockLabel, shellCommandFromCodeBlock } from '../lib/shellCommand'") &&
    scriptPanel.includes('shellCommandForPart(part)') &&
    scriptPanel.includes('codeBlockLabel(part.language, part.content)') &&
    scriptPanel.includes('executeScriptContent(shellCommandForPart(part), message.sourceConnectionId') &&
    scriptPanel.includes('extractBashScript') &&
    scriptPanel.includes('saveUpdateScript') &&
    scriptPanel.includes('deleteUpdateScript') &&
    scriptPanel.includes('loadPreviewScripts') &&
    scriptPanel.includes('localStorage') &&
    scriptExecution.includes('export function buildBashScriptTerminalInput') &&
    scriptExecution.includes('base64 --decode') &&
    scriptPanel.includes('buildBashScriptTerminalInput(prepared)') &&
    scriptPanel.includes('../lib/scriptRisk') &&
    scriptPanel.includes('analyzeScriptRisks') &&
    scriptPanel.includes('scriptRiskStatusForContent') &&
    scriptPanel.includes('draftScriptRiskStatus') &&
    scriptPanel.includes('selectedScriptRiskStatus') &&
    scriptPanel.includes('pendingScriptExecution') &&
    scriptPanel.includes('scriptRiskConfirmOpen') &&
    scriptPanel.includes('pendingScriptRiskLines') &&
    scriptPanel.includes('confirmPendingScriptExecution') &&
    scriptPanel.includes('closeScriptRiskConfirm') &&
    scriptPanel.includes('writeScriptToTerminal') &&
    scriptPanel.includes('script-risk-modal') &&
    scriptPanel.includes('script-risk-preview') &&
    aiPanel.includes('script-risk-preview-head') &&
    aiPanel.includes('pendingAiCommandRiskLines.length') &&
    aiPanel.includes('script-risk-action-hint') &&
    scriptPanel.includes('script-risk-preview-head') &&
    scriptPanel.includes('pendingScriptRiskLines.length') &&
    scriptPanel.includes('script-risk-action-hint') &&
    scriptPanel.includes(':class="[line.riskClass, { flagged: line.risks.length }]"') &&
    !scriptPanel.includes('检测到高风险脚本，确认要在当前终端执行吗？') &&
    !scriptPanel.includes('window.confirm(`妫€娴嬪埌楂橀闄╄剼鏈') &&
    styles.includes('.script-risk-modal') &&
    styles.includes('.script-risk-preview-head') &&
    styles.includes('.script-risk-preview-count') &&
    styles.includes('.script-risk-lines') &&
    styles.includes('.script-risk-action-hint') &&
    styles.includes('.script-risk-line') &&
    styles.includes('.script-risk-line.flagged') &&
    styles.includes('max-height: min(640px, calc(100vh - 44px));') &&
    styles.includes('display: flex;\n  flex-direction: column;') &&
    styles.includes('overflow: auto;\n  overscroll-behavior: contain;') &&
    styles.includes('.script-risk-body > .script-risk-summary') &&
    styles.includes('flex: 1 1 auto;') &&
    styles.includes('overflow-x: hidden;') &&
    styles.includes('grid-template-rows: auto minmax(0, 1fr);') &&
    styles.includes('.script-risk-line {\n  min-width: 0;') &&
    styles.includes('grid-template-columns: 38px minmax(0, 1fr) auto;') &&
    styles.includes('white-space: pre-wrap;') &&
    styles.includes('overflow-wrap: anywhere;') &&
    !styles.includes('.script-risk-line code {\n  white-space: pre;') &&
    styles.includes('.risk-delete') &&
    styles.includes('.risk-edit') &&
    styles.includes('.risk-reboot') &&
    styles.includes('.risk-upgrade') &&
    styles.includes('.command-risk-status') &&
    styles.includes('.script-editor-risk') &&
    styles.includes('.script-editor-risk.risk-muted') &&
    styles.includes('.theme-light .command-risk-status.risk-muted, .theme-light .script-editor-risk.risk-muted') &&
    schema.includes('CREATE TABLE IF NOT EXISTS update_scripts') &&
    sqlite.includes('pub fn save_update_script') &&
    sqlite.includes('pub fn list_update_scripts') &&
    tauri.includes("invoke<AiScriptTitleResponse>('generate_ai_script_title'") &&
    aiChat.includes('generate_script_title') &&
    styles.includes('.script-panel') &&
    styles.includes('.script-recorder') &&
    styles.includes('.script-chat-list') &&
    styles.includes('.script-draft-card') &&
    styles.includes('.script-draft-card textarea') &&
    styles.includes('.script-code-card pre') &&
    styles.includes('.script-code-card code') &&
    styles.includes('max-height: min(420px, 52vh);') &&
    !scriptPanel.includes('script-history-popover') &&
    !scriptPanel.includes('historyPopover') &&
    !scriptPanel.includes('historyButton') &&
    !styles.includes('.script-history-popover') &&
    styles.includes('.script-code-card textarea') &&
    !scriptPanel.includes('script-result-editor'),
  'Workspace must include recording-backed script generation with a chat interaction, inline script library, in-card editing, deletion, and guarded execution.'
)

assert(
  scriptPanel.includes("const PREVIEW_SCRIPT_STORAGE_KEY = 'ai-term:update-scripts:v2:global'") &&
    scriptPanel.includes('migratePreviewScripts') &&
    scriptPanel.includes('await listUpdateScripts()') &&
    scriptPanel.includes('pendingScriptConnectionMismatch') &&
    scriptPanel.includes('executionTargetConnectionIds') &&
    scriptPanel.includes('scriptSourceConnectionId') &&
    scriptPanel.includes('draftSourceConnectionId') &&
    scriptPanel.includes('sourceConnectionId?: string') &&
    workspacePanel.includes(':execution-target-connection-ids="executionTargetConnectionIds"') &&
    appShell.includes('const targetConnectionIds = computed') &&
    sqlite.includes('pub fn list_workspace_sessions(&self)') &&
    sqlite.includes('WHERE EXISTS') &&
    sqlite.includes('ai_conversation_messages AS messages') &&
    sqlite.includes('pub fn list_command_history(&self, connection_id: &str)') &&
    sqlite.includes('pub fn list_update_scripts(&self)') &&
    schema.includes('idx_workspace_sessions_updated') &&
    schema.includes('idx_command_history_connection_all_created') &&
    schema.includes('idx_ai_conversation_session_created') &&
    schema.includes('idx_update_scripts_updated'),
  'AI conversations and scripts must be globally visible, preserve source provenance, and confirm execution when selected targets cross source connections.'
)

assert(
    styles.includes('.context-strip') &&
    styles.includes('flex-wrap: wrap') &&
    styles.includes('overflow: hidden auto') &&
    styles.includes('.message-body p') &&
    styles.includes('.session-history-popover') &&
    styles.includes('.session-history-row:hover .session-history-actions') &&
    styles.includes('.rename-modal') &&
    styles.includes('.rename-field') &&
    styles.includes('overflow-wrap: anywhere') &&
    styles.includes('white-space: pre-wrap') &&
    styles.includes('grid-template-rows: 58px auto minmax(0, 1fr) auto;') &&
    styles.includes('.assistant-compose textarea') &&
    styles.includes('padding-right: calc(var(--icon-size) + 20px);') &&
    styles.includes('.assistant-compose .icon-button') &&
    styles.includes('right: calc(var(--composer-pad-x) + 8px);') &&
    styles.includes('bottom: calc(var(--composer-pad-bottom) + 8px);') &&
    !styles.includes('grid-template-columns: minmax(0, 1fr) var(--icon-size);') &&
    styles.includes('.workspace-tabs button') &&
    styles.includes('.selected-terminal-note') &&
    styles.includes('.thinking-row'),
  'Right AI workspace must constrain chips, inputs, and long model text so it does not overflow horizontally.'
)

assert(
  commandHistoryPanel.includes('defineProps') &&
    commandHistoryPanel.includes('commands') &&
    commandHistoryPanel.includes('MAX_VISIBLE_COMMANDS = 100') &&
    commandHistoryPanel.includes('visibleCommands') &&
    commandHistoryPanel.includes('historySearch') &&
    commandHistoryPanel.includes('copyCommand') &&
    commandHistoryPanel.includes('previewEntry') &&
    commandHistoryPanel.includes('previewCommand') &&
    commandHistoryPanel.includes('closePreview') &&
    commandHistoryPanel.includes('copyPreviewCommand') &&
    commandHistoryPanel.includes('executePreviewCommand') &&
    commandHistoryPanel.includes('isLongCommand') &&
    commandHistoryPanel.includes('history-command-cell') &&
    commandHistoryPanel.includes('预览完整命令') &&
    commandHistoryPanel.includes('history-preview-trigger') &&
    commandHistoryPanel.includes('<UiIcon name="eye" />') &&
    commandHistoryPanel.includes("@dblclick=\"isLongCommand(entry.command) && previewCommand(entry)\"") &&
    commandHistoryPanel.includes('history-preview-modal') &&
    commandHistoryPanel.includes("emit('rerun'") &&
    !commandHistoryPanel.includes('expandedCommandIds') &&
    !commandHistoryPanel.includes('toggleCommand') &&
    !commandHistoryPanel.includes(':class="{ expanded') &&
    !commandHistoryPanel.includes(':aria-expanded') &&
    styles.includes('.history-toolbar') &&
    styles.includes('.history-meta') &&
    styles.includes('/* Command history preview modal. */') &&
    styles.includes('/* Command history visual polish. */') &&
    styles.includes('.history-row.is-long') &&
    styles.includes('.history-preview-trigger') &&
    styles.includes('.history-preview-modal') &&
    styles.includes('.history-preview-body') &&
    styles.includes('.history-preview-actions') &&
    styles.includes('overflow-wrap: anywhere;') &&
    !styles.includes('/* Command history expanded action polish. */') &&
    !styles.includes('order: -1;') &&
    styles.includes('.history-actions'),
  'CommandHistoryPanel must cap visible command history, support search, copy, long-command preview modal, and allow rerunning a command.'
)

assert(
  terminalPane.includes("type TerminalCommandReadiness = 'ready' | 'line-busy' | 'shell-busy' | 'unavailable'") &&
    terminalPane.includes('function commandExecutionReadiness()') &&
    terminalPane.includes('commandExecutionReadiness,') &&
    workspacePanel.includes('rerunCommand: [command: string]') &&
    workspacePanel.includes("@rerun=\"emit('rerunCommand', $event)\"") &&
    appShell.includes('COMMAND_EXECUTION_RETRY_DELAYS_MS') &&
    appShell.includes('executeCommandOnTerminalIds') &&
    appShell.includes('rerunCommandOnActiveTerminal') &&
    appShell.includes('@rerun-command="rerunCommandOnActiveTerminal"') &&
    appShell.includes("readiness.includes('line-busy')") &&
    appShell.includes("readiness.includes('shell-busy')"),
  'History reruns must target the active terminal, tolerate short mount/prompt races, and distinguish a busy command line from a missing terminal.'
)

assert(
  appShell.includes('const COMMAND_HISTORY_CACHE_LIMIT = 300') &&
    appShell.includes('.slice(-COMMAND_HISTORY_CACHE_LIMIT)') &&
    sqlite.includes('const COMMAND_HISTORY_RETENTION_LIMIT: i64 = 1000;') &&
    sqlite.includes('prune_command_history') &&
    sqlite.includes('DELETE FROM command_history') &&
    aiPanel.includes('const MAX_AI_COMMAND_HISTORY = 80') &&
    aiPanel.includes('.slice(-MAX_AI_COMMAND_HISTORY)'),
  'Command history must be bounded: database keeps a finite recent window, frontend cache stays capped, and AI only receives recent useful commands.'
)

assert(
  appShell.includes('class="app-rail"') &&
    appShell.includes('toggleConnectionsPanel') &&
    appShell.includes('toggleSettingsPanel') &&
    appShell.includes("isLeftPanelActive('connections')") &&
    appShell.includes("isLeftPanelActive('settings')") &&
    !appShell.includes('Files') &&
    !appShell.includes('Vaults') &&
    !appShell.includes('Help') &&
    !appShell.includes('class="window-actions"'),
  'AppShell must follow the prototype shell with a narrow useful rail and no fake window controls or dead top action buttons.'
)

assert(
  indexHtml.includes('href="/icon.svg"') &&
    indexHtml.includes('href="/icon.png"') &&
    appShell.includes('class="brand-mark"') &&
    appShell.includes('src="/icon.svg"') &&
    styles.includes('.brand-mark') &&
    styles.includes('object-fit: contain') &&
    tauriConfig.includes('"icons/32x32.png"') &&
    tauriConfig.includes('"icons/128x128.png"') &&
    tauriConfig.includes('"icons/128x128@2x.png"') &&
    tauriConfig.includes('"icons/icon-512.png"') &&
    tauriConfig.includes('"icons/icon.png"'),
  'Project icon must be wired into the browser favicon, app chrome, and Tauri icon config.'
)

assert(
  sidebar.includes('class="section-head"') &&
    sidebar.includes("emit('create')") &&
    sidebar.includes('SSH 主机') &&
    sidebar.includes('连接模式') &&
    sidebar.includes('登录用户名') &&
    sidebar.includes('SSH / SFTP') &&
    !sidebar.includes('selectedProfile.jumpMode') &&
    !sidebar.includes('selectedProfile.fileTransferMode') &&
    !sidebar.includes('isSftpProfile'),
  'ConnectionSidebar must use the simplified prototype labels and avoid exposing legacy mode controls.'
)

assert(
  terminalPane.includes('quick-command-bar') &&
    terminalPane.includes('quickCommands') &&
    terminalPane.includes('quickCommandSettingsOpen') &&
    terminalPane.includes('quickCommandItems') &&
    terminalPane.includes('quickCommandRecommendations') &&
    terminalPane.includes('quickCommandEnabledCount') &&
    terminalPane.includes('quickCommandCanSave') &&
    terminalPane.includes('shouldShowQuickCommandMessage') &&
    terminalPane.includes('scriptRiskStatusForContent') &&
    terminalPane.includes("scriptRiskStatusForContent(value).level === 'high'") &&
    terminalPane.includes('recommendQuickCommandsWithAi') &&
    terminalPane.includes('chatWithAiProvider') &&
    terminalPane.includes('QUICK_COMMAND_AI_TIMEOUT_MS = 15_000') &&
    terminalPane.includes('quickCommandRecommendationGeneration') &&
    terminalPane.includes('withQuickCommandAiTimeout') &&
    terminalPane.includes('已生成历史候选，正在获取 AI 优化。') &&
    terminalPane.includes('class="modal quick-command-modal"') &&
    terminalPane.includes('quick-command-backdrop') &&
    !terminalPane.includes('@click.self="closeQuickCommandSettings"') &&
    terminalPane.includes('v-model="quickCommandItems[index]"') &&
    terminalPane.includes('根据历史推荐') &&
    terminalPane.includes('推荐候选') &&
    terminalPane.includes('确认恢复') &&
    terminalPane.includes('aiConfig?: AiProviderConfig') &&
    terminalPane.includes('apiKey?: string') &&
    terminalPane.includes('terminalLineReadyForAppInput()') &&
    terminalPane.includes('sendInteractiveTerminalInput(value)') &&
    !terminalPane.includes('function runQuickCommand(command: string) {\n  executeCommand(command)') &&
    terminalPane.includes('title="填入终端"') &&
    terminalPane.includes('QUICK_COMMAND_STORAGE_KEY_PREFIX') &&
    terminalPane.includes("props.profile?.id || 'local'") &&
    terminalPane.includes('QUICK_COMMANDS_CHANGED_EVENT') &&
    (appShell.match(/:ai-config="aiConfig"/g) ?? []).length >= 2 &&
    (appShell.match(/:api-key="activeAiRuntimeApiKey"/g) ?? []).length >= 2 &&
    styles.includes('.quick-command-modal') &&
    styles.includes('.quick-command-list') &&
    styles.includes('.quick-command-row') &&
    styles.includes('.quick-command-row .command-risk-status') &&
    styles.includes('.quick-command-bar .quick-command-bar-notice') &&
    styles.includes('.theme-light .quick-command-bar .quick-command-bar-notice') &&
    styles.includes('.theme-light .quick-command-row') &&
    styles.includes('.quick-command-recommendations') &&
    styles.includes('.quick-command-reset-confirm') &&
    styles.includes('.command-risk-status.risk-muted') &&
    terminalPane.includes('terminal-heading') &&
    terminalPane.includes('copyTerminalOutput') &&
    !terminalPane.includes('connection-strip'),
  'TerminalPane must expose a compact terminal header and managed quick command settings without the old tall connection summary.'
)

assert(
  workspacePanel.includes("activeWorkspaceTab === 'ai'") &&
    workspacePanel.includes("activeWorkspaceTab === 'history'") &&
    workspacePanel.includes("activeWorkspaceTab === 'scripts'") &&
    workspacePanel.includes('SFTP') &&
    aiConfig.includes('Custom AI Provider') &&
    aiConfig.includes('已配置') &&
    aiConfig.includes('待配置') &&
    !aiConfig.includes('configured') &&
    !aiConfig.includes('required') &&
    settingsSidebar.includes('AiConfigPanel') &&
    !aiPanel.includes('AiConfigPanel'),
  'Workspace must use the prototype AI assistant tab labels and AI configuration must live in the left settings menu.'
)

assert(
  tauriConfig.includes('"width": 1280') &&
    tauriConfig.includes('"minWidth": 980') &&
    styles.includes('min-width: 980px') &&
    styles.includes('--workspace-width: clamp(380px, 28vw, 520px);') &&
    styles.includes('grid-template-columns: var(--rail-width) var(--sidebar-width) minmax(0, 1fr) var(--workspace-width);') &&
    styles.includes('@media (max-width: 1280px)') &&
    styles.includes('Shell columns stay proportional') &&
    styles.includes('@media (max-width: 1080px)') &&
    styles.includes('--workspace-width: clamp(300px, 34vw, 360px);') &&
    styles.includes('.xterm-host {\n  width: 100%;') &&
    styles.includes('display: grid;\n  overflow: hidden;\n  box-sizing: border-box;\n  padding: 0;') &&
    styles.includes('box-sizing: border-box;\n  background: #03070c;\n  padding: 16px 6px 16px 18px;') &&
    !styles.includes('width: min(380px, calc(100vw - 56px));') &&
    !styles.includes('.app-shell:not(.right-collapsed) .right-panel {\n    display: none;'),
  'Frontend layout must keep the right workspace as a proportional grid column at the 1280 default and 980 minimum window widths without terminal overlap or workspace shrinkage.'
)

assert(
  aiConfig.includes('apiKey:') &&
    aiConfig.includes("editorMode === 'edit'") &&
    settingsSidebar.includes(':editor-mode="editorMode"') &&
    appShell.includes('aiConfigs = ref') &&
    appShell.includes('selectedAiConfigId') &&
    appShell.includes('createAiConfig') &&
    appShell.includes('aiRuntimeApiKeys') &&
    appShell.includes('listAiProviderConfigs') &&
    appShell.includes('saveAiProviderConfig') &&
    appShell.includes('deleteAiProviderConfig') &&
    appShell.includes('aiConfigEditorOpen') &&
    settingsSidebar.includes('modal-backdrop') &&
    settingsSidebar.includes('settings-card-head') &&
    settingsSidebar.includes('settings-card-main') &&
    settingsSidebar.includes('@save="(config, apiKey) => emit(\'saveAiConfig\', config, apiKey)"') &&
    styles.includes('.settings-card-head') &&
    styles.includes('.settings-card-main') &&
    styles.includes('.settings-card .card-actions') &&
    styles.includes('.theme-light .settings-option-icon') &&
    styles.includes('.theme-light .settings-option:hover .settings-option-icon, .theme-light .settings-option.active .settings-option-icon') &&
    styles.includes('.theme-light .settings-card .icon-button.danger:hover:not(:disabled)') &&
    styles.includes('grid-template-columns: repeat(2, 26px);') &&
    schema.includes('api_key TEXT') &&
    sqlite.includes('api_key = excluded.api_key') &&
    workspacePanel.includes(':api-key="apiKey"') &&
    aiConfig.includes("emit('save', { ...draft, id, apiKey, apiKeyRef }, apiKey)") &&
    aiPanelUsesBackendModelCall(),
  'AI configuration must support multiple SQLite-backed configs and AiPanel must call the configured model through the Tauri backend instead of using only local rules.'
)

function aiPanelUsesBackendModelCall() {
  const aiPanel = read('src/components/AiPanel.vue')
  return (
    aiPanel.includes('chatWithAiProvider') &&
    tauri.includes("invoke<AiChatResponse>('chat_with_ai_provider'") &&
    aiChat.includes('chat/completions') &&
    aiChat.includes('Authorization') &&
    aiPanel.includes('isAsking') &&
    aiPanel.includes('error = false') &&
    tauri.includes("invoke<AiChatResponse>('chat_with_ai_provider_stream'") &&
    tauri.includes('onAiChatStream') &&
    aiPanel.includes('extractPrimaryShellCommand')
  )
}

assert(
  sidebar.includes('v-model.number="selectedProfile.target.port"') &&
    sidebar.includes('type="number"') &&
    appShell.includes('normalizeConnectionProfileForSave') &&
    appShell.includes("normalizePort(normalized.target.port, 'SSH port', 22)") &&
    !sidebar.includes('v-model.number="selectedProfile.gateway.port"'),
  'Connection editor must expose SSH port fields and normalize them before saving.'
)

assert(
  !sidebar.includes('@click.self="emit(\'closeEditor\')"') &&
    !settingsSidebar.includes('@click.self="emit(\'closeAiConfig\')"'),
  'Connection and AI config modals must stay open when clicking outside the dialog.'
)

assert(
  sidebar.includes('shouldShowTargetPassword') &&
    sidebar.includes("return profile.target.authMode !== 'key'") &&
    sidebar.includes('targetPasswordLabel') &&
    sidebar.includes('SSH 密码') &&
    sidebar.includes('v-model="selectedProfile.target.password"') &&
    appShell.includes('if (!normalized.target.password?.trim()) normalized.target.password = undefined') &&
    appShell.includes("normalized.connectionRole = normalized.connectionRole === 'bastion' ? 'bastion' : 'direct'") &&
    appShell.includes("normalized.jumpMode = 'direct'") &&
    appShell.includes("normalized.fileTransferMode = 'auto'"),
  'Direct SSH profiles must keep the server password visible when needed and normalize away legacy bastion mode fields.'
)

assert(
  aiPanel.includes('explainPendingAiCommandRisk') &&
    aiPanel.includes('buildAiRiskExplanationPrompt') &&
    aiPanel.includes('aiRiskExplanationLoading') &&
    aiPanel.includes('onAiChatStream(requestId') &&
    aiPanel.includes('streamedAnswer += event.delta') &&
    aiPanel.includes('借助 AI 分析风险') &&
    aiPanel.includes('AI 正在分析风险') &&
    aiPanel.includes('aria-live="polite"') &&
    aiPanel.includes('<AiMarkdownMessage v-else-if="aiRiskExplanation"') &&
    aiMarkdownMessage.includes('v-html="renderMarkdown(part.content)"') &&
    !aiPanel.includes('@click.self="closeAiCommandRiskConfirm"') &&
    scriptPanel.includes('explainPendingScriptRisk') &&
    scriptPanel.includes('buildScriptRiskExplanationPrompt') &&
    scriptPanel.includes('scriptRiskExplanationLoading') &&
    scriptPanel.includes('onAiChatStream(requestId') &&
    scriptPanel.includes('streamedAnswer += event.delta') &&
    scriptPanel.includes('借助 AI 分析风险') &&
    scriptPanel.includes('AI 正在分析风险') &&
    scriptPanel.includes('aria-live="polite"') &&
    scriptPanel.includes('v-html="renderMarkdown(scriptRiskExplanation)"') &&
    !scriptPanel.includes('@click.self="closeScriptRiskConfirm"') &&
    styles.includes('.script-risk-ai') &&
    styles.includes('.script-risk-ai-output') &&
    styles.includes('.script-risk-thinking') &&
    styles.includes('.script-risk-ai-placeholder') &&
    styles.includes('.script-risk-ai-output .markdown-content'),
  'Risk confirmation modals must stay open on backdrop clicks and stream AI risk explanations with an active answering state.'
)

assert(
  settingsSidebar.includes('terminalFontFamily') &&
    settingsSidebar.includes('terminalFontSize') &&
    settingsSidebar.includes('defaultShell') &&
    settingsSidebar.includes('terminal-settings-panel') &&
    settingsSidebar.includes('terminal-settings-form') &&
    settingsSidebar.includes('影响终端正文、命令补全和脚本输出。') &&
    !settingsSidebar.includes('proxyUrl') &&
    settingsSidebar.includes('\u7ec8\u7aef\u5916\u89c2') &&
    !settingsSidebar.includes('\u7f51\u7edc\u4e0e\u4ee3\u7406') &&
    settingsSidebar.includes('\u9009\u62e9\u7ec8\u7aef\u5b57\u4f53') &&
    settingsSidebar.includes('Cascadia Mono') &&
    !settingsSidebar.includes('\u7ec8\u7aef\u4e3b\u9898') &&
    !settingsSidebar.includes('v-model="draft.terminalTheme"') &&
    !settingsSidebar.includes('\u5b89\u5168\u4e0e\u5bc6\u94a5') &&
    !settingsSidebar.includes('\u66f4\u65b0\u4e0e\u6570\u636e') &&
    !settingsSidebar.includes("activeSection === 'network'") &&
    !settingsSidebar.includes("activeSection === 'security'") &&
    !settingsSidebar.includes("activeSection === 'data'") &&
    settingsSidebar.includes('aiConfigSearch') &&
    settingsSidebar.includes('sortedAiConfigs') &&
    settingsSidebar.includes('filteredAiConfigs') &&
    settingsSidebar.includes('settings-ai-list') &&
    settingsSidebar.includes('settings-search') &&
    settingsSidebar.includes('settings-config-list') &&
    settingsSidebar.includes('\u6ca1\u6709\u5339\u914d\u7684 AI \u914d\u7f6e') &&
    appShell.includes('USER_SETTINGS_STORAGE_KEY') &&
    appShell.includes('updateUserSettings') &&
    appShell.includes('showToast') &&
    !appShell.includes('class="app-status-bar"') &&
    appShell.includes('class=\"toast-stack\"') &&
    appShell.includes('toastKey') &&
    appShell.includes('slice(-3)') &&
    terminalPane.includes('terminalSettings?: TerminalVisualSettings') &&
    terminalPane.includes('applyTerminalAppearance') &&
    terminalPane.includes('terminalThemeOptions') &&
    appShell.includes(':terminal-settings="appSettings"') &&
    styles.includes('.settings-controls') &&
    styles.includes('.terminal-settings-panel') &&
    styles.includes('.terminal-settings-form') &&
    styles.includes('.app-shell.theme-light .terminal-settings-panel .settings-field > span') &&
    styles.includes('.app-shell.theme-light .settings-option.active') &&
    styles.includes('.settings-search') &&
    styles.includes('.settings-config-list') &&
    styles.includes('.settings-empty') &&
    styles.includes('.app-toast') &&
    styles.includes('.toast-stack') &&
    styles.includes('top: 72px;'),
  'Settings center must keep the visible settings surface focused, use selectable terminal fonts, hide terminal theme and network proxy controls, and retain shared toasts.'
)

assert(
  commandHistoryPanel.includes('\u6682\u65e0\u547d\u4ee4\u5386\u53f2') &&
    commandHistoryPanel.includes('\u6ca1\u6709\u5339\u914d\u7684\u547d\u4ee4') &&
    commandHistoryPanel.includes('UiIcon') &&
    !commandHistoryPanel.includes('No command history') &&
    !commandHistoryPanel.includes('No matching commands') &&
    terminalPane.includes('SFTP \u76f4\u8fde') &&
    terminalPane.includes('SFTP \u7ecf\u7f51\u5173') &&
    !terminalPane.includes('SFTP direct') &&
    !terminalPane.includes('SFTP via gateway'),
  'Command history and SFTP mode labels must be localized to Chinese.'
)

assert(
  uiIcon.includes("'arrow-left'") &&
    uiIcon.includes("'file'") &&
    uiIcon.includes("'download'") &&
    uiIcon.includes("'upload'") &&
    uiIcon.includes("'save'") &&
    uiIcon.includes("'maximize'") &&
    uiIcon.includes("'list'") &&
    uiIcon.includes("'search'") &&
    uiIcon.includes("'stop'") &&
    aiPanel.includes('import UiIcon') &&
    aiPanel.includes('title="会话列表"') &&
    aiPanel.includes('name="list"') &&
    aiPanel.includes('name="arrow-right"') &&
    scriptPanel.includes('import UiIcon') &&
    scriptPanel.includes('name="save"') &&
    scriptPanel.includes('name="copy"') &&
    scriptPanel.includes('name="more"') &&
    fileTransfer.includes('import UiIcon') &&
    fileTransfer.includes('name="upload"') &&
    fileTransfer.includes('name="download"') &&
    fileTransfer.includes('name="folder-open"') &&
    fileTransfer.includes(`UiIcon :name="entry.isDir ? 'folder' : 'file'"`) &&
    uiIcon.includes("name === 'file'"),
  'AI, script, SFTP, and history surfaces must use UiIcon for common action buttons instead of fragile character glyphs.'
)
assert(
  !styles.includes('.app-shell.theme-light .local-pathbar input') &&
    !styles.includes('.app-shell.theme-light .sftp-pathbar input') &&
    !styles.includes('.app-shell.theme-light .file-row {\n  min-height') &&
    !styles.includes('.app-shell.theme-light .file-copy {\n  gap') &&
    !styles.includes('.app-shell.theme-light .file-actions {\n  gap') &&
    !styles.includes('.app-shell.theme-light .file-type-icon, .app-shell.theme-light .file-type-icon.file'),
  'Light theme SFTP directory must inherit the base file-browser geometry and only recolor surfaces.'
)

assert(
  appShell.includes("const APP_THEME_STORAGE_KEY = 'ai-term:app-theme:v1'") &&
    appShell.includes("type AppTheme = 'dark' | 'light'") &&
    appShell.includes('const appTheme = ref<AppTheme>(loadAppTheme())') &&
    appShell.includes('class="rail-button theme-toggle-button"') &&
    appShell.includes("'theme-light': appTheme === 'light'") &&
    appShell.includes(':app-theme="appTheme"') &&
    terminalPane.includes("appTheme?: 'dark' | 'light'") &&
    terminalPane.includes("props.appTheme === 'light' ? 'light'") &&
    uiIcon.includes("| 'sun'") &&
    uiIcon.includes("| 'moon'") &&
    uiIcon.includes("name === 'sun'") &&
    uiIcon.includes("name === 'moon'") &&
    styles.includes('/* Application light theme. */') &&
    styles.includes('/* Design-taste light theme refinement. */') &&
    styles.includes('/* Workspace separation polish. */') &&
    styles.includes('/* Light theme surface hardening. */') &&
    styles.includes('/* History row and light divider polish. */') &&
    styles.includes('/* Light theme layout parity. */') &&
    styles.includes('/* Light theme dark-surface cleanup. */') &&
    styles.includes('/* Light theme state surface cleanup. */') &&
    styles.includes('/* Light theme status indicator cleanup. */') &&
    styles.includes('/* Command history preview modal. */') &&
    styles.includes('/* Light theme shell structure parity contract. */') &&
    styles.includes('/* Light theme color-only surface contract. */') &&
    styles.includes('.theme-light .brand') &&
    styles.includes('border-right-color: var(--light-border);') &&
    styles.includes('.theme-light .workspace-tabs') &&
    styles.includes('.theme-light .terminal-frame') &&
    styles.includes('.theme-light .history-list') &&
    styles.includes('.theme-light .history-row') &&
    styles.includes('.theme-light .quick-command-modal') &&
    styles.includes('.theme-light .script-preview-modal') &&
    styles.includes('.theme-light .script-risk-modal .modal-head') &&
    styles.includes('.theme-light .modal-head .icon-button') &&
    styles.includes('.theme-light .modal-head .icon-button:hover:not(:disabled)') &&
    styles.includes('.theme-light .ai-config .badge.ok') &&
    styles.includes('.theme-light .ai-config .badge') &&
    styles.includes('.app-shell.theme-light .script-risk-chip strong') &&
    styles.includes('.app-shell.theme-light .script-risk-line-no') &&
    styles.includes('.theme-light .file-context-menu') &&
    styles.includes('.theme-light .terminal-completion') &&
    styles.includes('.app-shell.theme-light .terminal-native-code .xterm-host .composition-view') &&
    styles.includes('.app-shell.theme-light .workspace-open-handle') &&
    styles.includes('.app-shell.theme-light .record-dot') &&
    styles.includes('.app-shell.theme-light .status-dot.live') &&
    styles.includes('.app-shell.theme-light .badge') &&
    styles.includes('.rail-button.active::before') &&
    styles.includes('border-radius: 14px;') &&
    styles.includes('.rail-button .ui-icon') &&
    styles.includes('.theme-light .local-pathbar') &&
    styles.includes('.theme-light .file-actions .icon-button:hover:not(:disabled)') &&
    !appShell.includes('profileStoreStatusLabel'),
  'AppShell must provide a persisted light theme toggle and make all major workspace surfaces follow the app theme.'
)

assert(
  !styles.includes('/* Light theme structural cleanup. */') &&
    !styles.includes('/* Light theme responsive parity. */') &&
    !styles.includes('/* Light theme typography and interaction parity. */') &&
    !styles.includes('/* Light theme right workspace 1280 parity contract. */') &&
    !styles.includes('/* Light theme right workspace 1080 parity contract. */') &&
    !styles.includes('/* Light theme workspace structure parity contract. */') &&
    !styles.includes('.app-shell.theme-light {\n  grid-template-columns: 56px 280px minmax(440px, 1fr) 320px;') &&
    !styles.includes('.app-shell.theme-light:not(.right-collapsed) {\n  grid-template-columns: 56px 270px minmax(0, 1fr) 0;') &&
    !styles.includes('.app-shell.theme-light .workspace-tabs {\n  grid-template-columns: repeat(4, minmax(54px, 1fr));') &&
    !styles.includes('.app-shell.theme-light:not(.right-collapsed) .right-panel') &&
    !styles.includes('.app-shell.theme-light .workspace-tabs button {\n  height') &&
    !styles.includes('.app-shell.theme-light .app-rail {\n  gap') &&
    !styles.includes('.app-shell.theme-light .rail-button {\n  width') &&
    !styles.includes('.app-shell.theme-light .server-list {\n  gap') &&
    !styles.includes('.app-shell.theme-light .search-input {\n  width') &&
    !styles.includes('.app-shell.theme-light .server-card {\n  min-height') &&
    !styles.includes('.app-shell.theme-light .quick-command-bar {\n  margin'),
  'Light theme must inherit base geometry; theme-specific rules should not duplicate shell, rail, sidebar, terminal, or workspace layout.'
)
assert(
  fileTransfer.includes('浏览器预览中无法使用本地文件和 SFTP 能力，请在 AI Term 桌面端中操作。') &&
    fileTransfer.includes('isTauriPreviewUnavailable') &&
    styles.includes('/* Workspace empty-state and quick command modal polish. */') &&
    styles.includes('.history-list > .empty-state') &&
    styles.includes('.file-list > .empty-state') &&
    styles.includes('.assistant-panel .message-list > .empty-state') &&
    styles.includes('.quick-command-modal .modal-head') &&
    styles.includes('.theme-light .quick-command-modal .modal-head') &&
    terminalPane.includes('quickCommandSettingsButton') &&
    terminalPane.includes('handleQuickCommandSettingsPointerDown') &&
    terminalPane.includes("addEventListener('pointerdown', handleQuickCommandSettingsPointerDown, true)") &&
    styles.includes('grid-template-rows: auto minmax(0, 1fr) auto auto;'),
  'Right workspace empty states, SFTP browser-preview feedback, and quick-command modal chrome must be polished across dark and light themes.'
)
console.log('production-ui-check passed')
