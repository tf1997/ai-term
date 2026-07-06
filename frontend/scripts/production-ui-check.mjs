import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

const appShell = read('src/components/AppShell.vue')
const terminalPane = read('src/components/TerminalPane.vue')
const aiPanel = read('src/components/AiPanel.vue')
const aiConfig = read('src/components/AiConfigPanel.vue')
const fileTransfer = read('src/components/FileTransferPanel.vue')
const scriptPanel = read('src/components/ScriptPanel.vue')
const scriptRisk = read('src/lib/scriptRisk.ts')
const sidebar = read('src/components/ConnectionSidebar.vue')
const settingsSidebar = read('src/components/SettingsSidebar.vue')
const tauri = read('src/lib/tauri.ts')
const workspacePanel = read('src/components/WorkspacePanel.vue')
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
const commands = read('../src-tauri/src/app/commands.rs')
const credentials = read('../src-tauri/src/domain/auth/credentials.rs')
const tauriLib = read('../src-tauri/src/lib.rs')
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
    '/* Command history expanded action polish. */',
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

assertLastCssDeclarations(
  '.history-row.expanded .history-actions',
  {
    order: '-1',
    position: 'sticky',
    top: '0',
    'z-index': '1',
    'padding-top': '0',
    'padding-bottom': '6px',
    'border-top': '0',
    background: 'inherit',
  },
  'Expanded command history actions must remain visible above long command previews',
  { afterMarker: '/* Command history expanded action polish. */', beforeMarker: '/* Light theme shell structure parity contract. */' }
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
    aiPanel.includes('v-if="isShellLanguage(part.language) && normalizeShellCommand(part.content)"') &&
    aiPanel.includes('SHELL_COMMAND_LANGUAGES') &&
    aiPanel.includes("'bat'") &&
    aiPanel.includes("'cmd'") &&
    aiPanel.includes("'powershell'") &&
    !aiPanel.includes("['bash', 'sh', 'shell', 'zsh', '']"),
  'AI execute buttons must only appear on explicit shell code blocks, including bash and Windows bat/cmd/powershell blocks.'
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
    terminalPane.includes('class="terminal-completion"') &&
    appShell.includes(':command-history="commandHistoryForTab(tab)"') &&
    appShell.includes('key.startsWith(`${tab.connectionId}:`)') &&
    styles.includes('.terminal-completion') &&
    styles.includes('.terminal-native-code') &&
    styles.includes('.xterm-host .xterm-rows'),
  'TerminalPane must provide native-feeling terminal code styling plus command completion from system commands and same-connection user command history.'
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
    fileTransfer.includes('sftpListDirectory') &&
    fileTransfer.includes('sftpUploadFile') &&
    fileTransfer.includes('sftpUploadPath') &&
    fileTransfer.includes('sftpDownloadFile') &&
    fileTransfer.includes('sftpDownloadPath') &&
    fileTransfer.includes('sftpDeletePath') &&
    fileTransfer.includes('localHomeDirectory') &&
    fileTransfer.includes('localListDirectory') &&
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
    fileTransfer.includes('hasRemoteShellSnapshot') &&
    fileTransfer.includes('useForSftp') &&
    fileTransfer.includes('writeTerminalInput') &&
    fileTransfer.includes('remoteReady') &&
    tauri.includes("invoke<LocalDirectoryResponse>('local_list_directory'") &&
    tauri.includes("invoke<boolean>('cancel_task'") &&
    tauri.includes("invoke<SftpListResponse>('sftp_list_directory'") &&
    tauri.includes("invoke<SftpTransferResponse>('sftp_upload_path'") &&
    tauri.includes("invoke<SftpTransferResponse>('sftp_download_path'") &&
    tauri.includes("invoke<SftpProbeResponse>('sftp_probe'") &&

    styles.includes('.sftp-workbench-active .right-panel') &&
    styles.includes('grid-column: 3 / 5;') &&
    styles.includes('grid-template-columns: minmax(320px, 1fr) minmax(320px, 1fr);') &&
    styles.includes('.file-type-icon.folder') &&
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
  fileTransfer.includes('lastTransfer') &&
    fileTransfer.includes('transfer-target-strip') &&
    fileTransfer.includes('transfer-progress') &&
    fileTransfer.includes('openLastTransferLocation') &&
    fileTransfer.includes('copyLastTransferPath') &&
    fileTransfer.includes('joinLocalPath') &&
    fileTransfer.includes('onSftpTransferProgress') &&
    tauri.includes('localPath?: string') &&
    tauri.includes('remotePath?: string') &&
    tauri.includes('targetPath?: string') &&
    tauri.includes('onSftpTransferProgress') &&
    styles.includes('.transfer-target-strip') &&
    styles.includes('.transfer-progress') &&
    styles.includes('@keyframes transfer-progress-slide') &&
    sftpBackend.includes('SftpProgressUpdate') &&
    sftpBackend.includes('extract_sftp_progress_percent') &&
    sftpBackend.includes('download_target_path') &&
    commands.includes('SftpTransferEvent') &&
    commands.includes('upload_path_with_progress') &&
    commands.includes('download_path_with_progress'),
  'SFTP file and folder transfers must show clear local/remote targets, progress, final paths, and actions to locate or copy completed downloads/uploads.'
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
    !scriptPanel.includes(':disabled="!hasDraftScript" @click="saveDraftScript"') &&
    !scriptPanel.includes(':disabled="!hasDraftScript" @click="executeDraftScript"') &&
    !scriptPanel.includes(':disabled="!hasDraftScript" @click="copyDraftScript"') &&
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
  sidebar.includes('v-model="selectedProfile.target.host"') &&
    sidebar.includes('v-model="selectedProfile.target.username"') &&
    sidebar.includes('v-model.number="selectedProfile.target.port"') &&
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
    styles.includes('grid-template-rows: minmax(0, 1fr) auto;'),
  'Terminal pane must not render the old bottom local status footer.'
)

assert(
  appShell.includes('selectedTerminalIds') &&
    appShell.includes('targetTerminalIds') &&
    appShell.includes('multiTerminalInputEnabled') &&
    appShell.includes('terminalTargetLabel') &&
    appShell.includes('toggleTerminalTarget') &&
    appShell.includes('selectAllTerminalTargets') &&
    appShell.includes('resetTerminalTargetsToActive') &&
    appShell.includes('syncTerminalInputToTargets') &&
    appShell.includes('writeInputToTargetTerminals') &&
    appShell.includes('terminal-target-toggle') &&
    appShell.includes('terminal-target-summary') &&
    appShell.includes('{{ terminalTargetLabel }}') &&
    styles.includes('.terminal-target-toggle') &&
    styles.includes('.terminal-target-summary') &&
    aiPanel.includes('已发送到目标终端') &&
    scriptPanel.includes('已发送到目标终端'),
  'Terminal tabs must support selecting multiple targets for synchronized input, AI command execution, and script execution.'
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
    aiPanel.includes('context compressed') &&
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
    aiPanel.includes('parseMessageParts') &&
    aiPanel.includes('extractPrimaryShellCommand') &&
    aiPanel.includes('../lib/scriptRisk') &&
    aiPanel.includes('aiCommandRiskConfirmOpen') &&
    aiPanel.includes('pendingAiCommandExecution') &&
    aiPanel.includes('commandRiskStatus') &&
    aiPanel.includes('executeGeneratedCommand') &&
    aiPanel.includes('confirmPendingAiCommandExecution') &&
    aiPanel.includes('class="command-risk-status"') &&
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
    scriptPanel.includes(':class="[line.riskClass, { flagged: line.risks.length }]"') &&
    !scriptPanel.includes('检测到高风险脚本，确认要在当前终端执行吗？') &&
    !scriptPanel.includes('window.confirm(`妫€娴嬪埌楂橀闄╄剼鏈') &&
    styles.includes('.script-risk-modal') &&
    styles.includes('.script-risk-line') &&
    styles.includes('.script-risk-line.flagged') &&
    styles.includes('.risk-delete') &&
    styles.includes('.risk-edit') &&
    styles.includes('.risk-reboot') &&
    styles.includes('.risk-upgrade') &&
    styles.includes('.command-risk-status') &&
    styles.includes('.script-editor-risk') &&
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
    commandHistoryPanel.includes('expandedCommandIds') &&
    commandHistoryPanel.includes('isLongCommand') &&
    commandHistoryPanel.includes('history-command-cell') &&
    commandHistoryPanel.includes(':aria-expanded="isExpanded(entry)"') &&
    commandHistoryPanel.includes("emit('rerun'") &&
    styles.includes('.history-toolbar') &&
    styles.includes('.history-meta') &&
    styles.includes('.history-row.expanded') &&
    styles.includes('.history-row.expanded .history-actions') &&
    styles.includes('grid-template-columns: minmax(0, 1fr);') &&
    styles.includes('overflow-wrap: anywhere;') &&
    styles.includes('/* Command history expanded action polish. */') &&
    styles.includes('order: -1;') &&
    styles.includes('.history-actions'),
  'CommandHistoryPanel must cap visible command history, support search, copy, long-command expansion, and allow rerunning a command.'
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
    terminalPane.includes('quickCommandDraft') &&
    terminalPane.includes('recommendQuickCommandsWithAi') &&
    terminalPane.includes('chatWithAiProvider') &&
    terminalPane.includes('class="modal quick-command-modal"') &&
    !terminalPane.includes('@click.self="closeQuickCommandSettings"') &&
    terminalPane.includes('v-model="quickCommandDraft"') &&
    terminalPane.includes('AI 推荐') &&
    terminalPane.includes('aiConfig?: AiProviderConfig') &&
    terminalPane.includes('apiKey?: string') &&
    (appShell.match(/:ai-config="aiConfig"/g) ?? []).length >= 2 &&
    (appShell.match(/:api-key="activeAiRuntimeApiKey"/g) ?? []).length >= 2 &&
    styles.includes('.quick-command-modal') &&
    styles.includes('.quick-command-editor') &&
    terminalPane.includes('terminal-heading') &&
    terminalPane.includes('copyTerminalOutput') &&
    !terminalPane.includes('connection-strip'),
  'TerminalPane must expose a compact terminal header and quick command bar without the old tall connection summary.'
)

assert(
  workspacePanel.includes("activeWorkspaceTab === 'ai'") &&
    workspacePanel.includes("activeWorkspaceTab === 'history'") &&
    workspacePanel.includes("activeWorkspaceTab === 'scripts'") &&
    workspacePanel.includes('SFTP') &&
    aiConfig.includes('Custom AI Provider') &&
    settingsSidebar.includes('AiConfigPanel') &&
    !aiPanel.includes('AiConfigPanel'),
  'Workspace must use the prototype AI assistant tab labels and AI configuration must live in the left settings menu.'
)

assert(
  tauriConfig.includes('"width": 1280') &&
    tauriConfig.includes('"minWidth": 980') &&
    styles.includes('min-width: 980px') &&
    styles.includes('@media (max-width: 1280px)') &&
    styles.includes('@media (max-width: 1080px)') &&
    styles.includes('position: absolute') &&
    styles.includes('right-panel') &&
    !styles.includes('.app-shell:not(.right-collapsed) .right-panel {\n    display: none;'),
  'Frontend layout must adapt to the 1280 default and 980 minimum Tauri window widths without horizontal clipping.'
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
    !aiPanel.includes('@click.self="closeAiCommandRiskConfirm"') &&
    scriptPanel.includes('explainPendingScriptRisk') &&
    scriptPanel.includes('buildScriptRiskExplanationPrompt') &&
    scriptPanel.includes('scriptRiskExplanationLoading') &&
    scriptPanel.includes('onAiChatStream(requestId') &&
    scriptPanel.includes('streamedAnswer += event.delta') &&
    scriptPanel.includes('借助 AI 分析风险') &&
    scriptPanel.includes('AI 正在分析风险') &&
    scriptPanel.includes('aria-live="polite"') &&
    !scriptPanel.includes('@click.self="closeScriptRiskConfirm"') &&
    styles.includes('.script-risk-ai') &&
    styles.includes('.script-risk-ai-output') &&
    styles.includes('.script-risk-thinking') &&
    styles.includes('.script-risk-ai-placeholder'),
  'Risk confirmation modals must stay open on backdrop clicks and stream AI risk explanations with an active answering state.'
)

assert(
  settingsSidebar.includes('terminalFontFamily') &&
    settingsSidebar.includes('terminalFontSize') &&
    settingsSidebar.includes('defaultShell') &&
    settingsSidebar.includes('proxyUrl') &&
    settingsSidebar.includes('\u7ec8\u7aef\u5916\u89c2') &&
    settingsSidebar.includes('\u7f51\u7edc\u4e0e\u4ee3\u7406') &&
    settingsSidebar.includes('\u9009\u62e9\u7ec8\u7aef\u5b57\u4f53') &&
    settingsSidebar.includes('Cascadia Mono') &&
    !settingsSidebar.includes('\u7ec8\u7aef\u4e3b\u9898') &&
    !settingsSidebar.includes('v-model="draft.terminalTheme"') &&
    !settingsSidebar.includes('\u5b89\u5168\u4e0e\u5bc6\u94a5') &&
    !settingsSidebar.includes('\u66f4\u65b0\u4e0e\u6570\u636e') &&
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
    appShell.includes('class="toast-stack"') &&
    terminalPane.includes('terminalSettings?: TerminalVisualSettings') &&
    terminalPane.includes('applyTerminalAppearance') &&
    terminalPane.includes('terminalThemeOptions') &&
    appShell.includes(':terminal-settings="appSettings"') &&
    styles.includes('.settings-controls') &&
    styles.includes('.settings-search') &&
    styles.includes('.settings-config-list') &&
    styles.includes('.settings-empty') &&
    styles.includes('.app-toast') &&
    styles.includes('.toast-stack'),
  'Settings center must keep the visible settings surface focused, use selectable terminal fonts, hide terminal theme controls, and retain shared toasts.'
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
    fileTransfer.includes('name="folder-open"'),
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
    styles.includes('/* History expansion and light divider polish. */') &&
    styles.includes('/* Light theme layout parity. */') &&
    styles.includes('/* Light theme dark-surface cleanup. */') &&
    styles.includes('/* Light theme state surface cleanup. */') &&
    styles.includes('/* Light theme status indicator cleanup. */') &&
    styles.includes('/* Command history expanded action polish. */') &&
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
    styles.includes('.theme-light .file-context-menu') &&
    styles.includes('.theme-light .terminal-completion') &&
    styles.includes('.app-shell.theme-light .terminal-native-code .xterm-host .composition-view') &&
    styles.includes('.app-shell.theme-light .workspace-open-handle') &&
    styles.includes('.app-shell.theme-light .record-dot') &&
    styles.includes('.app-shell.theme-light .status-dot.live') &&
    styles.includes('.app-shell.theme-light .badge') &&
    styles.includes('.rail-button.active::before') &&
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
console.log('production-ui-check passed')
