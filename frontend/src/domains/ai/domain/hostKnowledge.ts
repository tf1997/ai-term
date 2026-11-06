import type { ExecutionTarget } from '../../../shared/security/commandPolicy'
import type { AgentCheckpoint } from './agentCheckpoints'
import { isSensitiveCommand } from '../../../shared/security/commandPrivacy'
export interface HostKnowledgeScope { profileId: string; routeKey: string; user: string; environmentScope: string }
export type HostKnowledgeKind = 'service-directory' | 'config-path' | 'log-path' | 'deployment-method' | 'verification'
export type HostKnowledgeStatus = 'active' | 'needs-review' | 'invalid'
export interface KnowledgeEvidence { runId: string; stepId: string }
export interface HostKnowledgeDraft {
  validForDays: number
  id: string | null; expectedRevision: number | null; kind: HostKnowledgeKind; title: string; value: string
  status: HostKnowledgeStatus; evidence: KnowledgeEvidence | null
}
export interface HostKnowledge {
  id: string; revision: number; scope: HostKnowledgeScope; kind: HostKnowledgeKind; title: string; value: string
  status: HostKnowledgeStatus; source: { evidence: KnowledgeEvidence; resolvedPath: string | null; fileScope: string | null } | null
  createdAt: number; updatedAt: number; confirmedAt: number | null; expiresAt?: number | null; invalidReason: string | null; lastObservation: KnowledgeEvidence | null
}
export type HostKnowledgeContextLoader = (query: string, runId?: string) => Promise<string>
export function sameKnowledgeScope(a: HostKnowledgeScope | null, b: HostKnowledgeScope | null) {
  return Boolean(a && b && a.profileId === b.profileId && a.routeKey === b.routeKey && a.user === b.user && a.environmentScope === b.environmentScope)
}
export function knowledgeTargetMatches(scope: HostKnowledgeScope, target?: ExecutionTarget | null) {
  return Boolean(target && scope.profileId === target.profileId && scope.user === target.context.user && scope.environmentScope === target.context.environmentScope)
}
export const hostKnowledgeKinds: Record<HostKnowledgeKind, string> = { 'service-directory': '服务目录', 'config-path': '配置路径', 'log-path': '日志路径', 'deployment-method': '部署方法', verification: '验证方法' }
export const hostKnowledgeStatuses: Record<HostKnowledgeStatus, string> = { active: '已确认', 'needs-review': '待确认', invalid: '已失效' }
export function emptyKnowledgeDraft(): HostKnowledgeDraft { return { validForDays: 90, id: null, expectedRevision: null, kind: 'config-path', title: '', value: '', status: 'active', evidence: null } }
/** Explicit opt-in suggestions only; never include file contents or tool output. */
export function knowledgeCandidates(checkpoint: AgentCheckpoint, scope: HostKnowledgeScope): HostKnowledgeDraft[] {
  if (checkpoint.routeKey !== scope.routeKey) return []
  return checkpoint.state.steps.filter(step => !step.sensitive && step.status === 'completed' && step.executionPhase === 'finished' && step.exitCode === 0 && knowledgeTargetMatches(scope, step.executionTarget)).flatMap(step => {
    const read = step.fileRead
    const isPath = ['read_file', 'list_directory'].includes(step.toolName) && read && !read.absent && !read.changedDuringRead && read.environmentScope
    const value = isPath ? read!.path : step.toolName === 'run_command' ? step.command : ''
    if (!value || value.length > 600 || /[\r\n\0]/.test(value) || isSensitiveCommand(value)) return []
    return [{ ...emptyKnowledgeDraft(), kind: isPath ? step.toolName === 'list_directory' ? 'service-directory' : 'config-path' : 'verification', title: `${isPath ? '路径' : '方法'} · ${step.id}`.slice(0, 80), value, evidence: { runId: checkpoint.runId, stepId: step.id } } satisfies HostKnowledgeDraft]
  }).slice(0, 64)
}
