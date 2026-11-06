import test from 'node:test'
import assert from 'node:assert/strict'
import { runAgentTask } from '../../src/domains/ai/application/agent/agentLoop'
import { agentGoalWithInputs, checkpointState, checkpointStepEffect } from '../../src/domains/ai/domain/agentCheckpoints'
import { createAgentCheckpointJournal } from '../../src/domains/ai/application/agent/agentCheckpointJournal'
import { proposal, record, id, deferred, tick } from '../transfer/file-edit-fixture.mjs'

const state = steps => ({ status: 'executing', steps, finalText: '', commandTimeoutMs: 1000 })
test('user replies preserve the original goal and question while missing or redacted saved input cannot be invented', () => {
  const inputs = [{ messageId: 'reply', question: 'A 还是 B？', text: '选择 B', redacted: false, createdAt: 1 }]
  const context = agentGoalWithInputs('部署原任务', inputs)
  assert.ok(context.startsWith('部署原任务')); assert.match(context, /A 还是 B/); assert.match(context, /选择 B/)
  const redacted = [{ ...inputs[0], text: '[敏感回复未存储]', redacted: true }]
  assert.match(agentGoalWithInputs('goal', redacted), /needsNewInput/)
  assert.match(agentGoalWithInputs('goal', redacted, { messageId: 'reply', text: 'CURRENT_PRIVATE_INPUT' }), /CURRENT_PRIVATE_INPUT/)
  assert.ok(!JSON.stringify(redacted).includes('CURRENT_PRIVATE_INPUT'))
  assert.throws(() => agentGoalWithInputs('goal', [], { messageId: 'missing', text: 'input' }), /未取得/)
})
const step = values => ({ id: 'command', command: 'fixture command', reason: 'fixture', sensitive: false, risks: [], status: 'running', executionPhase: 'dispatching', ...values })
const response = calls => ({ text: calls.length ? '' : 'done', toolCalls: calls, contextCompressed: false, contextChars: 0 })
function fixture(overrides = {}) {
  const events = [], checkpoints = []
  let model = 0
  const deps = {
    callModel: async () => response(model++ ? [] : [{ id: 'command', name: 'run_command', arguments: '{"command":"fixture command"}' }]),
    classifyStep: () => ({ risks: [], sensitive: false, autoExec: { eligible: false, suggestedPatterns: [] } }),
    requestApproval: async () => { events.push('approve'); return 'execute' },
    startCommand: () => { events.push('write'); return { result: Promise.resolve({ status: 'completed', output: 'ok', exitCode: 0, durationMs: 1, truncated: false }), peekOutput: () => '', cancel() {} } },
    checkpoint: async (value, boundary, stepId) => { events.push(boundary); checkpoints.push({ boundary, stepId, state: checkpointState(value) }) },
    requestTimeoutDecision: async () => 'stop', onAllowPattern() {}, onStateChange() {}, ...overrides
  }
  return { deps, events, checkpoints }
}

test('approved commands wait for durable intent, preserve results before another turn and save their terminal state', async () => {
  const pending = deferred(), f = fixture()
  const save = f.deps.checkpoint
  f.deps.checkpoint = async (...args) => { await save(...args); if (args[1] === 'before-dispatch') await pending.promise }
  const run = runAgentTask('fixture', f.deps)
  await tick(); assert.ok(f.events.includes('approve')); assert.ok(!f.events.includes('write'))
  assert.equal(checkpointStepEffect(f.checkpoints.at(-1).state.steps[0]), 'unknown')
  pending.resolve(); const result = await run.done
  assert.equal(result.status, 'done')
  assert.ok(f.events.indexOf('prepared') < f.events.indexOf('approve'))
  assert.ok(f.events.indexOf('before-dispatch') < f.events.indexOf('write'))
  assert.equal(f.checkpoints.at(-1).boundary, 'finished')
  assert.equal(f.checkpoints.at(-1).state.steps[0].exitCode, 0)
})

test('a failed pre-dispatch save prevents execution and does not turn the step into a retry of unknown effects', async () => {
  const f = fixture({ checkpoint: async (_state, boundary) => { if (boundary === 'before-dispatch') throw Error('database full') } })
  const result = await runAgentTask('fixture', f.deps).done
  assert.equal(result.status, 'error'); assert.match(result.error, /database full/); assert.ok(!f.events.includes('write'))
  assert.equal(result.steps[0].executionPhase, 'not-started')
})

test('stop during a checkpoint wait never dispatches a late command', async () => {
  const pending = deferred(), f = fixture({ checkpoint: async (_state, boundary) => { if (boundary === 'before-dispatch') await pending.promise } })
  const run = runAgentTask('fixture', f.deps); await tick(); run.stop()
  const result = await run.done; pending.resolve(); await tick()
  assert.equal(result.status, 'stopped'); assert.ok(!f.events.includes('write'))
})

test('result persistence failure after a file write prevents the second file and retains the first effect', async () => {
  let writes = 0
  const f = fixture({
    callModel: async () => response([{ id: 'files', name: 'write_file', arguments: JSON.stringify({ files: [1, 2].map(n => ({ baselineId: id(n), content: 'after' })) }) }]),
    prepareFileEdit: async request => proposal(Number(request.baselineId.slice(-12))), approveFileEdit: async () => {}, cancelFileEdit: async () => {},
    executeFileEdit: async p => { writes++; return record(p) },
    checkpoint: async (_state, boundary) => { if (boundary === 'result') throw Error('lost result save') }
  })
  const result = await runAgentTask('fixture', f.deps).done
  assert.equal(result.status, 'error'); assert.equal(writes, 1)
  assert.deepEqual(result.steps[0].fileEdits.map(item => item.status), ['applied', 'not-started'])
  assert.equal(checkpointStepEffect(checkpointState(result).steps[0]), 'known')
})

test('checkpoint projection excludes settings, grants, file baselines and sensitive command/file/SSH content', () => {
  const raw = state([step({ sensitive: true, command: 'PRIVATE_COMMAND', output: 'PRIVATE_OUTPUT', sshRequest: { environment: { TOKEN: 'PRIVATE_TOKEN' } }, intent: { reference: 'LIVE_APPROVAL' }, fileRequest: { tool: 'read_file', path: '/private' }, fileResult: { tool: 'read_file', content: 'PRIVATE_FILE', baselineId: 'LIVE_BASELINE', complete: true } })])
  raw.config = { apiKey: 'PRIVATE_API_KEY' }; raw.terminalSnapshot = 'PRIVATE_TERMINAL'
  const saved = checkpointState(raw)
  assert.ok(!/PRIVATE_|LIVE_/.test(JSON.stringify(saved)))
  assert.equal(checkpointStepEffect(saved.steps[0]), 'unknown')
  assert.equal(checkpointStepEffect(checkpointState(state([step({ executionPhase: 'finished', exitCode: undefined })])).steps[0]), 'unknown')
})

test('redacted history cannot become an executable retry or a new model request', async () => {
  const f = fixture({ callModel: async () => { assert.fail('redacted retry must not call model') }, startCommand: () => { assert.fail('redacted retry must not dispatch') } })
  const result = await runAgentTask('fixture', f.deps, { retryStep: step({ status: 'failed', command: '[敏感命令未存储]', commandRedacted: true }) }).done
  assert.equal(result.status, 'error'); assert.match(result.error, /已脱敏/)
})

test('journal serializes sequences, owns immutable snapshots and a lost receipt poisons subsequent writes', async () => {
  const pending = deferred(), seen = [], lease = { runId: 'run', token: 'owner', sequence: 0 }
  const api = { saveAgentCheckpoint: async (_lease, update) => { seen.push(update); if (seen.length === 1) await pending.promise; return update.expectedSequence + 1 }, releaseAgentRun: async () => {} }
  const journal = createAgentCheckpointJournal(api, lease)
  const raw = state([step()]), first = journal.save(raw, 'before-dispatch'), next = journal.save(raw, 'finished')
  raw.steps[0].command = 'changed later'; await tick(); assert.equal(seen.length, 1)
  pending.resolve(); await Promise.all([first, next]); assert.deepEqual(seen.map(value => value.expectedSequence), [0, 1]); assert.equal(seen[0].state.steps[0].command, 'fixture command')
  let saves = 0
  const failed = createAgentCheckpointJournal({ ...api, saveAgentCheckpoint: async () => { saves++; return new Promise(() => {}) } }, lease, 10)
  await assert.rejects(failed.save(raw, 'before-dispatch'), /超时/)
  await assert.rejects(failed.save(raw, 'finished'), /超时/)
  assert.equal(saves, 1); await failed.release()
})

const target = { sessionId: 'terminal', sessionInstance: 'fresh-instance', profileId: 'local', routeVersion: 0, contextVersion: 1, context: { shell: 'bash', workingDirectory: '/tmp', user: 'operator', environmentScope: 'host' } }

test('journal links an immutable live command reference only before dispatch without persisting it in task state', async () => {
  const seen = [], reference = { id: 'live-intent', operation: 'command', target: structuredClone(target), policyVersion: 'command-policy-v1' }
  const journal = createAgentCheckpointJournal({ saveAgentCheckpoint: async (_lease, update) => { seen.push(update); return update.expectedSequence + 1 }, releaseAgentRun: async () => {} }, { runId: 'run', token: 'owner', sequence: 0 })
  const raw = state([step({ sensitive: true, command: 'PRIVATE_COMMAND' })])
  const first = journal.save(raw, 'prepared', 'command', reference)
  reference.id = 'changed'; reference.target.context.user = 'changed'
  await first
  await journal.save(raw, 'result', 'command', reference)
  assert.equal(seen[0].scriptIntent.id, 'live-intent')
  assert.equal(seen[0].scriptIntent.target.context.user, 'operator')
  assert.equal(seen[1].scriptIntent, undefined)
  assert.ok(!JSON.stringify(seen[0].state).includes('live-intent'))
  assert.ok(!JSON.stringify(seen).includes('PRIVATE_COMMAND'))
})
function recoveryFixture() {
  const saved = checkpointState(state([step({ id: 'old-write', command: 'historical-write' })]))
  const recovery = { phase: 'inspecting', sourceSequence: 3, sourceStepIds: ['old-write'], requiredStepIds: ['old-write'], originalTarget: { ...target, sessionInstance: 'old-instance' }, currentTarget: target, resolutions: [] }
  return { state: saved, recovery }
}
const command = (id, value) => ({ id, name: 'run_command', arguments: JSON.stringify({ command: value }) })

test('recovery blocks writes and independent tasks, inspects fresh state, then requires fresh manual approval', async () => {
  const { recoveredAgentSteps } = await import('../../src/domains/ai/domain/agentCheckpoints')
  const record = recoveryFixture(), events = [], requests = []
  const responses = [response([{ id: 'forbidden', name: 'write_file', arguments: '{}' }]), response([command('check', 'whoami')]), response([]), response([command('new-write', 'touch /tmp/new')]), response([])]
  const f = fixture({
    callModel: async (_turns, _signal, context) => { requests.push(JSON.parse(context)); return responses.shift() },
    classifyStep: () => ({ risks: [], sensitive: false, autoExec: { eligible: true, suggestedPatterns: ['touch'] } }),
    startCommand: value => { events.push(value); return { result: Promise.resolve({ status: 'completed', exitCode: 0, output: '/tmp', truncated: false, durationMs: 1 }), peekOutput: () => '', cancel() {} } },
    requestRecoveryReview: async review => { assert.equal(review.steps[0].executionPhase, 'dispatching'); events.push('review'); return { action: 'continue', resolutions: [{ stepId: 'old-write', evidenceStepIds: ['check'], observation: '已核对当前状态' }] } },
    confirmRecovery: async resolutions => { events.push('confirm'); return { ...record.recovery, phase: 'continuing', resolutions } },
    requestApproval: async proposal => { events.push('approve'); assert.equal(proposal.command, 'touch /tmp/new'); assert.equal(proposal.suggestedPatterns, undefined); return 'execute' }
  })
  const result = await runAgentTask('original goal', f.deps, { recovery: record.recovery, initialSteps: recoveredAgentSteps(record) }).done
  assert.equal(result.status, 'done'); assert.deepEqual(events, ['whoami', 'review', 'confirm', 'approve', 'touch /tmp/new'])
  assert.equal(result.steps[0].exitCode, undefined); assert.equal(result.steps[0].executionPhase, 'dispatching')
  assert.equal(requests[0].recovery.phase, 'inspecting'); assert.equal(requests.at(-1).recovery.phase, 'continuing')
  assert.equal(requests.at(-1).recovery.resolvedEffects[0].observation, '已核对当前状态')
})

test('recovery can ask for more read-only inspection and stopping during confirmation never resumes late', async () => {
  const { recoveredAgentSteps } = await import('../../src/domains/ai/domain/agentCheckpoints')
  const record = recoveryFixture(), pending = deferred(), reviews = [], requests = []
  const f = fixture({
    callModel: async (_turns, _signal, context) => { requests.push(JSON.parse(context)); return response([]) },
    requestRecoveryReview: async review => { reviews.push(review); return reviews.length === 1 ? { action: 'inspect', note: '还需检查服务是否启动' } : { action: 'continue', resolutions: [] } },
    confirmRecovery: async () => pending.promise
  })
  const run = runAgentTask('original', f.deps, { recovery: record.recovery, initialSteps: recoveredAgentSteps(record) })
  await tick(); assert.equal(reviews.length, 2); assert.match(requests[1].recovery.userNote, /服务/)
  run.stop(); assert.equal((await run.done).status, 'stopped')
  pending.resolve({ ...record.recovery, phase: 'continuing', resolutions: [] }); await tick()
  assert.equal(requests.length, 2); assert.ok(!f.events.includes('write'))
})

test('unknown file writes trigger a fresh read before the model and preserve verified absence without restoring a baseline', async () => {
  const { recoveredAgentSteps } = await import('../../src/domains/ai/domain/agentCheckpoints')
  const record = recoveryFixture(), events = []
  record.state.steps[0].toolName = 'write_file'; record.state.steps[0].fileEdits = [{ changeId: 'old-change', path: '/tmp/file', environmentScope: 'file-scope', revision: null, status: 'unknown' }]
  const f = fixture({
    prepareFile: async request => { events.push(`read:${request.path}`); throw { kind: 'missing', message: 'missing', absence: { path: '/tmp/file', resolvedPath: '/tmp/file', environmentScope: 'file-scope', baselineId: 'ephemeral-baseline' } } },
    executeFile: async () => { throw Error('missing files have no read operation') },
    callModel: async () => { events.push('model'); return response([]) }, requestRecoveryReview: async () => ({ action: 'stop' }), confirmRecovery: async () => { throw Error('not expected') }
  })
  const result = await runAgentTask('original', f.deps, { recovery: record.recovery, initialSteps: recoveredAgentSteps(record) }).done
  assert.deepEqual(events, ['read:/tmp/file', 'model']); assert.equal(result.status, 'stopped')
  const saved = checkpointState(result); assert.equal(saved.steps[1].fileRead.absent, true)
  assert.equal(saved.steps[1].fileRead.resolvedPath, '/tmp/file'); assert.ok(!JSON.stringify(saved).includes('ephemeral-baseline'))
})

test('recovery history and progress stay within model budgets and never become executable tool arguments', async () => {
  const { recoveredAgentSteps, agentRunContext } = await import('../../src/domains/ai/domain/agentCheckpoints')
  const record = recoveryFixture()
  record.state.steps[0].command = '\u001b'.repeat(65536); record.state.steps[0].output = '\u001b'.repeat(262144)
  let history
  const f = fixture({ callModel: async turns => { history = turns; return response([]) }, requestRecoveryReview: async () => ({ action: 'stop' }), confirmRecovery: async () => {} })
  await runAgentTask('original', f.deps, { recovery: record.recovery, initialSteps: recoveredAgentSteps(record) }).done
  assert.ok(JSON.stringify(history).length < 20000); assert.equal(JSON.parse(history[0].toolCalls[0].arguments).command, undefined)
  const huge = { ...record.recovery, requiredStepIds: Array.from({ length: 1000 }, (_, n) => String(n).padEnd(256, 'x')) }
  const plan = { version: 1, reason: '\u001b'.repeat(500), items: Array.from({ length: 12 }, (_, n) => ({ id: String(n), description: '\u001b'.repeat(240), status: 'pending', stepIds: [`evidence-${n}`], userConfirmation: { messageId: `reply-${n}`, confirmedAt: 123 } })), changes: [] }
  const text = agentRunContext(plan, [], huge, Array.from({ length: 1000 }, (_, n) => ({ stepId: String(n), evidenceStepIds: ['check'], observation: '\u001b'.repeat(1000) })), '\u001b'.repeat(2000))
  assert.ok(text.length < 20000); assert.equal(JSON.parse(text).recovery.requiredCount, 1000)
  assert.deepEqual(JSON.parse(text).plan.items[11].stepIds, ['evidence-11'])
  assert.equal(JSON.parse(text).plan.items[11].userConfirmation.messageId, 'reply-11')
})

test('confirmation shares the checkpoint sequence queue with stop and a lost confirmation receipt blocks further saves', async () => {
  const pending = deferred(), seen = [], lease = { runId: 'run', token: 'owner', sequence: 4 }
  const api = {
    confirmAgentRecovery: async (_lease, _expected, sequence) => { seen.push(['confirm', sequence]); await pending.promise; return { sequence: sequence + 1 } },
    saveAgentCheckpoint: async (_lease, update) => { seen.push(['save', update.expectedSequence]); return update.expectedSequence + 1 }, releaseAgentRun: async () => {}
  }
  const journal = createAgentCheckpointJournal(api, lease)
  const confirmation = journal.confirm(target, []), stop = journal.save(state([]), 'finished')
  await tick(); assert.deepEqual(seen, [['confirm', 4]])
  pending.resolve(); await Promise.all([confirmation, stop]); assert.deepEqual(seen, [['confirm', 4], ['save', 5]])
  const failed = createAgentCheckpointJournal({ ...api, confirmAgentRecovery: async () => new Promise(() => {}) }, lease, 10)
  await assert.rejects(failed.confirm(target, []), /超时/); await assert.rejects(failed.save(state([]), 'finished'), /超时/)
  assert.equal(seen.length, 2); await failed.release()
})
