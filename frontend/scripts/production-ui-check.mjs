import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

const appShell = read('src/components/AppShell.vue')
const terminalPane = read('src/components/TerminalPane.vue')
const aiPanel = read('src/components/AiPanel.vue')
const aiConfig = read('src/components/AiConfigPanel.vue')
const fileTransfer = read('src/components/FileTransferPanel.vue')
const sidebar = read('src/components/ConnectionSidebar.vue')
const settingsSidebar = read('src/components/SettingsSidebar.vue')
const tauri = read('src/lib/tauri.ts')
const workspacePanel = read('src/components/WorkspacePanel.vue')
const commandHistoryPanel = read('src/components/CommandHistoryPanel.vue')
const contextMenu = read('src/components/ContextMenu.vue')
const styles = read('src/styles.css')
const tauriConfig = read('../src-tauri/tauri.conf.json')
const sqlite = read('../src-tauri/src/domain/storage/sqlite.rs')
const schema = read('../src-tauri/src/domain/storage/schema.sql')
const aiChat = read('../src-tauri/src/domain/ai/chat.rs')

assert(
  appShell.includes('selectedProfile = computed(() =>') &&
    appShell.includes('return undefined') &&
    !appShell.includes('?? profiles.value[0]'),
  'AppShell must pass an undefined profile when no connection is selected so the terminal opens locally by default.'
)

assert(
  appShell.includes('function openLocalTerminal()') &&
    appShell.includes("selectedProfileId.value = ''") &&
    appShell.includes('@click="openLocalTerminal"'),
  'AppShell must provide an explicit local terminal action that clears the selected profile and reconnects locally.'
)

assert(
  terminalPane.includes('if (props.profile)') &&
    terminalPane.includes('await connectLocal()') &&
    terminalPane.includes("status.value = 'local'"),
  'TerminalPane must automatically attach a local terminal when no connection profile is configured.'
)

assert(
  terminalPane.includes('connectProfile') &&
    terminalPane.includes('sessionId = await connectProfile(props.profile.id, size.cols, size.rows)') &&
    terminalPane.includes('await attachTerminalEvents()') &&
    !terminalPane.includes('Remote SSH profile editing is ready'),
  'TerminalPane must attach remote SSH profiles through the Tauri backend instead of rendering a placeholder.'
)

assert(
  !terminalPane.includes('Remote SSH is not enabled for this build yet.'),
  'TerminalPane must not show a disabled-remote placeholder.'
)

assert(
  !terminalPane.includes('terminal?.write(data)'),
  'TerminalPane must not echo keyboard input locally when there is no backend session.'
)

assert(
  terminalPane.includes('onTerminalData(sessionId') &&
    tauri.includes('terminalDataEventName(sessionId: string)'),
  'Terminal data listeners must use session-scoped event names.'
)

assert(
  terminalPane.includes('onTerminalClosed(sessionId') &&
    terminalPane.includes("status.value = 'idle'") &&
    tauri.includes('terminalClosedEventName(sessionId: string)'),
  'TerminalPane must listen for terminal close events and stop showing the local shell as live after it exits.'
)

assert(
  terminalPane.includes('function restartLocalTerminal()') &&
    terminalPane.includes('connectLocal()') &&
    terminalPane.includes('New Local Shell'),
  'TerminalPane must provide an in-terminal action to start a new local shell after disconnect or shell exit.'
)

assert(
  terminalPane.includes('No active shell') &&
    !terminalPane.includes('Starting local terminal...'),
  'TerminalPane idle state must not claim a local terminal is starting when no shell is attached.'
)

assert(
  terminalPane.includes('activeSession = ref') &&
    terminalPane.includes('activeSessionProfile') &&
    !terminalPane.includes("profile ? `${profile.gateway.host") &&
    !terminalPane.includes("profile ? `${profile.target.username"),
  'TerminalPane must render active terminal session metadata, not the currently selected profile draft.'
)

assert(
  !appShell.includes("selectedProfile?.name ?? 'Local Terminal'"),
  'The session tab must not show a selected profile as if it were the active terminal session.'
)

assert(
  aiConfig.includes('v-model="draft.baseUrl"') &&
    aiConfig.includes('v-model="draft.model"') &&
    aiConfig.includes('v-model="draft.apiKey"') &&
    aiConfig.includes("emit('save'"),
  'AI configuration must be editable and emit a save event instead of rendering readonly sample data.'
)

assert(
  fileTransfer.includes('type="file"') &&
    fileTransfer.includes('triggerUpload') &&
    fileTransfer.includes('transferQueue') &&
    fileTransfer.includes('remoteSessionActive') &&
    !fileTransfer.includes('profile ? `Ready'),
  'FileTransferPanel must expose an interactive upload flow without treating a selected profile draft as an active remote transfer session.'
)

assert(
  sidebar.includes('v-model="selectedProfile.gateway.host"') &&
    sidebar.includes('v-model="selectedProfile.gateway.username"') &&
    sidebar.includes('v-model="selectedProfile.target.host"') &&
    sidebar.includes('v-model="selectedProfile.target.username"'),
  'ConnectionSidebar must let users edit gateway and target connection fields after creating a profile.'
)

assert(
  sidebar.includes('v-model="selectedProfile.gateway.password"') &&
    sidebar.includes('v-model="selectedProfile.target.password"') &&
    sidebar.includes('type="password"') &&
    sidebar.includes('明文保存') &&
    appShell.includes("password: ''"),
  'ConnectionSidebar must let users save plaintext SSH passwords for gateway and target endpoints.'
)

assert(
  sidebar.includes("value=\"direct\"") &&
    sidebar.includes('普通直连') &&
    sidebar.includes("value=\"interactive-menu\"") &&
    sidebar.includes('堡垒机菜单'),
  'ConnectionSidebar must expose a direct SSH mode and a bastion interactive-menu mode.'
)

assert(
  sidebar.includes("selectedProfile.jumpMode === 'interactive-menu'") &&
    sidebar.includes('v-if="selectedProfile.jumpMode ===') &&
    sidebar.includes('v-model="selectedProfile.menuProfileId"'),
  'ConnectionSidebar must only show gateway/menu fields for bastion interactive-menu profiles.'
)

assert(
  sidebar.includes("emit('save'") &&
    sidebar.includes('保存配置') &&
    sidebar.includes('modal-backdrop') &&
    sidebar.includes('role="dialog"') &&
    appShell.includes('@save="saveSelectedProfile"'),
  'ConnectionSidebar must provide a modal save action wired to profile persistence.'
)

assert(
  sidebar.includes("connect: [profileId: string]") &&
    sidebar.includes("@dblclick=\"emit('connect', profile.id)\"") &&
    sidebar.includes("@click.stop=\"emit('connect', profile.id)\"") &&
    sidebar.includes('连接服务器') &&
    appShell.includes('@connect="connectProfileFromSidebar"'),
  'ConnectionSidebar must own the primary connect action and support double-clicking a connection card.'
)

assert(
  !sidebar.includes('selected-summary') &&
    !settingsSidebar.includes('settings-summary') &&
    !sidebar.includes('sidebar-footer') &&
    !settingsSidebar.includes('sidebar-footer') &&
    styles.includes('grid-template-rows: 58px 62px minmax(0, 1fr);') &&
    styles.includes('grid-template-rows: 58px minmax(0, 1fr);'),
  'Left sidebars must avoid the old lower preview/footer blocks and let lists own the available space.'
)

assert(
  contextMenu.includes('role="menu"') &&
    contextMenu.includes('role="menuitem"') &&
    appShell.includes('openConnectionContextMenu') &&
    appShell.includes('openAiConfigContextMenu') &&
    appShell.includes('openTerminalTabContextMenu') &&
    appShell.includes('openTerminalAreaContextMenu') &&
    sidebar.includes('@contextmenu.prevent="emit(\'openMenu\'') &&
    settingsSidebar.includes('@contextmenu.prevent="emit(\'openMenu\'') &&
    styles.includes('.context-menu'),
  'The client UI must provide custom right-click context menus for connections, AI configs, and terminal surfaces.'
)

assert(
  !appShell.includes('structuredClone(') &&
    appShell.includes('cloneConnectionProfile') &&
    appShell.includes('connectionDraft') &&
    appShell.includes('connectingProfileId') &&
    appShell.includes('connectionError') &&
    sidebar.includes('连接中') &&
    sidebar.includes('connectionError'),
  'Connection flow must safely clone Vue profile objects and show visible connecting/error feedback.'
)

assert(
  !appShell.includes('@click="connectSelectedProfile"') &&
    !appShell.includes('@click="saveSelectedProfile">保存配置'),
  'Profile save/connect controls must live in the left connection sidebar, not the global top toolbar.'
)

assert(
  appShell.includes("jumpMode: 'direct'") &&
    appShell.includes("menuProfileId: ''"),
  'New connection drafts must default to ordinary direct SSH instead of requiring bastion fields.'
)

assert(
  tauri.includes('listConnectionProfiles') &&
    tauri.includes('saveConnectionProfile') &&
    tauri.includes('deleteConnectionProfile') &&
    appShell.includes('await listConnectionProfiles()') &&
    appShell.includes('await saveConnectionProfile(profileToSave)') &&
    appShell.includes('await deleteConnectionProfile(profileId)') &&
    sidebar.includes("delete: [profileId: string]") &&
    sidebar.includes('保存配置') &&
    sidebar.includes('删除连接') &&
    appShell.includes('@save="saveSelectedProfile"'),
  'Connection profiles must support SQLite-backed create/read/update/delete through Tauri commands.'
)

assert(
  appShell.includes('terminalTabs = ref') &&
    appShell.includes('activeTerminalId') &&
    appShell.includes('createTerminalTab') &&
    appShell.includes('closeTerminalTab') &&
    appShell.includes('session-tabs'),
  'AppShell must manage multiple terminal tabs instead of a single fixed terminal.'
)

assert(
  appShell.includes('leftCollapsed') &&
    appShell.includes('rightCollapsed') &&
    appShell.includes('leftPanelMode') &&
    appShell.includes('sidebar-collapse-button') &&
    !appShell.includes('toggle-left') &&
    !appShell.includes('toggle-right') &&
    !appShell.includes('top-actions') &&
    appShell.includes('workspace-open-handle') &&
    appShell.includes('@close="rightCollapsed = true"') &&
    workspacePanel.includes("emit('close')") &&
    workspacePanel.includes('workspace-close'),
  'Terminal workspace must allow hiding both the left connection sidebar and the right workspace.'
)

assert(
    workspacePanel.includes("activeWorkspaceTab = ref<'history' | 'ai' | 'sftp'>") &&
    workspacePanel.includes('命令历史') &&
    workspacePanel.includes('AI 助手') &&
    workspacePanel.includes('SFTP') &&
    workspacePanel.includes('selectWorkspaceSession') &&
    workspacePanel.includes('createWorkspaceSession') &&
    workspacePanel.includes('renameWorkspaceSession') &&
    workspacePanel.includes('deleteWorkspaceSession') &&
    aiPanel.includes('session-history-popover') &&
    aiPanel.includes('filteredSessions') &&
    aiPanel.includes('sessionSearch') &&
    aiPanel.includes("emit('createSession')") &&
    aiPanel.includes("emit('renameSession'") &&
    aiPanel.includes("emit('deleteSession'") &&
    aiPanel.includes('generateAiSessionTitle') &&
    aiPanel.includes('maybeGenerateSessionTitle') &&
    aiPanel.includes("emit('updateSessionTitle'") &&
    appShell.includes('updateWorkspaceSessionTitle') &&
    appShell.includes('isAutoWorkspaceSessionName') &&
    workspacePanel.includes('CommandHistoryPanel') &&
    workspacePanel.includes('AiPanel'),
  'Right workspace must expose history, AI, SFTP, and AI session history controls.'
)

assert(
  terminalPane.includes('terminalOutput:') &&
    terminalPane.includes('commandRecorded:') &&
    terminalPane.includes('defineExpose') &&
    terminalPane.includes('executeCommand'),
  'TerminalPane must expose terminal output, command history events, and an executeCommand bridge.'
)

assert(
  aiConfig.includes('v-model="draft.baseUrl"') &&
    aiConfig.includes('v-model="draft.model"') &&
    aiConfig.includes('v-model="draft.apiKey"') &&
    aiConfig.includes("emit('save'"),
  'AI configuration must be editable and emit a save event instead of rendering readonly sample data.'
)

assert(
    workspacePanel.includes(':terminal-snapshot="terminalSnapshot"') &&
    workspacePanel.includes(':command-history="commandHistory"') &&
    workspacePanel.includes(':workspace-session-id="workspaceSessionId"') &&
    workspacePanel.includes('@execute-command=') &&
    appShell.includes('executeCommandOnActiveTerminal'),
  'AI workspace must receive current terminal content and command history and be able to execute generated commands in the active terminal.'
)

assert(
    aiPanel.includes('chatWithAiProvider') &&
    aiPanel.includes('terminalSnapshot,') &&
    aiPanel.includes('const commandHistory = props.commandHistory.map') &&
    aiPanel.includes('context compressed') &&
    aiPanel.includes('messages: AiMessage[]') &&
    aiPanel.includes('const requestConnectionId = props.connectionId') &&
    aiPanel.includes('const requestWorkspaceSessionId = props.workspaceSessionId') &&
    appShell.includes('aiMessagesBySession') &&
    appShell.includes('commandHistoryBySession') &&
    appShell.includes('workspaceSessionsByConnection') &&
    appShell.includes('loadWorkspaceState') &&
    appShell.includes('loadWorkspaceSessionList') &&
    appShell.includes('createWorkspaceSession') &&
    appShell.includes('renameWorkspaceSession') &&
    appShell.includes('deleteWorkspaceSessionForActiveConnection') &&
    appShell.includes('saveCommandHistoryRecord') &&
    appShell.includes('saveAiConversationMessage') &&
    tauri.includes("invoke<WorkspaceSession[]>('list_workspace_sessions'") &&
    tauri.includes("invoke<void>('save_workspace_session'") &&
    tauri.includes("invoke<boolean>('delete_workspace_session'") &&
    tauri.includes("invoke<AiSessionTitleResponse>('generate_ai_session_title'") &&
    tauri.includes("invoke<CommandHistoryEntry[]>('list_command_history'") &&
    tauri.includes("invoke<void>('save_command_history_record'") &&
    tauri.includes("invoke<AiMessage[]>('list_ai_conversation_messages'") &&
    tauri.includes("invoke<void>('save_ai_conversation_message'") &&
    appShell.includes('activeAiMessages') &&
    appShell.includes('setAiContextForTerminal') &&
    aiChat.includes('parse_model_error') &&
    aiChat.includes('build_context_bundle') &&
    aiChat.includes('build_system_prompt') &&
    aiChat.includes('关键上下文摘要') &&
    aiChat.includes('已压缩终端上下文') &&
    aiChat.includes('accepts_plain_text_model_answer') &&
    !aiChat.includes('模型返回不是合法 JSON') &&
    aiPanel.includes('错误详情') &&
    aiPanel.includes('chatWithAiProviderStream') &&
    aiPanel.includes('onAiChatStream') &&
    aiPanel.includes("event.kind === 'chunk'") &&
    aiPanel.includes('streaming: true') &&
    aiPanel.includes('handleComposerKeydown') &&
    aiPanel.includes('event.ctrlKey || event.metaKey') &&
    aiPanel.includes('event.isComposing') &&
    aiPanel.includes('scrollMessagesToLatest') &&
    aiPanel.includes('ref="messageList"') &&
    aiPanel.includes('thinking-row') &&
    appShell.includes('updateAiMessage') &&
    aiPanel.includes('parseMessageParts') &&
    aiPanel.includes('extractPrimaryShellCommand') &&
    aiPanel.includes('isDangerousCommand') &&
    aiPanel.includes('window.confirm') &&
    styles.includes('.message.collapsed') &&
    styles.includes('.code-block') &&
    tauri.includes('chatWithAiProvider'),
  'AI assistant must call the Tauri backend with terminal context/history and support compressed context plus model error details.'
)

assert(
    styles.includes('.context-strip') &&
    styles.includes('overflow-x: auto') &&
    styles.includes('.message-body p') &&
    styles.includes('.session-history-popover') &&
    styles.includes('.session-history-row:hover .session-history-actions') &&
    styles.includes('overflow-wrap: anywhere') &&
    styles.includes('white-space: pre-wrap') &&
    styles.includes('grid-template-rows: 58px auto minmax(0, 1fr) auto;') &&
    styles.includes('grid-template-columns: minmax(0, 1fr) var(--icon-size);') &&
    styles.includes('.assistant-compose textarea') &&
    styles.includes('.thinking-row'),
  'Right AI workspace must constrain chips, inputs, and long model text so it does not overflow horizontally.'
)

assert(
  commandHistoryPanel.includes('defineProps') &&
    commandHistoryPanel.includes('commands') &&
    commandHistoryPanel.includes("emit('rerun'"),
  'CommandHistoryPanel must show command history and allow rerunning a command.'
)

assert(
  appShell.includes('class="app-rail"') &&
    appShell.includes("leftPanelMode === 'connections'") &&
    appShell.includes("leftPanelMode === 'settings'") &&
    !appShell.includes('主题') &&
    !appShell.includes('Files') &&
    !appShell.includes('Vaults') &&
    !appShell.includes('Help') &&
    !appShell.includes('class="window-actions"'),
  'AppShell must follow the prototype shell with a narrow useful rail and no fake window controls or dead top action buttons.'
)

assert(
  sidebar.includes('连接管理') &&
    sidebar.includes('新建连接') &&
    sidebar.includes('SSH 连接') &&
    sidebar.includes('SFTP 连接'),
  'ConnectionSidebar must use the prototype labels and SSH/SFTP editor tabs.'
)

assert(
  terminalPane.includes('quick-command-bar') &&
    terminalPane.includes('quickCommands') &&
    terminalPane.includes('terminal-heading') &&
    terminalPane.includes('copyTerminalOutput') &&
    terminalPane.includes('复制终端输出') &&
    !terminalPane.includes('connection-strip') &&
    !terminalPane.includes('连接时长') &&
    !terminalPane.includes('入口域名') &&
    !terminalPane.includes('全屏'),
  'TerminalPane must expose a compact terminal header and quick command bar without the old tall connection summary.'
)

assert(
  workspacePanel.includes('AI 助手') &&
    workspacePanel.includes('命令历史') &&
    workspacePanel.includes('SFTP') &&
    aiConfig.includes('Custom AI Provider') &&
    settingsSidebar.includes('配置菜单') &&
    settingsSidebar.includes('AiConfigPanel') &&
    !aiPanel.includes('AiConfigPanel'),
  'Workspace must use the prototype AI assistant tab labels and AI configuration must live in the left settings menu.'
)

assert(
  tauriConfig.includes('"width": 1280') &&
    tauriConfig.includes('"minWidth": 980') &&
    styles.includes('min-width: 980px') &&
    styles.includes('@media (max-width: 1280px)') &&
    styles.includes('@media (max-width: 1080px)') &&
    styles.includes('position: absolute') &&
    styles.includes('right-panel') &&
    !styles.includes('.app-shell:not(.right-collapsed) .right-panel {\n    display: none;'),
  'Frontend layout must adapt to the 1280 default and 980 minimum Tauri window widths without horizontal clipping.'
)

assert(
  aiConfig.includes('apiKey:') &&
    aiConfig.includes('editorMode === \'edit\'') &&
    settingsSidebar.includes(':editor-mode="editorMode"') &&
    settingsSidebar.includes('新建 AI 配置') &&
    appShell.includes('aiConfigs = ref') &&
    appShell.includes('selectedAiConfigId') &&
    appShell.includes('createAiConfig') &&
    appShell.includes('aiRuntimeApiKeys') &&
    appShell.includes('listAiProviderConfigs') &&
    appShell.includes('saveAiProviderConfig') &&
    appShell.includes('deleteAiProviderConfig') &&
    appShell.includes('aiConfigEditorOpen') &&
    settingsSidebar.includes('modal-backdrop') &&
    settingsSidebar.includes('删除 AI 配置') &&
    settingsSidebar.includes('@save="(config, apiKey) => emit(\'saveAiConfig\', config, apiKey)"') &&
    settingsSidebar.includes('已保存到 SQLite') &&
    schema.includes('api_key TEXT') &&
    sqlite.includes('api_key = excluded.api_key') &&
    workspacePanel.includes(':api-key="apiKey"') &&
    aiConfig.includes("emit('save', { ...draft, id, apiKey, apiKeyRef }, apiKey)") &&
    aiPanelUsesBackendModelCall(),
  'AI configuration must support multiple SQLite-backed configs and AiPanel must call the configured model through the Tauri backend instead of using only local rules.'
)

function aiPanelUsesBackendModelCall() {
  const aiPanel = read('src/components/AiPanel.vue')
  return (
    aiPanel.includes('chatWithAiProvider') &&
    tauri.includes("invoke<AiChatResponse>('chat_with_ai_provider'") &&
    aiChat.includes('chat/completions') &&
    aiChat.includes('Authorization') &&
    aiPanel.includes('isAsking') &&
    aiPanel.includes('error = false') &&
    tauri.includes("invoke<AiChatResponse>('chat_with_ai_provider_stream'") &&
    tauri.includes('onAiChatStream') &&
    aiPanel.includes('extractPrimaryShellCommand')
  )
}

console.log('production-ui-check passed')
