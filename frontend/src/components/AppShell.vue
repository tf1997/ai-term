<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { AiProviderConfig, ConnectionProfile } from '../types/profile'
import { isWindowsPlatform } from '../utils/platform'

type TerminalRuntimeStatus = 'idle' | 'connecting' | 'local' | 'remote' | 'sftp' | 'preview' | 'error'
import type {
  AiContextStatus,
  AiMessage,
  CommandHistoryEntry,
  CommandRecordedEvent,
  ScriptRecording,
  TerminalInputEvent,
  TerminalInputSyncState,
  TerminalInputWriteFailureEvent,
  TerminalOutputDeltaEvent,
  TerminalOutputEvent,
  TerminalSelectionEvent,
  WorkspaceSession
} from '../types/workspace'
import {
  deleteAiProviderConfig,
  deleteConnectionProfile,
  deleteWorkspaceSession,
  listAiProviderConfigs,
  listAiConversationMessages,
  listCommandHistory,
  listConnectionProfiles,
  listWorkspaceSessions,
  saveAiConversationMessage,
  saveAiProviderConfig,
  saveCommandHistoryRecord,
  saveConnectionProfile,
  saveWorkspaceSession
} from '../lib/tauri'
import ConnectionSidebar from './ConnectionSidebar.vue'
import ContextMenu from './ContextMenu.vue'
import SettingsSidebar from './SettingsSidebar.vue'
import TerminalPane from './TerminalPane.vue'
import WorkspacePanel from './WorkspacePanel.vue'
import UiIcon from './UiIcon.vue'

interface TerminalTab {
  id: string
  title: string
  connectionId: string
  profile?: ConnectionProfile
  connectRequest: number
  status: TerminalRuntimeStatus
  connectionGeneration: number
}

const COMMAND_HISTORY_CACHE_LIMIT = 300
const USER_SETTINGS_STORAGE_KEY = 'ai-term:user-settings:v1'
const APP_THEME_STORAGE_KEY = 'ai-term:app-theme:v1'
const WORKSPACE_WIDTH_STORAGE_KEY = 'ai-term:workspace-width:v1'
const SYSTEM_TERMINAL_FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
const WINDOWS_TERMINAL_FONT_FAMILY = '"Cascadia Mono", "Cascadia Code", "JetBrains Mono", Consolas, monospace'
const LEGACY_WINDOWS_TERMINAL_FONT_FAMILY = '"JetBrains Mono", ui-monospace, monospace'
const DEFAULT_TERMINAL_FONT_FAMILY = isWindowsPlatform() ? WINDOWS_TERMINAL_FONT_FAMILY : SYSTEM_TERMINAL_FONT_FAMILY
const defaultUserSettings: AppUserSettings = {
  terminalFontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
  terminalFontSize: 13,
  terminalTheme: 'midnight',
  defaultShell: 'system'
}
type TerminalPaneInstance = InstanceType<typeof TerminalPane> & {
  commandExecutionReadiness: () => 'ready' | 'line-busy' | 'shell-busy' | 'unavailable'
  executeCommand: (command: string) => boolean
  terminalInputSyncState: () => TerminalInputSyncState
  writeTerminalInput: (data: string) => boolean
  writeSyncedTerminalInput: (data: string, sourceTerminalId: string) => boolean
  clearTerminal: () => void
  disconnectFromButton: () => void
  focusTerminal: () => void
  restartLocalTerminal: () => void
}

type LeftPanelMode = 'connections' | 'settings'
type SaveState = 'idle' | 'saving' | 'saved' | 'error'

type ToastKind = 'success' | 'error' | 'warning' | 'info'
type TerminalTheme = 'midnight' | 'matrix' | 'light'
type AppTheme = 'dark' | 'light'
type AboutSignalIcon = 'ai' | 'database' | 'network' | 'shield' | 'terminal'

interface AppUserSettings {
  terminalFontFamily: string
  terminalFontSize: number
  terminalTheme: TerminalTheme
  defaultShell: string
}

interface AppToast {
  id: string
  kind: ToastKind
  title: string
  message?: string
}
interface ContextMenuItem {
  id: string
  label: string
  danger?: boolean
  disabled?: boolean
  action: () => void
}

interface ContextMenuState {
  x: number
  y: number
  title?: string
  items: ContextMenuItem[]
}

interface AboutSignal {
  icon: AboutSignalIcon
  label: string
  value: string
}

const defaultAiConfig: AiProviderConfig = {
  id: 'default',
  provider: 'open-ai-compatible',
  baseUrl: '',
  model: '',
  apiKeyRef: '',
  apiKey: '',
  contextPolicy: 'selected-output-only',
  systemPrompt: 'You are an assistant for safe server operations.',
  riskPolicy: 'confirm-dangerous'
}
const LOCAL_CONNECTION_ID = 'local'
const DEFAULT_AI_SESSION_ID = 'ai:default'
const COMMAND_HISTORY_SESSION_ID = 'connection-history'
const APP_VERSION = '0.1.0'
const APP_CHANNEL = 'Stable'
const APP_LICENSE = 'Apache-2.0'
const APP_AUTHOR = 'tf1997 & gpt-5.5 & gpt-5.6-sol'
const aboutSignals: AboutSignal[] = [
  { icon: 'terminal', label: 'Terminal Core', value: 'PTY / SSH' },
  { icon: 'ai', label: 'AI Runtime', value: 'Command / Script' },
  { icon: 'network', label: 'Transfer Mesh', value: 'SFTP / Bastion' },
  { icon: 'shield', label: 'Safety Layer', value: 'Keys / Risk' },
  { icon: 'database', label: 'Local Store', value: 'SQLite / Keychain' }
]

const profiles = ref<ConnectionProfile[]>([])
const aiConfigs = ref<AiProviderConfig[]>([{ ...defaultAiConfig }])
const selectedAiConfigId = ref(defaultAiConfig.id)
const aiRuntimeApiKeys = ref<Record<string, string>>({})

const selectedProfileId = ref(profiles.value[0]?.id ?? '')
const profileStoreStatus = ref<'loading' | 'ready' | 'preview' | 'error'>('loading')
const connectingProfileId = ref('')
const connectionError = ref('')
const connectionSaveState = ref<SaveState>('idle')
const connectionSaveError = ref('')
const aiConfigSaveState = ref<SaveState>('idle')
const aiConfigSaveError = ref('')
const connectionEditorOpen = ref(false)
const connectionEditorMode = ref<'create' | 'edit'>('edit')
const connectionDraft = ref<ConnectionProfile | undefined>()
const aiConfigEditorOpen = ref(false)
const aiConfigEditorMode = ref<'create' | 'edit'>('edit')
const aiConfigDraft = ref<AiProviderConfig | undefined>()
const aboutOpen = ref(false)
const leftPanelMode = ref<LeftPanelMode>('connections')
const leftCollapsed = ref(false)
const rightCollapsed = ref(false)
const workspacePanelTab = ref<'history' | 'ai' | 'scripts' | 'sftp'>('ai')
const terminalTabs = ref<TerminalTab[]>([
  {
    id: 'local-1',
    title: '本地终端',
    connectionId: LOCAL_CONNECTION_ID,
    profile: undefined,
    connectRequest: 0,
    status: 'idle',
    connectionGeneration: 0
  }
])
const activeTerminalId = ref('local-1')
const selectedTerminalIds = ref<string[]>(['local-1'])
const pausedTerminalSyncIds = ref<string[]>([])
// shallowRef: component instances are only accessed imperatively; deep
// reactivity would proxy every TerminalPane instance for no benefit.
const terminalRefs = shallowRef<Record<string, TerminalPaneInstance | null>>({})
const terminalSnapshots = ref<Record<string, string>>({})
const terminalOutputEvents = ref<Record<string, TerminalOutputDeltaEvent>>({})
const terminalSelections = ref<Record<string, TerminalSelectionEvent>>({})
const workspaceSessions = ref<WorkspaceSession[]>([])
const activeAiSessionId = ref('')
const draftWorkspaceSessionIds = ref<Record<string, boolean>>({})
const commandHistoryByConnection = ref<Record<string, CommandHistoryEntry[]>>({})
const aiMessagesBySession = ref<Record<string, AiMessage[]>>({})
const aiContextBySession = ref<Record<string, AiContextStatus>>({})
const scriptRecordingsByTerminal = ref<Record<string, ScriptRecording>>({})
const loadedCommandHistoryConnections = ref<Record<string, boolean>>({})
const loadedAiSessions = ref<Record<string, boolean>>({})
const workspaceSessionListLoaded = ref(false)
const contextMenu = ref<ContextMenuState | null>(null)
const appSettings = ref<AppUserSettings>(loadUserSettings())
const appTheme = ref<AppTheme>(loadAppTheme())
const workspaceWidth = ref(loadWorkspaceWidth())
const workspaceResizing = ref(false)
const themeToggleButton = ref<HTMLButtonElement | null>(null)
const sessionTabStrip = ref<HTMLDivElement | null>(null)
const sessionTabButtons = shallowRef<Record<string, HTMLButtonElement | null>>({})
const sessionTabScrollLeft = ref(0)
const sessionTabClientWidth = ref(1)
const sessionTabScrollWidth = ref(1)
const toasts = ref<AppToast[]>([])
let lastThemeToggleAt = 0
let toastSequence = 0
let terminalOutputSequence = 0
const COMMAND_EXECUTION_RETRY_DELAYS_MS = [0, 100, 250, 500, 1_000]
let sessionTabResizeObserver: ResizeObserver | null = null
let workspaceSessionListLoadPromise: Promise<void> | null = null
const workspaceLayoutStyle = computed(() => ({ '--workspace-user-width': `${workspaceWidth.value}px` }))
const selectedProfile = computed(() => {
  if (!selectedProfileId.value) return undefined
  return profiles.value.find((profile) => profile.id === selectedProfileId.value)
})

const sidebarProfile = computed(() => {
  return connectionEditorOpen.value ? connectionDraft.value : selectedProfile.value
})

const activeTerminal = computed(() => {
  return terminalTabs.value.find((tab) => tab.id === activeTerminalId.value) ?? terminalTabs.value[0]
})

const selectedTerminalIdSet = computed(() => new Set(selectedTerminalIds.value))
const pausedTerminalSyncIdSet = computed(() => new Set(pausedTerminalSyncIds.value))

const targetTerminalTabs = computed(() => {
  const selected = terminalTabs.value.filter((tab) => selectedTerminalIdSet.value.has(tab.id))
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
const connectionLabels = computed<Record<string, string>>(() => {
  const labels: Record<string, string> = {
    [LOCAL_CONNECTION_ID]: '本地终端'
  }
  profiles.value.forEach((profile) => {
    const endpoint = profile.target.host
      ? `${profile.target.username || 'user'}@${profile.target.host}`
      : profile.name
    labels[profile.id] = profile.name && profile.name !== profile.id ? `${profile.name} · ${endpoint}` : endpoint
  })
  return labels
})
const sessionTabOverflow = computed(() => sessionTabScrollWidth.value - sessionTabClientWidth.value > 2)
const sessionTabThumbStyle = computed(() => {
  const clientWidth = Math.max(1, sessionTabClientWidth.value)
  const scrollWidth = Math.max(clientWidth, sessionTabScrollWidth.value)
  const scrollableWidth = Math.max(1, scrollWidth - clientWidth)
  const widthPercent = Math.max(8, (clientWidth / scrollWidth) * 100)
  const leftPercent = (sessionTabScrollLeft.value / scrollableWidth) * (100 - widthPercent)
  return {
    left: `${leftPercent}%`,
    width: `${widthPercent}%`
  }
})

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
const activeWorkspaceSessionId = computed(() => activeAiSessionId.value)

const activeCommandHistory = computed(() => {
  return commandHistoryByConnection.value[activeConnectionId.value] ?? []
})

function commandHistoryForTab(tab: TerminalTab) {
  return commandHistoryByConnection.value[tab.connectionId] ?? []
}
const activeAiMessages = computed(() => {
  return aiMessagesBySession.value[activeAiSessionId.value] ?? []
})

const activeAiContextStatus = computed(() => {
  return aiContextBySession.value[activeAiSessionId.value]
})

const activeScriptRecording = computed(() => {
  return scriptRecordingsByTerminal.value[activeTerminalId.value] ?? createIdleScriptRecording(activeTerminalId.value)
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

const sftpWorkbenchActive = computed(() => !rightCollapsed.value && workspacePanelTab.value === 'sftp')

const aiConfig = computed(() => {
  return aiConfigs.value.find((config) => config.id === selectedAiConfigId.value) ?? aiConfigs.value[0] ?? { ...defaultAiConfig }
})

const settingsAiConfig = computed(() => {
  return aiConfigEditorOpen.value ? aiConfigDraft.value ?? aiConfig.value : aiConfig.value
})

const activeAiRuntimeApiKey = computed(() => aiRuntimeApiKeys.value[aiConfig.value.id] ?? '')

function isAiConfigUsable(config: AiProviderConfig) {
  return Boolean(config.baseUrl.trim() && config.model.trim() && config.apiKey?.trim())
}

function selectPreferredAiConfig(configs: AiProviderConfig[], preferredId = selectedAiConfigId.value) {
  return (
    configs.find((config) => config.id === preferredId && isAiConfigUsable(config)) ??
    configs.find(isAiConfigUsable) ??
    configs.find((config) => config.id === preferredId) ??
    configs.find((config) => config.id === defaultAiConfig.id) ??
    configs[0] ??
    { ...defaultAiConfig }
  )
}

function selectProfile(profileId: string) {
  selectedProfileId.value = profileId
  connectionError.value = ''
  connectionSaveState.value = 'idle'
  connectionSaveError.value = ''
}

function createProfile() {
  const id = nextConnectionProfileId('connection')
  const profile: ConnectionProfile = {
    id,
    name: id,
    connectionRole: 'direct',
    gateway: {
      host: '',
      port: 22,
      username: '',
      authMode: 'auto',
      password: ''
    },
    target: {
      host: '',
      port: 22,
      username: '',
      authMode: 'auto',
      password: ''
    },
    jumpMode: 'direct',
    menuProfileId: '',
    fileTransferMode: 'auto'
  }
  connectionDraft.value = profile
  selectedProfileId.value = ''
  connectionError.value = ''
  connectionSaveState.value = 'idle'
  connectionSaveError.value = ''
  connectionEditorMode.value = 'create'
  connectionEditorOpen.value = true
  leftPanelMode.value = 'connections'
  leftCollapsed.value = false
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
    if (isSftpProfile(profile)) {
      workspacePanelTab.value = 'sftp'
      rightCollapsed.value = false
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

function isSftpProfile(profile: ConnectionProfile) {
  return profile.fileTransferMode === 'sftp-direct' || profile.fileTransferMode === 'sftp-gateway'
}

async function createLocalTerminalTab() {
  await ensureActiveAiSession(LOCAL_CONNECTION_ID)
  createTerminalTab()
}

function openLocalTerminal() {
  selectedProfileId.value = ''
  void createLocalTerminalTab()
}

function normalizedTerminalTargetIds(ids: string[], requiredId = activeTerminalId.value) {
  const validIds = new Set(terminalTabs.value.map((tab) => tab.id))
  const next = terminalTabs.value.map((tab) => tab.id).filter((id) => ids.includes(id) && validIds.has(id))
  if (requiredId && validIds.has(requiredId) && !next.includes(requiredId)) next.push(requiredId)
  if (next.length > 0) return next
  return requiredId && validIds.has(requiredId) ? [requiredId] : []
}

function setTerminalTargets(ids: string[], requiredId = activeTerminalId.value) {
  const next = normalizedTerminalTargetIds(ids, requiredId)
  selectedTerminalIds.value = next
  pausedTerminalSyncIds.value = pausedTerminalSyncIds.value.filter((id) => next.includes(id) && id !== requiredId)
}

function normalizeTerminalTargets(preferredId = activeTerminalId.value) {
  setTerminalTargets(selectedTerminalIds.value, preferredId)
}

function selectTerminalTab(tabId: string) {
  activeTerminalId.value = tabId
  const validIds = new Set(terminalTabs.value.map((tab) => tab.id))
  const current = selectedTerminalIds.value.filter((id) => validIds.has(id))
  if (current.length <= 1) {
    setTerminalTargets([tabId], tabId)
    return
  }
  setTerminalTargets(current, tabId)
}

function setSessionTabButton(tabId: string, element: unknown) {
  sessionTabButtons.value[tabId] = element instanceof HTMLButtonElement ? element : null
}

function updateSessionTabScrollMetrics() {
  const strip = sessionTabStrip.value
  if (!strip) return
  sessionTabScrollLeft.value = strip.scrollLeft
  sessionTabClientWidth.value = Math.max(1, strip.clientWidth)
  sessionTabScrollWidth.value = Math.max(1, strip.scrollWidth)
}

function handleSessionTabScroll() {
  updateSessionTabScrollMetrics()
}

function handleSessionTabWheel(event: WheelEvent) {
  const strip = sessionTabStrip.value
  if (!strip || !sessionTabOverflow.value) return
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
  if (!delta) return
  const nextLeft = Math.max(0, Math.min(strip.scrollLeft + delta, strip.scrollWidth - strip.clientWidth))
  if (nextLeft === strip.scrollLeft) return
  event.preventDefault()
  strip.scrollLeft = nextLeft
  updateSessionTabScrollMetrics()
}

function handleSessionTabScrollbarPointerDown(event: PointerEvent) {
  if (event.target !== event.currentTarget) return
  const strip = sessionTabStrip.value
  const track = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  if (!strip || !track || !sessionTabOverflow.value) return
  const trackRect = track.getBoundingClientRect()
  const widthRatio = sessionTabClientWidth.value / sessionTabScrollWidth.value
  const thumbWidth = Math.max(28, trackRect.width * widthRatio)
  const targetLeft = event.clientX - trackRect.left - thumbWidth / 2
  const scrollableTrack = Math.max(1, trackRect.width - thumbWidth)
  const scrollableContent = Math.max(1, strip.scrollWidth - strip.clientWidth)
  strip.scrollLeft = Math.max(0, Math.min(targetLeft / scrollableTrack, 1)) * scrollableContent
  updateSessionTabScrollMetrics()
}

function handleSessionTabThumbPointerDown(event: PointerEvent) {
  const strip = sessionTabStrip.value
  const thumb = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  const track = thumb?.parentElement
  if (!strip || !thumb || !track || !sessionTabOverflow.value) return
  event.preventDefault()
  const startX = event.clientX
  const startLeft = strip.scrollLeft
  const trackWidth = track.clientWidth
  const thumbWidth = thumb.clientWidth
  const scrollableTrack = Math.max(1, trackWidth - thumbWidth)
  const scrollableContent = Math.max(1, strip.scrollWidth - strip.clientWidth)
  const scrollPerPixel = scrollableContent / scrollableTrack

  const handlePointerMove = (moveEvent: PointerEvent) => {
    const nextLeft = startLeft + (moveEvent.clientX - startX) * scrollPerPixel
    strip.scrollLeft = Math.max(0, Math.min(nextLeft, scrollableContent))
    updateSessionTabScrollMetrics()
  }
  const stopDragging = () => {
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', stopDragging)
    window.removeEventListener('pointercancel', stopDragging)
  }

  thumb.setPointerCapture?.(event.pointerId)
  window.addEventListener('pointermove', handlePointerMove)
  window.addEventListener('pointerup', stopDragging, { once: true })
  window.addEventListener('pointercancel', stopDragging, { once: true })
}

function scrollActiveTerminalTabIntoView() {
  void nextTick(() => {
    sessionTabButtons.value[activeTerminalId.value]?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest'
    })
    updateSessionTabScrollMetrics()
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
  const validIds = new Set(terminalTabs.value.map((tab) => tab.id))
  const current = selectedTerminalIds.value.filter((id) => validIds.has(id))
  if (tabId === activeTerminalId.value) {
    setTerminalTargets([tabId], tabId)
    return
  }
  if (current.includes(tabId)) {
    setTerminalTargets(current.filter((id) => id !== tabId))
    return
  }
  setTerminalTargets([...current, tabId])
}

function selectAllTerminalTargets() {
  pausedTerminalSyncIds.value = []
  setTerminalTargets(terminalTabs.value.map((tab) => tab.id))
}

function resetTerminalTargetsToActive() {
  pausedTerminalSyncIds.value = []
  setTerminalTargets([activeTerminalId.value])
}

function openConnectionsPanel() {
  leftPanelMode.value = 'connections'
  leftCollapsed.value = false
}

function openSettingsPanel() {
  leftPanelMode.value = 'settings'
  leftCollapsed.value = false
}

function toggleConnectionsPanel() {
  if (leftPanelMode.value === 'connections') {
    leftCollapsed.value = !leftCollapsed.value
    return
  }
  openConnectionsPanel()
}

function toggleSettingsPanel() {
  if (leftPanelMode.value === 'settings') {
    leftCollapsed.value = !leftCollapsed.value
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
  return leftPanelMode.value === mode && !leftCollapsed.value
}

function leftPanelButtonTitle(mode: LeftPanelMode) {
  if (isLeftPanelActive(mode)) return mode === 'connections' ? '收起连接管理' : '收起设置中心'
  return mode === 'connections' ? '打开连接管理' : '打开设置中心'
}

function openContextMenu(event: MouseEvent, title: string, items: ContextMenuItem[]) {
  const menuWidth = 220
  const menuHeight = Math.min(320, 34 + items.length * 38)
  contextMenu.value = {
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
    title,
    items
  }
}

function closeContextMenu() {
  contextMenu.value = null
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
  openContextMenu(event, tab.title, [
    {
      id: 'switch',
      label: '切换到此终端',
      action: () => selectTerminalTab(tab.id)
    },
    {
      id: 'toggle-target',
      label: tab.id === activeTerminalId.value ? '仅同步当前终端' : isTerminalTargetSelected(tab.id) ? '从同步目标移除' : '加入同步目标',
      disabled: tab.id === activeTerminalId.value && targetTerminalIds.value.length === 1,
      action: () => toggleTerminalTarget(tab.id)
    },
    {
      id: 'select-all-targets',
      label: '选择全部终端',
      disabled: terminalTabs.value.length <= 1,
      action: selectAllTerminalTargets
    },
    {
      id: 'reset-targets',
      label: '仅当前终端',
      action: resetTerminalTargetsToActive
    },
    {
      id: 'new-local',
      label: '新建本地终端',
      action: openLocalTerminal
    },
    {
      id: 'close',
      label: '关闭终端标签',
      danger: true,
      disabled: terminalTabs.value.length === 1,
      action: () => closeTerminalTab(tab.id)
    }
  ])
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
      label: '选择全部终端',
      disabled: terminalTabs.value.length <= 1,
      action: selectAllTerminalTargets
    },
    {
      id: 'reset-targets',
      label: '仅当前终端',
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

function editSelectedProfile(profileId: string) {
  const profile = profiles.value.find((item) => item.id === profileId)
  if (!profile) return
  selectedProfileId.value = profileId
  connectionDraft.value = cloneConnectionProfile(profile)
  connectionSaveState.value = 'idle'
  connectionSaveError.value = ''
  connectionEditorMode.value = 'edit'
  connectionEditorOpen.value = true
  openConnectionsPanel()
}

function copySelectedProfile(profileId: string) {
  const profile = profiles.value.find((item) => item.id === profileId)
  if (!profile) return
  const draft = cloneConnectionProfile(profile)
  draft.id = nextConnectionProfileId(`${profile.id}-copy`)
  draft.name = nextConnectionProfileName(`${profile.name || profile.id} \u526f\u672c`)
  draft.gateway.credentialRef = undefined
  draft.target.credentialRef = undefined
  connectionDraft.value = draft
  selectedProfileId.value = ''
  connectionSaveState.value = 'idle'
  connectionSaveError.value = ''
  connectionEditorMode.value = 'create'
  connectionEditorOpen.value = true
  openConnectionsPanel()
}
function closeConnectionEditor() {
  connectionEditorOpen.value = false
  connectionDraft.value = undefined
  connectionSaveState.value = 'idle'
  connectionSaveError.value = ''
}

function createAiConfig() {
  const nextId = nextAiConfigId()
  const config: AiProviderConfig = {
    ...defaultAiConfig,
    id: nextId,
    apiKeyRef: '',
    apiKey: ''
  }
  aiConfigDraft.value = config
  aiConfigSaveState.value = 'idle'
  aiConfigSaveError.value = ''
  aiConfigEditorMode.value = 'create'
  aiConfigEditorOpen.value = true
  openSettingsPanel()
}

function selectAiConfig(configId: string) {
  if (aiConfigs.value.some((config) => config.id === configId)) {
    selectedAiConfigId.value = configId
    aiConfigSaveState.value = 'idle'
    aiConfigSaveError.value = ''
  }
}

function editAiConfig(configId?: string) {
  if (configId) {
    selectAiConfig(configId)
  }
  aiConfigDraft.value = cloneAiConfig(aiConfig.value)
  aiConfigSaveState.value = 'idle'
  aiConfigSaveError.value = ''
  aiConfigEditorMode.value = 'edit'
  aiConfigEditorOpen.value = true
  openSettingsPanel()
}

function closeAiConfigEditor() {
  aiConfigEditorOpen.value = false
  aiConfigDraft.value = undefined
  aiConfigSaveState.value = 'idle'
  aiConfigSaveError.value = ''
}

async function saveAiConfig(config: AiProviderConfig, apiKey = '') {
  aiConfigSaveState.value = 'saving'
  aiConfigSaveError.value = ''
  const savedConfig = {
    ...config,
    id: config.id.trim() || defaultAiConfig.id,
    apiKey: apiKey || config.apiKey || ''
  }
  if (savedConfig.apiKey) {
    savedConfig.apiKeyRef = `ai-provider:${savedConfig.id}`
    aiRuntimeApiKeys.value = {
      ...aiRuntimeApiKeys.value,
      [savedConfig.id]: savedConfig.apiKey
    }
  }
  try {
    await saveAiProviderConfig(savedConfig)
    aiConfigs.value = await listAiProviderConfigs()
    selectedAiConfigId.value = savedConfig.id
    profileStoreStatus.value = 'ready'
    aiConfigSaveState.value = 'saved'
    aiConfigEditorOpen.value = false
    aiConfigDraft.value = undefined
    showToast('success', 'AI 配置已保存', savedConfig.id)
  } catch (error) {
    profileStoreStatus.value = 'preview'
    aiConfigSaveState.value = 'error'
    aiConfigSaveError.value = formatError(error)
    showToast('error', 'AI 配置保存失败', aiConfigSaveError.value)
  }
}

async function deleteSelectedAiConfig(configId: string) {
  if (!window.confirm(`删除 AI 配置 ${configId}？`)) return
  aiConfigSaveState.value = 'saving'
  aiConfigSaveError.value = ''
  try {
    await deleteAiProviderConfig(configId)
    const configs = await listAiProviderConfigs()
    aiConfigs.value = configs.length ? configs : [{ ...defaultAiConfig }]
    selectedAiConfigId.value = selectPreferredAiConfig(aiConfigs.value).id
    const nextRuntimeKeys = { ...aiRuntimeApiKeys.value }
    delete nextRuntimeKeys[configId]
    aiRuntimeApiKeys.value = nextRuntimeKeys
    if (aiConfigDraft.value?.id === configId) aiConfigDraft.value = undefined
    aiConfigEditorOpen.value = false
    aiConfigSaveState.value = 'saved'
    profileStoreStatus.value = 'ready'
    showToast('success', 'AI 配置已删除', configId)
  } catch (error) {
    aiConfigSaveState.value = 'error'
    aiConfigSaveError.value = formatError(error)
    showToast('error', 'AI 配置删除失败', aiConfigSaveError.value)
  }
}

function cloneConnectionProfile(profile: ConnectionProfile): ConnectionProfile {
  return JSON.parse(JSON.stringify(profile)) as ConnectionProfile
}

function cloneAiConfig(config: AiProviderConfig): AiProviderConfig {
  return JSON.parse(JSON.stringify(config)) as AiProviderConfig
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function loadUserSettings(): AppUserSettings {
  try {
    const raw = localStorage.getItem(USER_SETTINGS_STORAGE_KEY)
    if (!raw) return { ...defaultUserSettings }
    const parsed = JSON.parse(raw) as Partial<AppUserSettings>
    const storedTerminalFontFamily = parsed.terminalFontFamily
    const usesManagedDefault = !storedTerminalFontFamily
      || storedTerminalFontFamily === SYSTEM_TERMINAL_FONT_FAMILY
      || storedTerminalFontFamily === WINDOWS_TERMINAL_FONT_FAMILY
      || storedTerminalFontFamily === LEGACY_WINDOWS_TERMINAL_FONT_FAMILY
    const terminalFontFamily = usesManagedDefault ? DEFAULT_TERMINAL_FONT_FAMILY : storedTerminalFontFamily
    return {
      ...defaultUserSettings,
      ...parsed,
      terminalFontFamily,
      terminalFontSize: Math.max(11, Math.min(22, Number(parsed.terminalFontSize) || defaultUserSettings.terminalFontSize)),
      terminalTheme: 'midnight'
    }
  } catch {
    return { ...defaultUserSettings }
  }
}

function persistUserSettings(settings: AppUserSettings) {
  localStorage.setItem(USER_SETTINGS_STORAGE_KEY, JSON.stringify(settings))
}

function loadAppTheme(): AppTheme {
  try {
    return localStorage.getItem(APP_THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

function persistAppTheme(theme: AppTheme) {
  try {
    localStorage.setItem(APP_THEME_STORAGE_KEY, theme)
  } catch {
    // Theme persistence is a convenience; the UI should still switch when storage is unavailable.
  }
  const root = document.documentElement
  root.dataset.theme = theme
  root.classList.toggle('theme-light', theme === 'light')
  root.classList.toggle('theme-dark', theme === 'dark')
}

function loadWorkspaceWidth() {
  try {
    const value = Number(localStorage.getItem(WORKSPACE_WIDTH_STORAGE_KEY))
    return Number.isFinite(value) ? Math.max(360, Math.min(560, value)) : 420
  } catch {
    return 420
  }
}

function persistWorkspaceWidth() {
  try {
    localStorage.setItem(WORKSPACE_WIDTH_STORAGE_KEY, String(workspaceWidth.value))
  } catch {
    // Resizing remains available when storage is unavailable.
  }
}

function beginWorkspaceResize(event: PointerEvent) {
  if (event.button !== 0 || rightCollapsed.value || sftpWorkbenchActive.value) return
  workspaceResizing.value = true
  document.body.classList.add('workspace-resizing')
  window.addEventListener('pointermove', handleWorkspaceResize)
  window.addEventListener('pointerup', endWorkspaceResize)
  window.addEventListener('pointercancel', endWorkspaceResize)
  event.preventDefault()
}

function handleWorkspaceResize(event: PointerEvent) {
  if (!workspaceResizing.value) return
  const leftWidth = leftCollapsed.value ? 48 : 296
  const maxForTerminal = Math.max(360, window.innerWidth - leftWidth - 560)
  const maxWidth = Math.min(560, maxForTerminal)
  workspaceWidth.value = Math.round(Math.max(360, Math.min(maxWidth, window.innerWidth - event.clientX)))
}

function endWorkspaceResize() {
  if (!workspaceResizing.value) return
  workspaceResizing.value = false
  document.body.classList.remove('workspace-resizing')
  window.removeEventListener('pointermove', handleWorkspaceResize)
  window.removeEventListener('pointerup', endWorkspaceResize)
  window.removeEventListener('pointercancel', endWorkspaceResize)
  persistWorkspaceWidth()
}

function handleWorkspaceResizeKeydown(event: KeyboardEvent) {
  let nextWidth = workspaceWidth.value
  if (event.key === 'ArrowLeft') nextWidth += 20
  else if (event.key === 'ArrowRight') nextWidth -= 20
  else if (event.key === 'Home') nextWidth = 360
  else if (event.key === 'End') nextWidth = 560
  else return
  event.preventDefault()
  workspaceWidth.value = Math.max(360, Math.min(560, nextWidth))
  persistWorkspaceWidth()
}

function toggleAppTheme() {
  appTheme.value = appTheme.value === 'light' ? 'dark' : 'light'
  showToast('info', '主题已切换', appTheme.value === 'light' ? '已切换为白色主题。' : '已切换为深色主题。')
}
function handleThemeTogglePointerDown(event: Event) {
  event.preventDefault()
  event.stopPropagation()
  ;(event as Event & { stopImmediatePropagation?: () => void }).stopImmediatePropagation?.()
  const now = performance.now()
  if (now - lastThemeToggleAt < 160) return
  lastThemeToggleAt = now
  toggleAppTheme()
}

function updateUserSettings(settings: AppUserSettings) {
  appSettings.value = { ...settings }
  showToast('success', '设置已保存', '终端字体和字号已同步到当前终端。')
}

async function copyAboutInfo() {
  if (!navigator.clipboard?.writeText) {
    showToast('error', '复制失败', '当前环境不支持剪贴板写入。')
    return
  }
  const info = [
    `AI Term v${APP_VERSION}`,
    `Author: ${APP_AUTHOR}`,
    `Channel: ${APP_CHANNEL}`,
    `License: ${APP_LICENSE}`,
    `Theme: ${appTheme.value}`,
    `Terminal tabs: ${terminalTabs.value.length}`,
    `Saved connections: ${profiles.value.length}`,
    `Active workspace sessions: ${activeWorkspaceSessions.value.length}`,
    `Workspace panel: ${rightCollapsed.value ? 'collapsed' : workspacePanelTab.value}`
  ].join('\n')
  try {
    await navigator.clipboard.writeText(info)
    showToast('success', '关于信息已复制', '版本与运行状态已写入剪贴板。')
  } catch (error) {
    showToast('error', '复制失败', formatError(error))
  }
}

function showToast(kind: ToastKind, title: string, message = '') {
  const id = `toast-${Date.now()}-${toastSequence++}`
  const toastKey = `${kind}\u0000${title}\u0000${message}`
  const nextToasts = toasts.value.filter((toast) => `${toast.kind}\u0000${toast.title}\u0000${toast.message ?? ''}` !== toastKey)
  toasts.value = [...nextToasts, { id, kind, title, message }].slice(-3)
  window.setTimeout(() => dismissToast(id), kind === 'error' ? 6200 : 3600)
}

function dismissToast(id: string) {
  toasts.value = toasts.value.filter((toast) => toast.id !== id)
}
async function loadProfiles() {
  try {
    profiles.value = await listConnectionProfiles()
    profileStoreStatus.value = 'ready'
    if (!profiles.value.some((profile) => profile.id === selectedProfileId.value)) {
      selectedProfileId.value = ''
    }
  } catch (error) {
    profileStoreStatus.value = 'preview'
  }
}

async function loadAiConfig() {
  try {
    const configs = await listAiProviderConfigs()
    aiConfigs.value = configs.length ? configs : [{ ...defaultAiConfig }]
    selectedAiConfigId.value = selectPreferredAiConfig(aiConfigs.value).id
  } catch (error) {
    aiConfigs.value = [{ ...defaultAiConfig }]
    selectedAiConfigId.value = defaultAiConfig.id
  }
}

function nextConnectionProfileId(base = 'connection') {
  const baseId = base
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'connection'
  let index = baseId === 'connection' ? profiles.value.length + 1 : 1
  let id = baseId === 'connection' ? `${baseId}-${index}` : baseId
  while (profiles.value.some((profile) => profile.id === id)) {
    index += 1
    id = `${baseId}-${index}`
  }
  return id
}

function nextConnectionProfileName(base: string) {
  const baseName = base.trim() || 'connection \u526f\u672c'
  let index = 1
  let name = baseName
  while (profiles.value.some((profile) => profile.name === name)) {
    index += 1
    name = `${baseName} ${index}`
  }
  return name
}
function nextAiConfigId() {
  let index = aiConfigs.value.filter((config) => config.id !== defaultAiConfig.id).length + 1
  let id = `ai-config-${index}`
  while (aiConfigs.value.some((config) => config.id === id)) {
    index += 1
    id = `ai-config-${index}`
  }
  return id
}

function normalizeConnectionProfileForSave(profile: ConnectionProfile): ConnectionProfile {
  const normalized = cloneConnectionProfile(profile)
  normalized.id = normalized.id.trim() || normalized.name.trim() || `connection-${Date.now()}`
  normalized.name = normalized.name.trim() || normalized.id
  normalized.target.host = normalized.target.host.trim()
  normalized.target.username = normalized.target.username.trim()
  normalized.target.port = normalizePort(normalized.target.port, 'SSH port', 22)
  normalized.connectionRole = normalized.connectionRole === 'bastion' ? 'bastion' : 'direct'
  normalized.jumpMode = 'direct'
  normalized.menuProfileId = ''
  normalized.fileTransferMode = 'auto'
  normalized.gateway = {
    host: '',
    port: 22,
    username: '',
    authMode: 'auto',
    password: undefined,
    credentialRef: undefined
  }

  if (!normalized.target.password?.trim()) normalized.target.password = undefined

  return normalized
}

function normalizePort(value: unknown, label: string, fallback?: number): number | undefined {
  if (value === undefined || value === null || value === '') return fallback
  const port = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535`)
  }
  return port
}
async function saveSelectedProfile() {
  const profileToSave = connectionEditorOpen.value ? connectionDraft.value : selectedProfile.value
  if (!profileToSave) return
  let normalizedProfile: ConnectionProfile
  try {
    normalizedProfile = normalizeConnectionProfileForSave(profileToSave)
  } catch (error) {
    connectionSaveState.value = 'error'
    connectionSaveError.value = formatError(error)
    showToast('error', '连接参数无效', connectionSaveError.value)
    return
  }
  const savedProfileId = normalizedProfile.id
  try {
    connectionSaveState.value = 'saving'
    connectionSaveError.value = ''
    await saveConnectionProfile(normalizedProfile)
    profileStoreStatus.value = 'ready'
    profiles.value = await listConnectionProfiles()
    selectedProfileId.value = savedProfileId
    connectionError.value = ''
    connectionSaveState.value = 'saved'
    connectionEditorOpen.value = false
    connectionDraft.value = undefined
    showToast('success', '连接已保存', normalizedProfile.name)
  } catch (error) {
    profileStoreStatus.value = 'preview'
    connectionSaveState.value = 'error'
    connectionSaveError.value = formatError(error)
    showToast('error', '连接保存失败', connectionSaveError.value)
  }
}

async function deleteSelectedProfile(profileId: string) {
  const profileName = profiles.value.find((profile) => profile.id === profileId)?.name ?? profileId
  if (!window.confirm(`删除连接 ${profileName}？`)) return
  connectionSaveState.value = 'saving'
  connectionSaveError.value = ''
  try {
    await deleteConnectionProfile(profileId)
    profiles.value = await listConnectionProfiles()
    if (selectedProfileId.value === profileId) selectedProfileId.value = ''
    if (connectionDraft.value?.id === profileId) connectionDraft.value = undefined
    connectionEditorOpen.value = false
    connectionSaveState.value = 'saved'
    profileStoreStatus.value = 'ready'
  } catch (error) {
    connectionSaveState.value = 'error'
    connectionSaveError.value = formatError(error)
  }
}

function nowText() {
  return new Date().toISOString()
}

function newWorkspaceSession(connectionId: string, name?: string, id?: string): WorkspaceSession {
  const createdAt = nowText()
  return {
    id: id || `${connectionId}:session:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    connectionId,
    name: name || 'Untitled',
    summary: '',
    createdAt,
    updatedAt: createdAt
  }
}

function markDraftWorkspaceSession(sessionId: string) {
  draftWorkspaceSessionIds.value = {
    ...draftWorkspaceSessionIds.value,
    [sessionId]: true
  }
}

function clearDraftWorkspaceSession(sessionId: string) {
  const nextDrafts = { ...draftWorkspaceSessionIds.value }
  delete nextDrafts[sessionId]
  draftWorkspaceSessionIds.value = nextDrafts
}

function isDraftWorkspaceSession(sessionId: string) {
  return Boolean(draftWorkspaceSessionIds.value[sessionId])
}

function workspaceSessionById(sessionId: string) {
  return workspaceSessions.value.find((session) => session.id === sessionId)
}

function upsertWorkspaceSession(session: WorkspaceSession) {
  workspaceSessions.value = [session, ...workspaceSessions.value.filter((item) => item.id !== session.id)]
}

function replaceWorkspaceSession(session: WorkspaceSession) {
  workspaceSessions.value = workspaceSessions.value.map((item) => (item.id === session.id ? session : item))
}

function createDraftWorkspaceSession(connectionId: string, sessionId?: string, name = 'Untitled') {
  const existing = sessionId ? workspaceSessionById(sessionId) : undefined
  if (existing) return existing
  const session = newWorkspaceSession(connectionId, name, sessionId)
  markDraftWorkspaceSession(session.id)
  upsertWorkspaceSession(session)
  return session
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

async function ensurePersistedWorkspaceSession(connectionId: string, sessionId = activeAiSessionId.value || DEFAULT_AI_SESSION_ID, title?: string) {
  await loadWorkspaceSessionList()
  let session = workspaceSessionById(sessionId)
  if (!session) {
    session = createDraftWorkspaceSession(connectionId, sessionId, title || 'Untitled')
  }
  const nextTitle = title?.trim()
  let changed = false
  if (nextTitle && isAutoWorkspaceSessionName(session.name)) {
    session = { ...session, name: nextTitle, updatedAt: nowText() }
    replaceWorkspaceSession(session)
    changed = true
  }
  if (!isDraftWorkspaceSession(session.id)) {
    if (changed) await saveWorkspaceSession(session)
    return session
  }
  await saveWorkspaceSession(session)
  clearDraftWorkspaceSession(session.id)
  return session
}

async function createWorkspaceSessionForActiveConnection() {
  try {
    const session = await createWorkspaceSession(activeConnectionId.value)
    selectWorkspaceSession(session.id)
  } catch (error) {
    connectionError.value = formatError(error)
  }
}

async function renameWorkspaceSession(sessionId: string, name: string) {
  const session = workspaceSessionById(sessionId)
  if (!session) return
  const nextName = name.trim()
  if (!nextName) return
  const updated = { ...session, name: nextName, updatedAt: nowText() }
  replaceWorkspaceSession(updated)
  if (isDraftWorkspaceSession(sessionId)) return
  try {
    await saveWorkspaceSession(updated)
  } catch (error) {
    connectionError.value = formatError(error)
  }
}

async function updateWorkspaceSessionTitle(connectionId: string, sessionId: string, title: string) {
  const session = workspaceSessionById(sessionId)
  if (!session || !isAutoWorkspaceSessionName(session.name)) return
  const nextTitle = title.trim()
  if (!nextTitle) return
  const updated = { ...session, name: nextTitle, updatedAt: nowText() }
  replaceWorkspaceSession(updated)
  try {
    await saveWorkspaceSession({ ...updated, connectionId: session.connectionId || connectionId })
    clearDraftWorkspaceSession(sessionId)
  } catch (error) {
    console.error('failed to update AI generated session title', error)
  }
}

async function updateWorkspaceSessionContextSummary(sessionId: string, summary: string, lastMessageId: string) {
  const session = workspaceSessionById(sessionId)
  if (!session) return
  // Background compaction keeps updatedAt untouched so it never reorders the
  // session list on its own.
  const updated = { ...session, contextSummary: summary, contextSummaryLastMessageId: lastMessageId }
  replaceWorkspaceSession(updated)
  if (isDraftWorkspaceSession(sessionId)) return
  try {
    await saveWorkspaceSession(updated)
  } catch (error) {
    console.error('failed to persist AI conversation context summary', error)
  }
}

function isAutoWorkspaceSessionName(name: string) {
  return ['untitled', '无标题', '默认会话', '本地默认会话', '当前会话'].includes(name.trim().toLowerCase())
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
    if (!isDraftWorkspaceSession(sessionId)) {
      await deleteWorkspaceSession(sessionId)
    }
    clearDraftWorkspaceSession(sessionId)
    const remaining = sessions.filter((item) => item.id !== sessionId)
    workspaceSessions.value = remaining
    delete aiMessagesBySession.value[sessionId]
    delete aiContextBySession.value[sessionId]
    delete loadedAiSessions.value[sessionId]
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
  const id = `terminal-${Date.now()}-${terminalTabs.value.length + 1}`
  const title = profile ? `${profile.target.username || 'user'}@${profile.target.host || profile.name}` : '本地终端'
  const connectionId = profile?.id ?? LOCAL_CONNECTION_ID
  terminalTabs.value.push({
    id,
    title,
    connectionId,
    profile: profile ? cloneConnectionProfile(profile) : undefined,
    connectRequest: 1,
    status: 'idle',
    connectionGeneration: 0
  })
  activeTerminalId.value = id
  setTerminalTargets([id], id)
  void loadCommandHistoryForConnection(connectionId)
}

function closeTerminalTab(tabId: string) {
  if (terminalTabs.value.length === 1) return
  const index = terminalTabs.value.findIndex((tab) => tab.id === tabId)
  terminalTabs.value = terminalTabs.value.filter((tab) => tab.id !== tabId)
  delete terminalSnapshots.value[tabId]
  delete terminalOutputEvents.value[tabId]
  delete terminalSelections.value[tabId]
  delete terminalRefs.value[tabId]
  delete scriptRecordingsByTerminal.value[tabId]
  if (activeTerminalId.value === tabId) {
    const nextTab = terminalTabs.value[Math.max(0, index - 1)] ?? terminalTabs.value[0]
    activeTerminalId.value = nextTab.id
  }
  normalizeTerminalTargets(activeTerminalId.value)
}

function setTerminalRef(tabId: string, instance: TerminalPaneInstance | null) {
  terminalRefs.value[tabId] = instance
}

function terminalStatusClass(status: TerminalRuntimeStatus) {
  return {
    live: status === 'local' || status === 'remote' || status === 'sftp',
    connecting: status === 'connecting',
    error: status === 'error',
    preview: status === 'preview'
  }
}

function updateTerminalStatus(terminalId: string, status: TerminalRuntimeStatus) {
  terminalTabs.value = terminalTabs.value.map((tab) => {
    if (tab.id !== terminalId) return tab
    const wasConnected = tab.status === 'remote' || tab.status === 'sftp'
    const isConnected = status === 'remote' || status === 'sftp'
    return {
      ...tab,
      status,
      connectionGeneration: !wasConnected && isConnected
        ? tab.connectionGeneration + 1
        : tab.connectionGeneration
    }
  })
}

function updateTerminalOutput(event: TerminalOutputEvent) {
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

function updateTerminalSelection(event: TerminalSelectionEvent) {
  terminalSelections.value = {
    ...terminalSelections.value,
    [event.terminalId]: event
  }
}

function recordCommand(event: CommandRecordedEvent) {
  const tab = terminalTabs.value.find((item) => item.id === event.terminalId)
  const connectionId = tab?.connectionId ?? LOCAL_CONNECTION_ID
  const nextIndex = (commandHistoryByConnection.value[connectionId]?.length ?? 0) + 1
  const entry: CommandHistoryEntry = {
    id: `${connectionId}-${event.terminalId}-${Date.now()}-${nextIndex}`,
    connectionId,
    workspaceSessionId: COMMAND_HISTORY_SESSION_ID,
    terminalId: event.terminalId,
    command: event.command,
    createdAt: new Date().toLocaleString()
  }
  commandHistoryByConnection.value = {
    ...commandHistoryByConnection.value,
    [connectionId]: [...(commandHistoryByConnection.value[connectionId] ?? []), entry].slice(-COMMAND_HISTORY_CACHE_LIMIT)
  }
  appendRecordingCommand(event.terminalId, event.command)
  void saveCommandHistoryForTerminal(entry).catch((error) => {
    console.error('failed to save command history', error)
  })
}

async function saveCommandHistoryForTerminal(entry: CommandHistoryEntry) {
  await saveCommandHistoryRecord(entry)
}

function createIdleScriptRecording(terminalId: string): ScriptRecording {
  return {
    terminalId,
    connectionId: activeConnectionId.value,
    workspaceSessionId: activeAiSessionId.value || DEFAULT_AI_SESSION_ID,
    isRecording: false,
    startedAt: '',
    commands: [],
    terminalOutput: ''
  }
}

function startScriptRecording() {
  const terminalId = activeTerminalId.value
  scriptRecordingsByTerminal.value = {
    ...scriptRecordingsByTerminal.value,
    [terminalId]: {
      terminalId,
      connectionId: activeConnectionId.value,
      workspaceSessionId: activeAiSessionId.value || DEFAULT_AI_SESSION_ID,
      isRecording: true,
      startedAt: nowText(),
      commands: [],
      terminalOutput: ''
    }
  }
}

function stopScriptRecording() {
  const recording = scriptRecordingsByTerminal.value[activeTerminalId.value]
  if (!recording) return
  scriptRecordingsByTerminal.value = {
    ...scriptRecordingsByTerminal.value,
    [activeTerminalId.value]: {
      ...recording,
      isRecording: false,
      stoppedAt: nowText()
    }
  }
}

function clearScriptRecording() {
  const nextRecordings = { ...scriptRecordingsByTerminal.value }
  delete nextRecordings[activeTerminalId.value]
  scriptRecordingsByTerminal.value = nextRecordings
}

function appendRecordingOutput(terminalId: string, delta: string) {
  if (!delta) return
  const recording = scriptRecordingsByTerminal.value[terminalId]
  if (!recording?.isRecording) return
  scriptRecordingsByTerminal.value = {
    ...scriptRecordingsByTerminal.value,
    [terminalId]: {
      ...recording,
      terminalOutput: `${recording.terminalOutput}${delta}`.slice(-120_000)
    }
  }
}

function appendRecordingCommand(terminalId: string, command: string) {
  const recording = scriptRecordingsByTerminal.value[terminalId]
  if (!recording?.isRecording) return
  scriptRecordingsByTerminal.value = {
    ...scriptRecordingsByTerminal.value,
    [terminalId]: {
      ...recording,
      commands: [...recording.commands, command].slice(-200)
    }
  }
}

function terminalOutputDelta(previousSnapshot: string, nextSnapshot: string) {
  if (!previousSnapshot) return nextSnapshot
  if (nextSnapshot.startsWith(previousSnapshot)) return nextSnapshot.slice(previousSnapshot.length)
  if (nextSnapshot.length > previousSnapshot.length) return nextSnapshot.slice(previousSnapshot.length)
  return nextSnapshot.slice(-80_000)
}

function commandPreview(command: string) {
  return command.length > 120 ? `${command.slice(0, 120)}...` : command
}

function isActiveTerminalOnlyInput(data: string) {
  return data.includes('AI_TERM_IDENT_') || data.includes('AI_TERM_DOWNLOAD_') || data.includes('AI_TERM_UPLOAD_')
}

function writeInputToActiveTerminal(data: string) {
  if (terminalRefs.value[activeTerminalId.value]?.writeTerminalInput(data)) return
  showToast('error', '终端输入未发送', '当前终端不可用或没有活动 shell。')
}

function focusActiveTerminalFromWorkspace() {
  rightCollapsed.value = true
  requestAnimationFrame(() => {
    terminalRefs.value[activeTerminalId.value]?.focusTerminal()
  })
}

async function executeCommandOnTerminalIds(command: string, targets: string[]) {
  const value = command.trim()
  if (!value) return
  const pendingTargets = new Set(targets)
  const lastReadiness = new Map<string, ReturnType<TerminalPaneInstance['commandExecutionReadiness']>>()
  let sentCount = 0

  for (const delay of COMMAND_EXECUTION_RETRY_DELAYS_MS) {
    if (delay > 0) await new Promise((resolve) => window.setTimeout(resolve, delay))
    await nextTick()
    for (const terminalId of [...pendingTargets]) {
      const pane = terminalRefs.value[terminalId]
      const readiness = pane?.commandExecutionReadiness() ?? 'unavailable'
      lastReadiness.set(terminalId, readiness)
      if (readiness === 'ready' && pane?.executeCommand(value)) {
        sentCount += 1
        pendingTargets.delete(terminalId)
      } else if (readiness === 'line-busy') {
        pendingTargets.delete(terminalId)
      }
    }
    if (pendingTargets.size === 0) break
  }

  if (sentCount > 0) {
    showToast('success', sentCount > 1 ? `命令已发送到 ${sentCount} 个终端` : '命令已发送', commandPreview(value))
    return
  }

  const readiness = [...lastReadiness.values()]
  if (readiness.includes('line-busy')) {
    showToast('warning', '命令未发送', '当前命令行已有输入或补全内容，请先提交或清空。')
  } else if (readiness.includes('shell-busy')) {
    showToast('warning', '命令未发送', 'Shell 尚未返回可执行提示符，请稍后重试。')
  } else {
    showToast('error', '命令未发送', '当前终端尚未就绪或连接已断开。')
  }
}

function executeCommandOnTargetTerminals(command: string) {
  void executeCommandOnTerminalIds(command, [...targetTerminalIds.value])
}

function rerunCommandOnActiveTerminal(command: string) {
  void executeCommandOnTerminalIds(command, [activeTerminalId.value])
}

async function writeInputToTargetTerminals(data: string) {
  if (!data) return
  if (isActiveTerminalOnlyInput(data)) {
    writeInputToActiveTerminal(data)
    return
  }
  const pendingTargets = new Set(targetTerminalIds.value)
  const lineBusyTargets = new Set<string>()
  const lastReadiness = new Map<string, ReturnType<TerminalPaneInstance['commandExecutionReadiness']>>()
  let sentCount = 0

  for (const delay of COMMAND_EXECUTION_RETRY_DELAYS_MS) {
    if (delay > 0) await new Promise((resolve) => window.setTimeout(resolve, delay))
    await nextTick()
    for (const terminalId of [...pendingTargets]) {
      const pane = terminalRefs.value[terminalId]
      const readiness = pane?.commandExecutionReadiness() ?? 'unavailable'
      lastReadiness.set(terminalId, readiness)
      if (readiness === 'ready' && pane?.writeTerminalInput(data)) {
        sentCount += 1
        pendingTargets.delete(terminalId)
      } else if (readiness === 'line-busy') {
        lineBusyTargets.add(terminalId)
        pendingTargets.delete(terminalId)
      }
    }
    if (pendingTargets.size === 0) break
  }

  const waitingCount = [...pendingTargets].filter((terminalId) => lastReadiness.get(terminalId) === 'shell-busy').length
  const skippedCount = pendingTargets.size + lineBusyTargets.size
  if (sentCount === 0) {
    showToast(
      lineBusyTargets.size > 0 || waitingCount > 0 ? 'warning' : 'error',
      '脚本未发送',
      lineBusyTargets.size > 0
        ? '目标终端命令行已有输入，请先提交或清空后重试。'
        : waitingCount > 0
          ? '等待提示符超时；目标终端可能仍在执行命令或处于交互程序中。'
          : '目标终端不可用或没有活动 shell。'
    )
  } else if (skippedCount > 0) {
    showToast('warning', '脚本已部分发送', `已发送到 ${sentCount} 个终端；${skippedCount} 个未就绪终端已跳过。`)
  }
}

function terminalInputSyncStatesMatch(source: TerminalInputSyncState, target: TerminalInputSyncState) {
  return source.available &&
    target.available &&
    source.context === 'shell' &&
    target.context === 'shell' &&
    source.reliable &&
    target.reliable &&
    source.command === target.command &&
    source.cursor === target.cursor &&
    source.pendingControlSequence === target.pendingControlSequence
}

function terminalInputStateIsEmptyPrompt(state: TerminalInputSyncState) {
  return state.available &&
    state.context === 'shell' &&
    state.reliable &&
    state.command.length === 0 &&
    state.cursor === 0 &&
    state.pendingControlSequence.length === 0
}

function pauseTerminalSyncTargets(ids: string[], message: string, notify = true) {
  const selected = new Set(targetTerminalIds.value)
  const current = new Set(pausedTerminalSyncIds.value)
  const added = ids.filter((id) => id !== activeTerminalId.value && selected.has(id) && !current.has(id))
  if (added.length === 0) return
  added.forEach((id) => current.add(id))
  pausedTerminalSyncIds.value = [...current]
  if (!notify) return
  showToast(
    'warning',
    added.length > 1 ? '部分终端同步已暂停' : '终端同步已暂停',
    message
  )
}

function resumeTerminalSyncTarget(terminalId: string) {
  if (!pausedTerminalSyncIdSet.value.has(terminalId)) return
  pausedTerminalSyncIds.value = pausedTerminalSyncIds.value.filter((id) => id !== terminalId)
}

function syncTerminalInputToTargets(event: TerminalInputEvent) {
  if (event.terminalId !== activeTerminalId.value) return
  if (!multiTerminalInputEnabled.value) return
  if (!targetTerminalIds.value.includes(event.terminalId)) return
  const targetIds = targetTerminalIds.value.filter((terminalId) => terminalId !== event.terminalId)

  if (event.data === '\x03') {
    const rejected: string[] = []
    const interruptTargetIds = targetIds.filter((terminalId) => !pausedTerminalSyncIdSet.value.has(terminalId))
    interruptTargetIds.forEach((terminalId) => {
      if (!terminalRefs.value[terminalId]?.writeSyncedTerminalInput(event.data, event.terminalId)) {
        rejected.push(terminalId)
      }
    })
    pauseTerminalSyncTargets(rejected, '部分终端无法接收中断输入；已停止继续向这些终端同步。')
    return
  }

  if (event.data === '\t') {
    if (
      event.beforeState.available &&
      event.beforeState.context === 'shell' &&
      event.beforeState.reliable
    ) {
      const rejected: string[] = []
      targetIds.forEach((terminalId) => {
        const pane = terminalRefs.value[terminalId]
        const targetState = pane?.terminalInputSyncState()
        if (!pane || !targetState || !terminalInputSyncStatesMatch(event.beforeState, targetState)) return
        resumeTerminalSyncTarget(terminalId)
        if (!pane.writeSyncedTerminalInput(event.data, event.terminalId)) rejected.push(terminalId)
      })
      pauseTerminalSyncTargets(rejected, '部分 Shell 无法接收补全按键；已暂停向这些终端同步。')
    }
    return
  }

  if (!event.safeToSync) {
    pauseTerminalSyncTargets(
      targetIds,
      '当前按键依赖各终端自己的历史、补全或交互状态，未广播到其他终端。回到空提示符后会自动恢复。'
    )
    return
  }

  const sourceAtEmptyPrompt = terminalInputStateIsEmptyPrompt(event.beforeState)
  const alignedTargets: Array<{ terminalId: string; pane: TerminalPaneInstance }> = []
  const mismatched: string[] = []
  targetIds.forEach((terminalId) => {
    const pane = terminalRefs.value[terminalId]
    const targetState = pane?.terminalInputSyncState()
    if (!pane || !targetState || !terminalInputSyncStatesMatch(event.beforeState, targetState)) {
      if (!pausedTerminalSyncIdSet.value.has(terminalId)) mismatched.push(terminalId)
      return
    }
    if (pausedTerminalSyncIdSet.value.has(terminalId)) {
      if (!sourceAtEmptyPrompt || !terminalInputStateIsEmptyPrompt(targetState)) return
      resumeTerminalSyncTarget(terminalId)
    }
    alignedTargets.push({ terminalId, pane })
  })

  pauseTerminalSyncTargets(
    mismatched,
    '各终端的命令行、光标或提示符状态不一致；已暂停失配终端，回到空提示符后会自动恢复。'
  )

  const rejected: string[] = []
  alignedTargets.forEach(({ terminalId, pane }) => {
    if (!pane.writeSyncedTerminalInput(event.data, event.terminalId)) rejected.push(terminalId)
  })
  pauseTerminalSyncTargets(rejected, '部分终端未能接收输入；已停止继续向这些终端同步。')
}

function handleTerminalInputWriteFailure(event: TerminalInputWriteFailureEvent) {
  const terminalTitle = terminalTabs.value.find((tab) => tab.id === event.terminalId)?.title ?? '目标终端'
  let syncDetail = ''
  if (targetTerminalIds.value.includes(event.terminalId)) {
    if (event.terminalId === activeTerminalId.value) {
      const otherTargetIds = targetTerminalIds.value.filter((id) => id !== event.terminalId)
      pauseTerminalSyncTargets(
        otherTargetIds,
        '当前终端输入失败，多终端键盘同步已暂停。',
        false
      )
      if (otherTargetIds.length > 0) syncDetail = ' 其他选中终端的键盘同步已暂停。'
    } else {
      pauseTerminalSyncTargets([event.terminalId], terminalTitle + ' 输入失败，已暂停向该终端同步。', false)
      syncDetail = ' 已暂停向该终端同步。'
    }
  }
  showToast(
    'error',
    '终端输入写入失败',
    terminalTitle + ' 的输入队列已停止，请重新连接后再试。' + syncDetail + (event.message ? ' ' + event.message : '')
  )
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
function appendAiMessageToActiveTerminal(message: AiMessage) {
  const key = message.workspaceSessionId
  aiMessagesBySession.value = {
    ...aiMessagesBySession.value,
    [key]: [...(aiMessagesBySession.value[key] ?? []), message].slice(-300)
  }
  if (message.streaming) return
  void persistWorkspaceSessionForMessage(message)
    .then(() => saveAiConversationMessage(message))
    .catch((error) => {
      console.error('failed to save AI conversation message', error)
    })
}

function updateAiMessage(message: AiMessage) {
  const key = message.workspaceSessionId
  const messages = aiMessagesBySession.value[key] ?? []
  aiMessagesBySession.value = {
    ...aiMessagesBySession.value,
    [key]: messages.map((item) => (item.id === message.id ? message : item))
  }
  if (message.streaming) return
  void persistWorkspaceSessionForMessage(message)
    .then(() => saveAiConversationMessage(message))
    .catch((error) => {
      console.error('failed to save AI conversation message', error)
    })
}

function setAiContextForTerminal(_connectionId: string, workspaceSessionId: string, status: AiContextStatus) {
  const key = workspaceSessionId
  aiContextBySession.value = {
    ...aiContextBySession.value,
    [key]: status
  }
}

async function persistWorkspaceSessionForMessage(message: AiMessage) {
  const title = message.role === 'user' ? workspaceSessionTitleFromText(message.text) : undefined
  const session = await ensurePersistedWorkspaceSession(message.connectionId, message.workspaceSessionId, title)
  const updated = { ...session, updatedAt: message.createdAt || nowText() }
  upsertWorkspaceSession(updated)
  await saveWorkspaceSession(updated)
}

function workspaceSessionTitleFromText(text: string) {
  const titleLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('选中终端内容'))
  return shortenWorkspaceSessionTitle(titleLine || text, '当前会话')
}

function shortenWorkspaceSessionTitle(value: string, fallback: string) {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return fallback
  return normalized.length > 60 ? `${normalized.slice(0, 57)}...` : normalized
}

async function loadWorkspaceSessionList() {
  if (workspaceSessionListLoaded.value) return
  if (workspaceSessionListLoadPromise) return workspaceSessionListLoadPromise
  workspaceSessionListLoadPromise = (async () => {
    try {
      const sessions = await listWorkspaceSessions()
      const drafts = workspaceSessions.value.filter((session) => isDraftWorkspaceSession(session.id))
      sessions.forEach((session) => {
        if (!isDraftWorkspaceSession(session.id)) return
        clearDraftWorkspaceSession(session.id)
        delete loadedAiSessions.value[session.id]
      })
      workspaceSessions.value = [
        ...drafts.filter((draft) => !sessions.some((session) => session.id === draft.id)),
        ...sessions
      ]
      workspaceSessionListLoaded.value = true
      if (activeAiSessionId.value) void loadAiSessionState(activeAiSessionId.value)
    } catch (error) {
      console.error('failed to load global AI sessions', error)
    }
  })()
  try {
    await workspaceSessionListLoadPromise
  } finally {
    workspaceSessionListLoadPromise = null
  }
}

async function loadCommandHistoryForConnection(connectionId: string) {
  if (loadedCommandHistoryConnections.value[connectionId]) return
  loadedCommandHistoryConnections.value = {
    ...loadedCommandHistoryConnections.value,
    [connectionId]: true
  }
  try {
    const commands = await listCommandHistory(connectionId)
    const localCommands = commandHistoryByConnection.value[connectionId] ?? []
    const persistedIds = new Set(commands.map((entry) => entry.id))
    commandHistoryByConnection.value = {
      ...commandHistoryByConnection.value,
      [connectionId]: [...commands, ...localCommands.filter((entry) => !persistedIds.has(entry.id))].slice(-COMMAND_HISTORY_CACHE_LIMIT)
    }
  } catch (error) {
    const nextLoaded = { ...loadedCommandHistoryConnections.value }
    delete nextLoaded[connectionId]
    loadedCommandHistoryConnections.value = nextLoaded
    console.error('failed to load connection command history', error)
  }
}

async function loadAiSessionState(workspaceSessionId: string) {
  if (!workspaceSessionId || loadedAiSessions.value[workspaceSessionId]) return
  loadedAiSessions.value = {
    ...loadedAiSessions.value,
    [workspaceSessionId]: true
  }
  if (isDraftWorkspaceSession(workspaceSessionId)) {
    aiMessagesBySession.value = {
      ...aiMessagesBySession.value,
      [workspaceSessionId]: aiMessagesBySession.value[workspaceSessionId] ?? []
    }
    return
  }
  try {
    const messages = await listAiConversationMessages(workspaceSessionId)
    const localMessages = aiMessagesBySession.value[workspaceSessionId] ?? []
    const persistedIds = new Set(messages.map((message) => message.id))
    aiMessagesBySession.value = {
      ...aiMessagesBySession.value,
      [workspaceSessionId]: [...messages, ...localMessages.filter((message) => !persistedIds.has(message.id))].slice(-300)
    }
  } catch (error) {
    const nextLoaded = { ...loadedAiSessions.value }
    delete nextLoaded[workspaceSessionId]
    loadedAiSessions.value = nextLoaded
    console.error('failed to load AI conversation', error)
  }
}

const selectableTextSelector = [
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '.terminal-body',
  '.xterm-host',
  'pre',
  'code',
  '.message-body',
  '.script-risk-preview',
  '.script-code-overlay',
  '.script-preview-code'
].join(',')

function targetElement(target: EventTarget | null) {
  return target instanceof Element ? target : null
}

function isSelectableTextTarget(target: EventTarget | null) {
  return Boolean(targetElement(target)?.closest(selectableTextSelector))
}

function selectionEndpointElement(node: Node | null) {
  return node instanceof Element ? node : node?.parentElement ?? null
}

function clearChromeSelection(target?: EventTarget | null) {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed) return
  const anchorElement = selectionEndpointElement(selection.anchorNode)
  const focusElement = selectionEndpointElement(selection.focusNode)
  if (
    isSelectableTextTarget(target ?? null) ||
    anchorElement?.closest(selectableTextSelector) ||
    focusElement?.closest(selectableTextSelector)
  ) {
    return
  }
  selection.removeAllRanges()
}

function handleAppSelectStart(event: Event) {
  const element = targetElement(event.target)
  if (!element?.closest('.app-shell')) return
  if (isSelectableTextTarget(element)) return
  event.preventDefault()
  clearChromeSelection()
}

function handleAppDragStart(event: DragEvent) {
  const element = targetElement(event.target)
  if (!element?.closest('.app-shell')) return
  if (isSelectableTextTarget(element)) return
  event.preventDefault()
}

function handleGlobalClick(event: MouseEvent) {
  closeContextMenu()
  clearChromeSelection(event.target)
}

function handleGlobalKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    closeContextMenu()
    closeAboutPage()
  }
}

onMounted(() => {
  void loadProfiles()
  void loadAiConfig()
  void ensureActiveAiSession(LOCAL_CONNECTION_ID)
  void loadCommandHistoryForConnection(LOCAL_CONNECTION_ID)
  window.addEventListener('click', handleGlobalClick)
  window.addEventListener('keydown', handleGlobalKeydown)
  themeToggleButton.value?.addEventListener('pointerdown', handleThemeTogglePointerDown, true)
  themeToggleButton.value?.addEventListener('mousedown', handleThemeTogglePointerDown, true)
  themeToggleButton.value?.addEventListener('click', handleThemeTogglePointerDown, true)
  document.addEventListener('selectstart', handleAppSelectStart, true)
  document.addEventListener('dragstart', handleAppDragStart, true)
  void nextTick(() => {
    updateSessionTabScrollMetrics()
    if (typeof ResizeObserver !== 'undefined' && sessionTabStrip.value) {
      sessionTabResizeObserver = new ResizeObserver(updateSessionTabScrollMetrics)
      sessionTabResizeObserver.observe(sessionTabStrip.value)
    }
  })
  window.addEventListener('resize', updateSessionTabScrollMetrics)
})

watch(activeConnectionId, (connectionId) => {
  void loadCommandHistoryForConnection(connectionId)
})

watch(activeAiSessionId, (sessionId) => {
  void loadAiSessionState(sessionId)
})

watch(
  () => [activeTerminalId.value, terminalTabs.value.length],
  scrollActiveTerminalTabIntoView
)

watch(
  () => [leftCollapsed.value, rightCollapsed.value],
  () => void nextTick(updateSessionTabScrollMetrics)
)

watch(appSettings, (settings) => {
  persistUserSettings(settings)
})
watch(appTheme, (theme) => persistAppTheme(theme), { immediate: true })
onBeforeUnmount(() => {
  endWorkspaceResize()
  window.removeEventListener('click', handleGlobalClick)
  window.removeEventListener('keydown', handleGlobalKeydown)
  themeToggleButton.value?.removeEventListener('pointerdown', handleThemeTogglePointerDown, true)
  themeToggleButton.value?.removeEventListener('mousedown', handleThemeTogglePointerDown, true)
  themeToggleButton.value?.removeEventListener('click', handleThemeTogglePointerDown, true)
  document.removeEventListener('selectstart', handleAppSelectStart, true)
  document.removeEventListener('dragstart', handleAppDragStart, true)
  window.removeEventListener('resize', updateSessionTabScrollMetrics)
  sessionTabResizeObserver?.disconnect()
  sessionTabResizeObserver = null
})
</script>

<template>
  <div class="app-shell" :class="{ 'left-collapsed': leftCollapsed, 'right-collapsed': rightCollapsed, 'sftp-workbench-active': sftpWorkbenchActive, 'workspace-is-resizing': workspaceResizing, 'theme-light': appTheme === 'light', 'theme-dark': appTheme === 'dark' }" :style="workspaceLayoutStyle">
    <header class="titlebar">
      <div class="brand">
        <img class="brand-mark" src="/icon.svg" alt="" aria-hidden="true" />
        <span>AI Term</span>
      </div>
      <nav class="session-tabs" aria-label="终端会话">
        <div class="session-tab-scrollarea">
          <div ref="sessionTabStrip" class="session-tab-strip" @scroll="handleSessionTabScroll" @wheel="handleSessionTabWheel">
            <button
              v-for="tab in terminalTabs"
              :key="tab.id"
              :ref="(element) => setSessionTabButton(tab.id, element)"
              class="tab"
              :class="{ active: tab.id === activeTerminalId, target: isTerminalTargetSelected(tab.id), 'sync-paused': isTerminalSyncPaused(tab.id) }"
              @click="selectTerminalTab(tab.id)"
              @contextmenu.prevent.stop="openTerminalTabContextMenu($event, tab)"
            >
              <span
                class="terminal-target-toggle"
                :class="{ selected: isTerminalTargetSelected(tab.id) }"
                :title="terminalTargetToggleTitle(tab.id)"
                aria-hidden="true"
                @click.stop="toggleTerminalTarget(tab.id)"
              >
                <span />
              </span>
              <span class="status-dot" :class="terminalStatusClass(tab.status)" />
              <span class="tab-title">{{ tab.title }}</span>
              <span v-if="terminalTabs.length > 1" class="tab-close" title="关闭终端" aria-label="关闭终端" @click.stop="closeTerminalTab(tab.id)"><UiIcon name="close" size="12" /></span>
            </button>
          </div>
          <div v-if="sessionTabOverflow" class="session-tab-scrollbar" aria-hidden="true" @pointerdown="handleSessionTabScrollbarPointerDown">
            <span class="session-tab-scrollbar-thumb" :style="sessionTabThumbStyle" @pointerdown.stop="handleSessionTabThumbPointerDown" />
          </div>
        </div>
        <div class="session-tab-actions">
          <button class="icon-button" type="button" title="新建本地终端" aria-label="新建本地终端" @click="openLocalTerminal"><UiIcon name="plus" /></button>
          <span class="terminal-target-summary" :class="{ active: multiTerminalInputEnabled }" :title="terminalTargetTitle">
            <UiIcon name="terminal" size="13" />
            <span>{{ terminalTargetLabel }}</span>
          </span>
        </div>
      </nav>
    </header>
    <aside class="app-rail" aria-label="主导航">
      <button
        class="rail-button"
        :class="{ active: isLeftPanelActive('connections') }"
        :title="leftPanelButtonTitle('connections')"
        :aria-label="leftPanelButtonTitle('connections')"
        @click="toggleConnectionsPanel"
      >
        <UiIcon name="terminal" />
      </button>
      <button
        class="rail-button"
        :class="{ active: isLeftPanelActive('settings') }"
        :title="leftPanelButtonTitle('settings')"
        :aria-label="leftPanelButtonTitle('settings')"
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
    <ConnectionSidebar
      v-if="leftPanelMode === 'connections'"
      :profiles="profiles"
      :selected-profile-id="selectedProfileId"
      :selected-profile="sidebarProfile"
      :connecting-profile-id="connectingProfileId"
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
      @select-ai-config="selectAiConfig"
      @create-ai-config="createAiConfig"
      @edit-ai-config="editAiConfig"
      @delete-ai-config="deleteSelectedAiConfig"
      @open-menu="openAiConfigContextMenu"
      @close-ai-config="closeAiConfigEditor"
      @save-ai-config="saveAiConfig"
      @update-settings="updateUserSettings"
    />
    <section class="terminal-stack" @contextmenu.prevent="openTerminalAreaContextMenu">
      <TerminalPane
        v-for="tab in terminalTabs"
        v-show="tab.id === activeTerminalId"
        :key="tab.id"
        :ref="(instance) => setTerminalRef(tab.id, instance as TerminalPaneInstance | null)"
        :terminal-id="tab.id"
        :active="tab.id === activeTerminalId"
        :profile="tab.profile"
        :connect-request="tab.connectRequest"
        :command-history="commandHistoryForTab(tab)"
        :terminal-settings="appSettings"
        :app-theme="appTheme"
        :ai-config="aiConfig"
        :api-key="activeAiRuntimeApiKey"
        @terminal-output="updateTerminalOutput"
        @terminal-selection="updateTerminalSelection"
        @terminal-input="syncTerminalInputToTargets"
        @terminal-input-write-failed="handleTerminalInputWriteFailure"
        @command-recorded="recordCommand"
        @status-changed="updateTerminalStatus"
        @profile-updated="refreshConnectionProfilesAfterTerminalAuth"
      />
    </section>
    <div
      v-if="!rightCollapsed && !sftpWorkbenchActive"
      class="workspace-resizer"
      role="separator"
      tabindex="0"
      aria-label="调整工作区宽度"
      aria-orientation="vertical"
      :aria-valuenow="workspaceWidth"
      aria-valuemin="360"
      aria-valuemax="560"
      @pointerdown="beginWorkspaceResize"
      @keydown="handleWorkspaceResizeKeydown"
    />
    <WorkspacePanel
      :collapsed="rightCollapsed"
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
      @close="rightCollapsed = true"
      @select-workspace-session="selectWorkspaceSession"
      @create-workspace-session="createWorkspaceSessionForActiveConnection"
      @rename-workspace-session="renameWorkspaceSession"
      @delete-workspace-session="deleteWorkspaceSessionForActiveConnection"
      @update-workspace-session-title="updateWorkspaceSessionTitle"
      @update-workspace-session-context-summary="updateWorkspaceSessionContextSummary"
      @append-ai-message="appendAiMessageToActiveTerminal"
      @update-ai-message="updateAiMessage"
      @set-ai-context-status="setAiContextForTerminal"
      @rerun-command="rerunCommandOnActiveTerminal"
      @execute-command="executeCommandOnTargetTerminals"
      @ai-error="showToast('error', 'AI 请求失败', $event)"
      @write-terminal-input="writeInputToTargetTerminals"
      @focus-terminal="focusActiveTerminalFromWorkspace"
      @start-script-recording="startScriptRecording"
      @stop-script-recording="stopScriptRecording"
      @clear-script-recording="clearScriptRecording"
      @workspace-tab-changed="workspacePanelTab = $event"
    />
    <button
      v-if="rightCollapsed"
      class="workspace-open-handle"
      type="button"
      title="打开工作区"
      aria-label="打开工作区"
      @click="rightCollapsed = false"
    >
      <UiIcon name="arrow-left" size="15" />
    </button>
    <div v-if="aboutOpen" class="modal-backdrop about-backdrop" role="presentation" @click.self="closeAboutPage">
      <section class="modal about-modal" role="dialog" aria-modal="true" aria-labelledby="about-title" aria-describedby="about-summary">
        <div class="modal-head about-head">
          <div>
            <strong id="about-title">关于 AI Term</strong>
            <span>v{{ APP_VERSION }} · {{ APP_CHANNEL }} · {{ APP_LICENSE }}</span>
          </div>
          <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="closeAboutPage"><UiIcon name="close" /></button>
        </div>
        <div class="about-body">
          <section class="about-hero">
            <div class="about-copy">
              <span class="about-kicker">AI TERM / SECURE OPS</span>
              <h2>AI Term</h2>
              <p id="about-summary">面向服务器操作的 AI 终端工作台。</p>
              <div class="about-version-strip" aria-label="版本信息">
                <span>v{{ APP_VERSION }}</span>
                <span>{{ APP_CHANNEL }}</span>
                <span>{{ APP_LICENSE }}</span>
              </div>
              <div class="about-source" aria-label="作者">
                <span>Author {{ APP_AUTHOR }}</span>
              </div>
            </div>
            <div class="about-visual" aria-hidden="true">
              <div class="about-visual-top">
                <span />
                <span />
                <span />
              </div>
              <div class="about-scan-grid">
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
              </div>
              <div class="about-terminal-lines">
                <span>$ ai-term boot --workspace</span>
                <span>ssh route ........... online</span>
                <span>sftp mesh ........... ready</span>
                <span>script guard ........ armed</span>
              </div>
            </div>
          </section>
          <section class="about-runtime" aria-label="运行信息">
            <article v-for="item in aboutRuntimeStats" :key="item.label">
              <span>{{ item.label }}</span>
              <strong>{{ item.value }}</strong>
            </article>
          </section>
          <section class="about-signal-grid" aria-label="能力矩阵">
            <article v-for="item in aboutSignals" :key="item.label" class="about-signal">
              <span class="about-signal-icon"><UiIcon :name="item.icon" /></span>
              <div>
                <strong>{{ item.label }}</strong>
                <small>{{ item.value }}</small>
              </div>
            </article>
          </section>
          <section class="about-command-panel" aria-label="运行摘要">
            <div class="about-command-head">
              <span>runtime://summary</span>
              <strong>ready</strong>
            </div>
            <div class="about-build-grid">
              <article>
                <span>Version</span>
                <strong>{{ APP_VERSION }}</strong>
              </article>
              <article>
                <span>Channel</span>
                <strong>{{ APP_CHANNEL }}</strong>
              </article>
              <article>
                <span>Theme</span>
                <strong>{{ appTheme }}</strong>
              </article>
              <article>
                <span>Workspace</span>
                <strong>{{ rightCollapsed ? 'compact' : workspacePanelTab }}</strong>
              </article>
            </div>
          </section>
        </div>
        <div class="modal-actions about-actions">
          <button type="button" @click="copyAboutInfo">
            <UiIcon name="copy" size="14" />
            <span>复制信息</span>
          </button>
          <button class="primary" type="button" @click="closeAboutPage">完成</button>
        </div>
      </section>
    </div>
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
      :x="contextMenu.x"
      :y="contextMenu.y"
      :title="contextMenu.title"
      :items="contextMenu.items"
      @close="closeContextMenu"
    />
  </div>
</template>
