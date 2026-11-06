import type { AgentAutoExecClassification } from './agent'
import { scanCommand } from '../../../shared/security/shellCommandScan'
import { analyzeScriptRisks } from '../../../shared/security/scriptRisk'

// Agent 自动执行判定器(任务 F7,规则来源:docs/ai-agent-mode-development.md 6.4)。
//
// 与脚本风险检查复用 shared/security 的词法扫描；未支持的结构不自动授权。
//
// 判定总则(6.4):
// 1. 整条命令按引号感知规则拆成段(| ; && || 与后台 &、换行为分隔;引号内不生效);
//    未闭合引号、heredoc(<<)整体不可自动执行。
// 2. 每段剥离前缀环境变量赋值与 timeout/command 透明包装后独立判定,全部通过才放行。
// 3. 一票否决(与允许来源无关):sudo 首 token、写文件的输出重定向(/dev/null 与
//    fd 复制除外)、命令替换 $(…)/反引号/进程替换(单引号内除外)。
// 4. token 前缀匹配允许来源:用户 patterns(显式授权,不附加条目级规则)∪ 内置只读集
//    (includeBuiltin 时;命中后执行条目级 forbiddenTokens / nextTokenAllowlist 规则)。

const BACKTICK = String.fromCharCode(96)

/** 内置只读命令条目。pattern 为 1–2 个 token 的前缀模式(如 'ls'、'git status')。 */
export interface BuiltinReadonlyEntry {
  pattern: string
  /** 条目 token 之后的任一 token 命中任一正则即否决(如 tail 的 -f)。 */
  forbiddenTokens?: RegExp[]
  /**
   * 条目 token 之后若存在首个非 - 开头的 token,必须在此列表内,否则否决
   * (用于 ip addr 限 show 语义;空数组表示不允许任何非选项参数)。
   */
  nextTokenAllowlist?: string[]
}

// follow 类参数会让命令常驻,挂住 agent 循环,一律否决。
const FOLLOW_SHORT_FLAG = /^-[a-zA-Z]*f$/
const FOLLOW_LONG_FLAG = /^--follow/
// git log/diff/show 的 --output 会写文件。
const GIT_OUTPUT_FLAG = /^--output(=|$)/

/**
 * 内置只读命令集(文档 6.4 清单的收紧版)。
 * 刻意不收录:less/more/top/watch/tail -f 等常驻或分页命令(会挂住循环)、
 * curl/wget(网络副作用)、echo(无价值)、cd(改变会话状态)。
 * 标注「额外收紧」的条目是在任务规格之上封堵的写/执行漏洞,见各自注释。
 */
export const BUILTIN_READONLY_COMMANDS: BuiltinReadonlyEntry[] = [
  // —— 单 token 只读命令 ——
  { pattern: 'ls' },
  { pattern: 'cat' },
  { pattern: 'head' },
  { pattern: 'stat' },
  { pattern: 'file' },
  { pattern: 'wc' },
  { pattern: 'du' },
  { pattern: 'df' },
  { pattern: 'free' },
  { pattern: 'uptime' },
  { pattern: 'w' },
  { pattern: 'who' },
  { pattern: 'whoami' },
  { pattern: 'id' },
  { pattern: 'uname' },
  // 额外收紧:`hostname <名称>` 会设置主机名(root 下生效),只允许纯选项用法。
  { pattern: 'hostname', nextTokenAllowlist: [] },
  // 额外收紧:date -s/--set 会设置系统时间(-Is 等展示用法被误伤时走人工审批,无害)。
  { pattern: 'date', forbiddenTokens: [/^-[a-zA-Z]*s$/, /^--set/] },
  { pattern: 'printenv' },
  // 额外收紧:`env CMD` 会执行任意命令,只允许纯选项用法(打印环境)。
  { pattern: 'env', nextTokenAllowlist: [] },
  { pattern: 'which' },
  { pattern: 'type' },
  { pattern: 'ps' },
  { pattern: 'pgrep' },
  // 额外收紧:ss -K/--kill 会强制关闭连接。
  { pattern: 'ss', forbiddenTokens: [/^-[a-zA-Z]*K$/, /^--kill/] },
  { pattern: 'lsof' },
  { pattern: 'grep' },
  // 额外收紧:rg --pre 会对每个文件执行外部命令(--pretty 不受影响)。
  { pattern: 'rg', forbiddenTokens: [/^--pre(=|$)/] },
  // —— 带禁用参数的单 token 条目 ——
  // tail 禁 follow;规格为 /^-[a-zA-Z]*f/,额外补上等价的 -F(--follow=name --retry)。
  { pattern: 'tail', forbiddenTokens: [/^-[a-zA-Z]*[fF]/, FOLLOW_LONG_FLAG] },
  // find 禁删除/执行/写文件谓词;-fprint0 为规格正则的补漏(同为写文件谓词)。
  { pattern: 'find', forbiddenTokens: [/^-(delete|exec|execdir|ok|okdir|fls|fprint0?|fprintf)$/] },
  // journalctl 禁清理与 follow;--rotate/--flush 等为额外收紧(写日志目录,root 语义)。
  {
    pattern: 'journalctl',
    forbiddenTokens: [/^--vacuum/, FOLLOW_SHORT_FLAG, FOLLOW_LONG_FLAG, /^--(rotate|flush|relinquish-var|setup-keys)$/]
  },
  // —— 两 token 条目 ——
  { pattern: 'systemctl status' },
  { pattern: 'systemctl is-active' },
  { pattern: 'systemctl list-units' },
  { pattern: 'systemctl list-timers' },
  { pattern: 'docker ps' },
  { pattern: 'docker images' },
  { pattern: 'docker inspect' },
  { pattern: 'docker logs', forbiddenTokens: [FOLLOW_SHORT_FLAG, FOLLOW_LONG_FLAG] },
  { pattern: 'kubectl get' },
  { pattern: 'kubectl describe' },
  { pattern: 'kubectl top' },
  { pattern: 'kubectl logs', forbiddenTokens: [FOLLOW_SHORT_FLAG, FOLLOW_LONG_FLAG] },
  { pattern: 'git status' },
  // 额外收紧:git log/diff/show 的 --output 会写文件。
  { pattern: 'git log', forbiddenTokens: [GIT_OUTPUT_FLAG] },
  { pattern: 'git diff', forbiddenTokens: [GIT_OUTPUT_FLAG] },
  { pattern: 'git show', forbiddenTokens: [GIT_OUTPUT_FLAG] },
  // git branch:规格禁删除/改名/复制;额外收紧 upstream 设置与描述编辑(写操作/开编辑器),
  // 并通过空 nextTokenAllowlist 拒绝非选项参数——裸 `git branch <名>` 是建分支,属写操作。
  {
    pattern: 'git branch',
    forbiddenTokens: [
      /^-(d|D|m|M|c|C)$/,
      /^--(delete|move|copy)/,
      /^--(set-upstream-to|unset-upstream|edit-description)(=|$)/
    ],
    nextTokenAllowlist: []
  },
  { pattern: 'ip addr', nextTokenAllowlist: ['show', 'list', 'ls', 'get'] },
  { pattern: 'ip route', nextTokenAllowlist: ['show', 'list', 'ls', 'get'] },
  { pattern: 'ip link', nextTokenAllowlist: ['show', 'list', 'ls', 'get'] }
]

/** 建议 pattern 取两 token 的子命令型工具(其余取首 token)。 */
const SUBCOMMAND_TOOLS = new Set([
  'git', 'docker', 'kubectl', 'systemctl', 'ip', 'journalctl',
  'npm', 'pnpm', 'yarn', 'cargo', 'brew', 'apt', 'apt-get', 'dnf', 'yum'
])

/** 前缀环境变量赋值(含 VAR+=v 形式)。 */
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*\+?=/
/**
 * 额外收紧:能改变「后续命令实际执行什么代码」的环境变量前缀
 * (PATH 换程序、LD_PRELOAD/DYLD_* 注入动态库、BASH_ENV/ENV/PS4 注入脚本等),
 * 即使赋值本身被剥离,也要否决整段。
 */
const DANGEROUS_ENV_RE = /^(PATH|IFS|ENV|BASH_ENV|SHELLOPTS|PS4|LD_[A-Z_]+|DYLD_[A-Z_]+)\+?=/
/** timeout 的 DURATION 位置参数(数字,可带 s/m/h/d 单位)。 */
const TIMEOUT_DURATION_RE = /^\d+(\.\d+)?[smhd]?$/

/** Exposes the same quote-aware tokenization to privacy checks. */
export function commandTokensForPrivacy(command: string) {
  return scanCommand(command).segments.flatMap((segment) => stripWrappers(segment).tokens)
}

/** An exact text grant cannot freeze substitutions, scripts or runtime input. */
export function canGrantExactCommand(command: string) {
  const scan = scanCommand(command)
  if (!scan.segments.length || scan.budgetExceeded || scan.unclosedQuote || scan.heredoc || scan.trailingOperator || scan.redirectVeto || scan.substitutionVeto || scan.ambiguousSyntaxVeto) return false
  if (analyzeScriptRisks(command).length) return false
  return scan.segments.every(segment => {
    const { tokens, dangerousEnv } = stripWrappers(segment)
    return !dangerousEnv && !tokens.includes('sudo')
  })
}

/**
 * 剥离前缀环境变量赋值与 timeout/command 透明包装,返回内层命令 token。
 * 命中危险环境变量(PATH/LD_PRELOAD 等,见 DANGEROUS_ENV_RE)时单独上报。
 */
function stripWrappers(tokens: string[]): { tokens: string[]; dangerousEnv: boolean } {
  const rest = [...tokens]
  let dangerousEnv = false
  while (rest.length && ENV_ASSIGNMENT_RE.test(rest[0])) {
    if (DANGEROUS_ENV_RE.test(rest[0])) dangerousEnv = true
    rest.shift()
  }
  for (;;) {
    const head = rest[0]
    if (head === 'timeout') {
      rest.shift()
      let sawDuration = false
      while (rest.length) {
        const option = rest[0]
        // -k/-s(及分写的长选项)带独立参数,一并跳过;=连写与其余选项跳过自身。
        if (option === '-k' || option === '-s' || option === '--kill-after' || option === '--signal') {
          rest.splice(0, 2)
          continue
        }
        if (option.startsWith('-')) {
          rest.shift()
          continue
        }
        if (!sawDuration && TIMEOUT_DURATION_RE.test(option)) {
          sawDuration = true
          rest.shift()
          continue
        }
        break
      }
      continue
    }
    if (head === 'command') {
      rest.shift()
      while (rest.length && (rest[0] === '-p' || rest[0] === '-v' || rest[0] === '-V')) rest.shift()
      continue
    }
    break
  }
  return { tokens: rest, dangerousEnv }
}

/** 用户 pattern:全部 token 与段前缀 token 完全一致即命中(token 级比较,非字符串前缀)。 */
function matchUserPattern(tokens: string[], userPatterns: string[]): string | null {
  for (const pattern of userPatterns) {
    const patternTokens = pattern.split(/\s+/).filter(Boolean)
    if (!patternTokens.length || patternTokens.length > tokens.length) continue
    if (patternTokens.every((part, idx) => part === tokens[idx])) return pattern
  }
  return null
}

/** 内置条目:前缀命中后执行条目级规则;规则否决返回 null(条目 pattern 互不重叠)。 */
function matchBuiltinEntry(tokens: string[]): string | null {
  for (const entry of BUILTIN_READONLY_COMMANDS) {
    const entryTokens = entry.pattern.split(' ')
    if (entryTokens.length > tokens.length) continue
    if (!entryTokens.every((part, idx) => part === tokens[idx])) continue
    const rest = tokens.slice(entryTokens.length)
    if (entry.forbiddenTokens && rest.some((token) => entry.forbiddenTokens!.some((re) => re.test(token)))) {
      return null
    }
    if (entry.nextTokenAllowlist) {
      const nextToken = rest.find((token) => !token.startsWith('-'))
      if (nextToken !== undefined && !entry.nextTokenAllowlist.includes(nextToken)) return null
    }
    return entry.pattern
  }
  return null
}

/** 第一段(剥离包装后)的建议 pattern:子命令工具取两 token,其余取首 token。 */
function suggestFromSegments(segments: string[][]): string {
  const first = segments[0]
  if (!first) return ''
  return suggestFromSegment(first)
}

/** 单段的建议 pattern:子命令型工具取两 token,其余取首 token。 */
function suggestFromSegment(segment: string[]): string {
  const { tokens } = stripWrappers(segment)
  if (!tokens.length) return ''
  if (SUBCOMMAND_TOOLS.has(tokens[0]) && tokens.length >= 2) return `${tokens[0]} ${tokens[1]}`
  return tokens[0]
}

/**
 * 自动执行判定:每段独立通过(允许来源命中且未触发任何一票否决)才 eligible。
 * matched 返回第一段命中的来源 pattern。
 *
 * suggestedPatterns 是「总是允许」的依据:列出让该命令可自动执行**仍需补充**的
 * 全部 pattern(已被现有来源覆盖的段不再列出)。空数组表示该命令无法通过允许
 * 列表放行(命中一票否决),此时不应展示「总是允许」——否则用户加了 pattern
 * 却依旧要人工审批。
 */
export function classifyForAutoExec(
  command: string,
  sources: { userPatterns: string[]; includeBuiltin: boolean }
): AgentAutoExecClassification {
  const scan = scanCommand(command)
  const rejected: AgentAutoExecClassification = { eligible: false, suggestedPatterns: [] }

  // A saved prefix never overrides risk findings, including unsupported syntax.
  if (analyzeScriptRisks(command).length) return rejected
  // 不可靠结构与全局一票否决:未闭合引号 / heredoc / 写重定向 / 命令替换类。
  if (scan.unclosedQuote || scan.heredoc || scan.trailingOperator) return rejected
  if (scan.redirectVeto || scan.substitutionVeto || scan.ambiguousSyntaxVeto) return rejected
  if (!scan.segments.length) return rejected

  const userPatterns = sources.userPatterns.map((pattern) => pattern.trim()).filter(Boolean)
  let firstMatched: string | undefined
  // 未被现有来源覆盖的段:这些才是「总是允许」需要补充的 pattern
  const missing: string[] = []

  for (const segment of scan.segments) {
    const { tokens, dangerousEnv } = stripWrappers(segment)
    if (dangerousEnv) return rejected
    // 纯赋值段(无命令)或剥离后为空:无从匹配,不放行。
    if (!tokens.length) return rejected
    // sudo 一票否决,允许来源无效。
    if (tokens[0] === 'sudo') return rejected
    // 用户 pattern 优先:显式授权,不附加条目级规则。
    const matched = matchUserPattern(tokens, userPatterns)
      ?? (sources.includeBuiltin ? matchBuiltinEntry(tokens) : null)
    if (matched) {
      if (firstMatched === undefined) firstMatched = matched
      continue
    }
    const suggestion = suggestFromSegment(segment)
    // 段无法归纳出 pattern 时,整条命令就没法靠允许列表放行。
    if (!suggestion) return rejected
    if (!missing.includes(suggestion)) missing.push(suggestion)
  }

  if (missing.length) return { eligible: false, suggestedPatterns: missing }
  return { eligible: true, matched: firstMatched, suggestedPatterns: [] }
}

/** 「总是允许」按钮的建议 pattern;多段命令简化为始终取第一段。 */
export function suggestPatternForCommand(command: string): string {
  return suggestFromSegments(scanCommand(command).segments)
}

/**
 * 命令能否安全追加 `; printf …`(哨兵包装的前提,文档 10.3)。
 * 与自动执行判定无关:这里只关心追加后语法是否仍然成立,不涉及风险。
 */
export function isSuffixSafeForSentinel(command: string): { ok: boolean; reason?: string } {
  const value = command.trim()
  if (!value) return { ok: false, reason: '命令为空' }
  const scan = scanCommand(value)
  if (scan.budgetExceeded) return { ok: false, reason: '命令超过分析长度上限，无法确认可安全追加哨兵标记' }
  if (scan.unclosedQuote) return { ok: false, reason: '命令含未闭合的引号' }
  if (scan.heredoc) return { ok: false, reason: '命令含 heredoc(<<),无法在同一行追加哨兵标记' }
  if (scan.trailingOperator) {
    return { ok: false, reason: '命令以 &、|、&& 或续行反斜杠结尾,无法在其后追加哨兵标记' }
  }
  return { ok: true }
}

/** 手动添加允许列表 pattern 时禁止出现的字符(重定向、管道、命令替换、引号、换行)。 */
const PATTERN_BANNED_CHARS = '|;&<>$\'"' + BACKTICK + '\n\r'

/** 设置中心手动添加 pattern 的同源校验:拒绝一切能改变判定语义的结构。 */
export function validateAllowlistPattern(pattern: string): { ok: boolean; reason?: string } {
  const trimmed = pattern.trim()
  if (!trimmed) return { ok: false, reason: '模式不能为空' }
  for (const ch of trimmed) {
    if (!PATTERN_BANNED_CHARS.includes(ch)) continue
    if (ch === '\n' || ch === '\r') return { ok: false, reason: '模式不能包含换行' }
    return { ok: false, reason: `模式不能包含字符「${ch}」:管道、重定向、命令替换与引号结构不允许进入允许列表` }
  }
  const tokens = trimmed.split(/\s+/)
  if (tokens[0] === 'sudo') return { ok: false, reason: '不允许添加以 sudo 开头的模式,sudo 命令始终需要人工审批' }
  if (tokens.length > 4) return { ok: false, reason: '模式最多 4 个 token,请缩短为命令前缀' }
  return { ok: true }
}
