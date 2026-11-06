import test from 'node:test'
import assert from 'node:assert/strict'
import { createRenderer, nextTick, reactive, ref } from 'vue'
import { useHostKnowledge } from '../../src/domains/ai/application/useHostKnowledge'
import { emptyKnowledgeDraft, sameKnowledgeScope, knowledgeCandidates } from '../../src/domains/ai/domain/hostKnowledge'
const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null })
const scope = { profileId: 'local', routeKey: 'route', user: 'operator', environmentScope: 'container' }
const target = { profileId: 'local', sessionId: 'terminal', sessionInstance: 'session', context: { user: 'operator', environmentScope: 'container' } }
function mount(t, overrides = {}) {
  const props = reactive({ connectionId: 'local', terminalId: 'terminal', terminalConnectionGeneration: 1, workspaceSessionId: 'workspace', config: { contextPolicy: 'active-command-output' } })
  const mode = ref('auto'), calls = [], saved = []
  const source = {
    agentCheckpointTarget: async () => { calls.push('target'); return target }, hostKnowledgeScope: async () => scope,
    listHostKnowledge: async () => saved,
    saveHostKnowledge: async (_target, draft) => { const value = { ...draft, id: draft.id ?? 'knowledge', revision: (draft.expectedRevision ?? 0) + 1, scope }; const i = saved.findIndex(r => r.id === value.id); if (i >= 0) saved[i] = value; else saved.push(value); return value },
    deleteHostKnowledge: async (_profile, id) => { saved.splice(saved.findIndex(record => record.id === id), 1); return true },
    hostKnowledgeContext: async (_target, query, runId) => { calls.push({ query, runId }); return JSON.stringify({ entries: saved }) },
    completedAgentCheckpointForMessage: async () => null, ...overrides
  }
  let model
  const app = renderer.createApp({ setup() { model = useHostKnowledge(props, () => mode.value, source); return () => null } }); app.mount({}); t.after(() => app.unmount())
  return { props, mode, calls, saved, model }
}
test('every model request reads the latest native knowledge after edit and deletion', async t => {
  const f = mount(t); await f.model.refresh()
  await f.model.save({ ...emptyKnowledgeDraft(), title: 'nginx 配置', value: '/etc/nginx.conf' })
  assert.match(await f.model.context('nginx', 'run'), /etc\/nginx/)
  const latest = f.model.records.value[0]
  await f.model.save({ ...emptyKnowledgeDraft(), id: latest.id, expectedRevision: latest.revision, title: 'nginx 配置', value: '/opt/nginx.conf' })
  const context = await f.model.context('nginx', 'run'); assert.match(context, /opt\/nginx/); assert.doesNotMatch(context, /etc\/nginx/)
  await f.model.remove(f.model.records.value[0]); assert.equal(await f.model.context('nginx'), '{"entries":[]}')
  assert.equal(f.calls.filter(call => typeof call === 'object').length, 3)
})
test('selection, none and restricted provider policies never request host knowledge', async t => {
  const f = mount(t)
  for (const mode of ['selection', 'none']) { f.mode.value = mode; assert.equal(await f.model.context('nginx'), '') }
  f.mode.value = 'auto'
  for (const policy of ['selected-output-only', 'manual-attachments']) { f.props.config.contextPolicy = policy; assert.equal(await f.model.context('nginx'), '') }
  assert.equal(f.calls.length, 0)
})
test('a late context cannot cross a changed connection or privacy choice', async t => {
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  const f = mount(t, { hostKnowledgeContext: async () => { entered(); await gate; return 'OLD_HOST_FACT' } })
  const pending = f.model.context('nginx'); await started
  f.props.terminalConnectionGeneration++; await nextTick(); release()
  assert.equal(await pending, '')
  assert.equal(f.model.scope.value, null)
})
test('unknown native context does not probe a terminal and explicitly withdraws old facts', async t => {
  const f = mount(t, { agentCheckpointTarget: async () => { throw Error('unknown target') } })
  f.props.agentCommandPolicy = { target: () => { throw Error('must not probe') } }
  const context = JSON.parse(await f.model.context('nginx'))
  assert.deepEqual(context.entries, []); assert.equal(context.currentSnapshot, true)
  assert.match(f.model.notice.value, /未附加/)
})
test('late saves never populate another target panel', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const f = mount(t, { saveHostKnowledge: () => gate }); await f.model.refresh()
  const pending = f.model.save({ ...emptyKnowledgeDraft(), title: 'nginx', value: '/etc/nginx.conf' })
  f.props.connectionId = 'other'; await nextTick(); release({ id: 'old', scope })
  assert.equal(await pending, false); assert.deepEqual(f.model.records.value, [])
})
test('a stalled target lookup has a bounded fallback and cannot start a late knowledge read', async t => {
  const timer = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => timer(fn, ms === 5000 ? 1 : ms))
  let release, reads = 0
  const pendingTarget = new Promise(resolve => { release = resolve })
  const f = mount(t, { agentCheckpointTarget: () => pendingTarget, hostKnowledgeContext: async () => { reads++; return 'late' } })
  assert.equal(JSON.parse(await f.model.context('nginx')).currentSnapshot, true)
  release(target); await nextTick(); await nextTick(); assert.equal(reads, 0)
})
test('task candidates contain successful same-scope metadata only and never auto-save', () => {
  const step = { id: 'read', executionTarget: target, status: 'completed', executionPhase: 'finished', exitCode: 0, sensitive: false, toolName: 'read_file', command: '', output: 'DO_NOT_COPY_OUTPUT', fileRead: { path: '/etc/nginx.conf', environmentScope: 'files', content: 'DO_NOT_COPY_FILE_BODY', absent: false, changedDuringRead: false } }
  const checkpoint = { runId: 'run', routeKey: 'route', state: { steps: [step, { ...step, id: 'sensitive', sensitive: true }, { ...step, id: 'other', executionTarget: { ...target, context: { ...target.context, user: 'root' } } }, { ...step, id: 'unknown', exitCode: null }] } }
  const candidates = knowledgeCandidates(checkpoint, scope)
  assert.equal(candidates.length, 1); assert.equal(candidates[0].evidence.stepId, 'read'); assert.equal(candidates[0].id, null)
  assert.ok(!JSON.stringify(candidates).includes('DO_NOT_COPY'))
  assert.deepEqual(knowledgeCandidates({ ...checkpoint, routeKey: 'other' }, scope), [])
  for (const field of ['profileId', 'routeKey', 'user', 'environmentScope']) assert.equal(sameKnowledgeScope(scope, { ...scope, [field]: 'different' }), false)
})
