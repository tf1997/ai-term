import type { AppUserSettings } from '../types/settings'

export const SYSTEM_TERMINAL_FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
export const WINDOWS_TERMINAL_FONT_FAMILY = '"Cascadia Mono", "Cascadia Code", "JetBrains Mono", Consolas, monospace'
export const LEGACY_WINDOWS_TERMINAL_FONT_FAMILY = '"JetBrains Mono", ui-monospace, monospace'
export const DEFAULT_TERMINAL_FONT_SIZE = 13
export const MIN_TERMINAL_FONT_SIZE = 11
export const MAX_TERMINAL_FONT_SIZE = 22
export const DEFAULT_AGENT_STEP_LIMIT = 25
export const MIN_AGENT_STEP_LIMIT = 1
export const MAX_AGENT_STEP_LIMIT = 25
export const DEFAULT_AGENT_COMMAND_TIMEOUT_SEC = 120
export const MIN_AGENT_COMMAND_TIMEOUT_SEC = 15
export const MAX_AGENT_COMMAND_TIMEOUT_SEC = 600

export function createDefaultUserSettings(windowsPlatform: boolean): AppUserSettings {
  return {
    terminalFontFamily: windowsPlatform ? WINDOWS_TERMINAL_FONT_FAMILY : SYSTEM_TERMINAL_FONT_FAMILY,
    terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
    terminalTheme: 'midnight',
    defaultShell: 'system',
    agentAutoExecReadonly: true,
    agentStepLimit: DEFAULT_AGENT_STEP_LIMIT,
    agentCommandTimeoutSec: DEFAULT_AGENT_COMMAND_TIMEOUT_SEC
  }
}

function parseNumericSetting(value: unknown): number {
  return typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN
}

function clampBudget(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const parsed = Math.round(parseNumericSetting(value))
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.max(minimum, Math.min(maximum, parsed))
}

export function clampAgentStepLimit(value: unknown): number {
  return clampBudget(value, MIN_AGENT_STEP_LIMIT, MAX_AGENT_STEP_LIMIT, DEFAULT_AGENT_STEP_LIMIT)
}

export function clampAgentCommandTimeoutSec(value: unknown): number {
  return clampBudget(value, MIN_AGENT_COMMAND_TIMEOUT_SEC, MAX_AGENT_COMMAND_TIMEOUT_SEC, DEFAULT_AGENT_COMMAND_TIMEOUT_SEC)
}

export function normalizeUserSettings(value: unknown, windowsPlatform: boolean): AppUserSettings {
  const defaults = createDefaultUserSettings(windowsPlatform)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults
  const settings = value as Record<string, unknown>
  const terminalFontFamily = typeof settings.terminalFontFamily === 'string' ? settings.terminalFontFamily.trim() : ''
  const terminalFontSize = parseNumericSetting(settings.terminalFontSize) || DEFAULT_TERMINAL_FONT_SIZE
  const defaultShell = typeof settings.defaultShell === 'string' ? settings.defaultShell.trim() : ''

  return {
    terminalFontFamily: terminalFontFamily || defaults.terminalFontFamily,
    terminalFontSize: Math.max(MIN_TERMINAL_FONT_SIZE, Math.min(MAX_TERMINAL_FONT_SIZE, terminalFontSize)),
    terminalTheme: 'midnight',
    defaultShell: defaultShell || defaults.defaultShell,
    agentAutoExecReadonly: typeof settings.agentAutoExecReadonly === 'boolean'
      ? settings.agentAutoExecReadonly
      : defaults.agentAutoExecReadonly,
    agentStepLimit: clampAgentStepLimit(settings.agentStepLimit),
    agentCommandTimeoutSec: clampAgentCommandTimeoutSec(settings.agentCommandTimeoutSec)
  }
}
