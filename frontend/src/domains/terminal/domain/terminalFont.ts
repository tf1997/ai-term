/**
 * 终端字体族的 CJK 兜底。
 *
 * xterm 不读 CSS 变量,字体族是通过 options.fontFamily 用 JS 传的,因此 styles.css 上
 * 的 --font-mono 兜底管不到终端正文。设置里的预设与用户自定义值都只列 Latin 等宽字体,
 * 而等宽字体基本都没有中文字形,中文会穿透整条栈落到 generic 关键字、由系统挑脸:
 * Windows 挑到 SimSun(衬线点阵脸,与 Cascadia 完全不搭),macOS 挑到 PingFang SC。
 * 显式兜底才能让两端观感一致。
 */

/**
 * CSS generic family 关键字。这类关键字一定能解析成功,排在它后面的字体永远轮不到,
 * 所以兜底必须插在它之前 —— 而设置里的预设恰好全都以 monospace 结尾,直接追加等于没写。
 */
const CSS_GENERIC_FONT_FAMILIES = new Set([
  'monospace',
  'sans-serif',
  'serif',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-monospace',
  'ui-sans-serif',
  'ui-serif',
  'ui-rounded'
])

function unquote(segment: string) {
  return segment.replace(/^["']|["']$/g, '')
}

/** 含空格或非 ASCII 的族名必须带引号;纯 ASCII 标识符保持原样,免得改动既有预设的写法。 */
function quoteFamily(name: string) {
  return /^[a-zA-Z-]+$/.test(name) ? name : `"${name}"`
}

/**
 * 把 `fallbacks` 插入 `fontFamily`,位置在末尾的 generic 关键字之前。
 *
 * - 已经列出的族名不重复插入(大小写不敏感),因此对同一输入反复调用是稳定的。
 * - 末尾不是 generic 关键字时直接追加。
 * - 空输入原样返回。
 */
export function withCjkFallback(fontFamily: string, fallbacks: readonly string[]) {
  const segments = fontFamily.split(',').map((segment) => segment.trim()).filter(Boolean)
  if (!segments.length) return fontFamily

  const present = new Set(segments.map((segment) => unquote(segment).toLowerCase()))
  const missing = fallbacks.filter((name) => !present.has(name.toLowerCase()))
  if (!missing.length) return fontFamily

  const tail = unquote(segments[segments.length - 1]).toLowerCase()
  const insertAt = CSS_GENERIC_FONT_FAMILIES.has(tail) ? segments.length - 1 : segments.length
  segments.splice(insertAt, 0, ...missing.map(quoteFamily))
  return segments.join(', ')
}

/** Windows 上 Noto 由 main.ts 打包加载(font-display: swap),首帧未就绪时垫系统自带的雅黑。 */
export const WINDOWS_TERMINAL_CJK_FALLBACK = ['Noto Sans SC Variable', 'Microsoft YaHei UI'] as const
export const SYSTEM_TERMINAL_CJK_FALLBACK = ['PingFang SC'] as const
