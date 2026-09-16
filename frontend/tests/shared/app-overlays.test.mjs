import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import test from 'node:test'
import { createRenderer, isReadonly } from 'vue'
import { useToasts } from "../../src/shared/ui/useToasts"
import { useContextMenu } from "../../src/shared/ui/useContextMenu"
import { activateMenuLayer, nextMenuIndex, placeContextMenu } from "../../src/shared/ui/contextMenuInteraction"

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

test('菜单状态只读暴露，窗口监听器由实际挂载的菜单管理', context => {
  const { menu, viewport } = mountOverlays(context)
  assert.equal(isReadonly(menu.contextMenu), true)
  assert.equal(menu.contextMenu.value, null)
  for (let index = 0; index < 10; index++) menu.openContextMenu(menuEvent(), '菜单', createItems())
  assert.equal(getEventListeners(viewport, 'click').length, 0)
  assert.equal(getEventListeners(viewport, 'keydown').length, 0)
})

test('菜单保留坐标、状态和业务回调，开关菜单不执行动作', context => {
  const { menu } = mountOverlays(context)
  let calls = 0
  const items = [{ id: 'delete', label: '删除', danger: true, disabled: true, action: () => { calls++ } }]
  const event = menuEvent(120, 240)
  menu.openContextMenu(event, '终端菜单', items, '当前终端始终接收输入')
  assert.equal(event.defaultPrevented, false)
  assert.deepEqual(menu.contextMenu.value, { x: 120, y: 240, title: '终端菜单', items, description: '当前终端始终接收输入' })
  menu.closeContextMenu()
  assert.equal(calls, 0)
  assert.equal(menu.contextMenu.value, null)
})

test('定位使用实际尺寸处理边界，短菜单无需固定高度上限', () => {
  assert.deepEqual(placeContextMenu(100, 200, 232, 360, 1440, 900), { x: 100, y: 200 })
  assert.deepEqual(placeContextMenu(1430, 890, 232, 360, 1440, 900), { x: 1200, y: 532 })
  assert.deepEqual(placeContextMenu(-20, -30, 232, 360, 1440, 900), { x: 8, y: 8 })
  assert.deepEqual(placeContextMenu(700, 500, 184, 74, 200, 90), { x: 8, y: 8 })
  assert.deepEqual(placeContextMenu(950, 650, 280, 416, 1000, 700), { x: 712, y: 276 })
})

test('打开时保留原始锚点，实际 DOM 渲染后再决定位置', context => {
  const { menu } = mountOverlays(context)
  menu.openContextMenu(menuEvent(1500, 1000), '菜单', createItems(20))
  assert.equal(menu.contextMenu.value.x, 1500)
  assert.equal(menu.contextMenu.value.y, 1000)
})

test('菜单导航在可用项中循环，支持首尾及空菜单', () => {
  assert.equal(nextMenuIndex(0, -1, 'ArrowDown'), -1)
  assert.equal(nextMenuIndex(3, -1, 'ArrowDown'), 0)
  assert.equal(nextMenuIndex(3, -1, 'ArrowUp'), 2)
  assert.equal(nextMenuIndex(3, 2, 'ArrowDown'), 0)
  assert.equal(nextMenuIndex(3, 0, 'ArrowUp'), 2)
  assert.equal(nextMenuIndex(3, 1, 'Home'), 0)
  assert.equal(nextMenuIndex(3, 1, 'End'), 2)
})

test('打开新菜单关闭旧层，旧层清理不能释放新的顶层', () => {
  let firstCloses = 0
  const first = activateMenuLayer(() => { firstCloses++; first.release() })
  assert.equal(first.isTop(), true)
  const second = activateMenuLayer(() => {})
  assert.equal(firstCloses, 1)
  assert.equal(first.isTop(), false)
  first.release()
  assert.equal(second.isTop(), true)
  second.release()
  assert.equal(second.isTop(), false)
})

test('一个右键手势可以直接替换菜单目标及动作', context => {
  const { menu } = mountOverlays(context)
  menu.openContextMenu(menuEvent(), '连接', createItems(3))
  menu.openContextMenu(menuEvent(300, 400), '终端', createItems(2))
  assert.equal(menu.contextMenu.value.title, '终端')
  assert.equal(menu.contextMenu.value.items.length, 2)
  menu.closeContextMenu()
  menu.closeContextMenu()
  assert.equal(menu.contextMenu.value, null)
})

test('卸载关闭菜单，迟到的事件不能重新打开', context => {
  const { menu, unmount } = mountOverlays(context)
  menu.openContextMenu(menuEvent(), '菜单', createItems())
  unmount()
  assert.equal(menu.contextMenu.value, null)
  menu.openContextMenu(menuEvent(), '迟到的菜单', createItems())
  assert.equal(menu.contextMenu.value, null)
})
