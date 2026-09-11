export function parseAiTimeoutSeconds(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0
  const seconds = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 4_294_967_295) {
    throw new Error('请求超时必须为 0 或有效的正整数（秒）。')
  }
  return seconds
}
