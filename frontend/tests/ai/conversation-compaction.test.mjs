import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createRenderer, nextTick, reactive, ref } from 'vue'
import { planConversationCompaction } from '../../src/domains/ai/domain/conversationCompaction'
import { useAiConversationContext } from '../../src/domains/ai/application/useAiConversationContext'
import { useAiChat } from '../../src/domains/ai/application/useAiChat'
import { useAgentSession } from '../../src/domains/ai/application/useAgentSession'
import { useAiAnswerState } from '../../src/domains/ai/application/useAiAnswerState'

function messages(count, size = 1000) {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`, workspaceSessionId: 'one', connectionId: 'local', terminalId: 'terminal',
    role: index % 2 ? 'assistant' : 'user', text: `${index}:`.padEnd(size, '文'),
    createdAt: new Date(1_000_000 + index).toISOString()
  }))
}

const renderer = createRenderer({
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
  parentNode: () => null, nextSibling: () => null
})

function mountConversation(t, options = {}, extraSetup = () => ({})) {
  const calls = []
  const events = []
  const summarySaved = deferred()
  const props = reactive({
    config: { id: 'config', baseUrl: 'https://example.invalid/v1', model: 'test', apiKey: 'test-key' },
    apiKey: '', workspaceSessionId: 'one', connectionId: 'local', terminalId: 'terminal',
    terminalConnectionGeneration: 1, terminalSnapshot: '', commandHistory: [],
    workspaceSessions: [{ id: 'one', name: '已命名会话' }], messages: messages(8),
    ...options.props
  })
  const emit = (event, ...args) => {
    events.push([event, ...args])
    if (event === 'updateSessionContextSummary') {
      const session = props.workspaceSessions.find((item) => item.id === args[0])
      if (session) Object.assign(session, { contextSummary: args[1], contextSummaryLastMessageId: args[2] })
      summarySaved.resolve(args)
    }
    if (event === 'updateMessage') {
      const index = props.messages.findIndex((message) => message.id === args[0].id)
      if (index >= 0) props.messages[index] = args[0]
    }
  }
  const source = {
    generateAiSessionTitle: async () => { throw Error('已命名会话不应请求标题') },
    compressAiConversation: async (request) => {
      calls.push(structuredClone(request))
      return options.compress
        ? options.compress(request)
        : { summary: '已排查 nginx，下一步检查上游服务。', sourceCount: request.messages.length }
    }
  }
  let conversation, extra
  const app = renderer.createApp({ setup() {
    conversation = useAiConversationContext(props, emit, source)
    extra = extraSetup({ props, emit, conversation })
    return () => null
  } })
  app.mount({})
  let unmounted = false
  const unmount = () => { if (!unmounted) { unmounted = true; app.unmount() } }
  t.after(unmount)
  return { props, calls, events, conversation, extra, unmount, summarySaved: summarySaved.promise }
}

function deferred() {
  let resolve
  const promise = new Promise((accept) => { resolve = accept })
  return { promise, resolve }
}

test('长消息提前摘要,短对话不增加后台请求,最近两组问答保持原文', () => {
  assert.equal(planConversationCompaction(messages(8, 50)), undefined)
  assert.equal(planConversationCompaction(messages(23, 50)), undefined)
  assert.equal(planConversationCompaction(messages(2, 10_000)), undefined, '最新问答不能被整体吞进摘要')
  const source = messages(8)
  const snapshot = structuredClone(source)
  const plan = planConversationCompaction(source)
  assert.deepEqual(plan.messages.map((message) => message.content), source.slice(0, 4).map((message) => message.text))
  assert.equal(plan.lastMessageId, source[3].id)
  assert.deepEqual(source, snapshot)
  assert.equal(planConversationCompaction(messages(24, 50)).lastMessageId, 'message-7')
})

test('压缩批次从最早消息开始,不跨过因请求预算未送出的内容', () => {
  const source = messages(50, 1400)
  source[0].text = '原始目标：修复 nginx 502。' + '日志'.repeat(2000) + '最后结论：上游超时。'
  const plan = planConversationCompaction(source)
  assert.ok(plan.messages[0].content.startsWith('原始目标：修复 nginx 502。'))
  assert.ok(plan.messages[0].content.endsWith('最后结论：上游超时。'))
  assert.ok(plan.messages.length < source.length - 4, '一批装不下全部历史时保留后续批次')
  assert.equal(plan.lastMessageId, source[plan.messages.length - 1].id)
  assert.equal(source[plan.messages.length].role, 'user', '不会把问题与答案拆到两侧')
  assert.ok(plan.messages.reduce((sum, message) => sum + Array.from(message.content).length + 5, 0) <= 12_000)
})

test('Agent 摘要包含执行结果,敏感命令及输出不进入后台摘要', () => {
  const source = messages(8)
  source[1].mode = 'agent'
  source[1].agentSteps = [
    { command: 'nginx -t', status: 'completed', exitCode: 1, output: 'configuration test failed' },
    { command: 'secret-command', status: 'completed', exitCode: 0, output: 'secret-output', sensitive: true }
  ]
  const content = planConversationCompaction(source).messages[1].content
  assert.match(content, /nginx -t/)
  assert.match(content, /退出码：1/)
  assert.match(content, /configuration test failed/)
  assert.ok(!content.includes('secret-command') && !content.includes('secret-output'))
  assert.ok(Array.from(content).length <= 1500)
})

test('前端批次预算不超过后端限制,Unicode 摘录不拆开代理对', () => {
  const frontend = readFileSync(new URL('../../src/domains/ai/domain/conversationCompaction.ts', import.meta.url), 'utf8')
  const backend = readFileSync(new URL('../../../src-tauri/src/domain/ai/chat.rs', import.meta.url), 'utf8')
  for (const name of ['MAX_CONVERSATION_CHARS', 'MAX_COMPACT_SOURCE_MESSAGE_CHARS', 'MAX_COMPACT_SOURCE_TOTAL_CHARS']) {
    const value = (source) => Number(new RegExp(`${name}[^=]*= ([\\d_]+)`).exec(source)[1].replaceAll('_', ''))
    assert.ok(value(frontend) <= value(backend), `${name} 必须遵守后端预算`)
  }
  const source = messages(8, 2100)
  source[0].text = '😀'.repeat(2100)
  const content = planConversationCompaction(source).messages[0].content
  assert.ok(content.startsWith('😀') && content.endsWith('😀'))
  assert.ok(Array.from(content).length <= 1500)
  assert.equal(content.replaceAll('😀', '').replace('\n[中间内容已省略]\n', ''), '')
})

test('摘要与截止 ID 恢复后复用,后续消息只压缩新增的旧历史', async (t) => {
  const first = mountConversation(t)
  await first.conversation.maybeCompactConversation('one')
  assert.equal(first.calls.length, 1)
  const saved = JSON.parse(JSON.stringify(first.props.workspaceSessions))
  const restored = mountConversation(t, { props: { workspaceSessions: saved } })
  assert.equal(restored.conversation.conversationContextParts('one').unsummarized[0].id, 'message-4')
  await restored.conversation.maybeCompactConversation('one')
  assert.equal(restored.calls.length, 0, '重开会话不重复生成同一份摘要')
  restored.props.messages = messages(12)
  await restored.conversation.maybeCompactConversation('one')
  assert.equal(restored.calls[0].previousSummary, saved[0].contextSummary)
  assert.ok(restored.calls[0].messages[0].content.startsWith('4:'))
  assert.equal(restored.props.workspaceSessions[0].contextSummaryLastMessageId, 'message-7')
})

test('同一会话只发一条在途压缩请求,切换会话后仍更新原会话', async (t) => {
  const pending = deferred()
  const fixture = mountConversation(t, { compress: () => pending.promise })
  const first = fixture.conversation.maybeCompactConversation('one')
  const second = fixture.conversation.maybeCompactConversation('one')
  await nextTick()
  assert.equal(fixture.calls.length, 1)
  fixture.props.workspaceSessionId = 'two'
  fixture.props.messages = []
  fixture.props.workspaceSessions.push({ id: 'two', name: '另一个会话' })
  pending.resolve({ summary: '原会话的摘要', sourceCount: 4 })
  await Promise.all([first, second])
  assert.equal(fixture.props.workspaceSessions[0].contextSummary, '原会话的摘要')
  assert.equal(fixture.props.workspaceSessions[1].contextSummary, undefined)
})

test('失败、来源数量不匹配和旧响应都不推进压缩截止 ID', async (t) => {
  t.mock.method(console, 'error', () => {})
  let attempts = 0
  const fixture = mountConversation(t, { compress: async (request) => {
    if (++attempts === 1) throw Error('offline')
    return { summary: '摘要', sourceCount: attempts === 2 ? 0 : request.messages.length }
  } })
  await fixture.conversation.maybeCompactConversation('one')
  await fixture.conversation.maybeCompactConversation('one')
  assert.equal(fixture.props.workspaceSessions[0].contextSummaryLastMessageId, undefined)
  await fixture.conversation.maybeCompactConversation('one')
  assert.equal(fixture.props.workspaceSessions[0].contextSummaryLastMessageId, 'message-3')

  const pending = deferred()
  const stale = mountConversation(t, { compress: () => pending.promise })
  const running = stale.conversation.maybeCompactConversation('one')
  await nextTick()
  Object.assign(stale.props.workspaceSessions[0], { contextSummary: '更新的摘要', contextSummaryLastMessageId: 'message-5' })
  pending.resolve({ summary: '过时摘要', sourceCount: 4 })
  await running
  assert.equal(stale.props.workspaceSessions[0].contextSummary, '更新的摘要')
  assert.equal(stale.props.workspaceSessions[0].contextSummaryLastMessageId, 'message-5')
})

test('重试被摘要覆盖的旧问题时不会提前看到后续结论,其他会话消息不混入', (t) => {
  const fixture = mountConversation(t, { props: {
    workspaceSessions: [{ id: 'one', contextSummary: '未来结论', contextSummaryLastMessageId: 'message-5' }]
  } })
  fixture.props.messages.push({ ...messages(1)[0], id: 'foreign', workspaceSessionId: 'two' })
  const retry = fixture.conversation.conversationContextParts('one', 'message-2')
  assert.equal(retry.summary, '')
  assert.deepEqual(retry.unsummarized.map((message) => message.id), ['message-0', 'message-1'])
  const latest = fixture.conversation.conversationContextParts('one')
  assert.equal(latest.summary, '未来结论')
  assert.deepEqual(latest.unsummarized.map((message) => message.id), ['message-6', 'message-7'])
  fixture.props.messages[5].streaming = true
  const anchorRetry = fixture.conversation.conversationContextParts('one', 'message-4')
  assert.equal(anchorRetry.summary, '', '截止消息进入重试流式状态也不能泄漏后续结论')
  assert.deepEqual(anchorRetry.unsummarized.map((message) => message.id), ['message-0', 'message-1', 'message-2', 'message-3'])
})

for (const mode of ['chat', 'agent']) {
  test(`${mode} 完成后使用最新消息触发持久摘要`, { timeout: 1000 }, async (t) => {
    const previousWindow = globalThis.window
    globalThis.window = globalThis
    const source = messages(8)
    source[7].text = ''
    source[7].streaming = true
    const fixture = mountConversation(t, { props: {
      messages: source, agentCommandRunner: () => { throw Error('无工具调用时不应执行命令') }
    } }, ({ props, emit, conversation }) => {
      const answerState = useAiAnswerState()
      const common = { props, emit, answerState, conversationContext: conversation }
      const api = { onAiChatStream: async () => () => {}, cancelTask: async () => {} }
      if (mode === 'chat') return useAiChat(common, {
        ...api, chatWithAiProviderStream: async () => ({ answer: '结论'.repeat(500), contextCompressed: false, contextChars: 0, historyCount: 0 })
      })
      return useAgentSession({
        ...common, askText: ref(''), pendingAgentRiskReview: ref(false), canSendMessage: () => true,
        composerBusy: () => false, selectedTerminalContext: () => undefined,
        scrollMessagesToLatest() {}, closeAiCommandRiskConfirm() {}
      }, {
        ...api, touchAgentCommandAllowlistEntry: async () => {},
        aiAgentTurnStream: async () => ({ text: '结论'.repeat(500), toolCalls: [], contextCompressed: false, contextChars: 0 })
      })
    })
    try {
      const method = mode === 'chat' ? fixture.extra.runChatTurn : fixture.extra.runAgentTurn
      await method(source[7], source[6].text, undefined, source[6].id)
      await fixture.summarySaved
      assert.equal(fixture.props.messages[7].streaming, false)
      assert.equal(fixture.calls.length, 1)
      assert.equal(fixture.props.workspaceSessions[0].contextSummaryLastMessageId, 'message-3')
    } finally {
      fixture.unmount()
      if (previousWindow === undefined) delete globalThis.window
      else globalThis.window = previousWindow
    }
  })
}
