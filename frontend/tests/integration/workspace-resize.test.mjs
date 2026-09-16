import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import test from 'node:test'
import { createRenderer, isReadonly, ref } from 'vue'
import { useWorkspaceResize } from "../../src/app/layout/useWorkspaceResize"
import { getWorkspaceLayout, getWorkspaceWidthForKey, getWorkspaceWidthForPointer, parseWorkspaceWidth } from "../../src/domains/settings/domain/workspaceLayout"
import { loadWorkspaceWidth, persistWorkspaceWidth, loadWorkspaceLayoutPreferences, persistWorkspaceLayoutPreferences, WORKSPACE_WIDTH_STORAGE_KEY, WORKSPACE_LAYOUT_STORAGE_KEY } from "../../src/domains/settings/infrastructure/storage/settingsStorage"

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  const writes = []
  return {
    writes,
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      writes.push([key, value])
      values.set(key, value)
    }
  }
}

const renderer = createRenderer({
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
  parentNode: () => null, nextSibling: () => null
})

function mountResize(context, options = {}) {
  const viewport = Object.assign(new EventTarget(), { innerWidth: options.innerWidth ?? 1440 })
  const classes = new Set(['other-state'])
  const documentTarget = { body: { classList: {
    add: (name) => classes.add(name), remove: (name) => classes.delete(name)
  } } }
  const descriptors = ['window', 'document'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  Object.defineProperty(globalThis, 'window', { configurable: true, value: viewport })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentTarget })
  const storage = options.storage ?? createStorage({ [WORKSPACE_WIDTH_STORAGE_KEY]: '420' })
  const leftCollapsed = ref(false)
  const rightCollapsed = ref(false)
  const sftpWorkbenchActive = ref(false)
  let state
  let app
  let unmounted = false
  function unmount() {
    if (!app || unmounted) return
    app.unmount()
    unmounted = true
  }
  context.after(() => {
    unmount()
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  })
  app = renderer.createApp({ setup() {
    state = useWorkspaceResize({ leftCollapsed, rightCollapsed, sftpWorkbenchActive, storage })
    return () => null
  } })
  app.mount({})
  return { state, viewport, classes, storage, leftCollapsed, rightCollapsed, sftpWorkbenchActive, unmount }
}

function pointer(type = 'pointerdown', properties = {}) {
  return Object.assign(new Event(type, { cancelable: true }), { button: 0, clientX: 1000, ...properties })
}

function keyEvent(key) {
  return Object.assign(new Event('keydown', { cancelable: true }), { key })
}

function assertNoResizeListeners(viewport) {
  for (const type of ['pointermove', 'pointerup', 'pointercancel']) {
    assert.equal(getEventListeners(viewport, type).length, 0)
  }
}

test('宽度解析默认使用最窄的 320，并支持 320–560 范围', () => {
  for (const [value, expected] of [[null, 320], ['', 320], ['0', 320], ['-1', 320], ['420', 420], ['420.5', 420.5], ['999', 560], ['bad', 320], ['Infinity', 320]]) {
    assert.equal(parseWorkspaceWidth(value), expected)
  }
})

test('指针算法保留左右栏与终端占用、窄窗口下限和像素取整', () => {
  assert.equal(getWorkspaceWidthForPointer(1440, 100, false), 560)
  assert.equal(getWorkspaceWidthForPointer(1440, 1400, false), 320)
  assert.equal(getWorkspaceWidthForPointer(1440, 1000.4, false), 440)
  assert.equal(getWorkspaceWidthForPointer(1440, 1000.6, false), 439)
  assert.equal(getWorkspaceWidthForPointer(1300, 100, false), 444)
  assert.equal(getWorkspaceWidthForPointer(1300, 100, true), 560)
  assert.equal(getWorkspaceWidthForPointer(1000, 100, true), 392)
  assert.equal(getWorkspaceWidthForPointer(800, 100, false), 192)
})

test('键盘算法保留 20px 步长，并接受统一的有效范围', () => {
  assert.equal(getWorkspaceWidthForKey(420, 'ArrowLeft'), 440)
  assert.equal(getWorkspaceWidthForKey(420, 'ArrowRight'), 400)
  assert.equal(getWorkspaceWidthForKey(550, 'ArrowLeft'), 560)
  assert.equal(getWorkspaceWidthForKey(370, 'ArrowRight'), 350)
  assert.equal(getWorkspaceWidthForKey(420.5, 'ArrowLeft'), 440.5)
  assert.equal(getWorkspaceWidthForKey(420, 'Home'), 320)
  assert.equal(getWorkspaceWidthForKey(420, 'End'), 560)
  assert.equal(getWorkspaceWidthForKey(420, 'Enter'), undefined)
})

test('宽度存储保留旧键和值，读写异常不抛出', () => {
  const storage = createStorage()
  assert.equal(loadWorkspaceWidth(storage), 320)
  assert.equal(persistWorkspaceWidth(480, storage), true)
  assert.equal(storage.getItem('ai-term:workspace-width:v1'), '480')
  assert.equal(loadWorkspaceWidth(storage), 480)
  const unavailable = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
  assert.equal(loadWorkspaceWidth(unavailable), 320)
  assert.equal(persistWorkspaceWidth(480, unavailable), false)
})

test('localStorage 属性访问异常同样回落 320 且不影响调用者', context => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked') } })
  context.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else delete globalThis.localStorage
  })
  assert.equal(loadWorkspaceWidth(), 320)
  assert.equal(persistWorkspaceWidth(480), false)
})

test('挂载读取宽度并只读暴露状态，空闲时不写存储或注册全局监听器', context => {
  const { state, viewport, storage, classes } = mountResize(context)
  assert.equal(isReadonly(state.workspaceWidth), true)
  assert.equal(isReadonly(state.workspaceResizing), true)
  assert.equal(state.workspaceWidth.value, 420)
  assert.deepEqual(state.workspaceLayoutStyle.value, { '--sidebar-width': '248px', '--workspace-width': '420px' })
  assert.equal(state.workspaceResizing.value, false)
  assert.equal(classes.has('workspace-resizing'), false)
  assert.equal(storage.writes.length, 0)
  assertNoResizeListeners(viewport)
})

test('指针缩放只在结束时持久化，结束后不再响应移动', context => {
  const { state, viewport, storage, classes } = mountResize(context)
  const start = pointer()
  state.beginWorkspaceResize(start)
  assert.equal(start.defaultPrevented, true)
  assert.equal(state.workspaceResizing.value, true)
  assert.equal(classes.has('workspace-resizing'), true)
  viewport.dispatchEvent(pointer('pointermove'))
  assert.equal(state.workspaceWidth.value, 440)
  assert.deepEqual(state.workspaceLayoutStyle.value, { '--sidebar-width': '248px', '--workspace-width': '440px' })
  assert.equal(storage.writes.length, 0)
  viewport.dispatchEvent(pointer('pointerup'))
  assert.equal(state.workspaceResizing.value, false)
  assert.equal(classes.has('workspace-resizing'), false)
  assert.deepEqual(storage.writes, [[WORKSPACE_WIDTH_STORAGE_KEY, '440']])
  assertNoResizeListeners(viewport)
  viewport.dispatchEvent(pointer('pointermove', { clientX: 1200 }))
  assert.equal(state.workspaceWidth.value, 440)
})

test('非主键、右栏收起或 SFTP 工作台激活时不启动缩放', context => {
  const { state, viewport, rightCollapsed, sftpWorkbenchActive, classes } = mountResize(context)
  const secondary = pointer('pointerdown', { button: 2 })
  state.beginWorkspaceResize(secondary)
  assert.equal(secondary.defaultPrevented, false)
  for (const disabledState of [rightCollapsed, sftpWorkbenchActive]) {
    disabledState.value = true
    const event = pointer()
    state.beginWorkspaceResize(event)
    assert.equal(event.defaultPrevented, false)
    disabledState.value = false
  }
  assert.equal(state.workspaceResizing.value, false)
  assert.equal(classes.has('workspace-resizing'), false)
  assertNoResizeListeners(viewport)
})

test('拖动读取实时窗口宽度和左栏折叠状态', context => {
  const { state, viewport, leftCollapsed } = mountResize(context, { innerWidth: 1300 })
  state.beginWorkspaceResize(pointer())
  viewport.dispatchEvent(pointer('pointermove', { clientX: 100 }))
  assert.equal(state.workspaceWidth.value, 444)
  leftCollapsed.value = true
  viewport.dispatchEvent(pointer('pointermove', { clientX: 100 }))
  assert.equal(state.workspaceWidth.value, 560)
  viewport.innerWidth = 1000
  viewport.dispatchEvent(pointer('pointermove', { clientX: 100 }))
  assert.equal(state.workspaceWidth.value, 392)
})

test('键盘事件即时保存，未知键不阻止默认行为也不写存储', context => {
  const { state, storage } = mountResize(context)
  for (const [key, expected] of [['ArrowLeft', 440], ['ArrowRight', 420], ['Home', 320], ['End', 560]]) {
    const event = keyEvent(key)
    state.handleWorkspaceResizeKeydown(event)
    assert.equal(event.defaultPrevented, true)
    assert.equal(state.workspaceWidth.value, expected)
    assert.equal(storage.getItem(WORKSPACE_WIDTH_STORAGE_KEY), String(expected))
  }
  const unknown = keyEvent('Tab')
  state.handleWorkspaceResizeKeydown(unknown)
  assert.equal(unknown.defaultPrevented, false)
  assert.equal(storage.writes.length, 4)
})

test('指针取消也完成保存和清理，重复结束不会重复保存', context => {
  const { state, viewport, storage, classes, unmount } = mountResize(context)
  state.beginWorkspaceResize(pointer())
  viewport.dispatchEvent(pointer('pointercancel'))
  viewport.dispatchEvent(pointer('pointerup'))
  unmount()
  assert.equal(state.workspaceResizing.value, false)
  assert.equal(classes.has('workspace-resizing'), false)
  assert.equal(storage.writes.length, 1)
  assertNoResizeListeners(viewport)
})

test('真实组件卸载时停止拖动、持久化并清理全部全局监听器', context => {
  const { state, viewport, storage, classes, unmount } = mountResize(context)
  state.beginWorkspaceResize(pointer())
  viewport.dispatchEvent(pointer('pointermove', { clientX: 950 }))
  unmount()
  assert.equal(state.workspaceWidth.value, 490)
  assert.equal(state.workspaceResizing.value, false)
  assert.equal(classes.has('workspace-resizing'), false)
  assert.equal(classes.has('other-state'), true)
  assert.deepEqual(storage.writes, [[WORKSPACE_WIDTH_STORAGE_KEY, '490']])
  assertNoResizeListeners(viewport)
})

test('空闲组件卸载不产生存储写入', context => {
  const { viewport, storage, classes, unmount } = mountResize(context)
  unmount()
  assert.equal(storage.writes.length, 0)
  assert.equal(classes.has('other-state'), true)
  assertNoResizeListeners(viewport)
})

test('存储不可用时键盘和指针缩放仍可操作并正常结束', context => {
  const unavailable = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
  const { state, viewport, classes } = mountResize(context, { storage: unavailable })
  assert.equal(state.workspaceWidth.value, 320)
  state.handleWorkspaceResizeKeydown(keyEvent('ArrowLeft'))
  assert.equal(state.workspaceWidth.value, 340)
  state.beginWorkspaceResize(pointer())
  viewport.dispatchEvent(pointer('pointermove', { clientX: 950 }))
  viewport.dispatchEvent(pointer('pointerup'))
  assert.equal(state.workspaceWidth.value, 490)
  assert.equal(state.workspaceResizing.value, false)
  assert.equal(classes.has('workspace-resizing'), false)
  assertNoResizeListeners(viewport)
})


test('1280、1100、1040 和 980 窗口保留终端最小宽度，窄窗口使用左侧抽屉', () => {
  for (const viewport of [1440, 1280, 1100, 1040, 980]) {
    const layout = getWorkspaceLayout(viewport, 360, false)
    const dockedSidebar = layout.sidebarOverlay ? 0 : layout.sidebarWidth
    assert.ok(viewport - 48 - dockedSidebar - layout.width >= 560)
    assert.equal(layout.sidebarOverlay, viewport < 1192)
    assert.ok(layout.width >= 320)
  }
  assert.equal(getWorkspaceLayout(1280, 360, false).sidebarWidth, 224)
  assert.equal(getWorkspaceLayout(980, 360, false, true).sidebarOverlay, false)
})

test('窗口缩小保留偏好，恢复宽窗口还原宽度；键盘从可见宽度开始', context => {
  const storage = createStorage({ [WORKSPACE_WIDTH_STORAGE_KEY]: '560' })
  const { state, viewport } = mountResize(context, { innerWidth: 1280, storage })
  assert.equal(state.workspaceWidth.value, 560)
  viewport.innerWidth = 980
  viewport.dispatchEvent(new Event('resize'))
  assert.equal(state.workspaceWidth.value, 372)
  assert.equal(state.workspaceMaxWidth.value, 372)
  assert.equal(state.workspaceLayoutStyle.value['--workspace-width'], '372px')
  assert.equal(storage.writes.length, 0)
  viewport.innerWidth = 1280
  viewport.dispatchEvent(new Event('resize'))
  assert.equal(state.workspaceWidth.value, 560)
  viewport.innerWidth = 980
  viewport.dispatchEvent(new Event('resize'))
  state.handleWorkspaceResizeKeydown(keyEvent('ArrowRight'))
  assert.equal(state.workspaceWidth.value, 352)
  assert.equal(storage.getItem(WORKSPACE_WIDTH_STORAGE_KEY), '352')
})

test('鼠标和键盘共享范围，CSS 反映实际宽度', context => {
  const { state, viewport } = mountResize(context, { innerWidth: 1280 })
  state.handleWorkspaceResizeKeydown(keyEvent('End'))
  const maximum = state.workspaceWidth.value
  assert.equal(maximum, state.workspaceMaxWidth.value)
  state.beginWorkspaceResize(pointer())
  viewport.dispatchEvent(pointer('pointermove', { clientX: 0 }))
  viewport.dispatchEvent(pointer('pointerup'))
  assert.equal(state.workspaceWidth.value, maximum)
  assert.equal(state.workspaceLayoutStyle.value['--workspace-width'], maximum + 'px')
})

test('左右栏、工具标签和导航模式可重启恢复，损坏偏好安全回落', () => {
  const storage = createStorage()
  const preferences = { leftCollapsed: true, rightCollapsed: true, workspacePanelTab: 'history', leftPanelMode: 'settings' }
  assert.equal(persistWorkspaceLayoutPreferences(preferences, storage), true)
  assert.deepEqual(loadWorkspaceLayoutPreferences(storage), preferences)
  for (const value of ['{', '[]', 'null', '{"leftCollapsed":"true","rightCollapsed":1,"workspacePanelTab":"unknown"}']) {
    storage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, value)
    assert.deepEqual(loadWorkspaceLayoutPreferences(storage), { leftCollapsed: false, rightCollapsed: false, workspacePanelTab: 'ai', leftPanelMode: 'connections' })
  }
  const unavailable = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
  assert.equal(persistWorkspaceLayoutPreferences(preferences, unavailable), false)
  assert.equal(loadWorkspaceLayoutPreferences(unavailable).workspacePanelTab, 'ai')
})
