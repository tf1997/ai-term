import assert from 'node:assert/strict'
import test from 'node:test'
import { agentWorkedLabel, hasCompletedAgentWork } from '../../src/domains/ai/domain/agentWorkLog'

const done = { mode: 'agent', agentStatus: 'done', agentSteps: [{ id: 'step', status: 'completed', command: 'pwd' }] }

test('整次任务仅在完成后折叠，进行中、待回复、异常和停止记录保持可见', () => {
  assert.equal(hasCompletedAgentWork(done), true)
  for (const override of [{ agentStatus: 'running' }, { agentStatus: 'waiting-input' }, { agentStatus: 'error' }, { agentStatus: 'stopped' }, { streaming: true }, { error: true }, { mode: 'chat' }]) {
    assert.equal(hasCompletedAgentWork({ ...done, ...override }), false)
  }
  assert.equal(hasCompletedAgentWork({ ...done, agentSteps: [] }), false)
  assert.equal(hasCompletedAgentWork({ ...done, agentSteps: [], agentReasoning: '旧思考记录' }), true)
  assert.equal(hasCompletedAgentWork({ ...done, agentSteps: [], agentTimeline: [{ id: 'thought', kind: 'thinking', reasoning: '思考', text: '' }] }), true)
})

test('Worked 显示真实任务耗时，旧记录不以命令耗时冒充总耗时', () => {
  for (const [durationSeconds, expected] of [[0, '0s'], [59.9, '59s'], [60, '1m'], [263, '4m 23s'], [3600, '1h'], [3723, '1h 2m 3s']]) {
    assert.equal(agentWorkedLabel({ ...done, durationSeconds }), `Worked for ${expected}`)
  }
  for (const durationSeconds of [undefined, null, -1, Infinity, NaN, '263']) {
    assert.equal(agentWorkedLabel({ ...done, durationSeconds, agentSteps: [{ durationMs: 15000 }] }), 'Worked')
  }
})
