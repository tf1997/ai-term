import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentFileToolService } from '../../src/domains/transfer/application/agentFileTools'
const reference = { id: 'inspection', target: { sessionId: 's' } }
const operation = { reference: { ...reference, id: 'read' }, request: { tool: 'read_file', path: '/tmp/a' }, provider: 'current-terminal', resolvedPath: '/tmp/a', revision: 'version', sensitive: false }
const plan = { reference, intent: { source: 'backend-owned-source', capture: { internal: true } }, maxOutputChars: 786432 }
function fixture(overrides = {}) {
  const events = []
  const deps = { target: async (id, generation) => { events.push(['target', id, generation]); return reference.target }, capture: (id, generation, capture) => { events.push(['capture', id, generation, capture.intent.source]); return { result: Promise.resolve({ status: 'completed', output: 'protocol', exitCode: 0, truncated: false }), cancel() {}, peekOutput: () => '' } } }
  const api = { inspect: async () => plan, finishInspection: async () => operation, approve: async () => {}, dispatch: async () => ({ kind: 'terminal', capture: { ...plan, reference: operation.reference } }), finishTerminal: async () => ({ tool: 'read_file', content: 'exact' }), cancel: async reference => events.push(['cancel', reference.id]), ...overrides }
  return { events, deps, service: createAgentFileToolService(deps, api) }
}
test('captures bind terminal generation and return only finalized backend results', async () => {
  const f = fixture(); const signal = { cancelled: false }; const prepared = await f.service.prepare('terminal', 4, operation.request, signal)
  assert.equal((await f.service.execute('terminal', 4, prepared, signal)).content, 'exact')
  assert.deepEqual(f.events.slice(0, 3), [['target', 'terminal', 4], ['capture', 'terminal', 4, 'backend-owned-source'], ['capture', 'terminal', 4, 'backend-owned-source']])
})
test('cancelled preparation removes a late returned operation', async () => {
  const signal = { cancelled: false }; const f = fixture({ finishInspection: async () => { signal.cancelled = true; return operation } })
  await assert.rejects(f.service.prepare('t', 1, operation.request, signal), error => error.kind === 'cancelled')
  assert.ok(f.events.some(event => event[0] === 'cancel' && event[1] === 'read'))
})
test('incomplete terminal captures never reach backend finalization', async () => {
  for (const failure of [{ truncated: true }, { commandMismatch: true }, { status: 'cancelled' }, { exitCode: undefined }]) {
    let finalized = false; const f = fixture({ finishInspection: async () => { finalized = true; return operation } })
    f.deps.capture = () => ({ result: Promise.resolve({ status: 'completed', output: 'partial', exitCode: 0, truncated: false, ...failure }), cancel() {}, peekOutput: () => '' })
    await assert.rejects(f.service.prepare('t', 1, operation.request, { cancelled: false })); assert.equal(finalized, false); assert.ok(f.events.some(event => event[0] === 'cancel'))
  }
})
