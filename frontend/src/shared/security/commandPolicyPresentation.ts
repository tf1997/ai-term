import type { CommandIntent, ExecutionContext } from './commandPolicy'
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

export const POLICY_RISK_KIND_LABELS: Record<ScriptRiskMatch['kind'], string> = {
  delete: '删除', edit: '写入修改', reboot: '重启关机', upgrade: '软件包变更', service: '服务变更',
  network: '网络变更', permission: '权限身份', disk: '磁盘操作', execution: '动态执行'
}

/**
 * Display-only intent for review surfaces that have no backend record (legacy
 * dispatch, independent SSH tasks). It carries no execution authority.
 */
export function reviewIntentFromRisks(id: string, source: string, risks: ScriptRiskMatch[], context: Partial<ExecutionContext> = {}): CommandIntent {
  const length = new TextEncoder().encode(source).length
  return {
    reference: {
      id, operation: 'command', policyVersion: '',
      target: { sessionId: '', sessionInstance: '', profileId: '', routeVersion: 0, contextVersion: 0,
        context: { shell: 'unknown', workingDirectory: null, user: null, environmentScope: null, ...context } }
    },
    source, operation: 'command', expiresInMs: 0, terminalInput: '',
    capture: { kind: 'none', nonce: '', internal: false },
    analysis: {
      analysisStatus: 'complete', decision: 'ask', unknownReasons: [], policyVersion: '',
      highestSeverity: risks.some(risk => risk.severity === 'high') ? 'high' : risks.length ? 'medium' : null,
      risks: risks.map(risk => ({
        ruleId: risk.label, kind: risk.kind, severity: risk.severity, message: `${risk.label}：${risk.message}`, targets: [],
        range: { startByte: 0, endByte: length, startLine: risk.line, startColumn: 1, endLine: risk.line, endColumn: 1 }
      }))
    }
  }
}
