import { computed, ref, watch } from 'vue'
import type { AiPanelProps } from '../domain/aiPanel'
import { normalizeTerminalContextMode, resolveTerminalContext } from '../domain/terminalContext'
import type { TerminalContextMode } from '../domain/terminalContext'

const STORAGE_KEY = 'ai-term:terminal-context-mode'

export function useAiTerminalContext(props: Readonly<AiPanelProps>) {
  let saved: unknown
  try { saved = localStorage.getItem(STORAGE_KEY) } catch { /* Storage may be unavailable. */ }
  const terminalContextMode = ref<TerminalContextMode>(normalizeTerminalContextMode(saved))
  watch(terminalContextMode, mode => {
    try { localStorage.setItem(STORAGE_KEY, mode) } catch { /* Keep the in-memory choice. */ }
  })
  const terminalContext = computed(() => resolveTerminalContext(
    terminalContextMode.value, props.terminalSnapshot, props.commandHistory, props.terminalSelection
  ))
  return { terminalContextMode, terminalContext }
}
