import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addTokenUsage,
  formatMessageUsageLabel,
  formatMessageUsageTitle,
  mergeMessageUsage,
  normalizeMessageUsage
} from '../../src/domains/ai/domain/tokenUsage'

test('累计用量:逐次请求相加,缺省字段不估算为 0,没有计数的上报不算一次请求', () => {
  let total = addTokenUsage(undefined, undefined)
  assert.equal(total, undefined)
  total = addTokenUsage(total, {})
  assert.equal(total, undefined)
  total = addTokenUsage(total, { inputTokens: 100, outputTokens: 10, cachedInputTokens: 60 })
  assert.deepEqual(total, { inputTokens: 100, outputTokens: 10, cachedInputTokens: 60, requests: 1 })
  total = addTokenUsage(total, { inputTokens: 150, outputTokens: 5 })
  assert.deepEqual(total, { inputTokens: 250, outputTokens: 15, cachedInputTokens: 60, requests: 2 })
  total = addTokenUsage(total, { totalTokens: 7 })
  assert.deepEqual(total, { inputTokens: 250, outputTokens: 15, cachedInputTokens: 60, totalTokens: 7, requests: 3 })
  assert.deepEqual(mergeMessageUsage(total, { requests: 2, reasoningTokens: 9 }), { ...total, reasoningTokens: 9, requests: 5 })
  assert.equal(mergeMessageUsage(undefined, undefined), undefined)
  assert.deepEqual(mergeMessageUsage(undefined, total), total)
})

test('持久化用量还原:只接受非负整数计数,非法结构整体丢弃', () => {
  assert.deepEqual(
    normalizeMessageUsage({ requests: 2, inputTokens: 5, outputTokens: 1, extra: 'x' }),
    { inputTokens: 5, outputTokens: 1, requests: 2 }
  )
  for (const bad of [
    undefined, null, 'usage', [], {},
    { requests: 0, inputTokens: 5 },
    { requests: 1 },
    { requests: 1, inputTokens: -1 },
    { requests: 1, inputTokens: 1.5 },
    { requests: '1', inputTokens: 5 }
  ]) {
    assert.equal(normalizeMessageUsage(bad), undefined)
  }
})

test('用量文案:输入(含缓存)与输出优先,只有合计时展示合计;详情按字段逐行列出', () => {
  assert.equal(
    formatMessageUsageLabel({ requests: 1, inputTokens: 12345, cachedInputTokens: 8000, outputTokens: 678 }),
    '输入 12,345（缓存 8,000） · 输出 678'
  )
  assert.equal(formatMessageUsageLabel({ requests: 1, inputTokens: 12, cachedInputTokens: 0 }), '输入 12')
  assert.equal(formatMessageUsageLabel({ requests: 3, totalTokens: 999 }), '合计 999')
  assert.equal(
    formatMessageUsageTitle({ requests: 3, inputTokens: 1, outputTokens: 2, reasoningTokens: 3, totalTokens: 6 }),
    '输入：1 tokens\n输出：2 tokens\n推理：3 tokens\n合计：6 tokens\n模型请求：3 次（仅统计网关上报了用量的请求）'
  )
})
