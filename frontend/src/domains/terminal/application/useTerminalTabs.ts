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
  const pausedTerminalTargetCount = computed(() => targetTerminalTabs.value.filter((tab) =>
    tab.id !== activeTerminalId.value && pausedTerminalSyncIdSet.value.has(tab.id)
  ).length)
  const activeTerminalTitle = computed(() => activeTerminal.value?.title ?? '当前终端')
  const terminalTargetLabel = computed(() => {
    const count = targetTerminalIds.value.length
    const paused = pausedTerminalTargetCount.value > 0 ? ` · 暂停 ${pausedTerminalTargetCount.value}` : ''
    return count > 1 ? `同步 ${count} 个${paused} · 当前 ${activeTerminalTitle.value}` : `当前 ${activeTerminalTitle.value}`
  })
  const terminalTargetTitle = computed(() => {
    const targets = targetTerminalTabs.value.map((tab) => tab.title).join('、')
    const paused = pausedTerminalTargetCount.value > 0
      ? `；${pausedTerminalTargetCount.value} 个终端键盘同步已暂停，回到空提示符后自动恢复`
      : ''
    return multiTerminalInputEnabled.value
      ? `当前 tab：${activeTerminalTitle.value}；同步目标：${targets}${paused}`
      : `当前 tab：${activeTerminalTitle.value}；仅发送到当前终端`
  })

  function setTerminalTargets(ids: readonly string[]) {
    const requiredId = activeTerminalId.value
    const next = normalizedTerminalTargetIds(terminalTabs.value, ids, requiredId)
    selectedTerminalIds.value = next
    pausedTerminalSyncIds.value = pausedTerminalSyncIds.value.filter((id) => next.includes(id) && id !== requiredId)
  }

  function selectTerminalTab(tabId: string) {
    if (!terminalTabs.value.some((tab) => tab.id === tabId)) return
    activeTerminalId.value = tabId
    const current = selectedTerminalIds.value
    setTerminalTargets(current.includes(tabId) ? current : [tabId])
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
    setTerminalTargets([id])
    return readonly(tab)
  }

  function removeTerminalTabs(ids: readonly string[], preferredActiveId?: string): string[] {
    const previousTabs = terminalTabs.value
    if (previousTabs.length <= 1) return []
    const requestedIds = new Set(ids)
    let remainingTabs = previousTabs.filter((tab) => !requestedIds.has(tab.id))
    if (remainingTabs.length === 0) {
      const survivor = previousTabs.find((tab) => tab.id === preferredActiveId)
        ?? previousTabs.find((tab) => tab.id === activeTerminalId.value)
        ?? previousTabs[0]
      remainingTabs = [survivor]
    }
    const remainingIds = new Set(remainingTabs.map((tab) => tab.id))
    const removedIds = previousTabs.filter((tab) => !remainingIds.has(tab.id)).map((tab) => tab.id)
    if (removedIds.length === 0) return []

    let nextActiveId = activeTerminalId.value
    if (!remainingIds.has(nextActiveId)) {
      const activeIndex = previousTabs.findIndex((tab) => tab.id === activeTerminalId.value)
      const nearestTargets = previousTabs
        .map((tab, index) => ({ tab, index }))
        .filter(({ tab }) => remainingIds.has(tab.id) && selectedTerminalIdSet.value.has(tab.id))
        .sort((left, right) => Math.abs(left.index - activeIndex) - Math.abs(right.index - activeIndex) || left.index - right.index)
      const previousSurvivor = previousTabs.slice(0, activeIndex).reverse().find((tab) => remainingIds.has(tab.id))
      nextActiveId = preferredActiveId && remainingIds.has(preferredActiveId)
        ? preferredActiveId
        : (nearestTargets[0]?.tab ?? previousSurvivor ?? remainingTabs[0]).id
    }

    const survivingTargets = selectedTerminalIds.value.filter((id) => remainingIds.has(id))
    terminalTabs.value = remainingTabs
    activeTerminalId.value = nextActiveId
    setTerminalTargets(survivingTargets.includes(nextActiveId) ? survivingTargets : [nextActiveId])
    return removedIds
  }

  function removeTerminalTab(tabId: string) {
    return removeTerminalTabs([tabId]).length > 0
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
    if (tabId === activeTerminalId.value) return '当前终端始终接收输入'
    return isTerminalTargetSelected(tabId) ? '从同步目标移除' : '加入同步目标'
  }

  function toggleTerminalTarget(tabId: string) {
    if (!terminalTabs.value.some((tab) => tab.id === tabId)) return
    if (tabId === activeTerminalId.value) return
    const current = selectedTerminalIds.value
    setTerminalTargets(current.includes(tabId) ? current.filter((id) => id !== tabId) : [...current, tabId])
  }

  function selectAllTerminalTargets() {
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
    pausedTerminalSyncIds: readonly(pausedTerminalSyncIds),
    activeTerminal, targetTerminalIds, targetConnectionIds, multiTerminalInputEnabled,
    pausedTerminalTargetCount, terminalTargetLabel, terminalTargetTitle,
    selectTerminalTab, addTerminalTab, removeTerminalTab, removeTerminalTabs,
    updateTerminalStatus, isTerminalTargetSelected, isTerminalSyncPaused, terminalTargetToggleTitle,
    setTerminalTargets, toggleTerminalTarget, selectAllTerminalTargets, resetTerminalTargetsToActive,
    pauseTerminalTargets, resumeTerminalSyncTarget
  }
}
