import assert from 'node:assert/strict'
import test from 'node:test'
import { createRenderer, reactive, ref } from 'vue'
import { useScriptDrafts } from '../../src/domains/scripts/application/useScriptDrafts'
import { useScriptGeneration } from '../../src/domains/scripts/application/useScriptGeneration'

const renderer = createRenderer({
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
  parentNode: () => null, nextSibling: () => null
})
const saved = (id, content = `echo ${id}`) => ({
  id, name: `${id}.sh`, content, description: '', connectionId: 'remote', workspaceSessionId: 'workspace',
  sourceCommands: [], createdAt: '', updatedAt: ''
})

function harness(t) {
  globalThis.window = globalThis
  const drafts = useScriptDrafts()
  drafts.ensureSaved(saved('A'))
  drafts.ensureSaved(saved('B'))
  const active = ref('A')
  const context = ref('connection/workspace/terminal')
  const messages = ref([])
  let resolveAnswer, request
  const answer = new Promise(resolve => { resolveAnswer = resolve })
  const props = reactive({
    connectionId: 'remote', workspaceSessionId: 'workspace', terminalId: 'terminal',
    config: { id: 'config', baseUrl: 'https://unused.example', model: 'mock', apiKey: 'test' }, apiKey: '',
    recording: { commands: [], terminalOutput: '', isRecording: false },
  })
  let generation
  const app = renderer.createApp({ setup() {
    generation = useScriptGeneration({
      props, saveState: ref('idle'), panelError: ref(''), scriptPanelMode: ref('library'),
      askText: ref('添加日志'), messages, collapsedMessages: ref({}), draftScriptContent: ref('unrelated draft'),
      recordedCommands: () => [], sourceCommands: () => [], recordedOutput: () => '', recordingHasData: () => false,
      scriptSourceConnectionId: () => 'remote', scriptSourceWorkspaceSessionId: () => 'workspace',
      hasDraftScript: () => true, hasUsableConfig: () => true, openGenerateMode() {},
      captureTarget: () => drafts.snapshot(active.value, context.value),
      applyGeneratedScript: (target, content, messageId) => drafts.receiveGeneration(target, content, messageId, active.value, context.value)
    }, {
      async onAiChatStream() { return () => {} },
      async chatWithAiProviderStream(_id, payload) { request = payload; return answer },
      async cancelTask() {}
    })
    return () => null
  } })
  app.mount({})
  t.after(() => app.unmount())
  return { drafts, active, context, props, messages, generation, request: () => request, finish: () => resolveAnswer({ answer: '```bash\necho revised A\n```' }) }
}

test('saved documents retain independent edits when revisited, including clearing all content', () => {
  const drafts = useScriptDrafts()
  const a = saved('A')
  drafts.ensureSaved(a)
  drafts.updateContent('A', 'echo unsaved')
  drafts.ensureSaved(saved('B'))
  assert.equal(drafts.ensureSaved(a).content, 'echo unsaved')
  drafts.updateContent('A', '')
  assert.equal(drafts.ensureSaved(a).content, '')
  assert.notEqual(drafts.documents.value.A.content, a.content)
})

test('creating another draft preserves earlier new documents and a cleared draft revision', () => {
  const drafts = useScriptDrafts()
  const first = drafts.createDraft()
  drafts.updateContent(first.id, 'echo keep')
  const second = drafts.createDraft()
  drafts.updateContent(second.id, 'echo second')
  assert.equal(drafts.documents.value[first.id].content, 'echo keep')
  drafts.updateContent(first.id, '')
  assert.equal(drafts.documents.value[first.id].revision, 2)
  assert.equal(drafts.documents.value[second.id].content, 'echo second')
})

test('a save completion never replaces edits made while save was pending', () => {
  const drafts = useScriptDrafts()
  const document = drafts.createDraft()
  drafts.updateContent(document.id, 'echo saved')
  const saveSnapshot = saved(document.id, document.content)
  drafts.updateContent(document.id, 'echo newer')
  drafts.markSaved(saveSnapshot)
  assert.equal(document.content, 'echo newer')
  assert.equal(document.savedScriptId, saveSnapshot.id)
})

test('AI uses the selected document in its prompt and applies only to the unchanged original', async t => {
  const h = harness(t)
  const work = h.generation.sendScriptRequest('revise', 'selected')
  await Promise.resolve()
  assert.match(h.request().question, /echo A/)
  assert.doesNotMatch(h.request().question, /unrelated draft/)
  h.finish()
  await work
  assert.equal(h.drafts.documents.value.A.content, 'echo revised A')
  assert.equal(h.drafts.documents.value.B.content, 'echo B')
  assert.equal(h.messages.value.at(-1).applicationState, 'applied')
})

test('switching A to B during AI generation retains an A proposal and accepts it into A only', async t => {
  const h = harness(t)
  const work = h.generation.sendScriptRequest('revise', 'selected')
  h.active.value = 'B'
  h.finish()
  await work
  assert.equal(h.drafts.documents.value.A.content, 'echo A')
  assert.equal(h.drafts.documents.value.B.content, 'echo B')
  assert.equal(h.drafts.documents.value.A.pending.content, 'echo revised A')
  h.drafts.acceptPending('A')
  assert.equal(h.drafts.documents.value.A.content, 'echo revised A')
  assert.equal(h.drafts.documents.value.B.content, 'echo B')
})

test('manual edits, even edits reverted to the original text, make AI wait for adoption', async t => {
  const h = harness(t)
  const work = h.generation.sendScriptRequest('revise', 'selected')
  h.drafts.updateContent('A', 'echo manual')
  h.drafts.updateContent('A', 'echo A')
  h.finish()
  await work
  assert.equal(h.drafts.documents.value.A.content, 'echo A')
  assert.equal(h.drafts.documents.value.A.pending.baseContent, 'echo A')
  assert.equal(h.messages.value.at(-1).applicationState, 'pending')
})

test('a changed business context retains a proposal instead of rewriting the visible editor', async t => {
  const h = harness(t)
  const work = h.generation.sendScriptRequest('revise', 'selected')
  h.context.value = 'different terminal'
  h.finish()
  await work
  assert.equal(h.drafts.documents.value.A.content, 'echo A')
  assert.ok(h.drafts.documents.value.A.pending)
})

test('stopping an AI request ignores a late response', async t => {
  const h = harness(t)
  const work = h.generation.sendScriptRequest('revise', 'selected')
  await Promise.resolve()
  h.generation.stopScriptGeneration()
  h.finish()
  await work
  assert.equal(h.drafts.documents.value.A.content, 'echo A')
  assert.equal(h.drafts.documents.value.A.pending, undefined)
})
