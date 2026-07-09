<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { AiProviderConfig, ConnectionProfile } from '../types/profile'

type TerminalRuntimeStatus = 'idle' | 'connecting' | 'local' | 'remote' | 'sftp' | 'preview' | 'error'
import type {
  AiContextStatus,
  AiMessage,
  CommandHistoryEntry,
  CommandRecordedEvent,
  ScriptRecording,
  TerminalInputEvent,
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
  workspaceSessionId: string
  profile?: ConnectionProfile
  connectRequest: number
  status: TerminalRuntimeStatus
}

const COMMAND_HISTORY_CACHE_LIMIT = 300
const USER_SETTINGS_STORAGE_KEY = 'ai-term:user-settings:v1'
const APP_THEME_STORAGE_KEY = 'ai-term:app-theme:v1'
const defaultUserSettings: AppUserSettings = {
  terminalFontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  terminalFontSize: 13,
  terminalTheme: 'midnight',
  defaultShell: 'system'
}
type TerminalPaneInstance = InstanceType<typeof TerminalPane> & {
  executeCommand: (command: string) => boolean
  writeTerminalInput: (data: string) => boolean
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
const LOCAL_DEFAULT_SESSION_ID = 'local:default'

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
const leftPanelMode = ref<LeftPanelMode>('connections')
const leftCollapsed = ref(false)
const rightCollapsed = ref(false)
const workspacePanelTab = ref<'history' | 'ai' | 'scripts' | 'sftp'>('ai')
const terminalTabs = ref<TerminalTab[]>([
  {
    id: 'local-1',
    title: '本地终端',
    connectionId: LOCAL_CONNECTION_ID,
    workspaceSessionId: LOCAL_DEFAULT_SESSION_ID,
    profile: undefined,
    connectRequest: 0,
    status: 'idle'
  }
])
const activeTerminalId = ref('local-1')
const selectedTerminalIds = ref<string[]>(['local-1'])
const terminalRefs = ref<Record<string, TerminalPaneInstance | null>>({})
const terminalSnapshots = ref<Record<string, string>>({})
const terminalOutputEvents = ref<Record<string, TerminalOutputDeltaEvent>>({})
const terminalSelections = ref<Record<string, TerminalSelectionEvent>>({})
const workspaceSessionsByConnection = ref<Record<string, WorkspaceSession[]>>({})
const draftWorkspaceSessionIds = ref<Record<string, boolean>>({})
const commandHistoryBySession = ref<Record<string, CommandHistoryEntry[]>>({})
const aiMessagesBySession = ref<Record<string, AiMessage[]>>({})
const aiContextBySession = ref<Record<string, AiContextStatus>>({})
const scriptRecordingsByTerminal = ref<Record<string, ScriptRecording>>({})
const loadedWorkspaceSessions = ref<Record<string, boolean>>({})
const loadedSessionLists = ref<Record<string, boolean>>({})
const contextMenu = ref<ContextMenuState | null>(null)
const appSettings = ref<AppUserSettings>(loadUserSettings())
const appTheme = ref<AppTheme>(loadAppTheme())
const themeToggleButton = ref<HTMLButtonElement | null>(null)
const toasts = ref<AppToast[]>([])
let lastThemeToggleAt = 0
let toastSequence = 0
let terminalOutputSequence = 0
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

const targetTerminalTabs = computed(() => {
  const selected = terminalTabs.value.filter((tab) => selectedTerminalIdSet.value.has(tab.id))
  if (selected.length > 0) return selected
  return activeTerminal.value ? [activeTerminal.value] : []
})

const targetTerminalIds = computed(() => targetTerminalTabs.value.map((tab) => tab.id))
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
const activeWorkspaceSessionId = computed(() => activeTerminal.value?.workspaceSessionId ?? LOCAL_DEFAULT_SESSION_ID)
const activeWorkspaceKey = computed(() => workspaceKey(activeConnectionId.value, activeWorkspaceSessionId.value))

const activeCommandHistory = computed(() => {
  return commandHistoryBySession.value[activeWorkspaceKey.value] ?? []
})

function commandHistoryForTab(tab: TerminalTab) {
  const currentKey = workspaceKey(tab.connectionId, tab.workspaceSessionId)
  const current = commandHistoryBySession.value[currentKey] ?? []
  const sameConnection = Object.entries(commandHistoryBySession.value)
    .filter(([key]) => key !== currentKey && key.startsWith(`${tab.connectionId}:`))
    .flatMap(([, commands]) => commands)
  return [...current, ...sameConnection]
}
const activeAiMessages = computed(() => {
  return aiMessagesBySession.value[activeWorkspaceKey.value] ?? []
})

const activeAiContextStatus = computed(() => {
  return aiContextBySession.value[activeWorkspaceKey.value]
})

const activeScriptRecording = computed(() => {
  return scriptRecordingsByTerminal.value[activeTerminalId.value] ?? createIdleScriptRecording(activeTerminalId.value)
})

const activeWorkspaceSessions = computed(() => {
  return workspaceSessionsByConnection.value[activeConnectionId.value] ?? []
})

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
    const session = await preferredWorkspaceSessionForConnection(profile.id)
    createTerminalTab(profile, session)
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
  const session = await preferredWorkspaceSessionForConnection(LOCAL_CONNECTION_ID)
  createTerminalTab(undefined, session)
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
  selectedTerminalIds.value = normalizedTerminalTargetIds(ids, requiredId)
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

function isTerminalTargetSelected(tabId: string) {
  return selectedTerminalIdSet.value.has(tabId)
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
  setTerminalTargets(terminalTabs.value.map((tab) => tab.id))
}

function resetTerminalTargetsToActive() {
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
    return {
      ...defaultUserSettings,
      ...parsed,
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

function workspaceKey(connectionId: string, sessionId: string) {
  return `${connectionId}::${sessionId}`
}

function defaultWorkspaceSessionId(connectionId: string) {
  return `${connectionId}:default`
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

function workspaceSessionsForConnection(connectionId: string) {
  return workspaceSessionsByConnection.value[connectionId] ?? []
}

function upsertWorkspaceSession(session: WorkspaceSession) {
  const sessions = workspaceSessionsForConnection(session.connectionId)
  workspaceSessionsByConnection.value = {
    ...workspaceSessionsByConnection.value,
    [session.connectionId]: [session, ...sessions.filter((item) => item.id !== session.id)]
  }
}

function replaceWorkspaceSession(session: WorkspaceSession) {
  const sessions = workspaceSessionsForConnection(session.connectionId)
  workspaceSessionsByConnection.value = {
    ...workspaceSessionsByConnection.value,
    [session.connectionId]: sessions.map((item) => (item.id === session.id ? session : item))
  }
}

function createDraftWorkspaceSession(connectionId: string, sessionId?: string, name = 'Untitled') {
  const existing = sessionId ? workspaceSessionsForConnection(connectionId).find((item) => item.id === sessionId) : undefined
  if (existing) {
    markDraftWorkspaceSession(existing.id)
    return existing
  }
  const session = newWorkspaceSession(connectionId, name, sessionId)
  markDraftWorkspaceSession(session.id)
  upsertWorkspaceSession(session)
  return session
}

async function ensureWorkspaceSession(connectionId: string, sessionId = defaultWorkspaceSessionId(connectionId), name = 'Untitled') {
  await loadWorkspaceSessionList(connectionId)
  return workspaceSessionsForConnection(connectionId).find((item) => item.id === sessionId) ?? createDraftWorkspaceSession(connectionId, sessionId, name)
}

async function preferredWorkspaceSessionForConnection(connectionId: string, name = 'Untitled') {
  await loadWorkspaceSessionList(connectionId)
  return workspaceSessionsForConnection(connectionId).find((session) => !isDraftWorkspaceSession(session.id)) ?? createDraftWorkspaceSession(connectionId, defaultWorkspaceSessionId(connectionId), name)
}

async function createWorkspaceSession(connectionId = activeConnectionId.value, name?: string) {
  await loadWorkspaceSessionList(connectionId)
  return createDraftWorkspaceSession(connectionId, undefined, name)
}

async function ensurePersistedWorkspaceSession(connectionId: string, sessionId = defaultWorkspaceSessionId(connectionId), title?: string) {
  await loadWorkspaceSessionList(connectionId)
  let session = workspaceSessionsForConnection(connectionId).find((item) => item.id === sessionId)
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
  const sessions = workspaceSessionsForConnection(activeConnectionId.value)
  const session = sessions.find((item) => item.id === sessionId)
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
  const session = workspaceSessionsForConnection(connectionId).find((item) => item.id === sessionId)
  if (!session || !isAutoWorkspaceSessionName(session.name)) return
  const nextTitle = title.trim()
  if (!nextTitle) return
  const updated = { ...session, name: nextTitle, updatedAt: nowText() }
  replaceWorkspaceSession(updated)
  try {
    await ensurePersistedWorkspaceSession(connectionId, sessionId, nextTitle)
  } catch (error) {
    console.error('failed to update AI generated session title', error)
  }
}

function isAutoWorkspaceSessionName(name: string) {
  return ['untitled', '无标题', '默认会话', '本地默认会话', '当前会话'].includes(name.trim().toLowerCase())
}

async function deleteWorkspaceSessionForActiveConnection(sessionId: string) {
  const sessions = workspaceSessionsForConnection(activeConnectionId.value)
  if (sessions.length <= 1) {
    window.alert('至少保留一个会话')
    return
  }
  const session = sessions.find((item) => item.id === sessionId)
  if (!session) return
  if (!window.confirm(`删除会话 ${session.name}？对应命令历史和 AI 对话也会删除。`)) return
  try {
    if (!isDraftWorkspaceSession(sessionId)) {
      await deleteWorkspaceSession(sessionId)
    }
    clearDraftWorkspaceSession(sessionId)
    const remaining = sessions.filter((item) => item.id !== sessionId)
    workspaceSessionsByConnection.value = {
      ...workspaceSessionsByConnection.value,
      [activeConnectionId.value]: remaining
    }
    delete commandHistoryBySession.value[workspaceKey(activeConnectionId.value, sessionId)]
    delete aiMessagesBySession.value[workspaceKey(activeConnectionId.value, sessionId)]
    delete aiContextBySession.value[workspaceKey(activeConnectionId.value, sessionId)]
    if (activeWorkspaceSessionId.value === sessionId) {
      selectWorkspaceSession(remaining[0].id)
    }
  } catch (error) {
    connectionError.value = formatError(error)
  }
}

function selectWorkspaceSession(sessionId: string) {
  const activeId = activeTerminalId.value
  terminalTabs.value = terminalTabs.value.map((tab) => (tab.id === activeId ? { ...tab, workspaceSessionId: sessionId } : tab))
  void loadWorkspaceState(activeConnectionId.value, sessionId)
}

function createTerminalTab(profile?: ConnectionProfile, workspaceSession?: WorkspaceSession) {
  const id = `terminal-${Date.now()}-${terminalTabs.value.length + 1}`
  const title = profile ? `${profile.target.username || 'user'}@${profile.target.host || profile.name}` : '本地终端'
  const connectionId = profile?.id ?? LOCAL_CONNECTION_ID
  const session = workspaceSession ?? createDraftWorkspaceSession(connectionId, defaultWorkspaceSessionId(connectionId), 'Untitled')
  terminalTabs.value.push({
    id,
    title,
    connectionId,
    workspaceSessionId: session.id,
    profile: profile ? cloneConnectionProfile(profile) : undefined,
    connectRequest: 1,
    status: 'idle'
  })
  activeTerminalId.value = id
  setTerminalTargets([id], id)
  void loadWorkspaceSessionList(connectionId)
  void loadWorkspaceState(connectionId, session.id)
}

function closeTerminalTab(tabId: string) {
  if (terminalTabs.value.length === 1) return
  const index = terminalTabs.value.findIndex((tab) => tab.id === tabId)
  terminalTabs.value = terminalTabs.value.filter((tab) => tab.id !== tabId)
  delete terminalSnapshots.value[tabId]
  delete terminalOutputEvents.value[tabId]
  delete terminalSelections.value[tabId]
  delete terminalRefs.value[tabId]
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
  terminalTabs.value = terminalTabs.value.map((tab) => (tab.id === terminalId ? { ...tab, status } : tab))
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
  const workspaceSessionId = tab?.workspaceSessionId ?? defaultWorkspaceSessionId(connectionId)
  const key = workspaceKey(connectionId, workspaceSessionId)
  const nextIndex = (commandHistoryBySession.value[key]?.length ?? 0) + 1
  const entry: CommandHistoryEntry = {
    id: `${workspaceSessionId}-${event.terminalId}-${Date.now()}-${nextIndex}`,
    connectionId,
    workspaceSessionId,
    terminalId: event.terminalId,
    command: event.command,
    createdAt: new Date().toLocaleString()
  }
  commandHistoryBySession.value = {
    ...commandHistoryBySession.value,
    [key]: [...(commandHistoryBySession.value[key] ?? []), entry].slice(-COMMAND_HISTORY_CACHE_LIMIT)
  }
  appendRecordingCommand(event.terminalId, event.command)
  void saveCommandHistoryForTerminal(entry).catch((error) => {
    console.error('failed to save command history', error)
  })
}

async function saveCommandHistoryForTerminal(entry: CommandHistoryEntry) {
  await ensurePersistedWorkspaceSession(entry.connectionId, entry.workspaceSessionId, workspaceSessionTitleFromCommand(entry.command))
  await saveCommandHistoryRecord(entry)
}

function createIdleScriptRecording(terminalId: string): ScriptRecording {
  return {
    terminalId,
    connectionId: activeConnectionId.value,
    workspaceSessionId: activeWorkspaceSessionId.value,
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
      workspaceSessionId: activeWorkspaceSessionId.value,
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

function executeCommandOnTargetTerminals(command: string) {
  const targets = targetTerminalIds.value
  let sentCount = 0
  targets.forEach((terminalId) => {
    if (terminalRefs.value[terminalId]?.executeCommand(command)) sentCount += 1
  })
  if (sentCount > 0) {
    showToast('success', sentCount > 1 ? `命令已发送到 ${sentCount} 个终端` : '命令已发送', commandPreview(command))
  } else {
    showToast('error', '命令未发送', '目标终端不可用或没有活动 shell。')
  }
}

function writeInputToTargetTerminals(data: string) {
  if (!data) return
  if (isActiveTerminalOnlyInput(data)) {
    writeInputToActiveTerminal(data)
    return
  }
  let sentCount = 0
  targetTerminalIds.value.forEach((terminalId) => {
    if (terminalRefs.value[terminalId]?.writeTerminalInput(data)) sentCount += 1
  })
  if (sentCount === 0) {
    showToast('error', '脚本未发送', '目标终端不可用或没有活动 shell。')
  }
}

function syncTerminalInputToTargets(event: TerminalInputEvent) {
  if (!multiTerminalInputEnabled.value) return
  if (!targetTerminalIds.value.includes(event.terminalId)) return
  targetTerminalIds.value.forEach((terminalId) => {
    if (terminalId === event.terminalId) return
    terminalRefs.value[terminalId]?.writeTerminalInput(event.data)
  })
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
  const key = workspaceKey(message.connectionId, message.workspaceSessionId)
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
  const key = workspaceKey(message.connectionId, message.workspaceSessionId)
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

function setAiContextForTerminal(connectionId: string, workspaceSessionId: string, status: AiContextStatus) {
  const key = workspaceKey(connectionId, workspaceSessionId)
  aiContextBySession.value = {
    ...aiContextBySession.value,
    [key]: status
  }
}

async function persistWorkspaceSessionForMessage(message: AiMessage) {
  const title = message.role === 'user' ? workspaceSessionTitleFromText(message.text) : undefined
  await ensurePersistedWorkspaceSession(message.connectionId, message.workspaceSessionId, title)
}

function workspaceSessionTitleFromCommand(command: string) {
  return shortenWorkspaceSessionTitle(command, '命令历史')
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

async function loadWorkspaceSessionList(connectionId: string) {
  if (loadedSessionLists.value[connectionId]) return
  loadedSessionLists.value = {
    ...loadedSessionLists.value,
    [connectionId]: true
  }
  try {
    const sessions = await listWorkspaceSessions(connectionId)
    const drafts = workspaceSessionsForConnection(connectionId).filter((session) => isDraftWorkspaceSession(session.id))
    workspaceSessionsByConnection.value = {
      ...workspaceSessionsByConnection.value,
      [connectionId]: [...drafts.filter((draft) => !sessions.some((session) => session.id === draft.id)), ...sessions]
    }
  } catch (error) {
    const nextLoaded = { ...loadedSessionLists.value }
    delete nextLoaded[connectionId]
    loadedSessionLists.value = nextLoaded
    console.error('failed to load workspace sessions', error)
  }
}

async function loadWorkspaceState(connectionId: string, workspaceSessionId: string) {
  const key = workspaceKey(connectionId, workspaceSessionId)
  if (loadedWorkspaceSessions.value[key]) return
  loadedWorkspaceSessions.value = {
    ...loadedWorkspaceSessions.value,
    [key]: true
  }
  if (isDraftWorkspaceSession(workspaceSessionId)) {
    commandHistoryBySession.value = {
      ...commandHistoryBySession.value,
      [key]: commandHistoryBySession.value[key] ?? []
    }
    aiMessagesBySession.value = {
      ...aiMessagesBySession.value,
      [key]: aiMessagesBySession.value[key] ?? []
    }
    return
  }
  try {
    const [commands, messages] = await Promise.all([
      listCommandHistory(connectionId, workspaceSessionId),
      listAiConversationMessages(connectionId, workspaceSessionId)
    ])
    commandHistoryBySession.value = {
      ...commandHistoryBySession.value,
      [key]: commands
    }
    aiMessagesBySession.value = {
      ...aiMessagesBySession.value,
      [key]: messages
    }
  } catch (error) {
    const nextLoaded = { ...loadedWorkspaceSessions.value }
    delete nextLoaded[key]
    loadedWorkspaceSessions.value = nextLoaded
    console.error('failed to load workspace history', error)
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
  if (event.key === 'Escape') closeContextMenu()
}

onMounted(() => {
  void loadProfiles()
  void loadAiConfig()
  void preferredWorkspaceSessionForConnection(LOCAL_CONNECTION_ID).then((session) => {
    terminalTabs.value = terminalTabs.value.map((tab) => (tab.id === 'local-1' ? { ...tab, workspaceSessionId: session.id } : tab))
    void loadWorkspaceState(LOCAL_CONNECTION_ID, session.id)
  })
  window.addEventListener('click', handleGlobalClick)
  window.addEventListener('keydown', handleGlobalKeydown)
  themeToggleButton.value?.addEventListener('pointerdown', handleThemeTogglePointerDown, true)
  themeToggleButton.value?.addEventListener('mousedown', handleThemeTogglePointerDown, true)
  themeToggleButton.value?.addEventListener('click', handleThemeTogglePointerDown, true)
  document.addEventListener('selectstart', handleAppSelectStart, true)
  document.addEventListener('dragstart', handleAppDragStart, true)
})

watch(activeConnectionId, (connectionId) => {
  void loadWorkspaceSessionList(connectionId)
})

watch(activeWorkspaceKey, () => {
  void loadWorkspaceState(activeConnectionId.value, activeWorkspaceSessionId.value)
})

watch(
  appSettings,
  (settings) => {
    persistUserSettings(settings)
  },
  { deep: true }
)
watch(appTheme, (theme) => persistAppTheme(theme), { immediate: true })
onBeforeUnmount(() => {
  window.removeEventListener('click', handleGlobalClick)
  window.removeEventListener('keydown', handleGlobalKeydown)
  themeToggleButton.value?.removeEventListener('pointerdown', handleThemeTogglePointerDown, true)
  themeToggleButton.value?.removeEventListener('mousedown', handleThemeTogglePointerDown, true)
  themeToggleButton.value?.removeEventListener('click', handleThemeTogglePointerDown, true)
  document.removeEventListener('selectstart', handleAppSelectStart, true)
  document.removeEventListener('dragstart', handleAppDragStart, true)
})
</script>

<template>
  <div class="app-shell" :class="{ 'left-collapsed': leftCollapsed, 'right-collapsed': rightCollapsed, 'sftp-workbench-active': sftpWorkbenchActive, 'theme-light': appTheme === 'light', 'theme-dark': appTheme === 'dark' }">
    <header class="titlebar">
      <div class="brand">
        <img class="brand-mark" src="/icon.svg" alt="" aria-hidden="true" />
        <span>AI Term</span>
      </div>
      <nav class="session-tabs" aria-label="终端会话">
        <button
          v-for="tab in terminalTabs"
          :key="tab.id"
          class="tab"
          :class="{ active: tab.id === activeTerminalId, target: isTerminalTargetSelected(tab.id) }"
          @click="selectTerminalTab(tab.id)"
          @contextmenu.prevent.stop="openTerminalTabContextMenu($event, tab)"
        >
                    <span
            class="terminal-target-toggle"
            :class="{ selected: isTerminalTargetSelected(tab.id) }"
            :title="tab.id === activeTerminalId ? (multiTerminalInputEnabled ? '仅同步当前终端' : '当前终端') : isTerminalTargetSelected(tab.id) ? '从同步目标移除' : '加入同步目标'"
            aria-hidden="true"
            @click.stop="toggleTerminalTarget(tab.id)"
          >
            <span />
          </span>
          <span class="status-dot" :class="terminalStatusClass(tab.status)" />
          <span class="tab-title">{{ tab.title }}</span>
          <span v-if="terminalTabs.length > 1" class="tab-close" title="关闭终端" aria-label="关闭终端" @click.stop="closeTerminalTab(tab.id)"><UiIcon name="close" size="12" /></span>
        </button>
                <button class="icon-button" type="button" title="新建本地终端" aria-label="新建本地终端" @click="openLocalTerminal"><UiIcon name="plus" /></button>
        <span class="terminal-target-summary" :class="{ active: multiTerminalInputEnabled }" :title="terminalTargetTitle">
          <UiIcon name="terminal" size="13" />
          <span>{{ terminalTargetLabel }}</span>
        </span>
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
        @command-recorded="recordCommand"
        @status-changed="updateTerminalStatus"
        @profile-updated="refreshConnectionProfilesAfterTerminalAuth"
      />
    </section>
    <WorkspacePanel
      :collapsed="rightCollapsed"
      :terminal-id="activeTerminalId"
      :connection-id="activeConnectionId"
      :connection-profile="activeTerminal?.profile"
      :workspace-session-id="activeWorkspaceSessionId"
      :workspace-sessions="activeWorkspaceSessions"
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
      @append-ai-message="appendAiMessageToActiveTerminal"
      @update-ai-message="updateAiMessage"
      @set-ai-context-status="setAiContextForTerminal"
      @execute-command="executeCommandOnTargetTerminals"
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
      工作区
    </button>
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
