import type { AiMessage } from './conversation'

export const MAX_REASONING_CHARS = 12_000

export function withAiReasoning(message: AiMessage, reasoning: string): AiMessage {
  let payload: Record<string, unknown> = {}
  try {
    const value = JSON.parse(message.payloadJson || '{}')
    if (value && typeof value === 'object' && !Array.isArray(value)) payload = value
  } catch { /* Preserve display even when an old payload is malformed. */ }
  const text = reasoning.trim() ? reasoning : undefined
  if (text) payload.reasoning = text
  else delete payload.reasoning
  return { ...message, reasoning: text, payloadJson: Object.keys(payload).length ? JSON.stringify(payload) : undefined }
}
