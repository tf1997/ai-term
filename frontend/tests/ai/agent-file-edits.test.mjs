import test from 'node:test'
import assert from 'node:assert/strict'
import { runAgentTask } from '../../src/domains/ai/application/agent/agentLoop'
import { parseFileEditArguments, persistableFileEdits } from '../../src/domains/ai/domain/agentFileEdits'
import { fileEditView } from '../../src/domains/transfer/domain/fileEdits'
import { id, proposal, record, target, tick, deferred } from '../transfer/file-edit-fixture.mjs'
const response = toolCalls => ({ text: toolCalls.length ? '' : 'done', toolCalls, contextCompressed: false, contextChars: 0 })
const call = (count = 3) => ({ id: 'edit', name: 'apply_patch', arguments: JSON.stringify({ reason: '修改配置', files: Array.from({ length: count }, (_, i) => ({ baselineId: id(i + 1), replacements: [{ oldText: 'before', newText: 'after' }] })) }) })
function fixture(overrides = {}, count = 3) {
  const events = [], turns = []
  let modelCalls = 0
  const deps = {
    callModel: async history => { turns.push(structuredClone(history)); return response(modelCalls++ ? [] : [call(count)]) },
    startCommand: () => { throw Error('edit entered general shell executor') }, classifyStep: () => { throw Error('edit entered command allowlist') },
    prepareFileEdit: async request => { const n = Number(request.baselineId.slice(-12)); events.push(`prepare-${n}`); return proposal(n) },
    approveFileEdit: async p => { events.push(`approve-${p.path}`) },
    executeFileEdit: async p => { events.push(`write-${p.path}`); return record(p) },
    cancelFileEdit: async p => { events.push(`cancel-${p.path}`) },
    requestApproval: async p => { events.push('review'); assert.equal(p.command, ''); assert.equal(p.fileEdits.length, count); assert.equal(p.suggestedPatterns, undefined); return 'execute' },
    requestTimeoutDecision: async () => 'stop', onAllowPattern: () => { throw Error('file edit created shell grant') }, onStateChange() {}, ...overrides
  }
  return { deps, events, turns, get modelCalls() { return modelCalls } }
}
test('whole batch is reviewed before any write and exact backend proposals execute sequentially', async () => {
  const f = fixture(); const state = await runAgentTask('edit', f.deps).done
  assert.equal(state.status, 'done'); assert.equal(state.steps[0].status, 'completed')
  assert.deepEqual(f.events.slice(0, 10), ['prepare-1', 'prepare-2', 'prepare-3', 'review', 'approve-/tmp/config-1', 'approve-/tmp/config-2', 'approve-/tmp/config-3', 'write-/tmp/config-1', 'write-/tmp/config-2', 'write-/tmp/config-3'])
  assert.ok(state.steps[0].fileEdits.every(item => item.status === 'applied'))
  assert.equal(state.steps[0].fileEdits[0].view.reference, undefined)
  const result = JSON.parse(f.turns[1].find(turn => turn.kind === 'toolResult').content)
  assert.equal(result.status, 'applied'); assert.equal(result.files[0].changeId, id(101)); assert.equal(result.files[0].before, undefined)
})
test('skipped diff grants nothing and does not dispatch any file', async () => {
  const f = fixture({ requestApproval: async () => 'skip' }); const state = await runAgentTask('edit', f.deps).done
  assert.equal(state.steps[0].status, 'skipped'); assert.ok(state.steps[0].fileEdits.every(item => item.status === 'skipped'))
  assert.ok(!f.events.some(event => /^(approve|write)-/.test(event)))
})
test('second-file conflict retains first success and leaves third file unstarted', async () => {
  const f = fixture({ executeFileEdit: async p => { f.events.push(`write-${p.path}`); return record(p, p.path.endsWith('2') ? 'conflict' : 'applied') } })
  const state = await runAgentTask('edit', f.deps).done
  assert.deepEqual(state.steps[0].fileEdits.map(item => item.status), ['applied', 'conflict', 'not-started'])
  assert.equal(state.steps[0].status, 'failed'); assert.ok(!f.events.includes('write-/tmp/config-3'))
  assert.equal(JSON.parse(f.turns[1].find(turn => turn.kind === 'toolResult').content).status, 'partial')
})
test('unknown write ends the run without another model turn or another file write', async () => {
  const f = fixture({ executeFileEdit: async p => record(p, p.path.endsWith('2') ? 'unknown' : 'applied') })
  const state = await runAgentTask('edit', f.deps).done
  assert.equal(state.status, 'stopped'); assert.equal(f.modelCalls, 1)
  assert.deepEqual(state.steps[0].fileEdits.map(item => item.status), ['applied', 'unknown', 'not-started'])
  let called = false
  const retry = await runAgentTask('retry', { ...f.deps, callModel: async () => { called = true; return response([]) } }, { retryStep: state.steps[0] }).done
  assert.equal(retry.status, 'error'); assert.equal(called, false)
})
test('stop during a write retains earlier effects, marks current effect unknown and ignores late success', async () => {
  const pending = deferred(); const f = fixture({ executeFileEdit: async p => p.path.endsWith('2') ? pending.promise : record(p) })
  const run = runAgentTask('edit', f.deps)
  await tick(); run.stop(); const state = await run.done
  assert.equal(state.status, 'stopped'); assert.deepEqual(state.steps[0].fileEdits.map(item => item.status), ['applied', 'unknown', 'not-started'])
  pending.resolve(record(proposal(2))); await tick()
  assert.equal(state.steps[0].fileEdits[1].status, 'unknown'); assert.equal(f.modelCalls, 1)
})
test('file writes invalidate old verification evidence', async () => {
  const initial = { id: 'checked', toolName: 'read_file', command: '', reason: 'check', risks: [], sensitive: false, status: 'completed', executionPhase: 'finished', output: 'healthy', outputTruncated: false }
  const verification = { id: 'health', purpose: 'health', required: true, check: { kind: 'output-contains', expected: 'healthy', stepId: 'checked' }, status: 'passed', actual: 'healthy', observedAt: 1 }
  const f = fixture({}, 1); const state = await runAgentTask('edit', f.deps, { initialSteps: [initial], initialVerifications: [verification] }).done
  assert.equal(state.verifications[0].status, 'unavailable'); assert.equal(state.outcome, 'unverified')
})
test('restore button workflow rereads and obtains new approval without a model decision', async () => {
  const f = fixture({
    callModel: async () => { throw Error('restore needs no model decision') },
    prepareFile: async request => ({ reference: { id: 'read', target }, request, provider: 'current-terminal', resolvedPath: '/tmp/config-1', revision: 'metadata:after', sensitive: false }),
    executeFile: async () => ({ tool: 'read_file', path: '/tmp/config-1', baselineId: id(1), content: 'after\r\n' }),
    cancelFile: async () => {},
    prepareFileEdit: async request => { assert.equal(request.changeId, id(101)); return proposal(1, { before: 'after\r\n', after: 'before\r\n', restoreOf: id(101) }) },
    requestApproval: async p => { f.events.push('review'); assert.equal(p.fileEdits[0].view.restoreOf, id(101)); return 'execute' }
  }, 1)
  const state = await runAgentTask('restore', f.deps, { restoreChange: { id: id(101), path: '/tmp/config-1' } }).done
  assert.equal(state.status, 'done'); assert.equal(state.steps[1].toolName, 'restore_file'); assert.ok(f.events.includes('review'))
})
test('edit parameters reject grants, duplicate baselines, empty patches and oversized payloads; sensitive history has no content or tickets', () => {
  const cases = [{ files: [{ baselineId: id(1), replacements: [] }] }, { files: [{ baselineId: id(1), replacements: [{ oldText: '', newText: 'x' }] }] }, { files: [{ baselineId: 'invented', replacements: [{ oldText: 'x', newText: 'y' }] }] }, { files: [{ baselineId: id(1), replacements: [{ oldText: 'x', newText: 'y' }], approved: true }] }]
  for (const value of cases) assert.throws(() => parseFileEditArguments('apply_patch', JSON.stringify(value)))
  assert.throws(() => parseFileEditArguments('write_file', JSON.stringify({ files: [{ baselineId: id(1), content: 'a' }, { baselineId: id(1), content: 'b' }] })))
  assert.throws(() => parseFileEditArguments('write_file', JSON.stringify({ files: [{ baselineId: id(1), content: '中'.repeat(30000) }] })))
  const saved = persistableFileEdits([{ status: 'applied', view: fileEditView(proposal(1, { before: 'old-secret', after: 'new-secret', sensitive: true })) }])
  assert.ok(!JSON.stringify(saved).includes('secret')); assert.ok(!JSON.stringify(saved).includes('reviewHash')); assert.ok(!JSON.stringify(saved).includes('reference'))
})

test('large reviewed batches retain change evidence without full write arguments in subsequent model context', async () => {
  let calls = 0
  const f = fixture({ callModel: async turns => {
    if (calls++ === 0) return response([{ id: 'large', name: 'write_file', arguments: JSON.stringify({ files: [1, 2, 3, 4].map(n => ({ baselineId: id(n), content: 'x'.repeat(65536) })) }) }])
    const history = JSON.stringify(turns)
    assert.ok(history.length < 80000)
    const call = turns.find(turn => turn.kind === 'assistant').toolCalls[0]
    assert.equal(JSON.parse(call.arguments).historyOnly, true)
    assert.equal(JSON.parse(call.arguments).files.length, 4)
    assert.match(history, new RegExp(id(104)))
    return response([])
  } }, 4)
  assert.equal((await runAgentTask('write', f.deps).done).status, 'done')
  assert.equal(calls, 2)
})

test('sensitive metadata backups are removed from every persisted attribute snapshot', () => {
  const attrs = { mode: 420, uid: 1, gid: 1, extendedMetadata: true, metadataBackup: { platform: 'darwin', xattrs: { private: 'sensitive-xattr' }, acl: 'sensitive-acl' } }
  const saved = persistableFileEdits([{ status: 'applied', view: fileEditView(proposal(1, { sensitive: true, restoreAttributes: attrs })), outcome: { status: 'applied', beforeAttributes: attrs, afterAttributes: attrs } }])
  assert.ok(!JSON.stringify(saved).includes('sensitive-'))
  assert.equal(saved[0].outcome.beforeAttributes.metadataBackup, null)
})

test('restore with no usable fresh baseline remains an explicit failed restore step and never asks the model to recreate it', async () => {
  const f = fixture({
    callModel: async () => { throw Error('restore must not request a model decision') },
    prepareFile: async () => { throw { kind: 'permission-denied', message: 'cannot read baseline' } }
  }, 1)
  const state = await runAgentTask('restore', f.deps, { restoreChange: { id: id(101), path: '/tmp/config-1' } }).done
  assert.equal(state.status, 'error')
  assert.equal(state.steps.at(-1).toolName, 'restore_file')
  assert.equal(state.steps.at(-1).fileEdits[0].status, 'not-started')
  assert.ok(!f.events.some(event => event.startsWith('write-')))
})
