import type { ConnectionProfile } from '../../connections/types'
import type { TerminalInputSyncState } from './events'
import type { AgentCaptureMode, AgentCommandHandle } from '../../ai/types'

export type TerminalRuntimeStatus = 'idle' | 'connecting' | 'local' | 'remote' | 'sftp' | 'preview' | 'error'

export interface TerminalTab {
  id: string
  title: string
  connectionId: string
  profile?: ConnectionProfile
  connectRequest: number
  status: TerminalRuntimeStatus
  connectionGeneration: number
}

export interface TerminalPaneHandle {
  commandExecutionReadiness: () => 'ready' | 'line-busy' | 'shell-busy' | 'unavailable'
  executeCommand: (command: string) => boolean
  agentCaptureSupported: () => boolean
  agentCapturePreparing: () => boolean
  ensureAgentCapture: () => Promise<AgentCaptureMode>
  runCommandAndCapture: (
    command: string,
    options?: { maxOutputChars?: number; dispatchGuard?: () => string }
  ) => AgentCommandHandle
  fillCommand: (command: string) => boolean
  pinQuickCommand: (command: string) => 'added' | 'exists' | 'invalid' | 'limit'
  terminalInputSyncState: () => TerminalInputSyncState
  writeTerminalInput: (data: string) => boolean
  writeFileInput: (data: string) => Promise<boolean>
  finishFileInput: (command: string) => void
  interruptFileInput: () => Promise<boolean>
  writeSyncedTerminalInput: (data: string, sourceTerminalId: string) => boolean
  clearTerminal: () => void
  disconnectFromButton: () => void
  focusTerminal: () => void
  restartLocalTerminal: () => void
}
