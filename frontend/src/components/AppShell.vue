<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { AiProviderConfig, ConnectionProfile } from '../types/profile'
import type { AppUserSettings } from '../types/settings'
import { useUserSettings } from '../composables/useUserSettings'
import { useAppTheme } from '../composables/useAppTheme'
import { useWorkspaceResize } from '../composables/useWorkspaceResize'
import { useToasts } from '../composables/useToasts'
import { useContextMenu } from '../composables/useContextMenu'
import { useCommandHistory } from '../composables/useCommandHistory'
import { useWorkspaceSessions } from '../composables/useWorkspaceSessions'
import { useAiMessages } from '../composables/useAiMessages'
import { DEFAULT_AI_SESSION_ID, nowText } from '../lib/workspaceSessions'
import { MAX_WORKSPACE_WIDTH, MIN_WORKSPACE_WIDTH } from '../lib/workspaceLayout'

import type { TerminalTab } from '../types/terminal'
import { useTerminalTabs } from '../composables/useTerminalTabs'
import { useTerminalTabScroll } from '../composables/useTerminalTabScroll'
import { terminalStatusClass } from '../lib/terminalTabs'
import type {
  CommandRecordedEvent,
  ScriptRecording,
  TerminalInputEvent,
  TerminalInputSyncState,
  TerminalInputWriteFailureEvent,
  TerminalOutputDeltaEvent,
  TerminalOutputEvent,
  TerminalSelectionEvent
} from '../types/workspace'
import {
  deleteAgentCommandAllowlistEntry,
  deleteAiProviderConfig,
  deleteConnectionProfile,
  listAgentCommandAllowlist,
  listAiProviderConfigs,
  listConnectionProfiles,
  saveAgentCommandAllowlistEntry,
  saveAiProviderConfig,
  saveConnectionProfile
} from '../lib/tauri'
import type { AgentAllowlistEntry, AgentCaptureMode, AgentCommandHandle } from '../types/agent'
import { isSensitiveCommand } from '../lib/commandPrivacy'
import ConnectionSidebar from './ConnectionSidebar.vue'
import ContextMenu from './ContextMenu.vue'
import SettingsSidebar from './SettingsSidebar.vue'
import TerminalPane from './TerminalPane.vue'
import WorkspacePanel from './WorkspacePanel.vue'
import UiIcon from './UiIcon.vue'



type TerminalPaneInstance = InstanceType<typeof TerminalPane> & {
  commandExecutionReadiness: () => 'ready' | 'line-busy' | 'shell-busy' | 'unavailable'
  executeCommand: (command: string) => boolean
  agentCaptureSupported: () => boolean
  ensureAgentCapture: () => Promise<AgentCaptureMode>
  runCommandAndCapture: (command: string, options?: { maxOutputChars?: number }) => AgentCommandHandle
  fillCommand: (command: string) => boolean
  pinQuickCommand: (command: string) => 'added' | 'exists' | 'invalid' | 'limit'
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

type AboutSignalIcon = 'ai' | 'database' | 'network' | 'shield' | 'terminal'

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
  riskPolicy: 'confirm-dangerous',
  timeoutSeconds: 0
}
const LOCAL_CONNECTION_ID = 'local'
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
const {
  terminalTabs, activeTerminalId, activeTerminal, targetTerminalIds, targetConnectionIds,
  multiTerminalInputEnabled, terminalTargetLabel, terminalTargetTitle, selectTerminalTab,
  addTerminalTab, removeTerminalTab, updateTerminalStatus, isTerminalTargetSelected,
  isTerminalSyncPaused, terminalTargetToggleTitle, toggleTerminalTarget, selectAllTerminalTargets,
  resetTerminalTargetsToActive, pauseTerminalTargets, resumeTerminalSyncTarget
} = useTerminalTabs()
// shallowRef: component instances are only accessed imperatively; deep
// reactivity would proxy every TerminalPane instance for no benefit.
const terminalRefs = shallowRef<Record<string, TerminalPaneInstance | null>>({})
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
const scriptRecordingsByTerminal = ref<Record<string, ScriptRecording>>({})
const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu()
const { toasts, showToast, dismissToast } = useToasts()
const { appSettings, updateUserSettings: saveUserSettings } = useUserSettings()
const { appTheme, themeToggleButton, toggleAppTheme } = useAppTheme({
  onThemeChange(theme) {
    showToast('info', '主题已切换', theme === 'light' ? '已切换为白色主题。' : '已切换为深色主题。')
  }
})
const {
  sessionTabStrip, sessionTabOverflow, sessionTabThumbStyle, setSessionTabButton,
  handleSessionTabScroll, handleSessionTabWheel, handleSessionTabScrollbarPointerDown,
  handleSessionTabThumbPointerDown
} = useTerminalTabScroll({ terminalTabs, activeTerminalId, leftCollapsed, rightCollapsed })
let terminalOutputSequence = 0
const COMMAND_EXECUTION_RETRY_DELAYS_MS = [0, 100, 250, 500, 1_000]
const selectedProfile = computed(() => {
  if (!selectedProfileId.value) return undefined
  return profiles.value.find((profile) => profile.id === selectedProfileId.value)
})

const sidebarProfile = computed(() => {
  return connectionEditorOpen.value ? connectionDraft.value : selectedProfile.value
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
const {
  workspaceWidth,
  workspaceResizing,
  workspaceLayoutStyle,
  beginWorkspaceResize,
  handleWorkspaceResizeKeydown
} = useWorkspaceResize({ leftCollapsed, rightCollapsed, sftpWorkbenchActive })

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

/**
 * 编辑不改「当前使用」:草稿直接按 configId 取,不经过 selectedAiConfigId。
 * 之前借 selectAiConfig 是为了让 aiConfig 指向目标,副作用是点一下铅笔就把
 * 正在用的配置换了 —— 编辑和启用是两件事。
 */
function editAiConfig(configId?: string) {
  const target = configId
    ? aiConfigs.value.find((config) => config.id === configId) ?? aiConfig.value
    : aiConfig.value
  aiConfigDraft.value = cloneAiConfig(target)
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
  const wasCreating = aiConfigEditorMode.value === 'create'
  const previousSelectedId = selectedAiConfigId.value
  try {
    await saveAiProviderConfig(savedConfig)
    aiConfigs.value = await listAiProviderConfigs()
    // 新建后切到新配置;编辑则保持原来的「当前使用」。改 id 相当于重命名,
    // 原 id 已经不在列表里,这时才跟到新 id,否则 aiConfig 会回落到列表首项。
    selectedAiConfigId.value = wasCreating || !aiConfigs.value.some((config) => config.id === previousSelectedId)
      ? savedConfig.id
      : previousSelectedId
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

function updateUserSettings(settings: AppUserSettings) {
  if (saveUserSettings(settings)) {
    showToast('success', '设置已保存', '终端字体和字号已同步到当前终端。')
  } else {
    showToast('warning', '设置已应用，但未保存', '本地存储不可用，重新打开应用后可能恢复原设置。')
  }
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

async function allowAgentPattern(pattern: string, sourceCommand: string) {
  try {
    await saveAgentCommandAllowlistEntry(pattern, sourceCommand)
    await loadAgentAllowlist()
    showToast('success', '已加入允许列表', `以后将自动执行:${pattern}`)
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
function agentCommandRunner(terminalId: string, command: string, options?: { maxOutputChars?: number }): AgentCommandHandle {
  const pane = terminalRefs.value[terminalId]
  if (!pane) {
    return {
      result: Promise.resolve({
        status: 'dispatch-failed' as const,
        output: '',
        durationMs: 0,
        truncated: false,
        failureReason: '任务绑定的终端已关闭或不可用'
      }),
      peekOutput: () => '',
      cancel: () => {}
    }
  }
  return pane.runCommandAndCapture(command, options)
}

/** Agent 模式可用性快检(同步):返回空串表示可用,否则为不可用原因。 */
function agentAvailabilityCheck(): string {
  const pane = terminalRefs.value[activeTerminalId.value]
  if (!pane) return '当前终端不可用'
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
  if (!removeTerminalTab(tabId)) return
  delete terminalSnapshots.value[tabId]
  delete terminalOutputEvents.value[tabId]
  delete terminalSelections.value[tabId]
  delete terminalRefs.value[tabId]
  delete scriptRecordingsByTerminal.value[tabId]
}

function setTerminalRef(tabId: string, instance: TerminalPaneInstance | null) {
  terminalRefs.value[tabId] = instance
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
  const entry = recordCommandForConnection(connectionId, event)
  if (entry) appendRecordingCommand(event.terminalId, event.command)
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

// 与派发路径共用一套重试节奏:刚回车、shell 还没把新提示符吐回来时不该直接判失败。
// 和派发一样先问就绪再动手,免得 fillCommand 内部的行内提示在每次重试时闪一遍。
async function fillHistoryCommandOnActiveTerminal(command: string) {
  const value = command.trim()
  if (!value) return
  let lastReadiness: ReturnType<TerminalPaneInstance['commandExecutionReadiness']> = 'unavailable'

  for (const delay of COMMAND_EXECUTION_RETRY_DELAYS_MS) {
    if (delay > 0) await new Promise((resolve) => window.setTimeout(resolve, delay))
    await nextTick()
    const pane = terminalRefs.value[activeTerminalId.value]
    lastReadiness = pane?.commandExecutionReadiness() ?? 'unavailable'
    if (lastReadiness === 'ready' && pane?.fillCommand(value)) {
      showToast('success', '已填入终端', commandPreview(value))
      return
    }
    // 行内已有内容是用户自己敲的,等下去也不会变
    if (lastReadiness === 'line-busy') break
  }

  if (lastReadiness === 'line-busy') {
    showToast('warning', '命令未填入', '当前命令行已有输入或补全内容，请先提交或清空。')
  } else if (lastReadiness === 'shell-busy') {
    showToast('warning', '命令未填入', 'Shell 尚未返回可输入提示符，请稍后重试。')
  } else {
    showToast('error', '命令未填入', '当前终端尚未就绪或连接已断开。')
  }
}

function pinQuickCommandOnActiveTerminal(command: string) {
  const pane = terminalRefs.value[activeTerminalId.value]
  const result = pane?.pinQuickCommand(command) ?? 'invalid'
  if (result === 'added') {
    showToast('success', '已固定命令', commandPreview(command))
  } else if (result === 'exists') {
    showToast('info', '命令已固定', commandPreview(command))
  } else if (result === 'limit') {
    showToast('warning', '无法固定命令', '当前连接最多保留 12 条固定命令，请先移除一条。')
  } else {
    showToast('warning', '无法固定命令', '该命令为空、过长、包含敏感信息或风险过高。')
  }
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
  const added = pauseTerminalTargets(ids)
  if (added.length === 0) return
  if (!notify) return
  showToast(
    'warning',
    added.length > 1 ? '部分终端同步已暂停' : '终端同步已暂停',
    message
  )
}


function syncTerminalInputToTargets(event: TerminalInputEvent) {
  if (event.terminalId !== activeTerminalId.value) return
  if (!multiTerminalInputEnabled.value) return
  if (!targetTerminalIds.value.includes(event.terminalId)) return
  const targetIds = targetTerminalIds.value.filter((terminalId) => terminalId !== event.terminalId)

  if (event.data === '\x03') {
    const rejected: string[] = []
    const interruptTargetIds = targetIds.filter((terminalId) => !isTerminalSyncPaused(terminalId))
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
      if (!isTerminalSyncPaused(terminalId)) mismatched.push(terminalId)
      return
    }
    if (isTerminalSyncPaused(terminalId)) {
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
  clearChromeSelection(event.target)
}

function handleGlobalKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    closeAboutPage()
  }
}

onMounted(() => {
  void loadProfiles()
  void loadAiConfig()
  void ensureActiveAiSession(LOCAL_CONNECTION_ID)
  void loadCommandHistoryForConnection(LOCAL_CONNECTION_ID)
  void loadAgentAllowlist()
  window.addEventListener('click', handleGlobalClick)
  window.addEventListener('keydown', handleGlobalKeydown)
  document.addEventListener('selectstart', handleAppSelectStart, true)
  document.addEventListener('dragstart', handleAppDragStart, true)
})

watch(activeConnectionId, (connectionId) => {
  void loadCommandHistoryForConnection(connectionId)
})

watch(
  () => [activeAiSessionId.value, isDraftWorkspaceSession(activeAiSessionId.value)],
  () => { void loadAiSessionState(activeAiSessionId.value) }
)


onBeforeUnmount(() => {
  window.removeEventListener('click', handleGlobalClick)
  window.removeEventListener('keydown', handleGlobalKeydown)
  document.removeEventListener('selectstart', handleAppSelectStart, true)
  document.removeEventListener('dragstart', handleAppDragStart, true)
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
      :aria-valuemin="MIN_WORKSPACE_WIDTH"
      :aria-valuemax="MAX_WORKSPACE_WIDTH"
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
      :agent-availability-check="agentAvailabilityCheck"
      :agent-availability-confirm="agentAvailabilityConfirm"
      :agent-command-runner="agentCommandRunner"
      :agent-allowlist-patterns="agentAllowlist.map((entry) => entry.pattern)"
      :agent-builtin-readonly-enabled="appSettings.agentAutoExecReadonly"
      :agent-step-limit="appSettings.agentStepLimit"
      :agent-command-timeout-ms="appSettings.agentCommandTimeoutSec * 1000"
      @close="rightCollapsed = true"
      @select-workspace-session="selectWorkspaceSession"
      @create-workspace-session="createWorkspaceSessionForActiveConnection"
      @rename-workspace-session="renameWorkspaceSession"
      @delete-workspace-session="deleteWorkspaceSessionForActiveConnection"
      @update-workspace-session-title="updateWorkspaceSessionTitle"
      @update-workspace-session-context-summary="updateWorkspaceSessionContextSummary"
      @set-workspace-session-mode="setWorkspaceSessionMode"
      @allow-agent-pattern="allowAgentPattern"
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
