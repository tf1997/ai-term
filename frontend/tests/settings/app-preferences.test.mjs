import assert from 'node:assert/strict'
import test from 'node:test'
import { createRenderer, isReadonly, nextTick } from 'vue'
import { useAppTheme } from "../../src/domains/settings/application/useAppTheme"
import { useUserSettings } from "../../src/domains/settings/application/useUserSettings"
import { APP_THEME_STORAGE_KEY, USER_SETTINGS_STORAGE_KEY } from "../../src/domains/settings/infrastructure/storage/settingsStorage"
import { SYSTEM_TERMINAL_FONT_FAMILY, WINDOWS_TERMINAL_FONT_FAMILY } from "../../src/domains/settings/domain/userSettings"

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
  createElement: () => ({}),
  createText: () => ({}),
  createComment: () => ({}),
  insert() {},
  remove() {},
  setText() {},
  setElementText() {},
  parentNode: () => null,
  nextSibling: () => null,
  patchProp() {}
})

class ThemeButton extends EventTarget {
  added = []
  removed = []

  addEventListener(type, listener, options) {
    this.added.push([type, listener, options])
    super.addEventListener(type, listener, options)
  }

  removeEventListener(type, listener, options) {
    this.removed.push([type, listener, options])
    super.removeEventListener(type, listener, typeof options === 'boolean' ? { capture: options } : options)
  }
}

function mountTheme(context, storage = createStorage()) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const classes = new Set(['theme-dark', 'app-root'])
  const root = {
    dataset: {},
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name)
        else classes.delete(name)
        return enabled
      }
    }
  }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: root } })
  const button = new ThemeButton()
  const changes = []
  let state
  const app = renderer.createApp({
    setup() {
      state = useAppTheme({ storage, onThemeChange: (theme) => changes.push(theme) })
      state.themeToggleButton.value = button
      return () => null
    }
  })
  app.mount({})
  let unmounted = false
  function unmount() {
    if (unmounted) return
    app.unmount()
    unmounted = true
  }
  context.after(() => {
    unmount()
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor)
    else delete globalThis.document
  })
  return { state, storage, button, changes, root, classes, unmount }
}

test('设置 composable 只公开只读状态，各实例独立且不共享默认值', () => {
  const windows = useUserSettings(true, createStorage())
  const system = useUserSettings(false, createStorage())
  assert.equal(isReadonly(windows.appSettings), true)
  assert.equal(isReadonly(windows.appSettings.value), true)
  assert.equal(windows.appSettings.value.terminalFontFamily, WINDOWS_TERMINAL_FONT_FAMILY)
  assert.equal(system.appSettings.value.terminalFontFamily, SYSTEM_TERMINAL_FONT_FAMILY)
  windows.updateUserSettings({ ...windows.appSettings.value, terminalFontSize: 20 })
  assert.equal(system.appSettings.value.terminalFontSize, 13)
})

test('设置唯一更新入口再次校验预算，并持久化实际生效的值', () => {
  const storage = createStorage({ [USER_SETTINGS_STORAGE_KEY]: JSON.stringify({ defaultShell: 'pwsh' }) })
  const { appSettings, updateUserSettings } = useUserSettings(true, storage)
  const draft = { ...appSettings.value, terminalFontSize: 99, agentStepLimit: 99, agentCommandTimeoutSec: 1, agentAutoExecReadonly: false }
  assert.equal(updateUserSettings(draft), true)
  assert.equal(appSettings.value.terminalFontSize, 22)
  assert.equal(appSettings.value.agentStepLimit, 25)
  assert.equal(appSettings.value.agentCommandTimeoutSec, 15)
  assert.equal(appSettings.value.agentAutoExecReadonly, false)
  assert.equal(appSettings.value.defaultShell, 'pwsh')
  assert.deepEqual(JSON.parse(storage.getItem(USER_SETTINGS_STORAGE_KEY)), { ...appSettings.value })
  draft.terminalFontSize = 11
  assert.equal(appSettings.value.terminalFontSize, 22)
})

test('存储写入失败返回 false，但设置仍立即应用到当前会话', () => {
  const storage = { getItem: () => null, setItem() { throw new Error('quota exceeded') } }
  const { appSettings, updateUserSettings } = useUserSettings(false, storage)
  assert.equal(updateUserSettings({ ...appSettings.value, terminalFontSize: 18 }), false)
  assert.equal(appSettings.value.terminalFontSize, 18)
})

test('挂载时恢复浅色主题并同步根节点，不触发用户切换提示', (context) => {
  const { state, root, classes, changes } = mountTheme(context, createStorage({ [APP_THEME_STORAGE_KEY]: 'light' }))
  assert.equal(isReadonly(state.appTheme), true)
  assert.equal(state.appTheme.value, 'light')
  assert.equal(root.dataset.theme, 'light')
  assert.equal(classes.has('theme-light'), true)
  assert.equal(classes.has('theme-dark'), false)
  assert.equal(classes.has('app-root'), true)
  assert.deepEqual(changes, [])
})

test('主题切换同步响应式状态、持久化和根节点样式', async (context) => {
  const { state, root, classes, changes, storage } = mountTheme(context)
  assert.equal(state.appTheme.value, 'dark')
  state.toggleAppTheme()
  await nextTick()
  assert.equal(state.appTheme.value, 'light')
  assert.equal(root.dataset.theme, 'light')
  assert.equal(storage.getItem(APP_THEME_STORAGE_KEY), 'light')
  assert.deepEqual(changes, ['light'])
  state.toggleAppTheme()
  await nextTick()
  assert.equal(root.dataset.theme, 'dark')
  assert.equal(classes.has('theme-light'), false)
  assert.equal(classes.has('theme-dark'), true)
})

test('存储完全不可用时主题仍可正常切换', async (context) => {
  const storage = {
    getItem() { throw new Error('storage blocked') },
    setItem() { throw new Error('storage blocked') }
  }
  const { state, root } = mountTheme(context, storage)
  state.toggleAppTheme()
  await nextTick()
  assert.equal(root.dataset.theme, 'light')
})

test('首个指针事件立即响应，一组 pointerdown、mousedown、click 只切换一次', async (context) => {
  let now = 0
  context.mock.method(performance, 'now', () => now)
  const { state, button, changes, root } = mountTheme(context)
  let fallbackClicks = 0
  button.addEventListener('click', () => { fallbackClicks += 1 })
  for (const eventType of ['pointerdown', 'mousedown', 'click']) {
    const event = new Event(eventType, { cancelable: true })
    button.dispatchEvent(event)
    assert.equal(event.defaultPrevented, true)
  }
  await nextTick()
  assert.equal(state.appTheme.value, 'light')
  assert.equal(root.dataset.theme, 'light')
  assert.equal(fallbackClicks, 0)
  assert.deepEqual(changes, ['light'])
  now = 160
  button.dispatchEvent(new Event('pointerdown'))
  await nextTick()
  assert.equal(state.appTheme.value, 'dark')
  assert.deepEqual(changes, ['light', 'dark'])
})

test('键盘产生的独立 click 事件可以切换主题', async (context) => {
  context.mock.method(performance, 'now', () => 0)
  const { state, button } = mountTheme(context)
  button.dispatchEvent(new Event('click'))
  await nextTick()
  assert.equal(state.appTheme.value, 'light')
})

test('卸载时清理原按钮的全部捕获监听器，并停止主题 watcher', async (context) => {
  const { state, button, unmount, root, storage, changes } = mountTheme(context)
  assert.deepEqual(button.added.map(([type, , capture]) => [type, capture]), [
    ['pointerdown', true], ['mousedown', true], ['click', true]
  ])
  state.themeToggleButton.value = null
  unmount()
  assert.deepEqual(button.removed, button.added)
  for (const eventType of ['pointerdown', 'mousedown', 'click']) {
    button.dispatchEvent(new Event(eventType))
  }
  assert.deepEqual(changes, [])
  const writeCount = storage.writes.length
  state.toggleAppTheme()
  await nextTick()
  assert.equal(root.dataset.theme, 'dark')
  assert.equal(storage.writes.length, writeCount)
})
