import assert from 'node:assert/strict'
import test from 'node:test'
import { agentDisplayTimeline, agentPresentationTimeline } from '../../src/domains/ai/domain/agentTimeline'

const tool = (id, values = {}) => ({ id, status: 'completed', exitCode: 0, command: 'pwd', risks: [], sensitive: false, ...values })
const thought = (id, text) => ({ id, kind: 'thinking', text, reasoning: `reasoning-${id}` })
const entry = stepId => ({ kind: 'tool', id: `tool-${stepId}`, stepId })
const flatten = entries => entries.flatMap(item => item.kind === 'completed-group' ? item.entries : [item])

test('完成步骤收纳时完整保留解释、思考与执行的时间顺序，不修改持久化记录', () => {
  const message = { agentSteps: [tool('one'), tool('two'), tool('three', { status: 'running', exitCode: undefined })], agentTimeline: [thought('a', '先检查'), entry('one'), thought('b', '继续检查'), entry('two'), thought('c', '正在定位'), entry('three')] }
  const original = structuredClone(message)
  const presentation = agentPresentationTimeline(message)
  assert.equal(presentation[0].kind, 'completed-group')
  assert.equal(presentation[0].steps.length, 2)
  assert.equal(presentation[1].kind, 'thinking')
  assert.equal(presentation.at(-1).step.id, 'three')
  assert.deepEqual(flatten(presentation), agentDisplayTimeline(message))
  assert.deepEqual(message, original)
})

test('异常、未执行、超时、跳过与正在执行的步骤不会被完成分组隐藏', () => {
  for (const values of [{ status: 'failed' }, { exitCode: 2 }, { status: 'pending', exitCode: undefined }, { status: 'running', exitCode: undefined }, { status: 'timeout' }, { status: 'skipped' }]) {
    const message = { agentSteps: [tool('a'), tool('b'), tool('attention', values), tool('c'), tool('d')] }
    const result = agentPresentationTimeline(message)
    assert.deepEqual(result.map(item => item.kind), ['completed-group', 'tool', 'completed-group'])
    assert.equal(result[1].step.id, 'attention')
    assert.deepEqual(flatten(result), agentDisplayTimeline(message))
  }
})

test('独立完成步骤和正在生成的后续说明保持直接可读，新增完成步骤保留分组标识', () => {
  const single = { agentSteps: [tool('a')] }
  assert.deepEqual(agentPresentationTimeline(single), agentDisplayTimeline(single))
  const message = { agentSteps: [tool('a'), tool('b')], agentTimeline: [entry('a'), entry('b'), thought('next', '后续说明')] }
  const before = agentPresentationTimeline(message)
  assert.equal(before.at(-1).text, '后续说明')
  message.agentSteps.push(tool('c'))
  message.agentTimeline.push(entry('c'))
  const after = agentPresentationTimeline(message)
  assert.equal(after[0].id, before[0].id)
  assert.equal(after[0].steps.length, 3)
  assert.deepEqual(flatten(after), agentDisplayTimeline(message))
})

test('旧版记录、缺失步骤引用与空记录仍可显示', () => {
  for (const message of [{}, { agentReasoning: '旧版思考', agentSteps: [tool('a'), tool('b')] }, { agentTimeline: [entry('missing'), thought('a', '仍需显示')], agentSteps: [] }]) {
    assert.deepEqual(flatten(agentPresentationTimeline(message)), agentDisplayTimeline(message))
  }
})
