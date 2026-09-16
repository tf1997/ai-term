<script setup lang="ts">
import AboutDialog from './AboutDialog.vue'
import { useChromeSelection } from '../layout/useChromeSelection'
import { useTerminalInputRouter } from '../../domains/terminal/index'
import { useScriptRecording } from '../../domains/scripts/index'
import type { TerminalPaneHandle as TerminalPaneInstance } from '../../domains/terminal/types'
import { useConnectionProfiles } from '../../domains/connections/index'
import { useAiConfigs } from '../../domains/ai/index'
import { normalizeConnectionProfileForSave } from '../../domains/connections/index'
import { formatError } from '../../shared/platform/errors'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'

import type { ConnectionProfile } from '../../domains/connections/types'
import type { AppUserSettings } from '../../domains/settings/types'
import { useUserSettings } from '../../domains/settings/index'
import { useAppTheme } from '../../domains/settings/index'
import { useWorkspaceResize } from '../layout/useWorkspaceResize'
import { useSessionView } from '../layout/useSessionView'
import type { SessionView } from '../layout/useSessionView'
import { useToasts } from '../../shared/ui/useToasts'
import { useContextMenu } from '../../shared/ui/useContextMenu'
import { terminalContextMenu } from '../../domains/terminal/index'
import { useCommandHistory } from '../../domains/terminal/index'
import { useWorkspaceSessions } from '../../domains/ai/index'
import { useAiMessages } from '../../domains/ai/index'
import { DEFAULT_AI_SESSION_ID } from '../../domains/ai/index'
import { loadWorkspaceLayoutPreferences, persistWorkspaceLayoutPreferences } from '../../domains/settings/index'
import type { TerminalTab } from '../../domains/terminal/types'
import { useTerminalTabs } from '../../domains/terminal/index'
import type { CommandRecordedEvent, TerminalOutputDeltaEvent, TerminalOutputEvent, TerminalSelectionEvent } from '../../domains/terminal/types'

import { deleteAgentCommandAllowlistEntry, listAgentCommandAllowlist, saveAgentCommandAllowlistEntry } from '../../domains/ai/infrastructure/api'
import { listConnectionProfiles, saveConnectionProfile } from '../../domains/connections/infrastructure/api'
import type { AgentAllowlistEntry, AgentCommandHandle, AgentCommandRunOptions } from '../../domains/ai/types'

import { createStableRefRegistry } from '../../domains/terminal/index'
import { ConnectionSidebar } from '../../domains/connections/views'
import ContextMenu from '../../shared/ui/ContextMenu.vue'
import { SettingsSidebar } from '../../domains/settings/views'
import { TerminalPane, TerminalTabsBar } from '../../domains/terminal/views'
import { FileTransferPanel, TransferTaskCenter } from '../../domains/transfer/views'
import type { TerminalFileBridge, TransferJob } from '../../domains/transfer/index'
import { localOpenPath, localParentPath } from '../../domains/transfer/index'
import WorkspacePanel from './WorkspacePanel.vue'
import UiIcon from '../../shared/ui/UiIcon.vue'

type LeftPanelMode = 'connections' | 'settings'
const LOCAL_CONNECTION_ID = 'local'
const connectingProfileId = ref('')
const aboutOpen = ref(false)
const layoutPreferences = loadWorkspaceLayoutPreferences()
const leftPanelMode = ref<LeftPanelMode>(layoutPreferences.leftPanelMode)
const leftCollapsed = ref(layoutPreferences.leftCollapsed)
const rightCollapsed = ref(layoutPreferences.rightCollapsed)
const workspacePanelTab = ref<'history' | 'ai' | 'scripts'>(layoutPreferences.workspacePanelTab)
watch([leftCollapsed, rightCollapsed, workspacePanelTab, leftPanelMode], () => {
  persistWorkspaceLayoutPreferences({ leftCollapsed: leftCollapsed.value, rightCollapsed: rightCollapsed.value, workspacePanelTab: workspacePanelTab.value, leftPanelMode: leftPanelMode.value })
})
const terminalTabState = useTerminalTabs()
const {
  terminalTabs, activeTerminalId, activeTerminal, targetTerminalIds, targetConnectionIds,
  multiTerminalInputEnabled, terminalTargetLabel, terminalTargetTitle, selectTerminalTab,
  addTerminalTab, removeTerminalTab, removeTerminalTabs, updateTerminalStatus, isTerminalTargetSelected,
  pausedTerminalSyncIds, toggleTerminalTarget, setTerminalTargets, selectAllTerminalTargets,
  resetTerminalTargetsToActive
} = terminalTabState
const { activeView, selectView } = useSessionView({ activeTerminalId, terminalTabs })
const visitedFileTerminals = ref<string[]>([])
const filePanelTabs = computed(() => terminalTabs.value.filter(tab => visitedFileTerminals.value.includes(tab.id)))
type FilePanelHandle = {
  focusView: () => void
  acceptTerminalOutput: (event: TerminalOutputDeltaEvent) => void
  openLocation: (job: TransferJob) => Promise<void>
  confirmClose: () => boolean
}
const filePanelRegistry = createStableRefRegistry<FilePanelHandle>()
const terminalFileBridges = new Map<string, TerminalFileBridge>()
const terminalContextVersions = ref<Record<string, number>>({})
const filePanelRoutes = ref<Record<string, string>>({})
watch([activeTerminalId, activeView], ([id, view]) => {
  if (view === 'files' && !visitedFileTerminals.value.includes(id)) visitedFileTerminals.value.push(id)
}, { immediate: true })
const remoteFileSessions = computed(() => terminalTabs.value.filter(tab => tab.profile).map(tab => ({ id: tab.id, title: tab.title })))
// SFTP tabs open a workspace without establishing a live SSH session.
const connectedProfileIds = computed(() => [...new Set(
  terminalTabs.value.filter((tab) => tab.profile && tab.status === 'remote').map((tab) => tab.connectionId)
)])
const pendingConnectionProfileIds = computed(() => [...new Set(
  terminalTabs.value.filter((tab) => tab.profile && tab.status === 'connecting').map((tab) => tab.connectionId)
)])
// shallowRef: component instances are only accessed imperatively; deep
// reactivity would proxy every TerminalPane instance for no benefit.
const terminalRefRegistry = createStableRefRegistry<TerminalPaneInstance>()
const terminalRefs = shallowRef(terminalRefRegistry.values)
const terminalSnapshots = ref<Record<string, string>>({})
const terminalOutputEvents = ref<Record<string, TerminalOutputDeltaEvent>>({})
const terminalSelections = ref<Record<string, TerminalSelectionEvent>>({})
const activeAiSessionId = ref('')
const workspaceSessionState = useWorkspaceSessions({
  onRenameError: (error) => { connectionError.value = formatError(error) }
})
const {
  workspaceSessions, isDraftWorkspaceSession, workspaceSessionById, createDraftWorkspaceSession,
  renameWorkspaceSession, updateWorkspaceSessionTitle, updateWorkspaceSessionContextSummary,
  setWorkspaceSessionMode, loadWorkspaceSessionList
} = workspaceSessionState
const {
  aiMessagesBySession, aiContextBySession, appendAiMessageToActiveTerminal, updateAiMessage,
  setAiContextForTerminal, loadAiSessionState, deleteAiSession
} = useAiMessages(workspaceSessionState)
const { commandHistoryForConnection, loadCommandHistoryForConnection, recordCommandForConnection } = useCommandHistory()
const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu()
const { toasts, showToast, dismissToast } = useToasts()
const { executeCommandOnTargetTerminals, fillHistoryCommandOnActiveTerminal, pinQuickCommandOnActiveTerminal, writeInputToTargetTerminals, syncTerminalInputToTargets, handleTerminalInputWriteFailure } = useTerminalInputRouter({ tabs: terminalTabState, terminalRefs, showToast })
const { profiles, selectedProfileId, profileStoreStatus, connectionError, connectionSaveState, connectionSaveError, connectionEditorOpen, connectionEditorMode, connectionDraft, selectedProfile, sidebarProfile, connectionLabels, selectProfile, createProfile, editSelectedProfile, copySelectedProfile, closeConnectionEditor, loadProfiles, saveSelectedProfile, deleteSelectedProfile } = useConnectionProfiles({ openConnectionsPanel, showToast })
const { aiConfigs, selectedAiConfigId, aiConfigSaveState, aiConfigSaveError, aiConfigEditorOpen, aiConfigEditorMode, aiConfigDraft, aiConfig, settingsAiConfig, activeAiRuntimeApiKey, createAiConfig, selectAiConfig, editAiConfig, closeAiConfigEditor, saveAiConfig, deleteSelectedAiConfig, loadAiConfig } = useAiConfigs({ profileStoreStatus, openSettingsPanel, showToast })
const { appSettings, updateUserSettings: saveUserSettings } = useUserSettings()
const { appTheme, themeToggleButton, toggleAppTheme } = useAppTheme({
  onThemeChange(theme) {
    showToast('info', '主题已切换', theme === 'light' ? '已切换为白色主题。' : '已切换为深色主题。')
  }
})
let terminalOutputSequence = 0

const activeTerminalSnapshot = computed(() => {
  return terminalSnapshots.value[activeTerminalId.value] ?? ''
})

const activeTerminalOutputEvent = computed(() => {
  return terminalOutputEvents.value[activeTerminalId.value]
})

const activeTerminalSelection = computed(() => {
  return terminalSelections.value[activeTerminalId.value]
})

const activeConnectionId = computed(() => activeTerminal.value?.connectionId ?? LOCAL_CONNECTION_ID)
const { activeScriptRecording, startScriptRecording, stopScriptRecording, clearScriptRecording, appendRecordingOutput, appendRecordingCommand, removeScriptRecording } = useScriptRecording({ activeTerminalId, activeConnectionId, activeAiSessionId })
const activeWorkspaceSessionId = computed(() => activeAiSessionId.value)

const activeCommandHistory = computed(() => {
  return commandHistoryForConnection(activeConnectionId.value)
})

function commandHistoryForTab(tab: TerminalTab) {
  return commandHistoryForConnection(tab.connectionId)
}
const activeAiMessages = computed(() => {
  return aiMessagesBySession.value[activeAiSessionId.value] ?? []
})

const activeAiContextStatus = computed(() => {
  return aiContextBySession.value[activeAiSessionId.value]
})

const activeWorkspaceSessions = computed(() => {
  return workspaceSessions.value
})

const aboutRuntimeStats = computed(() => [
  { label: '终端', value: String(terminalTabs.value.length) },
  { label: '连接', value: String(profiles.value.length) },
  { label: '会话', value: String(activeWorkspaceSessions.value.length) },
  { label: '主题', value: appTheme.value === 'light' ? 'Light' : 'Dark' }
])

const sftpWorkbenchActive = computed(() => activeView.value === 'files')
const {
  workspaceWidth,
  workspaceMinWidth,
  workspaceMaxWidth,
  sidebarOverlay,
  workspaceResizing,
  workspaceLayoutStyle,
  beginWorkspaceResize,
  handleWorkspaceResizeKeydown
} = useWorkspaceResize({ leftCollapsed, rightCollapsed, sftpWorkbenchActive })

const leftDrawerVisible = ref(false)
const leftSidebarPanel = ref<HTMLElement>()
const connectionsPanelButton = ref<HTMLButtonElement>()
const settingsPanelButton = ref<HTMLButtonElement>()
const leftDrawerOpen = computed(() => sidebarOverlay.value && leftDrawerVisible.value)
const leftPanelVisible = computed(() => sidebarOverlay.value ? leftDrawerVisible.value : !leftCollapsed.value)

watch(sidebarOverlay, (overlay) => {
  // Preserve interaction when resizing while keeping the docked preference separate.
  leftDrawerVisible.value = overlay && Boolean(leftSidebarPanel.value?.contains(document.activeElement))
})
watch([leftDrawerOpen, leftPanelMode], async ([open]) => {
  if (open) {
    await nextTick()
    if (leftDrawerOpen.value) leftSidebarPanel.value?.querySelector<HTMLButtonElement>('.sidebar-drawer-close')?.focus()
  }
})

function leftPanelTrigger() {
  return leftPanelMode.value === 'connections' ? connectionsPanelButton.value : settingsPanelButton.value
}

function closeLeftPanel() {
  if (sidebarOverlay.value) leftDrawerVisible.value = false
  else leftCollapsed.value = true
  void nextTick(() => leftPanelTrigger()?.focus())
}

function handleLeftDrawerKeydown(event: KeyboardEvent) {
  if (!leftDrawerOpen.value || event.defaultPrevented || contextMenu.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    if (connectionEditorOpen.value) {
      closeConnectionEditor()
      void nextTick(() => leftSidebarPanel.value?.querySelector<HTMLButtonElement>('.sidebar-drawer-close')?.focus())
    }
    else if (aiConfigEditorOpen.value) {
      closeAiConfigEditor()
      void nextTick(() => leftSidebarPanel.value?.querySelector<HTMLButtonElement>('.sidebar-drawer-close')?.focus())
    }
    else closeLeftPanel()
    return
  }
  if (event.key !== 'Tab') return
  const panel = leftSidebarPanel.value
  const scope = panel?.querySelector<HTMLElement>('.modal') ?? panel
  const focusable = [...(scope?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])].filter(element => element.getClientRects().length > 0)
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}

async function connectProfileFromSidebar(profileId: string) {
  const draft = profiles.value.find((profile) => profile.id === profileId)
  if (!draft) return
  selectedProfileId.value = profileId
  try {
    connectingProfileId.value = profileId
    connectionError.value = ''
    const profile = normalizeConnectionProfileForSave(draft)
    await saveConnectionProfile(profile)
    profileStoreStatus.value = 'ready'
    await ensureActiveAiSession(profile.id)
    createTerminalTab(profile)
    await nextTick()
    if (leftDrawerOpen.value) {
      leftDrawerVisible.value = false
      focusActiveTerminalFromWorkspace()
    }
    profiles.value = await listConnectionProfiles()
    selectedProfileId.value = profile.id
  } catch (error) {
    profileStoreStatus.value = 'error'
    connectionError.value = formatError(error)
  } finally {
    connectingProfileId.value = ''
  }
}

async function createLocalTerminalTab() {
  await ensureActiveAiSession(LOCAL_CONNECTION_ID)
  createTerminalTab()
}

function openLocalTerminal() {
  selectedProfileId.value = ''
  void createLocalTerminalTab()
}


function openConnectionsPanel() {
  leftPanelMode.value = 'connections'
  if (sidebarOverlay.value) leftDrawerVisible.value = true
  else leftCollapsed.value = false
}

function openSettingsPanel() {
  leftPanelMode.value = 'settings'
  if (sidebarOverlay.value) leftDrawerVisible.value = true
  else leftCollapsed.value = false
}

function toggleConnectionsPanel() {
  if (isLeftPanelActive('connections')) {
    closeLeftPanel()
    return
  }
  openConnectionsPanel()
}

function toggleSettingsPanel() {
  if (isLeftPanelActive('settings')) {
    closeLeftPanel()
    return
  }
  openSettingsPanel()
}

function openAboutPage() {
  aboutOpen.value = true
  closeContextMenu()
}

function closeAboutPage() {
  aboutOpen.value = false
}

function isLeftPanelActive(mode: LeftPanelMode) {
  return leftPanelMode.value === mode && leftPanelVisible.value
}

function leftPanelButtonTitle(mode: LeftPanelMode) {
  if (isLeftPanelActive(mode)) return mode === 'connections' ? '收起连接管理' : '收起设置中心'
  return mode === 'connections' ? '打开连接管理' : '打开设置中心'
}

function openConnectionContextMenu(event: MouseEvent, profileId: string) {
  const profile = profiles.value.find((item) => item.id === profileId)
  if (!profile) return
  selectProfile(profileId)
  openContextMenu(event, profile.name, [
    {
      id: 'connect',
      label: '连接服务器',
      action: () => void connectProfileFromSidebar(profileId)
    },
    {
      id: 'edit',
      label: '编辑连接',
      action: () => editSelectedProfile(profileId)
    },
    {
      id: 'copy',
      label: '\u590d\u5236\u8fde\u63a5',
      action: () => copySelectedProfile(profileId)
    },
    {
      id: 'new',
      label: '新建连接',
      action: createProfile
    },
    {
      id: 'delete',
      label: '删除连接',
      danger: true,
      action: () => void deleteSelectedProfile(profileId)
    }
  ])
}

function openAiConfigContextMenu(event: MouseEvent, configId: string) {
  selectAiConfig(configId)
  openContextMenu(event, configId, [
    {
      id: 'select',
      label: '使用此配置',
      action: () => selectAiConfig(configId)
    },
    {
      id: 'edit',
      label: '编辑 AI 配置',
      action: () => editAiConfig(configId)
    },
    {
      id: 'new',
      label: '新建 AI 配置',
      action: createAiConfig
    },
    {
      id: 'delete',
      label: '删除 AI 配置',
      danger: true,
      action: () => void deleteSelectedAiConfig(configId)
    }
  ])
}

function openTerminalTabContextMenu(event: MouseEvent, tab: TerminalTab) {
  const menu = terminalContextMenu({
    tabs: terminalTabs.value, tabId: tab.id, activeId: activeTerminalId.value, targetIds: targetTerminalIds.value,
    select: id => { selectTerminalTab(id); focusActiveTerminalFromWorkspace() },
    toggleTarget: toggleTerminalTarget,
    create: () => { openLocalTerminal(); focusActiveTerminalFromWorkspace() },
    close: closeTerminalTab, closeOthers: closeOtherTerminalTabs, closeRight: closeTerminalTabsToRight,
  })
  if (menu) openContextMenu(event, menu.title, menu.items, menu.description)
}
function openTerminalAreaContextMenu(event: MouseEvent) {
  openContextMenu(event, activeTerminal.value?.title ?? '终端', [
    {
      id: 'copy-output',
      label: '复制当前终端内容',
      disabled: !activeTerminalSnapshot.value,
      action: () => void copyActiveTerminalSnapshot()
    },
    {
      id: 'clear',
      label: '清屏',
      action: () => terminalRefs.value[activeTerminalId.value]?.clearTerminal()
    },
    {
      id: 'disconnect',
      label: '断开当前会话',
      action: () => terminalRefs.value[activeTerminalId.value]?.disconnectFromButton()
    },
    {
      id: 'select-all-targets',
      label: '同步全部终端',
      disabled: terminalTabs.value.length <= 1 || targetTerminalIds.value.length === terminalTabs.value.length,
      action: selectAllTerminalTargets
    },
    {
      id: 'reset-targets',
      label: '停止同步',
      disabled: !multiTerminalInputEnabled.value,
      action: resetTerminalTargetsToActive
    },
    {
      id: 'new-local',
      label: '新建本地终端',
      action: openLocalTerminal
    },
    {
      id: 'close-tab',
      label: '关闭当前标签',
      danger: true,
      disabled: terminalTabs.value.length === 1,
      action: () => closeTerminalTab(activeTerminalId.value)
    },
    {
      id: 'close-others',
      label: '关闭其他终端',
      danger: true,
      disabled: terminalTabs.value.length <= 1,
      action: () => closeOtherTerminalTabs(activeTerminalId.value)
    }
  ])
}
async function copyActiveTerminalSnapshot() {
  if (!activeTerminalSnapshot.value) {
    showToast('warning', '没有可复制内容', '当前终端还没有输出。')
    return
  }
  try {
    await navigator.clipboard?.writeText(activeTerminalSnapshot.value)
    showToast('success', '已复制终端输出')
  } catch (error) {
    showToast('error', '复制失败', formatError(error))
  }
}

function updateUserSettings(settings: AppUserSettings) {
  if (saveUserSettings(settings)) {
    showToast('success', '设置已保存', '终端字体和字号已同步到当前终端。')
  } else {
    showToast('warning', '设置已应用，但未保存', '本地存储不可用，重新打开应用后可能恢复原设置。')
  }
}


async function ensureActiveAiSession(sourceConnectionId = activeConnectionId.value, name = 'Untitled') {
  await loadWorkspaceSessionList()
  const current = workspaceSessionById(activeAiSessionId.value)
  if (current) {
    await loadAiSessionState(current.id)
    return current
  }
  const session = workspaceSessions.value.find((item) => !isDraftWorkspaceSession(item.id))
    ?? createDraftWorkspaceSession(sourceConnectionId, DEFAULT_AI_SESSION_ID, name)
  activeAiSessionId.value = session.id
  await loadAiSessionState(session.id)
  return session
}

async function createWorkspaceSession(connectionId = activeConnectionId.value, name?: string) {
  await loadWorkspaceSessionList()
  return createDraftWorkspaceSession(connectionId, undefined, name)
}


async function createWorkspaceSessionForActiveConnection() {
  try {
    const session = await createWorkspaceSession(activeConnectionId.value)
    selectWorkspaceSession(session.id)
  } catch (error) {
    connectionError.value = formatError(error)
  }
}


const agentAllowlist = ref<AgentAllowlistEntry[]>([])

async function loadAgentAllowlist() {
  try {
    agentAllowlist.value = await listAgentCommandAllowlist()
  } catch (error) {
    console.error('failed to load agent command allowlist', error)
  }
}

async function persistAgentPattern(pattern: string, sourceCommand: string) {
  await saveAgentCommandAllowlistEntry(pattern, sourceCommand)
  await loadAgentAllowlist()
  showToast('success', '已加入允许列表', `后续无风险命令匹配此前缀时自动执行：${pattern}`)
}

async function allowAgentPattern(pattern: string, sourceCommand: string) {
  try {
    await persistAgentPattern(pattern, sourceCommand)
  } catch (error) {
    showToast('error', '允许列表保存失败', formatError(error))
  }
}

async function removeAgentAllowlistPattern(pattern: string) {
  try {
    await deleteAgentCommandAllowlistEntry(pattern)
    await loadAgentAllowlist()
  } catch (error) {
    showToast('error', '允许列表删除失败', formatError(error))
  }
}

async function clearAgentAllowlist() {
  try {
    await Promise.all(agentAllowlist.value.map((entry) => deleteAgentCommandAllowlistEntry(entry.pattern)))
    await loadAgentAllowlist()
    showToast('success', '允许列表已清空', 'Agent 命令将恢复人工审批')
  } catch (error) {
    showToast('error', '允许列表清空失败', formatError(error))
  }
}

/** Agent 执行入口:任务开始时绑定的 terminalId 在整个任务期间不变(文档 6.6)。 */
function agentCommandDispatchFailure(reason: string): AgentCommandHandle {
  return {
    result: Promise.resolve({
      status: 'dispatch-failed',
      output: '',
      durationMs: 0,
      truncated: false,
      failureReason: reason
    }),
    peekOutput: () => '',
    cancel: () => {}
  }
}

function agentCommandRunner(terminalId: string, command: string, options?: AgentCommandRunOptions): AgentCommandHandle {
  const tab = terminalTabs.value.find((item) => item.id === terminalId)
  if (!tab) return agentCommandDispatchFailure('任务绑定的终端标签已关闭')
  if (
    options?.connectionGeneration !== undefined &&
    tab.connectionGeneration !== options.connectionGeneration
  ) {
    return agentCommandDispatchFailure('任务绑定的终端已经重新连接；为避免向新会话误发命令，请重新发起任务')
  }
  const pane = terminalRefs.value[terminalId]
  if (!pane) return agentCommandDispatchFailure('任务绑定的终端组件暂不可用')
  const dispatchGuard = () => {
    const currentTab = terminalTabs.value.find((item) => item.id === terminalId)
    if (!currentTab) return '任务绑定的终端标签已关闭'
    if (
      options?.connectionGeneration !== undefined &&
      currentTab.connectionGeneration !== options.connectionGeneration
    ) {
      return '任务绑定的终端已经重新连接；为避免向新会话误发命令，请重新发起任务'
    }
    if (terminalRefs.value[terminalId] !== pane) return '任务绑定的终端组件已经替换'
    return ''
  }
  return pane.runCommandAndCapture(command, {
    maxOutputChars: options?.maxOutputChars,
    dispatchGuard
  })
}

/** Agent 模式可用性快检(同步):返回空串表示可用,否则为不可用原因。 */
function agentAvailabilityCheck(): string {
  const pane = terminalRefs.value[activeTerminalId.value]
  if (!pane) return '当前终端不可用'
  if (!pane.agentCapturePreparing()) {
    const readiness = pane.commandExecutionReadiness()
    if (readiness === 'line-busy') return '当前终端命令行已有输入或补全内容,请先提交或清空'
    if (readiness === 'shell-busy') return 'Shell 尚未返回可执行提示符,请等待当前命令结束'
    if (readiness === 'unavailable') return '当前终端不可用或连接已断开'
  }
  if (!pane.agentCaptureSupported()) {
    return '当前终端的 shell 不支持命令捕获(既无 shell integration 语义标记,也不支持 POSIX printf 哨兵),Agent 暂不可用'
  }
  return ''
}

/**
 * 可用性确认(异步):无语义标记的终端会跑一次哨兵探针。
 * 返回空串表示可用,否则为不可用原因。
 */
async function agentAvailabilityConfirm(): Promise<string> {
  const pane = terminalRefs.value[activeTerminalId.value]
  if (!pane) return '当前终端不可用'
  const mode = await pane.ensureAgentCapture()
  if (mode === 'unsupported') {
    return '当前终端的 shell 不支持哨兵捕获(需 POSIX printf 与 $?),Agent 暂不可用;远端为 fish/PowerShell/cmd 时会出现这种情况'
  }
  return ''
}


async function deleteWorkspaceSessionForActiveConnection(sessionId: string) {
  const sessions = workspaceSessions.value
  if (sessions.length <= 1) {
    window.alert('至少保留一个会话')
    return
  }
  const session = sessions.find((item) => item.id === sessionId)
  if (!session) return
  if (!window.confirm(`删除 AI 会话 ${session.name}？该会话中的 AI 消息会被删除，命令历史不受影响。`)) return
  try {
    if (!await deleteAiSession(sessionId)) return
    const remaining = workspaceSessions.value
    if (activeWorkspaceSessionId.value === sessionId) {
      selectWorkspaceSession(remaining[0].id)
    }
  } catch (error) {
    connectionError.value = formatError(error)
  }
}

function selectWorkspaceSession(sessionId: string) {
  if (!workspaceSessionById(sessionId)) return
  activeAiSessionId.value = sessionId
  void loadAiSessionState(sessionId)
}

function createTerminalTab(profile?: ConnectionProfile) {
  const tab = addTerminalTab(profile)
  void loadCommandHistoryForConnection(tab.connectionId)
}

function closeTerminalTab(tabId: string) {
  if (filePanelRegistry.values[tabId]?.confirmClose() === false) return
  if (!removeTerminalTab(tabId)) return
  cleanUpClosedTerminal(tabId)
}

function cleanUpClosedTerminal(tabId: string) {
  visitedFileTerminals.value = visitedFileTerminals.value.filter(id => id !== tabId)
  filePanelRegistry.remove(tabId)
  terminalFileBridges.delete(tabId)
  delete terminalContextVersions.value[tabId]
  delete filePanelRoutes.value[tabId]
  delete terminalSnapshots.value[tabId]
  delete terminalOutputEvents.value[tabId]
  delete terminalSelections.value[tabId]
  terminalRefRegistry.remove(tabId)
  removeScriptRecording(tabId)
}

function closeOtherTerminalTabs(tabId: string) {
  if (!terminalTabs.value.some(tab => tab.id === tabId)) return
  const ids = terminalTabs.value.filter(tab => tab.id !== tabId).map(tab => tab.id)
  if (ids.some(id => filePanelRegistry.values[id]?.confirmClose() === false)) return
  const closedIds = removeTerminalTabs(ids, tabId)
  closedIds.forEach(cleanUpClosedTerminal)
}

function closeTerminalTabsToRight(tabId: string) {
  const index = terminalTabs.value.findIndex(tab => tab.id === tabId)
  if (index < 0) return
  const ids = terminalTabs.value.slice(index + 1).map(tab => tab.id)
  if (ids.some(id => filePanelRegistry.values[id]?.confirmClose() === false)) return
  const closedIds = removeTerminalTabs(ids, tabId)
  closedIds.forEach(cleanUpClosedTerminal)
}

function focusActiveTerminal() {
  const terminalId = activeTerminalId.value
  void nextTick(() => {
    if (activeView.value === 'terminal' && activeTerminalId.value === terminalId) {
      terminalRefs.value[terminalId]?.focusTerminal()
    }
  })
}

function selectSessionView(view: SessionView) {
  selectView(view)
  if (view === 'terminal') focusActiveTerminal()
  else void nextTick(() => filePanelRegistry.values[activeTerminalId.value]?.focusView())
}

function terminalFileBridge(terminalId: string): TerminalFileBridge {
  let bridge = terminalFileBridges.get(terminalId)
  if (!bridge) {
    bridge = {
      readiness: () => terminalRefs.value[terminalId]?.commandExecutionReadiness() ?? 'unavailable',
      write: data => terminalRefs.value[terminalId]?.writeFileInput(data) ?? false,
      finish: command => terminalRefs.value[terminalId]?.finishFileInput(command),
      interrupt: () => terminalRefs.value[terminalId]?.interruptFileInput() ?? false
    }
    terminalFileBridges.set(terminalId, bridge)
  }
  return bridge
}

function selectFileSession(terminalId: string) {
  selectTerminalTab(terminalId)
  selectSessionView('files')
}

async function connectFileProfile(profileId: string) {
  await connectProfileFromSidebar(profileId)
  if (activeTerminal.value?.connectionId === profileId) selectSessionView('files')
}

async function openTransferLocation(job: TransferJob) {
  if (job.direction === 'download') {
    try { await localOpenPath(localParentPath(job.targetPath)) }
    catch (error) { showToast('error', '无法打开下载位置', formatError(error)) }
    return
  }
  let tab = terminalTabs.value.find(item => item.id === job.binding.terminalId)
  if (!tab) {
    const profile = profiles.value.find(item => item.id === job.binding.connectionId)
    if (!profile) { showToast('error', '无法打开原目标', '原连接配置已删除。'); return }
    tab = addTerminalTab({ ...profile, fileTransferMode: profile.connectionRole === 'bastion' ? 'sftp-gateway' : 'sftp-direct' })
    if (job.binding.override.profileRoute) filePanelRoutes.value[tab.id] = job.binding.override.profileRoute
  }
  selectFileSession(tab.id)
  await nextTick()
  await filePanelRegistry.values[tab.id]?.openLocation(job)
}

function handleSessionViewKeydown(event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const tabs = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  const currentIndex = tabs.indexOf(event.target as HTMLButtonElement)
  if (currentIndex < 0) return
  event.preventDefault()
  const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
    : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  selectView(nextIndex === 0 ? 'terminal' : 'files')
  tabs[nextIndex]?.focus({ preventScroll: true })
}

function updateTerminalOutput(event: TerminalOutputEvent) {
  if (!terminalTabs.value.some(tab => tab.id === event.terminalId)) return
  const previousSnapshot = terminalSnapshots.value[event.terminalId] ?? ''
  const delta = terminalOutputDelta(previousSnapshot, event.snapshot)
  terminalSnapshots.value[event.terminalId] = event.snapshot
  terminalOutputEvents.value = {
    ...terminalOutputEvents.value,
    [event.terminalId]: {
      terminalId: event.terminalId,
      snapshot: event.snapshot,
      delta,
      sequence: ++terminalOutputSequence
    }
  }
  appendRecordingOutput(event.terminalId, delta)
}

function handleTerminalProtocolOutput(event: TerminalOutputDeltaEvent) {
  filePanelRegistry.values[event.terminalId]?.acceptTerminalOutput(event)
}

function updateTerminalSelection(event: TerminalSelectionEvent) {
  if (!terminalTabs.value.some(tab => tab.id === event.terminalId)) return
  terminalSelections.value = {
    ...terminalSelections.value,
    [event.terminalId]: event
  }
}

function clearTerminalSelection() {
  delete terminalSelections.value[activeTerminalId.value]
}

function recordCommand(event: CommandRecordedEvent) {
  const tab = terminalTabs.value.find((item) => item.id === event.terminalId)
  if (!tab) return
  if (/(?:^|[;&|\s])(?:ssh|mosh|su|login|exit|logout)(?:\s|$)|(?:^|[;&|\s])sudo\s+(?:-[^\s]*[is]\b|su\b)/.test(event.command)) {
    terminalContextVersions.value[event.terminalId] = (terminalContextVersions.value[event.terminalId] ?? 0) + 1
  }
  const connectionId = tab.connectionId
  const entry = recordCommandForConnection(connectionId, event)
  if (entry) appendRecordingCommand(event.terminalId, event.command)
}

function terminalOutputDelta(previousSnapshot: string, nextSnapshot: string) {
  if (!previousSnapshot) return nextSnapshot
  if (nextSnapshot.startsWith(previousSnapshot)) return nextSnapshot.slice(previousSnapshot.length)
  if (nextSnapshot.length > previousSnapshot.length) return nextSnapshot.slice(previousSnapshot.length)
  return nextSnapshot.slice(-80_000)
}

function focusActiveTerminalFromWorkspace() {
  selectSessionView('terminal')
}

async function refreshConnectionProfilesAfterTerminalAuth(profileId: string) {
  try {
    profiles.value = await listConnectionProfiles()
    if (profiles.value.some((profile) => profile.id === profileId)) {
      selectedProfileId.value = profileId
    }
    showToast('success', 'SSH \u8ba4\u8bc1\u5df2\u4fdd\u5b58', '\u4e0b\u6b21\u8fde\u63a5\u5c06\u81ea\u52a8\u8ba4\u8bc1')
  } catch (error) {
    showToast('error', '\u8fde\u63a5\u5237\u65b0\u5931\u8d25', formatError(error))
  }
}

function handleGlobalKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    if (aboutOpen.value) closeAboutPage()
    else if (!event.defaultPrevented && !contextMenu.value && leftDrawerOpen.value) {
      event.preventDefault()
      closeLeftPanel()
    }
  }
}

useChromeSelection()

onMounted(() => {
  void loadProfiles()
  void loadAiConfig()
  void ensureActiveAiSession(LOCAL_CONNECTION_ID)
  void loadCommandHistoryForConnection(LOCAL_CONNECTION_ID)
  void loadAgentAllowlist()
  window.addEventListener('keydown', handleGlobalKeydown)
})

watch(activeConnectionId, (connectionId) => {
  void loadCommandHistoryForConnection(connectionId)
})

watch(
  () => [activeAiSessionId.value, isDraftWorkspaceSession(activeAiSessionId.value)],
  () => { void loadAiSessionState(activeAiSessionId.value) }
)


onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleGlobalKeydown)
})
</script>

<template>
  <div class="app-shell" :class="{ 'left-collapsed': leftCollapsed || sidebarOverlay, 'left-sidebar-overlay': sidebarOverlay, 'left-drawer-open': leftDrawerOpen, 'right-collapsed': rightCollapsed, 'sftp-workbench-active': sftpWorkbenchActive, 'workspace-is-resizing': workspaceResizing, 'theme-light': appTheme === 'light', 'theme-dark': appTheme === 'dark' }" :style="workspaceLayoutStyle">
    <header class="titlebar">
      <div class="brand">
        <img class="brand-mark" src="/icon.svg" alt="" aria-hidden="true" />
        <span>AI Term</span>
      </div>
      <TerminalTabsBar
        :terminal-tabs="terminalTabs"
        :active-terminal-id="activeTerminalId"
        :target-terminal-ids="targetTerminalIds"
        :paused-terminal-ids="pausedTerminalSyncIds"
        :terminal-target-title="terminalTargetTitle"
        @select="selectTerminalTab"
        @close="closeTerminalTab"
        @close-others="closeOtherTerminalTabs"
        @create="openLocalTerminal"
        @toggle-target="toggleTerminalTarget"
        @set-targets="setTerminalTargets"
        @select-all-targets="selectAllTerminalTargets"
        @reset-targets="resetTerminalTargetsToActive"
        @context-menu="openTerminalTabContextMenu"
        @open-popover="closeContextMenu"
        @focus-terminal="focusActiveTerminal"
      />
    </header>
    <aside class="app-rail" aria-label="主导航">
      <button
        ref="connectionsPanelButton"
        class="rail-button"
        :class="{ active: isLeftPanelActive('connections') }"
        :title="leftPanelButtonTitle('connections')"
        :aria-label="leftPanelButtonTitle('connections')"
        :aria-expanded="isLeftPanelActive('connections')"
        aria-controls="left-sidebar-panel"
        @click="toggleConnectionsPanel"
      >
        <UiIcon name="terminal" />
      </button>
      <button
        class="rail-button"
        :class="{ active: isLeftPanelActive('settings') }"
        :title="leftPanelButtonTitle('settings')"
        :aria-label="leftPanelButtonTitle('settings')"
        ref="settingsPanelButton"
        :aria-expanded="isLeftPanelActive('settings')"
        aria-controls="left-sidebar-panel"
        @click="toggleSettingsPanel"
      >
        <UiIcon name="settings" />
      </button>
      <button
        ref="themeToggleButton"
        class="rail-button theme-toggle-button"
        type="button"
        :title="appTheme === 'light' ? '切换深色主题' : '切换白色主题'"
        :aria-label="appTheme === 'light' ? '切换深色主题' : '切换白色主题'"
        @click="toggleAppTheme"
      >
        <UiIcon :name="appTheme === 'light' ? 'moon' : 'sun'" />
      </button>
      <button
        class="rail-button"
        :class="{ active: aboutOpen }"
        type="button"
        title="&#20851;&#20110; AI Term"
        aria-label="&#20851;&#20110; AI Term"
        @click="openAboutPage"
      >
        <UiIcon name="info" />
      </button>
    </aside>
    <div v-if="leftDrawerOpen" class="sidebar-drawer-backdrop" aria-hidden="true" @click="closeLeftPanel" />
    <section
      id="left-sidebar-panel"
      ref="leftSidebarPanel"
      v-show="leftPanelVisible"
      class="left-sidebar-panel"
      :role="leftDrawerOpen ? 'dialog' : undefined"
      :aria-label="leftPanelMode === 'connections' ? '连接管理' : '设置中心'"
      @keydown="handleLeftDrawerKeydown"
    >
      <div class="sidebar-layout-controls">
        <button class="icon-button sidebar-drawer-close" type="button" :title="leftDrawerOpen ? '关闭侧栏' : '收起侧栏'" :aria-label="leftDrawerOpen ? '关闭侧栏' : '收起侧栏'" @click="closeLeftPanel">
          <UiIcon name="arrow-left" size="14" />
        </button>
      </div>
      <ConnectionSidebar
        v-if="leftPanelMode === 'connections'"
        :profiles="profiles"
        :selected-profile-id="selectedProfileId"
        :selected-profile="sidebarProfile"
        :connecting-profile-id="connectingProfileId"
        :connected-profile-ids="connectedProfileIds"
        :pending-connection-profile-ids="pendingConnectionProfileIds"
        :connection-error="connectionError"
        :editor-open="connectionEditorOpen"
        :editor-mode="connectionEditorMode"
        :save-state="connectionSaveState"
        :save-error="connectionSaveError"
        @select="selectProfile"
        @edit="editSelectedProfile"
        @copy="copySelectedProfile"
        @delete="deleteSelectedProfile"
        @open-menu="openConnectionContextMenu"
        @close-editor="closeConnectionEditor"
        @connect="connectProfileFromSidebar"
        @create="createProfile"
        @save="saveSelectedProfile"
      />
      <SettingsSidebar
        v-else
        :ai-configs="aiConfigs"
        :selected-ai-config-id="selectedAiConfigId"
        :ai-config="settingsAiConfig"
        :editor-open="aiConfigEditorOpen"
        :editor-mode="aiConfigEditorMode"
        :save-state="aiConfigSaveState"
        :save-error="aiConfigSaveError"
        :settings="appSettings"
        :agent-allowlist="agentAllowlist"
        @select-ai-config="selectAiConfig"
        @create-ai-config="createAiConfig"
        @edit-ai-config="editAiConfig"
        @delete-ai-config="deleteSelectedAiConfig"
        @open-menu="openAiConfigContextMenu"
        @close-ai-config="closeAiConfigEditor"
        @delete-agent-pattern="removeAgentAllowlistPattern"
        @add-agent-pattern="(pattern: string) => allowAgentPattern(pattern, '')"
        @clear-agent-patterns="clearAgentAllowlist"
        @save-ai-config="saveAiConfig"
        @update-settings="updateUserSettings"
      />
    </section>
    <div class="session-view-bar">
      <nav class="session-view-tabs" role="tablist" aria-label="当前会话视图" @keydown="handleSessionViewKeydown">
        <button
          id="session-view-terminal"
          type="button"
          role="tab"
          :aria-selected="activeView === 'terminal'"
          aria-controls="session-terminal-view"
          :tabindex="activeView === 'terminal' ? 0 : -1"
          :class="{ active: activeView === 'terminal' }"
          @click="selectSessionView('terminal')"
        >
          <UiIcon name="terminal" size="15" />
          <span>终端</span>
        </button>
        <button
          id="session-view-files"
          type="button"
          role="tab"
          :aria-selected="activeView === 'files'"
          aria-controls="session-files-view"
          :tabindex="activeView === 'files' ? 0 : -1"
          :class="{ active: activeView === 'files' }"
          @click="selectSessionView('files')"
        >
          <UiIcon name="folder" size="15" />
          <span>文件</span>
        </button>
      </nav>
      <TransferTaskCenter @open-location="openTransferLocation" />
      <button
        v-if="activeView === 'terminal'"
        class="session-tools-toggle"
        :class="{ active: !rightCollapsed }"
        type="button"
        :aria-expanded="!rightCollapsed"
        aria-controls="session-workspace-tools"
        :title="rightCollapsed ? '打开 AI、历史与脚本' : '收起辅助工具'"
        @click="rightCollapsed = !rightCollapsed"
      >
        <UiIcon name="ai" size="14" />
        <span>辅助工具</span>
        <UiIcon :name="rightCollapsed ? 'arrow-left' : 'arrow-right'" size="12" />
      </button>
    </div>
    <section id="session-terminal-view" v-show="activeView === 'terminal'" class="terminal-stack" role="tabpanel" aria-labelledby="session-view-terminal" @contextmenu.prevent="openTerminalAreaContextMenu">
      <TerminalPane
        v-for="tab in terminalTabs"
        v-show="tab.id === activeTerminalId"
        :key="tab.id"
        :ref="terminalRefRegistry.refFor(tab.id)"
        :id="`terminal-panel-${tab.id}`"
        role="tabpanel"
        :aria-labelledby="`terminal-tab-${tab.id}`"
        :terminal-id="tab.id"
        :active="tab.id === activeTerminalId && activeView === 'terminal'"
        :profile="tab.profile"
        :connect-request="tab.connectRequest"
        :command-history="commandHistoryForTab(tab)"
        :terminal-settings="appSettings"
        :app-theme="appTheme"
        @terminal-output="updateTerminalOutput"
        @terminal-protocol-output="handleTerminalProtocolOutput"
        @terminal-selection="updateTerminalSelection"
        @terminal-input="syncTerminalInputToTargets"
        @terminal-input-write-failed="handleTerminalInputWriteFailure"
        @command-recorded="recordCommand"
        @status-changed="updateTerminalStatus"
        @profile-updated="refreshConnectionProfilesAfterTerminalAuth"
      />
    </section>
    <section id="session-files-view" v-show="activeView === 'files'" class="session-files-view" role="tabpanel" aria-labelledby="session-view-files">
      <FileTransferPanel
        v-for="tab in filePanelTabs"
        v-show="tab.id === activeTerminalId"
        :key="tab.id"
        :ref="filePanelRegistry.refFor(tab.id)"
        :terminal-id="tab.id"
        :connection-id="tab.connectionId"
        :profile="tab.profile"
        :terminal-status="tab.status"
        :terminal-connection-generation="tab.connectionGeneration"
        :terminal-context-version="terminalContextVersions[tab.id] ?? 0"
        :terminal-bridge="terminalFileBridge(tab.id)"
        :profile-route="filePanelRoutes[tab.id]"
        :active="tab.id === activeTerminalId && activeView === 'files'"
        :profiles="profiles"
        :sessions="remoteFileSessions"
        @select-session="selectFileSession"
        @connect-profile="connectFileProfile"
        @create-connection="createProfile"
        @focus-terminal="focusActiveTerminalFromWorkspace"
      />
    </section>
    <div
      v-if="!rightCollapsed && !sftpWorkbenchActive"
      class="workspace-resizer"
      role="separator"
      tabindex="0"
      aria-label="调整辅助工具宽度"
      title="拖动调整宽度；方向键调整，Home 最窄，End 最宽"
      aria-orientation="vertical"
      :aria-valuenow="workspaceWidth"
      :aria-valuemin="workspaceMinWidth"
      :aria-valuemax="workspaceMaxWidth"
      @pointerdown="beginWorkspaceResize"
      @keydown="handleWorkspaceResizeKeydown"
    />
    <WorkspacePanel
      :active-tab="workspacePanelTab"
      id="session-workspace-tools"
      :collapsed="rightCollapsed || activeView === 'files'"
      :terminal-id="activeTerminalId"
      :connection-id="activeConnectionId"
      :connection-profile="activeTerminal?.profile"
      :terminal-status="activeTerminal?.status ?? 'idle'"
      :terminal-connection-generation="activeTerminal?.connectionGeneration ?? 0"
      :workspace-session-id="activeWorkspaceSessionId"
      :workspace-sessions="activeWorkspaceSessions"
      :connection-labels="connectionLabels"
      :execution-target-label="terminalTargetLabel"
      :execution-target-title="terminalTargetTitle"
      :execution-target-connection-ids="targetConnectionIds"
      :ai-configs="aiConfigs"
      :selected-ai-config-id="selectedAiConfigId"
      :ai-config="aiConfig"
      :api-key="activeAiRuntimeApiKey"
      :terminal-snapshot="activeTerminalSnapshot"
      :terminal-output-event="activeTerminalOutputEvent"
      :terminal-selection="activeTerminalSelection"
      :command-history="activeCommandHistory"
      :ai-messages="activeAiMessages"
      :ai-context-status="activeAiContextStatus"
      :script-recording="activeScriptRecording"
      :agent-availability-check="agentAvailabilityCheck"
      :agent-availability-confirm="agentAvailabilityConfirm"
      :agent-command-runner="agentCommandRunner"
      :agent-allowlist-patterns="agentAllowlist.map((entry) => entry.pattern)"
      :agent-allow-pattern="persistAgentPattern"
      :agent-builtin-readonly-enabled="appSettings.agentAutoExecReadonly"
      :agent-step-limit="appSettings.agentStepLimit"
      :agent-command-timeout-ms="appSettings.agentCommandTimeoutSec * 1000"
      @select-ai-config="selectAiConfig"
      @configure-ai="editAiConfig()"
      @clear-terminal-selection="clearTerminalSelection"
      @select-workspace-session="selectWorkspaceSession"
      @create-workspace-session="createWorkspaceSessionForActiveConnection"
      @rename-workspace-session="renameWorkspaceSession"
      @delete-workspace-session="deleteWorkspaceSessionForActiveConnection"
      @update-workspace-session-title="updateWorkspaceSessionTitle"
      @update-workspace-session-context-summary="updateWorkspaceSessionContextSummary"
      @set-workspace-session-mode="setWorkspaceSessionMode"
      @append-ai-message="appendAiMessageToActiveTerminal"
      @update-ai-message="updateAiMessage"
      @set-ai-context-status="setAiContextForTerminal"
      @fill-command="fillHistoryCommandOnActiveTerminal"
      @pin-quick-command="pinQuickCommandOnActiveTerminal"
      @execute-command="executeCommandOnTargetTerminals"
      @ai-error="showToast('error', 'AI 请求失败', $event)"
      @write-terminal-input="writeInputToTargetTerminals"
      @focus-terminal="focusActiveTerminalFromWorkspace"
      @start-script-recording="startScriptRecording"
      @stop-script-recording="stopScriptRecording"
      @clear-script-recording="clearScriptRecording"
      @workspace-tab-changed="workspacePanelTab = $event"
    />
    <AboutDialog v-if="aboutOpen" :app-theme="appTheme" :right-collapsed="rightCollapsed" :workspace-panel-tab="workspacePanelTab" :about-runtime-stats="aboutRuntimeStats" :terminal-count="terminalTabs.length" :profile-count="profiles.length" :session-count="activeWorkspaceSessions.length" @close="closeAboutPage" @toast="showToast" />
    <div v-if="toasts.length" class="toast-stack" aria-live="polite" aria-atomic="false">
      <article v-for="toast in toasts" :key="toast.id" class="app-toast" :class="toast.kind">
        <span>
          <strong>{{ toast.title }}</strong>
          <small v-if="toast.message">{{ toast.message }}</small>
        </span>
        <button class="icon-button" type="button" title="关闭通知" aria-label="关闭通知" @click="dismissToast(toast.id)">
          <UiIcon name="close" size="12" />
        </button>
      </article>
    </div>
    <ContextMenu
      v-if="contextMenu"
      v-bind="contextMenu"
      @close="closeContextMenu"
    />
  </div>
</template>
