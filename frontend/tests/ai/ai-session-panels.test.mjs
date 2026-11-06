import assert from 'node:assert/strict'
import test from 'node:test'
import { createRenderer, reactive, nextTick } from 'vue'
import { useAiSessionPanels } from '../../src/domains/ai/application/useAiSessionPanels'

const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null })
function fixture(t) {
  const takeovers = [], probes = [], activities = []
  const context = id => ({ terminalId: id, terminalConnectionGeneration: 1, connectionId: 'host', executionTargetLabel: id, executionTargetTitle: id,
    executionTargetConnectionIds: ['host'], terminalSnapshot: `output-${id}`, commandHistory: [],
    agentAvailabilityCheck: () => '', agentAvailabilityConfirm: async () => { probes.push(id); return '' } })
  const terminalContexts = { first: context('first'), second: context('second') }
  const props = reactive({ ...terminalContexts.first, workspaceSessionId: 'one', workspaceSessions: [{ id: 'one', aiMode: 'agent' }, { id: 'two', aiMode: 'agent' }],
    terminalContexts, messages: [], messagesBySession: { one: [], two: [] }, contextBySession: {},
    agentTakeoverChange: (id, active) => takeovers.push([id, active]) })
  let state
  const app = renderer.createApp({ setup() { state = useAiSessionPanels(props, activity => activities.push(activity)); return () => null } })
  app.mount({}); t.after(() => app.unmount())
  const panel = id => state.panels.value.find(item => item.id === id)?.props
  async function select(sessionId, terminalId) {
    Object.assign(props, terminalContexts[terminalId], { workspaceSessionId: sessionId })
    await nextTick()
  }
  return { state, props, panel, select, takeovers, probes, activities }
}

test('new and switched conversations preserve the running controller and original terminal context', async t => {
  const f = fixture(t)
  assert.equal(f.state.takeover('one', 'first', true), true)
  f.state.activityChanged({ sessionId: 'one', terminalId: 'first', mode: 'agent', status: 'running', label: '正在规划任务' })
  await f.select('two', 'second')
  assert.equal(f.state.panels.value.length, 2)
  assert.equal(f.panel('one').active, false)
  assert.equal(f.panel('one').terminalId, 'first')
  assert.equal(f.panel('one').terminalSnapshot, 'output-first')
  assert.equal(f.panel('two').terminalId, 'second')
  f.props.messagesBySession.one = [{ id: 'background-result', text: 'done' }]
  await nextTick()
  assert.equal(f.panel('one').messages[0].id, 'background-result')
  assert.deepEqual(f.panel('two').messages, [])
  assert.equal(f.panel('two').sessionActivities.one.status, 'running')
  await f.panel('one').agentAvailabilityConfirm()
  assert.deepEqual(f.probes, ['first'])
  await f.select('one', 'second')
  assert.equal(f.panel('one').terminalId, 'first', 'Returning to a running conversation cannot retarget it to the selected tab')
  assert.deepEqual(f.takeovers, [['first', true]], 'Navigation does not release ownership')
})

test('two sessions own different terminals and cannot steal or release each other’s ownership', async t => {
  const f = fixture(t)
  f.state.takeover('one', 'first', true)
  await f.select('two', 'first')
  assert.match(f.panel('two').agentAvailabilityCheck(), /其他会话/)
  assert.match(await f.panel('two').agentAvailabilityConfirm(), /其他会话/)
  assert.deepEqual(f.probes, [])
  assert.equal(f.state.takeover('two', 'first', true), false)
  f.state.takeover('two', 'first', false)
  assert.deepEqual(f.takeovers, [['first', true]])
  await f.select('two', 'second')
  assert.equal(f.state.takeover('two', 'second', true), true)
  f.state.takeover('one', 'first', false)
  assert.deepEqual(f.takeovers, [['first', true], ['second', true], ['first', false]])
  assert.equal(f.state.takeover('one', 'second', true), false)
  assert.equal(f.panel('two').terminalId, 'second')
})

test('Agent binding survives completion, observes real reconnects, and chat can follow another terminal', async t => {
  const f = fixture(t)
  f.state.takeover('one', 'first', true)
  f.state.takeover('one', 'first', false)
  await f.select('one', 'second')
  assert.equal(f.panel('one').terminalId, 'first')
  f.props.terminalContexts.first.terminalConnectionGeneration = 2
  await nextTick()
  assert.equal(f.panel('one').terminalConnectionGeneration, 2, 'Pinned sessions still observe reconnects to invalidate stale execution')
  f.props.workspaceSessions = [{ id: 'one', aiMode: 'chat' }, { id: 'two', aiMode: 'agent' }]
  await nextTick()
  assert.equal(f.panel('one').terminalId, 'second')
})

test('closing the sidebar does not remove running panels; deleted idle sessions are disposed', async t => {
  const f = fixture(t)
  f.state.takeover('one', 'first', true)
  await f.select('two', 'second')
  f.props.active = false
  await nextTick()
  assert.equal(f.state.panels.value.length, 2)
  assert.ok(f.state.panels.value.every(panel => !panel.props.active))
  f.state.takeover('one', 'first', false)
  f.props.workspaceSessions = [{ id: 'two', aiMode: 'agent' }]
  await nextTick()
  assert.equal(f.panel('one'), undefined)
  assert.equal(f.state.panels.value.length, 1)
})
