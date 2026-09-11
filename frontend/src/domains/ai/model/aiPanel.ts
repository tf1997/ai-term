import type { AiProviderConfig } from './provider'
import type { AiContextStatus, AiMessage, WorkspaceSession } from './conversation'
import type { CommandHistoryEntry, TerminalSelectionEvent } from '../../terminal/types'
import type { AgentCommandHandle, AgentCommandRunOptions, AiPanelMode } from './agent'

export interface AiPanelProps {
  terminalId: string
  terminalConnectionGeneration: number
  connectionId: string
  workspaceSessionId: string
  workspaceSessions: WorkspaceSession[]
  connectionLabels: Record<string, string>
  executionTargetLabel: string
  executionTargetTitle: string
  executionTargetConnectionIds: string[]
  selectedConfigId: string
  config: AiProviderConfig
  apiKey: string
  terminalSnapshot: string
  terminalSelection?: TerminalSelectionEvent
  commandHistory: CommandHistoryEntry[]
  messages: AiMessage[]
  contextStatus?: AiContextStatus
  agentAvailabilityCheck?: () => string
  /** 异步确认(无标记终端会跑哨兵探针);返回空串表示可用。 */
  agentAvailabilityConfirm?: () => Promise<string>
  agentCommandRunner?: (terminalId: string, command: string, options?: AgentCommandRunOptions) => AgentCommandHandle
  agentAllowlistPatterns?: string[]
  agentBuiltinReadonlyEnabled?: boolean
  /** 每个任务的最大步数(设置项);未传时用 agentLoop 的默认值。 */
  agentStepLimit?: number
  /** 单条命令等待多久后询问用户(设置项);未传时用 agentLoop 的默认值。 */
  agentCommandTimeoutMs?: number
}

export interface AiPanelEvents {
  appendMessage: [message: AiMessage]
  updateMessage: [message: AiMessage]
  setContextStatus: [connectionId: string, workspaceSessionId: string, status: AiContextStatus]
  executeCommand: [command: string]
  selectSession: [sessionId: string]
  createSession: []
  renameSession: [sessionId: string, name: string]
  deleteSession: [sessionId: string]
  updateSessionTitle: [connectionId: string, sessionId: string, title: string]
  updateSessionContextSummary: [sessionId: string, summary: string, lastMessageId: string]
  setSessionMode: [sessionId: string, mode: AiPanelMode]
  allowAgentPattern: [pattern: string, sourceCommand: string]
  aiError: [detail: string]
}

export type AiPanelEmit = <Event extends keyof AiPanelEvents>(event: Event, ...args: AiPanelEvents[Event]) => void
