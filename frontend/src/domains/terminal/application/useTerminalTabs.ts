import { computed, readonly, ref } from 'vue'
import type { ConnectionProfile } from '../../connections/types'
import type { TerminalRuntimeStatus, TerminalTab } from '../domain/terminal'
import { normalizedTerminalTargetIds } from '../domain/terminalTabs'

export function useTerminalTabs() {
  const terminalTabs = ref<TerminalTab[]>([{
    id: 'local-1', title: '本地终端', connectionId: 'local', profile: undefined,
    connectRequest: 0, status: 'idle', connectionGeneration: 0
  }])
  const activeTerminalId = ref('local-1')
  const selectedTerminalIds = ref<string[]>(['local-1'])
  const pausedTerminalSyncIds = ref<string[]>([])
  let terminalSequence = 1

  const tabs = readonly(terminalTabs)
  const activeTerminal = computed(() => tabs.value.find((tab) => tab.id === activeTerminalId.value) ?? tabs.value[0])
  const selectedTerminalIdSet = computed(() => new Set(selectedTerminalIds.value))
  const pausedTerminalSyncIdSet = computed(() => new Set(pausedTerminalSyncIds.value))
  const targetTerminalTabs = computed(() => {
    const selected = tabs.value.filter((tab) => selectedTerminalIdSet.value.has(tab.id))
    if (selected.length > 0) return selected
    return activeTerminal.value ? [activeTerminal.value] : []
  })
  const targetTerminalIds = computed(() => targetTerminalTabs.value.map((tab) => tab.id))
  const targetConnectionIds = computed(() => [...new Set(targetTerminalTabs.value.map((tab) => tab.connectionId))])
  const multiTerminalInputEnabled = computed(() => targetTerminalIds.value.length > 1)
  const activeTerminalTitle = computed(() => activeTerminal.value?.title ?? '当前终端')
  const terminalTargetLabel = computed(() => {
    const count = targetTerminalIds.value.length
    return count > 1 ? `同步 ${count} 个 · 当前 ${activeTerminalTitle.value}` : `当前 ${activeTerminalTitle.value}`
  })
  const terminalTargetTitle = computed(() => {
    const targets = targetTerminalTabs.value.map((tab) => tab.title).join('、')
    return multiTerminalInputEnabled.value
      ? `当前 tab：${activeTerminalTitle.value}；同步目标：${targets}`
      : `当前 tab：${activeTerminalTitle.value}；仅发送到当前终端`
  })

  function setTerminalTargets(ids: readonly string[], requiredId = activeTerminalId.value) {
    const next = normalizedTerminalTargetIds(terminalTabs.value, ids, requiredId)
    selectedTerminalIds.value = next
    pausedTerminalSyncIds.value = pausedTerminalSyncIds.value.filter((id) => next.includes(id) && id !== requiredId)
  }

  function selectTerminalTab(tabId: string) {
    if (!terminalTabs.value.some((tab) => tab.id === tabId)) return
    activeTerminalId.value = tabId
    const current = selectedTerminalIds.value
    setTerminalTargets(current.length <= 1 ? [tabId] : current, tabId)
  }

  function addTerminalTab(profile?: ConnectionProfile) {
    const id = `terminal-${Date.now()}-${++terminalSequence}`
    const tab: TerminalTab = {
      id,
      title: profile ? `${profile.target.username || 'user'}@${profile.target.host || profile.name}` : '本地终端',
      connectionId: profile?.id ?? 'local',
      profile: profile ? JSON.parse(JSON.stringify(profile)) as ConnectionProfile : undefined,
      connectRequest: 1,
      status: 'idle',
      connectionGeneration: 0
    }
    terminalTabs.value.push(tab)
    activeTerminalId.value = id
    setTerminalTargets([id], id)
    return readonly(tab)
  }

  function removeTerminalTab(tabId: string) {
    if (terminalTabs.value.length === 1) return false
    const index = terminalTabs.value.findIndex((tab) => tab.id === tabId)
    if (index < 0) return false
    terminalTabs.value = terminalTabs.value.filter((tab) => tab.id !== tabId)
    if (activeTerminalId.value === tabId) {
      activeTerminalId.value = (terminalTabs.value[Math.max(0, index - 1)] ?? terminalTabs.value[0]).id
    }
    setTerminalTargets(selectedTerminalIds.value)
    return true
  }

  function updateTerminalStatus(terminalId: string, status: TerminalRuntimeStatus) {
    terminalTabs.value = terminalTabs.value.map((tab) => {
      if (tab.id !== terminalId) return tab
      const wasConnected = tab.status === 'local' || tab.status === 'remote' || tab.status === 'sftp'
      const isConnected = status === 'local' || status === 'remote' || status === 'sftp'
      return {
        ...tab, status,
        connectionGeneration: !wasConnected && isConnected ? tab.connectionGeneration + 1 : tab.connectionGeneration
      }
    })
  }

  function isTerminalTargetSelected(tabId: string) {
    return selectedTerminalIdSet.value.has(tabId)
  }

  function isTerminalSyncPaused(tabId: string) {
    return pausedTerminalSyncIdSet.value.has(tabId)
  }

  function terminalTargetToggleTitle(tabId: string) {
    if (isTerminalSyncPaused(tabId)) return '键盘同步已暂停；各终端回到空提示符后会自动恢复'
    if (tabId === activeTerminalId.value) return multiTerminalInputEnabled.value ? '仅同步当前终端' : '当前终端'
    return isTerminalTargetSelected(tabId) ? '从同步目标移除' : '加入同步目标'
  }

  function toggleTerminalTarget(tabId: string) {
    if (!terminalTabs.value.some((tab) => tab.id === tabId)) return
    if (tabId === activeTerminalId.value) {
      setTerminalTargets([tabId], tabId)
      return
    }
    const current = selectedTerminalIds.value
    setTerminalTargets(current.includes(tabId) ? current.filter((id) => id !== tabId) : [...current, tabId])
  }

  function selectAllTerminalTargets() {
    pausedTerminalSyncIds.value = []
    setTerminalTargets(terminalTabs.value.map((tab) => tab.id))
  }

  function resetTerminalTargetsToActive() {
    pausedTerminalSyncIds.value = []
    setTerminalTargets([activeTerminalId.value])
  }

  function pauseTerminalTargets(ids: readonly string[]) {
    const current = new Set(pausedTerminalSyncIds.value)
    const added = [...new Set(ids)].filter((id) => id !== activeTerminalId.value && isTerminalTargetSelected(id) && !current.has(id))
    if (added.length) pausedTerminalSyncIds.value = [...current, ...added]
    return added
  }

  function resumeTerminalSyncTarget(terminalId: string) {
    if (!isTerminalSyncPaused(terminalId)) return
    pausedTerminalSyncIds.value = pausedTerminalSyncIds.value.filter((id) => id !== terminalId)
  }

  return {
    terminalTabs: tabs,
    activeTerminalId: readonly(activeTerminalId),
    activeTerminal, targetTerminalIds, targetConnectionIds, multiTerminalInputEnabled,
    terminalTargetLabel, terminalTargetTitle, selectTerminalTab, addTerminalTab, removeTerminalTab,
    updateTerminalStatus, isTerminalTargetSelected, isTerminalSyncPaused, terminalTargetToggleTitle,
    toggleTerminalTarget, selectAllTerminalTargets, resetTerminalTargetsToActive,
    pauseTerminalTargets, resumeTerminalSyncTarget
  }
}
