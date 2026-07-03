<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { AiProviderConfig, ConnectionProfile } from '../types/profile'
import type {
  AiContextStatus,
  AiMessage,
  CommandHistoryEntry,
  CommandRecordedEvent,
  ScriptRecording,
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

interface TerminalTab {
  id: string
  title: string
  connectionId: string
  workspaceSessionId: string
  profile?: ConnectionProfile
  connectRequest: number
}

type TerminalPaneInstance = InstanceType<typeof TerminalPane> & {
  executeCommand: (command: string) => boolean
  writeTerminalInput: (data: string) => boolean
  clearTerminal: () => void
  disconnectFromButton: () => void
  restartLocalTerminal: () => void
}

type LeftPanelMode = 'connections' | 'settings'
type SaveState = 'idle' | 'saving' | 'saved' | 'error'

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
    title: 'Local Terminal',
    connectionId: LOCAL_CONNECTION_ID,
    workspaceSessionId: LOCAL_DEFAULT_SESSION_ID,
    profile: undefined,
    connectRequest: 0
  }
])
const activeTerminalId = ref('local-1')
const terminalRefs = ref<Record<string, TerminalPaneInstance | null>>({})
const terminalSnapshots = ref<Record<string, string>>({})
const terminalSelections = ref<Record<string, TerminalSelectionEvent>>({})
const workspaceSessionsByConnection = ref<Record<string, WorkspaceSession[]>>({})
const commandHistoryBySession = ref<Record<string, CommandHistoryEntry[]>>({})
const aiMessagesBySession = ref<Record<string, AiMessage[]>>({})
const aiContextBySession = ref<Record<string, AiContextStatus>>({})
const scriptRecordingsByTerminal = ref<Record<string, ScriptRecording>>({})
const loadedWorkspaceSessions = ref<Record<string, boolean>>({})
const loadedSessionLists = ref<Record<string, boolean>>({})
const contextMenu = ref<ContextMenuState | null>(null)

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

const activeTerminalSnapshot = computed(() => {
  return terminalSnapshots.value[activeTerminalId.value] ?? ''
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

function selectProfile(profileId: string) {
  selectedProfileId.value = profileId
  connectionError.value = ''
  connectionSaveState.value = 'idle'
  connectionSaveError.value = ''
}

function createProfile() {
  const index = profiles.value.length + 1
  const profile: ConnectionProfile = {
    id: `connection-${index}`,
    name: `connection-${index}`,
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
    const profile = cloneConnectionProfile(draft)
    await saveConnectionProfile(profile)
    profileStoreStatus.value = 'ready'
    const session = await createWorkspaceSession(profile.id)
    createTerminalTab(profile, session)
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
  const session = await ensureWorkspaceSession(LOCAL_CONNECTION_ID, LOCAL_DEFAULT_SESSION_ID, 'Untitled')
  createTerminalTab(undefined, session)
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

function isLeftPanelActive(mode: LeftPanelMode) {
  return leftPanelMode.value === mode && !leftCollapsed.value
}

function leftPanelButtonTitle(mode: LeftPanelMode) {
  if (isLeftPanelActive(mode)) return mode === 'connections' ? '收起连接管理' : '收起配置菜单'
  return mode === 'connections' ? '打开连接管理' : '打开配置菜单'
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
      action: () => {
        activeTerminalId.value = tab.id
      }
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
  if (!activeTerminalSnapshot.value) return
  await navigator.clipboard?.writeText(activeTerminalSnapshot.value)
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
  } catch (error) {
    profileStoreStatus.value = 'preview'
    aiConfigSaveState.value = 'error'
    aiConfigSaveError.value = formatError(error)
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
    selectedAiConfigId.value = aiConfigs.value.some((config) => config.id === selectedAiConfigId.value)
      ? selectedAiConfigId.value
      : aiConfigs.value[0].id
    const nextRuntimeKeys = { ...aiRuntimeApiKeys.value }
    delete nextRuntimeKeys[configId]
    aiRuntimeApiKeys.value = nextRuntimeKeys
    if (aiConfigDraft.value?.id === configId) aiConfigDraft.value = undefined
    aiConfigEditorOpen.value = false
    aiConfigSaveState.value = 'saved'
    profileStoreStatus.value = 'ready'
  } catch (error) {
    aiConfigSaveState.value = 'error'
    aiConfigSaveError.value = formatError(error)
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
    selectedAiConfigId.value =
      aiConfigs.value.find((config) => config.id === defaultAiConfig.id)?.id ?? aiConfigs.value[0].id
  } catch (error) {
    aiConfigs.value = [{ ...defaultAiConfig }]
    selectedAiConfigId.value = defaultAiConfig.id
  }
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

async function saveSelectedProfile() {
  const profileToSave = connectionEditorOpen.value ? connectionDraft.value : selectedProfile.value
  if (!profileToSave) return
  const savedProfileId = profileToSave.id
  try {
    connectionSaveState.value = 'saving'
    connectionSaveError.value = ''
    await saveConnectionProfile(profileToSave)
    profileStoreStatus.value = 'ready'
    profiles.value = await listConnectionProfiles()
    selectedProfileId.value = savedProfileId
    connectionError.value = ''
    connectionSaveState.value = 'saved'
    connectionEditorOpen.value = false
    connectionDraft.value = undefined
  } catch (error) {
    profileStoreStatus.value = 'preview'
    connectionSaveState.value = 'error'
    connectionSaveError.value = formatError(error)
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

function newWorkspaceSession(connectionId: string, name?: string): WorkspaceSession {
  const createdAt = nowText()
  return {
    id: `${connectionId}:session:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    connectionId,
    name: name || 'Untitled',
    summary: '',
    createdAt,
    updatedAt: createdAt
  }
}

async function ensureWorkspaceSession(connectionId: string, sessionId = defaultWorkspaceSessionId(connectionId), name = 'Untitled') {
  await loadWorkspaceSessionList(connectionId)
  const existing = workspaceSessionsByConnection.value[connectionId]?.find((item) => item.id === sessionId)
  if (existing) return existing
  const createdAt = nowText()
  const session: WorkspaceSession = {
    id: sessionId,
    connectionId,
    name,
    summary: '',
    createdAt,
    updatedAt: createdAt
  }
  await saveWorkspaceSession(session)
  workspaceSessionsByConnection.value = {
    ...workspaceSessionsByConnection.value,
    [connectionId]: [session, ...(workspaceSessionsByConnection.value[connectionId] ?? [])]
  }
  return session
}

async function createWorkspaceSession(connectionId = activeConnectionId.value, name?: string) {
  const session = newWorkspaceSession(connectionId, name)
  await saveWorkspaceSession(session)
  workspaceSessionsByConnection.value = {
    ...workspaceSessionsByConnection.value,
    [connectionId]: [session, ...(workspaceSessionsByConnection.value[connectionId] ?? [])]
  }
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
  const sessions = workspaceSessionsByConnection.value[activeConnectionId.value] ?? []
  const session = sessions.find((item) => item.id === sessionId)
  if (!session) return
  const nextName = name.trim()
  if (!nextName) return
  const updated = { ...session, name: nextName, updatedAt: nowText() }
  try {
    await saveWorkspaceSession(updated)
    workspaceSessionsByConnection.value = {
      ...workspaceSessionsByConnection.value,
      [activeConnectionId.value]: sessions.map((item) => (item.id === sessionId ? updated : item))
    }
  } catch (error) {
    connectionError.value = formatError(error)
  }
}

async function updateWorkspaceSessionTitle(connectionId: string, sessionId: string, title: string) {
  const sessions = workspaceSessionsByConnection.value[connectionId] ?? []
  const session = sessions.find((item) => item.id === sessionId)
  if (!session || !isAutoWorkspaceSessionName(session.name)) return
  const nextTitle = title.trim()
  if (!nextTitle) return
  const updated = { ...session, name: nextTitle, updatedAt: nowText() }
  try {
    await saveWorkspaceSession(updated)
    workspaceSessionsByConnection.value = {
      ...workspaceSessionsByConnection.value,
      [connectionId]: sessions.map((item) => (item.id === sessionId ? updated : item))
    }
  } catch (error) {
    console.error('failed to update AI generated session title', error)
  }
}

function isAutoWorkspaceSessionName(name: string) {
  return ['untitled', '默认会话', '本地默认会话', '当前会话'].includes(name.trim().toLowerCase())
}

async function deleteWorkspaceSessionForActiveConnection(sessionId: string) {
  const sessions = workspaceSessionsByConnection.value[activeConnectionId.value] ?? []
  if (sessions.length <= 1) {
    window.alert('至少保留一个会话')
    return
  }
  const session = sessions.find((item) => item.id === sessionId)
  if (!session) return
  if (!window.confirm(`删除会话 ${session.name}？对应命令历史和 AI 对话也会删除。`)) return
  try {
    await deleteWorkspaceSession(sessionId)
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
  const title = profile ? `${profile.target.username || 'user'}@${profile.target.host || profile.name}` : 'Local Terminal'
  const connectionId = profile?.id ?? LOCAL_CONNECTION_ID
  const session = workspaceSession ?? {
    id: defaultWorkspaceSessionId(connectionId),
    connectionId,
    name: '默认会话',
    summary: '',
    createdAt: nowText(),
    updatedAt: nowText()
  }
  terminalTabs.value.push({
    id,
    title,
    connectionId,
    workspaceSessionId: session.id,
    profile: profile ? cloneConnectionProfile(profile) : undefined,
    connectRequest: 1
  })
  activeTerminalId.value = id
  void loadWorkspaceSessionList(connectionId)
  void loadWorkspaceState(connectionId, session.id)
}

function closeTerminalTab(tabId: string) {
  if (terminalTabs.value.length === 1) return
  const index = terminalTabs.value.findIndex((tab) => tab.id === tabId)
  terminalTabs.value = terminalTabs.value.filter((tab) => tab.id !== tabId)
  delete terminalSnapshots.value[tabId]
  delete terminalSelections.value[tabId]
  delete terminalRefs.value[tabId]
  if (activeTerminalId.value === tabId) {
    const nextTab = terminalTabs.value[Math.max(0, index - 1)] ?? terminalTabs.value[0]
    activeTerminalId.value = nextTab.id
  }
}

function setTerminalRef(tabId: string, instance: TerminalPaneInstance | null) {
  terminalRefs.value[tabId] = instance
}

function updateTerminalOutput(event: TerminalOutputEvent) {
  const previousSnapshot = terminalSnapshots.value[event.terminalId] ?? ''
  const delta = terminalOutputDelta(previousSnapshot, event.snapshot)
  terminalSnapshots.value[event.terminalId] = event.snapshot
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
    [key]: [...(commandHistoryBySession.value[key] ?? []), entry].slice(-300)
  }
  appendRecordingCommand(event.terminalId, event.command)
  void saveCommandHistoryRecord(entry).catch((error) => {
    console.error('failed to save command history', error)
  })
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
  return nextSnapshot.slice(-8_000)
}

function executeCommandOnActiveTerminal(command: string) {
  terminalRefs.value[activeTerminalId.value]?.executeCommand(command)
}

function writeInputToActiveTerminal(data: string) {
  terminalRefs.value[activeTerminalId.value]?.writeTerminalInput(data)
}

function appendAiMessageToActiveTerminal(message: AiMessage) {
  const key = workspaceKey(message.connectionId, message.workspaceSessionId)
  aiMessagesBySession.value = {
    ...aiMessagesBySession.value,
    [key]: [...(aiMessagesBySession.value[key] ?? []), message].slice(-300)
  }
  if (message.streaming) return
  void saveAiConversationMessage(message).catch((error) => {
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
  void saveAiConversationMessage(message).catch((error) => {
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

async function loadWorkspaceSessionList(connectionId: string) {
  if (loadedSessionLists.value[connectionId]) return
  loadedSessionLists.value = {
    ...loadedSessionLists.value,
    [connectionId]: true
  }
  try {
    const sessions = await listWorkspaceSessions(connectionId)
    workspaceSessionsByConnection.value = {
      ...workspaceSessionsByConnection.value,
      [connectionId]: sessions
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

function handleGlobalClick() {
  closeContextMenu()
}

function handleGlobalKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') closeContextMenu()
}

onMounted(() => {
  void loadProfiles()
  void loadAiConfig()
  void ensureWorkspaceSession(LOCAL_CONNECTION_ID, LOCAL_DEFAULT_SESSION_ID, 'Untitled').then(() => {
    void loadWorkspaceState(LOCAL_CONNECTION_ID, LOCAL_DEFAULT_SESSION_ID)
  })
  window.addEventListener('click', handleGlobalClick)
  window.addEventListener('keydown', handleGlobalKeydown)
})

watch(activeConnectionId, (connectionId) => {
  void loadWorkspaceSessionList(connectionId)
  void ensureWorkspaceSession(connectionId).then((session) => {
    const tab = activeTerminal.value
    if (tab && !tab.workspaceSessionId) selectWorkspaceSession(session.id)
  })
})

watch(activeWorkspaceKey, () => {
  void loadWorkspaceState(activeConnectionId.value, activeWorkspaceSessionId.value)
})

onBeforeUnmount(() => {
  window.removeEventListener('click', handleGlobalClick)
  window.removeEventListener('keydown', handleGlobalKeydown)
})
</script>

<template>
  <div class="app-shell" :class="{ 'left-collapsed': leftCollapsed, 'right-collapsed': rightCollapsed, 'sftp-workbench-active': sftpWorkbenchActive }">
    <header class="titlebar">
      <div class="brand">
        <span class="brand-mark">AT</span>
        <span>AI Term</span>
      </div>
      <nav class="session-tabs" aria-label="Sessions">
        <button
          v-for="tab in terminalTabs"
          :key="tab.id"
          class="tab"
          :class="{ active: tab.id === activeTerminalId }"
          @click="activeTerminalId = tab.id"
          @contextmenu.prevent.stop="openTerminalTabContextMenu($event, tab)"
        >
          <span class="status-dot live" />{{ tab.title }}
          <span v-if="terminalTabs.length > 1" class="tab-close" @click.stop="closeTerminalTab(tab.id)">×</span>
        </button>
        <button class="icon-button" title="New local terminal" @click="openLocalTerminal">+</button>
      </nav>
    </header>
    <aside class="app-rail" aria-label="Primary navigation">
      <button
        class="rail-button"
        :class="{ active: isLeftPanelActive('connections') }"
        :title="leftPanelButtonTitle('connections')"
        :aria-label="leftPanelButtonTitle('connections')"
        @click="toggleConnectionsPanel"
      >
        ▣
      </button>
      <button
        class="rail-button"
        :class="{ active: isLeftPanelActive('settings') }"
        :title="leftPanelButtonTitle('settings')"
        :aria-label="leftPanelButtonTitle('settings')"
        @click="toggleSettingsPanel"
      >
        ⚙
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
      @select-ai-config="selectAiConfig"
      @create-ai-config="createAiConfig"
      @edit-ai-config="editAiConfig"
      @delete-ai-config="deleteSelectedAiConfig"
      @open-menu="openAiConfigContextMenu"
      @close-ai-config="closeAiConfigEditor"
      @save-ai-config="saveAiConfig"
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
        @terminal-output="updateTerminalOutput"
        @terminal-selection="updateTerminalSelection"
        @command-recorded="recordCommand"
      />
    </section>
    <WorkspacePanel
      :collapsed="rightCollapsed"
      :terminal-id="activeTerminalId"
      :connection-id="activeConnectionId"
      :workspace-session-id="activeWorkspaceSessionId"
      :workspace-sessions="activeWorkspaceSessions"
      :selected-ai-config-id="selectedAiConfigId"
      :ai-config="aiConfig"
      :api-key="activeAiRuntimeApiKey"
      :terminal-snapshot="activeTerminalSnapshot"
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
      @execute-command="executeCommandOnActiveTerminal"
      @write-terminal-input="writeInputToActiveTerminal"
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
    <div class="persistence-status" :class="profileStoreStatus">
      profiles: {{ profileStoreStatus }} · active: {{ activeTerminal?.title }}
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
