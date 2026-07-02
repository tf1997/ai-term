import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/tauri'
import type { AiProviderConfig, ConnectionProfile } from '../types/profile'
import type { AiMessage, CommandHistoryEntry, WorkspaceSession } from '../types/workspace'

export interface TerminalDataEvent {
  sessionId: string
  data: string
}

export interface TerminalClosedEvent {
  sessionId: string
  reason: string
}

export interface AiChatRequest {
  config: AiProviderConfig
  apiKey: string
  question: string
  terminalSnapshot: string
  commandHistory: string[]
}

export interface AiChatResponse {
  answer: string
  contextCompressed: boolean
  contextChars: number
  historyCount: number
}

export interface AiChatStreamEvent {
  requestId: string
  kind: 'chunk' | 'done' | 'error'
  delta: string
  error?: string
  contextCompressed?: boolean
  contextChars?: number
  historyCount?: number
}

export interface AiSessionTitleRequest {
  config: AiProviderConfig
  apiKey: string
  userMessage: string
  assistantMessage: string
  terminalSnapshot: string
  commandHistory: string[]
}

export interface AiSessionTitleResponse {
  title: string
}

export function connectProfile(profileId: string, cols: number, rows: number) {
  return invoke<string>('connect_profile', { profileId, cols, rows })
}

export function connectLocalTerminal(cols: number, rows: number) {
  return invoke<string>('connect_local_terminal', { cols, rows })
}

export function terminalWrite(sessionId: string, data: string) {
  return invoke<void>('terminal_write', { sessionId, data })
}

export function terminalResize(sessionId: string, cols: number, rows: number) {
  return invoke<void>('terminal_resize', { sessionId, cols, rows })
}

export function disconnectTerminal(sessionId: string) {
  return invoke<boolean>('disconnect_terminal', { sessionId })
}

export function listConnectionProfiles() {
  return invoke<ConnectionProfile[]>('list_connection_profiles')
}

export function saveConnectionProfile(profile: ConnectionProfile) {
  return invoke<void>('save_connection_profile', { profile })
}

export function deleteConnectionProfile(id: string) {
  return invoke<boolean>('delete_connection_profile', { id })
}

export function listAiProviderConfigs() {
  return invoke<AiProviderConfig[]>('list_ai_provider_configs')
}

export function getAiProviderConfig(id: string) {
  return invoke<AiProviderConfig | null>('get_ai_provider_config', { id })
}

export function saveAiProviderConfig(config: AiProviderConfig) {
  return invoke<void>('save_ai_provider_config', { config })
}

export function deleteAiProviderConfig(id: string) {
  return invoke<boolean>('delete_ai_provider_config', { id })
}

export function chatWithAiProvider(request: AiChatRequest) {
  return invoke<AiChatResponse>('chat_with_ai_provider', { request })
}

export function chatWithAiProviderStream(requestId: string, request: AiChatRequest) {
  return invoke<AiChatResponse>('chat_with_ai_provider_stream', { requestId, request })
}

export function generateAiSessionTitle(request: AiSessionTitleRequest) {
  return invoke<AiSessionTitleResponse>('generate_ai_session_title', { request })
}

export function listWorkspaceSessions(connectionId: string) {
  return invoke<WorkspaceSession[]>('list_workspace_sessions', { connectionId })
}

export function saveWorkspaceSession(session: WorkspaceSession) {
  return invoke<void>('save_workspace_session', { session })
}

export function deleteWorkspaceSession(id: string) {
  return invoke<boolean>('delete_workspace_session', { id })
}

export function listCommandHistory(connectionId: string, workspaceSessionId: string) {
  return invoke<CommandHistoryEntry[]>('list_command_history', { connectionId, workspaceSessionId })
}

export function saveCommandHistoryRecord(record: CommandHistoryEntry) {
  return invoke<void>('save_command_history_record', { record })
}

export function listAiConversationMessages(connectionId: string, workspaceSessionId: string) {
  return invoke<AiMessage[]>('list_ai_conversation_messages', { connectionId, workspaceSessionId })
}

export function saveAiConversationMessage(message: AiMessage) {
  return invoke<void>('save_ai_conversation_message', { message })
}

export function terminalDataEventName(sessionId: string) {
  return `terminal:data:${sessionId}`
}

export function terminalClosedEventName(sessionId: string) {
  return `terminal:closed:${sessionId}`
}

export function aiChatStreamEventName(requestId: string) {
  return `ai-chat:stream:${requestId}`
}

export function onTerminalData(sessionId: string, handler: (event: TerminalDataEvent) => void) {
  return listen<TerminalDataEvent>(terminalDataEventName(sessionId), (event) => handler(event.payload))
}

export function onTerminalClosed(sessionId: string, handler: (event: TerminalClosedEvent) => void) {
  return listen<TerminalClosedEvent>(terminalClosedEventName(sessionId), (event) => handler(event.payload))
}

export function onAiChatStream(requestId: string, handler: (event: AiChatStreamEvent) => void) {
  return listen<AiChatStreamEvent>(aiChatStreamEventName(requestId), (event) => handler(event.payload))
}
