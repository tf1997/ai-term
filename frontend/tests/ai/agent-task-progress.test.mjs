import assert from 'node:assert/strict'
import test from 'node:test'
import { runAgentTask } from '../../src/domains/ai/application/agent/agentLoop'
import { updateAgentPlan, recordAgentVerification, agentTaskOutcome, agentPlanProgress, invalidateAgentVerifications, persistableVerifications, agentTaskContext } from '../../src/domains/ai/domain/agentTaskProgress'
import { hydrateAiMessagePayload } from '../../src/domains/ai/domain/workspaceSessions'
import { conversationMessageContent } from '../../src/domains/ai/domain/conversationContext'

const step = (id, overrides = {}) => ({ id, command: 'check service', reason: '实际检查', risks: [], sensitive: false, autoApproved: true, status: 'completed', executionPhase: 'finished', output: 'HTTP 200\nhealthy', outputTruncated: false, exitCode: 0, ...overrides })
const verification = (id, kind = 'output-contains', expected = 'HTTP 200', stepId = 'health') => JSON.stringify({ id, purpose: '验证服务响应', required: true, check: { kind, expected, ...(stepId ? { stepId } : {}) } })
const plan = (version, status, stepIds = []) => JSON.stringify({ expectedVersion: version, reason: '根据现场结果更新', items: [{ id: 'inspect', description: '检查服务', status, stepIds }] })
const tool = (id, name, args) => ({ id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) })
const response = calls => ({ text: calls.length ? '' : '模型已结束回复', toolCalls: calls, contextCompressed: false, contextChars: 0 })

test('zero reload exit followed by failed health response reports verification failure, even when model finishes', async () => {
  const replies = [
    [tool('plan-1', 'update_plan', plan(0, 'in-progress'))],
    [tool('declare', 'record_verification', verification('http', 'output-contains', 'HTTP 200', null))],
    [tool('reload', 'run_command', { command: 'reload service' }), tool('health', 'run_command', { command: 'check health' })],
    [tool('exit', 'record_verification', verification('reload-exit', 'exit-code', '0', 'reload')), tool('http', 'record_verification', verification('http'))],
    [tool('plan-2', 'update_plan', plan(1, 'completed', ['health']))], []
  ]
  const contexts = [], commands = []
  const task = runAgentTask('重载并确认健康', {
    callModel: async (_turns, _signal, context) => { contexts.push(JSON.parse(context)); return response(replies.shift()) },
    startCommand: command => { commands.push(command); return { result: Promise.resolve({ status: 'completed', exitCode: 0, output: command.startsWith('reload') ? 'reloaded' : 'HTTP 503\nunhealthy', durationMs: 5, truncated: false }), peekOutput: () => '', cancel() {} } },
    classifyStep: () => ({ risks: [], sensitive: false, autoExec: { eligible: true, suggestedPatterns: [] } }),
    requestApproval: async () => 'execute', requestTimeoutDecision: async () => 'stop', onAllowPattern() {}, onStateChange() {}
  })
  const state = await task.done
  assert.equal(state.status, 'done', state.error)
  assert.equal(state.outcome, 'verification-failed')
  assert.deepEqual(state.verifications.map(item => item.status), ['passed', 'failed'])
  assert.deepEqual(commands, ['reload service', 'check health'])
  assert.equal(contexts.at(-1).plan.version, 2)
  assert.equal(contexts[2].verifications[0].status, 'pending')
  assert.equal(contexts.at(-1).verifications.find(item => item.id === 'http').status, 'failed')
})

test('no checks or only process exit checks cannot mark the task verified', () => {
  assert.equal(agentTaskOutcome(undefined, []), 'unverified')
  const checks = recordAgentVerification(verification('exit', 'exit-code', '0'), [], [step('health')])
  assert.equal(checks[0].status, 'passed')
  assert.equal(agentTaskOutcome(undefined, checks), 'unverified')
  const verified = recordAgentVerification(verification('http'), checks, [step('health')])
  assert.equal(agentTaskOutcome(undefined, verified), 'verified')
})
test('unfinished required checks report partial progress and optional failures do not replace necessary results', () => {
  const checks = recordAgentVerification(verification('http'), [], [step('health')])
  const pending = recordAgentVerification(verification('other', 'output-contains', 'OK', null), checks, [step('health')])
  assert.equal(agentTaskOutcome(undefined, pending), 'partial')
  const optional = JSON.parse(verification('extra', 'output-contains', 'optional missing')); optional.required = false
  const withOptional = recordAgentVerification(JSON.stringify(optional), checks, [step('health')])
  assert.equal(withOptional[1].status, 'failed')
  assert.equal(agentTaskOutcome(undefined, withOptional), 'verified')
})

test('invented evidence and incomplete plans cannot become completed or verified', () => {
  assert.throws(() => updateAgentPlan(plan(0, 'completed', ['imaginary']), undefined, []), /不存在/)
  assert.throws(() => updateAgentPlan(plan(0, 'completed'), undefined, []), /实际步骤/)
  assert.throws(() => updateAgentPlan(plan(0, 'completed', ['unknown']), undefined, [step('unknown', { exitCode: undefined })]), /实际步骤/)
  assert.throws(() => updateAgentPlan(plan(0, 'completed', ['partial']), undefined, [step('partial', { toolName: 'apply_patch', fileEdits: [{ status: 'applied' }, { status: 'unknown' }] })]), /实际步骤/)
  const current = updateAgentPlan(plan(0, 'in-progress'), undefined, [])
  assert.throws(() => updateAgentPlan(plan(0, 'completed', ['health']), current, [step('health')]), /版本/)
  const changedId = JSON.parse(plan(1, 'pending')); changedId.items[0].id = 'new'
  assert.throws(() => updateAgentPlan(JSON.stringify(changedId), current, []), /保留/)
  assert.throws(() => recordAgentVerification(verification('missing', 'output-contains', '200', 'no-step'), [], []), /不存在/)
  const checks = recordAgentVerification(verification('http'), [], [step('health')])
  assert.equal(agentTaskOutcome(current, checks), 'unverified')
})

test('truncated or changing evidence stays unknown when absence cannot be established', () => {
  const partial = recordAgentVerification(verification('http'), [], [step('health', { output: 'partial', outputTruncated: true })])
  assert.equal(partial[0].status, 'unavailable')
  const unknownExit = recordAgentVerification(verification('http'), [], [step('health', { exitCode: undefined })])
  assert.equal(unknownExit[0].status, 'unavailable')
  const file = step('file', { toolName: 'read_file', fileResult: { tool: 'read_file', content: 'enabled=true', complete: true, changedDuringRead: true }, exitCode: undefined })
  assert.equal(recordAgentVerification(verification('file', 'file-contains', 'enabled=true', 'file'), [], [file])[0].status, 'unavailable')
})

test('cancelled and skipped arrangements leave the remaining queue without becoming completed evidence or waiving required checks', () => {
  const steps = [step('health')]
  const current = updateAgentPlan(JSON.stringify({ expectedVersion: 0, reason: '现场已确认配置正确；取消修改，跳过重载', items: [
    { id: 'inspect', description: '检查当前响应', status: 'completed', stepIds: ['health'] },
    { id: 'edit', description: '修改配置', status: 'cancelled', stepIds: [] },
    { id: 'reload', description: '重载服务', status: 'skipped', stepIds: [] }
  ] }), undefined, steps)
  assert.deepEqual(agentPlanProgress(current), { completed: 1, remaining: 0, cancelled: 1, skipped: 1 })
  assert.equal(agentTaskOutcome(current, []), 'unverified')
  const checks = recordAgentVerification(verification('http'), [], steps)
  assert.equal(agentTaskOutcome(current, checks), 'verified')
  const pending = recordAgentVerification(verification('missing', 'output-contains', 'OK', null), checks, steps)
  assert.equal(agentTaskOutcome(current, pending), 'partial')
  for (const status of ['pending', 'in-progress', 'waiting', 'failed']) {
    const changed = { ...current, items: current.items.map(item => item.id === 'edit' ? { ...item, status } : item) }
    assert.equal(agentPlanProgress(changed).remaining, 1, status)
    assert.equal(agentTaskOutcome(changed, checks), 'partial', status)
  }
  const reopened = hydrateAiMessagePayload({ text: '无需修改', payloadJson: JSON.stringify({ mode: 'agent', agentStatus: 'done', agentSteps: steps, agentPlan: current, agentVerifications: checks }) })
  assert.equal(reopened.agentOutcome, 'verified')
  assert.equal(JSON.parse(agentTaskContext(reopened.agentPlan, checks)).plan.items[1].status, 'cancelled')
})

test('new writes invalidate earlier observations and stale evidence cannot be reassigned as fresh', () => {
  const checked = step('health')
  const checks = recordAgentVerification(verification('http'), [], [checked])
  const write = step('write', { command: 'replace config', risks: [{ severity: 'high' }], autoApproved: false })
  const stale = invalidateAgentVerifications(checks, [checked, write])
  assert.equal(stale[0].status, 'unavailable')
  assert.equal(recordAgentVerification(verification('http'), stale, [checked, write])[0].status, 'unavailable')
  const fresh = step('health-new')
  assert.equal(recordAgentVerification(verification('http', 'output-contains', 'HTTP 200', 'health-new'), stale, [checked, write, fresh])[0].status, 'passed')
})

test('expected output remains literal, sensitive evidence is excluded from saved progress', () => {
  const steps = [step('health', { output: 'HTTP 200', sensitive: true })]
  assert.equal(recordAgentVerification(verification('http', 'output-contains', 'HTTP 200\n'), [], steps)[0].status, 'failed')
  const secretSteps = [step('health', { output: 'PRIVATE_FIXTURE_TOKEN', sensitive: true })]
  const check = recordAgentVerification(verification('secret', 'output-contains', 'PRIVATE_FIXTURE_TOKEN'), [], secretSteps)
  const persisted = persistableVerifications(check, secretSteps)
  assert.equal(JSON.stringify(persisted).includes('PRIVATE_FIXTURE_TOKEN'), false)
  assert.equal(check[0].status, 'passed')
})

test('plan and verification history survive reopening and enter follow-up context, without changing old records', () => {
  const steps = [step('health')]
  const current = updateAgentPlan(plan(0, 'completed', ['health']), undefined, steps)
  const checks = recordAgentVerification(verification('http'), [], steps)
  const message = hydrateAiMessagePayload({ id: 'message', role: 'assistant', text: 'done', connectionId: 'connection', terminalId: 'terminal', payloadJson: JSON.stringify({ mode: 'agent', agentStatus: 'done', agentSteps: steps, agentPlan: current, agentVerifications: checks }) })
  assert.equal(message.agentOutcome, 'verified')
  assert.equal(message.agentPlan.items[0].stepIds[0], 'health')
  assert.match(conversationMessageContent(message), /计划版本 1/)
  assert.match(conversationMessageContent(message), /验证 http：passed/)
  const context = JSON.parse(agentTaskContext(current, checks))
  assert.equal(context.verifications[0].check.stepId, 'health')
  const old = hydrateAiMessagePayload({ text: 'old', payloadJson: JSON.stringify({ mode: 'agent', agentSteps: [] }) })
  assert.equal(old.agentPlan, undefined)
  assert.equal(old.agentOutcome, undefined)
})
test('escaped long verification criteria stay within the model summary budget without losing statuses or evidence IDs', () => {
  const checks = Array.from({ length: 12 }, (_, index) => ({ id: `v${index}`, purpose: 'long check', required: true, check: { kind: 'output-contains', expected: '\u0001'.repeat(500), stepId: `step${index}` }, status: 'unavailable', actual: '\u0001'.repeat(700), observedAt: 1 }))
  const current = { version: 3, reason: '根据用户已确认的目标继续', changes: [], items: [{ id: 'confirmed', description: '确认目标', status: 'completed', stepIds: ['older', 'first', 'second'], userConfirmation: { messageId: 'reply-1', confirmedAt: 123 } }] }
  const summary = agentTaskContext(current, checks)
  assert.ok(summary.length <= 18000)
  const parsed = JSON.parse(summary)
  assert.equal(parsed.contextCompacted, true)
  assert.equal(parsed.verifications.length, 12)
  assert.equal(parsed.verifications[11].stepId, 'step11')
  assert.equal(parsed.verifications[11].status, 'unavailable')
  assert.deepEqual(parsed.plan.items[0].stepIds, ['first', 'second'])
  assert.equal(parsed.plan.items[0].userConfirmation.messageId, 'reply-1')
  assert.equal(parsed.plan.reasonExcerpt, current.reason)
})

test('only an existing user confirmation for the same item and description supports completion without execution', () => {
  const raw = JSON.parse(plan(0, 'completed'))
  raw.items[0].userConfirmation = { messageId: 'invented', confirmedAt: 123 }
  assert.throws(() => updateAgentPlan(JSON.stringify(raw), undefined, []), /实际步骤或已记录的用户确认/)
  const confirmation = { messageId: 'actual-reply', confirmedAt: 123 }
  const previous = { version: 1, reason: '用户确认', changes: [], items: [{ id: 'inspect', description: '检查服务', status: 'completed', stepIds: [], userConfirmation: confirmation }] }
  const updated = updateAgentPlan(plan(1, 'completed'), previous, [])
  assert.deepEqual(updated.items[0].userConfirmation, confirmation)
  assert.equal(agentTaskOutcome(updated, []), 'unverified', 'user statement is not a passed health check')
  const different = JSON.parse(plan(1, 'completed')); different.items[0].description = '重载其他服务'
  assert.throws(() => updateAgentPlan(JSON.stringify(different), previous, []), /已记录的用户确认/)
  const waiting = updateAgentPlan(JSON.stringify({ ...different, items: [{ ...different.items[0], status: 'waiting' }] }), previous, [])
  assert.equal(waiting.items[0].userConfirmation, undefined)
  const reopened = hydrateAiMessagePayload({ id: 'answer', role: 'assistant', connectionId: 'connection', terminalId: 'terminal', text: '用户确认', payloadJson: JSON.stringify({ mode: 'agent', agentStatus: 'done', agentSteps: [], agentPlan: updated }) })
  assert.deepEqual(reopened.agentPlan.items[0].userConfirmation, confirmation)
  assert.match(conversationMessageContent(reopened), /用户确认，回复 actual-reply；不代表应用执行或现场验证/)
})

test('evidence identifiers that exceed the combined context budget stop serialization rather than losing references', () => {
  const current = { version: 1, reason: 'large references', changes: [], items: Array.from({ length: 12 }, (_, n) => ({
    id: String(n).padEnd(80, '"'), description: 'large reference item', status: 'completed',
    stepIds: [String(n).padEnd(256, '"'), String(n + 12).padEnd(256, '"')], userConfirmation: { messageId: String(n).padEnd(256, '"'), confirmedAt: 123 }
  })) }
  const before = structuredClone(current)
  assert.throws(() => agentTaskContext(current, []), /证据引用超过上下文预算/)
  assert.deepEqual(current, before)
})
