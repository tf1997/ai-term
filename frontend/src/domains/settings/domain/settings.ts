export type TerminalTheme = 'midnight' | 'matrix' | 'light'
export type AppTheme = 'dark' | 'light'

export interface AppUserSettings {
  debugMode: boolean
  terminalFontFamily: string
  terminalFontSize: number
  terminalTheme: TerminalTheme
  defaultShell: string
  agentAutoExecReadonly: boolean
  agentStepLimit: number
  agentCommandTimeoutSec: number
}
