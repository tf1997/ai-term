export interface WorkspaceSession {
  id: string
  /** Connection active when the global AI conversation was created. */
  connectionId: string
  name: string
  summary: string
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

export interface TerminalInputEvent {
  terminalId: string
  data: string
}

export interface CommandRecordedEvent {
  terminalId: string
  command: string
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
