import assert from 'node:assert/strict'
import test from 'node:test'
import { createRenderer } from 'vue'
import { useWorkspaceSessions } from '../src/composables/useWorkspaceSessions.ts'
import { useAiMessages } from '../src/composables/useAiMessages.ts'
import { useCommandHistory } from '../src/composables/useCommandHistory.ts'
import { hydrateAiMessagePayload, isAutoWorkspaceSessionName, newWorkspaceSession, workspaceSessionTitleFromText } from '../src/lib/workspaceSessions.ts'

function deferred() {
  let resolve, reject
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

function session(id = 'one', overrides = {}) {
  return { id, connectionId: 'remote', name: 'Untitled', summary: '', createdAt: '2026-09-08T01:00:00.000Z', updatedAt: '2026-09-08T01:00:00.000Z', ...overrides }
}

function message(id = 'message', overrides = {}) {
  return { id, connectionId: 'remote', workspaceSessionId: 'one', terminalId: 'terminal', role: 'user', text: '检查服务器', createdAt: '2026-09-08T02:00:00.000Z', ...overrides }
}

function createStorage(initial = []) {
  const calls = []
  const rows = new Map(initial.map(row => [row.id, { ...row }]))
  return {
    calls, rows,
    async listWorkspaceSessions() { calls.push(['list-sessions']); return [...rows.values()].map(row => ({ ...row })) },
    async saveWorkspaceSession(row) { calls.push(['save-session', row.id, { ...row }]); rows.set(row.id, { ...row }) },
    async deleteWorkspaceSession(id) { calls.push(['delete-session', id]); return rows.delete(id) },
    async listAiConversationMessages(id) { calls.push(['list-messages', id]); return [] },
    async saveAiConversationMessage(row) { calls.push(['save-message', row.id, structuredClone(row)]) },
    async listCommandHistory(id) { calls.push(['list-history', id]); return [] },
    async saveCommandHistoryRecord(row) { calls.push(['save-history', row.id, { ...row }]) }
  }
}

const renderer = createRenderer({
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
  parentNode: () => null, nextSibling: () => null
})

function mountData(context, storage = createStorage()) {
  const errors = []
  const sessions = useWorkspaceSessions({ onRenameError: error => errors.push(error) }, storage)
  const history = useCommandHistory(storage)
  let messages
  let unmounted = false
  const app = renderer.createApp({ setup() {
    messages = useAiMessages(sessions, storage)
    return () => null
  } })
  app.mount({})
  function unmount() { if (!unmounted) { unmounted = true; app.unmount() } }
  context.after(unmount)
  return { sessions, history, messages, storage, errors, unmount }
}

test('会话规则保留默认名、来源连接、ISO 时间和 60 字符标题', () => {
  const draft = newWorkspaceSession('local', undefined, 'draft')
  assert.equal(draft.id, 'draft')
  assert.equal(draft.name, 'Untitled')
  assert.equal(draft.connectionId, 'local')
  assert.equal(draft.createdAt, draft.updatedAt)
  assert.equal(new Date(draft.createdAt).toISOString(), draft.createdAt)
  for (const name of ['UNTITLED', '无标题', '默认会话', '本地默认会话', '当前会话']) assert.equal(isAutoWorkspaceSessionName(name), true)
  assert.equal(isAutoWorkspaceSessionName('发布巡检'), false)
  assert.equal(workspaceSessionTitleFromText('选中终端内容\n\n 检查  网络 '), '检查 网络')
  assert.equal(workspaceSessionTitleFromText(''), '当前会话')
  assert.equal(workspaceSessionTitleFromText('界'.repeat(70)), '界'.repeat(57) + '...')
})

test('Agent 载荷兼容旧消息、损坏 JSON 和不可信运行状态', () => {
  const plain = message()
  assert.equal(hydrateAiMessagePayload(plain), plain)
  for (const payloadJson of ['bad', '{}', '{"mode":"chat"}', 'null']) {
    const row = message('legacy', { payloadJson })
    assert.equal(hydrateAiMessagePayload(row), row)
  }
  for (const agentStatus of ['done', 'stopped', 'error', 'running']) {
    const hydrated = hydrateAiMessagePayload(message('agent', { payloadJson: JSON.stringify({ mode: 'agent', agentStatus, agentSteps: 'bad' }) }))
    assert.equal(hydrated.mode, 'agent')
    assert.deepEqual(hydrated.agentSteps, [])
    assert.equal(hydrated.agentStatus, agentStatus === 'running' ? 'done' : agentStatus)
  }
})

test('命令历史按连接加载，合并期间新记录，复用同连接请求', async () => {
  const storage = createStorage()
  const waiting = deferred()
  let calls = 0
  storage.listCommandHistory = async id => { calls++; return id === 'remote' ? waiting.promise : [] }
  const history = useCommandHistory(storage)
  const first = history.loadCommandHistoryForConnection('remote')
  assert.equal(history.loadCommandHistoryForConnection('remote'), first)
  const live = history.recordCommandForConnection('remote', { terminalId: 'tab-a', command: 'pwd', exitCode: 0 })
  const other = history.recordCommandForConnection('local', { terminalId: 'tab-b', command: 'whoami' })
  waiting.resolve([{ ...live }, { ...live, id: 'persisted', command: 'ls' }])
  await first
  await history.loadCommandHistoryForConnection('remote')
  assert.equal(calls, 1)
  assert.deepEqual(history.commandHistoryForConnection('remote').map(row => row.id), [live.id, 'persisted'])
  assert.deepEqual(history.commandHistoryForConnection('local').map(row => row.id), [other.id])
  assert.equal(live.workspaceSessionId, 'connection-history')
  assert.equal(live.exitCode, 0)
  assert.equal('exitCode' in other, false)
})

test('历史加载失败可重试，保存失败保留当前记录与错误证据', async context => {
  const errors = []
  context.mock.method(console, 'error', (...args) => errors.push(args))
  const storage = createStorage()
  let attempts = 0
  storage.listCommandHistory = async () => { if (++attempts === 1) throw Error('load failed'); return [] }
  storage.saveCommandHistoryRecord = async () => { throw Error('save failed') }
  const history = useCommandHistory(storage)
  await history.loadCommandHistoryForConnection('local')
  history.recordCommandForConnection('local', { terminalId: 'tab', command: 'ls' })
  await history.loadCommandHistoryForConnection('local')
  assert.equal(attempts, 2)
  assert.equal(history.commandHistoryForConnection('local').length, 1)
  assert.equal(errors.length, 2)
})

test('敏感命令不进入历史与持久化，限量淘汰不复用记录 ID', context => {
  context.mock.method(Date, 'now', () => 1234)
  const storage = createStorage()
  const history = useCommandHistory(storage)
  assert.equal(history.recordCommandForConnection('local', { terminalId: 'tab', command: 'curl --token secret' }), undefined)
  assert.equal(storage.calls.length, 0)
  const ids = new Set()
  for (let index = 0; index < 305; index++) ids.add(history.recordCommandForConnection('local', { terminalId: 'tab', command: `echo ${index}` }).id)
  assert.equal(ids.size, 305)
  assert.equal(history.commandHistoryForConnection('local').length, 300)
  assert.equal(history.commandHistoryForConnection('local')[0].command, 'echo 5')
})

test('草稿无存储写入，列表载入合并本地草稿并升级同 ID 草稿', async context => {
  const storage = createStorage([session('one')])
  const { sessions } = mountData(context, storage)
  sessions.createDraftWorkspaceSession('local', 'one')
  const draft = sessions.createDraftWorkspaceSession('local', 'two')
  assert.equal(sessions.createDraftWorkspaceSession('remote', 'two').id, draft.id)
  assert.equal(storage.calls.length, 0)
  await Promise.all([sessions.loadWorkspaceSessionList(), sessions.loadWorkspaceSessionList()])
  assert.equal(storage.calls.length, 1)
  assert.deepEqual(sessions.workspaceSessions.value.map(row => row.id), ['two', 'one'])
  assert.equal(sessions.isDraftWorkspaceSession('one'), false)
  assert.equal(sessions.isDraftWorkspaceSession('two'), true)
})

test('列表失败后保留草稿并允许重试，只有成功保存才解除草稿标记', async context => {
  context.mock.method(console, 'error', () => {})
  const storage = createStorage()
  let loads = 0
  storage.listWorkspaceSessions = async () => { if (++loads === 1) throw Error('offline'); return [] }
  const { sessions } = mountData(context, storage)
  sessions.createDraftWorkspaceSession('local', 'one')
  await sessions.loadWorkspaceSessionList()
  assert.equal(sessions.workspaceSessions.value.length, 1)
  await sessions.loadWorkspaceSessionList()
  storage.saveWorkspaceSession = async () => { throw Error('write failed') }
  await assert.rejects(sessions.ensurePersistedWorkspaceSession('local', 'one', '网络检查'), /write failed/)
  assert.equal(sessions.isDraftWorkspaceSession('one'), true)
  storage.saveWorkspaceSession = async () => {}
  await sessions.ensurePersistedWorkspaceSession('local', 'one')
  assert.equal(sessions.isDraftWorkspaceSession('one'), false)
  assert.equal(loads, 2)
})

test('标题、摘要与 Agent 模式更新保留会话来源、手动命名和原排序', async context => {
  const { sessions, storage } = mountData(context, createStorage([session('one'), session('two')]))
  await sessions.loadWorkspaceSessionList()
  await sessions.renameWorkspaceSession('one', ' 手动标题 ')
  const renamed = { ...sessions.workspaceSessionById('one') }
  await sessions.updateWorkspaceSessionTitle('different-host', 'one', 'AI 覆盖标题')
  assert.equal(sessions.workspaceSessionById('one').name, '手动标题')
  await sessions.updateWorkspaceSessionContextSummary('one', '上下文摘要', 'message-8')
  await sessions.setWorkspaceSessionMode('one', 'agent')
  const updated = sessions.workspaceSessionById('one')
  assert.equal(updated.updatedAt, renamed.updatedAt)
  assert.equal(updated.connectionId, 'remote')
  assert.equal(updated.contextSummaryLastMessageId, 'message-8')
  assert.equal(updated.aiMode, 'agent')
  assert.deepEqual(sessions.workspaceSessions.value.map(row => row.id), ['one', 'two'])
  assert.equal(storage.rows.get('one').contextSummary, '上下文摘要')
})

test('草稿重命名、摘要和模式不落库，手动重命名保存错误返回应用壳', async context => {
  const storage = createStorage([session('one')])
  const { sessions, errors } = mountData(context, storage)
  sessions.createDraftWorkspaceSession('local', 'draft')
  await sessions.renameWorkspaceSession('draft', '命名')
  await sessions.updateWorkspaceSessionContextSummary('draft', '摘要', 'last')
  await sessions.setWorkspaceSessionMode('draft', 'agent')
  assert.equal(storage.calls.length, 0)
  await sessions.loadWorkspaceSessionList()
  storage.saveWorkspaceSession = async () => { throw Error('denied') }
  await sessions.renameWorkspaceSession('one', '改名')
  assert.match(errors[0].message, /denied/)
})

test('并发删除等待已接受的元数据写入，并且至少保留一个会话', async context => {
  const storage = createStorage([session('one'), session('two')])
  const waiting = deferred()
  const originalSave = storage.saveWorkspaceSession
  storage.saveWorkspaceSession = async row => { await waiting.promise; return originalSave(row) }
  const { sessions } = mountData(context, storage)
  await sessions.loadWorkspaceSessionList()
  const saving = sessions.renameWorkspaceSession('one', 'updated')
  const removing = sessions.removeWorkspaceSession('one')
  assert.equal(await sessions.removeWorkspaceSession('two'), false)
  assert.equal(storage.calls.some(call => call[0] === 'delete-session'), false)
  waiting.resolve()
  await saving
  assert.equal(await removing, true)
  assert.equal(storage.rows.has('one'), false)
  assert.deepEqual(sessions.workspaceSessions.value.map(row => row.id), ['two'])
})

test('消息载入复用请求，按会话隔离且不覆盖同 ID 的流式新内容', async context => {
  const storage = createStorage([session('one'), session('two')])
  const waiting = deferred()
  storage.listAiConversationMessages = async id => id === 'one' ? waiting.promise : [message('other', { workspaceSessionId: 'two' })]
  const { sessions, messages } = mountData(context, storage)
  await sessions.loadWorkspaceSessionList()
  const first = messages.loadAiSessionState('one')
  assert.equal(messages.loadAiSessionState('one'), first)
  messages.appendAiMessageToActiveTerminal(message('stream', { streaming: true, text: '更新的流式内容' }))
  await messages.loadAiSessionState('two')
  waiting.resolve([message('stream', { text: '旧内容' }), message('saved')])
  await first
  assert.deepEqual(messages.aiMessagesBySession.value.one.map(row => row.id), ['stream', 'saved'])
  assert.equal(messages.aiMessagesBySession.value.one[0].text, '更新的流式内容')
  assert.equal(messages.aiMessagesBySession.value.two[0].id, 'other')
})

test('消息加载失败可重试，草稿升级为已保存会话后可读取存量消息', async context => {
  context.mock.method(console, 'error', () => {})
  const storage = createStorage()
  let attempts = 0
  storage.listAiConversationMessages = async () => { if (++attempts === 1) throw Error('offline'); return [message()] }
  const { sessions, messages } = mountData(context, storage)
  sessions.createDraftWorkspaceSession('local', 'one')
  await messages.loadAiSessionState('one')
  assert.equal(attempts, 0)
  await sessions.ensurePersistedWorkspaceSession('local', 'one')
  await messages.loadAiSessionState('one')
  await messages.loadAiSessionState('one')
  assert.equal(attempts, 2)
  assert.equal(messages.aiMessagesBySession.value.one.length, 1)
})

test('同会话写入串行、不同会话并行，消息正文先于附属元数据保存', async context => {
  const storage = createStorage([session('one', { name: '已命名' }), session('two', { name: '另一个' })])
  const waiting = deferred()
  const started = deferred()
  const originalSave = storage.saveAiConversationMessage
  storage.saveAiConversationMessage = async row => {
    if (row.id === 'first') { started.resolve(); await waiting.promise }
    return originalSave(row)
  }
  const { sessions, messages } = mountData(context, storage)
  await sessions.loadWorkspaceSessionList()
  const first = messages.appendAiMessageToActiveTerminal(message('first'))
  const second = messages.appendAiMessageToActiveTerminal(message('second'))
  await started.promise
  await messages.appendAiMessageToActiveTerminal(message('parallel', { workspaceSessionId: 'two' }))
  assert.deepEqual(storage.calls.filter(call => call[0] === 'save-message').map(call => call[1]), ['parallel'])
  waiting.resolve()
  await Promise.all([first, second])
  assert.deepEqual(storage.calls.filter(call => call[0] === 'save-message').map(call => call[1]), ['parallel', 'first', 'second'])
  for (const id of ['first', 'second']) {
    const index = storage.calls.findIndex(call => call[0] === 'save-message' && call[1] === id)
    assert.equal(storage.calls[index + 1][0], 'save-session')
  }
})

test('流式消息不保存，完成后按入队快照保存，失败不阻塞后续消息', async context => {
  const errors = []
  context.mock.method(console, 'error', (...args) => errors.push(args))
  const storage = createStorage([session('one', { name: '已命名' })])
  const originalSave = storage.saveAiConversationMessage
  storage.saveAiConversationMessage = async row => { if (row.id === 'fail') throw Error('offline'); return originalSave(row) }
  const { sessions, messages } = mountData(context, storage)
  await sessions.loadWorkspaceSessionList()
  const draft = message('reply', { role: 'assistant', streaming: true })
  messages.appendAiMessageToActiveTerminal(draft)
  messages.updateAiMessage({ ...draft, text: '流式中间态' })
  assert.equal(storage.calls.some(call => call[0] === 'save-message'), false)
  await messages.appendAiMessageToActiveTerminal(message('fail'))
  const completed = { ...draft, streaming: false, text: '最终内容' }
  const pending = messages.updateAiMessage(completed)
  completed.text = '调用方后续变更'
  await pending
  assert.equal(errors.length, 1)
  assert.equal(storage.calls.find(call => call[0] === 'save-message')[2].text, '最终内容')
})

test('消息写入完成不回滚期间的会话改名、上下文摘要和模式', async context => {
  const storage = createStorage([session('one', { name: '原有标题' })])
  const waiting = deferred()
  const started = deferred()
  storage.saveAiConversationMessage = async () => { started.resolve(); await waiting.promise }
  const { sessions, messages } = mountData(context, storage)
  await sessions.loadWorkspaceSessionList()
  const writing = messages.appendAiMessageToActiveTerminal(message())
  await started.promise
  await sessions.renameWorkspaceSession('one', '手动新标题')
  await sessions.updateWorkspaceSessionContextSummary('one', '新摘要', 'last')
  await sessions.setWorkspaceSessionMode('one', 'agent')
  waiting.resolve()
  await writing
  assert.equal(storage.rows.get('one').name, '手动新标题')
  assert.equal(storage.rows.get('one').contextSummary, '新摘要')
  assert.equal(storage.rows.get('one').aiMode, 'agent')
})

test('删除等待消息队列，阻止迟到的流式事件、加载结果和上下文复活会话', async context => {
  const storage = createStorage([session('one', { name: '会话一' }), session('two')])
  const waitingWrite = deferred()
  const waitingRead = deferred()
  const started = deferred()
  storage.saveAiConversationMessage = async () => { started.resolve(); await waitingWrite.promise }
  storage.listAiConversationMessages = async () => waitingRead.promise
  const { sessions, messages, history } = mountData(context, storage)
  await sessions.loadWorkspaceSessionList()
  const loading = messages.loadAiSessionState('one')
  history.recordCommandForConnection('remote', { terminalId: 'tab', command: 'pwd' })
  const writing = messages.appendAiMessageToActiveTerminal(message())
  await started.promise
  const removing = messages.deleteAiSession('one')
  assert.equal(messages.deleteAiSession('one'), removing)
  messages.appendAiMessageToActiveTerminal(message('late', { streaming: true }))
  assert.equal(storage.calls.some(call => call[0] === 'delete-session'), false)
  waitingWrite.resolve()
  await writing
  assert.equal(await removing, true)
  waitingRead.resolve([message('old')])
  await loading
  messages.updateAiMessage(message('late-completed'))
  messages.setAiContextForTerminal('remote', 'one', { compressed: true, chars: 50, history: 1 })
  assert.equal(messages.aiMessagesBySession.value.one, undefined)
  assert.equal(messages.aiContextBySession.value.one, undefined)
  assert.equal(storage.rows.has('one'), false)
  assert.equal(history.commandHistoryForConnection('remote').length, 1)
})

test('删除失败保留缓存和草稿，解除阻塞后仍可接受消息', async context => {
  const storage = createStorage([session('one'), session('two')])
  storage.deleteWorkspaceSession = async () => { throw Error('delete failed') }
  const { sessions, messages } = mountData(context, storage)
  await sessions.loadWorkspaceSessionList()
  messages.appendAiMessageToActiveTerminal(message('first', { streaming: true }))
  await assert.rejects(messages.deleteAiSession('one'), /delete failed/)
  messages.appendAiMessageToActiveTerminal(message('after', { streaming: true }))
  assert.deepEqual(messages.aiMessagesBySession.value.one.map(row => row.id), ['first', 'after'])
  assert.equal(sessions.workspaceSessions.value.length, 2)
})

test('卸载忽略迟到的读取与新事件，但已接受的持久化任务仍完成', async context => {
  const storage = createStorage([session('one', { name: '会话' })])
  const waiting = deferred()
  storage.listAiConversationMessages = async () => waiting.promise
  const { sessions, messages, unmount } = mountData(context, storage)
  await sessions.loadWorkspaceSessionList()
  const loading = messages.loadAiSessionState('one')
  const writing = messages.appendAiMessageToActiveTerminal(message('accepted'))
  unmount()
  messages.appendAiMessageToActiveTerminal(message('ignored'))
  waiting.resolve([message('late-loaded')])
  await Promise.all([loading, writing])
  assert.deepEqual(storage.calls.filter(call => call[0] === 'save-message').map(call => call[1]), ['accepted'])
  assert.deepEqual(messages.aiMessagesBySession.value.one.map(row => row.id), ['accepted'])
})

test('消息缓存各保留 300 条，上下文状态按会话而非当前连接划分', context => {
  const { messages } = mountData(context)
  for (let index = 0; index < 305; index++) messages.appendAiMessageToActiveTerminal(message(`turn-${index}`, { streaming: true }))
  messages.appendAiMessageToActiveTerminal(message('other', { workspaceSessionId: 'two', streaming: true }))
  messages.setAiContextForTerminal('remote', 'one', { compressed: true, chars: 100, history: 5 })
  messages.setAiContextForTerminal('remote', 'two', { compressed: false, chars: 10, history: 1 })
  assert.equal(messages.aiMessagesBySession.value.one.length, 300)
  assert.equal(messages.aiMessagesBySession.value.one[0].id, 'turn-5')
  assert.equal(messages.aiMessagesBySession.value.two.length, 1)
  assert.equal(messages.aiContextBySession.value.one.compressed, true)
  assert.equal(messages.aiContextBySession.value.two.compressed, false)
})
