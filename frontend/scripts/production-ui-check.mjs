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
const terminalPane = read('src/components/TerminalPane.vue')
const aiPanel = read('src/components/AiPanel.vue')
const aiMarkdownMessage = read('src/components/AiMarkdownMessage.vue')
const aiMarkdown = read('src/lib/aiMarkdown.ts')
const shellCommand = read('src/lib/shellCommand.ts')
const aiConfig = read('src/components/AiConfigPanel.vue')
const fileTransfer = read('src/components/FileTransferPanel.vue')
const scriptPanel = read('src/components/ScriptPanel.vue')
const scriptRisk = read('src/lib/scriptRisk.ts')
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
const localFilesystem = read('../src-tauri/src/domain/filesystem/local.rs')
const commands = read('../src-tauri/src/app/commands.rs')
const credentials = read('../src-tauri/src/domain/auth/credentials.rs')
const tauriLib = read('../src-tauri/src/lib.rs')

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
const surfaceContractDisallowed = disallowedDeclarationsInRange('/* Light theme color-only surface contract. */', null, surfaceContractAllowedProperties)
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
    styles.includes('border-color: rgba(16, 185, 129, .28);') &&
    styles.includes('background: rgba(16, 185, 129, .10);') &&
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
    sftpBackend.includes('run_cached_native_sftp_routes(') &&
    sftpBackend.includes('|connection, _route| list_directory_native(connection, remote_path)'),
  'SFTP directory listing should reuse native SFTP sessions so remote directory switching does not reconnect for every folder.'
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
    terminalPane.includes('sessionId = await connectProfile(props.profile.id, size.cols, size.rows)') &&
    terminalPane.includes('await attachTerminalEvents()') &&
    !terminalPane.includes('Remote SSH profile editing is ready'),
  'TerminalPane must attach remote SSH profiles through the Tauri backend instead of rendering a placeholder.'
)

assert(
  !terminalPane.includes('Remote SSH is not enabled for this build yet.'),
  'TerminalPane must not show a disabled-remote placeholder.'
)

assert(
  terminalPane.includes('dataDisposable = terminal.onData((data) => {') &&
    terminalPane.includes('void terminalWrite(sessionId, data)') &&
    !terminalPane.includes('dataDisposable = terminal.onData((data) => {\n    terminal?.write(data)'),
  'TerminalPane must not echo keyboard input locally when there is no backend session.'
)

assert(
  terminalPane.includes('commandHistory: CommandHistoryEntry[]') &&
    terminalPane.includes('handleCompletionInput(data)') &&
    terminalPane.includes('terminalCompletionOpen') &&
    terminalPane.includes('completionSuggestions') &&
    terminalPane.includes('systemCommandSuggestions') &&
    terminalPane.includes('historyCommandSuggestions') &&
    terminalPane.includes('acceptCompletionSuggestion') &&
    terminalPane.includes('completionSummary') &&
    terminalPane.includes('completionSourceLabel') &&
    terminalPane.includes('handleDocumentPointerDown') &&
    terminalPane.includes('terminalBodyWrap.value?.contains(target)') &&
    terminalPane.includes('COMPLETION_DEBOUNCE_MS = 200') &&
    terminalPane.includes('COMPLETION_LIMIT = 12') &&
    terminalPane.includes('COMPLETION_VISIBLE_ROWS = 3') &&
    terminalPane.includes('completionKeyboardMode') &&
    terminalPane.includes('scrollActiveCompletionIntoView') &&
    terminalPane.includes("active?.scrollIntoView({ block: 'nearest' })") &&
    terminalPane.includes('scheduleCompletionSuggestions') &&
    terminalPane.includes('updateCompletionAfterInput') &&
    terminalPane.includes('const inputResult = trackUserInput(data)') &&
    terminalPane.includes("data === '\\x1b[A'") &&
    terminalPane.includes("data === '\\x1b[B'") &&
    terminalPane.includes('if (!completionKeyboardMode.value)') &&
    terminalPane.includes('terminalCompletionOpen.value = force || completionSuggestions.value.length > 0') &&
    terminalPane.includes('inputCommandBuffer.trimStart()') &&
    !terminalPane.includes("data === '\\t'") &&
    !terminalPane.includes("event.key === 'Tab'") &&
    terminalPane.includes('handleTerminalCustomKeyEvent') &&
    terminalPane.includes('terminal.attachCustomKeyEventHandler(handleTerminalCustomKeyEvent)') &&
    terminalPane.includes('convertEol: false') &&
    terminalPane.includes("event.ctrlKey && !event.altKey && !event.metaKey && event.code === 'Space'") &&
    terminalPane.includes('<kbd>&uarr;</kbd><kbd>&darr;</kbd>') &&
    terminalPane.includes('<kbd>Ctrl</kbd><kbd>Space</kbd>') &&
    terminalPane.includes('200ms') &&
    terminalPane.includes('class="terminal-completion"') &&
    appShell.includes(':command-history="commandHistoryForTab(tab)"') &&
    appShell.includes('key.startsWith(`${tab.connectionId}:`)') &&
    styles.includes('.terminal-completion') &&
    styles.includes('.terminal-completion-head') &&
    styles.includes('.terminal-completion-empty') &&
    styles.includes('grid-template-rows: minmax(0, 1fr) auto;') &&
    styles.includes('max-height: calc(38px + (var(--completion-visible-rows, 3) * 30px));') &&
    styles.includes('backdrop-filter: none;') &&
    styles.includes('.theme-light .terminal-completion kbd') &&
    styles.includes('.terminal-native-code') &&
    styles.includes('.xterm-host .xterm-rows') &&
    styles.includes('.xterm-host {\n  width: 100%;') &&
    styles.includes('display: grid;\n  overflow: hidden;\n  box-sizing: border-box;\n  padding: 16px 18px;') &&
    terminalPane.includes('terminalContentBox(element)') &&
    terminalPane.includes('measureTerminalCell(element)') &&
    terminalPane.includes('element.clientHeight - verticalPadding') &&
    terminalPane.includes('scrollTerminalToBottom') &&
    terminalPane.includes('terminal.buffer.active') &&
    terminalPane.includes('writeTerminalView(event.data)') &&
    terminalPane.includes('if (changed) terminal.resize(size.cols, size.rows)') &&
    !terminalPane.includes('Math.floor(element.clientHeight / 18)'),
  'TerminalPane must provide native-feeling terminal code styling, command completion, accurate measured sizing, and bottom-pinned output.'
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
  terminalPane.includes('onTerminalData(sessionId') &&
    tauri.includes('terminalDataEventName(sessionId: string)'),
  'Terminal data listeners must use session-scoped event names.'
)

assert(
  terminalPane.includes('onTerminalClosed(sessionId') &&
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
    terminalPane.includes('await verifyTerminalSessionStillActive(sessionId)') &&
    terminalPane.includes('window.setTimeout(resolve, 150)'),
  'Terminal tabs must reflect real terminal runtime status, local shell spawn failures must enter error, and quick shell exits must be detected even if the close event is missed.'
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
    fileTransfer.includes('maybeAutoProbeCurrentTerminalSftp') &&
    fileTransfer.includes('autoTerminalProbeAttempted') &&
    fileTransfer.includes('active: boolean') &&
    fileTransfer.includes('initializeRemoteBrowserIfActive') &&
    fileTransfer.includes('() => props.active') &&
    fileTransfer.includes('options.useForSftp && !props.active') &&
    workspacePanel.includes(':active="activeWorkspaceTab === \'sftp\'"') &&
    fileTransfer.includes('配置目标 SFTP 失败，正在自动识别当前终端服务器...') &&
    fileTransfer.includes('未识别到当前终端目标，已使用连接配置目标打开 SFTP。') &&
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
  workspaceTypes.includes('interface TerminalOutputDeltaEvent extends TerminalOutputEvent') &&
    appShell.includes('terminalOutputEvents') &&
    appShell.includes('terminalOutputSequence') &&
    appShell.includes('activeTerminalOutputEvent') &&
    appShell.includes('@focus-terminal="focusActiveTerminalFromWorkspace"') &&
    terminalPane.includes('function focusTerminal()') &&
    terminalPane.includes('focusTerminal,') &&
    workspacePanel.includes('sftpPanelVisited') &&
    workspacePanel.includes("if (tab === 'sftp') sftpPanelVisited.value = true") &&
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
    appShell.includes('ensurePersistedWorkspaceSession') &&
    appShell.includes('preferredWorkspaceSessionForConnection') &&
    appShell.includes('persistWorkspaceSessionForMessage') &&
    appShell.includes('saveCommandHistoryForTerminal') &&
    appShell.includes('const tab = terminalTabs.value.find((item) => item.id === event.terminalId)') &&
    appShell.includes('await ensurePersistedWorkspaceSession(entry.connectionId, entry.workspaceSessionId') &&
    appShell.includes('connectProfileFromSidebar') &&
    !appShell.includes('const session = await createWorkspaceSession(profile.id)'),
  'Workspace sessions must start as frontend drafts, persist only when data exists, and command history must be saved with the emitting terminal connection/session.'
)

assert(
  scriptPanel.includes("type ScriptPanelMode = 'library' | 'generate'") &&
    scriptPanel.includes('scriptPanelMode') &&
    scriptPanel.includes("scriptPanelMode = ref<ScriptPanelMode>('generate')") &&
    scriptPanel.includes("type ScriptLibraryView = 'list' | 'detail'") &&
    scriptPanel.includes("scriptLibraryView = ref<ScriptLibraryView>('list')") &&
    scriptPanel.includes('showScriptComposer') &&
    scriptPanel.includes("scriptPanelMode.value === 'generate'") &&
    scriptPanel.includes('openGenerateMode') &&
    scriptPanel.includes('openLibraryMode') &&
    scriptPanel.includes('focusLibrarySearch') &&
    scriptPanel.includes('librarySearchInput') &&
    scriptPanel.includes('selectedScriptContent') &&
    scriptPanel.includes('@click="openLibraryMode"') &&
    scriptPanel.includes('@click="createScriptConversation"') &&
    scriptPanel.includes('class="script-library"') &&
    scriptPanel.includes('class="script-library-body"') &&
    scriptPanel.includes('class="script-library-empty"') &&
    scriptPanel.includes('scriptLibraryView === \'list\'') &&
    scriptPanel.includes('scriptLibraryView === \'detail\'') &&
    scriptPanel.includes('scriptLibraryView.value = \'list\'') &&
    scriptPanel.includes('scriptLibraryView.value = \'detail\'') &&
    scriptPanel.includes('class="script-preview"') &&
    scriptPanel.includes('返回列表') &&
    scriptPanel.includes('selectedScriptLineNumbers') &&
    scriptPanel.includes('selectedScriptLineRail') &&
    scriptPanel.includes('syncSelectedScriptLineRail') &&
    scriptPanel.includes('copySelectedScript') &&
    scriptPanel.includes('openScriptPreview') &&
    scriptPanel.includes('closeScriptPreview') &&
    scriptPanel.includes('copyExpandedScript') &&
    scriptPanel.includes('executeExpandedScript') &&
    scriptPanel.includes('scriptPreviewOpen') &&
    scriptPanel.includes('expandedScriptContent') &&
    scriptPanel.includes('expandedScriptLineNumbers') &&
    scriptPanel.includes('regenerateSelectedScript') &&
    scriptPanel.includes('@click="regenerateSelectedScript"') &&
    scriptPanel.includes('当前脚本为空，无法重新生成。') &&
    scriptPanel.includes('class="script-library-editor"') &&
    scriptPanel.includes('title="返回列表"') &&
    scriptPanel.includes('title="保存脚本"') &&
    scriptPanel.includes('title="执行脚本"') &&
    scriptPanel.includes('title="复制脚本"') &&
    scriptPanel.includes('@click.stop="removeScript(script)"') &&
    !scriptPanel.includes('@click="removeScript(selectedScript)"') &&
    !scriptPanel.includes('<select aria-label="脚本语言" disabled>') &&
    !scriptPanel.includes('<option>Bash</option>') &&
    !scriptPanel.includes('<span>Bash</span>') &&
    !scriptPanel.includes("message.savedScriptId ? 'bash saved' : 'bash draft'") &&
    !scriptPanel.includes('@click="toggleSelectedScriptEditor"') &&
    !scriptPanel.includes('v-if="selectedScriptEditing"') &&
    !scriptPanel.includes('class="script-preview-code"><code>{{ selectedScriptContent }}</code></pre>') &&
    !scriptPanel.includes('class="script-title-head"') &&
    !scriptPanel.includes('<strong>脚本助手</strong>') &&
    !scriptPanel.includes('编写、优化和执行脚本') &&
    scriptPanel.includes('class="script-editor-toolbar"') &&
    scriptPanel.includes('class="script-file-tab"') &&
    scriptPanel.includes('function scriptEditorRiskStatus') &&
    scriptPanel.includes("level: 'muted'") &&
    scriptPanel.includes('hasSelectedScriptContent') &&
    scriptPanel.includes('v-if="props.recording.isRecording || recordingHasData" class="script-recorder"') &&
    scriptPanel.includes(':disabled="!hasDraftScript"') &&
    scriptPanel.includes(':disabled="!hasSelectedScriptContent"') &&
    scriptPanel.includes('class="script-editor-tools"') &&
    scriptPanel.includes('title="保存脚本草稿"') &&
    scriptPanel.includes('title="重新生成脚本"') &&
    scriptPanel.includes('title="执行脚本"') &&
    scriptPanel.includes('title="复制脚本"') &&
    scriptPanel.includes('title="放大预览"') &&
    !scriptPanel.includes('<strong>script.sh</strong>') &&
    scriptPanel.includes('script-preview-modal') &&
    scriptPanel.includes('class="script-expanded-editor"') &&
    scriptPanel.includes('script-code-overlay') &&
    scriptPanel.includes('highlightShellScript') &&
    scriptPanel.includes('draftScriptHighlightedHtml') &&
    scriptPanel.includes('selectedScriptHighlightedHtml') &&
    scriptPanel.includes('expandedScriptHighlightedHtml') &&
    scriptPanel.includes('syncScriptEditorScroll') &&
    !scriptPanel.includes('class="icon-button primary-action"') &&
    !scriptPanel.includes('&#128190;') &&
    !scriptPanel.includes('<strong>脚本草稿</strong>') &&
    !scriptPanel.includes('{{ draftStatusText }}') &&
    !scriptPanel.includes('可直接粘贴或生成脚本') &&
    !scriptPanel.includes('可直接粘贴或编写脚本') &&
    !scriptPanel.includes('>继续修改</button>') &&
    !scriptPanel.includes('class="script-draft-actions"') &&
    !scriptPanel.includes('class="script-assistant-section"') &&
    !scriptPanel.includes('class="script-assistant-title"') &&
    scriptPanel.includes('scriptRepliesExpanded') &&
    scriptPanel.includes('hasScriptReplies') &&
    scriptPanel.includes('class="script-replies-panel"') &&
    scriptPanel.includes('class="script-replies-list"') &&
    scriptPanel.includes("当前脚本草稿为空，无法复制。") &&
    scriptPanel.includes("当前脚本草稿为空，无法执行。") &&
    scriptPanel.includes(':disabled="!hasDraftScript" @click="saveDraftScript"') &&
    scriptPanel.includes(':disabled="!hasDraftScript" @click="executeDraftScript"') &&
    scriptPanel.includes(':disabled="!hasDraftScript" @click="copyDraftScript"') &&
    !scriptPanel.includes(':disabled="!hasDraftScript || isGenerating || !hasUsableConfig"') &&
    !scriptPanel.includes(':disabled="isGenerating || !hasUsableConfig"') &&
    !scriptPanel.includes(':disabled="!isGenerating && !hasUsableConfig"') &&
    scriptPanel.includes('class="script-draft-card"') &&
    scriptPanel.includes('draftScriptContent') &&
    scriptPanel.includes('`\u6a21\u5f0f\uff1a${modeText}`') &&
    scriptPanel.includes('`\u7528\u6237\u8981\u6c42\uff1a${userRequest}`') &&
    scriptPanel.includes("['\u670d\u52a1\u66f4\u65b0\u811a\u672c', '\u66f4\u65b0\u811a\u672c', '\u811a\u672c', 'untitled', 'untitled script']") &&
    !scriptPanel.includes('\u6a21\u5f0f?') &&
    !scriptPanel.includes('\u6a21\u5f0f?') &&
    scriptPanel.includes('saveDraftScript') &&
    scriptPanel.includes('optimizeSelectedScript') &&
    scriptPanel.includes('applyDraftScript') &&
    !scriptPanel.includes("sendScriptRequest('revise')") &&
    scriptPanel.includes("sendScriptRequest('regenerate')") &&
    scriptPanel.includes('collapsedMessages') &&
    scriptPanel.includes('shouldCollapseMessage') &&
    scriptPanel.includes('isMessageCollapsed') &&
    scriptPanel.includes('toggleMessage') &&
    !scriptPanel.includes('class="message-list script-chat-list"') &&
    !scriptPanel.includes(`:class="{ ai: message.role === 'assistant', error: message.error, collapsed: isMessageCollapsed(message) }"`) &&
    !scriptPanel.includes('class="message-actions"') &&
    scriptPanel.includes('v-if="showScriptComposer"') &&
    scriptPanel.includes('v-if="scriptPanelMode === \'library\'"') &&
    !scriptPanel.includes('class="script-mode-tabs"') &&
    !styles.includes('.script-mode-tabs') &&
    styles.includes('.script-library') &&
    styles.includes('.script-library-body') &&
    styles.includes('grid-template-rows: minmax(0, 1fr)') &&
    styles.includes('max-height: none') &&
    styles.includes('.script-library-empty') &&
    styles.includes('.script-preview') &&
    styles.includes('.script-preview-code') &&
    styles.includes('.script-library-editor') &&
    styles.includes('.script-library-editor .script-editor-toolbar') &&
    styles.includes('/* Expanded script preview modal. */') &&
    styles.includes('.script-preview-modal') &&
    styles.includes('.script-expanded-editor') &&
    styles.includes('.script-code-overlay') &&
    styles.includes('.shell-token.command') &&
    styles.includes('caret-color') &&
    styles.includes('.script-editor-toolbar') &&
    styles.includes('.script-file-tab') &&
    styles.includes('grid-template-columns: minmax(112px, 1fr) auto') &&
    styles.includes('.script-file-tab .record-dot') &&
    styles.includes('display: none;') &&
    styles.includes('.script-file-tab .script-editor-risk') &&
    styles.includes('min-width: max-content') &&
    styles.includes('max-width: none') &&
    styles.includes('/* Draft editor inline action rail. */') &&
    styles.includes('/* Uniform draft editor icon buttons. */') &&
    styles.includes('.script-editor-tools .icon-button:hover:not(:disabled)') &&
    !styles.includes('.script-editor-tools .primary-action') &&
    styles.includes('.script-generate .script-workbench') &&
    styles.includes('grid-template-rows: minmax(420px, 1fr)') &&
    styles.includes('min-height: 420px') &&
    styles.includes('.script-replies-panel') &&
    styles.includes('.script-replies-panel.expanded') &&
    styles.includes('.script-panel button:disabled') &&
    styles.includes('grid-template-columns: 32px minmax(0, 1fr) minmax(0, 1fr) 32px') &&
    styles.includes('/* Action-only script toolbar. */') &&
    styles.includes('min-height: 40px') &&
    styles.includes('.script-draft-card') &&
    styles.includes('.script-draft-card textarea'),
  'Script assistant must keep the script editor as the primary workspace, remove the redundant title block, expose AI replies through a compact collapsible panel instead of an always-visible assistant block, keep top script actions, and hide the user prompt while browsing saved scripts.'
)

assert(
  scriptPanel.includes('<UiIcon name="plus" />') &&
    scriptPanel.includes('<UiIcon name="stop" />') &&
    scriptPanel.includes(':disabled="!recordingHasData && !props.recording.isRecording"') &&
    scriptPanel.includes('<span class="script-file-icon"><UiIcon name="script" size="13" /></span>') &&
    !scriptPanel.includes('<span class="script-file-icon">sh</span>') &&
    scriptPanel.includes('placeholder="在这里编辑保存的脚本..."') &&
    scriptPanel.includes('placeholder="在这里粘贴或编写 shell、bat、PowerShell 脚本..."') &&
    styles.includes('/* Script panel black/white theme polish. */') &&
    styles.includes('.script-head .panel-actions') &&
    styles.includes('.script-recorder > div') &&
    styles.includes('.script-file-icon .ui-icon') &&
    styles.includes('.script-editor-shell textarea::placeholder') &&
    styles.includes('.script-editor-shell textarea::selection') &&
    styles.includes('background: rgba(16, 185, 129, .28);') &&
    styles.includes('.app-shell.theme-light .script-editor-shell textarea') &&
    styles.includes('background: transparent !important;') &&
    styles.includes('.app-shell.theme-light .script-editor-shell textarea::placeholder') &&
    styles.includes('.app-shell.theme-light .script-file-icon') &&
    styles.includes('height: calc(100% - 16px);') &&
    styles.includes('.app-shell.theme-light .script-library-empty'),
  'Script panel must use icon-based script tabs, compact recording controls, visible editor placeholders, green editor selection, full-width workbench layout, stronger script-library empty states, and matching black/light theme surfaces.'
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
    appShell.includes('terminal-target-toggle') &&
    appShell.includes('terminal-target-summary') &&
    appShell.includes('仅同步当前终端') &&
    appShell.includes('{{ terminalTargetLabel }}') &&
    appShell.includes(':title="terminalTargetTitle"') &&
    styles.includes('.terminal-target-toggle') &&
    styles.includes('.terminal-target-summary') &&
    styles.includes('max-width: min(260px, 28vw);') &&
    aiPanel.includes('已发送到目标终端') &&
    scriptPanel.includes('已发送到目标终端'),
  'Terminal tabs must keep the active terminal anchored while selecting multiple targets for synchronized input, AI command execution, and script execution.'
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
    appShell.includes('aiMessagesBySession') &&
    appShell.includes('commandHistoryBySession') &&
    appShell.includes('workspaceSessionsByConnection') &&
    appShell.includes('loadWorkspaceState') &&
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
    appShell.includes('activeAiMessages') &&
    appShell.includes('setAiContextForTerminal') &&
    aiChat.includes('parse_model_error') &&
    aiChat.includes('build_context_bundle') &&
    aiChat.includes('build_system_prompt') &&
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
    scriptPanel.includes('@click="executeScriptContent(shellCommandForPart(part))"') &&
    scriptPanel.includes('extractBashScript') &&
    scriptPanel.includes('saveUpdateScript') &&
    scriptPanel.includes('deleteUpdateScript') &&
    scriptPanel.includes('loadPreviewScripts') &&
    scriptPanel.includes('localStorage') &&
    scriptPanel.includes('bash -s <<') &&
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
    terminalPane.includes('recommendQuickCommandsWithAi') &&
    terminalPane.includes('chatWithAiProvider') &&
    terminalPane.includes('class="modal quick-command-modal"') &&
    terminalPane.includes('quick-command-backdrop') &&
    !terminalPane.includes('@click.self="closeQuickCommandSettings"') &&
    terminalPane.includes('v-model="quickCommandItems[index]"') &&
    terminalPane.includes('根据历史推荐') &&
    terminalPane.includes('推荐候选') &&
    terminalPane.includes('确认恢复') &&
    terminalPane.includes('aiConfig?: AiProviderConfig') &&
    terminalPane.includes('apiKey?: string') &&
    (appShell.match(/:ai-config="aiConfig"/g) ?? []).length >= 2 &&
    (appShell.match(/:api-key="activeAiRuntimeApiKey"/g) ?? []).length >= 2 &&
    styles.includes('.quick-command-modal') &&
    styles.includes('.quick-command-list') &&
    styles.includes('.quick-command-row') &&
    styles.includes('.quick-command-row .command-risk-status') &&
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
    styles.includes('overflow: hidden;\n  box-sizing: border-box;\n  padding: 16px 18px;') &&
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
    uiIcon.includes("'search'") &&
    uiIcon.includes("'stop'") &&
    aiPanel.includes('import UiIcon') &&
    aiPanel.includes('name="history"') &&
    aiPanel.includes('name="arrow-right"') &&
    scriptPanel.includes('import UiIcon') &&
    scriptPanel.includes('name="save"') &&
    scriptPanel.includes('name="maximize"') &&
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
