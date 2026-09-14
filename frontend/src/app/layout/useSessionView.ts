import { computed, readonly, ref, watch } from 'vue'
import type { Ref } from 'vue'

export type SessionView = 'terminal' | 'files'

interface SessionViewTab {
  id: string
  profile?: { fileTransferMode?: string }
}

/** Main views belong to the terminal session, independently of its auxiliary tools. */
export function useSessionView(options: {
  activeTerminalId: Readonly<Ref<string>>
  terminalTabs: Readonly<Ref<readonly SessionViewTab[]>>
}) {
  const views = ref<Record<string, SessionView>>({})
  const filesVisited = ref(false)
  const activeView = computed<SessionView>(() => {
    const id = options.activeTerminalId.value
    if (views.value[id]) return views.value[id]
    const mode = options.terminalTabs.value.find(tab => tab.id === id)?.profile?.fileTransferMode
    return mode === 'sftp-direct' || mode === 'sftp-gateway' ? 'files' : 'terminal'
  })

  function selectView(view: SessionView) {
    if (activeView.value === view) return false
    views.value[options.activeTerminalId.value] = view
    return true
  }

  watch(activeView, view => {
    if (view === 'files') filesVisited.value = true
  }, { immediate: true, flush: 'sync' })

  watch(() => options.terminalTabs.value.map(tab => tab.id), ids => {
    const openIds = new Set(ids)
    for (const id of Object.keys(views.value)) {
      if (!openIds.has(id)) delete views.value[id]
    }
  }, { flush: 'sync' })

  return { activeView, filesVisited: readonly(filesVisited), selectView }
}
