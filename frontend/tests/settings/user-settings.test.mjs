import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampAgentCommandTimeoutSec,
  createDefaultUserSettings,
  LEGACY_WINDOWS_TERMINAL_FONT_FAMILY,
  normalizeUserSettings,
  SYSTEM_TERMINAL_FONT_FAMILY,
  WINDOWS_TERMINAL_FONT_FAMILY
} from "../../src/domains/settings/domain/userSettings"
import {
  APP_THEME_STORAGE_KEY,
  loadAppTheme,
  loadUserSettings,
  persistAppTheme,
  persistUserSettings,
  USER_SETTINGS_STORAGE_KEY
} from "../../src/domains/settings/infrastructure/storage/settingsStorage"

// Keys persisted by historical releases; loading preferences must ignore them.
const LEGACY_WINDOWS_DENSITY_MIGRATION_STORAGE_KEY = 'ai-term:windows-density:v1'
const WINDOWS_TERMINAL_SIZE_CORRECTION_STORAGE_KEY = 'ai-term:windows-terminal-size-correction:v1'

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) }
  }
}

test('平台默认值保持字体、字号和 Agent 预算兼容，默认对象互不共享', () => {
  const windows = createDefaultUserSettings(true)
  const system = createDefaultUserSettings(false)
  assert.equal(windows.terminalFontFamily, WINDOWS_TERMINAL_FONT_FAMILY)
  assert.equal(system.terminalFontFamily, SYSTEM_TERMINAL_FONT_FAMILY)
  assert.deepEqual(system, {
    debugMode: false,
    terminalFontFamily: SYSTEM_TERMINAL_FONT_FAMILY,
    terminalFontSize: 13,
    terminalTheme: 'midnight',
    defaultShell: 'system',
    agentAutoExecReadonly: true,
    agentCommandTimeoutSec: 120
  })
  windows.terminalFontSize = 22
  assert.equal(createDefaultUserSettings(true).terminalFontSize, 14)
})

test('设置校验保留合法偏好和显式关闭，不修改传入草稿', () => {
  const draft = {
    debugMode: true,
    terminalFontFamily: '  Fira Code, monospace  ',
    terminalFontSize: 13.5,
    terminalTheme: 'light',
    defaultShell: '  pwsh  ',
    agentAutoExecReadonly: false,
    agentStepLimit: '8',
    agentCommandTimeoutSec: '240',
    unknownSetting: 'not part of the settings model'
  }
  const original = structuredClone(draft)
  assert.deepEqual(normalizeUserSettings(draft, true), {
    debugMode: true,
    terminalFontFamily: 'Fira Code, monospace',
    terminalFontSize: 13.5,
    terminalTheme: 'midnight',
    defaultShell: 'pwsh',
    agentAutoExecReadonly: false,
    agentCommandTimeoutSec: 240
  })
  assert.deepEqual(draft, original)
})

test('调试模式默认关闭，旧版设置和非布尔值不会意外开启诊断输出', () => {
  for (const windowsPlatform of [true, false]) {
    assert.equal(createDefaultUserSettings(windowsPlatform).debugMode, false)
    assert.equal(normalizeUserSettings({}, windowsPlatform).debugMode, false)
    for (const value of [undefined, null, false, 0, 1, '', 'true', 'false', [], {}, new Boolean(true)]) {
      assert.equal(normalizeUserSettings({ debugMode: value }, windowsPlatform).debugMode, false)
    }
    assert.equal(normalizeUserSettings({ debugMode: true }, windowsPlatform).debugMode, true)
  }
})

test('空值、错误根类型和错误字段类型回落默认值', () => {
  const defaults = createDefaultUserSettings(false)
  for (const value of [undefined, null, [], 'invalid', 42]) {
    assert.deepEqual(normalizeUserSettings(value, false), defaults)
  }
  assert.deepEqual(normalizeUserSettings({
    terminalFontFamily: 42,
    terminalFontSize: { toString: null },
    defaultShell: [],
    agentAutoExecReadonly: 'false',
    agentStepLimit: { toString: null },
    agentCommandTimeoutSec: { toString: null }
  }, false), defaults)
  assert.deepEqual(normalizeUserSettings({ terminalFontFamily: ' ', defaultShell: ' ' }, false), defaults)
})

test('字号保留 11–22 的现有边界和小数行为', () => {
  for (const [input, expected] of [[0, 13], ['', 13], ['invalid', 13], [-1, 11], [9, 11], [30, 22], [13.5, 13.5], ['16', 16]]) {
    assert.equal(normalizeUserSettings({ terminalFontSize: input }, false).terminalFontSize, expected)
  }
})

test('Agent 预算统一取整、夹取并处理无效值', () => {
  for (const input of [undefined, null, '', 0, -5, 'invalid', Infinity, NaN]) {
    assert.equal(clampAgentCommandTimeoutSec(input), 120)
  }
  for (const [input, expected] of [[1, 15], [15, 15], [600, 600], [900, 600], [20.6, 21], ['240', 240]]) {
    assert.equal(clampAgentCommandTimeoutSec(input), expected)
  }
})

test('旧版保存的步数上限被忽略,加载和再次保存不会恢复执行限制', () => {
  const storage = createStorage({ [USER_SETTINGS_STORAGE_KEY]: JSON.stringify({ agentStepLimit: 1, agentCommandTimeoutSec: 240 }) })
  const settings = loadUserSettings(false, storage)
  assert.equal(settings.agentStepLimit, undefined)
  assert.equal(settings.agentCommandTimeoutSec, 240)
  persistUserSettings(settings, storage)
  assert.equal(JSON.parse(storage.getItem(USER_SETTINGS_STORAGE_KEY)).agentStepLimit, undefined)
})

test('缺失、损坏和旧版设置可正常加载', () => {
  for (const raw of [null, '', '{broken', 'null', '[]', '42']) {
    const storage = createStorage(raw === null ? {} : { [USER_SETTINGS_STORAGE_KEY]: raw })
    assert.deepEqual(loadUserSettings(false, storage), createDefaultUserSettings(false))
  }
  const storage = createStorage({ [USER_SETTINGS_STORAGE_KEY]: JSON.stringify({ terminalFontSize: 16 }) })
  assert.deepEqual(loadUserSettings(false, storage), { ...createDefaultUserSettings(false), terminalFontSize: 16 })
})

test('托管字体仅在加载时随平台迁移，用户主动选择和自定义字体不被校验覆盖', () => {
  const presets = [SYSTEM_TERMINAL_FONT_FAMILY, WINDOWS_TERMINAL_FONT_FAMILY, LEGACY_WINDOWS_TERMINAL_FONT_FAMILY]
  for (const windowsPlatform of [true, false]) {
    for (const terminalFontFamily of presets) {
      const storage = createStorage({ [USER_SETTINGS_STORAGE_KEY]: JSON.stringify({ terminalFontFamily }) })
      assert.equal(loadUserSettings(windowsPlatform, storage).terminalFontFamily, createDefaultUserSettings(windowsPlatform).terminalFontFamily)
      assert.equal(normalizeUserSettings({ terminalFontFamily }, windowsPlatform).terminalFontFamily, terminalFontFamily)
    }
    const storage = createStorage({ [USER_SETTINGS_STORAGE_KEY]: JSON.stringify({ terminalFontFamily: 'Fira Code, monospace' }) })
    assert.equal(loadUserSettings(windowsPlatform, storage).terminalFontFamily, 'Fira Code, monospace')
  }
})

test('Windows 新安装和缺失字号采用 14px，其他平台采用 13px', () => {
  for (const windowsPlatform of [true, false]) {
    const expected = windowsPlatform ? 14 : 13
    for (const raw of [null, '', '{broken', 'null', '[]', '{}', '{"terminalFontSize":"invalid"}']) {
      const storage = createStorage(raw === null ? {} : { [USER_SETTINGS_STORAGE_KEY]: raw })
      assert.equal(loadUserSettings(windowsPlatform, storage).terminalFontSize, expected)
    }
    assert.equal(normalizeUserSettings({ terminalFontSize: 0 }, windowsPlatform).terminalFontSize, expected)
  }
})

test('所有已保存字号在旧密度标记存在时仍保持原值，读取不会重写设置', () => {
  for (const windowsPlatform of [true, false]) {
    for (const terminalFontSize of [11, 13, 13.5, 14, 15, 16, 22]) {
      for (const correction of [null, '1']) {
        const saved = { ...createDefaultUserSettings(windowsPlatform), terminalFontSize, defaultShell: 'pwsh', agentAutoExecReadonly: false }
        const raw = JSON.stringify(saved)
        const storage = createStorage({
          [USER_SETTINGS_STORAGE_KEY]: raw,
          [LEGACY_WINDOWS_DENSITY_MIGRATION_STORAGE_KEY]: '1',
          ...(correction ? { [WINDOWS_TERMINAL_SIZE_CORRECTION_STORAGE_KEY]: correction } : {})
        })
        let writes = 0
        const readOnlyStorage = { ...storage, setItem() { writes++; throw new Error('read should not write') } }
        assert.deepEqual(loadUserSettings(windowsPlatform, readOnlyStorage), saved)
        assert.equal(writes, 0)
        assert.equal(storage.getItem(USER_SETTINGS_STORAGE_KEY), raw)
        assert.equal(storage.getItem(WINDOWS_TERMINAL_SIZE_CORRECTION_STORAGE_KEY), correction)
      }
    }
  }
})

test('缺失设置时忽略旧迁移标记，主动保存和恢复默认都能保留新选择', () => {
  const storage = createStorage({ [LEGACY_WINDOWS_DENSITY_MIGRATION_STORAGE_KEY]: '1' })
  assert.equal(loadUserSettings(true, storage).terminalFontSize, 14)
  persistUserSettings({ ...createDefaultUserSettings(true), terminalFontSize: 15 }, storage)
  assert.equal(loadUserSettings(true, storage).terminalFontSize, 15)
  persistUserSettings(createDefaultUserSettings(true), storage)
  assert.equal(loadUserSettings(true, storage).terminalFontSize, 14)
  assert.equal(storage.getItem(WINDOWS_TERMINAL_SIZE_CORRECTION_STORAGE_KEY), null)
})

test('本地存储读写异常有明确回退，主题与设置互不覆盖', () => {
  const unavailable = {
    getItem() { throw new Error('storage blocked') },
    setItem() { throw new Error('storage blocked') }
  }
  assert.deepEqual(loadUserSettings(false, unavailable), createDefaultUserSettings(false))
  assert.equal(loadAppTheme(unavailable), 'dark')
  assert.equal(persistUserSettings(createDefaultUserSettings(false), unavailable), false)
  assert.equal(persistAppTheme('light', unavailable), false)
  const storage = createStorage()
  assert.equal(persistUserSettings(createDefaultUserSettings(false), storage), true)
  assert.equal(persistAppTheme('light', storage), true)
  assert.equal(loadAppTheme(storage), 'light')
  assert.deepEqual(loadUserSettings(false, storage), createDefaultUserSettings(false))
  storage.setItem(APP_THEME_STORAGE_KEY, 'unknown')
  assert.equal(loadAppTheme(storage), 'dark')
})

test('localStorage 属性本身不可访问时也能加载和保存而不抛错', (context) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('access denied') } })
  context.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else delete globalThis.localStorage
  })
  assert.deepEqual(loadUserSettings(false), createDefaultUserSettings(false))
  assert.equal(loadAppTheme(), 'dark')
  assert.equal(persistUserSettings(createDefaultUserSettings(false)), false)
  assert.equal(persistAppTheme('light'), false)
})
