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
const scriptPanel = read('src/components/ScriptPanel.vue')
const sidebar = read('src/components/ConnectionSidebar.vue')
const settingsSidebar = read('src/components/SettingsSidebar.vue')
const tauri = read('src/lib/tauri.ts')
const workspacePanel = read('src/components/WorkspacePanel.vue')
const commandHistoryPanel = read('src/components/CommandHistoryPanel.vue')
const contextMenu = read('src/components/ContextMenu.vue')
const styles = read('src/styles.css')
const indexHtml = read('index.html')
const tauriConfig = read('../src-tauri/tauri.conf.json')
const sqlite = read('../src-tauri/src/domain/storage/sqlite.rs')
const schema = read('../src-tauri/src/domain/storage/schema.sql')
const aiChat = read('../src-tauri/src/domain/ai/chat.rs')
const sftpBackend = read('../src-tauri/src/domain/connection/sftp.rs')
const commands = read('../src-tauri/src/app/commands.rs')
function cssRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = styles.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`))
  return match?.[1] ?? ''
}

function assertCssRuleIncludes(selector, snippets, message) {
  const rule = cssRule(selector)
  assert(snippets.every((snippet) => rule.includes(snippet)), message)
}

assertCssRuleIncludes(
  '.assistant-panel',
  ['flex: 1 1 auto;', 'min-height: 0;', 'overflow: hidden;'],
  'AI assistant panel must constrain the message list so long chats scroll instead of stretching the workspace.'
)

assertCssRuleIncludes(
  '.message-list',
  ['overflow-y: auto;', 'overflow-x: hidden;', 'overscroll-behavior: contain;'],
  'AI message list must own vertical scrolling and keep long chats readable.'
)

assertCssRuleIncludes(
  '.message-list',
  ['display: flex;', 'flex-direction: column;'],
  'AI message list must stack messages by content height so extra messages overflow into scrolling instead of shrinking each card.'
)

assertCssRuleIncludes(
  '.message',
  ['flex: 0 0 auto;', 'height: auto;'],
  'AI message cards must keep their natural height when the conversation grows.'
)

assert(
  aiPanel.includes('collapsedMessages') &&
    aiPanel.includes('function isMessageCollapsed') &&
    aiPanel.includes('collapsed: isMessageCollapsed(message)') &&
    !aiPanel.includes('collapsed: !isMessageExpanded(message)'),
  'AI messages must be expanded by default; only messages collapsed by the user should be compact.'
)

assert(
  !aiPanel.includes('executeGeneratedCommand()') &&
    !aiPanel.includes('executableCommands(message)') &&
    aiPanel.includes('v-if="isShellLanguage(part.language) && normalizeShellCommand(part.content)"') &&
    aiPanel.includes("['bash', 'sh', 'shell', 'zsh']") &&
    !aiPanel.includes("['bash', 'sh', 'shell', 'zsh', '']"),
  'AI execute buttons must only appear on explicit bash/shell code blocks, not panel or message-level controls.'
)

assert(
  sftpBackend.includes('fn terminate_sftp_process') &&
    sftpBackend.includes('SFTP_CHILD_EXIT_GRACE') &&
    !sftpBackend.includes('let _ = process.child.wait();'),
  'SFTP backend must not block indefinitely while waiting for killed child processes; failed auth, cancel, and timeout paths must return so the UI clears loading.'
)
assert(
  sftpBackend.includes('fn sftp_line_ending()') &&
    sftpBackend.includes('cfg!(windows)') &&
    sftpBackend.includes('should_send_sftp_commands') &&
    sftpBackend.includes('connected to ') &&
    sftpBackend.includes('SFTP_READY_GRACE'),
  'SFTP backend must handle Windows OpenSSH PTY differences: CRLF input and readiness fallback instead of relying only on a visible sftp> prompt.'
)
assert(
  sftpBackend.includes('terminal_status_response') &&
    sftpBackend.includes('"\\x1b[6n"') &&
    sftpBackend.includes('b"\\x1b[1;1R"'),
  'SFTP backend must answer Windows OpenSSH cursor-position requests (ESC[6n) so sftp.exe does not hang in the PTY.'
)
assert(
  commands.includes('SFTP_COMMAND_TIMEOUT') &&
    commands.includes('tokio::time::timeout') &&
    commands.includes('SFTP directory listing timed out') &&
    commands.includes('token.store(true'),
  'SFTP directory listing command must have a Tauri-level hard timeout so the frontend never stays stuck on loading when Windows sftp.exe or PTY hangs.'
)
assert(
  sftpBackend.includes('const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);') &&
    commands.includes('const SFTP_COMMAND_TIMEOUT: Duration = Duration::from_secs(45);'),
  'SFTP backend command timeout must fire before the Tauri-level hard timeout so failures include captured sftp.exe output.'
)
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
  terminalPane.includes('dataDisposable = terminal.onData((data) => {') &&
    terminalPane.includes('void terminalWrite(sessionId, data)') &&
    !terminalPane.includes('dataDisposable = terminal.onData((data) => {\n    terminal?.write(data)'),
  'TerminalPane must not echo keyboard input locally when there is no backend session.'
)


assert(
  terminalPane.includes('stripCommandInputControlSequences(data)') &&
    terminalPane.includes('skipInputControlSequence') &&
    terminalPane.includes('pendingInputControlSequence') &&
    terminalPane.includes('isPendingCsiInputSequence') &&
    terminalPane.includes("pendingInputControlSequence.startsWith('\\x1b[')") &&
    terminalPane.includes('isPendingCsiInputSequence && pendingInputControlSequence.length > 2 && code >= 0x40 && code <= 0x7e') &&
    terminalPane.includes('!isPendingCsiInputSequence && code >= 0x40 && code <= 0x7e') &&
    terminalPane.includes("char === '\\x1b'") &&
    terminalPane.includes('code >= 0x40 && code <= 0x7e') &&
    terminalPane.includes('const commandInput = stripCommandInputControlSequences(data)'),
  'TerminalPane command history must strip full CSI terminal control sequences such as ESC[5;1R, ESC[I, and ESC[O before recording commands.'
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
    fileTransfer.includes('sftpListDirectory') &&
    fileTransfer.includes('sftpUploadFile') &&
    fileTransfer.includes('sftpUploadPath') &&
    fileTransfer.includes('sftpDownloadFile') &&
    fileTransfer.includes('sftpDownloadPath') &&
    fileTransfer.includes('sftpDeletePath') &&
    fileTransfer.includes('localHomeDirectory') &&
    fileTransfer.includes('localListDirectory') &&
    fileTransfer.includes('localEntries') &&
    fileTransfer.includes('selectedLocalEntry') &&
    fileTransfer.includes('selectedRemoteEntry') &&
    fileTransfer.includes('openLocalFileLocation') &&
    fileTransfer.includes('openLocalContextMenu') &&
    fileTransfer.includes('openRemoteContextMenu') &&
    fileTransfer.includes('fileContextMenu') &&
    fileTransfer.includes('file-type-icon') &&
    fileTransfer.includes('cancelTask') &&
    fileTransfer.includes('activeTask') &&
    fileTransfer.includes('cancelActiveTask') &&
    fileTransfer.includes('sftpProbe') &&
    fileTransfer.includes('sftpProbeByHost') &&
    fileTransfer.includes('probeSelectedTarget') &&
    fileTransfer.includes('probeBastionServers') &&
    fileTransfer.includes('selectedTarget') &&
    fileTransfer.includes("transferMode = ref<'sftp' | 'terminal'>") &&
    fileTransfer.includes('uploadFilesThroughTerminal') &&
    fileTransfer.includes('downloadThroughTerminal') &&
    fileTransfer.includes('identifyCurrentTerminalTarget') &&
    fileTransfer.includes('currentTerminalTarget') &&
    fileTransfer.includes('useTerminalTargetForSftp') &&
    fileTransfer.includes('writeTerminalInput') &&
    fileTransfer.includes('remoteReady') &&
    tauri.includes("invoke<LocalDirectoryResponse>('local_list_directory'") &&
    tauri.includes("invoke<boolean>('cancel_task'") &&
    tauri.includes("invoke<SftpListResponse>('sftp_list_directory'") &&
    tauri.includes("invoke<SftpTransferResponse>('sftp_upload_path'") &&
    tauri.includes("invoke<SftpTransferResponse>('sftp_download_path'") &&
    tauri.includes("invoke<SftpProbeResponse>('sftp_probe'") &&
    tauri.includes("invoke<BastionServerCandidate[]>('probe_bastion_servers'") &&
    styles.includes('.sftp-workbench-active .right-panel') &&
    styles.includes('grid-column: 3 / 5;') &&
    styles.includes('grid-template-columns: minmax(320px, 1fr) minmax(320px, 1fr);') &&
    styles.includes('.file-type-icon.folder') &&
    styles.includes('.file-context-menu') &&
    appShell.includes('sftpWorkbenchActive') &&
    appShell.includes('isSftpProfile(profile)') &&
    appShell.includes("workspacePanelTab.value = 'sftp'") &&
    workspacePanel.includes('workspaceTabChanged') &&
    workspacePanel.includes('@write-terminal-input=') &&
    terminalPane.includes('writeTerminalInput') &&
    terminalPane.includes('enterSftpProfileMode') &&
    terminalPane.includes('SFTP profile is ready') &&
    !fileTransfer.includes('profile ? `Ready'),
  'FileTransferPanel must expose real SFTP, bastion target discovery, and terminal-channel small-file transfer flows without treating a selected profile draft as an active remote transfer session.'
)

assert(
  fileTransfer.includes('lastTransfer') &&
    fileTransfer.includes('transfer-target-strip') &&
    fileTransfer.includes('transfer-progress') &&
    fileTransfer.includes('openLastTransferLocation') &&
    fileTransfer.includes('copyLastTransferPath') &&
    fileTransfer.includes('joinLocalPath') &&
    fileTransfer.includes('onSftpTransferProgress') &&
    tauri.includes('localPath?: string') &&
    tauri.includes('remotePath?: string') &&
    tauri.includes('targetPath?: string') &&
    tauri.includes('onSftpTransferProgress') &&
    styles.includes('.transfer-target-strip') &&
    styles.includes('.transfer-progress') &&
    styles.includes('@keyframes transfer-progress-slide') &&
    sftpBackend.includes('SftpProgressUpdate') &&
    sftpBackend.includes('extract_sftp_progress_percent') &&
    sftpBackend.includes('download_target_path') &&
    commands.includes('SftpTransferEvent') &&
    commands.includes('upload_path_with_progress') &&
    commands.includes('download_path_with_progress'),
  'SFTP file and folder transfers must show clear local/remote targets, progress, final paths, and actions to locate or copy completed downloads/uploads.'
)
assert(
  appShell.includes('draftWorkspaceSessionIds') &&
    appShell.includes('createDraftWorkspaceSession') &&
    appShell.includes('ensurePersistedWorkspaceSession') &&
    appShell.includes('preferredWorkspaceSessionForConnection') &&
    appShell.includes('persistWorkspaceSessionForMessage') &&
    appShell.includes('saveCommandHistoryForTerminal') &&
    appShell.includes('const tab = terminalTabs.value.find((item) => item.id === event.terminalId)') &&
    appShell.includes('await ensurePersistedWorkspaceSession(entry.connectionId, entry.workspaceSessionId') &&
    appShell.includes('connectProfileFromSidebar') &&
    !appShell.includes('const session = await createWorkspaceSession(profile.id)'),
  'Workspace sessions must start as frontend drafts, persist only when data exists, and command history must be saved with the emitting terminal connection/session.'
)

assert(
  scriptPanel.includes("type ScriptPanelMode = 'library' | 'generate'") &&
    scriptPanel.includes('scriptPanelMode') &&
    scriptPanel.includes('showScriptComposer') &&
    scriptPanel.includes("scriptPanelMode.value === 'generate' && recordingHasData.value") &&
    scriptPanel.includes('openGenerateMode') &&
    scriptPanel.includes('openLibraryMode') &&
    scriptPanel.includes('selectedScriptContent') &&
    scriptPanel.includes('class="script-mode-tabs"') &&
    scriptPanel.includes('class="script-library"') &&
    scriptPanel.includes('class="script-preview"') &&
    scriptPanel.includes('v-if="showScriptComposer"') &&
    scriptPanel.includes("v-if=\"scriptPanelMode === 'library'\"") &&
    styles.includes('.script-mode-tabs') &&
    styles.includes('.script-library') &&
    styles.includes('.script-preview') &&
    styles.includes('.script-preview-code'),
  'Script assistant must separate library lookup from recorded script generation, hiding the user prompt while browsing saved scripts.'
)

assert(
  sidebar.includes('v-model="selectedProfile.gateway.host"') &&
    sidebar.includes('v-model="selectedProfile.gateway.username"') &&
    sidebar.includes('v-model.number="selectedProfile.gateway.port"') &&
    sidebar.includes('v-model="selectedProfile.target.host"') &&
    sidebar.includes('v-model="selectedProfile.target.username"') &&
    sidebar.includes('v-model.number="selectedProfile.target.port"'),
  'ConnectionSidebar must let users edit gateway and target connection fields after creating a profile.'
)

assert(
  sidebar.includes('v-model="selectedProfile.gateway.password"') &&
    sidebar.includes('v-model="selectedProfile.target.password"') &&
    sidebar.includes('type="password"') &&
    sidebar.includes('v-model="selectedProfile.gateway.authMode"') &&
    sidebar.includes('v-model="selectedProfile.target.authMode"') &&
    appShell.includes("password: ''"),
  'ConnectionSidebar must let users save plaintext SSH passwords for gateway and target endpoints.'
)

assert(
  sidebar.includes('value="direct"') &&
    sidebar.includes('value="interactive-menu"') &&
    sidebar.includes('sftp-direct') &&
    sidebar.includes('sftp-gateway'),
  'ConnectionSidebar must expose a direct SSH mode and a bastion interactive-menu mode.'
)

assert(
  sidebar.includes('function isSftpProfile') &&
    sidebar.includes('function needsGateway') &&
    sidebar.includes('function needsMenuProfile') &&
    sidebar.includes('setConnectionEditorType') &&
    sidebar.includes('setSftpRoute') &&
    sidebar.includes("profile.fileTransferMode = 'auto'") &&
    sidebar.includes("profile.fileTransferMode = profile.jumpMode === 'interactive-menu' ? 'sftp-gateway' : 'sftp-direct'") &&
    sidebar.includes('v-if="needsGateway(selectedProfile)"') &&
    sidebar.includes('v-if="needsMenuProfile(selectedProfile)"') &&
    sidebar.includes('v-model="selectedProfile.menuProfileId"'),
  'ConnectionSidebar must support real SSH/SFTP editor modes and only require menu fields for interactive SSH profiles.'
)

assert(
  sidebar.includes("emit('save'") &&
    sidebar.includes('modal-backdrop') &&
    sidebar.includes('role="dialog"') &&
    appShell.includes('@save="saveSelectedProfile"'),
  'ConnectionSidebar must provide a modal save action wired to profile persistence.'
)

assert(
  sidebar.includes("connect: [profileId: string]") &&
    sidebar.includes('@dblclick=') &&
    sidebar.includes('@click.stop=') &&
    sidebar.includes("emit('connect', profile.id)") &&
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
    sidebar.includes('openMenu') &&
    settingsSidebar.includes('openMenu') &&
    styles.includes('.context-menu'),
  'The client UI must provide custom right-click context menus for connections, AI configs, and terminal surfaces.'
)

assert(
  !appShell.includes('structuredClone(') &&
    appShell.includes('cloneConnectionProfile') &&
    appShell.includes('connectionDraft') &&
    appShell.includes('connectingProfileId') &&
    appShell.includes('connectionError') &&
    sidebar.includes('connectingProfileId') &&
    sidebar.includes('connectionError'),
  'Connection flow must safely clone Vue profile objects and show visible connecting/error feedback.'
)

assert(
  !appShell.includes('@click="connectSelectedProfile"') &&
    !appShell.includes('@click="saveSelectedProfile"'),
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
    appShell.includes('await saveConnectionProfile(normalizedProfile)') &&
    appShell.includes('await deleteConnectionProfile(profileId)') &&
    sidebar.includes("delete: [profileId: string]") &&
    sidebar.includes("emit('save'") &&
    sidebar.includes("emit('delete'") &&
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
    appShell.includes('toggleConnectionsPanel') &&
    appShell.includes('toggleSettingsPanel') &&
    appShell.includes('isLeftPanelActive') &&
    appShell.includes('leftPanelButtonTitle') &&
    !appShell.includes('sidebar-collapse-button') &&
    !styles.includes('.sidebar-collapse-button') &&
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
  workspacePanel.includes("activeWorkspaceTab = ref<'history' | 'ai' | 'scripts' | 'sftp'>") &&
    workspacePanel.includes("activeWorkspaceTab === 'history'") &&
    workspacePanel.includes("activeWorkspaceTab === 'ai'") &&
    workspacePanel.includes("activeWorkspaceTab === 'scripts'") &&
    workspacePanel.includes("activeWorkspaceTab === 'sftp'") &&
    workspacePanel.includes('selectWorkspaceSession') &&
    workspacePanel.includes('createWorkspaceSession') &&
    workspacePanel.includes('renameWorkspaceSession') &&
    workspacePanel.includes('deleteWorkspaceSession') &&
    aiPanel.includes('session-history-popover') &&
    aiPanel.includes('historyPopover') &&
    aiPanel.includes('historyButton') &&
    aiPanel.includes('handleDocumentPointerDown') &&
    aiPanel.includes("document.addEventListener('pointerdown'") &&
    aiPanel.includes('filteredSessions') &&
    aiPanel.includes('sessionSearch') &&
    aiPanel.includes("emit('createSession')") &&
    aiPanel.includes("emit('renameSession'") &&
    aiPanel.includes('openRenameSessionDialog') &&
    aiPanel.includes('submitRenameSession') &&
    aiPanel.includes('rename-modal') &&
    !aiPanel.includes('window.prompt') &&
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
    terminalPane.includes('terminalSelection:') &&
    terminalPane.includes('commandRecorded:') &&
    terminalPane.includes('defineExpose') &&
    terminalPane.includes('executeCommand') &&
    terminalPane.includes('onSelectionChange') &&
    terminalPane.includes('getSelectionPosition') &&
    terminalPane.includes('copySelectionToClipboard') &&
    terminalPane.includes('pasteClipboardToTerminal') &&
    terminalPane.includes("@tauri-apps/api/clipboard") &&
    terminalPane.includes('readClipboardText') &&
    terminalPane.includes('writeClipboardText') &&
    terminalPane.includes("addEventListener('pointerdown', handleTerminalPointerDown, true)") &&
    terminalPane.includes("addEventListener('contextmenu', handleTerminalContextMenu, true)") &&
    terminalPane.includes('requestTerminalPaste') &&
    appShell.includes('terminalSelections') &&
    appShell.includes('updateTerminalSelection'),
  'TerminalPane must expose terminal output, selection context, command history events, selection auto-copy, right-click paste, and an executeCommand bridge.'
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
    workspacePanel.includes(':terminal-selection="terminalSelection"') &&
    workspacePanel.includes(':command-history="commandHistory"') &&
    workspacePanel.includes(':workspace-session-id="workspaceSessionId"') &&
    workspacePanel.includes('@execute-command=') &&
    appShell.includes('executeCommandOnActiveTerminal'),
  'AI workspace must receive current terminal content and command history and be able to execute generated commands in the active terminal.'
)

assert(
  aiPanel.includes('chatWithAiProvider') &&
    aiPanel.includes('terminalSnapshot,') &&
    aiPanel.includes('terminalSelection?: TerminalSelectionEvent') &&
    aiPanel.includes('selectedTerminalContext') &&
    aiPanel.includes('formatSelectedLineRange') &&
    aiPanel.includes('buildQuestionWithSelectedTerminalText') &&
    aiPanel.includes('selected-terminal-note') &&
    !aiPanel.includes('selected-context-chip') &&
    !styles.includes('.selected-context-chip') &&
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
    tauri.includes("invoke<UpdateScript[]>('list_update_scripts'") &&
    tauri.includes("invoke<void>('save_update_script'") &&
    tauri.includes("invoke<boolean>('delete_update_script'") &&
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
    aiChat.includes('accepts_plain_text_model_answer') &&
    aiPanel.includes('chatWithAiProviderStream') &&
    aiPanel.includes('cancelTask') &&
    aiPanel.includes('stopCurrentAnswer') &&
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
  workspacePanel.includes('ScriptPanel') &&
    workspacePanel.includes("activeWorkspaceTab === 'scripts'") &&
    workspacePanel.includes('@write-terminal-input="emit(\'writeTerminalInput\', $event)"') &&
    workspacePanel.includes('@start-recording="emit(\'startScriptRecording\')"') &&
    workspacePanel.includes('@stop-recording="emit(\'stopScriptRecording\')"') &&
    appShell.includes('scriptRecordingsByTerminal') &&
    appShell.includes('startScriptRecording') &&
    appShell.includes('stopScriptRecording') &&
    appShell.includes('appendRecordingOutput') &&
    appShell.includes('appendRecordingCommand') &&
    scriptPanel.includes('sendScriptRequest') &&
    scriptPanel.includes('script-history-popover') &&
    scriptPanel.includes('historyPopover') &&
    scriptPanel.includes('historyButton') &&
    scriptPanel.includes('handleDocumentPointerDown') &&
    scriptPanel.includes("document.addEventListener('pointerdown'") &&
    scriptPanel.includes('loadSelectedScript') &&
    scriptPanel.includes('toggleScriptEditor') &&
    scriptPanel.includes('saveMessageScript') &&
    scriptPanel.includes('openRenameScriptDialog') &&
    scriptPanel.includes('renameScript') &&
    scriptPanel.includes('scriptNameDraft') &&
    !scriptPanel.includes('window.prompt') &&
    scriptPanel.includes('generateAiScriptTitle') &&
    scriptPanel.includes('generateScriptTitle') &&
    scriptPanel.includes('isAutoScriptName') &&
    scriptPanel.includes('executeMessageScript') &&
    scriptPanel.includes('buildScriptPrompt') &&
    scriptPanel.includes('MAX_SCRIPT_SOURCE_COMMANDS') &&
    scriptPanel.includes('recordedOutput') &&
    scriptPanel.includes('chatWithAiProviderStream') &&
    scriptPanel.includes('cancelTask') &&
    scriptPanel.includes('stopScriptGeneration') &&
    scriptPanel.includes('onAiChatStream') &&
    scriptPanel.includes('extractBashScript') &&
    scriptPanel.includes('saveUpdateScript') &&
    scriptPanel.includes('deleteUpdateScript') &&
    scriptPanel.includes('loadPreviewScripts') &&
    scriptPanel.includes('localStorage') &&
    scriptPanel.includes('bash -s <<') &&
    scriptPanel.includes('isDangerousScript') &&
    scriptPanel.includes('window.confirm') &&
    schema.includes('CREATE TABLE IF NOT EXISTS update_scripts') &&
    sqlite.includes('pub fn save_update_script') &&
    sqlite.includes('pub fn list_update_scripts') &&
    tauri.includes("invoke<AiScriptTitleResponse>('generate_ai_script_title'") &&
    aiChat.includes('generate_script_title') &&
    styles.includes('.script-panel') &&
    styles.includes('.script-recorder') &&
    styles.includes('.script-chat-list') &&
    styles.includes('.script-history-popover') &&
    styles.includes('.script-code-card textarea') &&
    !scriptPanel.includes('script-result-editor'),
  'Workspace must include recording-backed script generation with a chat interaction, session-style script library, in-card editing, deletion, and guarded execution.'
)

assert(
    styles.includes('.context-strip') &&
    styles.includes('flex-wrap: wrap') &&
    styles.includes('overflow: hidden auto') &&
    styles.includes('.message-body p') &&
    styles.includes('.session-history-popover') &&
    styles.includes('.session-history-row:hover .session-history-actions') &&
    styles.includes('.rename-modal') &&
    styles.includes('.rename-field') &&
    styles.includes('overflow-wrap: anywhere') &&
    styles.includes('white-space: pre-wrap') &&
    styles.includes('grid-template-rows: 58px auto minmax(0, 1fr) auto;') &&
    styles.includes('.assistant-compose textarea') &&
    styles.includes('padding-right: calc(var(--icon-size) + 20px);') &&
    styles.includes('.assistant-compose .icon-button') &&
    styles.includes('right: calc(var(--composer-pad-x) + 8px);') &&
    styles.includes('bottom: calc(var(--composer-pad-bottom) + 8px);') &&
    !styles.includes('grid-template-columns: minmax(0, 1fr) var(--icon-size);') &&
    styles.includes('.workspace-tabs button') &&
    styles.includes('.selected-terminal-note') &&
    styles.includes('.thinking-row'),
  'Right AI workspace must constrain chips, inputs, and long model text so it does not overflow horizontally.'
)

assert(
  commandHistoryPanel.includes('defineProps') &&
    commandHistoryPanel.includes('commands') &&
    commandHistoryPanel.includes('MAX_VISIBLE_COMMANDS = 100') &&
    commandHistoryPanel.includes('visibleCommands') &&
    commandHistoryPanel.includes('historySearch') &&
    commandHistoryPanel.includes('copyCommand') &&
    commandHistoryPanel.includes('expandedCommandIds') &&
    commandHistoryPanel.includes('isLongCommand') &&
    commandHistoryPanel.includes("emit('rerun'") &&
    styles.includes('.history-toolbar') &&
    styles.includes('.history-meta') &&
    styles.includes('.history-row.expanded') &&
    styles.includes('.history-actions'),
  'CommandHistoryPanel must cap visible command history, support search, copy, long-command expansion, and allow rerunning a command.'
)

assert(
  appShell.includes('const COMMAND_HISTORY_CACHE_LIMIT = 300') &&
    appShell.includes('.slice(-COMMAND_HISTORY_CACHE_LIMIT)') &&
    sqlite.includes('const COMMAND_HISTORY_RETENTION_LIMIT: i64 = 1000;') &&
    sqlite.includes('prune_command_history') &&
    sqlite.includes('DELETE FROM command_history') &&
    aiPanel.includes('const MAX_AI_COMMAND_HISTORY = 80') &&
    aiPanel.includes('.slice(-MAX_AI_COMMAND_HISTORY)'),
  'Command history must be bounded: database keeps a finite recent window, frontend cache stays capped, and AI only receives recent useful commands.'
)

assert(
  appShell.includes('class="app-rail"') &&
    appShell.includes('toggleConnectionsPanel') &&
    appShell.includes('toggleSettingsPanel') &&
    appShell.includes("isLeftPanelActive('connections')") &&
    appShell.includes("isLeftPanelActive('settings')") &&
    !appShell.includes('Files') &&
    !appShell.includes('Vaults') &&
    !appShell.includes('Help') &&
    !appShell.includes('class="window-actions"'),
  'AppShell must follow the prototype shell with a narrow useful rail and no fake window controls or dead top action buttons.'
)

assert(
  indexHtml.includes('href="/icon.svg"') &&
    indexHtml.includes('href="/icon.png"') &&
    appShell.includes('class="brand-mark"') &&
    appShell.includes('src="/icon.svg"') &&
    styles.includes('.brand-mark') &&
    styles.includes('object-fit: contain') &&
    tauriConfig.includes('"icons/32x32.png"') &&
    tauriConfig.includes('"icons/128x128.png"') &&
    tauriConfig.includes('"icons/128x128@2x.png"') &&
    tauriConfig.includes('"icons/icon-512.png"') &&
    tauriConfig.includes('"icons/icon.png"'),
  'Project icon must be wired into the browser favicon, app chrome, and Tauri icon config.'
)

assert(
  sidebar.includes('class="section-head"') &&
    sidebar.includes("emit('create')") &&
    sidebar.includes('selectedProfile.jumpMode') &&
    sidebar.includes('selectedProfile.fileTransferMode') &&
    sidebar.includes('sftp-direct') &&
    sidebar.includes('sftp-gateway') &&
    sidebar.includes('setSftpRoute') &&
    sidebar.includes('isSftpProfile'),
  'ConnectionSidebar must use the prototype labels and provide real SSH/SFTP editor tabs.'
)

assert(
  terminalPane.includes('quick-command-bar') &&
    terminalPane.includes('quickCommands') &&
    terminalPane.includes('terminal-heading') &&
    terminalPane.includes('copyTerminalOutput') &&
    !terminalPane.includes('connection-strip'),
  'TerminalPane must expose a compact terminal header and quick command bar without the old tall connection summary.'
)

assert(
  workspacePanel.includes("activeWorkspaceTab === 'ai'") &&
    workspacePanel.includes("activeWorkspaceTab === 'history'") &&
    workspacePanel.includes("activeWorkspaceTab === 'scripts'") &&
    workspacePanel.includes('SFTP') &&
    aiConfig.includes('Custom AI Provider') &&
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
    aiConfig.includes("editorMode === 'edit'") &&
    settingsSidebar.includes(':editor-mode="editorMode"') &&
    appShell.includes('aiConfigs = ref') &&
    appShell.includes('selectedAiConfigId') &&
    appShell.includes('createAiConfig') &&
    appShell.includes('aiRuntimeApiKeys') &&
    appShell.includes('listAiProviderConfigs') &&
    appShell.includes('saveAiProviderConfig') &&
    appShell.includes('deleteAiProviderConfig') &&
    appShell.includes('aiConfigEditorOpen') &&
    settingsSidebar.includes('modal-backdrop') &&
    settingsSidebar.includes('settings-card-head') &&
    settingsSidebar.includes('settings-card-main') &&
    settingsSidebar.includes('@save="(config, apiKey) => emit(\'saveAiConfig\', config, apiKey)"') &&
    styles.includes('.settings-card-head') &&
    styles.includes('.settings-card-main') &&
    styles.includes('.settings-card .card-actions') &&
    styles.includes('grid-template-columns: repeat(2, 26px);') &&
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

assert(
  sidebar.includes('v-model.number="selectedProfile.gateway.port"') &&
    sidebar.includes('v-model.number="selectedProfile.target.port"') &&
    sidebar.includes('type="number"') &&
    appShell.includes('normalizeConnectionProfileForSave') &&
    appShell.includes('normalizePort('),
  'Connection editor must expose SSH port fields and normalize them before saving.'
)

assert(
  !sidebar.includes('@click.self="emit(\'closeEditor\')"') &&
    !settingsSidebar.includes('@click.self="emit(\'closeAiConfig\')"'),
  'Connection and AI config modals must stay open when clicking outside the dialog.'
)

assert(
  sidebar.includes('shouldShowTargetPassword') &&
    sidebar.includes('targetPasswordLabel') &&
    sidebar.includes('\\u670d\\u52a1\\u5668\\u5bc6\\u7801\\uff08\\u53ef\\u9009\\uff09') &&
    appShell.includes("normalized.jumpMode === 'interactive-menu'") &&
    appShell.includes('normalized.target.password = undefined'),
  'Interactive-menu bastion profiles must treat the internal server password as optional and avoid saving or auto-submitting it when blank.'
)
console.log('production-ui-check passed')
