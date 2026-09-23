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
  const modelRequests = []
  const cancellations = []
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
    const api = {
      onAiChatStream: async (_id, listener) => { streamListener = listener; return () => {} },
      cancelTask: async id => {
        cancellations.push(id)
        await options.cancelTask?.(id)
      }
    }
    chat = useAiChat(common, { ...api, chatWithAiProviderStream: options.chatResponse ?? (async () => ({ answer: '完成' })) })
    agent = useAgentSession({
      ...common, askText: ref(''), pendingAgentRiskReview: ref(false), canSendMessage: () => true,
      composerBusy: () => false, selectedTerminalContext: () => undefined,
      scrollMessagesToLatest() {}, closeAiCommandRiskConfirm() {}
    }, {
      ...api, touchAgentCommandAllowlistEntry: async () => {},
      aiAgentTurnStream: async (id, request) => {
        modelRequests.push({ id, request })
        const next = scriptedResponses.shift()
        if (!next) throw Error('Unexpected extra model request')
        return typeof next === 'function' ? next(request) : next
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
    props, commands, saves, events, modelRequests, cancellations, answerState, chat, agent, assistant,
    advance: seconds => { now += seconds * 1000 },
    stream: event => streamListener(event),
    runAgent: () => agent.runAgentTurn(assistant, '检查状态', undefined, 'question'),
    retryAgent: () => {
      const message = props.messages[0]
      const retryStep = message.agentSteps?.findLast(step => step.status === 'failed')
      const pending = {
        ...message, text: '', error: false, errorKind: undefined, stopReason: undefined,
        streaming: true, agentStatus: 'running', payloadJson: undefined,
        agentSteps: message.agentSteps?.filter(step => step.status === 'completed' || step.status === 'skipped')
      }
      emit('updateMessage', pending)
      return agent.runAgentTurn(pending, '检查状态', undefined, 'question', retryStep)
    },
    runChat: () => chat.runChatTurn(assistant, '检查状态', undefined, 'question')
  }
}

test('完成工具后遇到 HTTP 502，响应式消息重试可停止并取消新请求', { timeout: 2000 }, async t => {
  const request = deferred()
  const cancelled = deferred()
  t.after(() => request.resolve(response()))
  const fixture = mountRuntime(t, {
    responses: [response(commandCall('first')), () => { throw Error('HTTP 502') }, () => request.promise],
    cancelTask: id => cancelled.resolve(id)
  })
  const firstRun = fixture.runAgent()
  await until(() => fixture.agent.agentPendingApproval.value)
  fixture.agent.resolveAgentApproval('execute')
  await firstRun
  const failed = fixture.props.messages[0]
  assert.equal(failed.agentStatus, 'error')
  assert.match(failed.text, /HTTP 502/)
  assert.equal(failed.agentSteps[0].status, 'completed')

  const retry = fixture.retryAgent()
  await until(() => fixture.modelRequests.length === 3)
  assert.equal(fixture.agent.agentRunActive.value, true)
  assert.equal(fixture.agent.agentTaskPending(), true)
  assert.equal(fixture.answerState.isAsking.value, true)
  const retriedRequest = fixture.modelRequests[2]
  assert.notEqual(retriedRequest.id, fixture.modelRequests[1].id)
  assert.equal(JSON.parse(retriedRequest.request.turns[1].content).output, 'ok')
  assert.deepEqual(fixture.commands, ['printf status'], '已完成的命令不能重复执行')

  fixture.advance(12)
  fixture.agent.stopAgentRun()
  await retry
  assert.equal(fixture.props.messages[0].id, failed.id)
  assert.equal(fixture.props.messages[0].agentStatus, 'stopped')
  assert.equal(fixture.props.messages[0].streaming, false)
  assert.equal(fixture.props.messages[0].durationSeconds, 12)
  assert.equal(fixture.answerState.isAsking.value, false)
  assert.equal(fixture.answerState.currentAssistantMessageId.value, '')
  assert.equal(fixture.agent.agentTaskPending(), false)
  assert.equal(await cancelled.promise, retriedRequest.id)
  assert.deepEqual(fixture.cancellations, [retriedRequest.id])

  fixture.stream({ kind: 'chunk', delta: '停止后迟到的内容' })
  request.resolve(response(commandCall('late-command')))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fixture.props.messages[0].agentStatus, 'stopped')
  assert.equal(fixture.agent.agentStreamText.value, '')
  assert.deepEqual(fixture.commands, ['printf status'])
})

test('失败命令重试复制响应式风险记录，执行时可停止且不改写旧步骤', { timeout: 2000 }, async t => {
  const commandResult = deferred()
  let commandCancelled = false
  const fixture = mountRuntime(t, { responses: [response(commandCall('failed', 'systemctl restart nginx'))] })
  fixture.props.agentCommandRunner = () => { throw Error('Shell 未就绪') }
  const firstRun = fixture.runAgent()
  await until(() => fixture.agent.agentPendingApproval.value)
  fixture.agent.resolveAgentApproval('execute', true)
  await firstRun
  const failed = fixture.props.messages[0].agentSteps[0]
  assert.equal(failed.status, 'failed')
  assert.ok(failed.risks.length, '覆盖嵌套的 Vue 响应式风险对象')

  fixture.props.agentCommandRunner = (_terminal, command) => {
    fixture.commands.push(command)
    return {
      result: commandResult.promise, peekOutput: () => '',
      cancel: () => { commandCancelled = true; commandResult.resolve({ status: 'cancelled' }) }
    }
  }
  const retry = fixture.retryAgent()
  await until(() => fixture.agent.agentRun.value?.steps[0].deadlineAt)
  assert.deepEqual(fixture.commands, ['systemctl restart nginx'])
  assert.equal(fixture.props.messages[0].agentSteps[0].status, 'running')
  assert.equal(failed.status, 'failed', '重试不能修改之前的响应式步骤')
  assert.deepEqual(fixture.props.messages[0].agentSteps[0].risks, failed.risks)
  fixture.agent.stopAgentRun()
  await retry
  assert.equal(commandCancelled, true)
  assert.equal(fixture.modelRequests.length, 1, '停止后不再请求模型')
  assert.equal(fixture.props.messages[0].agentStatus, 'stopped')
  assert.equal(fixture.answerState.isAsking.value, false)
})

test('重试循环同步启动异常会保存错误并清理忙碌状态，之后仍可重试', { timeout: 2000 }, async t => {
  const fixture = mountRuntime(t, {
    responses: [response(commandCall('first')), () => { throw Error('HTTP 502') }, response()]
  })
  const firstRun = fixture.runAgent()
  await until(() => fixture.agent.agentPendingApproval.value)
  fixture.agent.resolveAgentApproval('execute')
  await firstRun
  t.mock.method(globalThis, 'structuredClone', () => { throw Error('无法恢复步骤快照') }, { times: 1 })
  await fixture.retryAgent()
  const failed = fixture.props.messages[0]
  assert.equal(failed.agentStatus, 'error')
  assert.equal(failed.error, true)
  assert.equal(failed.streaming, false)
  assert.match(failed.text, /无法恢复步骤快照/)
  assert.equal(fixture.answerState.isAsking.value, false)
  assert.equal(fixture.answerState.currentAssistantMessageId.value, '')
  assert.equal(fixture.agent.agentTaskPending(), false)
  assert.equal(fixture.agent.agentRunActive.value, false)
  assert.equal(fixture.agent.agentRunMessageId.value, '')
  const restored = hydrateAiMessagePayload({ ...fixture.assistant, payloadJson: failed.payloadJson })
  assert.equal(restored.agentStatus, 'error')
  assert.equal(restored.errorKind, 'protocol')
  assert.equal(restored.agentSteps[0].output, 'ok')
  assert.ok(fixture.events.some(([event, detail]) => event === 'aiError' && detail.includes('无法恢复步骤快照')))

  await fixture.retryAgent()
  assert.equal(fixture.props.messages[0].agentStatus, 'done')
  assert.deepEqual(fixture.commands, ['printf status'])
})

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

test('Agent 思考过程随 payload 恢复，但不会改写上下文正文', () => {
  const restored = hydrateAiMessagePayload({
    id: 'reasoning',
    mode: 'agent',
    text: '任务已完成',
    payloadJson: JSON.stringify({
      mode: 'agent',
      agentStatus: 'done',
      agentReasoning: '先检查服务状态，再确认配置。',
      agentSteps: []
    })
  })
  assert.equal(restored.agentReasoning, '先检查服务状态，再确认配置。')
  assert.equal(restored.text, '任务已完成')
})
