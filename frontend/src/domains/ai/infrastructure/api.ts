import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/tauri'
import type { AiProviderConfig } from '../domain/provider'

import type { AgentAllowlistEntry, AiAgentTurnRequest, AiAgentTurnResponse } from '../domain/agent'
import type { AiMessage, WorkspaceSession } from '../domain/conversation'
import type { AiTokenUsage } from '../domain/tokenUsage'




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
  /** 网关上报的 token 用量;未上报时缺省。 */
  usage?: AiTokenUsage
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

/** Agent 模式:单轮模型调用(文本走 ai-chat 流事件,tool_calls 随返回值)。 */
export function aiAgentTurnStream(requestId: string, request: AiAgentTurnRequest) {
  return invoke<AiAgentTurnResponse>('ai_agent_turn_stream', { requestId, request })
}

export function listAgentCommandAllowlist() {
  return invoke<AgentAllowlistEntry[]>('list_agent_command_allowlist')
}

export function saveAgentCommandAllowlistEntry(pattern: string, sourceCommand: string) {
  return invoke<void>('save_agent_command_allowlist_entry', { pattern, sourceCommand })
}

export function deleteAgentCommandAllowlistEntry(pattern: string) {
  return invoke<boolean>('delete_agent_command_allowlist_entry', { pattern })
}

export function touchAgentCommandAllowlistEntry(pattern: string) {
  return invoke<void>('touch_agent_command_allowlist_entry', { pattern })
}

export function compressAiConversation(request: AiConversationCompactRequest) {
  return invoke<AiConversationCompactResponse>('compress_ai_conversation', { request })
}

export function generateAiSessionTitle(request: AiSessionTitleRequest) {
  return invoke<AiSessionTitleResponse>('generate_ai_session_title', { request })
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

export function listAiConversationMessages(workspaceSessionId: string) {
  return invoke<AiMessage[]>('list_ai_conversation_messages', { workspaceSessionId })
}

export function saveAiConversationMessage(message: AiMessage) {
  return invoke<void>('save_ai_conversation_message', { message })
}

export function aiChatStreamEventName(requestId: string) {
  return `ai-chat:stream:${requestId}`
}

export function onAiChatStream(requestId: string, handler: (event: AiChatStreamEvent) => void) {
  return listen<AiChatStreamEvent>(aiChatStreamEventName(requestId), (event) => handler(event.payload))
}

export { cancelTask } from '../../../shared/platform/tasks'
