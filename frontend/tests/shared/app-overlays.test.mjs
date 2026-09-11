import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import test from 'node:test'
import { createRenderer, isReadonly } from 'vue'
import { useToasts } from "../../src/shared/ui/useToasts"
import { useContextMenu } from "../../src/shared/ui/useContextMenu"

function createClock() {
  const timers = new Map()
  let time = 0
  let sequence = 0
  return {
    setTimeout(callback, delay) {
      const id = sequence++
      timers.set(id, { callback, at: time + delay })
      return id
    },
    clearTimeout: (id) => timers.delete(id),
    activeCount: () => timers.size,
    advance(milliseconds) {
      const target = time + milliseconds
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((first, second) => first[1].at - second[1].at)[0]
        if (!next) break
        const [id, timer] = next
        timers.delete(id)
        time = timer.at
        timer.callback()
      }
      time = target
    }
  }
}

const renderer = createRenderer({
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
  parentNode: () => null, nextSibling: () => null
})

function mountOverlays(context, factory = () => ({ notifications: useToasts(), menu: useContextMenu() })) {
  const clock = createClock()
  const viewport = Object.assign(new EventTarget(), {
    innerWidth: 1440,
    innerHeight: 900,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  })
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: viewport })
  let app
  let state
  let unmounted = false
  function unmount() {
    if (!app || unmounted) return
    app.unmount()
    unmounted = true
  }
  context.after(() => {
    unmount()
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else delete globalThis.window
  })
  app = renderer.createApp({ setup() {
    state = factory()
    return () => null
  } })
  app.mount({})
  return { ...state, viewport, clock, unmount }
}

function menuEvent(clientX = 100, clientY = 200) {
  return Object.assign(new Event('contextmenu', { cancelable: true }), { clientX, clientY })
}

function createItems(count = 1) {
  return Array.from({ length: count }, (_, index) => ({ id: 'item-' + index, label: '操作 ' + index, action() {} }))
}

test('通知初始为空、只读暴露且不创建计时器', context => {
  const { notifications, clock } = mountOverlays(context)
  assert.equal(isReadonly(notifications.toasts), true)
  assert.equal(isReadonly(notifications.toasts.value), true)
  assert.deepEqual(notifications.toasts.value, [])
  assert.equal(clock.activeCount(), 0)
})

test('同一毫秒内的通知 ID 唯一，省略详情仍保存空字符串', context => {
  context.mock.method(Date, 'now', () => 1000)
  const { notifications } = mountOverlays(context)
  for (const kind of ['info', 'success', 'warning']) notifications.showToast(kind, kind)
  assert.deepEqual(notifications.toasts.value.map(toast => toast.id), ['toast-1000-0', 'toast-1000-1', 'toast-1000-2'])
  assert.equal(notifications.toasts.value.every(toast => toast.message === ''), true)
})

test('普通通知保留 3600ms 自动消失时间', context => {
  const { notifications, clock } = mountOverlays(context)
  for (const kind of ['info', 'success', 'warning']) notifications.showToast(kind, kind)
  clock.advance(3599)
  assert.equal(notifications.toasts.value.length, 3)
  clock.advance(1)
  assert.deepEqual(notifications.toasts.value, [])
  assert.equal(clock.activeCount(), 0)
})

test('错误通知保留 6200ms 自动消失时间', context => {
  const { notifications, clock } = mountOverlays(context)
  notifications.showToast('error', '失败', '详细错误')
  clock.advance(6199)
  assert.equal(notifications.toasts.value.length, 1)
  clock.advance(1)
  assert.equal(notifications.toasts.value.length, 0)
  assert.equal(clock.activeCount(), 0)
})

test('重复通知替换 ID、移动到末尾并重置时限，旧计时器被回收', context => {
  const { notifications, clock } = mountOverlays(context)
  notifications.showToast('info', '主题已切换', '浅色')
  const previousId = notifications.toasts.value[0].id
  notifications.showToast('success', '设置已保存')
  clock.advance(3500)
  notifications.showToast('info', '主题已切换', '浅色')
  assert.deepEqual(notifications.toasts.value.map(toast => toast.title), ['设置已保存', '主题已切换'])
  assert.notEqual(notifications.toasts.value[1].id, previousId)
  assert.equal(clock.activeCount(), 2)
  clock.advance(100)
  assert.deepEqual(notifications.toasts.value.map(toast => toast.title), ['主题已切换'])
  clock.advance(3499)
  assert.equal(notifications.toasts.value.length, 1)
  clock.advance(1)
  assert.equal(notifications.toasts.value.length, 0)
  assert.equal(clock.activeCount(), 0)
})

test('去重同时比较类型、标题和详情，缺失详情与空详情等价', context => {
  const { notifications, clock } = mountOverlays(context)
  notifications.showToast('info', '提示')
  notifications.showToast('info', '提示', '')
  assert.equal(notifications.toasts.value.length, 1)
  notifications.showToast('warning', '提示', '')
  notifications.showToast('info', '提示', '详情')
  assert.equal(notifications.toasts.value.length, 3)
  notifications.showToast('info', '其他标题', '详情')
  assert.deepEqual(notifications.toasts.value.map(toast => [toast.kind, toast.title, toast.message]), [
    ['warning', '提示', ''], ['info', '提示', '详情'], ['info', '其他标题', '详情']
  ])
  assert.equal(clock.activeCount(), 3)
})

test('字面量反斜线转义内容不能改变通知的去重字段边界', context => {
  const { notifications } = mountOverlays(context)
  const separator = String.raw`\u0000`
  notifications.showToast('info', 'alpha' + separator + 'beta', 'gamma')
  notifications.showToast('info', 'alpha', 'beta' + separator + 'gamma')
  assert.equal(notifications.toasts.value.length, 2)
})

test('通知持续涌入时只保留最近三条，存活计时器也最多三个', context => {
  const { notifications, clock } = mountOverlays(context)
  for (let index = 0; index < 100; index++) {
    notifications.showToast('info', '通知 ' + index)
    assert.ok(clock.activeCount() <= 3)
  }
  assert.deepEqual(notifications.toasts.value.map(toast => toast.title), ['通知 97', '通知 98', '通知 99'])
  clock.advance(3600)
  assert.equal(clock.activeCount(), 0)
  assert.equal(notifications.toasts.value.length, 0)
})

test('手动关闭立即回收计时器，重复关闭或未知 ID 不影响其他通知', context => {
  const { notifications, clock } = mountOverlays(context)
  notifications.showToast('info', '普通提示')
  notifications.showToast('error', '错误提示')
  const id = notifications.toasts.value[0].id
  notifications.dismissToast(id)
  notifications.dismissToast(id)
  notifications.dismissToast('unknown')
  assert.deepEqual(notifications.toasts.value.map(toast => toast.title), ['错误提示'])
  assert.equal(clock.activeCount(), 1)
  clock.advance(3600)
  assert.equal(notifications.toasts.value.length, 1)
  clock.advance(2600)
  assert.equal(notifications.toasts.value.length, 0)
})

test('组件卸载清空通知与全部计时器，迟到的异步结果不再创建通知', context => {
  const { notifications, clock, unmount } = mountOverlays(context)
  notifications.showToast('info', '提示')
  notifications.showToast('error', '失败')
  unmount()
  assert.equal(clock.activeCount(), 0)
  assert.equal(notifications.toasts.value.length, 0)
  notifications.showToast('success', '迟到的响应')
  clock.advance(10000)
  assert.equal(notifications.toasts.value.length, 0)
  assert.equal(clock.activeCount(), 0)
})

test('不同通知实例的状态和计时器互不影响', context => {
  context.mock.method(Date, 'now', () => 1000)
  const { first, second, clock } = mountOverlays(context, () => ({ first: useToasts(), second: useToasts() }))
  first.showToast('info', '相同提示')
  second.showToast('info', '相同提示')
  first.dismissToast(first.toasts.value[0].id)
  assert.equal(first.toasts.value.length, 0)
  assert.equal(second.toasts.value.length, 1)
  assert.equal(clock.activeCount(), 1)
  clock.advance(3600)
  assert.equal(second.toasts.value.length, 0)
})

test('菜单初始关闭且只读暴露，每种全局事件只注册一次', context => {
  const { menu, viewport } = mountOverlays(context)
  assert.equal(isReadonly(menu.contextMenu), true)
  assert.equal(menu.contextMenu.value, null)
  assert.equal(getEventListeners(viewport, 'click').length, 1)
  assert.equal(getEventListeners(viewport, 'keydown').length, 1)
  for (let index = 0; index < 10; index++) menu.openContextMenu(menuEvent(), '菜单', createItems())
  assert.equal(getEventListeners(viewport, 'click').length, 1)
  assert.equal(getEventListeners(viewport, 'keydown').length, 1)
})

test('菜单保留标题、坐标、禁用/危险标记和业务回调，开关菜单不执行动作', context => {
  const { menu } = mountOverlays(context)
  let actionCalls = 0
  const action = () => { actionCalls++ }
  const items = [{ id: 'delete', label: '删除', danger: true, disabled: true, action }]
  const event = menuEvent(120, 240)
  menu.openContextMenu(event, '终端菜单', items)
  assert.equal(event.defaultPrevented, false)
  assert.deepEqual(menu.contextMenu.value, { x: 120, y: 240, title: '终端菜单', items })
  assert.equal(menu.contextMenu.value.items[0].action, action)
  menu.closeContextMenu()
  assert.equal(actionCalls, 0)
  assert.equal(menu.contextMenu.value, null)
})

test('菜单定位保留 220px 宽度、8px 边距和按条目数量估算的高度', context => {
  const { menu, viewport } = mountOverlays(context)
  menu.openContextMenu(menuEvent(1500, 1000), '菜单', createItems(3))
  assert.equal(menu.contextMenu.value.x, 1212)
  assert.equal(menu.contextMenu.value.y, 744)
  menu.openContextMenu(menuEvent(-20, -30), '菜单', createItems())
  assert.equal(menu.contextMenu.value.x, 8)
  assert.equal(menu.contextMenu.value.y, 8)
  viewport.innerWidth = 1000
  viewport.innerHeight = 700
  menu.openContextMenu(menuEvent(1200, 900), '菜单', createItems(2))
  assert.equal(menu.contextMenu.value.x, 772)
  assert.equal(menu.contextMenu.value.y, 582)
})

test('多条菜单高度上限仍为 320px，极小窗口也保留原有 8px 下限', context => {
  const { menu, viewport } = mountOverlays(context)
  menu.openContextMenu(menuEvent(1400, 900), '菜单', createItems(20))
  assert.equal(menu.contextMenu.value.y, 572)
  viewport.innerWidth = 200
  viewport.innerHeight = 90
  menu.openContextMenu(menuEvent(500, 500), '菜单', createItems(2))
  assert.equal(menu.contextMenu.value.x, 8)
  assert.equal(menu.contextMenu.value.y, 8)
})

test('重新打开菜单替换旧状态，关闭操作幂等且不调用任何业务动作', context => {
  const { menu } = mountOverlays(context)
  menu.openContextMenu(menuEvent(), '连接', createItems(3))
  menu.openContextMenu(menuEvent(300, 400), '终端', createItems(2))
  assert.equal(menu.contextMenu.value.title, '终端')
  assert.equal(menu.contextMenu.value.items.length, 2)
  assert.equal(menu.contextMenu.value.x, 300)
  menu.closeContextMenu()
  menu.closeContextMenu()
  assert.equal(menu.contextMenu.value, null)
})

test('全局点击关闭菜单但不阻止默认行为', context => {
  const { menu, viewport } = mountOverlays(context)
  menu.openContextMenu(menuEvent(), '菜单', createItems())
  const event = new Event('click', { cancelable: true })
  viewport.dispatchEvent(event)
  assert.equal(menu.contextMenu.value, null)
  assert.equal(event.defaultPrevented, false)
})

test('仅 Escape 关闭菜单，不吞掉按键或影响其他快捷键处理器', context => {
  const { menu, viewport } = mountOverlays(context)
  menu.openContextMenu(menuEvent(), '菜单', createItems())
  const keys = []
  viewport.addEventListener('keydown', event => keys.push(event.key))
  for (const key of ['Enter', 'Tab', 'ArrowDown']) {
    viewport.dispatchEvent(Object.assign(new Event('keydown'), { key }))
    assert.notEqual(menu.contextMenu.value, null)
  }
  const escape = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' })
  viewport.dispatchEvent(escape)
  assert.equal(menu.contextMenu.value, null)
  assert.equal(escape.defaultPrevented, false)
  assert.deepEqual(keys, ['Enter', 'Tab', 'ArrowDown', 'Escape'])
})

test('卸载时关闭菜单并移除全局监听器，之后不能再次打开已销毁菜单', context => {
  const { menu, viewport, unmount } = mountOverlays(context)
  menu.openContextMenu(menuEvent(), '菜单', createItems())
  unmount()
  assert.equal(menu.contextMenu.value, null)
  assert.equal(getEventListeners(viewport, 'click').length, 0)
  assert.equal(getEventListeners(viewport, 'keydown').length, 0)
  menu.openContextMenu(menuEvent(), '迟到的菜单', createItems())
  assert.equal(menu.contextMenu.value, null)
})

test('多个菜单实例不共享状态，卸载移除各自注册的处理器', context => {
  const { first, second, viewport, unmount } = mountOverlays(context, () => ({ first: useContextMenu(), second: useContextMenu() }))
  first.openContextMenu(menuEvent(), '第一个', createItems())
  second.openContextMenu(menuEvent(), '第二个', createItems())
  first.closeContextMenu()
  assert.equal(second.contextMenu.value.title, '第二个')
  assert.equal(getEventListeners(viewport, 'click').length, 2)
  unmount()
  assert.equal(getEventListeners(viewport, 'click').length, 0)
  assert.equal(getEventListeners(viewport, 'keydown').length, 0)
})
