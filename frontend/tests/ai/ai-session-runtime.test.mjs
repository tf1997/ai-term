import assert from 'node:assert/strict'
import test from 'node:test'
import { createRenderer, nextTick, reactive, ref } from 'vue'
import { useAiAnswerState } from '../../src/domains/ai/application/useAiAnswerState'
import { useAiChat } from '../../src/domains/ai/application/useAiChat'
import { useAgentSession } from '../../src/domains/ai/application/useAgentSession'
import { hydrateAiMessagePayload } from '../../src/domains/ai/domain/workspaceSessions'
import { aiStreamPartialText } from '../../src/domains/ai/domain/aiStreamError'

const renderer = createRenderer({
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
  parentNode: () => null, nextSibling: () => null
})

function deferred() {
  let resolve, reject
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

async function until(condition) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (condition()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('Expected runtime state was not reached')
}

const commandCall = (id, command = 'printf status') => ({ id, name: 'run_command', arguments: JSON.stringify({ command, reason: '查看状态' }) })
const response = (...toolCalls) => ({ text: toolCalls.length ? '查看状态' : '检查完成', toolCalls, contextChars: 0, contextCompressed: false })

function mountRuntime(t, options = {}) {
  const previousWindow = globalThis.window
  globalThis.window = globalThis
  let now = 100_000
  t.mock.method(Date, 'now', () => now)
  const assistant = {
    id: 'answer', workspaceSessionId: 'session', connectionId: 'local', terminalId: 'terminal',
    terminalConnectionGeneration: 1, role: 'assistant', text: '', streaming: true, createdAt: new Date(now).toISOString()
  }
  const commands = []
  const saves = []
  const events = []
  const props = reactive({
    config: { id: 'config', baseUrl: 'https://fixture.invalid/v1', model: 'test', apiKey: 'fixture' },
    apiKey: '', workspaceSessionId: 'session', connectionId: 'local', terminalId: 'terminal',
    terminalConnectionGeneration: 1, terminalSnapshot: '', commandHistory: [], messages: [assistant],
    agentAllowlistPatterns: [], agentBuiltinReadonlyEnabled: false,
    agentCommandRunner: (_terminal, command) => {
      commands.push(command)
      return options.commandHandle ?? {
        result: Promise.resolve({ status: 'completed', output: 'ok', exitCode: 0, durationMs: 50, truncated: false }),
        peekOutput: () => '', cancel() {}
      }
    },
    agentAllowPattern: async (pattern, sourceCommand) => {
      saves.push({ pattern, sourceCommand })
      await options.save?.(pattern, sourceCommand)
    }
  })
  let answerState, chat, agent, streamListener
  const scriptedResponses = options.responses?.slice() ?? [response()]
  const emit = (event, ...args) => {
    events.push([event, ...args])
    if (event === 'updateMessage') props.messages[0] = args[0]
  }
  const app = renderer.createApp({ setup() {
    answerState = useAiAnswerState()
    const common = {
      props, emit, answerState,
      conversationContext: {
        aiCommandHistory: () => [], conversationContextParts: () => ({ unsummarized: [] }),
        maybeGenerateSessionTitle() {}, maybeCompactConversation: async () => {}
      }
    }
    const api = { onAiChatStream: async (_id, listener) => { streamListener = listener; return () => {} }, cancelTask: async () => {} }
    chat = useAiChat(common, { ...api, chatWithAiProviderStream: options.chatResponse ?? (async () => ({ answer: '完成' })) })
    agent = useAgentSession({
      ...common, askText: ref(''), pendingAgentRiskReview: ref(false), canSendMessage: () => true,
      composerBusy: () => false, selectedTerminalContext: () => undefined,
      scrollMessagesToLatest() {}, closeAiCommandRiskConfirm() {}
    }, {
      ...api, touchAgentCommandAllowlistEntry: async () => {},
      aiAgentTurnStream: async () => {
        const next = scriptedResponses.shift()
        if (!next) throw Error('Unexpected extra model request')
        return next
      }
    })
    return () => null
  } })
  app.mount({})
  t.after(async () => {
    agent.stopAgentRun()
    await nextTick()
    app.unmount()
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  })
  return {
    props, commands, saves, events, answerState, chat, agent, assistant,
    advance: seconds => { now += seconds * 1000 },
    stream: event => streamListener(event),
    runAgent: () => agent.runAgentTurn(assistant, '检查状态', undefined, 'question'),
    runChat: () => chat.runChatTurn(assistant, '检查状态', undefined, 'question')
  }
}

test('总是允许等待保存成功，并立即用于同一任务的后续命令', { timeout: 2000 }, async t => {
  const saving = deferred()
  const fixture = mountRuntime(t, {
    save: () => saving.promise,
    responses: [response(commandCall('first')), response(commandCall('second', 'printf finished')), response()]
  })
  const running = fixture.runAgent()
  await until(() => fixture.agent.agentPendingApproval.value)
  fixture.advance(10)
  fixture.agent.resolveAgentApproval('execute-and-allow')
  fixture.agent.resolveAgentApproval('execute-and-allow')
  await until(() => fixture.saves.length === 1)
  assert.equal(fixture.agent.agentApprovalSaving.value, true)
  assert.deepEqual(fixture.commands, [], '保存完成前不派发命令')
  fixture.advance(63)
  saving.resolve()
  await running
  assert.deepEqual(fixture.commands, ['printf status', 'printf finished'])
  assert.equal(fixture.saves.length, 1, '重复点击不能重复保存或执行')
  const message = fixture.props.messages[0]
  assert.equal(message.agentSteps[1].autoApproved, true)
  assert.equal(fixture.agent.agentApprovalSaving.value, false)
  assert.equal(message.durationSeconds, 73, '总耗时包含等待审批与保存的时间')
  assert.equal(fixture.answerState.messageAnswerDuration(message), 73, '重复结束通知不清零')
  const restored = hydrateAiMessagePayload({ ...fixture.assistant, streaming: false, payloadJson: message.payloadJson })
  assert.equal(restored.durationSeconds, 73)
  assert.equal(restored.agentSteps[1].autoApproved, true)
})

test('保存授权失败保留明确的未执行步骤，不派发命令', { timeout: 2000 }, async t => {
  const fixture = mountRuntime(t, { save: async () => { throw Error('disk full') }, responses: [response(commandCall('first'))] })
  const running = fixture.runAgent()
  await until(() => fixture.agent.agentPendingApproval.value)
  fixture.advance(8)
  fixture.agent.resolveAgentApproval('execute-and-allow')
  await running
  assert.deepEqual(fixture.commands, [])
  assert.equal(fixture.props.messages[0].agentStatus, 'error')
  const step = fixture.props.messages[0].agentSteps[0]
  assert.equal(step.status, 'failed')
  assert.equal(step.executionPhase, 'not-started')
  assert.match(step.failureReason, /保存授权失败.*disk full/)
  assert.equal(fixture.props.messages[0].durationSeconds, 8)
  assert.equal(fixture.agent.agentApprovalSaving.value, false)
})

test('仅执行本次不新增授权，后续同类命令仍需确认', { timeout: 2000 }, async t => {
  const fixture = mountRuntime(t, { responses: [response(commandCall('first'), commandCall('second'))] })
  const running = fixture.runAgent()
  await until(() => fixture.agent.agentPendingApproval.value?.proposal.id === 'first')
  fixture.agent.resolveAgentApproval('execute')
  await until(() => fixture.agent.agentPendingApproval.value?.proposal.id === 'second')
  assert.equal(fixture.commands.length, 1)
  assert.deepEqual(fixture.saves, [])
  fixture.agent.stopAgentRun()
  await running
})

for (const command of ['sudo uptime', 'rm -rf /tmp/example', 'cat ~/.ssh/id_rsa']) {
  test(`不可自动授权的命令不能通过总是允许绕过确认：${command}`, { timeout: 2000 }, async t => {
    const fixture = mountRuntime(t, { responses: [response(commandCall('first', command))] })
    const running = fixture.runAgent()
    await until(() => fixture.agent.agentPendingApproval.value)
    fixture.agent.resolveAgentApproval('execute-and-allow')
    await nextTick()
    assert.ok(fixture.agent.agentPendingApproval.value)
    assert.deepEqual(fixture.saves, [])
    assert.deepEqual(fixture.commands, [])
    fixture.agent.stopAgentRun()
    await running
  })
}

test('保存期间停止任务，迟到的保存结果不能派发命令', { timeout: 2000 }, async t => {
  const saving = deferred()
  const fixture = mountRuntime(t, { save: () => saving.promise, responses: [response(commandCall('first'))] })
  const running = fixture.runAgent()
  await until(() => fixture.agent.agentPendingApproval.value)
  fixture.agent.resolveAgentApproval('execute-and-allow')
  await until(() => fixture.saves.length)
  fixture.advance(14)
  fixture.agent.resolveAgentApproval('stop')
  await running
  saving.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(fixture.commands, [])
  assert.equal(fixture.props.messages[0].agentStatus, 'stopped')
  assert.equal(fixture.props.messages[0].durationSeconds, 14)
})

for (const outcome of ['complete', 'error', 'stop']) {
  test(`对话 ${outcome} 的耗时随消息保存，保留用量或中断正文`, { timeout: 2000 }, async t => {
    const request = deferred()
    let called = false
    const fixture = mountRuntime(t, { chatResponse: () => { called = true; return request.promise } })
    const running = fixture.runChat()
    await until(() => called)
    fixture.advance(65)
    if (outcome === 'error') {
      fixture.stream({ kind: 'chunk', delta: '已经收到的正文' })
      fixture.stream({ kind: 'error', error: 'connection reset' })
      request.reject(Error('connection reset'))
    } else {
      if (outcome === 'stop') fixture.chat.stopCurrentAnswer()
      request.resolve({ answer: '完成', usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } })
    }
    await running
    const message = fixture.props.messages[0]
    assert.equal(message.streaming, false)
    assert.equal(message.durationSeconds, 65, '结束时读取实际时间，不依赖最后一次 interval tick')
    const restored = hydrateAiMessagePayload({ ...fixture.assistant, streaming: false, error: message.error, payloadJson: message.payloadJson })
    assert.equal(restored.durationSeconds, 65)
    if (outcome === 'error') assert.equal(aiStreamPartialText(restored), '已经收到的正文')
    if (outcome === 'complete') assert.equal(restored.usage.totalTokens, 25)
    if (outcome === 'stop') assert.match(message.text, /已停止回答/)
  })
}

test('旧消息不伪造耗时，异常耗时不会破坏记录恢复', () => {
  for (const value of [undefined, -1, '60', null]) {
    const restored = hydrateAiMessagePayload({ id: 'legacy', payloadJson: JSON.stringify({ durationSeconds: value }) })
    assert.equal(restored.durationSeconds, undefined)
  }
})
