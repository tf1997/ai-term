import assert from 'node:assert/strict'
import test from 'node:test'
import { createRenderer, nextTick, reactive, ref } from 'vue'
import { useAiAnswerState } from '../../src/domains/ai/application/useAiAnswerState'
import { useAiChat } from '../../src/domains/ai/application/useAiChat'
import { useAgentSession } from '../../src/domains/ai/application/useAgentSession'
import { hydrateAiMessagePayload } from '../../src/domains/ai/domain/workspaceSessions'
import { aiStreamPartialText } from '../../src/domains/ai/domain/aiStreamError'
import { commandRiskCases } from '../shared/command-risk-cases.mjs'
import { agentDisplayTimeline, normalizeAgentTimeline } from '../../src/domains/ai/domain/agentTimeline'

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
    if (event === 'appendMessage') props.messages.push(args[0])
    if (event === 'updateMessage') {
      const index = props.messages.findIndex(message => message.id === args[0].id)
      if (index >= 0) props.messages[index] = args[0]
    }
  }
  const app = renderer.createApp({ setup() {
    answerState = useAiAnswerState()
    const common = {
      props, emit, answerState, hostKnowledgeContext: options.hostKnowledgeContext, terminalContextMode: () => options.terminalContextMode ?? 'auto',
      conversationContext: {
        aiCommandHistory: () => options.commandHistory ?? [], conversationContextParts: () => ({ unsummarized: [] }),
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
      ...api, ...options.checkpoints, touchAgentCommandAllowlistEntry: async () => {},
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
    runAgent: () => agent.runAgentTurn(assistant, '检查状态', options.selection, 'question'),
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
    runChat: () => chat.runChatTurn(assistant, '检查状态', options.selection, 'question')
  }
}

function checkpointFixture() {
  const saved = [], starts = [], released = []
  let sequence = 0
  const api = {
    agentCheckpointTarget: async () => ({ sessionId: 'terminal', sessionInstance: 'instance', profileId: 'local', routeVersion: 0, contextVersion: 1, context: { shell: 'bash', workingDirectory: '/tmp', user: 'user', environmentScope: 'fixture' } }),
    beginAgentRun: async (_target, start) => { starts.push(start); return { runId: start.runId, token: 'memory-owner', sequence: 0 } },
    saveAgentCheckpoint: async (_lease, update) => { assert.equal(update.expectedSequence, sequence); saved.push(structuredClone(update)); return ++sequence },
    releaseAgentRun: async lease => { released.push(lease.runId) },
    listAgentCheckpoints: async () => []
  }
  return { api, saved, starts, released }
}
test('Agent session creates a separate checkpoint record with the original goal and persists all tool boundaries without provider settings', async t => {
  const checkpoints = checkpointFixture()
  const f = mountRuntime(t, { checkpoints: checkpoints.api, responses: [response(commandCall('one')), response()] })
  const running = f.runAgent()
  await until(() => Boolean(f.agent.agentPendingApproval.value))
  assert.equal(checkpoints.starts[0].goal, '检查状态')
  assert.equal(f.commands.length, 0)
  f.agent.resolveAgentApproval('execute')
  await running
  assert.deepEqual(f.commands, ['printf status'])
  assert.ok(checkpoints.saved.some(record => record.boundary === 'before-dispatch'))
  assert.equal(checkpoints.saved.at(-1).boundary, 'finished')
  assert.equal(checkpoints.saved.at(-1).state.steps[0].exitCode, 0)
  assert.ok(!/apiKey|baseUrl|memory-owner|allowlistPatterns/.test(JSON.stringify(checkpoints.saved)))
  assert.equal(checkpoints.released.length, 1)
})
test('checkpoint startup failure prevents both model requests and command execution', async t => {
  const checkpoints = checkpointFixture()
  checkpoints.api.beginAgentRun = async () => { throw Error('database unavailable') }
  const f = mountRuntime(t, { checkpoints: checkpoints.api })
  await f.runAgent()
  assert.equal(f.modelRequests.length, 0); assert.equal(f.commands.length, 0)
  assert.match(f.props.messages[0].text, /database unavailable/)
  assert.equal(JSON.parse(f.props.messages[0].payloadJson).payloadVersion, 2)
})
test('stopping while acquiring checkpoint ownership does not begin a late model request and releases the eventual owner', async t => {
  const pending = deferred(), checkpoints = checkpointFixture()
  const begin = checkpoints.api.beginAgentRun
  checkpoints.api.beginAgentRun = async (...args) => { await pending.promise; return begin(...args) }
  const f = mountRuntime(t, { checkpoints: checkpoints.api })
  const running = f.runAgent(); await until(() => f.agent.agentTaskPending())
  await new Promise(resolve => setImmediate(resolve))
  f.agent.stopAgentRun(); pending.resolve(); await running
  assert.equal(f.modelRequests.length, 0); assert.equal(f.commands.length, 0)
  assert.equal(checkpoints.released.length, 1)
})

for (const mode of ['auto', 'selection', 'none']) {
  for (const kind of ['chat', 'agent']) {
    test(`${kind} 终端上下文 ${mode} 只发送允许的内容`, async t => {
      let request
      const fixture = mountRuntime(t, {
        terminalContextMode: mode,
        commandHistory: ['uptime'],
        selection: { terminalId: 'terminal', text: 'SELECTED_OUTPUT', startLine: 1, endLine: 2 },
        chatResponse: async (_id, value) => { request = value; return { answer: '完成' } }
      })
      fixture.props.terminalSnapshot = 'FULL_TERMINAL_OUTPUT'
      if (kind === 'chat') await fixture.runChat()
      else { await fixture.runAgent(); request = fixture.modelRequests[0].request }
      assert.equal(request.terminalSnapshot, mode === 'auto' ? 'FULL_TERMINAL_OUTPUT' : '')
      assert.deepEqual(request.commandHistory, mode === 'auto' ? ['uptime'] : [])
      assert.equal((request.question ?? request.goal).includes('SELECTED_OUTPUT'), mode !== 'none')
    })
  }
}

test('仅选区无选中内容时不退回终端快照，Agent 后续轮次保持请求时的选择', async t => {
  const options = { terminalContextMode: 'selection', commandHistory: ['uptime'], responses: [response(commandCall('first')), response()] }
  const fixture = mountRuntime(t, options)
  fixture.props.terminalSnapshot = 'FULL_TERMINAL_OUTPUT'
  const running = fixture.runAgent()
  await until(() => fixture.agent.agentPendingApproval.value)
  options.terminalContextMode = 'auto'
  fixture.agent.resolveAgentApproval('execute')
  await running
  for (const { request } of fixture.modelRequests) {
    assert.equal(request.terminalSnapshot, '')
    assert.deepEqual(request.commandHistory, [])
    assert.equal(request.goal, '检查状态')
  }
  assert.equal(JSON.parse(fixture.modelRequests[1].request.turns[1].content).output, 'ok')
})

test('复合命令按整条内容授权，同会话相同命令自动执行，变化后重新确认', { timeout: 2000 }, async t => {
  const command = 'printf status; printf complete'
  const fixture = mountRuntime(t, { responses: [response(commandCall('first', command)), response(commandCall('same', command)), response(commandCall('changed', command + ' | head -1')), response(commandCall('reconnected', command))] })
  const running = fixture.runAgent()
  await until(() => fixture.agent.agentPendingApproval.value)
  assert.deepEqual(fixture.agent.agentPendingApproval.value.proposal.suggestedPatterns, ['printf'])
  fixture.agent.resolveAgentApproval('execute-and-allow-exact')
  await until(() => fixture.agent.agentPendingApproval.value?.proposal.id === 'changed')
  assert.deepEqual(fixture.commands, [command, command])
  assert.equal(fixture.props.messages[0].agentSteps[1].autoApproved, true)
  assert.equal(fixture.agent.agentSessionGrantCount.value, 1)
  assert.deepEqual(fixture.saves, [], '完整命令只在内存授权，不写入前缀允许列表')
  fixture.agent.stopAgentRun()
  await running
  fixture.props.terminalConnectionGeneration++
  await nextTick()
  assert.equal(fixture.agent.agentSessionGrantCount.value, 0)
  fixture.props.terminalConnectionGeneration--
  await nextTick()
  assert.equal(fixture.agent.agentSessionGrantCount.value, 0, '返回之前的会话标识也不会恢复旧授权')
  const reconnected = fixture.runAgent()
  await until(() => fixture.agent.agentPendingApproval.value?.proposal.id === 'reconnected')
  assert.deepEqual(fixture.commands, [command, command])
  fixture.agent.stopAgentRun()
  await reconnected
})

test('撤销会话授权后相同命令需要重新确认', { timeout: 2000 }, async t => {
  const command = 'printf status; printf complete'
  const later = deferred()
  t.after(() => later.resolve(response()))
  const fixture = mountRuntime(t, { responses: [response(commandCall('first', command)), () => later.promise] })
  const running = fixture.runAgent()
  await until(() => fixture.agent.agentPendingApproval.value)
  fixture.agent.resolveAgentApproval('execute-and-allow-exact')
  await until(() => fixture.modelRequests.length === 2)
  fixture.agent.revokeSessionCommandGrants()
  later.resolve(response(commandCall('again', command)))
  await until(() => fixture.agent.agentPendingApproval.value?.proposal.id === 'again')
  assert.deepEqual(fixture.commands, [command])
  fixture.agent.stopAgentRun()
  await running
})

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
  await until(() => fixture.agent.agentPendingApproval.value)
  assert.deepEqual(fixture.commands, [], '失败重试不能复用之前的批准')
  fixture.agent.resolveAgentApproval('execute', true)
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

for (const command of ['sudo uptime', 'rm -rf /tmp/example', 'cat ~/.ssh/id_rsa', 'echo !!', 'PATH=/tmp/bin date', 'echo ok > /tmp/file']) {
  test(`不可自动授权的命令不能通过总是允许绕过确认：${command}`, { timeout: 2000 }, async t => {
    const fixture = mountRuntime(t, { responses: [response(commandCall('first', command))] })
    const running = fixture.runAgent()
    await until(() => fixture.agent.agentPendingApproval.value)
    fixture.agent.resolveAgentApproval('execute-and-allow')
    fixture.agent.resolveAgentApproval('execute-and-allow-exact')
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

for (const outcome of ['complete', 'error', 'stop']) {
  test(`普通对话 ${outcome} 独立保存推理，不混入正文或命令`, async t => {
    const request = deferred()
    t.after(() => request.resolve({ answer: '正文' }))
    let called = false
    const fixture = mountRuntime(t, { chatResponse: () => { called = true; return request.promise } })
    const running = fixture.runChat()
    await until(() => called)
    fixture.stream({ kind: 'reasoning', delta: '**内部分析**\n```bash\nprintf analysis\n```' })
    fixture.stream({ kind: 'chunk', delta: '正常回复。' })
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(fixture.props.messages[0].text, '正常回复。')
    assert.ok(fixture.props.messages[0].reasoning.includes('内部分析'))
    // Cover pending deltas that have not yet reached the throttled render update.
    fixture.stream({ kind: 'reasoning', delta: '\n最后一段推理' })
    if (outcome === 'error') request.reject(Error('connection reset'))
    else {
      if (outcome === 'stop') fixture.chat.stopCurrentAnswer()
      request.resolve({ answer: '正常回复。' })
    }
    await running
    const message = fixture.props.messages[0]
    assert.ok(message.reasoning.endsWith('最后一段推理'))
    assert.ok(!message.text.includes('内部分析'))
    assert.equal(message.command || '', '')
    assert.equal(hydrateAiMessagePayload({ ...fixture.assistant, payloadJson: message.payloadJson }).reasoning, message.reasoning)
    if (outcome === 'error') assert.equal(aiStreamPartialText(message), '正常回复。')
  })
}

test('普通对话重新请求时不保留上次推理', async t => {
  const fixture = mountRuntime(t)
  fixture.assistant.reasoning = '旧推理'
  fixture.assistant.payloadJson = JSON.stringify({ reasoning: '旧推理' })
  await fixture.runChat()
  assert.equal(fixture.props.messages[0].reasoning, undefined)
  assert.equal(JSON.parse(fixture.props.messages[0].payloadJson).reasoning, undefined)
})

test('旧消息不伪造耗时，异常耗时不会破坏记录恢复', () => {
  for (const value of [undefined, -1, '60', null]) {
    const restored = hydrateAiMessagePayload({ id: 'legacy', payloadJson: JSON.stringify({ durationSeconds: value }) })
    assert.equal(restored.durationSeconds, undefined)
  }
})

for (const outcome of ['complete', 'error', 'stop']) {
  test(`Agent ${outcome} 保留多轮推理和工具前文字，清理运行状态后仍可恢复`, { timeout: 2000 }, async t => {
    const first = deferred()
    const second = deferred()
    const fixture = mountRuntime(t, { responses: [() => first.promise, () => second.promise] })
    const running = fixture.runAgent()
    await until(() => fixture.modelRequests.length === 1)
    fixture.stream({ kind: 'reasoning', delta: '先分析服务状态。' })
    fixture.stream({ kind: 'chunk', delta: '接下来检查服务。' })
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.deepEqual(agentDisplayTimeline(fixture.props.messages[0]).map(entry => entry.kind), ['thinking', 'text'])
    assert.equal(agentDisplayTimeline(fixture.props.messages[0])[0].text, '先分析服务状态。')
    assert.equal(agentDisplayTimeline(fixture.props.messages[0])[1].text, '接下来检查服务。')
    first.resolve({ ...response(commandCall('inspect')), text: '接下来检查服务。' })
    await until(() => fixture.agent.agentPendingApproval.value)
    fixture.agent.resolveAgentApproval('execute')
    await until(() => fixture.modelRequests.length === 2)
    fixture.stream({ kind: 'reasoning', delta: '再核对执行结果。' })
    assert.deepEqual(agentDisplayTimeline(fixture.props.messages[0]).map(entry => entry.kind), ['thinking', 'text', 'tool', 'thinking'])
    assert.ok(!JSON.stringify(fixture.modelRequests[1].request).includes('先分析服务状态。'))
    if (outcome === 'error') second.reject(Error('HTTP 502'))
    else if (outcome === 'stop') fixture.agent.stopAgentRun()
    else second.resolve({ ...response(), text: '最终总结。' })
    await running
    if (outcome === 'stop') second.resolve(response())
    const message = fixture.props.messages[0]
    assert.equal(message.agentStatus, { complete: 'done', error: 'error', stop: 'stopped' }[outcome])
    assert.equal(fixture.agent.agentReasoningText.value, '')
    assert.equal(fixture.agent.agentStreamText.value, '')
    assert.equal(fixture.agent.agentRunMessageId.value, '')
    for (const text of ['先分析服务状态。', '接下来检查服务。', '再核对执行结果。']) {
      assert.ok(message.agentReasoning.includes(text))
      assert.equal(message.agentReasoning.split(text).length, 2, '过程文字不能重复保存')
    }
    assert.ok(!message.agentReasoning.includes('最终总结。'))
    const restored = hydrateAiMessagePayload({ ...fixture.assistant, payloadJson: message.payloadJson })
    assert.equal(restored.agentReasoning, message.agentReasoning)
    assert.deepEqual(agentDisplayTimeline(restored).map(entry => entry.kind), ['thinking', 'text', 'tool', 'thinking'])
    assert.deepEqual(restored.agentTimeline, message.agentTimeline)
  })
}

test('Agent 无推理事件时保留工具前文字，重试也保留之前的过程', { timeout: 2000 }, async t => {
  const fixture = mountRuntime(t, {
    responses: [
      { ...response(commandCall('inspect')), text: '检查服务状态。' },
      () => { throw Error('HTTP 502') },
      response()
    ]
  })
  const running = fixture.runAgent()
  await until(() => fixture.agent.agentPendingApproval.value)
  fixture.agent.resolveAgentApproval('execute')
  await running
  assert.equal(fixture.props.messages[0].agentReasoning.trim(), '检查服务状态。')
  await fixture.retryAgent()
  const message = fixture.props.messages[0]
  assert.equal(message.agentStatus, 'done')
  assert.equal(message.agentReasoning.trim(), '检查服务状态。')
  assert.equal(hydrateAiMessagePayload({ ...fixture.assistant, payloadJson: message.payloadJson }).agentReasoning, message.agentReasoning)
})

test('Agent 多轮及同轮多工具按发生顺序展示，最终回复不重复', { timeout: 2000 }, async t => {
  const last = deferred()
  const fixture = mountRuntime(t, { responses: [
    { ...response(commandCall('first'), commandCall('second')), text: '先做两项检查。' },
    { ...response(commandCall('third')), text: '根据结果继续检查。' },
    () => last.promise
  ] })
  const running = fixture.runAgent()
  for (const id of ['first', 'second', 'third']) {
    await until(() => fixture.agent.agentPendingApproval.value?.proposal.id === id)
    fixture.agent.resolveAgentApproval('execute')
  }
  await until(() => fixture.modelRequests.length === 3)
  fixture.stream({ kind: 'reasoning', delta: '核对三项结果。' })
  fixture.stream({ kind: 'chunk', delta: '全部正常。' })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.match(agentDisplayTimeline(fixture.props.messages[0]).at(-1).text, /全部正常。/)
  last.resolve({ ...response(), text: '全部正常。' })
  await running
  const message = fixture.props.messages[0]
  const display = agentDisplayTimeline(message)
  assert.deepEqual(display.map(entry => entry.kind === 'tool' ? entry.step.id : entry.text), [
    '先做两项检查。', 'first', 'second', '根据结果继续检查。', 'third', '核对三项结果。'
  ])
  assert.equal(message.text, '全部正常。')
  assert.deepEqual(JSON.parse(JSON.stringify(agentDisplayTimeline(hydrateAiMessagePayload({ ...fixture.assistant, payloadJson: message.payloadJson })))), JSON.parse(JSON.stringify(display)))
})

test('Agent 旧记录不伪造轮次，损坏时间线不影响工具显示', () => {
  const message = { mode: 'agent', agentReasoning: '旧的合并思考', agentSteps: [{ id: 'first' }, { id: 'second' }] }
  const display = agentDisplayTimeline(message)
  assert.equal(display[0].legacy, true)
  assert.deepEqual(display.map(entry => entry.kind), ['thinking', 'tool', 'tool'])
  assert.equal(normalizeAgentTimeline(null), undefined)
  const timeline = normalizeAgentTimeline([null, {}, { kind: 'thinking', id: 'bad', text: 42 },
    { kind: 'tool', id: 'one', stepId: 'first' }, { kind: 'tool', id: 'one', stepId: 'first' },
    { kind: 'tool', id: 'missing', stepId: 'missing' }])
  assert.deepEqual(agentDisplayTimeline({ ...message, agentTimeline: timeline }).map(entry => entry.step.id), ['first', 'second'])
})

test('Agent 流式增量合并显示更新，结束时完整保存且定时器不覆盖终态', async t => {
  const request = deferred()
  t.after(() => request.resolve(response()))
  const fixture = mountRuntime(t, { responses: [() => request.promise] })
  const running = fixture.runAgent()
  await until(() => fixture.modelRequests.length === 1)
  const updates = () => fixture.events.filter(([type]) => type === 'updateMessage').length
  const before = updates()
  for (let i = 0; i < 1000; i++) fixture.stream({ kind: 'reasoning', delta: 'x' })
  assert.equal(updates() - before, 1, '首个增量立即显示，其余合并')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(updates() - before, 2)
  fixture.stream({ kind: 'reasoning', delta: '结束' })
  request.resolve(response())
  await running
  const finalMessage = fixture.props.messages[0]
  assert.equal(finalMessage.agentReasoning, 'x'.repeat(1000) + '结束')
  const finishedUpdates = updates()
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(updates(), finishedUpdates)
  assert.equal(fixture.props.messages[0].agentStatus, 'done')
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

for (const withTool of [false, true]) {
  test(`Agent 主动提问后释放终端和输入状态,等待状态可恢复 (${withTool ? '已有步骤' : '首次澄清'})`, async t => {
    const question = '找到 A 和 B 两个目标，需要处理哪一个？'
    const ask = response({ id: 'ask', name: 'ask_user', arguments: JSON.stringify({ question }) })
    const fixture = mountRuntime(t, { responses: withTool ? [response(commandCall('inspect')), ask] : [ask] })
    const takeover = []
    fixture.props.agentTakeoverChange = (terminal, active) => takeover.push([terminal, active])
    const running = fixture.runAgent()
    if (withTool) {
      await until(() => fixture.agent.agentPendingApproval.value)
      fixture.agent.resolveAgentApproval('execute')
    }
    await running
    const message = fixture.props.messages[0]
    assert.equal(message.agentStatus, 'waiting-input')
    assert.equal(message.text, question)
    assert.equal(message.error, false)
    assert.equal(message.streaming, false)
    assert.equal(fixture.answerState.isAsking.value, false)
    assert.equal(fixture.agent.agentRunActive.value, false)
    assert.equal(fixture.agent.agentTaskPending(), false)
    assert.equal(fixture.agent.agentRunStatusLabel(message), '等待你的回复')
    assert.deepEqual(takeover, [['terminal', true], ['terminal', false]])
    assert.equal(message.agentSteps.length, withTool ? 1 : 0)
    const restored = hydrateAiMessagePayload({ ...fixture.assistant, text: message.text, payloadJson: message.payloadJson })
    assert.equal(restored.agentStatus, 'waiting-input')
    assert.equal(restored.text, question)
  })
}

for (const { name, command, patterns } of commandRiskCases) {
  test(`Agent 实际审批入口不能被旧允许项绕过：${name}`, { timeout: 2000 }, async t => {
    const fixture = mountRuntime(t, { responses: [response(commandCall('risk', command))] })
    fixture.props.agentAllowlistPatterns = patterns
    fixture.props.agentBuiltinReadonlyEnabled = true
    const running = fixture.runAgent()
    await until(() => fixture.agent.agentPendingApproval.value)
    assert.ok(fixture.agent.agentPendingApproval.value.proposal.risks.length)
    fixture.agent.resolveAgentApproval('execute-and-allow')
    fixture.agent.resolveAgentApproval('execute-and-allow-exact')
    await nextTick()
    assert.ok(fixture.agent.agentPendingApproval.value)
    assert.equal(fixture.agent.agentSessionGrantCount.value, 0)
    assert.deepEqual(fixture.saves, [])
    assert.deepEqual(fixture.commands, [])
    fixture.agent.stopAgentRun()
    await running
  })
}

function policyIntent(source, decision = 'ask') {
  return { source, operation: 'command', reference: { id: 'runtime-only-ticket', target: { sessionId: 'original' } },
    capture: { kind: 'sentinel', nonce: 'backend_nonce', internal: false }, terminalInput: 'backend transport\r',
    analysis: { decision, analysisStatus: decision === 'allow' ? 'complete' : 'unknown', risks: [],
      unknownReasons: decision === 'allow' ? [] : [{ message: '当前环境需要复核', range: { startLine: 1 } }] } }
}

for (const [change, mutate] of [
  ['directory', intent => { intent.reference.target.context.workingDirectory = '/srv/other' }],
  ['account', intent => { intent.reference.target.context.user = 'other-user' }],
  ['container', intent => { intent.reference.target.context.environmentScope = 'other-container' }],
  ['shell', intent => { intent.reference.target.context.shell = 'posix' }],
  ['route', intent => { intent.reference.target.routeVersion++ }],
  ['native session', intent => { intent.reference.target.sessionInstance = 'replacement-instance' }],
  ['profile', intent => { intent.reference.target.profileId = 'other-profile' }],
  ['unknown context', intent => { intent.reference.target.context.workingDirectory = null }],
  ['policy', intent => { intent.reference.policyVersion = intent.analysis.policyVersion = 'new-policy' }]
]) {
  test(`exact command grants expire on changed ${change} and do not return with the old environment`, async t => {
    const command = 'printf status'
    const f = mountRuntime(t, { responses: [
      response(commandCall('first', command)), response(commandCall('same', command)),
      response(commandCall('changed', command)), response(commandCall('restored', command)), response()
    ] })
    const target = await checkpointFixture().api.agentCheckpointTarget()
    let prepared = 0
    const approvals = []
    f.props.agentCommandPolicy = {
      prepare: async (_id, _generation, source) => {
        const number = ++prepared
        const intent = { ...policyIntent(source, 'allow'), reference: {
          id: `grant-ticket-${number}`, operation: 'command', policyVersion: 'policy-v1',
          target: { ...structuredClone(target), contextVersion: number }
        } }
        intent.analysis.policyVersion = 'policy-v1'
        if (number === 3) mutate(intent)
        return intent
      },
      approve: async intent => { approvals.push(intent.reference.id) }, cancel: async () => {}
    }
    const running = f.runAgent()
    await until(() => f.agent.agentPendingApproval.value?.proposal.id === 'first')
    f.agent.resolveAgentApproval('execute-and-allow-exact')
    await until(() => f.agent.agentPendingApproval.value?.proposal.id === 'changed')
    assert.deepEqual(f.commands, [command, command], 'fresh unchanged context may reuse only the exact command')
    assert.equal(f.props.messages[0].agentSteps[1].autoApproved, true)
    assert.equal(f.agent.agentSessionGrantCount.value, 0)
    f.agent.resolveAgentApproval('execute')
    await until(() => f.agent.agentPendingApproval.value?.proposal.id === 'restored')
    assert.deepEqual(f.commands, [command, command, command], 'returning to an old environment must not restore its grant')
    assert.deepEqual(approvals, ['grant-ticket-1', 'grant-ticket-3'])
    assert.deepEqual(f.saves, [])
    f.agent.stopAgentRun(); await running
  })
}

test('native sensitivity redacts history and links the exact live intent before command dispatch', async t => {
  const checkpoints = checkpointFixture(), command = "export APP_PASSWORD='PRIVATE_FIXTURE_VALUE'"
  const fixture = mountRuntime(t, { checkpoints: checkpoints.api, responses: [response(commandCall('credential', command)), response()] })
  const prepared = { ...policyIntent(command), sourceSensitive: true, reference: { id: 'live-script-source', operation: 'command', target: await checkpoints.api.agentCheckpointTarget(), policyVersion: 'command-policy-v1' } }
  const approvals = []
  fixture.props.agentCommandPolicy = { prepare: async () => prepared, approve: async intent => { approvals.push(intent.reference.id) }, cancel: async () => {} }
  fixture.props.agentCommandRunner = (_terminal, actual, options) => {
    assert.equal(actual, command)
    assert.equal(options.intent.reference.id, prepared.reference.id)
    assert.deepEqual(approvals, ['live-script-source'])
    const before = checkpoints.saved.find(item => item.boundary === 'before-dispatch')
    assert.equal(before.scriptIntent.id, prepared.reference.id)
    return { result: Promise.resolve({ status: 'completed', exitCode: 0, output: 'PRIVATE_FIXTURE_VALUE', durationMs: 1, truncated: false }), peekOutput: () => '', cancel() {} }
  }
  const running = fixture.runAgent()
  await until(() => fixture.agent.agentPendingApproval.value)
  assert.equal(fixture.agent.agentPendingApproval.value.proposal.sensitive, true)
  assert.equal(checkpoints.saved.find(item => item.boundary === 'prepared').scriptIntent.id, 'live-script-source')
  fixture.agent.resolveAgentApproval('execute', true)
  await running
  assert.equal(fixture.props.messages[0].agentStatus, 'done')
  assert.ok(!JSON.stringify(checkpoints.saved).includes('PRIVATE_FIXTURE_VALUE'))
  assert.ok(!fixture.props.messages[0].payloadJson.includes('PRIVATE_FIXTURE_VALUE'))
  assert.ok(checkpoints.saved.filter(item => !['prepared', 'before-dispatch'].includes(item.boundary)).every(item => !item.scriptIntent))
})

test('后端 ask 覆盖只读自动允许，批准精确记录后派发且不持久化票据', async t => {
  const fixture = mountRuntime(t, { responses: [response(commandCall('policy')), response()] })
  const prepared = policyIntent('printf status')
  const approved = [], dispatched = [], cancelled = []
  fixture.props.agentBuiltinReadonlyEnabled = true
  fixture.props.agentCommandPolicy = {
    prepare: async (id, generation, source) => { assert.equal(id, 'terminal'); assert.equal(generation, 1); assert.equal(source, prepared.source); return prepared },
    approve: async intent => { approved.push(intent.reference.id) },
    cancel: async intent => { cancelled.push(intent.reference.id) }
  }
  fixture.props.agentCommandRunner = (_id, command, options) => {
    assert.deepEqual(approved, ['runtime-only-ticket'])
    assert.equal(options.intent.reference.id, prepared.reference.id)
    assert.equal(options.intent.source, command)
    dispatched.push(command)
    return { result: Promise.resolve({ status: 'completed', exitCode: 0, output: 'ok', durationMs: 0, truncated: false }), peekOutput: () => '', cancel() {} }
  }
  const task = fixture.runAgent()
  await until(() => fixture.agent.agentPendingApproval.value)
  assert.equal(dispatched.length, 0)
  assert.ok(fixture.agent.agentPendingApproval.value.proposal.risks.some(risk => risk.message.includes('环境需要复核')))
  fixture.agent.resolveAgentApproval('execute-and-allow-exact')
  assert.equal(approved.length, 0)
  fixture.agent.resolveAgentApproval('execute', true)
  await task
  assert.deepEqual(dispatched, ['printf status'])
  assert.equal(cancelled.length, 1)
  assert.ok(!JSON.stringify(fixture.props.messages[0]).includes('runtime-only-ticket'))
})

for (const scenario of ['deny', 'analysis-error', 'approval-error']) {
  test(`后端 ${scenario} 时不得回退到前端派发`, async t => {
    const fixture = mountRuntime(t, { responses: [response(commandCall('blocked'))] })
    fixture.props.agentBuiltinReadonlyEnabled = true
    fixture.props.agentCommandPolicy = {
      prepare: async source => { if (scenario === 'analysis-error') throw Error('analysis unavailable'); return policyIntent('printf status', scenario === 'deny' ? 'deny' : 'ask') },
      approve: async () => { throw Error('stale target') }, cancel: async () => {}
    }
    const task = fixture.runAgent()
    if (scenario === 'approval-error') {
      await until(() => fixture.agent.agentPendingApproval.value)
      fixture.agent.resolveAgentApproval('execute', true)
    }
    await task
    assert.equal(fixture.props.messages[0].agentStatus, 'error')
    assert.deepEqual(fixture.commands, [])
  })
}

test('分析尚未返回时停止，迟到的后端记录被取消', async t => {
  const prepared = deferred(), cancelled = []
  let requested = false
  const fixture = mountRuntime(t, { responses: [response(commandCall('late'))] })
  fixture.props.agentCommandPolicy = {
    prepare: async () => { requested = true; return prepared.promise },
    approve: async () => { assert.fail('stopped run cannot approve') },
    cancel: async intent => { cancelled.push(intent.reference.id) }
  }
  const task = fixture.runAgent()
  await until(() => requested)
  fixture.agent.stopAgentRun()
  await task
  prepared.resolve(policyIntent('printf status'))
  await until(() => cancelled.length === 1)
  assert.deepEqual(fixture.commands, [])
})

test('restart recovery reuses the original run and goal, collects new evidence and persists human observations without old authority', async t => {
  const checkpoints = checkpointFixture(), target = await checkpoints.api.agentCheckpointTarget()
  const record = { runId: 'original-run', messageId: 'answer', workspaceSessionId: 'session', goal: '恢复原始任务', target, lastTarget: target, routeKey: 'local-route-v1', sequence: 4, boundary: 'before-dispatch', state: { status: 'executing', steps: [{ id: 'old-command', command: 'old unknown write', reason: 'old', toolName: 'run_command', sensitive: false, status: 'running', executionPhase: 'dispatching', output: null, outputTruncated: false, exitCode: null, fileRead: null, fileEdits: [] }], plan: null, verifications: [], finalText: '', error: null, stopReason: null } }
  let sequence = 4, recovery, begins = 0
  checkpoints.api.beginAgentRun = async () => { begins++; throw Error('recovery must not start another run') }
  checkpoints.api.recoverAgentRun = async (current, runId, expected) => {
    assert.equal(runId, record.runId); assert.equal(expected, sequence)
    recovery = { phase: 'inspecting', sourceSequence: sequence, sourceStepIds: ['old-command'], requiredStepIds: ['old-command'], originalTarget: target, currentTarget: current, resolutions: [] }
    return { lease: { runId, token: 'new-owner', sequence: ++sequence }, checkpoint: { ...record, recovery, sequence } }
  }
  checkpoints.api.saveAgentCheckpoint = async (lease, update) => { assert.equal(lease.runId, record.runId); assert.equal(update.expectedSequence, sequence); checkpoints.saved.push(structuredClone(update)); return ++sequence }
  checkpoints.api.confirmAgentRecovery = async (_lease, _target, expected, resolutions) => { assert.equal(expected, sequence); recovery = { ...recovery, phase: 'continuing', resolutions }; return { ...record, recovery, sequence: ++sequence } }
  const f = mountRuntime(t, { checkpoints: checkpoints.api, responses: [response(commandCall('fresh-check', 'whoami')), response(), response(commandCall('new-command', 'whoami')), response()] })
  f.props.agentBuiltinReadonlyEnabled = true
  const running = f.agent.startAgentRecovery(record)
  await until(() => Boolean(f.agent.agentPendingRecovery.value))
  assert.deepEqual(f.commands, ['whoami']); assert.equal(begins, 0); assert.equal(f.modelRequests[0].request.goal, record.goal)
  f.agent.resolveAgentRecovery({ action: 'continue', resolutions: [{ stepId: 'old-command', evidenceStepIds: ['fresh-check'], observation: '已检查当前账号与现场，继续原目标' }] })
  await until(() => Boolean(f.agent.agentPendingApproval.value))
  assert.equal(f.commands.length, 1); assert.equal(f.agent.agentPendingApproval.value.proposal.id, 'new-command')
  assert.equal(f.agent.agentPendingApproval.value.proposal.suggestedPatterns, undefined)
  f.agent.resolveAgentApproval('execute'); await running
  const payload = JSON.parse(f.props.messages[0].payloadJson)
  assert.equal(payload.agentSteps[0].exitCode, undefined); assert.equal(payload.agentSteps[0].executionPhase, 'dispatching')
  assert.equal(payload.agentRecovery.resolutions[0].observation, '已检查当前账号与现场，继续原目标')
  assert.ok(!JSON.stringify(payload).includes('new-owner')); assert.equal(checkpoints.saved.at(-1).boundary, 'finished')
  assert.equal(f.modelRequests.at(-1).request.taskContext.includes('已检查当前账号与现场'), true)
})

test('backend target mismatch during recovery prevents model and terminal work', async t => {
  const checkpoints = checkpointFixture(), target = await checkpoints.api.agentCheckpointTarget()
  checkpoints.api.recoverAgentRun = async () => { throw Error('当前账号或容器环境与原任务不同') }
  checkpoints.api.confirmAgentRecovery = async () => { throw Error('must not confirm') }
  const f = mountRuntime(t, { checkpoints: checkpoints.api })
  await f.agent.startAgentRecovery({ runId: 'original', messageId: 'answer', workspaceSessionId: 'session', goal: '原目标', target, sequence: 1, state: { steps: [], plan: null, verifications: [] } })
  assert.equal(f.modelRequests.length, 0); assert.equal(f.commands.length, 0)
  assert.match(f.props.messages[0].text, /账号或容器/)
})

function waitingCheckpoint(target) {
  return { runId: 'waiting-run', messageId: 'answer', workspaceSessionId: 'session', goal: '部署并验证原始目标', target, lastTarget: target, routeKey: 'local-route-v1', sequence: 4, boundary: 'finished', userInputs: [], state: {
    status: 'waiting-input', steps: [{ id: 'old-inspect', command: 'inspect original', reason: '已检查', toolName: 'run_command', sensitive: false, status: 'completed', executionPhase: 'finished', output: 'A and B', outputTruncated: false, exitCode: 0, fileRead: null, fileEdits: [] }],
    plan: { version: 2, reason: '等待选择', items: [{ id: 'inspect', description: '检查', status: 'completed', stepIds: ['old-inspect'] }, { id: 'select', description: '按用户选择继续', status: 'waiting', stepIds: [] }], changes: [] }, verifications: [], finalText: '选择 A 还是 B？', error: null, stopReason: null } }
}
function replyReceipt(record, current, reply) {
  return { lease: { runId: record.runId, token: 'reply-owner', sequence: record.sequence + 1 }, checkpoint: { ...structuredClone(record), sequence: record.sequence + 1, messageId: reply.assistantMessageId,
    userInputs: [...record.userInputs, { messageId: reply.messageId, question: record.state.finalText, text: reply.text, redacted: false, createdAt: 1 }],
    recovery: { phase: 'continuing', sourceSequence: record.sequence, sourceStepIds: record.state.steps.map(step => step.id), requiredStepIds: [], originalTarget: record.target, currentTarget: current, resolutions: [] } } }
}

test('answering a waiting task keeps its run, original goal, question, plan and completed evidence with fresh command approval', async t => {
  const checkpoints = checkpointFixture(), target = await checkpoints.api.agentCheckpointTarget(), record = waitingCheckpoint(target)
  let sequence = record.sequence
  checkpoints.api.beginAgentRun = async () => { assert.fail('reply must not create another run') }
  checkpoints.api.recoverAgentRun = async () => { assert.fail('same-session reply has its own native transition') }
  checkpoints.api.confirmAgentRecovery = async () => { assert.fail('no unknown effects in this fixture') }
  checkpoints.api.replyAgentRun = async (current, runId, expected, reply) => {
    assert.equal(runId, record.runId); assert.equal(expected, sequence); sequence++
    assert.notEqual(reply.assistantMessageId, record.messageId)
    return replyReceipt(record, current, reply)
  }
  checkpoints.api.saveAgentCheckpoint = async (lease, update) => { assert.equal(lease.runId, record.runId); assert.equal(update.expectedSequence, sequence); checkpoints.saved.push(structuredClone(update)); return ++sequence }
  const changedPlan = { expectedVersion: 2, reason: '用户选择 B', items: [...record.state.plan.items.map(item => ({ ...item, status: item.id === 'select' ? 'in-progress' : item.status }))] }
  const f = mountRuntime(t, { checkpoints: checkpoints.api, responses: [response({ id: 'plan', name: 'update_plan', arguments: JSON.stringify(changedPlan) }), response(commandCall('new-command', 'whoami')), response()] })
  f.props.agentBuiltinReadonlyEnabled = true
  f.props.messages[0].agentStatus = 'waiting-input'; f.props.messages[0].text = record.state.finalText
  const running = f.agent.replyToAgentTask(record, '选择 B，保留先前检查')
  await until(() => Boolean(f.agent.agentPendingApproval.value))
  assert.deepEqual(f.commands, [])
  assert.equal(f.agent.agentPendingApproval.value.proposal.id, 'new-command')
  assert.equal(JSON.parse(f.modelRequests[0].request.taskContext).plan.version, 2)
  assert.equal(JSON.parse(f.modelRequests[1].request.taskContext).plan.version, 3)
  assert.ok(f.modelRequests.every(item => item.request.goal.startsWith(record.goal) && item.request.goal.includes('选择 A 还是 B') && item.request.goal.includes('选择 B，保留先前检查')))
  assert.ok(f.modelRequests[0].request.turns.some(turn => JSON.stringify(turn).includes('old-inspect')))
  f.agent.resolveAgentApproval('execute'); await running
  assert.deepEqual(f.commands, ['whoami'])
  assert.equal(f.props.messages[0].text, '选择 A 还是 B？')
  assert.equal(f.props.messages[1].role, 'user')
  assert.equal(f.props.messages[2].agentPlan.version, 3)
  assert.deepEqual(f.props.messages[2].agentSteps.map(step => step.id), ['old-inspect', 'new-command'])
})

test('a failed or stopped reply save cannot call the model, dispatch, or create a replacement task', async t => {
  const checkpoints = checkpointFixture(), target = await checkpoints.api.agentCheckpointTarget(), record = waitingCheckpoint(target)
  const pending = deferred()
  checkpoints.api.recoverAgentRun = async () => { assert.fail('must not recover silently') }
  checkpoints.api.confirmAgentRecovery = async () => { assert.fail('must not confirm silently') }
  checkpoints.api.beginAgentRun = async () => { assert.fail('must not create replacement') }
  let current, submitted
  checkpoints.api.replyAgentRun = async (expected, _id, _sequence, reply) => { current = expected; submitted = reply; return pending.promise }
  const f = mountRuntime(t, { checkpoints: checkpoints.api, responses: [] })
  const running = f.agent.replyToAgentTask(record, '选择 B')
  await until(() => Boolean(submitted)); f.agent.stopAgentRun(); await running
  assert.equal(f.modelRequests.length, 0); assert.deepEqual(f.commands, [])
  pending.resolve(replyReceipt(record, current, submitted))
  await until(() => checkpoints.released.includes(record.runId))
  assert.equal(f.modelRequests.length, 0)
})


test('chat forwards fresh host knowledge separately from conversation and stops before sending a cancelled lookup', async t => {
  let received
  const f = mountRuntime(t, { hostKnowledgeContext: async query => `facts for ${query}`, chatResponse: async (_id, request) => { received = request; return { answer: 'done' } } })
  await f.runChat(); assert.equal(received.hostKnowledgeContext, 'facts for 检查状态'); assert.deepEqual(received.conversationMessages, [])
})

test('agent reloads host knowledge between tool results and sends no cached deleted fact', async t => {
  let count = 0
  const f = mountRuntime(t, { hostKnowledgeContext: async () => ++count === 1 ? 'first fact' : 'empty current snapshot', responses: [response(commandCall('read')), response()] })
  const pending = f.runAgent(); await until(() => f.agent.agentPendingApproval.value)
  f.agent.resolveAgentApproval('execute'); await pending
  assert.equal(f.modelRequests[0].request.hostKnowledgeContext, 'first fact')
  assert.equal(f.modelRequests[1].request.hostKnowledgeContext, 'empty current snapshot')
})

test('stopping while host knowledge is loading prevents model dispatch in chat and agent', async t => {
  for (const kind of ['chat', 'agent']) {
    const lookup = deferred(); let entered = false, sent = false
    const f = mountRuntime(t, { hostKnowledgeContext: () => { entered = true; return lookup.promise }, chatResponse: async () => { sent = true; return { answer: 'should not send' } } })
    const pending = kind === 'chat' ? f.runChat() : f.runAgent(); await until(() => entered)
    if (kind === 'chat') f.chat.stopCurrentAnswer(); else f.agent.stopAgentRun()
    lookup.resolve('late fact'); await pending
    assert.equal(sent, false); assert.equal(f.modelRequests.length, 0)
  }
})

test('a terminal owned by another session blocks preparation and direct run without releasing its lock', async t => {
  const f = mountRuntime(t)
  const ownership = [], probes = []
  f.props.agentTakeoverChange = (terminalId, active) => { ownership.push([terminalId, active]); return false }
  f.props.agentAvailabilityConfirm = async () => { probes.push('probe'); return '' }
  const preparation = await f.agent.prepareAgentAction(f.agent.currentAgentTarget())
  assert.match(preparation.blocked, /其他会话/)
  assert.deepEqual(probes, [])
  await f.runAgent()
  assert.deepEqual(f.modelRequests, [])
  assert.deepEqual(f.commands, [])
  assert.ok(ownership.every(([, active]) => active), 'Rejected acquisition cannot release another session’s terminal')
  assert.equal(f.answerState.isAsking.value, false)
})

test('a real terminal reconnect cancels the pending approval rather than dispatching to the replacement', async t => {
  const f = mountRuntime(t, { responses: [response(commandCall('before-reconnect'))] })
  const running = f.runAgent()
  await until(() => Boolean(f.agent.agentPendingApproval.value))
  f.props.terminalConnectionGeneration++
  await nextTick(); await running
  assert.equal(f.agent.agentPendingApproval.value, null)
  assert.deepEqual(f.commands, [])
  assert.equal(f.props.messages[0].agentStatus, 'stopped')
})
