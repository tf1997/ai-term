import type { AiMessage } from './conversation'
import type { TerminalSelectionEvent } from '../../terminal/types'
import { parseMessageParts } from '../../../shared/content/aiMarkdown'
import type { MessagePart } from '../../../shared/content/aiMarkdown'
import { isSensitiveCommand } from '../../../shared/security/commandPrivacy'
import { commandTokensForPrivacy } from '../agent/agentAutoApprove'
import { isSensitivePath } from '../../../shared/security/pathPrivacy'
import { looksLikeShellCommand, normalizeShellCommand, shellCommandFromCodeBlock } from '../../../shared/shell/shellCommand'

export const MAX_SELECTED_TERMINAL_CHARS = 20_000

export const MAX_AI_COMMAND_HISTORY = 80

export const MAX_AI_CONVERSATION_MESSAGES = 16

// Compact when this many eligible turns pile up beyond the recent window,
// so the compaction call runs occasionally instead of after every exchange.
export const AI_CONTEXT_COMPACT_THRESHOLD = 8

export function isSensitiveAgentCommand(command: string) {
  return isSensitiveCommand(command)
    || commandTokensForPrivacy(command).some((token) => isSensitivePath(token))
}

export function formatSelectedLineRange(selection: TerminalSelectionEvent) {
  if (!selection.startLine || !selection.endLine) return 'line ?'
  if (selection.startLine === selection.endLine) return `line ${selection.startLine}`
  return `line ${selection.startLine} - line ${selection.endLine}`
}

export function truncateSelectedTerminalText(text: string) {
  if (text.length <= MAX_SELECTED_TERMINAL_CHARS) return text
  return `${text.slice(0, MAX_SELECTED_TERMINAL_CHARS)}\n\n[AI Term 已截断用户选中的终端内容：省略 ${text.length - MAX_SELECTED_TERMINAL_CHARS} 个字符]`
}

export function buildQuestionWithSelectedTerminalText(question: string, selection?: TerminalSelectionEvent) {
  if (!selection?.text.trim()) return question
  return [
    `用户问题：${question.trim()}`,
    '',
    `用户选中的终端内容（${formatSelectedLineRange(selection)}）：`,
    '```text',
    truncateSelectedTerminalText(selection.text),
    '```',
    '',
    '请优先结合这段选中内容、当前终端内容和历史命令回答。'
  ].join('\n')
}

export function createMessage(
  connectionId: string,
  workspaceSessionId: string,
  terminalId: string,
  role: AiMessage['role'],
  text: string,
  command = '',
  error = false,
  streaming = false
): AiMessage {
  return {
    id: `${connectionId}-${terminalId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    connectionId,
    workspaceSessionId,
    terminalId,
    role,
    text,
    command,
    error,
    streaming,
    createdAt: new Date().toISOString()
  }
}

export function formatAiError(error: unknown) {
  if (!(error instanceof Error)) return String(error)
  if (error.message.includes('__TAURI_IPC__') || error.message.includes('invoke')) {
    return `AI 后端调用不可用：${error.message}\n请通过 Tauri 客户端运行，或在 src-tauri 目录执行 cargo run。`
  }
  return error.message
}

export function extractPrimaryShellCommand(answer: string) {
  const shellBlock = parseMessageParts(answer)
    .find((part) => part.type === 'code' && shellCommandForPart(part))
  if (shellBlock?.type === 'code') return shellCommandForPart(shellBlock)

  const candidate = answer
    .split('\n')
    .map((line) => line.trim())
    .find((line) => looksLikeShellCommand(line))
  return candidate ? normalizeShellCommand(candidate) : ''
}

export function shellCommandForPart(part: MessagePart) {
  if (part.type !== 'code') return ''
  return shellCommandFromCodeBlock(part.language, part.content)
}

export function normalizeGeneratedSessionTitle(generatedTitle: string, userMessage: string) {
  const title = generatedTitle.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').slice(0, 36)
  if (/^[a-z0-9._-]{1,3}$/i.test(title)) return `${title} 命令`
  if (title) return title
  const fallback = userMessage.trim().replace(/\s+/g, ' ').slice(0, 24)
  return fallback || '当前会话'
}

export function formatSessionDisplayTitle(name?: string) {
  const title = (name?.trim() || '当前会话').replace(/([^\d\s])(\d+)$/, '$1 $2')
  return /^[a-z0-9._-]{1,3}$/i.test(title) ? `${title} 命令` : title
}

export function isAutoSessionName(name: string) {
  return ['untitled', '默认会话', '本地默认会话', '当前会话'].includes(name.trim().toLowerCase())
}
