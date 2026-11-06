// Shared lexical scan for risk review and Agent authorization. This is not a full shell parser.
const BACKTICK = String.fromCharCode(96)

type QuoteState = null | 'single' | 'double' | 'ansi' | 'backtick'

export const MAX_RISK_SCAN_CHARS = 128 * 1024

export interface ScannedShellWord {
  value: string
  raw: string
  start: number
}

export interface CommandScan {
  /** 各段的 token 列表(引号内容并入所在 token,引号本身移除)。 */
  segments: string[][]
  details: { words: ScannedShellWord[]; start: number; end: number }[]
  redirects: { target: string; start: number }[]
  issues: { offset: number; message: string }[]
  budgetExceeded: boolean
  /** 存在写文件的输出重定向(目标 /dev/null 与 fd 复制 2>&1 等除外)。 */
  redirectVeto: boolean
  /** 存在命令替换 $(、反引号、进程替换 <( )( 或历史展开等注入结构(单引号内除外)。 */
  substitutionVeto: boolean
  historyExpansionVeto: boolean
  /** 未建模的分组、子 shell 或函数语法，必须人工确认。 */
  ambiguousSyntaxVeto: boolean
  unclosedQuote: boolean
  heredoc: boolean
  heredocOffset?: number
  /**
   * 命令以分隔符/续行符结尾(后台 &、悬空 | && ||、行尾反斜杠),末尾无实际内容。
   * 结尾 `;` 与换行不算——它们可以安全追加。哨兵包装用它判断能否追加 `; printf`。
   */
  trailingOperator: boolean
}

function isWordBoundary(ch: string | undefined): boolean {
  return ch === undefined || /[\s;|&<>]/.test(ch)
}

/**
 * bash/zsh 交互终端的历史展开:`!` 后紧跟空白、行尾、= ( " 时为字面量,
 * 其余(!!、!字符串、!? 等)展开结果会原样插入命令行——等价于命令注入,按替换结构否决。
 * agent 命令写入的是用户的交互终端,histexpand 是激活的,双引号也挡不住。
 */
function isHistoryExpansionTrigger(next: string | undefined): boolean {
  return next !== undefined && !' \t\n=("'.includes(next)
}

/**
 * 引号感知扫描:把整条命令拆成段并取词,同时收集一票否决所需的结构信息。
 * 分隔符:|(含 || 与 |&)、;、&&、后台 &、换行;引号/转义内的分隔符不生效。
 */
export function scanCommand(command: string): CommandScan {
  if (command.length > MAX_RISK_SCAN_CHARS) {
    return {
      segments: [], details: [], redirects: [], issues: [{ offset: 0, message: '命令超过风险分析长度上限，无法完整检查，请拆分后审查。' }],
      budgetExceeded: true, redirectVeto: false, substitutionVeto: false, historyExpansionVeto: false,
      ambiguousSyntaxVeto: true, unclosedQuote: false, heredoc: false, trailingOperator: false
    }
  }
  const text = command.replace(/\r\n?/g, '\n')
  const segments: string[][] = []
  const details: CommandScan['details'] = []
  const redirects: CommandScan['redirects'] = []
  const issues: CommandScan['issues'] = []
  let tokens: string[] = []
  let words: ScannedShellWord[] = []
  let wordStart = 0
  let segmentStart = 0
  /** 进行中的词;null 表示当前无词。 */
  let word: string | null = null
  /** 进行中的词是否仍是「未经引号的纯数字」——用于识别 2>&1 / 2>/dev/null 的 fd 前缀。 */
  let wordIsBareDigits = false
  let quote: QuoteState = null
  /** 反引号结束后应回到的引号状态(反引号可出现在双引号内)。 */
  let backtickReturn: 'double' | null = null
  /** 下一个完成的词是输出重定向目标(不进入 token 列表,仅校验是否 /dev/null)。 */
  let awaitingRedirectTarget = false
  let redirectStart = 0
  let redirectVeto = false
  let substitutionVeto = false
  let historyExpansionVeto = false
  let ambiguousSyntaxVeto = false
  let heredoc = false
  let heredocOffset: number | undefined
  /** 最近一个未被实际内容跟随的分隔符;null 表示末尾有内容。 */
  let danglingSeparator: string | null = null

  const uncertain = (offset: number, message: string) => {
    // One location per reason is enough to require review of the whole input.
    if (!issues.some(issue => issue.message === message)) issues.push({ offset, message })
  }
  const substitution = (offset: number) => {
    substitutionVeto = true
    uncertain(offset, '包含命令替换、进程替换或历史展开，实际执行内容需要逐次确认。')
  }
  const appendChar = (ch: string, quoted: boolean) => {
    danglingSeparator = null
    if (word === null) {
      wordStart = index
      word = ch
      wordIsBareDigits = !quoted && /^[0-9]$/.test(ch)
      return
    }
    word += ch
    if (quoted || !/^[0-9]$/.test(ch)) wordIsBareDigits = false
  }
  /** 进入引号即视为开始一个词(空引号 '' 也是一个空参数)。 */
  const openQuotedWord = () => {
    danglingSeparator = null
    if (word === null) { word = ''; wordStart = index }
    wordIsBareDigits = false
  }
  const finishWord = () => {
    if (word === null) return
    const value = word
    word = null
    wordIsBareDigits = false
    if (awaitingRedirectTarget) {
      awaitingRedirectTarget = false
      redirects.push({ target: value, start: redirectStart })
      if (value !== '/dev/null') redirectVeto = true
      return
    }
    tokens.push(value)
    words.push({ value, raw: text.slice(wordStart, index), start: wordStart })
  }
  const finishSegment = () => {
    finishWord()
    if (awaitingRedirectTarget) {
      // 悬空的 >(无目标),按不可靠结构否决。
      redirectVeto = true
      uncertain(redirectStart, '输出重定向缺少完整目标，无法判定写入位置。')
      awaitingRedirectTarget = false
    }
    if (tokens.length || segmentStart < index) {
      details.push({ words, start: segmentStart, end: index })
      if (tokens.length) segments.push(tokens)
    }
    tokens = []
    words = []
    segmentStart = index + 1
  }

  let index = 0
  while (index < text.length) {
    const ch = text[index]
    const next: string | undefined = text[index + 1]

    if (quote === 'single') {
      if (ch === "'") { quote = null; index += 1; continue }
      appendChar(ch, true)
      index += 1
      continue
    }
    if (quote === 'ansi') {
      // Escape decoding can change command names/flags; do not authorize the
      // undecoded token as though it were the shell's actual value.
      if (ch === '\\') {
        ambiguousSyntaxVeto = true
        uncertain(index, '包含尚未解析的 ANSI-C 转义，实际命令需要确认。')
        if (next !== undefined) appendChar(next, true)
        index += 2
        continue
      }
      if (ch === "'") { quote = null; index += 1; continue }
      appendChar(ch, true)
      index += 1
      continue
    }
    if (quote === 'backtick') {
      // 反引号出现本身已整体否决,内容只需跳过以正确找到闭合位置。
      if (ch === '\\') { index += 2; continue }
      if (ch === BACKTICK) { quote = backtickReturn; backtickReturn = null; index += 1; continue }
      index += 1
      continue
    }
    if (quote === 'double') {
      if (ch === '\\') {
        if (next === '\n') { index += 2; continue }
        if (next !== undefined && '$`"\\'.includes(next)) { appendChar(next, true); index += 2 }
        else { appendChar(ch, true); index += 1 }
        continue
      }
      if (ch === '"') { quote = null; index += 1; continue }
      // 双引号内 $(、反引号、历史展开仍然生效。
      if (ch === '$' && next === '(') { substitution(index); index += 2; continue }
      if (ch === BACKTICK) { substitution(index); backtickReturn = 'double'; quote = 'backtick'; index += 1; continue }
      if (ch === '!' && isHistoryExpansionTrigger(next)) { substitution(index); historyExpansionVeto = true; index += 1; continue }
      appendChar(ch, true)
      index += 1
      continue
    }

    // —— 常规(无引号)状态 ——
    if (ch === '\\') {
      // 行续接(\ + 换行)与行尾反斜杠直接跳过;其余为字符转义,取字面字符。
      if (next === '\n' || next === undefined) { danglingSeparator = '\\'; index += 2; continue }
      appendChar(next, true)
      index += 2
      continue
    }
    if (ch === "'") { openQuotedWord(); quote = 'single'; index += 1; continue }
    if (ch === '"') { openQuotedWord(); quote = 'double'; index += 1; continue }
    if (ch === '$' && next === "'") { openQuotedWord(); quote = 'ansi'; index += 2; continue }
    if (ch === '$' && next === '(') { substitution(index); index += 2; continue }
    if (ch === BACKTICK) { substitution(index); backtickReturn = null; quote = 'backtick'; index += 1; continue }
    if (ch === '!' && isHistoryExpansionTrigger(next)) { substitution(index); historyExpansionVeto = true; index += 1; continue }
    if (ch === '#' && word === null) {
      const newline = text.indexOf('\n', index)
      if (newline < 0) break
      index = newline
      continue
    }
    if (ch === '(' || ch === ')' || ch === '{' || ch === '}') {
      ambiguousSyntaxVeto = true
      uncertain(index, '包含尚未完整分析的分组、函数或参数结构，请检查完整命令。')
      appendChar(ch, false)
      index += 1
      continue
    }
    if (ch === ' ' || ch === '\t') { finishWord(); index += 1; continue }
    if (ch === '\n' || ch === ';') { finishSegment(); danglingSeparator = ';'; index += 1; continue }
    if (ch === '|') {
      // |、||、|& 均按段分隔(|& 等价 2>&1 |,无文件写入)。
      finishSegment()
      danglingSeparator = '|'
      index += next === '|' || next === '&' ? 2 : 1
      continue
    }
    if (ch === '&') {
      if (next === '>') {
        // &> / &>> :stdout+stderr 一并重定向,目标须为 /dev/null。
        finishWord()
        awaitingRedirectTarget = true
        redirectStart = index
        index += text[index + 2] === '>' ? 3 : 2
        continue
      }
      // && 与后台 & 均按段分隔,后台的每个部分同样逐段判定。
      finishSegment()
      danglingSeparator = '&'
      index += next === '&' ? 2 : 1
      continue
    }
    if (ch === '<') {
      if (next === '<') {
        if (text[index + 2] === '<') {
          // <<< herestring:无文件写入,后随词按普通 token 处理。
          finishWord()
          index += 3
          continue
        }
        heredoc = true
        heredocOffset ??= index
        uncertain(index, '包含 heredoc 脚本或数据块，当前分析器不能完整判定其执行内容。')
        index += 2
        continue
      }
      // 进程替换 <(…) 内含命令执行,与命令替换同类否决。
      if (next === '(') { substitution(index); index += 2; continue }
      if (next === '>') {
        redirectVeto = true
        uncertain(index, '读写重定向可能创建或修改文件，请确认目标。')
        index += 2
        continue
      }
      // 普通输入重定向只读文件,不否决;文件名按普通 token 处理。
      finishWord()
      index += 1
      continue
    }
    if (ch === '>') {
      // 进程替换 >(…) 同上。
      if (next === '(') { substitution(index); index += 2; continue }
      // fd 前缀(如 2> 的 2):未经引号的纯数字词属于重定向本身,不算命令 token。
      if (word !== null) {
        if (wordIsBareDigits) {
          word = null
          wordIsBareDigits = false
        } else {
          finishWord()
        }
      }
      let cursor = index + 1
      if (text[cursor] === '>') cursor += 1 // >>
      if (text[cursor] === '|') cursor += 1 // >| overrides noclobber
      if (text[cursor] === '&') {
        cursor += 1
        if (text[cursor] === '-') { index = cursor + 1; continue } // >&- 关闭 fd,无文件写入
        let digitsEnd = cursor
        while (/[0-9]/.test(text[digitsEnd] ?? '')) digitsEnd += 1
        if (digitsEnd > cursor && isWordBoundary(text[digitsEnd])) {
          // 2>&1 之类的 fd 复制,允许。
          index = digitsEnd
          continue
        }
        // >&word 形式:按重定向到文件处理,落到目标校验。
      }
      awaitingRedirectTarget = true
      redirectStart = index
      index = cursor
      continue
    }
    appendChar(ch, false)
    index += 1
  }

  const unclosedQuote = quote !== null
  finishSegment()
  if (unclosedQuote) uncertain(wordStart, '命令包含未闭合的引号，无法完整分析。')
  if (danglingSeparator !== null && danglingSeparator !== ';') uncertain(Math.max(0, text.length - 1), '命令以未完成的操作符或续行结束，请检查完整内容。')
  return {
    segments,
    details,
    redirects,
    issues,
    budgetExceeded: false,
    redirectVeto,
    substitutionVeto,
    historyExpansionVeto,
    ambiguousSyntaxVeto,
    unclosedQuote,
    heredoc,
    heredocOffset,
    trailingOperator: danglingSeparator !== null && danglingSeparator !== ';'
  }
}
