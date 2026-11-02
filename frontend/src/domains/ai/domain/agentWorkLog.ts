import type { AiMessage } from './conversation'
import { agentDisplayTimeline } from './agentTimeline'
import { normalizeAiDuration } from './aiTiming'

export function hasCompletedAgentWork(message: AiMessage): boolean {
  return message.mode === 'agent' && message.agentStatus === 'done' && !message.streaming && !message.error && agentDisplayTimeline(message).length > 0
}

export function agentWorkedLabel(message: AiMessage): string {
  const seconds = normalizeAiDuration(message.durationSeconds)
  if (seconds === undefined) return 'Worked'
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total % 3600 / 60)
  const remainder = total % 60
  return `Worked for ${[hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', remainder || (!hours && !minutes) ? `${remainder}s` : ''].filter(Boolean).join(' ')}`
}
