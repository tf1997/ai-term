import { onBeforeUnmount } from 'vue'
import * as tauri from '../infrastructure/api'

interface TerminalEventsOptions {
  sessionId: () => string
  ingestTerminalOutput: (data: string) => void
  captureOutput: (data: string) => void
  handleTerminalSessionClosed: (reason: string) => void
}

type TerminalEventSource = Pick<typeof tauri, 'onTerminalData' | 'onTerminalClosed'>

export function useTerminalEvents(options: TerminalEventsOptions, source: TerminalEventSource = tauri) {
  let generation = 0
  let disposed = false
  let unlisten: (() => void) | undefined
  let unlistenClosed: (() => void) | undefined

  function detachTerminalEvents() {
    generation += 1
    unlisten?.()
    unlistenClosed?.()
    unlisten = undefined
    unlistenClosed = undefined
  }

  async function attachTerminalEvents(activeSessionId = options.sessionId()) {
    detachTerminalEvents()
    if (disposed || !activeSessionId) return false
    const requestGeneration = generation
    const isCurrent = () => !disposed && requestGeneration === generation && options.sessionId() === activeSessionId
    const nextUnlisten = await source.onTerminalData(activeSessionId, event => {
      if (!isCurrent() || event.sessionId !== activeSessionId) return
      options.ingestTerminalOutput(event.data)
      options.captureOutput(event.data)
    })
    if (!isCurrent()) { nextUnlisten(); return false }
    let nextUnlistenClosed: () => void
    try {
      nextUnlistenClosed = await source.onTerminalClosed(activeSessionId, event => {
        if (isCurrent() && event.sessionId === activeSessionId) options.handleTerminalSessionClosed(event.reason)
      })
    } catch (error) {
      nextUnlisten()
      throw error
    }
    if (!isCurrent()) { nextUnlisten(); nextUnlistenClosed(); return false }
    unlisten = nextUnlisten
    unlistenClosed = nextUnlistenClosed
    return true
  }

  onBeforeUnmount(() => {
    disposed = true
    detachTerminalEvents()
  })

  return { attachTerminalEvents, detachTerminalEvents }
}
