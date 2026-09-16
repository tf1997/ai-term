import assert from 'node:assert/strict'
import test from 'node:test'
import { isReadonly } from 'vue'
import { normalizedTerminalTargetIds, terminalStatusClass } from "../../src/domains/terminal/domain/terminalTabs"
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
  assert.equal(isReadonly(state.pausedTerminalSyncIds), true)
  assert.deepEqual(state.terminalTabs.value, [{
    id: 'local-1', title: '本地终端', connectionId: 'local', profile: undefined,
    connectRequest: 0, status: 'idle', connectionGeneration: 0
  }])
  assert.deepEqual(state.targetTerminalIds.value, ['local-1'])
  assert.equal(state.multiTerminalInputEnabled.value, false)
  assert.equal(state.pausedTerminalTargetCount.value, 0)
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

test('切换到已有同步目标保留范围和连接去重结果', () => {
  const state = useTerminalTabs()
  const remote = state.addTerminalTab(profile())
  const local = state.addTerminalTab()
  state.toggleTerminalTarget('local-1')
  state.toggleTerminalTarget(remote.id)
  state.selectTerminalTab(remote.id)
  assert.deepEqual(state.targetTerminalIds.value, ['local-1', remote.id, local.id])
  assert.deepEqual(state.targetConnectionIds.value, ['local', 'server'])
  assert.equal(state.terminalTargetLabel.value, '同步 3 个 · 当前 ops@example.internal')
  assert.match(state.terminalTargetTitle.value, /同步目标：本地终端、ops@example.internal、本地终端/)
})

test('切换未选中的标签退出同步，不因查看终端扩大广播范围', () => {
  const state = useTerminalTabs()
  const remote = state.addTerminalTab(profile())
  const local = state.addTerminalTab()
  state.toggleTerminalTarget('local-1')
  state.pauseTerminalTargets(['local-1'])
  state.selectTerminalTab(remote.id)
  assert.deepEqual(state.targetTerminalIds.value, [remote.id])
  assert.deepEqual(state.targetConnectionIds.value, ['server'])
  assert.equal(state.multiTerminalInputEnabled.value, false)
  assert.equal(state.isTerminalTargetSelected(local.id), false)
  assert.deepEqual(state.pausedTerminalSyncIds.value, [])
})

test('同步期间新建终端只向新终端输入并清除原范围的暂停状态', () => {
  const state = useTerminalTabs()
  state.addTerminalTab()
  state.selectAllTerminalTargets()
  state.pauseTerminalTargets(['local-1'])
  const tab = state.addTerminalTab(profile())
  assert.deepEqual(state.targetTerminalIds.value, [tab.id])
  assert.deepEqual(state.pausedTerminalSyncIds.value, [])
})

test('活动标签始终必选，点击勾选不改变范围，停止同步需明确重置', () => {
  const state = useTerminalTabs()
  const tab = state.addTerminalTab()
  state.selectAllTerminalTargets()
  state.pauseTerminalTargets(['local-1'])
  assert.equal(state.terminalTargetToggleTitle(tab.id), '当前终端始终接收输入')
  state.toggleTerminalTarget(tab.id)
  assert.deepEqual(state.targetTerminalIds.value, ['local-1', tab.id])
  assert.equal(state.isTerminalSyncPaused('local-1'), true)
  state.resetTerminalTargetsToActive()
  assert.deepEqual(state.targetTerminalIds.value, [tab.id])
  assert.deepEqual(state.pausedTerminalSyncIds.value, [])
  assert.equal(state.terminalTargetToggleTitle(tab.id), '当前终端始终接收输入')
})

test('显式设置同步目标过滤重复和无效项、保留活动终端与仍选中目标的暂停状态', () => {
  const state = useTerminalTabs()
  const second = state.addTerminalTab()
  const active = state.addTerminalTab()
  state.selectAllTerminalTargets()
  state.pauseTerminalTargets(['local-1', second.id])
  state.setTerminalTargets([second.id, 'missing', second.id])
  assert.deepEqual(state.targetTerminalIds.value, [second.id, active.id])
  assert.deepEqual(state.pausedTerminalSyncIds.value, [second.id])
  assert.equal(state.pausedTerminalTargetCount.value, 1)
  state.setTerminalTargets([])
  assert.deepEqual(state.targetTerminalIds.value, [active.id])
  assert.deepEqual(state.pausedTerminalSyncIds.value, [])
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

test('切换活动源只清理该源的暂停，全选保留其他目标的安全暂停', () => {
  const state = useTerminalTabs()
  const second = state.addTerminalTab()
  const third = state.addTerminalTab()
  state.selectAllTerminalTargets()
  state.pauseTerminalTargets(['local-1', second.id])
  assert.equal(state.pausedTerminalTargetCount.value, 2)
  assert.match(state.terminalTargetLabel.value, /同步 3 个 · 暂停 2 · 当前 本地终端/)
  assert.match(state.terminalTargetTitle.value, /2 个终端键盘同步已暂停/)
  state.selectTerminalTab('local-1')
  assert.equal(state.isTerminalSyncPaused('local-1'), false)
  assert.equal(state.isTerminalSyncPaused(second.id), true)
  assert.equal(state.pausedTerminalTargetCount.value, 1)
  state.pauseTerminalTargets([third.id])
  state.selectAllTerminalTargets()
  state.selectAllTerminalTargets()
  assert.deepEqual(state.pausedTerminalSyncIds.value, [second.id, third.id])
  assert.equal(state.pausedTerminalTargetCount.value, 2)
  state.resetTerminalTargetsToActive()
  assert.deepEqual(state.targetTerminalIds.value, ['local-1'])
  assert.deepEqual(state.pausedTerminalSyncIds.value, [])
  assert.equal(state.pausedTerminalTargetCount.value, 0)
  assert.doesNotMatch(state.terminalTargetLabel.value, /暂停/)
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

test('关闭活动终端优先选择距离最近的存活同步目标，不把相邻未选终端加入范围', () => {
  const state = useTerminalTabs()
  const unrelated = state.addTerminalTab()
  const closing = state.addTerminalTab()
  const rightTarget = state.addTerminalTab(profile())
  state.selectTerminalTab(closing.id)
  state.setTerminalTargets(['local-1', closing.id, rightTarget.id])
  state.pauseTerminalTargets(['local-1', rightTarget.id])
  state.removeTerminalTab(closing.id)
  assert.equal(state.activeTerminalId.value, rightTarget.id)
  assert.deepEqual(state.targetTerminalIds.value, ['local-1', rightTarget.id])
  assert.equal(state.isTerminalTargetSelected(unrelated.id), false)
  assert.deepEqual(state.pausedTerminalSyncIds.value, ['local-1'])
})

test('关闭活动终端时等距同步目标优先前一项', () => {
  const state = useTerminalTabs()
  const middle = state.addTerminalTab()
  const right = state.addTerminalTab()
  state.selectAllTerminalTargets()
  state.selectTerminalTab(middle.id)
  state.removeTerminalTab(middle.id)
  assert.equal(state.activeTerminalId.value, 'local-1')
  assert.deepEqual(state.targetTerminalIds.value, ['local-1', right.id])
})

test('批量关闭其他终端保留指定后台终端并返回实际关闭项', () => {
  const state = useTerminalTabs()
  const keep = state.addTerminalTab(profile())
  const active = state.addTerminalTab()
  state.selectAllTerminalTargets()
  state.pauseTerminalTargets(['local-1', keep.id])
  assert.deepEqual(state.removeTerminalTabs(['local-1', active.id], keep.id), ['local-1', active.id])
  assert.deepEqual(state.terminalTabs.value.map(tab => tab.id), [keep.id])
  assert.equal(state.activeTerminalId.value, keep.id)
  assert.deepEqual(state.targetTerminalIds.value, [keep.id])
  assert.deepEqual(state.pausedTerminalSyncIds.value, [])
})

test('批量关闭后台标签保留当前终端与仍存活的同步及暂停状态', () => {
  const state = useTerminalTabs()
  const second = state.addTerminalTab()
  const third = state.addTerminalTab()
  const active = state.addTerminalTab()
  state.selectAllTerminalTargets()
  state.pauseTerminalTargets(['local-1', second.id, third.id])
  assert.deepEqual(state.removeTerminalTabs([third.id, 'missing', second.id, third.id], 'local-1'), [second.id, third.id])
  assert.equal(state.activeTerminalId.value, active.id)
  assert.deepEqual(state.targetTerminalIds.value, ['local-1', active.id])
  assert.deepEqual(state.pausedTerminalSyncIds.value, ['local-1'])
})

test('批量关闭活动同步组后按原位置选前一存活终端，不受中途删除影响', () => {
  const state = useTerminalTabs()
  const second = state.addTerminalTab()
  const third = state.addTerminalTab()
  const active = state.addTerminalTab()
  const last = state.addTerminalTab()
  state.selectTerminalTab(active.id)
  state.setTerminalTargets([second.id, active.id])
  state.removeTerminalTabs([second.id, active.id])
  assert.equal(state.activeTerminalId.value, third.id)
  assert.deepEqual(state.targetTerminalIds.value, [third.id])
  assert.deepEqual(state.terminalTabs.value.map(tab => tab.id), ['local-1', third.id, last.id])
})

test('关闭活动终端后显式切到未选的保留项时退出同步，不扩大原范围', () => {
  const state = useTerminalTabs()
  const keep = state.addTerminalTab()
  const closing = state.addTerminalTab()
  state.setTerminalTargets(['local-1', closing.id])
  state.removeTerminalTabs([closing.id], keep.id)
  assert.equal(state.activeTerminalId.value, keep.id)
  assert.deepEqual(state.targetTerminalIds.value, [keep.id])
})

test('批量删除全部标签至少保留当前终端，指定保留项优先且失效 ID 不影响状态', () => {
  const state = useTerminalTabs()
  state.addTerminalTab()
  const active = state.addTerminalTab()
  const ids = state.terminalTabs.value.map(tab => tab.id)
  assert.deepEqual(state.removeTerminalTabs(ids, 'missing'), ids.filter(id => id !== active.id))
  assert.equal(state.activeTerminalId.value, active.id)
  assert.deepEqual(state.removeTerminalTabs([active.id]), [])
  assert.deepEqual(state.removeTerminalTabs(['missing']), [])
  assert.deepEqual(state.removeTerminalTabs([]), [])

  const other = useTerminalTabs()
  const remote = other.addTerminalTab(profile())
  assert.deepEqual(other.removeTerminalTabs(['local-1', remote.id], 'local-1'), [remote.id])
  assert.equal(other.activeTerminalId.value, 'local-1')
  assert.deepEqual(other.targetTerminalIds.value, ['local-1'])
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

test('同名终端身份在菜单中显示相同序号，动作绑定被右键的 ID', async () => {
  const { terminalContextMenu } = await import('../../src/domains/terminal/application/terminalContextMenu')
  const tabs = [{ id: 'a', title: '本地终端' }, { id: 'b', title: '本地终端' }, { id: 'c', title: '生产连接' }]
  const calls = []
  const menu = terminalContextMenu({ tabs, tabId: 'b', activeId: 'a', targetIds: ['a'],
    select: id => calls.push(['select', id]), toggleTarget: id => calls.push(['sync', id]), create() {},
    close: id => calls.push(['close', id]), closeOthers() {}, closeRight() {},
  })
  assert.equal(menu.title, '本地终端 · 2')
  menu.items.find(item => item.id === 'switch').action()
  menu.items.find(item => item.id === 'toggle-target').action()
  menu.items.find(item => item.id === 'close').action()
  assert.deepEqual(calls, [['select', 'b'], ['sync', 'b'], ['close', 'b']])
  assert.deepEqual(menu.items.map(item => item.group), ['common', 'common', 'sync', 'close', 'close', 'close'])
})

test('当前单终端菜单精简无效操作，并说明关闭禁用原因', async () => {
  const { terminalContextMenu } = await import('../../src/domains/terminal/application/terminalContextMenu')
  const options = { tabs: [{ id: 'a', title: '本地终端' }], tabId: 'a', activeId: 'a', targetIds: ['a'],
    select() {}, toggleTarget() {}, create() {}, close() {}, closeOthers() {}, closeRight() {},
  }
  const menu = terminalContextMenu(options)
  assert.equal(menu.title, '本地终端')
  assert.equal(menu.description, '当前终端始终接收输入')
  assert.deepEqual(menu.items.map(item => item.id), ['new-local', 'close'])
  assert.equal(menu.items[1].disabled, true)
  assert.equal(menu.items[1].disabledReason, '至少保留一个终端')
  assert.equal(terminalContextMenu({ ...options, tabId: 'missing' }), undefined)
})
