import type { CommandPolicyAnalysis, ExecutionTarget } from '../../../shared/security/commandPolicy'

export interface SshTaskRequest {
  command: string
  workingDirectory: string
  environment: Record<string, string>
  timeoutMs: number
}
export interface SshTaskTarget { profileId: string; host: string; port: number; user: string; gateway: string | null }
export interface SshTaskReference { id: string; origin: ExecutionTarget; policyVersion: string }
export interface SshTaskIntent {
  reference: SshTaskReference
  request: SshTaskRequest
  target: SshTaskTarget
  effectiveEnvironment: Record<string, string>
  analysis: CommandPolicyAnalysis
  expiresInMs: number
}
export type SshTaskStatus = 'connecting' | 'running' | 'completed' | 'not-started' | 'unknown'
export interface SshTaskResult {
  status: SshTaskStatus
  stdout: string
  stderr: string
  truncated: boolean
  exitCode: number | null
  exitSignal: string | null
  exitEvidence: string | null
  reason: string | null
  startedAt: number
  finishedAt: number | null
}
export interface SshTaskSnapshot extends SshTaskResult {
  reference: SshTaskReference
  target: SshTaskTarget
  sequence: number
  outputBytes: number
}
export interface SshTaskHandle {
  result: Promise<SshTaskSnapshot>
  cancel(): void
}
export interface SshTaskService {
  prepare(terminalId: string, generation: number, request: SshTaskRequest): Promise<SshTaskIntent>
  approve(intent: SshTaskIntent): Promise<void>
  start(terminalId: string, generation: number, intent: SshTaskIntent, update: (snapshot: SshTaskSnapshot) => void): Promise<SshTaskHandle>
  cancel(intent: SshTaskIntent): Promise<unknown>
}

export function sshTaskResult(snapshot: SshTaskSnapshot): SshTaskResult {
  const { status, stdout, stderr, truncated, exitCode, exitSignal, exitEvidence, reason, startedAt, finishedAt } = snapshot
  return { status, stdout, stderr, truncated, exitCode, exitSignal, exitEvidence, reason, startedAt, finishedAt }
}
export function sshTaskTargetLabel(target: SshTaskTarget) {
  return `${target.user}@${target.host}:${target.port}${target.gateway ? `（经 ${target.gateway}）` : ''}`
}
export function sshTaskOutput(result: Pick<SshTaskResult, 'stdout' | 'stderr'>) {
  return `stdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`
}
