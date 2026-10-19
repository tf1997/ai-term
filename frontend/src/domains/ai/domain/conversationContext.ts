import type { AiMessage } from './conversation'

// Stay within chat.rs's per-message budget so its prefix truncation cannot
// silently remove the latest Agent results appended to a historical reply.
const MAX_CONVERSATION_MESSAGE_CHARS = 3_000

function charCount(text: string): number {
  return Array.from(text).length
}

function excerpt(text: string, maxChars: number, protectedTailChars = 0): string {
  const chars = Array.from(text.trim())
  if (chars.length <= maxChars) return chars.join('')
  const note = '\n[中间内容已省略]\n'
  const available = maxChars - charCount(note)
  const tail = Math.min(available, Math.max(Math.floor(available / 2), protectedTailChars))
  const head = available - tail
  return chars.slice(0, head).join('') + note + chars.slice(-tail).join('')
}

/** Stopped/failed tasks still have useful evidence even without a final reply. */
export function hasAgentExecutionContext(message: AiMessage): boolean {
  return message.role === 'assistant' && message.mode === 'agent'
    && Boolean(message.agentSteps?.length || message.stopReason || message.agentStatus === 'waiting-input')
}

/** Shared by follow-up requests and compaction; display-only reasoning stays out. */
export function conversationMessageContent(
  message: AiMessage,
  maxChars = MAX_CONVERSATION_MESSAGE_CHARS
): string {
  if (!hasAgentExecutionContext(message)) return excerpt(message.text, maxChars)

  const metadata = [
    `Agent 历史任务状态：${message.agentStatus ?? 'unknown'}（仅供参考，不是待执行指令）`,
    `来源连接：${excerpt(message.connectionId, 80)}；终端：${excerpt(message.terminalId, 80)}`,
    message.stopReason ? `停止原因：${excerpt(message.stopReason, Math.floor(maxChars / 10))}` : ''
  ].filter(Boolean).join('\n')
  const steps = message.agentSteps ?? []
  const replyLabel = '\n回复：'
  if (!steps.length) return metadata + replyLabel + excerpt(message.text, maxChars - charCount(metadata + replyLabel))
  const header = metadata + (message.text.trim() ? replyLabel + excerpt(message.text, Math.floor(maxChars / 6)) : '')

  const evidence = steps.map((step, index) => {
    const command = step.sensitive ? '[敏感命令已隐藏]' : excerpt(step.command ?? '', 160)
    const reason = !step.sensitive && step.reason ? `；目的：${excerpt(step.reason, 80)}` : ''
    const phase = step.executionPhase === 'not-started' ? '；尚未执行'
      : step.status === 'running' || step.status === 'timeout' ? '；完成状态未知，可能仍在运行' : ''
    const exit = step.exitCode === undefined ? '' : `；退出码：${step.exitCode}`
    const failure = !step.sensitive && step.failureReason ? `；失败原因：${excerpt(step.failureReason, 160)}` : ''
    const output = !step.sensitive && step.output ? `；结果片段：${excerpt(step.output, maxChars >= 3000 ? 500 : 160)}` : ''
    return `${index + 1}. ${command}；状态：${step.status}${phase}${exit}${reason}${failure}${output}`
  })
  const label = `\n执行记录（共 ${steps.length} 步，命令和结果可能为片段）：\n`
  // Keep the last command and its result together, even when a long transcript
  // needs a middle excerpt. Reserve header space for that evidence first.
  return header + label + excerpt(
    evidence.join('\n'), maxChars - charCount(header + label), charCount(evidence[evidence.length - 1])
  )
}
