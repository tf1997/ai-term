import assert from 'node:assert/strict'
import test from 'node:test'
import { runAgentTask, compressAgentTurns } from '../../src/domains/ai/application/agent/agentLoop'
import { fileToolModelResult, parseFileToolArguments, persistableFileResult } from '../../src/domains/ai/domain/agentFileTools'
import { hydrateAiMessagePayload } from '../../src/domains/ai/domain/workspaceSessions'
const tick = () => new Promise(resolve => setImmediate(resolve))
const target = { sessionId: 'terminal', sessionInstance: 'instance', profileId: 'profile', routeVersion: 0, contextVersion: 1, context: { shell: 'bash', user: '1000', workingDirectory: '/tmp', environmentScope: 'scope' } }
const request = { tool: 'read_file', path: '/tmp/test', options: { maxLines: 200, maxBytes: 16384, startLine: 1, tail: false } }
const operation = { reference: { id: 'read', target }, request, provider: 'current-terminal', resolvedPath: '/tmp/test', revision: 'metadata:1', sensitive: false }
const result = { tool: 'read_file', path: '/tmp/test', resolvedPath: '/tmp/test', revision: 'metadata:1', provider: 'current-terminal', target, sensitive: false, metadata: { kind: 'file', size: 8, modifiedNs: null, identity: null }, content: '\ufeffa\r\nb', start: { byte: 0, line: 1, midLine: false }, end: { byte: 8, line: 2, midLine: true }, eof: true, complete: true, changedDuringRead: false, nextCursor: null, truncation: null, scannedBytes: 8 }
const call = () => ({ id: 'read', name: 'read_file', arguments: '{"path":"/tmp/test"}' })
const response = calls => ({ text: calls.length ? '' : 'done', toolCalls: calls, contextCompressed: false, contextChars: 0 })
function dependencies(overrides = {}) {
  let model = 0
  const turns = [], events = []
  return { turns, events, deps: {
    callModel: async history => { turns.push(structuredClone(history)); return response(model++ === 0 ? [call()] : []) },
    startCommand: () => { throw Error('file tool entered shell executor') }, classifyStep: () => { throw Error('file tool entered shell analysis') },
    prepareFile: async () => { events.push('prepare'); return operation }, approveFile: async () => { events.push('approve') },
    executeFile: async () => { events.push('read'); return result }, cancelFile: async () => { events.push('cancel') },
    requestApproval: async () => { events.push('review'); return 'execute' }, requestTimeoutDecision: async () => 'stop', onAllowPattern: () => { throw Error('file tool added shell grant') }, onStateChange() {}, ...overrides
  } }
}
test('typed file read returns exact bytes without shell command or exit status', async () => {
  const f = dependencies(); const state = await runAgentTask('read', f.deps).done
  assert.equal(state.status, 'done'); assert.equal(state.steps[0].toolName, 'read_file'); assert.equal(state.steps[0].command, '')
  assert.equal(state.steps[0].exitCode, undefined); assert.equal(state.fileChanges, undefined); assert.equal(state.steps[0].output, result.content)
  assert.deepEqual(f.events, ['prepare', 'read', 'cancel'])
  const returned = JSON.parse(f.turns[1].find(turn => turn.kind === 'toolResult').content)
  assert.equal(returned.content, result.content); assert.equal(returned.target, undefined)
})
test('sensitive file reads require exact review, can be skipped and never grant shell patterns', async () => {
  for (const decision of ['execute', 'skip']) {
    let proposal
    const f = dependencies({ prepareFile: async () => ({ ...operation, sensitive: true }), requestApproval: async value => { proposal = value; f.events.push('review'); return decision } })
    const state = await runAgentTask('read', f.deps).done
    assert.equal(proposal.toolName, 'read_file'); assert.equal(proposal.fileResolvedPath, '/tmp/test'); assert.equal(proposal.fileRevision, 'metadata:1'); assert.equal(proposal.suggestedPatterns, undefined)
    assert.equal(state.steps[0].status, decision === 'skip' ? 'skipped' : 'completed')
    assert.deepEqual(f.events, decision === 'skip' ? ['review', 'cancel'] : ['review', 'approve', 'read', 'cancel'])
  }
})
test('stop cancels a late prepared file operation without reading it', async () => {
  let release; const pending = new Promise(resolve => { release = resolve })
  const f = dependencies({ prepareFile: () => pending }); const task = runAgentTask('read', f.deps)
  await tick(); task.stop(); assert.equal((await task.done).status, 'stopped'); release(operation); await tick()
  assert.deepEqual(f.events, ['cancel'])
})
test('missing file is a model-visible error but changed target stops the bound task', async () => {
  for (const kind of ['missing', 'target-changed']) {
    const f = dependencies({ executeFile: async () => { throw { kind, message: kind } } }); const state = await runAgentTask('read', f.deps).done
    assert.equal(state.steps[0].status, 'failed'); assert.equal(state.status, kind === 'missing' ? 'done' : 'stopped')
    if (kind === 'missing') assert.equal(JSON.parse(f.turns[1][1].content).error.kind, 'missing')
  }
})
test('file parameters reject source, grants, traversal and unbounded ranges', () => {
  for (const args of [{ path: '/tmp/x', internal: true }, { path: '/tmp/x', command: 'whoami' }, { path: '/tmp/../x' }, { path: '/tmp/x', maxBytes: 65537 }, { path: '/tmp/x', startLine: 0 }, { path: '/tmp/x', tail: true, startLine: 2 }, { path: '/tmp/x', cursor: 'made up' }]) assert.equal(parseFileToolArguments('read_file', JSON.stringify(args)).ok, false)
  assert.equal(parseFileToolArguments('list_directory', '{"path":"/tmp","limit":501}').ok, false)
})
test('history keeps file tool identity, strips sensitive contents and restores old commands', async () => {
  const saved = persistableFileResult({ ...result, sensitive: true, nextCursor: 'ephemeral', baselineId: 'live-baseline' })
  assert.equal(saved.baselineId, undefined)
  assert.equal(saved.nextCursor, null); assert.equal(saved.redacted, true); assert.ok(!saved.content.includes(result.content)); assert.equal(JSON.parse(fileToolModelResult(saved)).status, 'content_not_persisted')
  const fileStep = { id: 'read', toolName: 'read_file', command: '', fileRequest: request, fileResult: saved, risks: [], sensitive: true, status: 'completed', reason: 'read' }
  const old = { id: 'old', command: 'pwd', risks: [], sensitive: false, status: 'completed', reason: 'cwd', output: '/tmp', exitCode: 0 }
  const message = hydrateAiMessagePayload({ text: '', payloadJson: JSON.stringify({ payloadVersion: 2, mode: 'agent', agentSteps: [old, fileStep] }) })
  let rebuilt; const f = dependencies({ callModel: async turns => { rebuilt = turns; return response([]) } })
  await runAgentTask('continue', f.deps, { initialSteps: message.agentSteps }).done
  assert.equal(rebuilt[0].toolCalls[0].name, 'run_command'); assert.equal(rebuilt[2].toolCalls[0].name, 'read_file')
})
test('oversized encoded results request smaller reread without a cursor skipping unseen text', () => {
  const model = JSON.parse(fileToolModelResult({ ...result, content: '\u001b'.repeat(65536), nextCursor: 'next', baselineId: 'unseen-baseline' }))
  assert.equal(model.baselineId, undefined)
  assert.equal(model.status, 'model_context_limit'); assert.equal(model.content, undefined); assert.equal(model.nextCursor, undefined)
  const turns = Array.from({ length: 4 }, (_, n) => [{ kind: 'assistant', text: '', toolCalls: [{ id: String(n), name: 'read_file', arguments: '{}' }] }, { kind: 'toolResult', toolCallId: String(n), content: JSON.stringify({ tool: 'read_file', path: '/tmp/file', revision: String(n), content: 'x'.repeat(12000) }) }]).flat()
  const compacted = compressAgentTurns(turns, 24000)
  assert.ok(compacted.reduce((sum, turn) => sum + (turn.content?.length ?? 0), 0) < 24000); assert.equal(compacted.at(-1).content, turns.at(-1).content)
})

test('full 64 KiB baseline reaches the next model turn while earlier file bodies are compacted', () => {
  const content = 'x'.repeat(65536)
  const json = fileToolModelResult({ ...result, content, baselineId: 'live-baseline' })
  assert.equal(JSON.parse(json).content, content)
  assert.equal(JSON.parse(json).baselineId, 'live-baseline')
  const turns = Array.from({ length: 3 }, (_, n) => [{ kind: 'assistant', text: '', toolCalls: [{ id: String(n), name: 'read_file', arguments: '{}' }] }, { kind: 'toolResult', toolCallId: String(n), content: json }]).flat()
  const compacted = compressAgentTurns(turns, 24000)
  assert.ok(compacted.reduce((sum, turn) => sum + (turn.content?.length ?? 0) + (turn.toolCalls?.reduce((sum, call) => sum + call.arguments.length, 0) ?? 0), 0) < 80000)
  assert.equal(compacted.at(-1).content, json)
  assert.equal(JSON.parse(compacted[1].content).baselineId, undefined)
})

test('shared snapshots keep full original bytes, bind missing files and enforce batch budgets', async () => {
  const { createBoundAgentFileSnapshotReader } = await import('../../src/domains/ai/application/agent/readAgentFileSnapshots')
  const scope = 'a'.repeat(64); let executed = 0
  const files = {
    prepare: async (_id, _generation, request) => {
      if (request.path === '/missing') throw { kind: 'missing', message: 'missing', absence: { path: '/missing', resolvedPath: '/missing', environmentScope: scope } }
      return { ...operation, request }
    },
    execute: async (_id, _generation, op) => { executed++; return { ...result, path: op.request.path, resolvedPath: op.request.path, environmentScope: scope, content: op.request.path.startsWith('/large') ? 'x'.repeat(65536) : result.content } },
    cancel: async () => {}
  }
  const read = createBoundAgentFileSnapshotReader(files, 't', 1, () => { throw Error('unexpected legacy fallback') })
  const snapshots = await read(['/tmp/test', '/missing'], { cancelled: false })
  assert.equal(snapshots[0].version.content, result.content); assert.equal(snapshots[1].version.state, 'missing'); assert.equal(snapshots[0].scope, snapshots[1].scope)
  executed = 0
  const large = await read(Array.from({ length: 6 }, (_, i) => `/large${i}`), { cancelled: false })
  assert.equal(executed, 4); assert.equal(large[4].version.state, 'unavailable')
  files.execute = async () => ({ ...result, environmentScope: scope, complete: false })
  assert.equal((await read(['/tmp/test'], { cancelled: false }))[0].version.state, 'unavailable')
})
