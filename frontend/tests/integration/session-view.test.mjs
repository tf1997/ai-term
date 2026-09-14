import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'
import { mountComposable } from '../helpers/lifecycle.mjs'
import { useSessionView } from '../../src/app/layout/useSessionView'

function setup(context) {
  const activeTerminalId = ref('a')
  const terminalTabs = ref([{ id: 'a' }, { id: 'b' }])
  const { state } = mountComposable(context, () => useSessionView({ activeTerminalId, terminalTabs }))
  return { state, activeTerminalId, terminalTabs }
}

test('each terminal restores its own view and new terminals start at the terminal', context => {
  const { state, activeTerminalId, terminalTabs } = setup(context)
  assert.equal(state.activeView.value, 'terminal')
  state.selectView('files')
  activeTerminalId.value = 'b'
  assert.equal(state.activeView.value, 'terminal')
  activeTerminalId.value = 'a'
  assert.equal(state.activeView.value, 'files')
  terminalTabs.value.push({ id: 'c' })
  activeTerminalId.value = 'c'
  assert.equal(state.activeView.value, 'terminal')
})

test('reselecting files is idempotent and returning to terminal preserves the file mount', context => {
  const { state } = setup(context)
  assert.equal(state.filesVisited.value, false)
  assert.equal(state.selectView('files'), true)
  assert.equal(state.filesVisited.value, true)
  assert.equal(state.selectView('files'), false)
  assert.equal(state.selectView('terminal'), true)
  assert.equal(state.filesVisited.value, true)
})

test('explicit SFTP-only profiles start in files but remember a manual terminal selection', context => {
  const { state, activeTerminalId, terminalTabs } = setup(context)
  for (const fileTransferMode of ['sftp-direct', 'sftp-gateway']) {
    terminalTabs.value.push({ id: fileTransferMode, profile: { fileTransferMode } })
    activeTerminalId.value = fileTransferMode
    assert.equal(state.activeView.value, 'files')
    state.selectView('terminal')
    activeTerminalId.value = 'a'
    activeTerminalId.value = fileTransferMode
    assert.equal(state.activeView.value, 'terminal')
  }
})

test('closed terminal view state is discarded', context => {
  const { state, activeTerminalId, terminalTabs } = setup(context)
  state.selectView('files')
  activeTerminalId.value = 'b'
  terminalTabs.value = [{ id: 'b' }]
  terminalTabs.value.push({ id: 'a' })
  activeTerminalId.value = 'a'
  assert.equal(state.activeView.value, 'terminal')
})
