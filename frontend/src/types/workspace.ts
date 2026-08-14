import type { AgentStep } from './agent'

export interface WorkspaceSession {
  id: string
  /** Connection active when the global AI conversation was created. */
  connectionId: string
  name: string
  summary: string
  /** AI-compressed summary of conversation turns older than the recent window. */
  contextSummary?: string
  /** Id of the last conversation message covered by contextSummary. */
  contextSummaryLastMessageId?: string
  /** AI 面板模式(普通对话 / Agent),会话级持久化;缺省视为 chat。 */
  aiMode?: 'chat' | 'agent'
  createdAt: string
  updatedAt: string
}

export interface CommandHistoryEntry {
  id: string
  /** Command history remains owned by its execution connection. */
  connectionId: string
  /** Legacy capture-group provenance; AI conversation selection must not filter history. */
  workspaceSessionId: string
  terminalId: string
  command: string
  createdAt: string
  /** Shell integration(OSC 133;D)上报的退出码;启发式捕获的记录没有该值。 */
  exitCode?: number
}

export interface TerminalOutputEvent {
  terminalId: string
  snapshot: string
}

export interface TerminalOutputDeltaEvent extends TerminalOutputEvent {
  delta: string
  sequence: number
}

export interface TerminalSelectionEvent {
  terminalId: string
  text: string
  startLine: number
  endLine: number
}

export interface TerminalInputSyncState {
  available: boolean
  context: 'shell' | 'sensitive' | 'unknown'
  reliable: boolean
  command: string
  cursor: number
  pendingControlSequence: string
}

export interface TerminalInputEvent {
  terminalId: string
  data: string
  beforeState: TerminalInputSyncState
  safeToSync: boolean
}

export type TerminalInputWriteSource = 'interactive' | 'direct' | 'synced' | 'command'

export interface TerminalInputWriteFailureEvent {
  terminalId: string
  sourceTerminalId?: string
  source: TerminalInputWriteSource
  message: string
}

export interface CommandRecordedEvent {
  terminalId: string
  command: string
  exitCode?: number
}

export interface AiContextStatus {
  compressed: boolean
  chars: number
  history: number
}

export interface AiMessage {
  id: string
  /** Source connection for this turn; it does not control conversation visibility. */
  connectionId: string
  workspaceSessionId: string
  terminalId: string
  role: 'user' | 'assistant'
  text: string
  command?: string
  error?: boolean
  streaming?: boolean
  /** 产生该消息的模式;缺省视为 chat。 */
  mode?: 'chat' | 'agent'
  /** Agent 任务步骤时间线(运行时字段,持久化走 payloadJson)。 */
  agentSteps?: AgentStep[]
  agentStatus?: 'running' | 'done' | 'stopped' | 'error'
  /** Agent 载荷序列化(与后端 payload_json 列对应)。 */
  payloadJson?: string
  createdAt: string
}

export interface UpdateScript {
  id: string
  /** Source connection only; saved scripts are globally visible. */
  connectionId: string
  workspaceSessionId: string
  name: string
  description: string
  content: string
  sourceCommands: string[]
  createdAt: string
  updatedAt: string
}

export interface ScriptRecording {
  terminalId: string
  connectionId: string
  workspaceSessionId: string
  isRecording: boolean
  startedAt: string
  stoppedAt?: string
  commands: string[]
  terminalOutput: string
}
