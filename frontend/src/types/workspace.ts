export interface WorkspaceSession {
  id: string
  connectionId: string
  name: string
  summary: string
  createdAt: string
  updatedAt: string
}

export interface CommandHistoryEntry {
  id: string
  connectionId: string
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
