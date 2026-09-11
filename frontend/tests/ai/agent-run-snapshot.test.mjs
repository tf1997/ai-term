import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentRunSnapshot } from "../../src/domains/ai/agent/agentRunSnapshot"

test('Agent 运行快照不受后续标签和配置变化影响', () => {
  const input = {
    config: { id: 'config-1', model: 'model-a', baseUrl: 'https://a.example/v1' },
    apiKey: 'key-a',
    terminalSnapshot: 'terminal-a',
    commandHistory: ['df -h'],
    conversationMessages: [{ role: 'user', content: '检查磁盘' }],
    conversationSummary: 'summary-a',
    allowlistPatterns: ['df'],
    builtinReadonlyEnabled: true
  }
  const snapshot = createAgentRunSnapshot(input)

  input.config.model = 'model-b'
  input.commandHistory.push('rm -rf /tmp/example')
  input.conversationMessages[0].content = '另一个会话'
  input.allowlistPatterns.push('rm')

  assert.equal(snapshot.config.model, 'model-a')
  assert.deepEqual(snapshot.commandHistory, ['df -h'])
  assert.deepEqual(snapshot.conversationMessages, [{ role: 'user', content: '检查磁盘' }])
  assert.deepEqual(snapshot.allowlistPatterns, ['df'])
})
