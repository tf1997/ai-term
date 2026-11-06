import type { CommandIntent } from './commandPolicy'
import type { ScriptRiskMatch } from './scriptRisk'

/** Keep unknown analysis visible; an empty list must never imply approval. */
export function commandPolicyRisks(intent: Pick<CommandIntent, 'source' | 'analysis'>): ScriptRiskMatch[] {
  const lines = intent.source.split('\n')
  return [
    ...intent.analysis.risks.map(risk => ({
      kind: risk.kind, severity: risk.severity, label: '命令策略', message: risk.message,
      line: risk.range.startLine, text: lines[risk.range.startLine - 1] ?? intent.source
    })),
    ...intent.analysis.unknownReasons.map(issue => ({
      kind: 'execution' as const, severity: 'high' as const, label: '需要逐次确认', message: issue.message,
      line: issue.range.startLine, text: lines[issue.range.startLine - 1] ?? intent.source
    }))
  ]
}
