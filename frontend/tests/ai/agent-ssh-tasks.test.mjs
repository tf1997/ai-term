import assert from 'node:assert/strict'
import test from 'node:test'
import { runAgentTask } from '../../src/domains/ai/application/agent/agentLoop'
import { parseSshTaskArguments, sensitiveSshTask, sshTaskModelResult } from '../../src/domains/ai/domain/agentSshTasks'
import { hydrateAiMessagePayload } from '../../src/domains/ai/domain/workspaceSessions'
import { request, intent, snapshot, deferred, tick } from '../terminal/ssh-task-fixture.mjs'
const call = { id: 'ssh', name: 'run_ssh_task', arguments: JSON.stringify({ ...request, reason: '检查登录环境' }) }
const response = toolCalls => ({ text: toolCalls.length ? '' : 'finished', toolCalls, contextCompressed: false, contextChars: 0 })
function fixture(overrides = {}) {
  let model = 0
  const events = [], turns = []
  return { events, turns, deps: {
    callModel: async history => { turns.push(structuredClone(history)); return response(model++ ? [] : [call]) },
    startCommand() { throw Error('independent SSH task reached PTY') }, classifyStep() { throw Error('independent SSH task reached PTY policy') },
    prepareSshTask: async () => { events.push('prepare'); return intent },
    approveSshTask: async () => { events.push('approve') },
    startSshTask: async (_intent, update) => { events.push('start'); update(snapshot); return { result: Promise.resolve(snapshot), cancel() { events.push('stop') } } },
    cancelSshTask: async () => { events.push('cancel') },
    requestApproval: async proposal => { events.push('review'); assert.deepEqual(proposal.sshTarget, intent.target); return 'execute' },
    requestTimeoutDecision: async () => 'stop', onAllowPattern() { throw Error('SSH grant persisted') }, onStateChange() {}, ...overrides
  } }
}
test('independent task always reviews its login target then returns separate streams and exit evidence', async () => {
  const f = fixture()
  const state = await runAgentTask('SSH task', f.deps).done
  assert.equal(state.status, 'done', state.error)
  assert.deepEqual(f.events, ['prepare', 'review', 'approve', 'start', 'cancel'])
  assert.equal(state.steps[0].exitCode, 7)
  assert.equal(state.steps[0].sshResult.stderr, 'diagnostic')
  assert.equal(state.steps[0].sshResult.reference, undefined)
  const result = JSON.parse(f.turns[1].find(turn => turn.kind === 'toolResult').content)
  assert.equal(result.target.user, 'deploy')
  assert.equal(result.exitEvidence, 'shell-trailer-and-channel-close')
})
test('unknown dispatched task ends the run and retry does not dispatch it again', async () => {
  const f = fixture({ startSshTask: async () => ({ result: Promise.resolve({ ...snapshot, status: 'unknown', exitCode: null, exitEvidence: null, reason: 'connection lost' }), cancel() {} }) })
  const state = await runAgentTask('SSH task', f.deps).done
  assert.equal(state.status, 'error')
  assert.equal(f.turns.length, 1)
  const retry = await runAgentTask('SSH task', f.deps, { retryStep: state.steps[0] }).done
  assert.equal(retry.status, 'error')
  assert.match(retry.error, /不能重放/)
  assert.equal(f.events.filter(x => x === 'prepare').length, 1)
})
test('stopping while approval is pending never dispatches after a late approval', async () => {
  const decision = deferred()
  const f = fixture({ requestApproval: () => decision.promise })
  const task = runAgentTask('SSH task', f.deps)
  await tick(); task.stop(); decision.resolve('execute')
  assert.equal((await task.done).status, 'stopped')
  await tick()
  assert.equal(f.events.includes('start'), false)
  assert.equal(f.events.includes('approve'), false)
})
test('stopping a running task wins over an immediately resolved cancellation result', async () => {
  const running = deferred()
  let cancellations = 0
  const f = fixture({ startSshTask: async () => ({ result: running.promise, cancel() { cancellations++; running.resolve({ ...snapshot, status: 'unknown', exitCode: null }) } }) })
  const task = runAgentTask('SSH task', f.deps)
  await tick(); task.stop()
  const state = await task.done
  assert.equal(state.status, 'stopped')
  assert.equal(cancellations, 1)
  assert.match(state.stopReason, /远端/)
})
test('approval failure, skip and denied analysis never dispatch or use terminal fallback', async () => {
  for (const override of [
    { approveSshTask: async () => { throw Error('expired') } },
    { requestApproval: async () => 'skip' },
    { prepareSshTask: async () => ({ ...intent, analysis: { ...intent.analysis, decision: 'deny' } }) }
  ]) {
    const f = fixture(override)
    await runAgentTask('SSH task', f.deps).done
    assert.equal(f.events.includes('start'), false)
  }
})
test('task arguments remain literal, reject executable routing overrides, and bound model output independently', () => {
  const parsed = parseSshTaskArguments(JSON.stringify({ ...request, environment: { VALUE: "literal ' $(must-not-execute)" } }))
  assert.equal(parsed.request.environment.VALUE, "literal ' $(must-not-execute)")
  assert.equal(sensitiveSshTask(parsed.request), true)
  assert.throws(() => parseSshTaskArguments(JSON.stringify({ ...request, host: 'other' })))
  const output = JSON.parse(sshTaskModelResult({ ...snapshot, stdout: 'x'.repeat(64000), stderr: 'y'.repeat(10000) }))
  assert.equal(output.stdout.length, 4000)
  assert.equal(output.stderr.length, 4000)
  assert.equal(output.contextTruncated, true)
})
test('new SSH history retains task target and output while old command records remain compatible', async () => {
  const state = await runAgentTask('SSH task', fixture().deps).done
  const hydrated = hydrateAiMessagePayload({ text: '', payloadJson: JSON.stringify({ mode: 'agent', agentStatus: 'done', agentSteps: [...state.steps, { id: 'old', command: 'pwd', reason: '', risks: [], sensitive: false, status: 'completed' }] }) })
  assert.deepEqual(hydrated.agentSteps[0].sshTarget, intent.target)
  assert.equal(hydrated.agentSteps[1].executionPhase, 'finished')
})
