import { parseMessageParts } from '../../../shared/content/aiMarkdown'
import type { MessagePart } from '../../../shared/content/aiMarkdown'
import { shellCommandFromCodeBlock, codeBlockLabel, detectShellScriptLanguage } from '../../../shared/shell/shellCommand'
import { prepareScriptForExecution } from './scriptExecution'
import { analyzeScriptRisks } from '../../../shared/security/scriptRisk'

export const MAX_SCRIPT_SOURCE_COMMANDS = 80

export function compactCommands(commands: string[], limit: number) {
  const selected: string[] = []
  const seen = new Set<string>()
  for (const raw of [...commands].reverse()) {
    const command = raw.trim().replace(/\s+/g, ' ')
    if (!command || isLowSignalCommand(command)) continue
    const key = command.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    selected.push(raw.trim())
    if (selected.length >= limit) break
  }
  return selected.reverse()
}

export function isLowSignalCommand(command: string) {
  return /^(clear|history|pwd|date|whoami|exit|logout)$/.test(command.trim().toLowerCase())
}

export function extractBashScript(answer: string) {
  const shellBlock = parseMessageParts(answer)
    .find((part) => part.type === 'code' && shellCommandForPart(part))
  return shellBlock?.type === 'code' ? shellCommandForPart(shellBlock) : ''
}

export function displayAnswerWithoutScript(answer: string) {
  const parts = parseMessageParts(answer)
  if (!parts.some((part) => part.type === 'code' && shellCommandForPart(part))) return answer.trim()
  const displayText = parts
    .map((part) => {
      if (part.type === 'text') return part.content
      if (shellCommandForPart(part)) return ''
      const language = codeBlockLabel(part.language, part.content)
      return `\`\`\`${language === 'text' ? '' : language}\n${part.content}\n\`\`\``
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return displayText || '已生成脚本，可在卡片中编辑、保存或执行。'
}

export function inferScriptName(content: string, fallback: string) {
  const nameMatch = content.match(/\b(?:SCRIPT_NAME|TASK_NAME|JOB_NAME)=['"]?([a-zA-Z0-9_.-]+)/)
  if (nameMatch?.[1]) return `${nameMatch[1]} 脚本`
  const serviceMatch = content.match(/\b(?:SERVICE_NAME|APP_NAME|SERVICE)=['"]?([a-zA-Z0-9_.-]+)/)
  if (serviceMatch?.[1]) return `${serviceMatch[1]} 脚本`
  const systemctlMatch = content.match(/\bsystemctl\s+(?:restart|reload|status)\s+([a-zA-Z0-9_.@-]+)/)
  if (systemctlMatch?.[1]) return `${systemctlMatch[1]} 脚本`
  return fallback.trim() || '脚本'
}

export function inferDescription(answer: string) {
  const lines = answer
    .replace(/```[\s\S]*?```/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.slice(0, 2).join(' ').slice(0, 180)
}

export function isAutoScriptName(name: string) {
  return ['服务更新脚本', '更新脚本', '脚本', 'untitled', 'untitled script'].includes(name.trim().toLowerCase())
}

export function isDangerousScript(content: string) {
  return analyzeScriptRisks(preparedScriptContent(content)).length > 0
}

export function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function isTauriUnavailableError(error: unknown) {
  const message = formatError(error)
  return message.includes('__TAURI_IPC__') || message.includes('window.__TAURI_IPC__') || message.includes('invoke')
}

export function nowText() {
  return new Date().toISOString()
}

export function shellCommandForPart(part: MessagePart) {
  if (part.type !== 'code') return ''
  return shellCommandFromCodeBlock(part.language, part.content)
}

export function preparedScriptContent(content: string, fileName = '') {
  return prepareScriptForExecution(content, detectShellScriptLanguage(content, fileName))
}
