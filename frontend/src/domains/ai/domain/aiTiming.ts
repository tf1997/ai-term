import type { AiMessage } from './conversation'

export function normalizeAiDuration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function formatAiDuration(seconds: number) {
  const safeSeconds = Math.floor(normalizeAiDuration(seconds) ?? 0)
  if (safeSeconds < 60) return `${safeSeconds} 秒`
  const minutes = Math.floor(safeSeconds / 60)
  const remainder = safeSeconds % 60
  if (minutes < 60) return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ''}${remainder ? ` ${remainder} 秒` : ''}`
}

/** Keep timing alongside usage, Agent steps and partial replies in the existing payload. */
export function withAiMessageDuration(message: AiMessage, durationSeconds: number): AiMessage {
  let payload: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(message.payloadJson || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>
  } catch {
    // Older malformed payloads must not prevent a completed reply from being saved.
  }
  return {
    ...message,
    durationSeconds,
    payloadJson: JSON.stringify({ ...payload, durationSeconds })
  }
}
