import test from 'node:test'
import assert from 'node:assert/strict'
import { createAgentFileEditService } from '../../src/domains/transfer/application/agentFileEdits'
import { proposal, record, target, deferred, tick } from './file-edit-fixture.mjs'
function fixture(overrides = {}, dependencies = {}) {
  const calls = []
  const api = { prepare: async () => proposal(), prepareRestore: async () => proposal(), approve: async () => {}, dispatch: async () => { calls.push('dispatch'); return { kind: 'complete', record: record() } }, finishTerminal: async () => record(), cancel: async () => { calls.push('cancel') }, getChange: async () => record(), listChanges: async () => [], ...overrides }
  const service = createAgentFileEditService({ target: async () => target, capture: async () => 'receipt', ...dependencies }, api)
  return { service, calls }
}
test('lost dispatch receipt reconciles the durable change and never dispatches twice', async () => {
  let dispatches = 0
  const f = fixture({ dispatch: async () => { dispatches++; throw Error('lost acknowledgement') } })
  const result = await f.service.execute('terminal', 1, proposal(), { cancelled: false })
  assert.equal(result.outcome.status, 'applied'); assert.equal(dispatches, 1)
})
test('unavailable or unrelated journal evidence remains unknown', async () => {
  for (const getChange of [async () => null, async () => { throw Error('offline') }, async () => ({ ...record(), path: '/different-file' })]) {
    const f = fixture({ dispatch: async () => { throw Error('lost') }, getChange })
    assert.equal((await f.service.execute('terminal', 1, proposal(), { cancelled: false })).outcome.status, 'unknown')
  }
})
test('changed target fails before dispatch and late preparation is cancelled', async () => {
  const f = fixture({}, { target: async () => ({ ...target, sessionInstance: 'new' }) })
  assert.equal((await f.service.execute('terminal', 1, proposal(), { cancelled: false })).outcome.status, 'conflict')
  assert.ok(!f.calls.includes('dispatch'))
  const pending = deferred(), signal = { cancelled: false }
  const late = fixture({ prepare: () => pending.promise })
  const preparing = late.service.prepare('terminal', 1, { baselineId: 'baseline', change: { action: 'delete' } }, signal)
  await tick(); signal.cancelled = true; pending.resolve(proposal())
  await assert.rejects(preparing); await tick(); assert.ok(late.calls.includes('cancel'))
})
test('WAN write receipt remains observable beyond 25 seconds and is dispatched only once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const pending = deferred()
  let dispatches = 0, reconciles = 0, settled = false
  const f = fixture({ dispatch: () => { dispatches++; return pending.promise }, getChange: async () => { reconciles++; return null } })
  const running = f.service.execute('terminal', 1, proposal(), { cancelled: false }).then(result => { settled = true; return result })
  await tick(); t.mock.timers.tick(30000); await tick()
  assert.equal(settled, false); assert.equal(reconciles, 0)
  pending.resolve({ kind: 'complete', record: record() })
  assert.equal((await running).outcome.status, 'applied'); assert.equal(dispatches, 1)
})
test('WAN write deadline reconciles missing evidence as unknown without replay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let dispatches = 0
  const f = fixture({ dispatch: () => { dispatches++; return new Promise(() => {}) }, getChange: async () => null })
  const running = f.service.execute('terminal', 1, proposal(), { cancelled: false })
  await tick(); t.mock.timers.tick(65001); await tick()
  assert.equal((await running).outcome.status, 'unknown'); assert.equal(dispatches, 1)
  assert.ok(f.calls.includes('cancel'))
})
