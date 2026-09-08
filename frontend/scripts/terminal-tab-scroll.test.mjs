import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import test from 'node:test'
import { createRenderer, markRaw, nextTick, ref } from 'vue'
import { useTerminalTabScroll } from '../src/composables/useTerminalTabScroll.ts'

const renderer = createRenderer({
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
  parentNode: () => null, nextSibling: () => null
})

class ScrollElement {
  clientWidth = 100
  scrollWidth = 400
  scrollLeft = 0
  parentElement = null
  captured = new Set()
  scrollCalls = []
  getBoundingClientRect() { return { left: 10, width: this.clientWidth } }
  setPointerCapture(id) { this.captured.add(id) }
  hasPointerCapture(id) { return this.captured.has(id) }
  releasePointerCapture(id) { this.captured.delete(id) }
  scrollIntoView(options) { this.scrollCalls.push(options) }
}

function pointer(element, clientX = 0, target = element) {
  return {
    target, currentTarget: element, clientX, pointerId: 1, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true }
  }
}

async function mountScroll(context, options = {}) {
  const viewport = new EventTarget()
  const observers = []
  class FakeResizeObserver {
    constructor(callback) { this.callback = callback; observers.push(this) }
    observe(element) { this.element = element }
    disconnect() { this.disconnected = true }
  }
  const globals = { window: viewport, HTMLElement: ScrollElement, HTMLButtonElement: ScrollElement,
    ResizeObserver: options.noObserver ? undefined : FakeResizeObserver }
  const descriptors = Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value })
  const terminalTabs = ref([{ id: 'local-1' }])
  const activeTerminalId = ref('local-1')
  const leftCollapsed = ref(false)
  const rightCollapsed = ref(false)
  const strip = markRaw(Object.assign(new ScrollElement(), options.dimensions))
  let state
  let unmounted = false
  const app = renderer.createApp({ setup() {
    state = useTerminalTabScroll({ terminalTabs, activeTerminalId, leftCollapsed, rightCollapsed })
    state.sessionTabStrip.value = options.noStrip ? null : strip
    return () => null
  } })
  function unmount() { if (!unmounted) { unmounted = true; app.unmount() } }
  context.after(() => {
    unmount()
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  })
  app.mount({})
  if (options.unmountImmediately) unmount()
  await nextTick()
  return { state, strip, viewport, observers, terminalTabs, activeTerminalId, leftCollapsed, rightCollapsed, unmount }
}

function assertNoDragListeners(viewport) {
  for (const type of ['pointermove', 'pointerup', 'pointercancel']) assert.equal(getEventListeners(viewport, type).length, 0)
}

test('挂载测量、溢出 2px 阈值和最小 8% 滑块保持原算法', async context => {
  const { state, strip } = await mountScroll(context)
  assert.equal(state.sessionTabOverflow.value, true)
  assert.deepEqual(state.sessionTabThumbStyle.value, { left: '0%', width: '25%' })
  strip.scrollLeft = 150
  state.handleSessionTabScroll()
  assert.deepEqual(state.sessionTabThumbStyle.value, { left: '37.5%', width: '25%' })
  strip.scrollWidth = 10000
  state.handleSessionTabScroll()
  assert.equal(state.sessionTabThumbStyle.value.width, '8%')
  strip.scrollWidth = 102
  state.handleSessionTabScroll()
  assert.equal(state.sessionTabOverflow.value, false)
  strip.scrollWidth = 103
  state.handleSessionTabScroll()
  assert.equal(state.sessionTabOverflow.value, true)
})

test('无容器与零宽容器不产生无效百分比或溢出', async context => {
  const { state } = await mountScroll(context, { noStrip: true })
  assert.equal(state.sessionTabOverflow.value, false)
  assert.deepEqual(state.sessionTabThumbStyle.value, { left: '0%', width: '100%' })
  state.handleSessionTabScroll()
  state.sessionTabStrip.value = markRaw(Object.assign(new ScrollElement(), { clientWidth: 0, scrollWidth: 0 }))
  state.handleSessionTabScroll()
  assert.deepEqual(state.sessionTabThumbStyle.value, { left: '0%', width: '100%' })
})

test('滚轮使用较大轴并钳制边界，仅实际滚动时阻止默认行为', async context => {
  const { state, strip } = await mountScroll(context)
  const wheel = (deltaX, deltaY) => Object.assign(new Event('wheel', { cancelable: true }), { deltaX, deltaY })
  const vertical = wheel(20, 80)
  state.handleSessionTabWheel(vertical)
  assert.equal(strip.scrollLeft, 80)
  assert.equal(vertical.defaultPrevented, true)
  state.handleSessionTabWheel(wheel(50, 10))
  assert.equal(strip.scrollLeft, 130)
  state.handleSessionTabWheel(wheel(0, 999))
  assert.equal(strip.scrollLeft, 300)
  const end = wheel(0, 10)
  state.handleSessionTabWheel(end)
  assert.equal(end.defaultPrevented, false)
  state.handleSessionTabWheel(wheel(-999, 0))
  assert.equal(strip.scrollLeft, 0)
  const zero = wheel(0, 0)
  state.handleSessionTabWheel(zero)
  assert.equal(zero.defaultPrevented, false)
  strip.scrollWidth = 100
  state.handleSessionTabScroll()
  const fits = wheel(0, 100)
  state.handleSessionTabWheel(fits)
  assert.equal(fits.defaultPrevented, false)
})

test('轨道点击保持最小 28px 算法，忽略子元素冒泡并限制两端', async context => {
  const { state, strip } = await mountScroll(context)
  const track = new ScrollElement()
  state.handleSessionTabScrollbarPointerDown(pointer(track, 60))
  assert.equal(strip.scrollLeft, 150)
  state.handleSessionTabScrollbarPointerDown(pointer(track, 0, new ScrollElement()))
  assert.equal(strip.scrollLeft, 150)
  state.handleSessionTabScrollbarPointerDown(pointer(track, -100))
  assert.equal(strip.scrollLeft, 0)
  state.handleSessionTabScrollbarPointerDown(pointer(track, 1000))
  assert.equal(strip.scrollLeft, 300)
})

test('滑块拖动换算为内容距离，pointerup 清理监听与指针捕获', async context => {
  const { state, strip, viewport } = await mountScroll(context)
  const thumb = Object.assign(new ScrollElement(), { clientWidth: 25, parentElement: new ScrollElement() })
  const down = pointer(thumb, 10)
  state.handleSessionTabThumbPointerDown(down)
  assert.equal(down.defaultPrevented, true)
  assert.equal(thumb.hasPointerCapture(1), true)
  viewport.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 35 }))
  assert.equal(strip.scrollLeft, 100)
  viewport.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 1000 }))
  assert.equal(strip.scrollLeft, 300)
  viewport.dispatchEvent(new Event('pointerup'))
  assertNoDragListeners(viewport)
  assert.equal(thumb.hasPointerCapture(1), false)
})

test('重复拖动先释放前一次监听，取消和卸载均完整清理', async context => {
  const { state, viewport, unmount } = await mountScroll(context)
  const thumb = Object.assign(new ScrollElement(), { clientWidth: 25, parentElement: new ScrollElement() })
  state.handleSessionTabThumbPointerDown(pointer(thumb))
  state.handleSessionTabThumbPointerDown(pointer(thumb))
  assert.equal(getEventListeners(viewport, 'pointermove').length, 1)
  viewport.dispatchEvent(new Event('pointercancel'))
  assertNoDragListeners(viewport)
  state.handleSessionTabThumbPointerDown(pointer(thumb))
  unmount()
  assertNoDragListeners(viewport)
  assert.equal(thumb.hasPointerCapture(1), false)
  state.handleSessionTabThumbPointerDown(pointer(thumb))
  assertNoDragListeners(viewport)
})

test('ResizeObserver、窗口 resize 和左右折叠均重新测量', async context => {
  const { state, strip, observers, viewport, leftCollapsed, rightCollapsed } = await mountScroll(context)
  assert.equal(observers[0].element, strip)
  strip.clientWidth = 200
  observers[0].callback()
  assert.equal(state.sessionTabThumbStyle.value.width, '50%')
  strip.clientWidth = 300
  viewport.dispatchEvent(new Event('resize'))
  assert.equal(state.sessionTabThumbStyle.value.width, '75%')
  strip.clientWidth = 100
  leftCollapsed.value = true
  await nextTick(); await nextTick()
  assert.equal(state.sessionTabThumbStyle.value.width, '25%')
  strip.clientWidth = 200
  rightCollapsed.value = true
  await nextTick(); await nextTick()
  assert.equal(state.sessionTabThumbStyle.value.width, '50%')
})

test('切换和增删标签在 DOM 更新后平滑定位活动标签', async context => {
  const { state, terminalTabs, activeTerminalId } = await mountScroll(context)
  const button = new ScrollElement()
  state.setSessionTabButton('second', button)
  terminalTabs.value.push({ id: 'second' })
  activeTerminalId.value = 'second'
  await nextTick(); await nextTick()
  assert.deepEqual(button.scrollCalls, [{ behavior: 'smooth', block: 'nearest', inline: 'nearest' }])
  terminalTabs.value.push({ id: 'third' })
  await nextTick(); await nextTick()
  assert.equal(button.scrollCalls.length, 2)
  state.setSessionTabButton('second', null)
  terminalTabs.value.pop()
  await nextTick(); await nextTick()
  assert.equal(button.scrollCalls.length, 2)
})

test('卸载阻止待执行的 nextTick、迟到的观察回调和 DOM 引用注册', async context => {
  const { state, strip, observers, viewport, activeTerminalId, unmount } = await mountScroll(context)
  const button = new ScrollElement()
  state.setSessionTabButton('second', button)
  activeTerminalId.value = 'second'
  await nextTick()
  unmount()
  await nextTick()
  assert.equal(button.scrollCalls.length, 0)
  assert.equal(observers[0].disconnected, true)
  assert.equal(getEventListeners(viewport, 'resize').length, 0)
  strip.clientWidth = 400
  observers[0].callback()
  assert.equal(state.sessionTabThumbStyle.value.width, '25%')
  state.setSessionTabButton('second', button)
  assert.equal(button.scrollCalls.length, 0)
})

test('挂载后立即卸载不创建观察器或遗留监听', async context => {
  const { observers, viewport } = await mountScroll(context, { unmountImmediately: true })
  assert.equal(observers.length, 0)
  assert.equal(getEventListeners(viewport, 'resize').length, 0)
  assertNoDragListeners(viewport)
})

test('不支持 ResizeObserver 时窗口事件仍能更新滚动指标', async context => {
  const { state, strip, viewport } = await mountScroll(context, { noObserver: true })
  strip.clientWidth = 200
  viewport.dispatchEvent(new Event('resize'))
  assert.equal(state.sessionTabThumbStyle.value.width, '50%')
})
