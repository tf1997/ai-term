import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/tauri'
import type { AiProviderConfig, ConnectionProfile } from '../types/profile'
import type { AiMessage, CommandHistoryEntry, UpdateScript, WorkspaceSession } from '../types/workspace'

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
  conversationMessages?: AiConversationTurn[]
  /** Compressed summary of turns older than conversationMessages. */
  conversationSummary?: string
}

export interface AiConversationTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface AiConversationCompactRequest {
  config: AiProviderConfig
  apiKey: string
  previousSummary?: string
  messages: AiConversationTurn[]
}

export interface AiConversationCompactResponse {
  summary: string
  sourceCount: number
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

export interface AiScriptTitleRequest {
  config: AiProviderConfig
  apiKey: string
  userRequest: string
  scriptContent: string
  sourceCommands: string[]
}

export interface AiScriptTitleResponse {
  title: string
}

export interface SftpFileEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  permissions: string
  modified: string
}

export interface SftpListResponse {
  path: string
  entries: SftpFileEntry[]
}

export interface SftpTransferResponse {
  message: string
  localPath?: string
  remotePath?: string
  targetPath?: string
  isDir?: boolean
}

export interface SftpTransferEvent {
  taskId: string
  percent?: number
  text?: string
  transferredBytes?: number
  totalBytes?: number
  bytesPerSecond?: number
  remainingSeconds?: number
  etaSeconds?: number
  estimatedCompletionEpochMs?: number
  elapsedSeconds?: number
}

export interface SftpProbeResponse {
  available: boolean
  path?: string
  message: string
}

export interface RemoteTextFileResponse {
  path: string
  content: string
  revision: string
  size: number
}

export interface LocalFileEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  modified: string
}

export interface LocalDirectoryResponse {
  path: string
  home: string
  entries: LocalFileEntry[]
}

export interface BastionServerCandidate {
  host: string
  username?: string
  label: string
  sourceLine: string
}

export function connectProfile(profileId: string, cols: number, rows: number) {
  return invoke<string>('connect_profile', { profileId, cols, rows })
}

export function connectLocalTerminal(cols: number, rows: number, sessionId?: string) {
  const payload: { cols: number; rows: number; sessionId?: string } = { cols, rows }
  if (sessionId) payload.sessionId = sessionId
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

export function listConnectionProfiles() {
  return invoke<ConnectionProfile[]>('list_connection_profiles')
}

export function saveConnectionProfile(profile: ConnectionProfile) {
  return invoke<void>('save_connection_profile', { profile })
}

export function forgetAiTermKnownHost(host: string, port?: number) {
  return invoke<number>('forget_ai_term_known_host', { host, port })
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

export function compressAiConversation(request: AiConversationCompactRequest) {
  return invoke<AiConversationCompactResponse>('compress_ai_conversation', { request })
}

export function generateAiSessionTitle(request: AiSessionTitleRequest) {
  return invoke<AiSessionTitleResponse>('generate_ai_session_title', { request })
}

export function generateAiScriptTitle(request: AiScriptTitleRequest) {
  return invoke<AiScriptTitleResponse>('generate_ai_script_title', { request })
}

export function listWorkspaceSessions() {
  return invoke<WorkspaceSession[]>('list_workspace_sessions')
}

export function saveWorkspaceSession(session: WorkspaceSession) {
  return invoke<void>('save_workspace_session', { session })
}

export function deleteWorkspaceSession(id: string) {
  return invoke<boolean>('delete_workspace_session', { id })
}

export function listCommandHistory(connectionId: string) {
  return invoke<CommandHistoryEntry[]>('list_command_history', { connectionId })
}

export function saveCommandHistoryRecord(record: CommandHistoryEntry) {
  return invoke<void>('save_command_history_record', { record })
}

export function listAiConversationMessages(workspaceSessionId: string) {
  return invoke<AiMessage[]>('list_ai_conversation_messages', { workspaceSessionId })
}

export function saveAiConversationMessage(message: AiMessage) {
  return invoke<void>('save_ai_conversation_message', { message })
}

export function listUpdateScripts() {
  return invoke<UpdateScript[]>('list_update_scripts')
}

export function getUpdateScript(id: string) {
  return invoke<UpdateScript | null>('get_update_script', { id })
}

export function saveUpdateScript(script: UpdateScript) {
  return invoke<void>('save_update_script', { script })
}

export function deleteUpdateScript(id: string) {
  return invoke<boolean>('delete_update_script', { id })
}

export function localHomeDirectory() {
  return invoke<string>('local_home_directory')
}

export function localListRoots() {
  return invoke<string[]>('local_list_roots')
}

export function localListDirectory(path: string) {
  return invoke<LocalDirectoryResponse>('local_list_directory', { path })
}

export function localOpenPath(path: string) {
  return invoke<void>('local_open_path', { path })
}

export interface SftpTargetOverride {
  targetHost?: string
  targetUsername?: string
}

export interface TaskOptions {
  taskId?: string
}

export function cancelTask(taskId: string) {
  return invoke<boolean>('cancel_task', { taskId })
}

export function sftpListDirectory(connectionId: string, path: string, target?: SftpTargetOverride, options?: TaskOptions) {
  return invoke<SftpListResponse>('sftp_list_directory', { connectionId, path, ...target, ...options })
}

export function sftpProbe(connectionId: string, target?: SftpTargetOverride, options?: TaskOptions) {
  return invoke<SftpProbeResponse>('sftp_probe', { connectionId, ...target, ...options })
}

export function sftpCreateDirectory(connectionId: string, path: string, target?: SftpTargetOverride, options?: TaskOptions) {
  return invoke<SftpTransferResponse>('sftp_create_directory', { connectionId, path, ...target, ...options })
}

export function sftpDeletePath(connectionId: string, path: string, isDir: boolean, target?: SftpTargetOverride, options?: TaskOptions) {
  return invoke<SftpTransferResponse>('sftp_delete_path', { connectionId, path, isDir, ...target, ...options })
}

export function sftpUploadFile(connectionId: string, localPath: string, remoteDir: string, target?: SftpTargetOverride, options?: TaskOptions) {
  return invoke<SftpTransferResponse>('sftp_upload_file', { connectionId, localPath, remoteDir, ...target, ...options })
}

export function sftpUploadPath(connectionId: string, localPath: string, remoteDir: string, target?: SftpTargetOverride, options?: TaskOptions) {
  return invoke<SftpTransferResponse>('sftp_upload_path', { connectionId, localPath, remoteDir, ...target, ...options })
}

export function sftpDownloadFile(connectionId: string, remotePath: string, localPath: string, target?: SftpTargetOverride, options?: TaskOptions) {
  return invoke<SftpTransferResponse>('sftp_download_file', { connectionId, remotePath, localPath, ...target, ...options })
}

export function sftpDownloadPath(connectionId: string, remotePath: string, localDir: string, isDir: boolean, target?: SftpTargetOverride, options?: TaskOptions) {
  return invoke<SftpTransferResponse>('sftp_download_path', { connectionId, remotePath, localDir, isDir, ...target, ...options })
}

export function sftpReadTextFile(connectionId: string, remotePath: string, target?: SftpTargetOverride) {
  return invoke<RemoteTextFileResponse>('sftp_read_text_file', { connectionId, remotePath, ...target })
}

export function sftpSaveTextFile(
  connectionId: string,
  remotePath: string,
  content: string,
  expectedRevision: string,
  force: boolean,
  target?: SftpTargetOverride
) {
  return invoke<RemoteTextFileResponse>('sftp_save_text_file', {
    connectionId,
    remotePath,
    content,
    expectedRevision,
    force,
    ...target
  })
}

export function probeBastionServers(connectionId: string) {
  return invoke<BastionServerCandidate[]>('probe_bastion_servers', { connectionId })
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

export function sftpTransferEventName(taskId: string) {
  return `sftp:transfer:${taskId}`
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
export function onSftpTransferProgress(taskId: string, handler: (event: SftpTransferEvent) => void) {
  return listen<SftpTransferEvent>(sftpTransferEventName(taskId), (event) => handler(event.payload))
}
export function onTauriFileDrop(handler: (paths: string[]) => void) {
  return listen<string[]>('tauri://file-drop', (event) => handler(Array.isArray(event.payload) ? event.payload : []))
}

export function onTauriFileDropHover(handler: (paths: string[]) => void) {
  return listen<string[]>('tauri://file-drop-hover', (event) => handler(Array.isArray(event.payload) ? event.payload : []))
}

export function onTauriFileDropCancelled(handler: () => void) {
  return listen('tauri://file-drop-cancelled', () => handler())
}
