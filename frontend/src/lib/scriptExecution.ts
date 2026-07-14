import type { ShellScriptLanguage } from './shellCommand'

const BACKTICK = String.fromCharCode(96)
const ANSI_SINGLE_QUOTE = 'ansi-single'

interface BashHeredoc {
  delimiter: string
  stripTabs: boolean
}

interface BashLexState {
  quote: string | null
  heredocs: BashHeredoc[]
  arithmeticDepth: number
}

/**
 * Remove only standalone Bash comment lines at the last moment before sending.
 * Source text, risk lines, and editor line numbers remain untouched.
 */
export function prepareScriptForExecution(content: string, language: ShellScriptLanguage = 'bash') {
  const source = content.replace(/\r\n?/g, '\n')
  if (language === 'powershell' || language === 'cmd') return source
  return stripBashComments(source)
}

function stripBashComments(source: string) {
  const state: BashLexState = { quote: null, heredocs: [], arithmeticDepth: 0 }
  return source.split('\n').map((line, lineIndex) => {
    if (state.heredocs.length) {
      const heredoc = state.heredocs[0]
      const candidate = heredoc.stripTabs ? line.replace(/^\t+/, '') : line
      if (candidate === heredoc.delimiter) state.heredocs.shift()
      return line
    }

    // A first-line shebang is an interpreter directive, not an ordinary comment.
    if (lineIndex === 0 && line.startsWith('#!')) return line
    if (!state.quote && state.arithmeticDepth === 0 && /^\s*#/.test(line)) return ''

    const result = scanBashLine(line, state)
    state.heredocs.push(...result.heredocs)
    return line
  }).join('\n')
}

function scanBashLine(line: string, state: BashLexState) {
  const heredocs: BashHeredoc[] = []
  let index = 0

  while (index < line.length) {
    const character = line[index]

    if (state.quote === ANSI_SINGLE_QUOTE) {
      if (character === '\\') {
        index += index === line.length - 1 ? 1 : 2
        continue
      }
      if (character === "'") state.quote = null
      index += 1
      continue
    }

    if (state.quote === "'") {
      if (character === "'") state.quote = null
      index += 1
      continue
    }

    if (state.quote === '"') {
      if (character === '\\') {
        index += index === line.length - 1 ? 1 : 2
        continue
      }
      if (character === '"') state.quote = null
      index += 1
      continue
    }

    if (state.quote === BACKTICK) {
      if (character === '\\') {
        index += index === line.length - 1 ? 1 : 2
        continue
      }
      if (character === BACKTICK) state.quote = null
      index += 1
      continue
    }

    if (state.arithmeticDepth > 0) {
      if (character === '(') state.arithmeticDepth += 1
      if (character === ')') state.arithmeticDepth -= 1
      index += 1
      continue
    }

    if (character === '$' && line[index + 1] === '(' && line[index + 2] === '(') {
      state.arithmeticDepth = 2
      index += 3
      continue
    }
    if (character === '(' && line[index + 1] === '(') {
      state.arithmeticDepth = 2
      index += 2
      continue
    }

    if (character === '$' && line[index + 1] === "'") {
      state.quote = ANSI_SINGLE_QUOTE
      index += 2
      continue
    }
    if (character === '\\') {
      index += index === line.length - 1 ? 1 : 2
      continue
    }
    if (character === "'" || character === '"' || character === BACKTICK) {
      state.quote = character
      index += 1
      continue
    }

    if (character === '<' && line[index + 1] === '<' && line[index + 2] !== '<') {
      const heredoc = readHeredocDelimiter(line, index + 2)
      if (heredoc) {
        heredocs.push(heredoc.value)
        index = heredoc.nextIndex
        continue
      }
    }

    index += 1
  }

  return { heredocs }
}

function readHeredocDelimiter(line: string, start: number) {
  let index = start
  let stripTabs = false
  if (line[index] === '-') {
    stripTabs = true
    index += 1
  }
  while (/\s/.test(line[index] ?? '')) index += 1
  let delimiter = ''
  let quote: "'" | '"' | null = null
  let consumed = false

  while (index < line.length) {
    const character = line[index]
    if (quote) {
      if (character === quote) {
        quote = null
        consumed = true
        index += 1
        continue
      }
      if (character === '\\' && quote === '"' && index + 1 < line.length) {
        delimiter += line[index + 1]
        consumed = true
        index += 2
        continue
      }
      delimiter += character
      consumed = true
      index += 1
      continue
    }
    if (/\s|[;|&()<>]/.test(character)) break
    if (character === '$' && (line[index + 1] === "'" || line[index + 1] === '"')) {
      quote = line[index + 1] as "'" | '"'
      consumed = true
      index += 2
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      consumed = true
      index += 1
      continue
    }
    if (character === '\\' && index + 1 < line.length) {
      delimiter += line[index + 1]
      consumed = true
      index += 2
      continue
    }
    delimiter += character
    consumed = true
    index += 1
  }

  if (!consumed || quote) return null
  return { value: { delimiter, stripTabs }, nextIndex: index }
}
