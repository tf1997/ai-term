import type { AppTheme, AppUserSettings } from '../model/settings'
import { createDefaultUserSettings, DEFAULT_TERMINAL_FONT_SIZE, LEGACY_WINDOWS_TERMINAL_FONT_FAMILY, normalizeUserSettings, SYSTEM_TERMINAL_FONT_FAMILY, WINDOWS_TERMINAL_FONT_FAMILY } from '../model/userSettings'
import { DEFAULT_WORKSPACE_WIDTH, parseWorkspaceWidth } from '../model/workspaceLayout'

export interface SettingsStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export const USER_SETTINGS_STORAGE_KEY = 'ai-term:user-settings:v1'
export const LEGACY_WINDOWS_DENSITY_MIGRATION_STORAGE_KEY = 'ai-term:windows-density:v1'
export const WINDOWS_TERMINAL_SIZE_CORRECTION_STORAGE_KEY = 'ai-term:windows-terminal-size-correction:v1'
export const APP_THEME_STORAGE_KEY = 'ai-term:app-theme:v1'
export const WORKSPACE_WIDTH_STORAGE_KEY = 'ai-term:workspace-width:v1'

function readStoredValue(key: string, storage?: SettingsStorage): string | null {
  try {
    return (storage ?? localStorage).getItem(key)
  } catch {
    return null
  }
}

function writeStoredValue(key: string, value: string, storage?: SettingsStorage): boolean {
  try {
    const target = storage ?? localStorage
    target.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export function loadUserSettings(windowsPlatform: boolean, storage?: SettingsStorage): AppUserSettings {
  const defaults = createDefaultUserSettings(windowsPlatform)
  const raw = readStoredValue(USER_SETTINGS_STORAGE_KEY, storage)
  if (!raw) {
    if (windowsPlatform && readStoredValue(LEGACY_WINDOWS_DENSITY_MIGRATION_STORAGE_KEY, storage)) {
      writeStoredValue(WINDOWS_TERMINAL_SIZE_CORRECTION_STORAGE_KEY, '1', storage)
    }
    return defaults
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return defaults
  }
  const settings = normalizeUserSettings(parsed, windowsPlatform)
  if ([SYSTEM_TERMINAL_FONT_FAMILY, WINDOWS_TERMINAL_FONT_FAMILY, LEGACY_WINDOWS_TERMINAL_FONT_FAMILY].includes(settings.terminalFontFamily)) {
    settings.terminalFontFamily = defaults.terminalFontFamily
  }

  if (
    windowsPlatform
    && readStoredValue(LEGACY_WINDOWS_DENSITY_MIGRATION_STORAGE_KEY, storage)
    && !readStoredValue(WINDOWS_TERMINAL_SIZE_CORRECTION_STORAGE_KEY, storage)
  ) {
    let correctionPersisted = true
    if (settings.terminalFontSize === 15) {
      settings.terminalFontSize = DEFAULT_TERMINAL_FONT_SIZE
      correctionPersisted = persistUserSettings(settings, storage)
    }
    if (correctionPersisted) {
      writeStoredValue(WINDOWS_TERMINAL_SIZE_CORRECTION_STORAGE_KEY, '1', storage)
    }
  }
  return settings
}

export function persistUserSettings(settings: AppUserSettings, storage?: SettingsStorage): boolean {
  return writeStoredValue(USER_SETTINGS_STORAGE_KEY, JSON.stringify(settings), storage)
}

export function loadAppTheme(storage?: SettingsStorage): AppTheme {
  return readStoredValue(APP_THEME_STORAGE_KEY, storage) === 'light' ? 'light' : 'dark'
}

export function persistAppTheme(theme: AppTheme, storage?: SettingsStorage): boolean {
  return writeStoredValue(APP_THEME_STORAGE_KEY, theme, storage)
}

export function loadWorkspaceWidth(storage?: SettingsStorage): number {
  try {
    return parseWorkspaceWidth((storage ?? localStorage).getItem(WORKSPACE_WIDTH_STORAGE_KEY))
  } catch {
    return DEFAULT_WORKSPACE_WIDTH
  }
}

export function persistWorkspaceWidth(width: number, storage?: SettingsStorage): boolean {
  return writeStoredValue(WORKSPACE_WIDTH_STORAGE_KEY, String(width), storage)
}
