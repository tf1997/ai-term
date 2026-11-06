import { invoke } from '@tauri-apps/api/tauri'
import type { ExecutionTarget } from '../../../shared/security/commandPolicy'
import type { AgentCheckpoint, AgentCheckpointUpdate, AgentRunStart, AgentRunLease, AgentRecoverySession, RecoveryResolution, AgentRunReply } from '../domain/agentCheckpoints'

export const agentCheckpointTarget = (sessionId: string) => invoke<ExecutionTarget>('command_execution_target', { sessionId })
export const recoverAgentRun = (expected: ExecutionTarget, runId: string, expectedSequence: number) => invoke<AgentRecoverySession>('recover_agent_run', { expected, runId, expectedSequence })
export const replyAgentRun = (expected: ExecutionTarget, runId: string, expectedSequence: number, reply: AgentRunReply) => invoke<AgentRecoverySession>('reply_agent_run', { expected, runId, expectedSequence, reply })
export const confirmAgentRecovery = (lease: AgentRunLease, expected: ExecutionTarget, expectedSequence: number, resolutions: RecoveryResolution[]) => invoke<AgentCheckpoint>('confirm_agent_recovery', { lease, expected, expectedSequence, resolutions })
export const beginAgentRun = (expected: ExecutionTarget, start: AgentRunStart) => invoke<AgentRunLease>('begin_agent_run', { expected, start })
export const saveAgentCheckpoint = (lease: AgentRunLease, update: AgentCheckpointUpdate) => invoke<number>('save_agent_checkpoint', { lease, update })
export const releaseAgentRun = (lease: AgentRunLease) => invoke<void>('release_agent_run', { lease })
export const listAgentCheckpoints = (profileId: string, workspaceSessionId: string) => invoke<AgentCheckpoint[]>('list_agent_checkpoints', { profileId, workspaceSessionId })

export const completedAgentCheckpointForMessage = (profileId: string, workspaceSessionId: string, messageId: string) => invoke<AgentCheckpoint | null>('completed_agent_checkpoint_for_message', { profileId, workspaceSessionId, messageId })
