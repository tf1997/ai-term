export type ScriptRiskKind = 'delete' | 'edit' | 'reboot' | 'upgrade' | 'service' | 'network' | 'permission' | 'disk'
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

const SCRIPT_RISK_RULES: ScriptRiskRule[] = [
  { kind: 'delete', label: '删除操作', severity: 'high', message: '可能删除文件、容器或集群资源，部分操作不可恢复。', pattern: /\brm\s+(-[^\s]*[rf][^\s]*|-r|-f)\b/i },
  { kind: 'delete', label: '删除操作', severity: 'high', message: 'sudo 删除会绕过普通权限保护，请确认目标路径。', pattern: /\bsudo\s+rm\b/i },
  { kind: 'delete', label: '批量删除', severity: 'high', message: 'find -delete 会批量删除匹配文件，请确认搜索范围。', pattern: /\bfind\b.*\s-delete\b/i },
  { kind: 'delete', label: '资源删除', severity: 'high', message: '会删除容器、镜像或 Kubernetes 资源。', pattern: /\b(?:kubectl\s+delete|docker\s+(?:rm|rmi)|docker\s+system\s+prune\b.*(?:\s-a\b|--all\b))/i },
  { kind: 'edit', label: '编辑覆盖', severity: 'medium', message: '会直接编辑或覆盖文件，建议先确认备份。', pattern: /(?:^|[\s;&|])(?:sudo\s+)?(?:sed\s+-i|perl\s+-pi)\b/i },
  { kind: 'edit', label: '系统文件写入', severity: 'high', message: '会写入系统目录，可能影响服务或启动配置。', pattern: /(?:^|[\s;&|])(?:sudo\s+)?(?:tee|mv|cp)\s+.*\s\/(?:etc|boot|usr|var|opt)\b/i },
  { kind: 'edit', label: '系统文件覆盖', severity: 'high', message: '重定向写入系统目录可能覆盖关键配置。', pattern: /(?:^|[^<])>{1,2}\s*\/(?:etc|boot|usr|var|opt)\b/i },
  { kind: 'edit', label: '手动编辑', severity: 'medium', message: '会打开编辑器修改文件，请确认目标文件。', pattern: /(?:^|[\s;&|])(?:sudo\s+)?(?:vi|vim|nano|emacs)\s+\//i },
  { kind: 'reboot', label: '重启关机', severity: 'high', message: '会中断当前会话或重启/关闭机器。', pattern: /\b(?:shutdown|reboot|poweroff|halt)\b/i },
  { kind: 'upgrade', label: '系统升级', severity: 'medium', message: '会升级软件包版本，可能改变运行环境。', pattern: /\b(?:apt(?:-get)?\s+(?:dist-)?upgrade|yum\s+update|dnf\s+(?:update|upgrade)|pacman\s+-Syu|brew\s+upgrade)\b/i },
  { kind: 'service', label: '服务变更', severity: 'medium', message: '会重启、停止或重载服务，可能造成短暂中断。', pattern: /\b(?:systemctl\s+(?:restart|stop|reload)|service\s+\S+\s+(?:restart|stop|reload))\b/i },
  { kind: 'network', label: '网络防火墙', severity: 'high', message: '会修改防火墙或网络规则，可能导致连接中断。', pattern: /\b(?:iptables\s+-f|nft\s+flush|ufw\s+disable|firewall-cmd\b.*--reload)\b/i },
  { kind: 'permission', label: '权限变更', severity: 'medium', message: '会放宽或改写权限，可能扩大访问风险。', pattern: /\b(?:chmod\s+(?:-R\s+)?777|chown\s+(?:-R\s+)?\S+)\b/i },
  { kind: 'disk', label: '磁盘分区', severity: 'high', message: '会写入磁盘、格式化或修改分区，风险极高。', pattern: /\b(?:dd\s+.*\bof=\/dev\/|mkfs(?:\.|\s|$)|fdisk\b|parted\b|wipefs\b)\b/i }
]

export function analyzeScriptRisks(content: string): ScriptRiskMatch[] {
  return content.split(/\r?\n/).flatMap((line, index) => {
    const text = line.trim()
    if (!text || text.startsWith('#')) return []
    return SCRIPT_RISK_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => ({
      kind: rule.kind,
      label: rule.label,
      severity: rule.severity,
      line: index + 1,
      text: line,
      message: rule.message
    }))
  })
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
