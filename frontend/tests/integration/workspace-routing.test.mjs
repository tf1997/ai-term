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

test('工作区命令按目标集合发送，历史填入只影响当前终端', async context => {
  const { state, tabs, calls, remote } = setupRouter(context)
  await state.executeCommandOnTerminalIds(' pwd ', [...tabs.targetTerminalIds.value])
  assert.deepEqual(calls, [['local-1', 'execute', 'pwd'], [remote.id, 'execute', 'pwd']])
  await state.fillHistoryCommandOnActiveTerminal(' ls ')
  assert.deepEqual(calls.at(-1), [remote.id, 'fill', 'ls'])
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
