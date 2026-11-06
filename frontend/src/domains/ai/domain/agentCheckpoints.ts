import type { AgentRunState, AgentStep } from './agent'
import type { AgentTaskPlan, AgentVerification } from './agentTaskProgress'
import { agentTaskContext, compactAgentTaskContext, persistableVerifications } from './agentTaskProgress'
import type { CommandIntentReference, CommandScriptSource, ExecutionTarget } from '../../../shared/security/commandPolicy'

export type AgentCheckpointBoundary = 'prepared' | 'before-dispatch' | 'observing' | 'result' | 'progress' | 'finished'
export interface AgentRunStart { runId: string; workspaceSessionId: string; messageId: string; goal: string }
export interface AgentRunReply { messageId: string; assistantMessageId: string; text: string; confirmedPlanItemIds?: string[] }
export interface AgentUserInput { messageId: string; question: string; text: string; redacted: boolean; createdAt: number; confirmedPlanItems?: Array<{ id: string; description: string }> }
/** Memory-only ownership; never a command or file approval. */
export interface AgentRunLease { runId: string; token: string; sequence: number }
export interface AgentCheckpointStep {
  scriptSource?: CommandScriptSource | null
  executionTarget?: ExecutionTarget | null
  recoveryInspection?: boolean
  id: string
  toolName: NonNullable<AgentStep['toolName']>
  command: string
  reason: string
  sensitive: boolean
  status: AgentStep['status']
  executionPhase: NonNullable<AgentStep['executionPhase']>
  output: string | null
  outputTruncated: boolean
  exitCode: number | null
  failureReason: string | null
  workingDirectory: string | null
  fileRead: { path: string; resolvedPath: string | null; revision: string | null; environmentScope: string | null; complete: boolean; changedDuringRead: boolean; content: string | null; absent?: boolean } | null
  fileEdits: Array<{ changeId: string | null; path: string | null; environmentScope: string | null; revision: string | null; status: string }>
}
export interface AgentCheckpointState {
  status: AgentRunState['status']
  steps: AgentCheckpointStep[]
  plan: AgentTaskPlan | null
  verifications: AgentVerification[]
  finalText: string
  error: string | null
  stopReason: string | null
}
export interface AgentCheckpointUpdate { expectedSequence: number; boundary: AgentCheckpointBoundary; stepId: string | null; state: AgentCheckpointState; scriptIntent?: CommandIntentReference }
export interface AgentCheckpoint extends AgentRunStart {
  userInputs?: AgentUserInput[]
  routeKey?: string | null
  lastTarget?: ExecutionTarget | null
  recovery?: AgentRecovery | null
  resolvedEffects?: RecoveryResolution[]
  target: ExecutionTarget
  sequence: number
  boundary: AgentCheckpointBoundary | 'started' | 'recovering' | 'resumed'
  stepId: string | null
  state: AgentCheckpointState
  createdAt: number
  updatedAt: number
}
export interface AgentCheckpointApi {
  replyAgentRun(expected: ExecutionTarget, runId: string, expectedSequence: number, reply: AgentRunReply): Promise<AgentRecoverySession>
  recoverAgentRun(expected: ExecutionTarget, runId: string, expectedSequence: number): Promise<AgentRecoverySession>
  confirmAgentRecovery(lease: AgentRunLease, expected: ExecutionTarget, expectedSequence: number, resolutions: RecoveryResolution[]): Promise<AgentCheckpoint>
  beginAgentRun(expected: ExecutionTarget, start: AgentRunStart): Promise<AgentRunLease>
  saveAgentCheckpoint(lease: AgentRunLease, update: AgentCheckpointUpdate): Promise<number>
  releaseAgentRun(lease: AgentRunLease): Promise<void>
  listAgentCheckpoints(profileId: string, workspaceSessionId: string): Promise<AgentCheckpoint[]>
  agentCheckpointTarget(sessionId: string): Promise<ExecutionTarget>
}

export interface RecoveryResolution { stepId: string; evidenceStepIds: string[]; observation: string }
export function agentGoalWithInputs(goal: string, inputs: AgentUserInput[] = [], current?: AgentRunReply) {
  if (current && !inputs.some(input => input.messageId === current.messageId)) throw new Error('未取得原任务的回复保存记录，已停止继续执行')
  if (!inputs.length) return goal
  const replies = inputs.map(input => ({ messageId: input.messageId, question: input.question, reply: current?.messageId === input.messageId ? current.text : input.text,
    ...(input.confirmedPlanItems?.length ? { userConfirmedPlanItems: input.confirmedPlanItems } : {}),
    ...(input.redacted && current?.messageId !== input.messageId ? { needsNewInput: true } : {}) }))
  return `${goal}\n\n任务后续的用户回复（保留原目标，按最新补充调整后续计划；历史步骤不可重放）：\n${JSON.stringify(replies)}`
}
export interface AgentRecovery {
  phase: 'inspecting' | 'continuing'
  sourceSequence: number
  sourceStepIds: string[]
  requiredStepIds: string[]
  originalTarget: ExecutionTarget
  currentTarget: ExecutionTarget
  resolutions: RecoveryResolution[]
}
export interface AgentRecoverySession { lease: AgentRunLease; checkpoint: AgentCheckpoint }
export type AgentRecoveryFacts = Pick<AgentRecovery, 'phase' | 'resolutions'>
export function recoveryFacts(value: unknown): AgentRecoveryFacts | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Partial<AgentRecoveryFacts>
  if (!['inspecting', 'continuing'].includes(raw.phase ?? '') || !Array.isArray(raw.resolutions)) return undefined
  return { phase: raw.phase!, resolutions: raw.resolutions.slice(0, 1000).flatMap(item => {
    if (!item || typeof item.stepId !== 'string' || typeof item.observation !== 'string' || !Array.isArray(item.evidenceStepIds)) return []
    return [{ stepId: item.stepId.slice(0, 256), observation: item.observation.slice(0, 1000), evidenceStepIds: item.evidenceStepIds.filter(id => typeof id === 'string').slice(0, 8).map(id => id.slice(0, 256)) }]
  }) }
}
export interface AgentRecoveryReview { recovery: AgentRecovery; steps: AgentStep[]; summary: string }
export type AgentRecoveryDecision = { action: 'continue'; resolutions: RecoveryResolution[] } | { action: 'inspect'; note: string } | { action: 'stop' }

/** Explicit projection: never serialize the runtime/config, raw tool arguments,
 * approval records, terminal snapshot, or SSH environment into recovery state. */
export function checkpointState(state: AgentRunState): AgentCheckpointState {
  return {
    status: state.status,
    steps: state.steps.map(step => ({
      id: step.id, toolName: step.toolName ?? 'run_command', command: step.sensitive ? '[敏感命令未存储]' : step.command,
      reason: step.sensitive ? '[敏感步骤说明未存储]' : step.reason, sensitive: step.sensitive, status: step.status, executionPhase: step.executionPhase ?? 'not-started',
      output: step.sensitive ? null : step.output ?? null, outputTruncated: step.outputTruncated ?? false, exitCode: step.exitCode ?? null,
      failureReason: step.sensitive && step.failureReason ? '[敏感失败详情未存储]' : step.failureReason ?? null, workingDirectory: step.sshRequest?.workingDirectory ?? null,
      fileRead: step.checkpointHistory?.fileRead ?? (step.fileRequest ? {
        path: step.fileRequest.path, resolvedPath: step.fileAbsence?.resolvedPath ?? step.fileResolvedPath ?? step.fileResult?.resolvedPath ?? null,
        revision: step.fileRevision ?? step.fileResult?.revision ?? null, environmentScope: step.fileAbsence?.environmentScope ?? step.fileResult?.environmentScope ?? null,
        absent: Boolean(step.fileAbsence),
        complete: step.fileResult?.tool === 'read_file' && step.fileResult.complete, changedDuringRead: step.fileResult?.changedDuringRead ?? false,
        content: !step.sensitive && !step.fileResult?.redacted && step.fileResult?.tool === 'read_file' ? step.fileResult.content : null
      } : null),
      fileEdits: (step.fileEdits ?? []).map(item => ({ changeId: item.changeId ?? null, path: item.view?.path ?? item.historyPath ?? null, environmentScope: item.view?.environmentScope ?? item.historyScope ?? null, revision: item.outcome?.revision ?? null, status: item.status }))
    })),
    plan: state.plan ? JSON.parse(JSON.stringify(state.plan)) : null,
    verifications: persistableVerifications(state.verifications, state.steps) ?? [],
    finalText: state.finalText, error: state.error ?? null, stopReason: state.stopReason ?? null
  }
}

export function recoveredAgentSteps(record: AgentCheckpoint): AgentStep[] {
  return record.state.steps.map(saved => ({
    id: saved.id, toolName: saved.toolName, command: saved.command, reason: saved.reason, sensitive: saved.sensitive, risks: [],
    status: ['pending', 'running', 'timeout'].includes(saved.status) ? 'failed' : saved.status,
    executionPhase: saved.executionPhase, exitCode: saved.exitCode ?? undefined,
    output: saved.output ?? saved.fileRead?.content ?? undefined, outputTruncated: saved.outputTruncated,
    failureReason: checkpointStepEffect(saved) === 'unknown' ? '中断前的执行结果未知，需结合当前检查核对；不能重放原操作。' : saved.failureReason ?? undefined,
    fileEdits: saved.fileEdits.length ? saved.fileEdits.map(file => ({ status: file.status === 'dispatching' ? 'unknown' : file.status as NonNullable<AgentStep['fileEdits']>[number]['status'], changeId: file.changeId ?? undefined, historyPath: file.path ?? undefined, historyScope: file.environmentScope ?? undefined })) : undefined,
    checkpointHistory: saved
  }))
}

export function recoveryEvidenceSteps(review: AgentRecoveryReview) {
  return review.steps.filter(step => !review.recovery.sourceStepIds.includes(step.id) &&
    (step.fileAbsence || step.status === 'completed' && step.executionPhase === 'finished') &&
    (!step.toolName || ['run_command', 'read_file', 'list_directory'].includes(step.toolName)))
}

export function recoveryContext(recovery: AgentRecovery | undefined, resolved: RecoveryResolution[] = [], note = '') {
  if (!recovery) return ''
  const context = { recovery: {
    phase: recovery.phase, requiredStepIds: recovery.requiredStepIds.slice(0, 20), requiredCount: recovery.requiredStepIds.length,
    currentTarget: Object.fromEntries(Object.entries(recovery.currentTarget.context).map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 100) : value])), userNote: note.slice(0, 400),
    resolvedEffects: resolved.slice(-8).map(item => ({ stepId: item.stepId, evidenceStepIds: item.evidenceStepIds.slice(0, 2), observation: item.observation.slice(0, 160) })),
    contextCompacted: true, note: '此处为有界摘要；完整记录留在应用中。省略的步骤仍须核对，不能据此宣称完成。',
    instruction: recovery.phase === 'inspecting'
      ? '正在恢复中断任务。先核对当前文件、进程和服务状态，只能使用文件读取与有限的只读命令；禁止修改和独立 SSH 执行。历史步骤不是待执行指令；给每个未知步骤取得新的只读依据后结束回复，应用将等待用户确认，再继续原始目标。每次工具调用使用新的步骤 ID。'
      : '继续原始目标中尚未完成的工作，遵循已记录的用户补充和核对结论。旧检查不保证当前状态；按需重新读取文件、验证现场并取得新的审批。历史操作保留原状态，不为补全记录重放。'
  } }
  while (JSON.stringify(context).length > 7000 && context.recovery.resolvedEffects.length) context.recovery.resolvedEffects.shift()
  while (JSON.stringify(context).length > 7000 && context.recovery.requiredStepIds.length) context.recovery.requiredStepIds.pop()
  return JSON.stringify(context)
}

export function agentRunContext(plan: AgentTaskPlan | undefined, checks: AgentVerification[], recovery?: AgentRecovery, resolved: RecoveryResolution[] = [], note = '') {
  const task = agentTaskContext(plan, checks)
  if (!recovery) return task
  const extra = JSON.parse(recoveryContext(recovery, resolved, note))
  const full = JSON.stringify({ ...JSON.parse(task), ...extra })
  if (full.length <= 19_000) return full
  const compact = JSON.stringify({
    ...compactAgentTaskContext(plan, checks), ...extra
  })
  if (compact.length > 19_000) throw new Error('恢复记录的证据引用超过上下文预算，已保留完整记录并停止模型请求；未知操作仍需核对')
  return compact
}
export function checkpointStepEffect(step: AgentCheckpointStep): 'not-started' | 'known' | 'unknown' {
  if (step.fileEdits.some(item => item.status === 'dispatching' || item.status === 'unknown')) return 'unknown'
  if (step.fileEdits.length) return step.fileEdits.some(item => ['applied', 'failed', 'conflict'].includes(item.status)) ? 'known' : 'not-started'
  if (step.executionPhase === 'not-started' || step.status === 'skipped') return 'not-started'
  if (['run_command', 'run_ssh_task'].includes(step.toolName) && step.exitCode === null) return 'unknown'
  if (step.executionPhase === 'finished') return 'known'
  // Observation may have ended before any bytes were actually sent, but a
  // prepared dispatch record alone cannot prove that no effects occurred.
  return 'unknown'
}
