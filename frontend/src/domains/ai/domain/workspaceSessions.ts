import type { AiMessage, WorkspaceSession } from './conversation'
import type { AgentErrorKind, AgentExecutionPhase, AgentStep } from './agent'
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

function normalizeErrorKind(value: unknown): AgentErrorKind | undefined {
  return value === 'model' || value === 'tool' || value === 'protocol' ? value : undefined
}

function normalizeExecutionPhase(value: unknown): AgentExecutionPhase | undefined {
  return value === 'not-started' || value === 'dispatching' || value === 'running' || value === 'finished' ? value : undefined
}

function hydrateAgentSteps(steps: AgentStep[], message: AiMessage) {
  const detail = message.text.replace(/^任务出错[:：]\s*/, '')
  const validSteps = steps.filter((step) => step && typeof step === 'object')
  let failedStep = -1
  validSteps.forEach((step, index) => {
    if (step.status === 'failed') failedStep = index
  })
  return validSteps.map((step, index) => {
    let executionPhase = normalizeExecutionPhase(step.executionPhase)
    let failureReason = typeof step.failureReason === 'string' ? step.failureReason : undefined
    if (!executionPhase) {
      if (step.status === 'completed') executionPhase = 'finished'
      if (step.status === 'pending' || step.status === 'skipped') executionPhase = 'not-started'
      // Older records stored dispatch failures only in the enclosing message text.
      if (index === failedStep && (detail.startsWith('命令派发失败:') || detail.startsWith('命令派发失败：') || detail.startsWith('命令启动失败:') || detail.startsWith('命令启动失败：'))) {
        executionPhase = 'not-started'
        failureReason = failureReason || detail
      }
    }
    return { ...step, executionPhase, failureReason }
  })
}

export function hydrateAiMessagePayload(message: AiMessage): AiMessage {
  const raw = message.payloadJson?.trim()
  if (!raw) return message
  try {
    const payload = JSON.parse(raw) as Partial<Pick<
      AiMessage,
      'mode' | 'agentSteps' | 'agentStatus' | 'terminalConnectionGeneration' | 'errorKind' | 'stopReason'
    >> & { usage?: unknown }
    const usage = normalizeMessageUsage(payload.usage)
    if (payload.mode !== 'agent') return usage ? { ...message, usage } : message
    const agentSteps = hydrateAgentSteps(Array.isArray(payload.agentSteps) ? payload.agentSteps : [], message)
    const errorKind = normalizeErrorKind(payload.errorKind) ?? (message.error
      ? agentSteps.some((step) => step.status === 'failed') ? 'tool' : 'model'
      : undefined)
    const stopReason = typeof payload.stopReason === 'string' ? payload.stopReason : undefined
    return {
      ...message,
      mode: 'agent',
      agentSteps,
      agentStatus: payload.agentStatus === 'done' || payload.agentStatus === 'stopped' || payload.agentStatus === 'error'
        ? payload.agentStatus
        : 'done',
      ...(errorKind ? { errorKind } : {}),
      ...(stopReason ? { stopReason } : {}),
      terminalConnectionGeneration: Number.isSafeInteger(payload.terminalConnectionGeneration) && payload.terminalConnectionGeneration! >= 0
        ? payload.terminalConnectionGeneration
        : message.terminalConnectionGeneration,
      ...(usage ? { usage } : {})
    }
  } catch {
    return message
  }
}
