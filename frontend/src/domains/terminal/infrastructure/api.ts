import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/tauri'




import type { CommandHistoryEntry } from '../domain/events'



export interface TerminalDataEvent {
  sessionId: string
  data: string
}

export interface TerminalClosedEvent {
  sessionId: string
  reason: string
}

export function connectProfile(profileId: string, cols: number, rows: number) {
  return invoke<string>('connect_profile', { profileId, cols, rows })
}

export function connectLocalTerminal(
  cols: number,
  rows: number,
  sessionId?: string,
  shellIntegration?: boolean
) {
  const payload: { cols: number; rows: number; sessionId?: string; shellIntegration?: boolean } = { cols, rows }
  if (sessionId) payload.sessionId = sessionId
  if (shellIntegration !== undefined) payload.shellIntegration = shellIntegration
  return invoke<string>('connect_local_terminal', payload)
}

export function terminalWrite(sessionId: string, data: string) {
  return invoke<void>('terminal_write', { sessionId, data })
}

export function terminalResize(sessionId: string, cols: number, rows: number) {
  return invoke<void>('terminal_resize', { sessionId, cols, rows })
}

export function terminalSessionActive(sessionId: string) {
  return invoke<boolean>('terminal_session_active', { sessionId })
}

export function disconnectTerminal(sessionId: string) {
  return invoke<boolean>('disconnect_terminal', { sessionId })
}

export function forgetAiTermKnownHost(host: string, port?: number) {
  return invoke<number>('forget_ai_term_known_host', { host, port })
}

export function listCommandHistory(connectionId: string) {
  return invoke<CommandHistoryEntry[]>('list_command_history', { connectionId })
}

export function saveCommandHistoryRecord(record: CommandHistoryEntry) {
  return invoke<void>('save_command_history_record', { record })
}

export function terminalDataEventName(sessionId: string) {
  return `terminal:data:${sessionId}`
}

export function terminalClosedEventName(sessionId: string) {
  return `terminal:closed:${sessionId}`
}

export function onTerminalData(sessionId: string, handler: (event: TerminalDataEvent) => void) {
  return listen<TerminalDataEvent>(terminalDataEventName(sessionId), (event) => handler(event.payload))
}

export function onTerminalClosed(sessionId: string, handler: (event: TerminalClosedEvent) => void) {
  return listen<TerminalClosedEvent>(terminalClosedEventName(sessionId), (event) => handler(event.payload))
}
