import assert from 'node:assert/strict'
import test from 'node:test'
import { isReadonly } from 'vue'
import { normalizedTerminalTargetIds, terminalStatusClass } from "../../src/domains/terminal/model/terminalTabs"
import { useTerminalTabs } from "../../src/domains/terminal/application/useTerminalTabs"

function profile(id = 'server') {
  return {
    id, name: '生产连接', connectionRole: 'direct',
    gateway: { host: '', username: '', authMode: 'auto' },
    target: { host: 'example.internal', username: 'ops', authMode: 'key' },
    jumpMode: 'direct', menuProfileId: '', fileTransferMode: 'auto'
  }
}

test('初始本地标签保持原始 ID、连接请求与只读状态', () => {
  const state = useTerminalTabs()
  assert.equal(isReadonly(state.terminalTabs.value), true)
  assert.equal(isReadonly(state.activeTerminalId), true)
  assert.deepEqual(state.terminalTabs.value, [{
    id: 'local-1', title: '本地终端', connectionId: 'local', profile: undefined,
    connectRequest: 0, status: 'idle', connectionGeneration: 0
  }])
  assert.deepEqual(state.targetTerminalIds.value, ['local-1'])
  assert.equal(state.multiTerminalInputEnabled.value, false)
})

test('新增标签激活并重置同步目标，连接配置是独立快照', () => {
  const state = useTerminalTabs()
  const config = profile()
  const tab = state.addTerminalTab(config)
  config.target.host = 'changed.internal'
  assert.equal(tab.title, 'ops@example.internal')
  assert.equal(tab.profile.target.host, 'example.internal')
  assert.equal(tab.connectionId, 'server')
  assert.equal(tab.connectRequest, 1)
  assert.equal(state.activeTerminalId.value, tab.id)
  assert.deepEqual(state.targetTerminalIds.value, [tab.id])
})

test('远程标题保留用户名和主机的回退规则', () => {
  const state = useTerminalTabs()
  const config = profile()
  config.target.username = ''
  config.target.host = ''
  assert.equal(state.addTerminalTab(config).title, 'user@生产连接')
})

test('同一毫秒关闭再新增也不复用终端实例 key', context => {
  context.mock.method(Date, 'now', () => 1234)
  const state = useTerminalTabs()
  const first = state.addTerminalTab()
  state.removeTerminalTab(first.id)
  const second = state.addTerminalTab()
  assert.equal(first.id, 'terminal-1234-2')
  assert.notEqual(second.id, first.id)
})

test('同步目标按标签顺序去重、过滤失效 ID 并补充活动标签', () => {
  const tabs = [{ id: 'first' }, { id: 'second' }, { id: 'third' }]
  assert.deepEqual(normalizedTerminalTargetIds(tabs, ['third', 'missing', 'third', 'first'], 'second'), ['first', 'third', 'second'])
  assert.deepEqual(normalizedTerminalTargetIds(tabs, [], 'first'), ['first'])
  assert.deepEqual(normalizedTerminalTargetIds(tabs, ['missing'], 'missing'), [])
})

test('单选状态切换标签时只发送到新的当前终端', () => {
  const state = useTerminalTabs()
  state.addTerminalTab()
  state.selectTerminalTab('local-1')
  assert.deepEqual(state.targetTerminalIds.value, ['local-1'])
  assert.equal(state.terminalTargetLabel.value, '当前 本地终端')
  assert.match(state.terminalTargetTitle.value, /仅发送到当前终端/)
})

test('多选状态切换标签保留原目标并纳入新的活动终端', () => {
  const state = useTerminalTabs()
  const remote = state.addTerminalTab(profile())
  const local = state.addTerminalTab()
  state.toggleTerminalTarget('local-1')
  state.selectTerminalTab(remote.id)
  assert.deepEqual(state.targetTerminalIds.value, ['local-1', remote.id, local.id])
  assert.deepEqual(state.targetConnectionIds.value, ['local', 'server'])
  assert.equal(state.terminalTargetLabel.value, '同步 3 个 · 当前 ops@example.internal')
  assert.match(state.terminalTargetTitle.value, /同步目标：本地终端、ops@example.internal、本地终端/)
})

test('取消活动标签的勾选重置为仅当前，不能移除当前输入目标', () => {
  const state = useTerminalTabs()
  const tab = state.addTerminalTab()
  state.selectAllTerminalTargets()
  assert.equal(state.terminalTargetToggleTitle(tab.id), '仅同步当前终端')
  state.toggleTerminalTarget(tab.id)
  assert.deepEqual(state.targetTerminalIds.value, [tab.id])
  assert.equal(state.terminalTargetToggleTitle(tab.id), '当前终端')
})

test('仅暂停有效的非活动同步目标，恢复和移除目标都清除暂停状态', () => {
  const state = useTerminalTabs()
  const tab = state.addTerminalTab()
  assert.deepEqual(state.pauseTerminalTargets(['local-1', tab.id, 'missing']), [])
  state.selectAllTerminalTargets()
  assert.deepEqual(state.pauseTerminalTargets(['local-1', tab.id, 'missing']), ['local-1'])
  assert.equal(state.isTerminalSyncPaused('local-1'), true)
  assert.match(state.terminalTargetToggleTitle('local-1'), /键盘同步已暂停/)
  assert.deepEqual(state.pauseTerminalTargets(['local-1']), [])
  state.resumeTerminalSyncTarget('local-1')
  assert.equal(state.isTerminalSyncPaused('local-1'), false)
  state.pauseTerminalTargets(['local-1'])
  state.toggleTerminalTarget('local-1')
  assert.equal(state.isTerminalSyncPaused('local-1'), false)
  assert.equal(state.terminalTargetToggleTitle('local-1'), '加入同步目标')
})

test('切换活动目标、全选和仅当前均清理对应暂停状态', () => {
  const state = useTerminalTabs()
  const tab = state.addTerminalTab()
  state.selectAllTerminalTargets()
  state.pauseTerminalTargets(['local-1'])
  state.selectTerminalTab('local-1')
  assert.equal(state.isTerminalSyncPaused('local-1'), false)
  state.pauseTerminalTargets([tab.id])
  state.selectAllTerminalTargets()
  assert.equal(state.isTerminalSyncPaused(tab.id), false)
  state.pauseTerminalTargets([tab.id])
  state.resetTerminalTargetsToActive()
  assert.deepEqual(state.targetTerminalIds.value, ['local-1'])
  assert.equal(state.isTerminalSyncPaused(tab.id), false)
})

test('关闭活动标签选择前一个；关闭第一个选择新的第一个', () => {
  const state = useTerminalTabs()
  const second = state.addTerminalTab()
  const third = state.addTerminalTab()
  assert.equal(state.removeTerminalTab(third.id), true)
  assert.equal(state.activeTerminalId.value, second.id)
  state.selectTerminalTab('local-1')
  state.removeTerminalTab('local-1')
  assert.equal(state.activeTerminalId.value, second.id)
  assert.deepEqual(state.targetTerminalIds.value, [second.id])
})

test('关闭后台标签不切换活动标签并清除同步目标及暂停记录', () => {
  const state = useTerminalTabs()
  const active = state.addTerminalTab()
  state.selectAllTerminalTargets()
  state.pauseTerminalTargets(['local-1'])
  state.removeTerminalTab('local-1')
  assert.equal(state.activeTerminalId.value, active.id)
  assert.deepEqual(state.targetTerminalIds.value, [active.id])
  assert.equal(state.isTerminalSyncPaused('local-1'), false)
})

test('最后一个终端不能关闭，晚到的失效标签事件不会改变状态', () => {
  const state = useTerminalTabs()
  assert.equal(state.removeTerminalTab('local-1'), false)
  assert.equal(state.removeTerminalTab('missing'), false)
  state.selectTerminalTab('missing')
  state.toggleTerminalTarget('missing')
  state.updateTerminalStatus('missing', 'remote')
  assert.equal(state.terminalTabs.value.length, 1)
  assert.equal(state.activeTerminalId.value, 'local-1')
  assert.deepEqual(state.targetTerminalIds.value, ['local-1'])
})

test('连接代次在本地、远程及 SFTP 首次连接和重连时递增', () => {
  for (const connectedStatus of ['local', 'remote', 'sftp']) {
    const state = useTerminalTabs()
    for (const status of ['connecting', 'preview', 'error']) {
      state.updateTerminalStatus('local-1', status)
      assert.equal(state.activeTerminal.value.connectionGeneration, 0)
    }
    state.updateTerminalStatus('local-1', connectedStatus)
    assert.equal(state.activeTerminal.value.connectionGeneration, 1)
    for (const status of [connectedStatus, 'local', 'remote', 'sftp']) {
      state.updateTerminalStatus('local-1', status)
      assert.equal(state.activeTerminal.value.connectionGeneration, 1)
    }
    state.updateTerminalStatus('local-1', 'connecting')
    assert.equal(state.activeTerminal.value.connectionGeneration, 1)
    state.updateTerminalStatus('local-1', connectedStatus)
    assert.equal(state.activeTerminal.value.connectionGeneration, 2)
  }
})

test('终端状态样式映射保留本地、远程、SFTP 与预览区别', () => {
  for (const status of ['idle', 'connecting', 'local', 'remote', 'sftp', 'preview', 'error']) {
    assert.deepEqual(terminalStatusClass(status), {
      live: ['local', 'remote', 'sftp'].includes(status),
      connecting: status === 'connecting', error: status === 'error', preview: status === 'preview'
    })
  }
})

test('独立应用的标签与同步状态不共享', () => {
  const first = useTerminalTabs()
  const second = useTerminalTabs()
  first.addTerminalTab()
  first.selectAllTerminalTargets()
  assert.equal(second.terminalTabs.value.length, 1)
  assert.deepEqual(second.targetTerminalIds.value, ['local-1'])
})
