import type { AiMessage } from '../types/workspace'

function messagePayload(message: AiMessage): Record<string, unknown> {
  try {
    const payload: unknown = JSON.parse(message.payloadJson || '{}')
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

export function createAiStreamErrorMessage(message: AiMessage, detail: string, partialText: string): AiMessage {
  const payload = messagePayload(message)
  if (partialText.trim()) payload.partialText = partialText
  else delete payload.partialText
  return {
    ...message,
    text: detail,
    command: '',
    error: true,
    streaming: false,
    payloadJson: Object.keys(payload).length ? JSON.stringify(payload) : undefined
  }
}

export function aiStreamPartialText(message: AiMessage): string {
  if (!message.error) return ''
  const partialText = messagePayload(message).partialText
  return typeof partialText === 'string' ? partialText : ''
}
