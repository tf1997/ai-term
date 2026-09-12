import type { AiMessage, WorkspaceSession } from './conversation'
import { normalizeMessageUsage } from './tokenUsage'

export const DEFAULT_AI_SESSION_ID = 'ai:default'
export const COMMAND_HISTORY_SESSION_ID = 'connection-history'
export const COMMAND_HISTORY_CACHE_LIMIT = 300

export function nowText() {
  return new Date().toISOString()
}

export function newWorkspaceSession(connectionId: string, name?: string, id?: string): WorkspaceSession {
  const createdAt = nowText()
  return {
    id: id || `${connectionId}:session:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    connectionId,
    name: name || 'Untitled',
    summary: '',
    createdAt,
    updatedAt: createdAt
  }
}

export function isAutoWorkspaceSessionName(name: string) {
  return ['untitled', '无标题', '默认会话', '本地默认会话', '当前会话'].includes(name.trim().toLowerCase())
}

export function workspaceSessionTitleFromText(text: string) {
  const titleLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('选中终端内容'))
  return shortenWorkspaceSessionTitle(titleLine || text, '当前会话')
}

function shortenWorkspaceSessionTitle(value: string, fallback: string) {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return fallback
  return normalized.length > 60 ? `${normalized.slice(0, 57)}...` : normalized
}

export function hydrateAiMessagePayload(message: AiMessage): AiMessage {
  const raw = message.payloadJson?.trim()
  if (!raw) return message
  try {
    const payload = JSON.parse(raw) as Partial<Pick<
      AiMessage,
      'mode' | 'agentSteps' | 'agentStatus' | 'terminalConnectionGeneration'
    >> & { usage?: unknown }
    const usage = normalizeMessageUsage(payload.usage)
    if (payload.mode !== 'agent') return usage ? { ...message, usage } : message
    return {
      ...message,
      mode: 'agent',
      agentSteps: Array.isArray(payload.agentSteps) ? payload.agentSteps : [],
      agentStatus: payload.agentStatus === 'done' || payload.agentStatus === 'stopped' || payload.agentStatus === 'error'
        ? payload.agentStatus
        : 'done',
      terminalConnectionGeneration: Number.isSafeInteger(payload.terminalConnectionGeneration) && payload.terminalConnectionGeneration! >= 0
        ? payload.terminalConnectionGeneration
        : message.terminalConnectionGeneration,
      ...(usage ? { usage } : {})
    }
  } catch {
    return message
  }
}
