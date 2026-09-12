// Token 用量:与后端 domain/ai/usage.rs 的 AiTokenUsage 一一对应。
// 只记录网关实际上报的计数;缺省字段表示没有上报,不估算成 0。

export interface AiTokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedInputTokens?: number
  reasoningTokens?: number
}

/** 一条消息累计的用量。Agent 任务会把每轮模型请求相加,chat 通常只有一次请求。 */
export interface AiMessageUsage extends AiTokenUsage {
  /** 上报了用量的模型请求次数;比实际轮次少说明网关只对部分请求返回了 usage。 */
  requests: number
}

// 顺序即展示顺序:输入(含缓存命中)→ 输出(含推理)→ 合计
const USAGE_FIELDS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens'] as const

type UsageField = (typeof USAGE_FIELDS)[number]

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function hasAnyCount(usage: AiTokenUsage): boolean {
  return USAGE_FIELDS.some((field) => isCount(usage[field]))
}

/** 把两份累计用量相加;任一侧缺省的字段按另一侧计,双方都缺省则继续缺省。 */
export function mergeMessageUsage(
  left: AiMessageUsage | undefined,
  right: AiMessageUsage | undefined
): AiMessageUsage | undefined {
  if (!left) return right
  if (!right) return left
  const merged: AiMessageUsage = { requests: left.requests + right.requests }
  for (const field of USAGE_FIELDS) {
    const a = left[field]
    const b = right[field]
    if (isCount(a) || isCount(b)) merged[field] = (isCount(a) ? a : 0) + (isCount(b) ? b : 0)
  }
  return merged
}

/** 把一次模型请求上报的用量计入累计;没有任何计数的上报不算一次请求。 */
export function addTokenUsage(
  total: AiMessageUsage | undefined,
  next: AiTokenUsage | undefined
): AiMessageUsage | undefined {
  if (!next || !hasAnyCount(next)) return total
  return mergeMessageUsage(total, { ...pickCounts(next), requests: 1 })
}

function pickCounts(usage: AiTokenUsage): AiTokenUsage {
  const picked: AiTokenUsage = {}
  for (const field of USAGE_FIELDS) {
    const value = usage[field]
    if (isCount(value)) picked[field] = value
  }
  return picked
}

/** 从持久化 payload 还原用量;字段不合法就整体丢弃,不修补。 */
export function normalizeMessageUsage(value: unknown): AiMessageUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (!isCount(record.requests) || record.requests < 1) return undefined
  const counts = pickCounts(record as AiTokenUsage)
  if (!hasAnyCount(counts)) return undefined
  return { ...counts, requests: record.requests }
}

export function formatTokenCount(count: number): string {
  return Math.max(0, Math.floor(count)).toLocaleString('zh-CN')
}

const FIELD_LABELS: Record<UsageField, string> = {
  inputTokens: '输入',
  cachedInputTokens: '缓存命中',
  outputTokens: '输出',
  reasoningTokens: '推理',
  totalTokens: '合计'
}

/** 单行摘要:优先展示输入/输出,只有合计时展示合计。 */
export function formatMessageUsageLabel(usage: AiMessageUsage): string {
  const parts: string[] = []
  if (isCount(usage.inputTokens)) {
    const cached = isCount(usage.cachedInputTokens) && usage.cachedInputTokens > 0
      ? `（缓存 ${formatTokenCount(usage.cachedInputTokens)}）`
      : ''
    parts.push(`输入 ${formatTokenCount(usage.inputTokens)}${cached}`)
  }
  if (isCount(usage.outputTokens)) parts.push(`输出 ${formatTokenCount(usage.outputTokens)}`)
  if (parts.length === 0 && isCount(usage.totalTokens)) parts.push(`合计 ${formatTokenCount(usage.totalTokens)}`)
  return parts.join(' · ')
}

/** 悬停详情:逐字段列出,并说明累计了几次模型请求。 */
export function formatMessageUsageTitle(usage: AiMessageUsage): string {
  const lines = USAGE_FIELDS
    .filter((field) => isCount(usage[field]))
    .map((field) => `${FIELD_LABELS[field]}：${formatTokenCount(usage[field] as number)} tokens`)
  lines.push(`模型请求：${usage.requests} 次（仅统计网关上报了用量的请求）`)
  return lines.join('\n')
}
