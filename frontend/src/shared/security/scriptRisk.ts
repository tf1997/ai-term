export type ScriptRiskKind = 'delete' | 'edit' | 'reboot' | 'upgrade' | 'service' | 'network' | 'permission' | 'disk' | 'execution'
export type ScriptRiskSeverity = 'high' | 'medium'
export type ScriptRiskLevel = 'safe' | 'medium' | 'high'

export interface ScriptRiskMatch {
  kind: ScriptRiskKind
  label: string
  severity: ScriptRiskSeverity
  line: number
  text: string
  message: string
}

export interface ScriptRiskPreviewLine {
  number: number
  text: string
  risks: ScriptRiskMatch[]
  riskClass: string
}

interface ScriptRiskRule {
  kind: ScriptRiskKind
  label: string
  severity: ScriptRiskSeverity
  message: string
  pattern: RegExp
}

const WINDOWS_SYSTEM_PATH = String.raw`(?:[a-z]:\\(?:windows|program files|program files \(x86\)|programdata)|%windir%|%systemroot%|%programfiles%|%programdata%)`

const SCRIPT_RISK_RULES: ScriptRiskRule[] = [
  { kind: 'delete', label: '删除操作', severity: 'high', message: '可能删除文件、容器或集群资源，部分操作不可恢复。', pattern: /\brm\s+(-[^\s]*[rf][^\s]*|-r|-f)\b/i },
  { kind: 'delete', label: '删除操作', severity: 'high', message: 'sudo 删除会绕过普通权限保护，请确认目标路径。', pattern: /\bsudo\s+rm\b/i },
  { kind: 'delete', label: '批量删除', severity: 'high', message: 'find -delete 会批量删除匹配文件，请确认搜索范围。', pattern: /\bfind\b.*\s-delete\b/i },
  { kind: 'delete', label: '资源删除', severity: 'high', message: '会删除容器、镜像或 Kubernetes 资源。', pattern: /\b(?:kubectl\s+delete|docker\s+(?:rm|rmi)|docker\s+system\s+prune\b.*(?:\s-a\b|--all\b))/i },
  { kind: 'delete', label: 'Windows 删除', severity: 'high', message: 'Windows del/erase/rd/rmdir 可能递归或强制删除文件，请确认路径和通配符。', pattern: /(?:^|[&|()\s])(?:del|erase|rd|rmdir)\b(?=.*(?:\/s|\/f|\/q|-[rf]|\*|\?|[a-z]:\\|%\w+%|\\\\))/i },
  { kind: 'delete', label: 'PowerShell 删除', severity: 'high', message: 'Remove-Item 递归或强制删除可能不可恢复，请确认目标路径。', pattern: /\b(?:Remove-Item|rm|del|erase|rd|rmdir)\b(?=.*(?:-Recurse|-Force|\*|\?|[a-z]:\\|%\w+%))/i },

  { kind: 'edit', label: '编辑覆盖', severity: 'medium', message: '会直接编辑或覆盖文件，建议先确认备份。', pattern: /(?:^|[\s;&|])(?:sudo\s+)?(?:sed\s+-i|perl\s+-pi)\b/i },
  { kind: 'edit', label: '系统文件写入', severity: 'high', message: '会写入系统目录，可能影响服务或启动配置。', pattern: /(?:^|[\s;&|])(?:sudo\s+)?(?:tee|mv|cp)\s+.*\s\/(?:etc|boot|usr|var|opt)\b/i },
  { kind: 'edit', label: '系统文件覆盖', severity: 'high', message: '重定向写入系统目录可能覆盖关键配置。', pattern: /(?:^|[^<])>{1,2}\s*\/(?:etc|boot|usr|var|opt)\b/i },
  { kind: 'edit', label: '手动编辑', severity: 'medium', message: '会打开编辑器修改文件，请确认目标文件。', pattern: /(?:^|[\s;&|])(?:sudo\s+)?(?:vi|vim|nano|emacs)\s+\//i },
  { kind: 'edit', label: '注册表变更', severity: 'high', message: '会修改 Windows 注册表，可能影响系统、服务或启动项。', pattern: /(?:^|[&|()\s])reg(?:\.exe)?\s+(?:add|delete|import|restore|load|unload)\b/i },
  { kind: 'edit', label: '系统文件写入', severity: 'high', message: '会写入 Windows 系统目录，可能覆盖关键文件。', pattern: new RegExp(String.raw`(?:^|[&|()\s])(?:copy|xcopy|robocopy|move|ren|rename)\b.*${WINDOWS_SYSTEM_PATH}`, 'i') },
  { kind: 'edit', label: 'PowerShell 写入', severity: 'high', message: '会通过 PowerShell 写入或覆盖系统目录文件，请确认目标路径。', pattern: new RegExp(String.raw`\b(?:Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|Rename-Item)\b.*${WINDOWS_SYSTEM_PATH}`, 'i') },
  { kind: 'edit', label: '系统变量变更', severity: 'medium', message: '会修改环境变量，可能影响后续终端和系统行为。', pattern: /(?:^|[&|()\s])setx\b/i },

  { kind: 'reboot', label: '重启关机', severity: 'high', message: '会中断当前会话或重启/关闭机器。', pattern: /\b(?:shutdown|reboot|poweroff|halt)\b/i },
  { kind: 'reboot', label: 'Windows 重启关机', severity: 'high', message: '会重启、关机或注销 Windows，会中断当前会话。', pattern: /(?:^|[&|()\s])shutdown(?:\.exe)?\b.*(?:\/r|\/s|\/l|\/g|\/p|\/h)/i },
  { kind: 'reboot', label: 'PowerShell 重启关机', severity: 'high', message: '会通过 PowerShell 重启或关闭电脑。', pattern: /\b(?:Restart-Computer|Stop-Computer)\b/i },

  { kind: 'upgrade', label: '系统升级', severity: 'medium', message: '会升级软件包版本，可能改变运行环境。', pattern: /\b(?:apt(?:-get)?\s+(?:dist-)?upgrade|yum\s+update|dnf\s+(?:update|upgrade)|pacman\s+-Syu|brew\s+upgrade)\b/i },
  { kind: 'upgrade', label: 'Windows 软件升级', severity: 'medium', message: '会安装或升级 Windows 软件包，可能改变运行环境。', pattern: /(?:^|[&|()\s])(?:winget\s+(?:upgrade|install)|choco\s+(?:upgrade|install)|scoop\s+(?:update|install)|wusa(?:\.exe)?\b|msiexec(?:\.exe)?\b)/i },
  { kind: 'upgrade', label: 'PowerShell 模块变更', severity: 'medium', message: '会安装或升级 PowerShell 模块/包提供器。', pattern: /\b(?:Install-Module|Update-Module|Install-PackageProvider|Install-Package|Update-Package)\b/i },

  { kind: 'service', label: '服务变更', severity: 'medium', message: '会重启、停止或重载服务，可能造成短暂中断。', pattern: /\b(?:systemctl\s+(?:restart|stop|reload)|service\s+\S+\s+(?:restart|stop|reload))\b/i },
  { kind: 'service', label: 'Windows 服务变更', severity: 'medium', message: '会停止、删除或修改 Windows 服务，可能造成业务中断。', pattern: /(?:^|[&|()\s])(?:sc(?:\.exe)?\s+(?:stop|delete|config|failure)|net\s+stop|taskkill(?:\.exe)?\b.*(?:\/f|-f))/i },
  { kind: 'service', label: 'PowerShell 服务变更', severity: 'medium', message: '会停止、重启服务或强制结束进程。', pattern: /\b(?:Stop-Service|Restart-Service|Set-Service|Stop-Process)\b(?=.*(?:-Force|-Name|-Id|\s))/i },

  { kind: 'network', label: '网络防火墙', severity: 'high', message: '会修改防火墙或网络规则，可能导致连接中断。', pattern: /\b(?:iptables\s+-f|nft\s+flush|ufw\s+disable|firewall-cmd\b.*--reload)\b/i },
  { kind: 'network', label: 'Windows 网络配置', severity: 'high', message: '会修改 Windows 防火墙、网络栈或连接状态，可能导致远程连接中断。', pattern: /(?:^|[&|()\s])(?:netsh\s+(?:advfirewall|firewall|interface|winsock)|ipconfig\s+\/(?:release|flushdns)|route\s+(?:delete|add)|New-NetFirewallRule|Remove-NetFirewallRule|Set-NetFirewallProfile)\b/i },
  { kind: 'network', label: 'Linux 网络配置', severity: 'high', message: '会修改 Linux 网络地址、路由、接口或防火墙规则，可能导致远程连接中断。', pattern: /(?:^|[&|()\s])(?:ip\s+(?:addr|address|route|link)\s+(?:add|del|delete|set|replace|change)|iptables\b.*\s(?:-A|-I|-D|-F)|nft\s+(?:add|delete|flush)|ufw\s+(?:allow|deny|delete|enable|disable)|firewall-cmd\b.*(?:--add|--remove|--zone))/i },

  { kind: 'permission', label: '权限变更', severity: 'medium', message: '会放宽或改写权限，可能扩大访问风险。', pattern: /\b(?:chmod\s+(?:-R\s+)?777|chown\s+(?:-R\s+)?\S+)\b/i },
  { kind: 'permission', label: 'Windows 权限变更', severity: 'medium', message: '会更改 Windows ACL、所有者或执行策略。', pattern: /(?:^|[&|()\s])(?:icacls|takeown)\b|\b(?:Set-Acl|Set-ExecutionPolicy)\b/i },

  { kind: 'execution', label: '动态执行', severity: 'high', message: '会通过解释器、脚本或动态命令执行任意代码，无法仅凭外层命令判断影响。', pattern: /(?:^|[&|()\s])(?:eval|source|exec|xargs)\b|(?:^|[&|()\s])(?:sh|bash|zsh|dash|ksh|fish|python(?:3)?|perl|ruby|node|php|pwsh|powershell|cmd)(?:\.exe)?\s+(?:-c|--command|\/c|\/r|\/command)\b/i },

  { kind: 'edit', label: '文件写入', severity: 'medium', message: '会通过输出重定向写入文件，请确认目标路径和覆盖行为。', pattern: /(?:^|[\s;|&])(?:\d+)?>{1,2}\s*(?!\/dev\/null\b|&\d\b)\S+/i },

  { kind: 'disk', label: '磁盘分区', severity: 'high', message: '会写入磁盘、格式化或修改分区，风险极高。', pattern: /\b(?:dd\s+.*\bof=\/dev\/|mkfs(?:\.|\s|$)|fdisk\b|parted\b|wipefs\b)\b/i },
  { kind: 'disk', label: 'Windows 磁盘操作', severity: 'high', message: '会格式化、清理、加密或修改启动/磁盘配置，风险极高。', pattern: /(?:^|[&|()\s])(?:format(?:\.com)?\b|diskpart\b|bcdedit\b|bootrec\b|manage-bde\b|cipher\s+\/w)|\b(?:Clear-Disk|Initialize-Disk|Format-Volume|Remove-Partition|Set-Partition)\b/i }
]

export function analyzeScriptRisks(content: string): ScriptRiskMatch[] {
  return content.split(/\r?\n/).flatMap((line, index) => {
    const normalized = normalizeRiskScanLine(line)
    if (!normalized || isCommentLine(normalized)) return []
    const segments = splitShellSegments(normalized)
    const matches = new Map<ScriptRiskKind, ScriptRiskMatch>()
    segments.forEach((segment) => {
      const head = riskCommandHead(segment)
      const preservePaths = PATH_WRITING_COMMANDS.has(head)
      const text = maskShellLiterals(segment, preservePaths)
      SCRIPT_RISK_RULES.filter((rule) => rule.pattern.test(text)).forEach((rule) => {
        if (!matches.has(rule.kind)) matches.set(rule.kind, {
          kind: rule.kind,
          label: rule.label,
          severity: rule.severity,
          line: index + 1,
          text: line,
          message: rule.message
        })
      })
    })
    return [...matches.values()]
  })
}

const PATH_WRITING_COMMANDS = new Set([
  'cp', 'mv', 'tee', 'sed', 'perl', 'rm', 'chmod', 'chown', 'dd', 'install',
  'set-content', 'add-content', 'out-file', 'copy-item', 'move-item', 'rename-item'
])

const RISK_WRAPPER_COMMANDS = new Set(['sudo', 'doas', 'command', 'nohup', 'nice', 'timeout'])

function splitShellSegments(line: string) {
  const segments: string[] = []
  let start = 0
  let quote: 'single' | 'double' | 'ansi' | null = null
  let escaped = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    const previous = line[index - 1]
    if (escaped) { escaped = false; continue }
    if (quote === 'single') {
      if (character === "'") quote = null
      continue
    }
    if (quote === 'ansi') {
      if (character === '\\') escaped = true
      else if (character === "'") quote = null
      continue
    }
    if (quote === 'double') {
      if (character === '\\') escaped = true
      else if (character === '"') quote = null
      continue
    }
    if (character === "'" || character === '"') { quote = character === "'" ? 'single' : 'double'; continue }
    if (character === '$' && line[index + 1] === "'") { quote = 'ansi'; index += 1; continue }
    if (character === '\\') { escaped = true; continue }
    if (character === '#' && (index === 0 || /[\s;]/.test(previous ?? ''))) break
    if (character === ';' || character === '|' || character === '&') {
      const segment = line.slice(start, index).trim()
      if (segment) segments.push(segment)
      if (line[index + 1] === character || (character === '|' && line[index + 1] === '&')) index += 1
      start = index + 1
    }
  }
  const last = line.slice(start).trim()
  if (last) segments.push(last)
  return segments
}

function riskCommandHead(segment: string) {
  const tokens = shellWords(segment)
  let index = 0
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(tokens[index])) index += 1
  while (index < tokens.length && RISK_WRAPPER_COMMANDS.has(tokens[index].toLowerCase())) {
    const wrapper = tokens[index].toLowerCase()
    index += 1
    if (wrapper === 'timeout') {
      while (index < tokens.length && tokens[index].startsWith('-')) index += 1
      if (/^\d+(?:\.\d+)?[smhd]?$/.test(tokens[index] ?? '')) index += 1
    }
  }
  return (tokens[index] ?? '').replace(/^.*[\\/]/, '').replace(/\.(?:exe|cmd|bat|ps1)$/i, '').toLowerCase()
}

function shellWords(value: string) {
  const words: string[] = []
  let word = ''
  let quote: 'single' | 'double' | 'ansi' | null = null
  let escaped = false
  const finish = () => { if (word) words.push(word); word = '' }
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (escaped) { word += character; escaped = false; continue }
    if (quote === 'single') { if (character === "'") quote = null; else word += character; continue }
    if (quote === 'ansi') { if (character === '\\') escaped = true; else if (character === "'") quote = null; else word += character; continue }
    if (quote === 'double') { if (character === '\\') escaped = true; else if (character === '"') quote = null; else word += character; continue }
    if (character === "'" || character === '"') { quote = character === "'" ? 'single' : 'double'; continue }
    if (character === '$' && value[index + 1] === "'") { quote = 'ansi'; index += 1; continue }
    if (/\s/.test(character)) finish()
    else word += character
  }
  finish()
  return words
}

/**
 * Remove quoted literals and shell comments before applying risk rules. A
 * regex such as `rm -rf` must not flag `echo "rm -rf ..."`, while the actual
 * command `rm -rf "/tmp"` still retains its unquoted command and flags.
 * Escaped characters remain visible because they can change the command's
 * actual token (for example `\rm`).
 */
function maskShellLiterals(line: string, preservePaths = false) {
  let result = ''
  let quote: 'single' | 'double' | 'ansi' | null = null
  let escaped = false
  let quotedValue = ''
  let quoteStart = 0
  const appendQuoted = () => {
    const value = preservePaths && /^(?:\/?(?:etc|boot|usr|var|opt|tmp|home|root)(?:\/|$)|[A-Za-z]:[\\/]|[~.][\\/])/.test(quotedValue)
      ? quotedValue
      : ' '.repeat(Math.max(1, quotedValue.length))
    result += value
    quotedValue = ''
  }

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    const previous = line[index - 1]
    if (escaped) {
      if (quote !== null) quotedValue += character
      else result += character
      escaped = false
      continue
    }
    if (quote === 'single') {
      if (character === "'") { quote = null; appendQuoted() }
      else quotedValue += character
      continue
    }
    if (quote === 'ansi') {
      if (character === '\\') escaped = true
      else if (character === "'") quote = null
      if (character === "'") { quote = null; appendQuoted() }
      else quotedValue += character
      continue
    }
    if (quote === 'double') {
      if (character === '\\') escaped = true
      else if (character === '"') quote = null
      if (character === '"') { quote = null; appendQuoted() }
      else quotedValue += character
      continue
    }
    if (character === "'" || character === '"') {
      quote = character === "'" ? 'single' : 'double'
      quoteStart = index
      quotedValue = ''
      result += ' '
      continue
    }
    if (character === '$' && line[index + 1] === "'") {
      quote = 'ansi'
      quoteStart = index
      quotedValue = ''
      result += '  '
      index += 1
      continue
    }
    if (character === '#' && (index === 0 || /[\s;|&()]/.test(previous ?? ''))) break
    result += character
  }

  if (quote !== null) result += ' '.repeat(Math.max(1, line.length - quoteStart))

  return result
}

function normalizeRiskScanLine(line: string) {
  return line
    .trim()
    .replace(/^@+/, '')
    .replace(/^\$\s+/, '')
    .replace(/^PS\s+[A-Z]:\\[^>]*>\s*/i, '')
    .replace(/^[A-Z]:\\[^>]*>\s*/i, '')
}

function isCommentLine(text: string) {
  return text.startsWith('#') || /^rem\b/i.test(text) || /^::/.test(text)
}

export function summarizeScriptRisks(risks: ScriptRiskMatch[]) {
  const summary = new Map<ScriptRiskKind, ScriptRiskMatch>()
  risks.forEach((risk) => {
    const current = summary.get(risk.kind)
    if (!current || (current.severity === 'medium' && risk.severity === 'high')) {
      summary.set(risk.kind, risk)
    }
  })
  return [...summary.values()]
}

export function buildScriptRiskPreviewLines(content: string, risks: ScriptRiskMatch[]): ScriptRiskPreviewLine[] {
  const risksByLine = new Map<number, ScriptRiskMatch[]>()
  risks.forEach((risk) => {
    risksByLine.set(risk.line, [...(risksByLine.get(risk.line) ?? []), risk])
  })
  return content.split(/\r?\n/).map((text, index) => {
    const lineRisks = risksByLine.get(index + 1) ?? []
    return {
      number: index + 1,
      text,
      risks: lineRisks,
      riskClass: riskClassForLine(lineRisks)
    }
  })
}

export function riskClassForLine(risks: ScriptRiskMatch[]) {
  if (!risks.length) return ''
  const mainRisk = risks.find((risk) => risk.severity === 'high') ?? risks[0]
  return `risk-${mainRisk.kind}`
}

export function riskLabelsForLine(risks: ScriptRiskMatch[]) {
  return risks.map((risk) => risk.label).join(' / ')
}

export function scriptRiskLevelForRisks(risks: ScriptRiskMatch[]): ScriptRiskLevel {
  if (risks.some((risk) => risk.severity === 'high')) return 'high'
  if (risks.length > 0) return 'medium'
  return 'safe'
}

export function scriptRiskStatusForContent(content: string) {
  const risks = analyzeScriptRisks(content)
  const level = scriptRiskLevelForRisks(risks)
  const label = level === 'high' ? '高风险' : level === 'medium' ? '中风险' : '未发现风险'
  const message = level === 'safe' ? '未检测到危险命令' : summarizeScriptRisks(risks).map((risk) => risk.label).join(' / ')
  return { level, label, message, risks }
}
