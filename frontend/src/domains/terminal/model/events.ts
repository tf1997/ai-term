


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
