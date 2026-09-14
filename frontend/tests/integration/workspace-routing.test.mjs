import assert from 'node:assert/strict'
import test from 'node:test'
import { ref, shallowRef, nextTick } from 'vue'
import { mountComposable } from "../helpers/lifecycle.mjs"
import { useTerminalTabs } from "../../src/domains/terminal/application/useTerminalTabs"
import { useTerminalInputRouter } from "../../src/domains/terminal/application/useTerminalInputRouter"
import { useScriptRecording } from "../../src/domains/scripts/application/useScriptRecording"

function inputState(overrides = {}) { return { available: true, context: 'shell', reliable: true, command: '', cursor: 0, pendingControlSequence: '', ...overrides } }
function setupRouter(context) {
  const calls = [], notifications = [], timers = new Map()
  const previous = globalThis.window
  globalThis.window = { setTimeout(callback) { timers.set(0, callback); return 0 }, clearTimeout(timer) { timers.delete(timer) } }
  context.after(() => { globalThis.window = previous })
  const tabs = useTerminalTabs()
  const remote = tabs.addTerminalTab()
  tabs.selectAllTerminalTargets()
  const pane = id => ({ commandExecutionReadiness: () => 'ready', executeCommand: command => { calls.push([id, 'execute', command]); return true }, fillCommand: command => { calls.push([id, 'fill', command]); return true }, pinQuickCommand: () => 'added', writeTerminalInput: data => { calls.push([id, 'write', data]); return true }, writeSyncedTerminalInput: data => { calls.push([id, 'sync', data]); return true }, terminalInputSyncState: () => inputState() })
  const terminalRefs = shallowRef({ 'local-1': pane('local-1'), [remote.id]: pane(remote.id) })
  const mounted = mountComposable(context, () => useTerminalInputRouter({ tabs, terminalRefs, showToast: (...args) => notifications.push(args) }))
  return { ...mounted, tabs, terminalRefs, calls, notifications, timers, remote }
}

function fireNextTimer(timers) {
  const [id, callback] = timers.entries().next().value ?? []
  assert.equal(typeof callback, 'function')
  timers.delete(id)
  callback()
}

test('工作区命令按目标集合发送，历史填入只影响当前终端', async context => {
  const { state, tabs, calls, remote } = setupRouter(context)
  await state.executeCommandOnTerminalIds(' pwd ', [...tabs.targetTerminalIds.value])
  assert.deepEqual(calls, [['local-1', 'execute', 'pwd'], [remote.id, 'execute', 'pwd']])
  await state.fillHistoryCommandOnActiveTerminal(' ls ')
  assert.deepEqual(calls.at(-1), [remote.id, 'fill', 'ls'])
})

test('历史填入等待提示符期间切换标签，仍只填入调用时的终端', async context => {
  const { state, tabs, terminalRefs, timers, calls, remote } = setupRouter(context)
  terminalRefs.value[remote.id].commandExecutionReadiness = () => 'shell-busy'
  const waiting = state.fillHistoryCommandOnActiveTerminal(' ls ')
  await nextTick()
  await nextTick()
  assert.equal(timers.size, 1)
  tabs.selectTerminalTab('local-1')
  terminalRefs.value[remote.id].commandExecutionReadiness = () => 'ready'
  fireNextTimer(timers)
  await waiting
  assert.deepEqual(calls, [[remote.id, 'fill', 'ls']])
  assert.equal(timers.size, 0)
})

test('历史填入等待期间关闭原终端，即使引用尚未清理也不填入或转发到保留终端', async context => {
  const { state, tabs, terminalRefs, timers, calls, notifications, remote } = setupRouter(context)
  terminalRefs.value[remote.id].commandExecutionReadiness = () => 'shell-busy'
  const waiting = state.fillHistoryCommandOnActiveTerminal('pwd')
  await nextTick()
  await nextTick()
  assert.equal(timers.size, 1)
  tabs.removeTerminalTabs([remote.id], 'local-1')
  terminalRefs.value[remote.id].commandExecutionReadiness = () => 'ready'
  fireNextTimer(timers)
  await waiting
  assert.equal(tabs.activeTerminalId.value, 'local-1')
  assert.deepEqual(calls, [])
  assert.deepEqual(notifications, [['warning', '命令未填入', '原终端已关闭。']])
  assert.equal(timers.size, 0)
})

test('传输内部输入只发送当前终端，普通输入保留多终端路由', async context => {
  const { state, calls, remote } = setupRouter(context)
  await state.writeInputToTargetTerminals('echo AI_TERM_IDENT_probe')
  assert.deepEqual(calls, [[remote.id, 'write', 'echo AI_TERM_IDENT_probe']])
  calls.length = 0
  await state.writeInputToTargetTerminals('whoami\r')
  assert.equal(calls.length, 2)
})

test('失配同步暂停，回到空提示符恢复，后台输入不能广播', context => {
  const { state, tabs, terminalRefs, calls, remote } = setupRouter(context)
  terminalRefs.value['local-1'].terminalInputSyncState = () => inputState({ command: 'other' })
  const event = { terminalId: remote.id, data: 'p', safeToSync: true, beforeState: inputState() }
  state.syncTerminalInputToTargets(event)
  assert.equal(tabs.isTerminalSyncPaused('local-1'), true)
  assert.equal(calls.length, 0)
  terminalRefs.value['local-1'].terminalInputSyncState = () => inputState()
  state.syncTerminalInputToTargets(event)
  assert.equal(tabs.isTerminalSyncPaused('local-1'), false)
  assert.deepEqual(calls, [['local-1', 'sync', 'p']])
  state.syncTerminalInputToTargets({ ...event, terminalId: 'local-1' })
  assert.equal(calls.length, 1)
})

test('非空命令行状态一致且未暂停时仍可同步补全按键', context => {
  const { state, tabs, terminalRefs, calls, notifications, remote } = setupRouter(context)
  const beforeState = inputState({ command: 'git che', cursor: 7 })
  terminalRefs.value['local-1'].terminalInputSyncState = () => beforeState
  state.syncTerminalInputToTargets({ terminalId: remote.id, data: '\t', safeToSync: false, beforeState })
  assert.deepEqual(calls, [['local-1', 'sync', '\t']])
  assert.equal(tabs.isTerminalSyncPaused('local-1'), false)
  assert.deepEqual(notifications, [])
})

test('补全不会恢复非空命令行上的暂停目标，双方回到空提示符才恢复', context => {
  const { state, tabs, terminalRefs, calls, remote } = setupRouter(context)
  const beforeState = inputState({ command: 'git che', cursor: 7 })
  terminalRefs.value['local-1'].terminalInputSyncState = () => beforeState
  tabs.pauseTerminalTargets(['local-1'])
  state.syncTerminalInputToTargets({ terminalId: remote.id, data: '\t', safeToSync: false, beforeState })
  assert.deepEqual(calls, [])
  assert.equal(tabs.isTerminalSyncPaused('local-1'), true)

  terminalRefs.value['local-1'].terminalInputSyncState = () => inputState()
  state.syncTerminalInputToTargets({ terminalId: remote.id, data: '\t', safeToSync: false, beforeState: inputState() })
  assert.deepEqual(calls, [['local-1', 'sync', '\t']])
  assert.equal(tabs.isTerminalSyncPaused('local-1'), false)
})

test('补全遇到命令或光标失配、终端不可用时标记暂停且只提示一次', context => {
  const { state, tabs, terminalRefs, calls, notifications, remote } = setupRouter(context)
  const beforeState = inputState({ command: 'git che', cursor: 7 })
  const event = { terminalId: remote.id, data: '\t', safeToSync: false, beforeState }
  for (const targetState of [
    inputState({ command: 'git sta', cursor: 7 }),
    inputState({ command: 'git che', cursor: 3 }),
    inputState({ available: false })
  ]) {
    tabs.resumeTerminalSyncTarget('local-1')
    notifications.length = 0
    terminalRefs.value['local-1'].terminalInputSyncState = () => targetState
    state.syncTerminalInputToTargets(event)
    state.syncTerminalInputToTargets(event)
    assert.equal(tabs.isTerminalSyncPaused('local-1'), true)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0][0], 'warning')
  }
  assert.deepEqual(calls, [])
})

test('来源处于交互程序或状态不可靠时补全不广播，并暂停目标', context => {
  const { state, tabs, terminalRefs, calls, remote } = setupRouter(context)
  for (const beforeState of [inputState({ context: 'unknown' }), inputState({ context: 'sensitive' }), inputState({ reliable: false })]) {
    tabs.resumeTerminalSyncTarget('local-1')
    terminalRefs.value['local-1'].terminalInputSyncState = () => beforeState
    state.syncTerminalInputToTargets({ terminalId: remote.id, data: '\t', safeToSync: false, beforeState })
    assert.equal(tabs.isTerminalSyncPaused('local-1'), true)
  }
  assert.deepEqual(calls, [])
})

test('补全写入被拒绝时暂停目标，Ctrl+C 仍可到达未暂停的交互终端', context => {
  const { state, tabs, terminalRefs, calls, remote } = setupRouter(context)
  const pane = terminalRefs.value['local-1']
  const originalWrite = pane.writeSyncedTerminalInput
  pane.writeSyncedTerminalInput = () => false
  state.syncTerminalInputToTargets({ terminalId: remote.id, data: '\t', safeToSync: false, beforeState: inputState() })
  assert.equal(tabs.isTerminalSyncPaused('local-1'), true)
  pane.writeSyncedTerminalInput = originalWrite
  const interrupt = { terminalId: remote.id, data: '\x03', safeToSync: false, beforeState: inputState({ context: 'unknown' }) }
  state.syncTerminalInputToTargets(interrupt)
  assert.deepEqual(calls, [])
  tabs.resumeTerminalSyncTarget('local-1')
  state.syncTerminalInputToTargets(interrupt)
  assert.deepEqual(calls, [['local-1', 'sync', '\x03']])
})

test('卸载取消待重试的命令并释放计时器，不派发晚到输入', async context => {
  const { state, tabs, terminalRefs, timers, calls, unmount } = setupRouter(context)
  for (const pane of Object.values(terminalRefs.value)) pane.commandExecutionReadiness = () => 'shell-busy'
  const waiting = state.executeCommandOnTerminalIds('pwd', [...tabs.targetTerminalIds.value])
  await nextTick()
  await nextTick()
  assert.equal(timers.size, 1)
  unmount()
  await waiting
  assert.equal(timers.size, 0)
  assert.equal(calls.length, 0)
})

test('录制按终端隔离、固定开始时来源，停止和关闭清理只影响对应终端', () => {
  const activeTerminalId = ref('one'), activeConnectionId = ref('host'), activeAiSessionId = ref('session')
  const state = useScriptRecording({ activeTerminalId, activeConnectionId, activeAiSessionId })
  state.startScriptRecording()
  state.appendRecordingCommand('one', 'pwd')
  state.appendRecordingOutput('one', 'output')
  activeTerminalId.value = 'two'
  activeConnectionId.value = 'other'
  state.startScriptRecording()
  state.appendRecordingCommand('one', 'ls')
  activeTerminalId.value = 'one'
  assert.equal(state.activeScriptRecording.value.connectionId, 'host')
  assert.deepEqual(state.activeScriptRecording.value.commands, ['pwd', 'ls'])
  state.stopScriptRecording()
  state.appendRecordingCommand('one', 'ignored')
  assert.equal(state.activeScriptRecording.value.commands.length, 2)
  state.removeScriptRecording('one')
  assert.equal(state.activeScriptRecording.value.isRecording, false)
  activeTerminalId.value = 'two'
  assert.equal(state.activeScriptRecording.value.isRecording, true)
})

test('录制输出和命令遵守原有限额，清空后不再接收输出', () => {
  const state = useScriptRecording({ activeTerminalId: ref('one'), activeConnectionId: ref('local'), activeAiSessionId: ref('') })
  state.startScriptRecording()
  for (let index = 0; index < 205; index++) state.appendRecordingCommand('one', String(index))
  state.appendRecordingOutput('one', 'x'.repeat(120010))
  assert.equal(state.activeScriptRecording.value.commands.length, 200)
  assert.equal(state.activeScriptRecording.value.commands[0], '5')
  assert.equal(state.activeScriptRecording.value.terminalOutput.length, 120000)
  assert.equal(state.activeScriptRecording.value.workspaceSessionId, 'ai:default')
  state.clearScriptRecording()
  state.appendRecordingOutput('one', 'ignored')
  assert.equal(state.activeScriptRecording.value.terminalOutput, '')
})
