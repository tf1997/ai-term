import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import test from 'node:test'
import { createRenderer, markRaw, nextTick, ref } from 'vue'
import { useTerminalTabScroll } from "../../src/domains/terminal/application/useTerminalTabScroll"

const renderer = createRenderer({
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
  parentNode: () => null, nextSibling: () => null
})

class ScrollElement {
  clientWidth = 100
  scrollWidth = 400
  scrollLeft = 0
  clientLeft = 0
  offsetLeft = 0
  parentElement = null
  isTab = false
  deferSmoothScroll = false
  scrollCalls = []
  scrollIntoViewCalls = []
  constructor(properties = {}) { Object.assign(this, properties) }
  getBoundingClientRect() {
    const parent = this.parentElement
    const left = parent
      ? parent.getBoundingClientRect().left + parent.clientLeft + this.offsetLeft - parent.scrollLeft
      : 10
    return { left, right: left + this.clientWidth, width: this.clientWidth }
  }
  closest(selector) {
    return selector === '.tab' && this.isTab ? this : this.parentElement?.closest(selector) ?? null
  }
  contains(element) {
    for (let current = element; current; current = current.parentElement) {
      if (current === this) return true
    }
    return false
  }
  scrollTo(options) {
    this.scrollCalls.push(options)
    if (!this.deferSmoothScroll || options.behavior !== 'smooth') this.scrollLeft = options.left
  }
  scrollIntoView(options) { this.scrollIntoViewCalls.push(options) }
}

class TabButton extends ScrollElement {}

async function flushLayout() {
  await nextTick()
  await nextTick()
}

function wheel(deltaX, deltaY, properties = {}) {
  return Object.assign(new Event('wheel', { cancelable: true }), { deltaX, deltaY, deltaMode: 0, ctrlKey: false }, properties)
}

async function mountScroll(context, options = {}) {
  const viewport = new EventTarget()
  const observers = []
  class FakeResizeObserver {
    observed = new Set()
    constructor(callback) { this.callback = callback; observers.push(this) }
    observe(element) { this.observed.add(element) }
    unobserve(element) { this.observed.delete(element) }
    disconnect() { this.disconnected = true; this.observed.clear() }
  }
  const globals = { window: viewport, HTMLElement: ScrollElement, HTMLButtonElement: TabButton,
    ResizeObserver: options.noObserver ? undefined : FakeResizeObserver }
  const descriptors = Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value })
  const terminalTabs = ref(options.tabs ?? [{ id: 'local-1' }])
  const activeTerminalId = ref(options.activeId ?? 'local-1')
  const leftCollapsed = ref(false)
  const rightCollapsed = ref(false)
  const strip = markRaw(new ScrollElement(options.dimensions))
  let state
  let unmounted = false
  function renderTab(id, properties = {}) {
    const tab = new ScrollElement({ clientWidth: 80, isTab: true, parentElement: strip, ...properties })
    const button = new TabButton({ clientWidth: Math.max(0, tab.clientWidth - 24), parentElement: tab })
    state.setSessionTabButton(id, button)
    return { tab, button }
  }
  const app = renderer.createApp({ setup() {
    state = useTerminalTabScroll({ terminalTabs, activeTerminalId,
      ...(options.withCollapsed ? { leftCollapsed, rightCollapsed } : {}) })
    state.sessionTabStrip.value = options.noStrip ? null : strip
    for (const tab of options.renderedTabs ?? []) renderTab(tab.id, tab)
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
  await flushLayout()
  return { state, strip, viewport, observers, terminalTabs, activeTerminalId, leftCollapsed, rightCollapsed, renderTab, unmount }
}

test('左右按钮使用实际滚动位置，忽略边缘亚像素误差和弹性越界', async context => {
  const { state, strip } = await mountScroll(context)
  assert.equal(state.sessionTabOverflow.value, true)
  assert.equal(state.sessionTabCanScrollLeft.value, false)
  assert.equal(state.sessionTabCanScrollRight.value, true)
  strip.scrollLeft = 150
  state.handleSessionTabScroll()
  assert.equal(state.sessionTabCanScrollLeft.value, true)
  assert.equal(state.sessionTabCanScrollRight.value, true)
  strip.scrollLeft = 299.75
  state.handleSessionTabScroll()
  assert.equal(state.sessionTabCanScrollRight.value, false)
  strip.scrollLeft = 340
  state.handleSessionTabScroll()
  assert.equal(state.sessionTabCanScrollRight.value, false)
  strip.scrollLeft = -12
  state.handleSessionTabScroll()
  assert.equal(state.sessionTabCanScrollLeft.value, false)
  strip.scrollWidth = 101
  state.handleSessionTabScroll()
  assert.equal(state.sessionTabOverflow.value, false)
  assert.equal(state.sessionTabCanScrollRight.value, false)
  strip.scrollWidth = 102
  state.handleSessionTabScroll()
  assert.equal(state.sessionTabOverflow.value, true)
  assert.equal(state.sessionTabCanScrollRight.value, true)
})

test('无容器和隐藏容器禁用滚动，容器替换后重新观察和测量', async context => {
  const { state, observers } = await mountScroll(context, { noStrip: true })
  assert.equal(state.sessionTabOverflow.value, false)
  assert.equal(state.sessionTabCanScrollLeft.value, false)
  assert.equal(state.sessionTabCanScrollRight.value, false)
  state.scrollSessionTabs(1)
  state.handleSessionTabWheel(wheel(0, 10))
  const hidden = markRaw(new ScrollElement({ clientWidth: 0 }))
  state.sessionTabStrip.value = hidden
  await flushLayout()
  assert.equal(state.sessionTabOverflow.value, false)
  assert.equal(observers[0].observed.has(hidden), true)
  state.scrollSessionTabs(1)
  assert.equal(hidden.scrollCalls.length, 0)
  const visible = markRaw(new ScrollElement({ clientWidth: 200 }))
  state.sessionTabStrip.value = visible
  await flushLayout()
  assert.equal(observers[0].observed.has(hidden), false)
  assert.equal(observers[0].observed.has(visible), true)
  assert.equal(state.sessionTabCanScrollRight.value, true)
  state.sessionTabStrip.value = null
  await flushLayout()
  assert.equal(state.sessionTabCanScrollRight.value, false)
})

test('按钮每次平滑滚动 75% 视口，最后一页钳制到内容边界', async context => {
  const { state, strip } = await mountScroll(context)
  state.scrollSessionTabs(-1)
  assert.equal(strip.scrollCalls.length, 0)
  state.scrollSessionTabs(1)
  assert.deepEqual(strip.scrollCalls, [{ left: 75, behavior: 'smooth' }])
  assert.equal(state.sessionTabCanScrollLeft.value, true)
  strip.scrollLeft = 270
  state.scrollSessionTabs(1)
  assert.deepEqual(strip.scrollCalls.at(-1), { left: 300, behavior: 'smooth' })
  assert.equal(state.sessionTabCanScrollRight.value, false)
  state.scrollSessionTabs(1)
  assert.equal(strip.scrollCalls.length, 2)
  state.scrollSessionTabs(-1)
  assert.deepEqual(strip.scrollCalls.at(-1), { left: 225, behavior: 'smooth' })
})

test('平滑动画完成前不把目标位置当作已滚动位置', async context => {
  const { state, strip } = await mountScroll(context, { dimensions: { scrollLeft: 270, deferSmoothScroll: true } })
  state.scrollSessionTabs(1)
  assert.equal(strip.scrollCalls.at(-1).left, 300)
  assert.equal(state.sessionTabCanScrollRight.value, true)
  strip.scrollLeft = 300
  state.handleSessionTabScroll()
  assert.equal(state.sessionTabCanScrollRight.value, false)
})

test('滚轮支持主轴、行和整页单位，Ctrl 缩放保持默认行为', async context => {
  const { state, strip } = await mountScroll(context)
  const vertical = wheel(20, 80)
  state.handleSessionTabWheel(vertical)
  assert.equal(strip.scrollLeft, 80)
  assert.equal(vertical.defaultPrevented, true)
  state.handleSessionTabWheel(wheel(50, 10))
  assert.equal(strip.scrollLeft, 130)
  state.handleSessionTabWheel(wheel(0, 2, { deltaMode: 1 }))
  assert.equal(strip.scrollLeft, 162)
  state.handleSessionTabWheel(wheel(-1, 0, { deltaMode: 2 }))
  assert.equal(strip.scrollLeft, 62)
  const zoom = wheel(0, 100, { ctrlKey: true })
  state.handleSessionTabWheel(zoom)
  assert.equal(zoom.defaultPrevented, false)
  assert.equal(strip.scrollLeft, 62)
  state.handleSessionTabWheel(wheel(0, 0.25))
  assert.equal(strip.scrollLeft, 62.25)
})

test('滚轮只在实际滚动时阻止默认行为，并读取最新内容宽度', async context => {
  const { state, strip } = await mountScroll(context)
  const start = wheel(0, -10)
  state.handleSessionTabWheel(start)
  assert.equal(start.defaultPrevented, false)
  state.handleSessionTabWheel(wheel(0, 999))
  assert.equal(strip.scrollLeft, 300)
  const end = wheel(0, 10)
  state.handleSessionTabWheel(end)
  assert.equal(end.defaultPrevented, false)
  const zero = wheel(0, 0)
  state.handleSessionTabWheel(zero)
  assert.equal(zero.defaultPrevented, false)
  strip.scrollWidth = 500
  state.handleSessionTabWheel(wheel(0, 50))
  assert.equal(strip.scrollLeft, 350)
  state.handleSessionTabWheel(wheel(-999, 0))
  assert.equal(strip.scrollLeft, 0)
  strip.scrollWidth = 100
  const fits = wheel(0, 100)
  state.handleSessionTabWheel(fits)
  assert.equal(fits.defaultPrevented, false)
  assert.equal(state.sessionTabOverflow.value, false)
})

test('切换标签显示整个外壳和关闭按钮，只滚动标签容器', async context => {
  const { state, strip, activeTerminalId, renderTab } = await mountScroll(context, { dimensions: { clientLeft: 2 } })
  const { tab, button } = renderTab('second', { offsetLeft: 50, clientWidth: 80 })
  button.clientWidth = 40
  await flushLayout()
  assert.ok(button.getBoundingClientRect().right <= strip.getBoundingClientRect().left + strip.clientLeft + strip.clientWidth)
  activeTerminalId.value = 'second'
  await flushLayout()
  assert.deepEqual(strip.scrollCalls, [{ left: 30, behavior: 'smooth' }])
  assert.equal(tab.getBoundingClientRect().right, strip.getBoundingClientRect().left + strip.clientLeft + strip.clientWidth)
  assert.equal(tab.scrollIntoViewCalls.length, 0)
  assert.equal(button.scrollIntoViewCalls.length, 0)
  renderTab('local-1', { offsetLeft: 0, clientWidth: 60 })
  await flushLayout()
  activeTerminalId.value = 'local-1'
  await flushLayout()
  assert.deepEqual(strip.scrollCalls.at(-1), { left: 0, behavior: 'smooth' })
  const calls = strip.scrollCalls.length
  activeTerminalId.value = 'missing'
  await flushLayout()
  activeTerminalId.value = 'local-1'
  await flushLayout()
  assert.equal(strip.scrollCalls.length, calls)
})

test('初次挂载定位已选中的远端标签，超宽标签对齐起始位置且不反复跳动', async context => {
  const { strip, observers } = await mountScroll(context, {
    activeId: 'remote', tabs: [{ id: 'local-1' }, { id: 'remote' }],
    renderedTabs: [{ id: 'remote', offsetLeft: 170, clientWidth: 150 }]
  })
  assert.equal(strip.scrollLeft, 170)
  assert.equal(strip.scrollCalls.length, 1)
  observers[0].callback()
  await flushLayout()
  assert.equal(strip.scrollCalls.length, 1)
})

test('标签数量不变的重新排序也保持当前标签可见', async context => {
  const { strip, terminalTabs, activeTerminalId, renderTab } = await mountScroll(context, {
    tabs: [{ id: 'local-1' }, { id: 'second' }]
  })
  const { tab } = renderTab('second', { offsetLeft: 200, clientWidth: 60 })
  await flushLayout()
  activeTerminalId.value = 'second'
  await flushLayout()
  assert.equal(strip.scrollLeft, 160)
  tab.offsetLeft = 40
  terminalTabs.value.reverse()
  await flushLayout()
  assert.deepEqual(strip.scrollCalls.at(-1), { left: 40, behavior: 'smooth' })
})

test('连接状态更新替换标签数组时保留用户手动滚动的位置', async context => {
  const { state, strip, terminalTabs, activeTerminalId, renderTab } = await mountScroll(context, {
    tabs: [{ id: 'local-1', status: 'local' }, { id: 'second', status: 'connecting' }]
  })
  renderTab('local-1', { offsetLeft: 0, clientWidth: 80 })
  renderTab('second', { offsetLeft: 200, clientWidth: 80 })
  await flushLayout()
  state.handleSessionTabWheel(wheel(0, 150))
  assert.equal(strip.scrollLeft, 150)
  const calls = strip.scrollCalls.length
  terminalTabs.value = terminalTabs.value.map(tab => ({ ...tab, status: tab.id === 'second' ? 'remote' : tab.status }))
  await flushLayout()
  assert.equal(strip.scrollLeft, 150)
  assert.equal(strip.scrollCalls.length, calls)
  assert.equal(state.sessionTabCanScrollLeft.value, true)
  activeTerminalId.value = 'second'
  await flushLayout()
  assert.deepEqual(strip.scrollCalls.at(-1), { left: 180, behavior: 'smooth' })
})

test('ResizeObserver、窗口变化和侧栏折叠保持当前标签完整可见', async context => {
  const { strip, observers, viewport, leftCollapsed, rightCollapsed, renderTab } = await mountScroll(context, {
    dimensions: { clientWidth: 200 }, withCollapsed: true
  })
  const { tab } = renderTab('local-1', { offsetLeft: 120, clientWidth: 80 })
  await flushLayout()
  assert.equal(observers[0].observed.has(strip), true)
  assert.equal(observers[0].observed.has(tab), true)
  assert.equal(strip.scrollLeft, 0)
  strip.clientWidth = 150
  observers[0].callback()
  await flushLayout()
  assert.equal(strip.scrollLeft, 50)
  tab.clientWidth = 100
  observers[0].callback()
  await flushLayout()
  assert.equal(strip.scrollLeft, 70)
  strip.clientWidth = 140
  viewport.dispatchEvent(new Event('resize'))
  await flushLayout()
  assert.equal(strip.scrollLeft, 80)
  strip.clientWidth = 120
  leftCollapsed.value = true
  await flushLayout()
  assert.equal(strip.scrollLeft, 100)
  strip.clientWidth = 110
  rightCollapsed.value = true
  await flushLayout()
  assert.equal(strip.scrollLeft, 110)
})

test('注销或替换标签引用后释放旧元素观察，忽略已移出容器的标签', async context => {
  const { state, strip, observers, activeTerminalId, renderTab } = await mountScroll(context)
  const first = renderTab('second', { offsetLeft: 200 })
  await flushLayout()
  const replacement = renderTab('second', { offsetLeft: 200 })
  await flushLayout()
  assert.equal(observers[0].observed.has(first.tab), false)
  assert.equal(observers[0].observed.has(replacement.tab), true)
  replacement.tab.parentElement = null
  activeTerminalId.value = 'second'
  await flushLayout()
  assert.equal(strip.scrollCalls.length, 0)
  state.setSessionTabButton('second', null)
  assert.equal(observers[0].observed.has(replacement.tab), false)
  assert.equal(observers[0].observed.has(strip), true)
})

test('不支持 ResizeObserver 时窗口事件仍保持活动标签可见', async context => {
  const { strip, viewport, renderTab } = await mountScroll(context, { noObserver: true, dimensions: { clientWidth: 200 } })
  renderTab('local-1', { offsetLeft: 120, clientWidth: 80 })
  await flushLayout()
  strip.clientWidth = 100
  viewport.dispatchEvent(new Event('resize'))
  await flushLayout()
  assert.equal(strip.scrollLeft, 100)
})

test('卸载阻止待执行定位、迟到的观察回调和滚动事件，并释放监听', async context => {
  const { state, strip, observers, viewport, activeTerminalId, renderTab, unmount } = await mountScroll(context)
  const { button } = renderTab('second', { offsetLeft: 200 })
  await flushLayout()
  activeTerminalId.value = 'second'
  await nextTick()
  unmount()
  await flushLayout()
  assert.equal(strip.scrollCalls.length, 0)
  assert.equal(observers[0].disconnected, true)
  assert.equal(observers[0].observed.size, 0)
  assert.equal(getEventListeners(viewport, 'resize').length, 0)
  strip.clientWidth = 400
  observers[0].callback()
  state.handleSessionTabScroll()
  state.scrollSessionTabs(1)
  const lateWheel = wheel(0, 20)
  state.handleSessionTabWheel(lateWheel)
  state.setSessionTabButton('second', button)
  await flushLayout()
  assert.equal(state.sessionTabOverflow.value, true)
  assert.equal(strip.scrollCalls.length, 0)
  assert.equal(lateWheel.defaultPrevented, false)
  assert.equal(observers[0].observed.size, 0)
})

test('挂载后立即卸载不创建观察器或遗留监听', async context => {
  const { observers, viewport } = await mountScroll(context, { unmountImmediately: true })
  assert.equal(observers.length, 0)
  assert.equal(getEventListeners(viewport, 'resize').length, 0)
})
