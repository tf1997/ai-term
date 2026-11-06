import assert from 'node:assert/strict'
import test from 'node:test'
import { createSshTaskService } from '../../src/domains/terminal/application/sshTasks'
import { origin, intent, snapshot, deferred, tick } from './ssh-task-fixture.mjs'

function fixture(overrides = {}) {
  const calls = []
  const api = {
    prepare: async () => intent, approve: async () => {}, cancel: async () => { calls.push('cancel'); return true },
    listen: async () => () => calls.push('unlisten'),
    start: async () => { calls.push('start'); return snapshot }, read: async () => { calls.push('read'); return snapshot }, ...overrides
  }
  return { calls, api, service: createSshTaskService({ target: async () => structuredClone(origin) }, api) }
}

test('lost start acknowledgement reconciles stored result without dispatching again', async () => {
  let starts = 0
  const f = fixture({ start: async () => { starts++; throw Error('ack lost') } })
  const updates = []
  const handle = await f.service.start('terminal', 1, intent, value => updates.push(value))
  assert.equal((await handle.result).exitCode, 7)
  assert.equal(starts, 1)
  assert.equal(updates[0].stderr, 'diagnostic')
  assert.deepEqual(f.calls, ['read', 'unlisten'])
})

test('missing result after dispatch remains unknown and cannot become exit zero', async () => {
  const f = fixture({ start: async () => { throw Error('lost') }, read: async () => { throw Error('connection gone') } })
  const result = await (await f.service.start('terminal', 1, intent, () => {})).result
  assert.equal(result.status, 'unknown')
  assert.equal(result.exitCode, null)
  assert.match(result.reason, /核验/)
  assert.deepEqual(f.calls, ['cancel', 'unlisten'])
})

test('changed origin stops before any dispatch, including an identical session id after reconnect', async () => {
  const f = fixture()
  const service = createSshTaskService({ target: async () => ({ ...origin, sessionInstance: 'new' }) }, f.api)
  await assert.rejects(service.start('terminal', 2, intent, () => {}), /连接已变化/)
  assert.deepEqual(f.calls, [])
})

test('cancel during listener setup prevents start and releases late listener', async () => {
  const listener = deferred()
  const f = fixture({ listen: () => listener.promise })
  const handle = await f.service.start('terminal', 1, intent, () => {})
  handle.cancel()
  listener.resolve(() => f.calls.push('unlisten'))
  assert.equal((await handle.result).status, 'not-started')
  assert.deepEqual(f.calls, ['cancel', 'unlisten'])
})

test('event loss is recovered by snapshot polling, preserving both output streams', async () => {
  const f = fixture({ start: async () => ({ ...snapshot, sequence: 0, status: 'running', stdout: '', stderr: '', exitCode: null, finishedAt: null }) })
  const updates = []
  const result = await (await f.service.start('terminal', 1, intent, value => updates.push(value))).result
  assert.equal(result.status, 'completed')
  assert.deepEqual(updates.map(value => value.sequence), [0, 3])
  assert.equal(result.stdout, '你好')
  assert.equal(result.stderr, 'diagnostic')
})

test('stop observing a dispatched task preserves partial output without reporting termination', async () => {
  const f = fixture({ start: async () => ({ ...snapshot, sequence: 1, status: 'running', stdout: 'partial', exitCode: null, finishedAt: null }) })
  const handle = await f.service.start('terminal', 1, intent, () => {})
  await tick()
  handle.cancel()
  const result = await handle.result
  // A final snapshot received concurrently with stop remains authoritative.
  assert.equal(result.status, 'completed')
  assert.equal(result.exitCode, 7)
  assert.equal(f.calls.filter(x => x === 'cancel').length, 1)
})
