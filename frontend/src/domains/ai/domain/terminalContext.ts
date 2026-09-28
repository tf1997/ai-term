import type { TerminalSelectionEvent } from '../../terminal/types'

export type TerminalContextMode = 'auto' | 'selection' | 'none'

export function normalizeTerminalContextMode(value: unknown): TerminalContextMode {
  return value === 'selection' || value === 'none' ? value : 'auto'
}

export function resolveTerminalContext<T>(
  mode: TerminalContextMode,
  terminalSnapshot: string,
  commandHistory: T[],
  selection?: TerminalSelectionEvent
) {
  return {
    terminalSnapshot: mode === 'auto' ? terminalSnapshot : '',
    commandHistory: mode === 'auto' ? commandHistory : [],
    selection: mode !== 'none' && selection?.text.trim() ? selection : undefined
  }
}
