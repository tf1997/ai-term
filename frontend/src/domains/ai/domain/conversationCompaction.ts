import type { AiMessage } from './conversation'
import { AI_CONTEXT_COMPACT_THRESHOLD, MAX_AI_CONVERSATION_MESSAGES } from './aiConversation'

// Character budgets match the backend's provider-independent prompt limits.
// These are context limits, not estimates of billable tokens.
const MAX_CONVERSATION_CHARS = 8_000
const RECENT_CONVERSATION_TARGET_CHARS = 4_000
const MIN_RECENT_MESSAGES = 4
const MAX_COMPACT_SOURCE_MESSAGE_CHARS = 1_500
const MAX_COMPACT_SOURCE_TOTAL_CHARS = 12_000

interface ConversationCompactionPlan {
  messages: Array<{ role: AiMessage['role']; content: string }>
  lastMessageId: string
}

function charCount(text: string): number {
  return Array.from(text).length
}

function excerpt(text: string, maxChars: number): string {
  const chars = Array.from(text.trim())
  if (chars.length <= maxChars) return chars.join('')
  const note = '\n[中间内容已省略]\n'
  const available = maxChars - charCount(note)
  const head = Math.ceil(available / 2)
  return chars.slice(0, head).join('') + note + chars.slice(-(available - head)).join('')
}

function messageForCompaction(message: AiMessage): string {
  const steps = message.agentSteps
  if (!steps?.length) return excerpt(message.text, MAX_COMPACT_SOURCE_MESSAGE_CHARS)

  // Include execution evidence that is otherwise stored only in the Agent card.
  // Never reintroduce sensitive command text or output into a summary request.
  const text = excerpt(message.text, 700)
  const evidence = steps.map((step) => {
    const command = step.sensitive ? '[敏感命令已隐藏]' : excerpt(step.command, 160)
    const result = !step.sensitive && step.output ? `；结果片段：${excerpt(step.output, 160)}` : ''
    const exit = step.exitCode === undefined ? '' : `；退出码：${step.exitCode}`
    return `${command}；状态：${step.status}${exit}${result}`
  }).join('\n')
  const label = '\n执行记录（命令和结果可能为片段）：\n'
  return text + label + excerpt(evidence, MAX_COMPACT_SOURCE_MESSAGE_CHARS - charCount(text + label))
}

/** Compact an oldest, contiguous batch; never advance past unsent messages. */
export function planConversationCompaction(messages: AiMessage[]): ConversationCompactionPlan | undefined {
  const sizes = messages.map((message) => charCount(message.text.trim()))
  const overCharBudget = sizes.reduce((sum, size) => sum + size, 0) >= MAX_CONVERSATION_CHARS
  const overflowCount = messages.length - MAX_AI_CONVERSATION_MESSAGES
  if (!overCharBudget && overflowCount < AI_CONTEXT_COMPACT_THRESHOLD) return

  let boundary = Math.max(0, overflowCount)
  if (overCharBudget) {
    let recentChars = sizes.slice(boundary).reduce((sum, size) => sum + size, 0)
    while (boundary < messages.length - MIN_RECENT_MESSAGES && recentChars > RECENT_CONVERSATION_TARGET_CHARS) {
      recentChars -= sizes[boundary++]
    }
  }
  // Keep a question with its answer instead of leaving an orphaned assistant turn.
  while (boundary > 0 && messages[boundary]?.role === 'assistant') boundary -= 1
  if (!boundary) return

  const batch: ConversationCompactionPlan['messages'] = []
  let sourceChars = 0
  for (const message of messages.slice(0, boundary)) {
    const content = messageForCompaction(message)
    const cost = charCount(content) + 5 // Role label and separators in build_compact_prompt.
    if (sourceChars + cost > MAX_COMPACT_SOURCE_TOTAL_CHARS) break
    batch.push({ role: message.role, content })
    sourceChars += cost
  }
  while (batch.length > 0 && messages[batch.length]?.role === 'assistant') batch.pop()
  if (!batch.length) return
  return { messages: batch, lastMessageId: messages[batch.length - 1].id }
}
