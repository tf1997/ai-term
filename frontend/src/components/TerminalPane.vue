<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { IDisposable } from '@xterm/xterm'
import { readText as readClipboardText, writeText as writeClipboardText } from '@tauri-apps/api/clipboard'
import '@xterm/xterm/css/xterm.css'
import {
  connectProfile,
  connectLocalTerminal,
  forgetAiTermKnownHost,
  disconnectTerminal,
  onTerminalClosed,
  onTerminalData,
  saveConnectionProfile,
  terminalResize,
  terminalSessionActive,
  terminalWrite
} from '../lib/tauri'
import type { AuthEndpoint, ConnectionProfile } from '../types/profile'
import type {
  CommandHistoryEntry,
  CommandRecordedEvent,
  TerminalInputEvent,
  TerminalInputSyncState,
  TerminalInputWriteFailureEvent,
  TerminalInputWriteSource,
  TerminalOutputEvent,
  TerminalSelectionEvent
} from '../types/workspace'
import { isSensitiveCommand } from '../lib/commandPrivacy'
import { attachShellIntegration, type AttachedShellIntegration } from '../lib/shellIntegration'
import { scriptRiskStatusForContent } from '../lib/scriptRisk'
import { isWindowsPlatform } from '../utils/platform'
import UiIcon from './UiIcon.vue'

const terminalTypographyOptions = isWindowsPlatform()
  ? { lineHeight: 1.18, letterSpacing: 0, fontWeight: '400' as const, fontWeightBold: '600' as const }
  : { lineHeight: 1, letterSpacing: 0, fontWeight: 'normal' as const, fontWeightBold: 'bold' as const }

type TerminalRuntimeStatus = 'idle' | 'connecting' | 'local' | 'remote' | 'sftp' | 'preview' | 'error'
type TerminalSessionKind = 'local' | 'remote' | 'sftp' | 'preview'
type CompletionSuggestionSource = 'pinned' | 'system' | 'history' | 'session'
type PinQuickCommandResult = 'added' | 'exists' | 'invalid' | 'limit'
type TerminalTheme = 'midnight' | 'matrix' | 'light'
type TerminalInputTrackResult = 'idle' | 'changed' | 'submitted'
type TerminalInputContext = 'shell' | 'sensitive' | 'unknown'
type TerminalCommandReadiness = 'ready' | 'line-busy' | 'shell-busy' | 'unavailable'

interface TerminalVisualSettings {
  terminalFontFamily: string
  terminalFontSize: number
  terminalTheme: TerminalTheme
}

interface TerminalInputBatch {
  generation: number
  sessionId: string
  data: string
  source: TerminalInputWriteSource
  sourceTerminalId?: string
  commits: Array<() => void>
}

interface PendingTerminalInput {
  generation: number
  data: string
}

interface DeferredCommandCapture {
  promptText: string
  startLine: number
}

interface PreparedTerminalInputOptions {
  source: TerminalInputWriteSource
  sourceTerminalId?: string
  submittedCommands?: readonly string[]
  onWritten?: () => void
}

type ShellPromptKind = 'powershell' | 'cmd' | 'posix' | 'generic' | 'bare'

interface ShellPromptSignature {
  kind: ShellPromptKind
  identity: string
  sigil: string
}

interface SshHostKeyTarget {
  host: string
  port: number
  label: string
}
interface CompletionSuggestion {
  command: string
  source: CompletionSuggestionSource
  count?: number
}

interface QuickCommandsChangedDetail {
  storageKey: string
  commands: string[]
}

const props = defineProps<{
  terminalId: string
  active: boolean
  profile?: ConnectionProfile
  connectRequest: number
  commandHistory: CommandHistoryEntry[]
  terminalSettings?: TerminalVisualSettings
  appTheme?: 'dark' | 'light'
}>()

const emit = defineEmits<{
  terminalOutput: [event: TerminalOutputEvent]
  terminalSelection: [event: TerminalSelectionEvent]
  terminalInput: [event: TerminalInputEvent]
  terminalInputWriteFailed: [event: TerminalInputWriteFailureEvent]
  commandRecorded: [event: CommandRecordedEvent]
  statusChanged: [terminalId: string, status: TerminalRuntimeStatus]
  profileUpdated: [profileId: string]
}>()

const terminalHost = ref<HTMLDivElement | null>(null)
const terminalBodyWrap = ref<HTMLDivElement | null>(null)
const terminalCompletion = ref<HTMLDivElement | null>(null)
const quickCommandSettingsButton = ref<HTMLButtonElement | null>(null)
let terminal: Terminal | undefined
let fitAddon: FitAddon | undefined
let sessionId = ''
let connectionAttempt = 0
let unlisten: (() => void) | undefined
let unlistenClosed: (() => void) | undefined
let resizeObserver: ResizeObserver | undefined
// Leave one cell unused so fractional font metrics and a stable scrollbar gutter
// cannot clip the glyph rendered in the last PTY column.
const TERMINAL_SAFE_COLUMN_MARGIN = 1
let terminalFitFrame = 0
let forcePtyResizeOnNextFit = false
let dataDisposable: IDisposable | undefined
let selectionDisposable: IDisposable | undefined
let terminalSelectionNormalizing = false
let terminalOutputBuffer = ''
let terminalOutputRecentTail = ''
let terminalOutputEmitTimer: number | undefined
const TERMINAL_OUTPUT_EMIT_INTERVAL = 200
const TERMINAL_OUTPUT_BUFFER_LIMIT = 1_500_000
const TERMINAL_OUTPUT_TAIL_LIMIT = 4_000
let selectionCopyTimer: number | undefined
const SELECTION_COPY_DEBOUNCE = 150
let inputCommandBuffer = ''
let inputCommandCursor = 0
let inputCommandReliable = true
let lastTrackedUserInputAt = 0
let terminalInputContext: TerminalInputContext = 'unknown'
let shellPromptText = ''
let shellPromptSignature: ShellPromptSignature | undefined
let shellPromptDiscoveryOpen = true
let shellCommandAwaitingPrompt = false
let terminalWasInAlternateBuffer = false
let pendingTrackedCommands: string[] = []
let pendingDeferredCommandCaptures: DeferredCommandCapture[] = []
let completionDebounceTimer: number | undefined
let completionSuppressedForHistoryNavigation = false
let shellIntegrationAttachment: AttachedShellIntegration | undefined
let pendingInputControlSequence = ''
let terminalInputGeneration = 0
let terminalInputReady = false
let failedTerminalInputGeneration: number | undefined
const terminalInputQueue: TerminalInputBatch[] = []
const terminalInputPumpGenerations = new Set<number>()
const pendingPreReadyTerminalInput: PendingTerminalInput[] = []
const PRE_READY_INPUT_LIMIT = 64 * 1024
let pendingPreReadyTerminalInputSize = 0
const pendingTerminalProtocolResponses: string[] = []
const deferredCommandCaptureTimers = new Set<number>()
let lastRightClickPasteAt = 0
let quickCommandBarNoticeTimer: number | undefined
const status = ref<TerminalRuntimeStatus>('idle')
const terminalSize = ref({ cols: 80, rows: 24 })
const activeSession = ref<TerminalSessionKind>('local')
const activeSessionProfile = ref<ConnectionProfile | undefined>(undefined)
const terminalCompletionOpen = ref(false)
const completionSuggestions = ref<CompletionSuggestion[]>([])
const selectedCompletionIndex = ref(-1)
const completionPrefixLength = ref(0)
const completionPlacement = ref<'above' | 'below'>('below')
const completionPositionStyle = ref<Record<string, string>>({ left: '8px', top: '8px', width: 'min(430px, calc(100% - 16px))' })
const localCommandHistory = ref<string[]>([])
const COMPLETION_DEBOUNCE_MS = 400
const COMPLETION_LIMIT = 6
const DEFAULT_QUICK_COMMANDS = ['pwd', 'ls -la', 'df -h', 'free -m', 'ps aux', 'git status']
const QUICK_COMMAND_STORAGE_KEY_PREFIX = 'ai-term:quick-commands:v1'
const QUICK_COMMAND_LIMIT = 12
const quickCommands = ref<string[]>(loadQuickCommands())
const quickCommandSettingsOpen = ref(false)
const quickCommandItems = ref<string[]>([...quickCommands.value])
const quickCommandRecommendations = ref<string[]>([])
const quickCommandResetConfirm = ref(false)
const quickCommandNotice = ref('')
const quickCommandError = ref('')
const quickCommandBarNotice = ref('')
const QUICK_COMMANDS_CHANGED_EVENT = 'ai-term:quick-commands-changed'
const sshAuthPromptOpen = ref(false)
const sshAuthPassword = ref('')
const sshAuthError = ref('')
const sshAuthSaving = ref(false)
const sshAuthFailedDetail = ref('')
const sshHostKeyPromptOpen = ref(false)
const sshHostKeySaving = ref(false)
const sshHostKeyError = ref('')
const sshHostKeyFailedDetail = ref('')
const sshHostKeyKnownHosts = ref('')
const sshHostKeyTarget = ref<SshHostKeyTarget | undefined>(undefined)
function startConnectionAttempt() {
  connectionAttempt += 1
  return connectionAttempt
}

function isCurrentConnectionAttempt(attempt: number) {
  return attempt === connectionAttempt
}

function createTerminalSessionId(kind: TerminalSessionKind) {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${kind}-${props.terminalId}-${suffix}`
}

function emitTerminalStatus(value = status.value) {
  emit('statusChanged', props.terminalId, value)
}

function cloneConnectionProfile(profile: ConnectionProfile): ConnectionProfile {
  return JSON.parse(JSON.stringify(profile)) as ConnectionProfile
}

function sshAuthTargetLabel(_profile?: ConnectionProfile) {
  return 'SSH 服务器'
}

function shouldAskForSshPassword(error: unknown) {
  if (!props.profile || isSftpProfile(props.profile)) return false
  const message = formatError(error)
  return (
    message.includes('password: no saved password') ||
    message.includes('SSH \u8ba4\u8bc1\u5931\u8d25') ||
    message.includes('Authentication failed') ||
    message.includes('no saved password')
  )
}

function openSshAuthPrompt(detail: string) {
  sshAuthFailedDetail.value = detail
  sshAuthPassword.value = ''
  sshAuthError.value = ''
  sshAuthSaving.value = false
  sshAuthPromptOpen.value = true
  void nextTick(() => {
    const input = document.querySelector<HTMLInputElement>('.ssh-auth-modal input[type="password"]')
    input?.focus()
  })
}

function closeSshAuthPrompt() {
  if (sshAuthSaving.value) return
  sshAuthPromptOpen.value = false
  sshAuthPassword.value = ''
  sshAuthError.value = ''
}

async function submitSshAuthPassword() {
  if (!props.profile) return
  const password = sshAuthPassword.value
  if (!password) {
    sshAuthError.value = '\u8bf7\u8f93\u5165\u5bc6\u7801'
    return
  }
  sshAuthSaving.value = true
  sshAuthError.value = ''
  try {
    const updated = cloneConnectionProfile(props.profile)
    const endpoint = updated.target
    updated.jumpMode = 'direct'
    updated.menuProfileId = ''
    updated.fileTransferMode = 'auto'
    endpoint.authMode = 'password'
    endpoint.password = password
    await saveConnectionProfile(updated)
    emit('profileUpdated', updated.id)
    sshAuthPromptOpen.value = false
    sshAuthPassword.value = ''
    await connectRemote()
  } catch (error) {
    sshAuthError.value = formatError(error)
  } finally {
    sshAuthSaving.value = false
  }
}

function shouldAskForSshHostKeyReset(error: unknown) {
  const message = formatError(error)
  return message.includes('SSH host key verification failed') && message.includes('AI Term known_hosts')
}

function endpointPort(endpoint: AuthEndpoint) {
  return endpoint.port ?? 22
}

function endpointHostPort(endpoint: AuthEndpoint) {
  return `${endpoint.host}:${endpointPort(endpoint)}`
}

function endpointLabelForHostKey(endpoint: AuthEndpoint) {
  const username = endpoint.username?.trim()
  return `${username ? `${username}@` : ''}${endpointHostPort(endpoint)}`
}

function endpointMatchesHostKeyDetail(endpoint: AuthEndpoint, detail: string) {
  const host = endpoint.host?.trim()
  if (!host) return false
  return detail.includes(endpointLabelForHostKey(endpoint)) || detail.includes(endpointHostPort(endpoint))
}

function resolveSshHostKeyTarget(detail: string): SshHostKeyTarget | undefined {
  const profile = activeSessionProfile.value ?? props.profile
  if (!profile) return undefined
  const candidates = [profile.target, profile.gateway].filter((endpoint) => endpoint.host?.trim())
  const endpoint = candidates.find((candidate) => endpointMatchesHostKeyDetail(candidate, detail)) ?? candidates[0]
  if (!endpoint) return undefined
  return {
    host: endpoint.host.trim(),
    port: endpointPort(endpoint),
    label: endpointLabelForHostKey(endpoint)
  }
}

function extractKnownHostsPath(detail: string) {
  return detail.match(/Known hosts:\s*([^\r\n]+)/)?.[1]?.trim() ?? ''
}

function openSshHostKeyPrompt(detail: string) {
  const target = resolveSshHostKeyTarget(detail)
  if (!target) return
  sshHostKeyTarget.value = target
  sshHostKeyFailedDetail.value = detail
  sshHostKeyKnownHosts.value = extractKnownHostsPath(detail)
  sshHostKeyError.value = ''
  sshHostKeySaving.value = false
  sshHostKeyPromptOpen.value = true
}

function closeSshHostKeyPrompt() {
  if (sshHostKeySaving.value) return
  sshHostKeyPromptOpen.value = false
  sshHostKeyError.value = ''
}

async function confirmSshHostKeyReset() {
  const target = sshHostKeyTarget.value
  if (!target) return
  sshHostKeySaving.value = true
  sshHostKeyError.value = ''
  try {
    const removed = await forgetAiTermKnownHost(target.host, target.port)
    sshHostKeyPromptOpen.value = false
    const notice = removed > 0
      ? `\r\n[AI Term] 已移除 ${target.label} 的旧主机密钥记录，正在重新连接。\r\n`
      : `\r\n[AI Term] 没有找到 ${target.label} 的旧主机密钥记录，正在重新连接。\r\n`
    writeTerminalView(notice, true)
    appendTerminalOutput(notice)
    await connectRemote()
  } catch (error) {
    sshHostKeyError.value = formatError(error)
  } finally {
    sshHostKeySaving.value = false
  }
}

function systemCommandSuggestions() {
  const common = ['cd', 'ls', 'pwd', 'cat', 'grep', 'find', 'mkdir', 'touch', 'cp', 'mv', 'rm', 'echo', 'curl', 'wget', 'ssh', 'scp', 'rsync', 'tar', 'chmod', 'chown', 'ps', 'top', 'htop', 'kill', 'df -h', 'du -sh', 'free -m', 'ping', 'git status', 'git pull', 'git checkout', 'git log --oneline', 'docker ps', 'docker logs', 'kubectl get pods']
  const windows = ['dir', 'cd', 'cls', 'type', 'copy', 'move', 'del', 'findstr', 'where', 'tasklist', 'taskkill', 'ipconfig', 'netstat -ano', 'powershell', 'Get-Process', 'Get-Service', 'Get-ChildItem']
  const shellKind = shellPromptSignature?.kind
  if (shellKind === 'powershell' || shellKind === 'cmd') return [...windows, 'git status', 'docker ps']
  if (activeSession.value === 'remote') {
    return ['systemctl status', 'journalctl -xe', 'ss -tulpn', 'ip addr', ...common]
  }
  if (shellKind === 'posix') {
    return ['systemctl status', 'journalctl -xe', 'ss -tulpn', 'ip addr', ...common]
  }
  const platform = `${navigator.platform} ${navigator.userAgent}`.toLowerCase()
  if (platform.includes('win')) {
    return [...windows, 'wmic cpu get loadpercentage', ...common]
  }
  if (platform.includes('mac')) {
    return ['brew update', 'brew upgrade', 'open .', 'pbcopy', 'pbpaste', 'sw_vers', 'system_profiler', ...common]
  }
  return ['apt update', 'apt list --upgradable', 'systemctl status', 'journalctl -xe', 'ss -tulpn', 'ip addr', ...common]
}

function historyCommandSuggestions() {
  const persisted = props.commandHistory.map((entry) => entry.command)
  const persistedCommands = new Set(persisted)
  return [...persisted, ...localCommandHistory.value.filter((command) => !persistedCommands.has(command))]
}

function loadQuickCommands() {
  try {
    const raw = window.localStorage.getItem(quickCommandStorageKey()) ?? window.localStorage.getItem(QUICK_COMMAND_STORAGE_KEY_PREFIX)
    if (!raw) return [...DEFAULT_QUICK_COMMANDS]
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return safeQuickCommandList(parsed)
  } catch (error) {
    console.warn('failed to load quick commands', error)
  }
  return [...DEFAULT_QUICK_COMMANDS]
}

function persistQuickCommands(commands: string[]) {
  window.localStorage.setItem(quickCommandStorageKey(), JSON.stringify(commands))
}

function handleQuickCommandsChanged(event: Event) {
  const detail = (event as CustomEvent<QuickCommandsChangedDetail>).detail
  if (!detail || detail.storageKey !== quickCommandStorageKey() || !Array.isArray(detail.commands)) return
  quickCommands.value = safeQuickCommandList(detail.commands)
  if (terminalCompletionOpen.value) refreshCompletionSuggestions()
}

function quickCommandStorageKey() {
  return `${QUICK_COMMAND_STORAGE_KEY_PREFIX}:${props.profile?.id || 'local'}`
}

function safeQuickCommandList(commands: string[]) {
  return normalizeQuickCommandList(commands.filter((command) => (
    !isSensitiveCommand(command)
    && !isHighRiskQuickCommand(command)
    && scriptRiskStatusForContent(command).level !== 'high'
  )))
}

function normalizeQuickCommandList(commands: string[]) {
  const seen = new Set<string>()
  const result: string[] = []
  commands.forEach((command) => {
    const value = command.trim()
    if (!value || seen.has(value) || value.length > 140) return
    seen.add(value)
    result.push(value)
  })
  return result.slice(0, QUICK_COMMAND_LIMIT)
}

const normalizedQuickCommandItems = computed(() => normalizeQuickCommandList(
  quickCommandItems.value.filter((command) => {
    const value = command.trim()
    return value
      && value.length <= 140
      && !isSensitiveCommand(value)
      && !isHighRiskQuickCommand(value)
      && scriptRiskStatusForContent(value).level !== 'high'
  })
))
const quickCommandEnabledCount = computed(() => normalizedQuickCommandItems.value.length)
const quickCommandHasBlockingIssues = computed(() =>
  quickCommandItems.value.some((command) => {
    const value = command.trim()
    return Boolean(value && (
      value.length > 140
      || isSensitiveCommand(value)
      || isHighRiskQuickCommand(value)
      || scriptRiskStatusForContent(value).level === 'high'
    ))
  })
)
const quickCommandCanSave = computed(() => quickCommandEnabledCount.value > 0 && !quickCommandHasBlockingIssues.value)

function syncQuickCommandItems(commands: string[]) {
  quickCommandItems.value = commands.length > 0 ? [...commands] : ['']
}

function quickCommandDuplicate(command: string, index: number) {
  const value = command.trim()
  if (!value) return false
  return quickCommandItems.value.some((item, itemIndex) => itemIndex !== index && item.trim() === value)
}

function quickCommandStatus(command: string, index: number) {
  const value = command.trim()
  if (!value) {
    return { label: '未启用', level: 'muted', message: '空行不会保存。', blocking: false }
  }
  if (value.length > 140) {
    return { label: '过长', level: 'high', message: '超过 140 个字符，请缩短后保存。', blocking: true }
  }
  if (isSensitiveCommand(value)) {
    return { label: '敏感', level: 'high', message: '包含凭证或密钥的命令不能保存。', blocking: true }
  }
  if (isHighRiskQuickCommand(value)) {
    return { label: '高风险', level: 'high', message: '高风险命令不能保存为固定命令。', blocking: true }
  }
  if (quickCommandDuplicate(command, index)) {
    return { label: '重复', level: 'medium', message: '重复命令会在保存时自动合并。', blocking: false }
  }
  const risk = scriptRiskStatusForContent(value)
  if (risk.level === 'high') {
    return { label: risk.label, level: risk.level, message: risk.message, blocking: true }
  }
  if (risk.level === 'safe') {
    return { label: '可用', level: 'safe', message: '未检测到风险。', blocking: false }
  }
  return { label: risk.label, level: risk.level, message: risk.message, blocking: false }
}

function shouldShowQuickCommandMessage(command: string, index: number) {
  const status = quickCommandStatus(command, index)
  return status.level !== 'safe'
}

function addQuickCommandItem(index = quickCommandItems.value.length - 1) {
  if (quickCommandItems.value.length >= QUICK_COMMAND_LIMIT) {
    quickCommandNotice.value = `最多保留 ${QUICK_COMMAND_LIMIT} 条固定命令。`
    return
  }
  quickCommandItems.value.splice(index + 1, 0, '')
  quickCommandError.value = ''
}

function removeQuickCommandItem(index: number) {
  if (quickCommandItems.value.length <= 1) {
    syncQuickCommandItems([''])
    return
  }
  quickCommandItems.value.splice(index, 1)
}

function moveQuickCommandItem(index: number, direction: -1 | 1) {
  const nextIndex = index + direction
  if (nextIndex < 0 || nextIndex >= quickCommandItems.value.length) return
  const next = [...quickCommandItems.value]
  const current = next[index]
  next[index] = next[nextIndex]
  next[nextIndex] = current
  quickCommandItems.value = next
}

function handleQuickCommandSettingsPointerDown(event: PointerEvent) {
  event.preventDefault()
  event.stopPropagation()
  openQuickCommandSettings()
}

function openQuickCommandSettings() {
  syncQuickCommandItems(quickCommands.value)
  quickCommandRecommendations.value = []
  quickCommandResetConfirm.value = false
  quickCommandNotice.value = ''
  quickCommandError.value = ''
  quickCommandSettingsOpen.value = true
}

function closeQuickCommandSettings() {
  quickCommandSettingsOpen.value = false
  quickCommandRecommendations.value = []
  quickCommandResetConfirm.value = false
}

function saveQuickCommandSettings() {
  if (!quickCommandCanSave.value) {
    quickCommandError.value = quickCommandEnabledCount.value === 0 ? '至少保留 1 条固定命令。' : '请先处理高风险或过长命令。'
    return
  }
  const nextCommands = commitQuickCommands(normalizedQuickCommandItems.value)
  syncQuickCommandItems(nextCommands)
  quickCommandRecommendations.value = []
  quickCommandResetConfirm.value = false
  quickCommandError.value = ''
  quickCommandNotice.value = '固定命令已保存。'
}

function commitQuickCommands(commands: string[]) {
  const nextCommands = safeQuickCommandList(commands)
  quickCommands.value = nextCommands
  persistQuickCommands(nextCommands)
  window.dispatchEvent(new CustomEvent<QuickCommandsChangedDetail>(QUICK_COMMANDS_CHANGED_EVENT, {
    detail: { storageKey: quickCommandStorageKey(), commands: nextCommands }
  }))
  if (terminalCompletionOpen.value) refreshCompletionSuggestions()
  return nextCommands
}

function pinQuickCommand(command: string): PinQuickCommandResult {
  const value = command.trim()
  if (
    !value
    || value.length > 140
    || isSensitiveCommand(value)
    || isHighRiskQuickCommand(value)
    || scriptRiskStatusForContent(value).level === 'high'
  ) return 'invalid'
  if (quickCommands.value.includes(value)) return 'exists'
  if (quickCommands.value.length >= QUICK_COMMAND_LIMIT) return 'limit'
  commitQuickCommands([...quickCommands.value, value])
  return 'added'
}

function resetQuickCommandDraft() {
  quickCommandResetConfirm.value = true
  quickCommandError.value = ''
  quickCommandNotice.value = ''
}

function confirmResetQuickCommandDraft() {
  syncQuickCommandItems(DEFAULT_QUICK_COMMANDS)
  quickCommandRecommendations.value = []
  quickCommandResetConfirm.value = false
  quickCommandError.value = ''
  quickCommandNotice.value = '已恢复默认候选，保存后生效。'
}

function cancelResetQuickCommandDraft() {
  quickCommandResetConfirm.value = false
}

function addQuickCommandRecommendation(command: string) {
  const merged = normalizeQuickCommandList([...quickCommandItems.value, command])
  syncQuickCommandItems(merged)
  quickCommandError.value = ''
  quickCommandNotice.value = '已追加候选，保存后生效。'
}

function appendQuickCommandRecommendations() {
  const merged = normalizeQuickCommandList([...quickCommandItems.value, ...quickCommandRecommendations.value])
  syncQuickCommandItems(merged)
  quickCommandError.value = ''
  quickCommandNotice.value = '已追加全部推荐，保存后生效。'
}

function replaceQuickCommandsWithRecommendations() {
  syncQuickCommandItems(quickCommandRecommendations.value)
  quickCommandError.value = ''
  quickCommandNotice.value = '已替换为推荐候选，保存后生效。'
}
function quickCommandHistorySeed() {
  return historyCommandSuggestions()
    .map((command) => command.trim())
    .filter((command) => command && !isSensitiveCommand(command))
    .slice(-80)
}

function isHighRiskQuickCommand(command: string) {
  return /\b(rm\s+-rf|mkfs|shutdown|reboot|halt|poweroff|format\s+|del\s+\/|remove-item\b|dd\s+if=|chmod\s+-R\s+777)\b/i.test(command) || command.includes(':(){')
}

function localQuickCommandRecommendations() {
  const events = quickCommandHistorySeed()
  const stats = new Map<string, { command: string; count: number; lastIndex: number }>()
  events.forEach((command, index) => {
    if (isHighRiskQuickCommand(command) || scriptRiskStatusForContent(command).level === 'high') return
    const current = stats.get(command)
    if (current) {
      current.count += 1
      current.lastIndex = index
    } else {
      stats.set(command, { command, count: 1, lastIndex: index })
    }
  })
  const recencyWindow = Math.max(1, events.length / 4)
  const score = (item: { count: number; lastIndex: number }) => {
    const age = Math.max(0, events.length - item.lastIndex - 1)
    return Math.log1p(item.count) + Math.exp(-age / recencyWindow)
  }
  return normalizeQuickCommandList(
    [...stats.values()]
      .sort((first, second) => (
        score(second) - score(first)
        || second.count - first.count
        || second.lastIndex - first.lastIndex
        || first.command.localeCompare(second.command)
      ))
      .map(({ command }) => command)
      .concat(DEFAULT_QUICK_COMMANDS)
  )
}

function recommendQuickCommandsFromHistory() {
  const current = new Set(normalizedQuickCommandItems.value)
  quickCommandRecommendations.value = localQuickCommandRecommendations()
    .filter((command) => !current.has(command))
  quickCommandError.value = ''
  quickCommandNotice.value = quickCommandRecommendations.value.length > 0
    ? '已根据本机历史生成推荐候选。'
    : '当前固定命令已覆盖可用的历史候选。'
  quickCommandResetConfirm.value = false
}
function buildCompletionSuggestions(prefix = completionInputLine().trimStart()) {
  const normalizedPrefix = prefix.toLowerCase()
  const historyStats = new Map<string, { command: string; count: number; source: CompletionSuggestionSource; lastIndex: number; lastExitCode?: number }>()
  const matchesPrefix = (command: string) => !normalizedPrefix || command.toLowerCase().startsWith(normalizedPrefix)
  const addHistory = (command: string, source: CompletionSuggestionSource, index: number, exitCode?: number) => {
    const value = command.trim()
    if (!value || isSensitiveCommand(value)) return
    if (!matchesPrefix(value)) return
    const current = historyStats.get(value)
    if (current) {
      current.count += 1
      if (index >= current.lastIndex) {
        current.lastIndex = index
        current.lastExitCode = exitCode
      }
      if (source === 'session') current.source = source
      return
    }
    historyStats.set(value, { command: value, count: 1, source, lastIndex: index, lastExitCode: exitCode })
  }

  const historyCommandKeys = new Set<string>()
  props.commandHistory.forEach((entry, index) => {
    const key = entry.command.trim()
    if (key) historyCommandKeys.add(key)
    addHistory(entry.command, 'history', index, entry.exitCode)
  })
  localCommandHistory.value.forEach((command, index) => {
    const value = command.trim()
    if (historyCommandKeys.has(value)) {
      const persisted = historyStats.get(value)
      if (persisted) persisted.source = 'session'
      return
    }
    addHistory(command, 'session', props.commandHistory.length + index)
  })

  const pinnedSuggestions = quickCommands.value
    .map((command) => command.trim())
    .filter((command) => command && !isSensitiveCommand(command) && matchesPrefix(command))
    .map((command) => {
      const history = historyStats.get(command)
      historyStats.delete(command)
      return { command, source: 'pinned' as CompletionSuggestionSource, count: history?.count ?? 0 }
    })

  // 最近一次执行失败(退出码非 0)的命令排在同频次的成功命令之后
  const lastRunFailed = (entry: { lastExitCode?: number }) =>
    entry.lastExitCode !== undefined && entry.lastExitCode !== 0 ? 1 : 0
  const historySuggestions = [...historyStats.values()]
    .sort((a, b) => b.count - a.count || lastRunFailed(a) - lastRunFailed(b) || b.lastIndex - a.lastIndex || a.command.localeCompare(b.command))
    .map(({ command, source, count }) => ({ command, source, count }))

  const seen = new Set([
    ...pinnedSuggestions.map((suggestion) => suggestion.command),
    ...historySuggestions.map((suggestion) => suggestion.command)
  ])
  const systemSuggestions = systemCommandSuggestions()
    .map((command) => command.trim())
    .filter((command) => command && matchesPrefix(command) && !seen.has(command))
    .map((command) => ({ command, source: 'system' as CompletionSuggestionSource, count: 0 }))

  return [...pinnedSuggestions, ...historySuggestions, ...systemSuggestions].slice(0, COMPLETION_LIMIT)
}

function refreshCompletionSuggestions() {
  if (!canOfferCompletion() || !completionInputLine().trim()) {
    closeCompletion()
    return
  }
  completionSuggestions.value = buildCompletionSuggestions()
  selectedCompletionIndex.value = -1
  completionPrefixLength.value = completionInputLine().trimStart().length
  terminalCompletionOpen.value = completionSuggestions.value.length > 0
  if (terminalCompletionOpen.value) scheduleCompletionPosition()
}

function clearCompletionTimer() {
  if (completionDebounceTimer === undefined) return
  window.clearTimeout(completionDebounceTimer)
  completionDebounceTimer = undefined
}

function scheduleCompletionSuggestions() {
  clearCompletionTimer()
  if (!canOfferCompletion() || !completionInputLine().trim()) {
    closeCompletion()
    return
  }
  completionDebounceTimer = window.setTimeout(() => {
    completionDebounceTimer = undefined
    refreshCompletionSuggestions()
  }, COMPLETION_DEBOUNCE_MS)
}

function updateCompletionAfterInput(result: TerminalInputTrackResult) {
  if (result === 'submitted') {
    closeCompletion()
    return
  }
  if (result === 'changed') {
    completionSuppressedForHistoryNavigation = false
    scheduleCompletionSuggestions()
  }
}

function closeCompletion() {
  clearCompletionTimer()
  terminalCompletionOpen.value = false
  completionSuggestions.value = []
  selectedCompletionIndex.value = -1
  completionPrefixLength.value = 0
}

function completionSourceLabel(source: CompletionSuggestionSource) {
  if (source === 'pinned') return '固定'
  if (source === 'system') return '系统'
  if (source === 'history') return '历史'
  return '当前'
}

function scheduleCompletionPosition() {
  void nextTick(() => {
    window.requestAnimationFrame(positionTerminalCompletion)
  })
}

function positionTerminalCompletion() {
  const wrap = terminalBodyWrap.value
  const host = terminalHost.value
  const popup = terminalCompletion.value
  const screen = host?.querySelector<HTMLElement>('.xterm-screen')
  if (!terminal || !wrap || !popup || !screen || !terminalCompletionOpen.value) return

  const wrapRect = wrap.getBoundingClientRect()
  const screenRect = screen.getBoundingClientRect()
  if (!wrapRect.width || !wrapRect.height || !screenRect.width || !screenRect.height) return

  const cellWidth = screenRect.width / Math.max(1, terminal.cols)
  const cellHeight = screenRect.height / Math.max(1, terminal.rows)
  const cursorX = Math.max(0, Math.min(terminal.cols - 1, terminal.buffer.active.cursorX))
  const cursorY = Math.max(0, Math.min(terminal.rows - 1, terminal.buffer.active.cursorY))
  const cursorLeft = screenRect.left - wrapRect.left + cursorX * cellWidth
  const cursorTop = screenRect.top - wrapRect.top + cursorY * cellHeight
  const maxWidth = Math.max(1, Math.min(430, wrap.clientWidth - 16))
  const popupHeight = popup.offsetHeight
  const popupWidth = Math.min(popup.offsetWidth || maxWidth, maxWidth)
  const gap = 6
  const spaceAbove = cursorTop
  const spaceBelow = wrap.clientHeight - cursorTop - cellHeight
  const placement = spaceBelow >= popupHeight + gap || spaceBelow >= spaceAbove ? 'below' : 'above'
  const maxLeft = Math.max(8, wrap.clientWidth - popupWidth - 8)
  const left = Math.min(Math.max(8, cursorLeft), maxLeft)
  const desiredTop = placement === 'below'
    ? cursorTop + cellHeight + gap
    : cursorTop - popupHeight - gap
  const top = Math.min(Math.max(8, desiredTop), Math.max(8, wrap.clientHeight - popupHeight - 8))

  completionPlacement.value = placement
  completionPositionStyle.value = {
    left: `${left}px`,
    top: `${top}px`,
    width: `${maxWidth}px`
  }
}

function handleDocumentPointerDown(event: PointerEvent) {
  if (!terminalCompletionOpen.value) return
  const target = event.target instanceof Node ? event.target : null
  if (target && terminalBodyWrap.value?.contains(target)) return
  closeCompletion()
}

function acceptCompletionSuggestion(suggestion: CompletionSuggestion) {
  if (!suggestion) return false
  const current = completionInputLine().trimStart()
  if (!suggestion.command.toLowerCase().startsWith(current.toLowerCase())) return false
  const tail = suggestion.command.slice(current.length)
  if (!tail) {
    closeCompletion()
    return false
  }
  if (tail && !sendInteractiveTerminalInput(tail)) return false
  closeCompletion()
  return true
}

function isHistoryNavigationInput(data: string) {
  return data === '\x1b[A' || data === '\x1bOA' || data === '\x1b[B' || data === '\x1bOB'
}

function moveCompletionSelection(delta: number) {
  const count = completionSuggestions.value.length
  if (!count) return
  const current = selectedCompletionIndex.value
  selectedCompletionIndex.value = current < 0
    ? (delta > 0 ? 0 : count - 1)
    : (current + delta + count) % count
  void nextTick(() => {
    terminalCompletion.value
      ?.querySelectorAll<HTMLElement>('[role="option"]')[selectedCompletionIndex.value]
      ?.scrollIntoView({ block: 'nearest' })
  })
}

function handleCompletionInput(data: string) {
  if (!terminalCompletionOpen.value) return false
  if (data === '\x1b') {
    closeCompletion()
    return true
  }
  if (data === '\x1b[B' || data === '\x1bOB') {
    moveCompletionSelection(1)
    return true
  }
  if (data === '\x1b[A' || data === '\x1bOA') {
    // 未选中任何项时按 ↑ 仍走 shell 历史;进入列表后 ↑ 在首项回到未选中态
    if (selectedCompletionIndex.value < 0) {
      completionSuppressedForHistoryNavigation = true
      closeCompletion()
      return false
    }
    if (selectedCompletionIndex.value === 0) {
      selectedCompletionIndex.value = -1
      return true
    }
    moveCompletionSelection(-1)
    return true
  }
  if ((data === '\r' || data === '\n') && selectedCompletionIndex.value >= 0) {
    const suggestion = completionSuggestions.value[selectedCompletionIndex.value]
    if (suggestion && acceptCompletionSuggestion(suggestion)) return true
  }
  closeCompletion()
  return false
}

function renderIdlePrompt(term: Terminal) {
  term.reset()
  term.writeln('No active shell.')
  term.writeln('Use New Local Shell to start a local terminal.')
  term.writeln('')
  scrollTerminalToBottom()
}

function isSftpProfile(profile?: ConnectionProfile) {
  return profile?.fileTransferMode === 'sftp-direct' || profile?.fileTransferMode === 'sftp-gateway'
}

function terminalHostIsMeasurable(element: HTMLElement) {
  return props.active && element.clientWidth > 0 && element.clientHeight > 0
}

function currentTerminalSize() {
  syncTerminalSize()
  return terminal ? { cols: terminal.cols, rows: terminal.rows } : terminalSize.value
}

function scrollTerminalToBottom() {
  window.requestAnimationFrame(() => terminal?.scrollToBottom())
}

function terminalIsPinnedToBottom() {
  if (!terminal) return true
  const buffer = terminal.buffer.active
  return buffer.viewportY >= buffer.baseY - 1
}

function writeTerminalView(data: string, forceScroll = false) {
  if (!terminal || !data) return
  const shouldScroll = forceScroll || terminalIsPinnedToBottom()
  terminal.write(data, () => {
    if (shouldScroll) scrollTerminalToBottom()
    updateTerminalInputContextFromOutput()
    if (shellIntegrationInputActive()) {
      // 集成模式下输入内容以屏幕回显为准:回显落地后再评估是否弹补全,
      // Tab 补全、autosuggestion、历史翻找造成的行内容变化都会经过这里
      if (shellIntegrationCommandLine().trim()) {
        scheduleCompletionSuggestions()
      } else if (terminalCompletionOpen.value) {
        closeCompletion()
      }
    } else if (recoverTrackedTerminalInputFromRenderedLine()) {
      scheduleCompletionSuggestions()
    }
    if (terminalCompletionOpen.value) scheduleCompletionPosition()
  })
}

function syncTerminalSize(forcePtyResize = false) {
  if (!terminal || !fitAddon || !terminalHost.value || !terminalHostIsMeasurable(terminalHost.value)) return
  const previous = { cols: terminal.cols, rows: terminal.rows }
  const proposed = fitAddon.proposeDimensions()
  if (proposed) {
    terminal.resize(
      Math.max(2, proposed.cols - TERMINAL_SAFE_COLUMN_MARGIN),
      Math.max(1, proposed.rows)
    )
  } else {
    fitAddon.fit()
  }
  const size = { cols: terminal.cols, rows: terminal.rows }
  const changed = size.cols !== previous.cols || size.rows !== previous.rows
  terminalSize.value = size
  if (sessionId && (changed || forcePtyResize)) {
    void terminalResize(sessionId, size.cols, size.rows)
  }
  if (forcePtyResize) terminal.refresh(0, terminal.rows - 1)
  scrollTerminalToBottom()
  if (terminalCompletionOpen.value) scheduleCompletionPosition()
}

function scheduleTerminalSizeSync(forcePtyResize = false) {
  forcePtyResizeOnNextFit ||= forcePtyResize
  if (terminalFitFrame) return
  terminalFitFrame = window.requestAnimationFrame(() => {
    terminalFitFrame = 0
    const force = forcePtyResizeOnNextFit
    forcePtyResizeOnNextFit = false
    syncTerminalSize(force)
  })
}

function scheduleTerminalSizeSyncAfterFonts() {
  void document.fonts.ready.then(() => scheduleTerminalSizeSync(true))
}

function emitTerminalSnapshot() {
  if (terminalOutputEmitTimer !== undefined) {
    window.clearTimeout(terminalOutputEmitTimer)
    terminalOutputEmitTimer = undefined
  }
  emit('terminalOutput', {
    terminalId: props.terminalId,
    snapshot: terminalOutputBuffer
  })
}

// Coalesce the full-snapshot broadcast: high-output commands fire the data
// handler dozens–hundreds of times/sec, and each emit fans a ~1.5 MB string
// out to the parent and every context-consuming panel. A trailing timer
// collapses a burst into one emit per interval; the local input-context and
// completion updates below still run per chunk since they only read state.
// 面板消费方(AI 上下文、SFTP 握手、录制)都不需要高频快照,200ms 足够;
// 更高频率会在 vim 等全屏程序持续重绘时把右侧面板的重渲染打满主线程。
function scheduleTerminalSnapshotEmit() {
  if (terminalOutputEmitTimer !== undefined) return
  terminalOutputEmitTimer = window.setTimeout(() => {
    terminalOutputEmitTimer = undefined
    emitTerminalSnapshot()
  }, TERMINAL_OUTPUT_EMIT_INTERVAL)
}

function setTerminalOutputBuffer(text: string) {
  terminalOutputBuffer = text
  terminalOutputRecentTail = text.slice(-TERMINAL_OUTPUT_TAIL_LIMIT)
}

function appendTerminalOutput(data: string) {
  // 追加依赖 V8 的 rope 优化;超限一倍才压缩,避免高频输出时每块都整体拷贝 1.5MB
  terminalOutputBuffer = `${terminalOutputBuffer}${data}`
  if (terminalOutputBuffer.length > TERMINAL_OUTPUT_BUFFER_LIMIT * 2) {
    terminalOutputBuffer = terminalOutputBuffer.slice(-TERMINAL_OUTPUT_BUFFER_LIMIT)
  }
  terminalOutputRecentTail = `${terminalOutputRecentTail}${data}`
  if (terminalOutputRecentTail.length > TERMINAL_OUTPUT_TAIL_LIMIT * 2) {
    terminalOutputRecentTail = terminalOutputRecentTail.slice(-TERMINAL_OUTPUT_TAIL_LIMIT)
  }
  if (terminalCompletionOpen.value) scheduleCompletionPosition()
  scheduleTerminalSnapshotEmit()
}

function activeBufferLine(y: number) {
  if (!terminal) return y
  if (y > terminal.rows) return y
  return terminal.buffer.active.viewportY + y
}

function selectedLineRange(text: string) {
  const selectionPosition = terminal?.getSelectionPosition()
  if (selectionPosition) {
    return {
      startLine: Math.max(1, activeBufferLine(selectionPosition.start.y)),
      endLine: Math.max(1, activeBufferLine(selectionPosition.end.y))
    }
  }
  const lineCount = Math.max(1, text.split(/\r?\n/).length)
  const endLine = Math.max(1, terminalOutputBuffer.split('\n').length)
  return {
    startLine: Math.max(1, endLine - lineCount + 1),
    endLine
  }
}

function normalizedTerminalSelectionText(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n+$/g, '')
}

function normalizeTerminalSelectionToContent() {
  if (!terminal || terminalSelectionNormalizing) return false
  const selection = terminal.getSelectionPosition()
  if (!selection) return false

  const buffer = terminal.buffer.active
  const cols = terminal.cols
  let firstOffset: number | undefined
  let lastOffset: number | undefined

  for (let rowIndex = selection.start.y; rowIndex <= selection.end.y; rowIndex += 1) {
    const line = buffer.getLine(rowIndex)
    if (!line) continue
    const startColumn = rowIndex === selection.start.y ? selection.start.x : 0
    const endColumn = rowIndex === selection.end.y ? selection.end.x : cols
    if (endColumn <= startColumn) continue

    let selectedContentStart: number | undefined
    let selectedContentEnd: number | undefined
    for (let column = startColumn; column < Math.min(endColumn, cols); column += 1) {
      const cell = line.getCell(column)
      if (!cell?.getChars().trim()) continue
      selectedContentStart ??= column
      selectedContentEnd = Math.min(cols, column + Math.max(1, cell.getWidth()))
    }
    if (selectedContentStart === undefined || selectedContentEnd === undefined) continue

    firstOffset ??= rowIndex * cols + selectedContentStart
    lastOffset = rowIndex * cols + selectedContentEnd
  }

  terminalSelectionNormalizing = true
  try {
    if (firstOffset === undefined || lastOffset === undefined) {
      terminal.clearSelection()
      return true
    }

    const currentStart = selection.start.y * cols + selection.start.x
    const currentEnd = selection.end.y * cols + selection.end.x
    if (currentStart === firstOffset && currentEnd === lastOffset) return false

    terminal.select(firstOffset % cols, Math.floor(firstOffset / cols), lastOffset - firstOffset)
    return true
  } finally {
    terminalSelectionNormalizing = false
  }
}

function emitTerminalSelection(text: string) {
  const normalized = normalizedTerminalSelectionText(text)
  if (!normalized) {
    emit('terminalSelection', {
      terminalId: props.terminalId,
      text: '',
      startLine: 0,
      endLine: 0
    })
    return
  }
  const range = selectedLineRange(normalized)
  emit('terminalSelection', {
    terminalId: props.terminalId,
    text: normalized,
    startLine: range.startLine,
    endLine: Math.max(range.startLine, range.endLine)
  })
}

async function copySelectionToClipboard() {
  normalizeTerminalSelectionToContent()
  const selectedText = normalizedTerminalSelectionText(terminal?.getSelection() ?? '')
  emitTerminalSelection(selectedText)
  if (!selectedText.trim()) return
  try {
    await writeClipboard(selectedText)
  } catch (error) {
    console.warn('failed to copy terminal selection', error)
  }
}

async function readClipboard() {
  try {
    return (await readClipboardText()) ?? ''
  } catch {
    return (await navigator.clipboard?.readText()) ?? ''
  }
}

async function writeClipboard(text: string) {
  try {
    await writeClipboardText(text)
  } catch {
    await navigator.clipboard?.writeText(text)
  }
}

function recordCommand(command: string, exitCode?: number) {
  const value = command.trim()
  if (!value || isSensitiveCommand(value)) return
  localCommandHistory.value = [...localCommandHistory.value, value].slice(-120)
  emit('commandRecorded', {
    terminalId: props.terminalId,
    command: value,
    ...(exitCode === undefined ? {} : { exitCode })
  })
}

function renderedLogicalLineAt(startLine: number) {
  const buffer = terminal?.buffer.active
  if (!buffer) return ''

  let value = ''
  for (let lineIndex = startLine; lineIndex < buffer.length; lineIndex += 1) {
    const line = buffer.getLine(lineIndex)
    if (!line || (lineIndex > startLine && !line.isWrapped)) break
    value += line.translateToString(true)
  }
  return value.trimEnd()
}

function currentRenderedCommandLinePosition() {
  const buffer = terminal?.buffer.active
  if (!buffer) return { startLine: -1, text: '' }
  let startLine = buffer.baseY + buffer.cursorY
  while (startLine > 0 && buffer.getLine(startLine)?.isWrapped) startLine -= 1
  return { startLine, text: renderedLogicalLineAt(startLine) }
}

function currentRenderedCommandLine() {
  return currentRenderedCommandLinePosition().text
}

function recoverTrackedTerminalInputFromRenderedLine() {
  if (inputCommandReliable || terminalInputContext !== 'shell' || !shellPromptText) return false
  const renderedLine = currentRenderedCommandLine()
  if (!renderedLine.startsWith(shellPromptText)) return false
  const command = renderedLine.slice(shellPromptText.length).trimStart()
  inputCommandBuffer = command
  inputCommandCursor = command.length
  inputCommandReliable = true
  return true
}

function submittedTerminalCommand(fallback: string) {
  if (terminalInputContext === 'sensitive' || terminal?.buffer.active.type === 'alternate') return ''
  if (inputCommandReliable && terminalInputContext === 'shell') return fallback.trim()
  const renderedLine = currentRenderedCommandLine()
  if (inputCommandReliable && shellPromptText && renderedLine.startsWith(shellPromptText)) return fallback.trim()
  return ''
}

function deferredCommandCapture(): DeferredCommandCapture | undefined {
  if (
    !shellPromptText ||
    terminalInputContext === 'sensitive' ||
    terminal?.buffer.active.type === 'alternate'
  ) return undefined
  const rendered = currentRenderedCommandLinePosition()
  if (rendered.startLine < 0 || !rendered.text.startsWith(shellPromptText)) return undefined
  return { promptText: shellPromptText, startLine: rendered.startLine }
}

function renderedCommandForCapture(capture: DeferredCommandCapture) {
  const renderedLine = renderedLogicalLineAt(capture.startLine)
  if (!renderedLine.startsWith(capture.promptText)) return ''
  return renderedLine.slice(capture.promptText.length).trim()
}

function scheduleDeferredCommandCapture(capture: DeferredCommandCapture) {
  const delays = [40, 120, 300, 650]
  let previousCandidate = ''
  const attempt = (index: number) => {
    const timer = window.setTimeout(() => {
      deferredCommandCaptureTimers.delete(timer)
      const candidate = renderedCommandForCapture(capture)
      if (candidate && candidate === previousCandidate) {
        recordCommand(candidate)
        return
      }
      if (candidate) previousCandidate = candidate
      if (index + 1 < delays.length) {
        attempt(index + 1)
      } else if (previousCandidate) {
        recordCommand(previousCandidate)
      }
    }, delays[index])
    deferredCommandCaptureTimers.add(timer)
  }
  attempt(0)
}

function commitTrackedCommands(commands: string[]) {
  commands.forEach(recordCommand)
}

function advanceTerminalInputGeneration() {
  deferredCommandCaptureTimers.forEach((timer) => window.clearTimeout(timer))
  deferredCommandCaptureTimers.clear()
  shellIntegrationAttachment?.tracker.reset()
  terminalInputReady = false
  terminalInputGeneration += 1
  failedTerminalInputGeneration = undefined
  pendingTrackedCommands = []
  pendingDeferredCommandCaptures = []
  pendingInputControlSequence = ''
  shellPromptText = ''
  shellPromptSignature = undefined
  shellPromptDiscoveryOpen = true
  shellCommandAwaitingPrompt = false
  terminalWasInAlternateBuffer = false
  terminalInputQueue.length = 0
  pendingPreReadyTerminalInput.length = 0
  pendingPreReadyTerminalInputSize = 0
  pendingTerminalProtocolResponses.length = 0
}

function terminalBackendInputReady() {
  return Boolean(
    sessionId &&
    terminalInputReady &&
    failedTerminalInputGeneration !== terminalInputGeneration
  )
}

function handleTerminalProtocolResponse(data: string) {
  if (!/^\x1b\[\d{1,4};\d{1,4}R$/.test(data)) return false
  pendingTerminalProtocolResponses.push(data)
  flushTerminalProtocolResponses()
  return true
}

function flushTerminalProtocolResponses() {
  if (!terminalBackendInputReady() || pendingTerminalProtocolResponses.length === 0) return
  const data = pendingTerminalProtocolResponses.splice(0).join('')
  enqueueTerminalInput(data, 'direct')
}

function terminalMayBecomeInputReady() {
  return status.value === 'connecting' && failedTerminalInputGeneration !== terminalInputGeneration
}

function bufferPreReadyTerminalInput(data: string) {
  if (!data || !terminalMayBecomeInputReady()) return false
  if (pendingPreReadyTerminalInputSize + data.length > PRE_READY_INPUT_LIMIT) {
    pendingPreReadyTerminalInput.length = 0
    pendingPreReadyTerminalInputSize = 0
    return false
  }
  pendingPreReadyTerminalInput.push({ generation: terminalInputGeneration, data })
  pendingPreReadyTerminalInputSize += data.length
  return true
}

function flushPreReadyTerminalInput() {
  if (!terminalBackendInputReady() || pendingPreReadyTerminalInput.length === 0) return
  const pending = pendingPreReadyTerminalInput.splice(0)
  pendingPreReadyTerminalInputSize = 0
  pending
    .filter((item) => item.generation === terminalInputGeneration)
    .forEach((item) => {
      if (!forwardInteractiveTerminalInput(item.data)) invalidateTrackedTerminalInput()
    })
}

function sameTerminalInputBatch(
  batch: TerminalInputBatch,
  generation: number,
  activeSessionId: string,
  source: TerminalInputWriteSource,
  sourceTerminalId?: string
) {
  return batch.generation === generation &&
    batch.sessionId === activeSessionId &&
    batch.source === source &&
    batch.sourceTerminalId === sourceTerminalId
}

function enqueueTerminalInput(
  data: string,
  source: TerminalInputWriteSource,
  commits: Array<() => void> = [],
  sourceTerminalId?: string
) {
  if (!data || !terminalBackendInputReady()) return false
  const generation = terminalInputGeneration
  const activeSessionId = sessionId
  const tail = terminalInputQueue[terminalInputQueue.length - 1]
  if (tail && sameTerminalInputBatch(tail, generation, activeSessionId, source, sourceTerminalId)) {
    tail.data += data
    tail.commits.push(...commits)
  } else {
    terminalInputQueue.push({
      generation,
      sessionId: activeSessionId,
      data,
      source,
      sourceTerminalId,
      commits: [...commits]
    })
  }
  if (shellPromptSignature) shellPromptDiscoveryOpen = false
  void pumpTerminalInputQueue(generation)
  return true
}

async function pumpTerminalInputQueue(generation = terminalInputGeneration) {
  if (terminalInputPumpGenerations.has(generation)) return
  terminalInputPumpGenerations.add(generation)
  try {
    while (true) {
      const batchIndex = terminalInputQueue.findIndex((item) => item.generation === generation)
      if (batchIndex < 0) break
      const [batch] = terminalInputQueue.splice(batchIndex, 1)
      if (!batch) continue
      if (
        batch.generation !== terminalInputGeneration ||
        batch.sessionId !== sessionId ||
        !terminalInputReady ||
        failedTerminalInputGeneration === batch.generation
      ) {
        continue
      }
      try {
        await terminalWrite(batch.sessionId, batch.data)
      } catch (error) {
        if (batch.generation !== terminalInputGeneration || batch.sessionId !== sessionId) continue
        terminalInputReady = false
        failedTerminalInputGeneration = batch.generation
        pendingTrackedCommands = []
        invalidateTrackedTerminalInput()
        for (let index = terminalInputQueue.length - 1; index >= 0; index -= 1) {
          if (terminalInputQueue[index]?.generation === batch.generation) terminalInputQueue.splice(index, 1)
        }
        emit('terminalInputWriteFailed', {
          terminalId: props.terminalId,
          sourceTerminalId: batch.sourceTerminalId,
          source: batch.source,
          message: formatError(error)
        })
        continue
      }
      if (batch.generation === terminalInputGeneration && batch.sessionId === sessionId && terminalInputReady) {
        batch.commits.forEach(runTerminalInputCommit)
      }
    }
  } finally {
    terminalInputPumpGenerations.delete(generation)
    if (terminalInputQueue.some((batch) => batch.generation === generation)) {
      void pumpTerminalInputQueue(generation)
    }
  }
}

function resetTrackedTerminalInput(context: TerminalInputContext = terminalInputContext) {
  inputCommandBuffer = ''
  inputCommandCursor = 0
  inputCommandReliable = true
  terminalInputContext = context
  completionSuppressedForHistoryNavigation = false
}

function parseShellPrompt(value: string): ShellPromptSignature | undefined {
  const text = value.trimEnd()
  if (!text || text.length > 512) return undefined

  if (/^PS\s+[^>\r\n]+>$/.test(text)) {
    return { kind: 'powershell', identity: 'powershell', sigil: '>' }
  }

  const cmdPrompt = /^([A-Za-z]):\\[^>\r\n]*>$/.exec(text)
  if (cmdPrompt) {
    return { kind: 'cmd', identity: cmdPrompt[1]?.toLowerCase() ?? '', sigil: '>' }
  }

  const posixPrompt = /^(?:\([^)]+\)\s*)?\[?([^\s@\[\]]+@[^\s:\]\[]+)(?:[:\s][^\r\n]*)?\]?([#$%])$/.exec(text)
  if (posixPrompt) {
    return {
      kind: 'posix',
      identity: posixPrompt[1]?.toLowerCase() ?? '',
      sigil: posixPrompt[2] ?? ''
    }
  }

  if (/^[$#%>]$/.test(text)) {
    return { kind: 'bare', identity: text, sigil: text }
  }

  const genericPrompt = /^[^\r\n]{2,160}([$#%>\u276f\u279c\u203a\u03bb\u00bb])$/.exec(text)
  if (genericPrompt) {
    return { kind: 'generic', identity: text, sigil: genericPrompt[1] ?? '' }
  }

  return undefined
}

function recognizedShellPrompt(lastLine: string) {
  const text = lastLine.trimEnd()
  if (!text) return undefined

  const candidate = parseShellPrompt(text)
  if (shellPromptDiscoveryOpen) {
    return candidate ? { text, signature: candidate } : undefined
  }

  const learned = shellPromptSignature
  if (!learned || !shellPromptText) return undefined
  if (text.startsWith(shellPromptText) && text.length > shellPromptText.length) return undefined
  if (
    (text === shellPromptText || text.endsWith(shellPromptText)) &&
    (learned.kind !== 'bare' || shellCommandAwaitingPrompt)
  ) {
    return { text: shellPromptText, signature: learned }
  }
  // 命令提交后等待新提示符时,接受强特征提示符并重新学习签名,
  // 覆盖嵌套 ssh/su/堡垒机跳转等切换 shell 身份的场景
  if (
    shellCommandAwaitingPrompt &&
    candidate &&
    (candidate.kind === 'posix' || candidate.kind === 'cmd' || candidate.kind === 'powershell')
  ) {
    return { text, signature: candidate }
  }
  if (learned.kind === 'bare') return undefined
  if (!candidate) return undefined
  if (learned.kind === 'powershell' && candidate.kind === 'powershell') {
    return { text, signature: candidate }
  }
  if (learned.kind === 'cmd' && candidate.kind === 'cmd') {
    return { text, signature: candidate }
  }
  if (
    learned.kind === 'posix' &&
    candidate.kind === 'posix' &&
    learned.identity === candidate.identity &&
    learned.sigil === candidate.sigil
  ) {
    return { text, signature: candidate }
  }
  if (
    learned.kind === 'generic' &&
    candidate.kind === 'generic' &&
    learned.sigil === candidate.sigil &&
    shellCommandAwaitingPrompt
  ) {
    return { text, signature: candidate }
  }
  return undefined
}

// 远端把行按终端宽度截断时(如 systemctl 的 ellipsized 输出)可能连同 SGR 重置
// 或 OSC 8 超链接结束序列一起截掉,导致下划线/反显/超链接状态泄漏到后续所有
// 输出。未关闭的 OSC 8 超链接在 xterm.js 中会把之后每个单元格都渲染成虚线下
// 划线,且 SGR 重置按设计不清除链接状态,必须单独补 \x1b]8;;ST。提示符回归时
// 若光标前的字符仍带这些属性,向显示层补一个完整重置。
function clearLeakedTextAttributes() {
  if (!terminal) return
  const buffer = terminal.buffer.active
  if (buffer.type === 'alternate' || buffer.cursorX <= 0) return
  const cell = buffer.getLine(buffer.baseY + buffer.cursorY)?.getCell(buffer.cursorX - 1)
  if (!cell) return
  if (
    cell.isUnderline() ||
    cell.isInverse() ||
    cell.isBlink() ||
    cell.isStrikethrough() ||
    cell.isDim() ||
    cell.isItalic()
  ) {
    terminal.write('\x1b[0m\x1b]8;;\x1b\\')
  }
}

function markTrackedTerminalInputAsShell() {
  shellCommandAwaitingPrompt = false
  clearLeakedTextAttributes()
  if (!inputCommandReliable) {
    resetTrackedTerminalInput('shell')
    return
  }
  terminalInputContext = 'shell'
  if (inputCommandBuffer.trim()) scheduleCompletionSuggestions()
}

function invalidateTrackedTerminalInput() {
  inputCommandBuffer = ''
  inputCommandCursor = 0
  inputCommandReliable = false
  closeCompletion()
}

// Shell integration(OSC 133)集成模式:tracker 处于 input 态(shell 上报了
// 提示符边界)时,输入内容与命令边界以语义标记为准;其余状态(如从集成 shell
// ssh 进无集成远端后 tracker 停在 executing)回落到启发式兜底层,互不锁死。
// 见 docs/shell-integration-development.md。
const SHELL_INTEGRATION_SETTING_KEY = 'ai-term:shell-integration'

function shellIntegrationInjectionEnabled() {
  return window.localStorage.getItem(SHELL_INTEGRATION_SETTING_KEY) !== '0'
}

function shellIntegrationInputActive() {
  return status.value !== 'preview'
    && terminal?.buffer.active.type !== 'alternate'
    && shellIntegrationAttachment?.tracker.state === 'input'
}

function shellIntegrationCommandLine() {
  return shellIntegrationInputActive() ? shellIntegrationAttachment!.tracker.commandLine() : ''
}

function completionInputLine() {
  return shellIntegrationInputActive() ? shellIntegrationCommandLine() : inputCommandBuffer
}

function canOfferCompletion() {
  if (shellIntegrationInputActive()) {
    return !completionSuppressedForHistoryNavigation
      && shellIntegrationCommandLine().trimStart().length >= 2
      && shellIntegrationAttachment!.tracker.cursorAtInputEnd()
  }
  return terminalInputContext === 'shell'
    && inputCommandReliable
    && !completionSuppressedForHistoryNavigation
    && inputCommandBuffer.trimStart().length >= 2
    && inputCommandCursor === inputCommandBuffer.length
}

function terminalLineReadyForAppInput() {
  if (shellIntegrationInputActive()) {
    return shellIntegrationCommandLine().trim().length === 0
  }
  return terminalInputContext === 'shell'
    && inputCommandReliable
    && inputCommandBuffer.trim().length === 0
}

function terminalInputSyncState(): TerminalInputSyncState {
  const available = status.value === 'preview' || terminalBackendInputReady()
  return {
    available,
    context: terminalInputContext,
    reliable: available && terminalInputContext !== 'sensitive' && inputCommandReliable,
    command: terminalInputContext === 'sensitive' ? '' : inputCommandBuffer,
    cursor: terminalInputContext === 'sensitive' ? 0 : inputCommandCursor,
    pendingControlSequence: terminalInputContext === 'sensitive' ? '' : pendingInputControlSequence
  }
}

function commandExecutionReadiness(): TerminalCommandReadiness {
  if (status.value !== 'preview' && !terminalBackendInputReady()) return 'unavailable'
  if (shellIntegrationInputActive()) {
    return shellIntegrationCommandLine().trim() ? 'line-busy' : 'ready'
  }
  updateTerminalInputContextFromOutput()
  if (terminalLineReadyForAppInput()) return 'ready'
  if (terminalInputContext === 'shell') return 'line-busy'
  return 'shell-busy'
}

// read -n1、y/n 确认、分页器按键等输入会被程序直接消费而没有回车,跟踪缓冲会
// 残留这次按键;残留会永久挡住提示符识别,脚本/快捷命令随之一直报"未就绪"。
// 用户已停止输入且屏幕当前行就是干净的已学习提示符时,判定缓冲为残留。
const TRACKED_INPUT_STALE_AFTER_MS = 1_500

function trackedInputResidueIsStale() {
  if (Date.now() - lastTrackedUserInputAt < TRACKED_INPUT_STALE_AFTER_MS) return false
  if (!shellPromptText || !terminal || terminal.buffer.active.type === 'alternate') return false
  const rendered = currentRenderedCommandLine()
  if (!rendered) return false
  if (rendered === shellPromptText) return true
  return shellPromptSignature?.kind !== 'bare' && rendered.endsWith(shellPromptText)
}

function updateTerminalInputContextFromOutput() {
  if (terminal?.buffer.active.type === 'alternate') {
    terminalWasInAlternateBuffer = true
    terminalInputContext = 'unknown'
    invalidateTrackedTerminalInput()
    return
  }
  if (terminalWasInAlternateBuffer) {
    terminalWasInAlternateBuffer = false
    // 退出全屏程序(vim 等)后 shell 会重绘提示符,视同等待新提示符
    shellCommandAwaitingPrompt = true
  }
  const text = terminalOutputRecentTail
    .slice(-2_000)
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '')
  const lastLine = text.split('\n').pop()?.trimEnd() ?? ''
  if (!lastLine) return
  if (/(?:password|passphrase|verification code|one[- ]time(?: password| code)?|otp|pin|token)[^\n]{0,40}[:：]?\s*$/i.test(lastLine)) {
    resetTrackedTerminalInput('sensitive')
    closeCompletion()
    return
  }
  if (inputCommandBuffer.length > 0) {
    if (!trackedInputResidueIsStale()) return
    resetTrackedTerminalInput()
  }
  if (!shellPromptDiscoveryOpen && terminalInputContext === 'shell') return
  const prompt = recognizedShellPrompt(lastLine)
  if (!prompt) return
  shellPromptText = prompt.text
  shellPromptSignature = prompt.signature
  markTrackedTerminalInputAsShell()
}

function insertTrackedTerminalText(text: string) {
  if (!text || terminalInputContext === 'sensitive') return
  inputCommandBuffer = `${inputCommandBuffer.slice(0, inputCommandCursor)}${text}${inputCommandBuffer.slice(inputCommandCursor)}`
  inputCommandCursor += text.length
}

function deleteTrackedTerminalWord() {
  if (inputCommandCursor <= 0) return
  const before = inputCommandBuffer.slice(0, inputCommandCursor)
  const start = before.search(/\s*\S+\s*$/)
  const deleteFrom = start === -1 ? 0 : start
  inputCommandBuffer = `${inputCommandBuffer.slice(0, deleteFrom)}${inputCommandBuffer.slice(inputCommandCursor)}`
  inputCommandCursor = deleteFrom
}

function previousTrackedTextBoundary(text: string, cursor: number) {
  if (cursor <= 0) return 0
  const codePoints = Array.from(text.slice(0, cursor))
  const previous = codePoints[codePoints.length - 1]
  return Math.max(0, cursor - (previous?.length ?? 1))
}

function nextTrackedTextBoundary(text: string, cursor: number) {
  if (cursor >= text.length) return text.length
  const [next] = Array.from(text.slice(cursor))
  return Math.min(text.length, cursor + (next?.length ?? 1))
}

function trackUserInput(data: string): TerminalInputTrackResult {
  lastTrackedUserInputAt = Date.now()
  if (isHistoryNavigationInput(data)) {
    completionSuppressedForHistoryNavigation = true
    invalidateTrackedTerminalInput()
    return 'idle'
  }
  if (data === '\x1b[D' || data === '\x1bOD') {
    if (inputCommandReliable) inputCommandCursor = previousTrackedTextBoundary(inputCommandBuffer, inputCommandCursor)
    closeCompletion()
    return 'idle'
  }
  if (data === '\x1b[C' || data === '\x1bOC') {
    if (inputCommandReliable && inputCommandCursor >= inputCommandBuffer.length) {
      invalidateTrackedTerminalInput()
      return 'idle'
    }
    if (inputCommandReliable) inputCommandCursor = nextTrackedTextBoundary(inputCommandBuffer, inputCommandCursor)
    closeCompletion()
    return 'idle'
  }
  if (data === '\x1b[H' || data === '\x1bOH') {
    if (inputCommandReliable) inputCommandCursor = 0
    closeCompletion()
    return 'idle'
  }
  if (data === '\x1b[F' || data === '\x1bOF') {
    invalidateTrackedTerminalInput()
    return 'idle'
  }
  if (data === '\x1b[3~') {
    if (inputCommandReliable && inputCommandCursor < inputCommandBuffer.length) {
      const deleteTo = nextTrackedTextBoundary(inputCommandBuffer, inputCommandCursor)
      inputCommandBuffer = `${inputCommandBuffer.slice(0, inputCommandCursor)}${inputCommandBuffer.slice(deleteTo)}`
    }
    closeCompletion()
    return 'changed'
  }
  if (data === '\t') {
    invalidateTrackedTerminalInput()
    return 'idle'
  }
  if (data.includes('\x1b') && !data.includes('\x1b[200~') && !data.includes('\x1b[201~')) {
    invalidateTrackedTerminalInput()
    return 'idle'
  }

  const commandInput = stripCommandInputControlSequences(data)
  const allowDeferredCapture = data === '\r' || data === '\n'
  let result: TerminalInputTrackResult = 'idle'
  for (const character of commandInput) {
    const code = character.charCodeAt(0)
    if (code === 13 || code === 10) {
      // 集成模式下命令由 OSC 133;C/D 精确捕获(含退出码),跳过影子捕获避免重复记录
      const integrationCaptures = shellIntegrationInputActive()
      const command = integrationCaptures ? '' : submittedTerminalCommand(inputCommandBuffer)
      const deferredCapture = integrationCaptures || command || !allowDeferredCapture
        ? undefined
        : deferredCommandCapture()
      if (command) pendingTrackedCommands.push(command)
      if (deferredCapture) pendingDeferredCommandCaptures.push(deferredCapture)
      if (terminalInputContext === 'shell' || command || deferredCapture) {
        shellCommandAwaitingPrompt = true
      }
      resetTrackedTerminalInput('unknown')
      result = 'submitted'
    } else if (code === 127 || code === 8) {
      if (terminalInputContext !== 'sensitive' && inputCommandReliable && inputCommandCursor > 0) {
        const deleteFrom = previousTrackedTextBoundary(inputCommandBuffer, inputCommandCursor)
        inputCommandBuffer = `${inputCommandBuffer.slice(0, deleteFrom)}${inputCommandBuffer.slice(inputCommandCursor)}`
        inputCommandCursor = deleteFrom
      }
      result = inputCommandBuffer.trim() ? 'changed' : 'submitted'
    } else if (code === 1) {
      if (inputCommandReliable) inputCommandCursor = 0
    } else if (code === 3) {
      resetTrackedTerminalInput('unknown')
      result = 'submitted'
    } else if (code === 5) {
      invalidateTrackedTerminalInput()
    } else if (code === 11) {
      if (inputCommandReliable) inputCommandBuffer = inputCommandBuffer.slice(0, inputCommandCursor)
      result = inputCommandBuffer.trim() ? 'changed' : 'submitted'
    } else if (code === 21) {
      if (inputCommandReliable) {
        inputCommandBuffer = inputCommandBuffer.slice(inputCommandCursor)
        inputCommandCursor = 0
      }
      result = inputCommandBuffer.trim() ? 'changed' : 'submitted'
    } else if (code === 23) {
      if (inputCommandReliable) deleteTrackedTerminalWord()
      result = inputCommandBuffer.trim() ? 'changed' : 'submitted'
    } else if (code < 32) {
      invalidateTrackedTerminalInput()
    } else if (character >= ' ') {
      insertTrackedTerminalText(character)
      result = 'changed'
    }
  }
  return result
}

function terminalInputSafeForSync(
  data: string,
  beforeState: TerminalInputSyncState,
  afterState: TerminalInputSyncState
) {
  if (data === '\x03') return true
  if (!beforeState.available || beforeState.context !== 'shell' || !beforeState.reliable) return false
  if (data === '\r' || data === '\n') return true
  if (data.includes('\r') || data.includes('\n') || data === '\t') return false
  if (data.startsWith('\x1b[200~') || data.endsWith('\x1b[201~')) return false
  const isBackspace = data === '\x7f' || data === '\b'
  if (!isBackspace && Array.from(data).some((character) => (character.codePointAt(0) ?? 0) < 32)) return false
  if (data.includes('\x1b')) return false
  return afterState.context === 'shell' && afterState.reliable
}

function stripCommandInputControlSequences(data: string) {
  let visible = ''
  for (const char of data) {
    if (pendingInputControlSequence) {
      if (!skipInputControlSequence(char)) {
        visible += char
      }
      continue
    }
    if (char === '\x1b') {
      pendingInputControlSequence = char
      continue
    }
    visible += char
  }
  return visible
}

function skipInputControlSequence(char: string) {
  pendingInputControlSequence += char
  if (pendingInputControlSequence.length > 32) {
    pendingInputControlSequence = ''
    return false
  }
  const code = char.charCodeAt(0)
  const isPendingCsiInputSequence = pendingInputControlSequence.startsWith('\x1b[')
  if (isPendingCsiInputSequence && pendingInputControlSequence.length > 2 && code >= 0x40 && code <= 0x7e) {
    pendingInputControlSequence = ''
  } else if (!isPendingCsiInputSequence && code >= 0x40 && code <= 0x7e) {
    pendingInputControlSequence = ''
  }
  return true
}

function resolvedTerminalSettings() {
  return {
    terminalFontFamily: props.terminalSettings?.terminalFontFamily || 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    terminalFontSize: Math.max(11, Math.min(22, Number(props.terminalSettings?.terminalFontSize) || 13)),
    terminalTheme: props.appTheme === 'light' ? 'light' : props.terminalSettings?.terminalTheme || 'midnight'
  }
}

function terminalThemeOptions(theme: TerminalTheme) {
  if (theme === 'matrix') {
    return {
      background: '#050807',
      foreground: '#d8ffe7',
      cursor: '#7cffb2',
      selectionBackground: '#68d39138',
      selectionInactiveBackground: '#68d39124',
      blue: '#8cc8ff',
      cyan: '#5ff1d2',
      green: '#63ff91',
      yellow: '#f2ff86',
      red: '#ff7d7d'
    }
  }
  if (theme === 'light') {
    return {
      background: '#f6f8fb',
      foreground: '#172033',
      cursor: '#1d4ed8',
      selectionBackground: '#10b98133',
      selectionInactiveBackground: '#10b98124',
      blue: '#2563eb',
      cyan: '#0891b2',
      green: '#047857',
      yellow: '#a16207',
      red: '#dc2626'
    }
  }
  return {
    background: '#0b0d0e',
    foreground: '#d5dde5',
    cursor: '#d8f3ff',
    selectionBackground: '#e2e8f042',
    selectionInactiveBackground: '#e2e8f02e',
    blue: '#88b7ff',
    cyan: '#60d8e8',
    green: '#7ee094',
    yellow: '#ffc95e'
  }
}

function applyTerminalAppearance() {
  if (!terminal) return
  const settings = resolvedTerminalSettings()
  terminal.options.fontFamily = settings.terminalFontFamily
  terminal.options.fontSize = settings.terminalFontSize
  terminal.options.lineHeight = terminalTypographyOptions.lineHeight
  terminal.options.letterSpacing = terminalTypographyOptions.letterSpacing
  terminal.options.fontWeight = terminalTypographyOptions.fontWeight
  terminal.options.fontWeightBold = terminalTypographyOptions.fontWeightBold
  terminal.options.theme = terminalThemeOptions(settings.terminalTheme)
  terminal.refresh(0, terminal.rows - 1)
  scheduleTerminalSizeSync()
  scheduleTerminalSizeSyncAfterFonts()
}

onMounted(async () => {
  if (!terminalHost.value) return

  terminal = new Terminal({
    cursorBlink: true,
    convertEol: false,
    fontFamily: resolvedTerminalSettings().terminalFontFamily,
    fontSize: resolvedTerminalSettings().terminalFontSize,
    ...terminalTypographyOptions,
    theme: terminalThemeOptions(resolvedTerminalSettings().terminalTheme)
  })
  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  shellIntegrationAttachment = attachShellIntegration(terminal, {
    onInputStart: () => {
      completionSuppressedForHistoryNavigation = false
    },
    onCommandStart: () => closeCompletion(),
    onCommandFinished: (result) => recordCommand(result.command, result.exitCode)
  })
  terminal.open(terminalHost.value)
  syncTerminalSize()
  terminal.focus()

  dataDisposable = terminal.onData((data) => {
    if (handleTerminalProtocolResponse(data)) return
    if (terminalInputDestinationAvailable()) {
      if (handleCompletionInput(data)) return
      forwardInteractiveTerminalInput(data)
      return
    }
    bufferPreReadyTerminalInput(data)
  })
  selectionDisposable = terminal.onSelectionChange(() => {
    if (terminalSelectionNormalizing) return
    const activeTerminal = terminal
    if (activeTerminal?.hasSelection() && !normalizedTerminalSelectionText(activeTerminal.getSelection()).trim()) {
      normalizeTerminalSelectionToContent()
      emitTerminalSelection('')
      return
    }
    // xterm fires this continuously while dragging; a trailing debounce
    // collapses the drag into a single clipboard IPC + selection emit.
    if (selectionCopyTimer !== undefined) window.clearTimeout(selectionCopyTimer)
    selectionCopyTimer = window.setTimeout(() => {
      selectionCopyTimer = undefined
      void copySelectionToClipboard()
    }, SELECTION_COPY_DEBOUNCE)
  })
  terminalHost.value.addEventListener('pointerdown', handleTerminalPointerDown, true)
  terminalHost.value.addEventListener('contextmenu', handleTerminalContextMenu, true)
  document.addEventListener('pointerdown', handleDocumentPointerDown, true)
  window.addEventListener(QUICK_COMMANDS_CHANGED_EVENT, handleQuickCommandsChanged)
  quickCommandSettingsButton.value?.addEventListener('pointerdown', handleQuickCommandSettingsPointerDown, true)

  resizeObserver = new ResizeObserver(() => scheduleTerminalSizeSync())
  resizeObserver.observe(terminalHost.value)
  scheduleTerminalSizeSyncAfterFonts()

  if (isSftpProfile(props.profile)) {
    enterSftpProfileMode()
  } else if (props.profile) {
    await connectRemote()
  } else {
    await connectLocal()
  }
})

watch(status, (value) => emitTerminalStatus(value), { immediate: true })

watch(
  () => props.terminalSettings,
  () => applyTerminalAppearance()
)

watch(
  () => props.appTheme,
  () => applyTerminalAppearance()
)

watch(
  () => props.active,
  async (active) => {
    if (!active) return
    await nextTick()
    scheduleTerminalSizeSync(true)
    terminal?.focus()
    terminalHost.value?.focus()
  }
)

watch(
  () => props.connectRequest,
  async () => {
    if (!terminal || props.connectRequest === 0) return
    if (props.profile) {
      if (isSftpProfile(props.profile)) {
        enterSftpProfileMode()
      } else {
        await connectRemote()
      }
    } else {
      await connectLocal()
    }
  }
)

watch(
  () => props.profile?.id,
  () => {
    if (!terminal || props.profile || sessionId) return
    void connectLocal()
  }
)

function handleTerminalSessionClosed(reason: string) {
  if (!sessionId) return
  const closedSessionId = sessionId
  advanceTerminalInputGeneration()
  sessionId = ''
  status.value = 'idle'
  resetTrackedTerminalInput('unknown')
  closeCompletion()
  const message = `\r\nShell exited: ${reason}\r\n`
  writeTerminalView(message, true)
  appendTerminalOutput(message)
  void disconnectTerminal(closedSessionId)
}

async function verifyTerminalSessionStillActive(activeSessionId: string) {
  await new Promise((resolve) => window.setTimeout(resolve, 150))
  try {
    const active = await terminalSessionActive(activeSessionId)
    if (!active && sessionId === activeSessionId) {
      handleTerminalSessionClosed('eof')
      return false
    }
    return active
  } catch (error) {
    console.warn('failed to verify terminal session state', error)
    return sessionId === activeSessionId
  }
}

async function attachTerminalEvents(activeSessionId = sessionId) {
  unlisten?.()
  unlistenClosed?.()
  unlisten = undefined
  unlistenClosed = undefined
  if (!activeSessionId) return false

  const nextUnlisten = await onTerminalData(activeSessionId, (event) => {
    if (event.sessionId === activeSessionId && sessionId === activeSessionId) {
      writeTerminalView(event.data)
      appendTerminalOutput(event.data)
    }
  })
  if (sessionId !== activeSessionId) {
    nextUnlisten()
    return false
  }

  let nextUnlistenClosed: (() => void) | undefined
  try {
    nextUnlistenClosed = await onTerminalClosed(activeSessionId, (event) => {
      if (event.sessionId !== activeSessionId || sessionId !== activeSessionId) return
      handleTerminalSessionClosed(event.reason)
    })
  } catch (error) {
    nextUnlisten()
    throw error
  }
  if (sessionId !== activeSessionId) {
    nextUnlisten()
    nextUnlistenClosed()
    return false
  }

  unlisten = nextUnlisten
  unlistenClosed = nextUnlistenClosed
  return true
}

async function connectRemote() {
  if (!terminal || !terminalHost.value || !props.profile) return
  const attempt = startConnectionAttempt()
  const profile = props.profile
  let connectedSessionId = ''
  try {
    disconnect(false, false)
    activeSession.value = 'remote'
    activeSessionProfile.value = profile
    status.value = 'connecting'
    terminal.reset()
    const size = currentTerminalSize()
    terminal.writeln(`Connecting SSH profile: ${profile.name}`)
    scrollTerminalToBottom()
    setTerminalOutputBuffer(`Connecting SSH profile: ${profile.name}\n`)
    emitTerminalSnapshot()
    connectedSessionId = await connectProfile(profile.id, size.cols, size.rows)
    if (!isCurrentConnectionAttempt(attempt)) {
      void disconnectTerminal(connectedSessionId)
      return
    }
    sessionId = connectedSessionId
    if (!await attachTerminalEvents()) {
      void disconnectTerminal(connectedSessionId)
      return
    }
    if (!isCurrentConnectionAttempt(attempt) || sessionId !== connectedSessionId) {
      void disconnectTerminal(connectedSessionId)
      return
    }
    const active = await verifyTerminalSessionStillActive(connectedSessionId)
    if (!isCurrentConnectionAttempt(attempt) || sessionId !== connectedSessionId) {
      void disconnectTerminal(connectedSessionId)
      return
    }
    if (!active) return
    terminalInputReady = true
    flushTerminalProtocolResponses()
    flushPreReadyTerminalInput()
    status.value = 'remote'
    syncTerminalSize(true)
    await nextTick()
    terminal.focus()
  } catch (error) {
    if (!isCurrentConnectionAttempt(attempt)) {
      if (connectedSessionId) void disconnectTerminal(connectedSessionId)
      return
    }
    const failedSessionId = sessionId || connectedSessionId
    advanceTerminalInputGeneration()
    sessionId = ''
    unlisten?.()
    unlistenClosed?.()
    unlisten = undefined
    unlistenClosed = undefined
    if (failedSessionId) void disconnectTerminal(failedSessionId)
    status.value = 'error'
    activeSession.value = 'remote'
    activeSessionProfile.value = profile
    const detail = formatError(error)
    const message = `\r\nSSH connection failed: ${detail}\r\n`
    writeTerminalView(message, true)
    appendTerminalOutput(message)
    if (shouldAskForSshHostKeyReset(error)) {
      openSshHostKeyPrompt(detail)
    } else if (shouldAskForSshPassword(error)) {
      openSshAuthPrompt(detail)
    }
  }
}

async function connectLocal() {
  if (!terminal || !terminalHost.value) return
  const attempt = startConnectionAttempt()
  const requestedSessionId = createTerminalSessionId('local')
  let connectedSessionId = ''
  try {
    disconnect(false, false)
    status.value = 'connecting'
    activeSession.value = 'local'
    activeSessionProfile.value = undefined
    terminal.reset()
    terminal.writeln('Opening local shell...')
    scrollTerminalToBottom()
    setTerminalOutputBuffer('Opening local shell...\n')
    emitTerminalSnapshot()
    const size = currentTerminalSize()
    sessionId = requestedSessionId
    if (!await attachTerminalEvents()) throw new Error('Failed to attach local terminal events')
    connectedSessionId = await connectLocalTerminal(
      size.cols,
      size.rows,
      requestedSessionId,
      shellIntegrationInjectionEnabled()
    )
    if (!isCurrentConnectionAttempt(attempt)) {
      void disconnectTerminal(connectedSessionId)
      return
    }
    if (connectedSessionId !== sessionId) {
      sessionId = connectedSessionId
      if (!await attachTerminalEvents()) {
        void disconnectTerminal(connectedSessionId)
        return
      }
    }
    if (!isCurrentConnectionAttempt(attempt) || sessionId !== connectedSessionId) {
      void disconnectTerminal(connectedSessionId)
      return
    }
    const active = await verifyTerminalSessionStillActive(connectedSessionId)
    if (!isCurrentConnectionAttempt(attempt) || sessionId !== connectedSessionId) {
      void disconnectTerminal(connectedSessionId)
      return
    }
    if (!active) return
    terminalInputReady = true
    flushTerminalProtocolResponses()
    flushPreReadyTerminalInput()
    status.value = 'local'
    syncTerminalSize(true)
    await nextTick()
    terminal.focus()
  } catch (error) {
    if (!isCurrentConnectionAttempt(attempt)) {
      if (connectedSessionId) void disconnectTerminal(connectedSessionId)
      return
    }
    advanceTerminalInputGeneration()
    sessionId = ''
    unlisten?.()
    unlistenClosed?.()
    unlisten = undefined
    unlistenClosed = undefined
    if (connectedSessionId) void disconnectTerminal(connectedSessionId)
    if (isTauriUnavailableError(error)) {
      enterPreviewMode()
    } else {
      enterLocalShellErrorMode(error)
    }
  }
}

function enterLocalShellErrorMode(error: unknown) {
  terminalInputReady = false
  status.value = 'error'
  activeSession.value = 'local'
  activeSessionProfile.value = undefined
  sessionId = ''
  const detail = formatError(error)
  const message = `Local shell failed to start: ${detail}`
  terminal?.reset()
  terminal?.writeln('\x1b[31mLocal shell failed to start.\x1b[0m')
  terminal?.writeln(detail)
  terminal?.writeln('')
  terminal?.writeln('Use New Local Shell to retry.')
  scrollTerminalToBottom()
  appendTerminalOutput(`${message}\nUse New Local Shell to retry.\n`)
}

function enterPreviewMode() {
  terminalInputReady = false
  status.value = 'preview'
  activeSession.value = 'preview'
  activeSessionProfile.value = undefined
  sessionId = ''
  terminal?.clear()
  terminal?.writeln('\x1b[33mTauri backend is not available in browser preview.\x1b[0m')
  terminal?.writeln('Run `cargo run` inside src-tauri to attach a local shell.')
  terminal?.writeln('')
  writeTerminalView('\x1b[94mpreview\x1b[0m$ ', true)
  appendTerminalOutput('Tauri backend is not available in browser preview.\nRun `cargo run` inside src-tauri to attach a local shell.\npreview$ ')
  shellPromptText = 'preview$'
  shellPromptSignature = parseShellPrompt(shellPromptText)
  shellPromptDiscoveryOpen = false
  resetTrackedTerminalInput('shell')
}

function enterSftpProfileMode() {
  if (!terminal || !props.profile) return
  disconnect(false)
  terminalInputReady = false
  status.value = 'sftp'
  activeSession.value = 'sftp'
  activeSessionProfile.value = props.profile
  sessionId = ''
  terminal.reset()
  terminal.writeln('\x1b[36mSFTP profile is ready.\x1b[0m')
  terminal.writeln(`Profile: ${props.profile.name}`)
  terminal.writeln(`Target: ${props.profile.target.username || 'user'}@${props.profile.target.host || 'server'}`)
  terminal.writeln(`Mode: ${props.profile.fileTransferMode === 'sftp-gateway' ? 'SFTP 经网关' : 'SFTP 直连'}`)
  terminal.writeln('')
  terminal.writeln('Use the SFTP workspace on the right to browse, upload, and download files.')
  scrollTerminalToBottom()
  setTerminalOutputBuffer([
    'SFTP profile is ready.',
    `Profile: ${props.profile.name}`,
    `Target: ${props.profile.target.username || 'user'}@${props.profile.target.host || 'server'}`,
    `Mode: ${props.profile.fileTransferMode === 'sftp-gateway' ? 'SFTP 经网关' : 'SFTP 直连'}`,
    'Use the SFTP workspace on the right to browse, upload, and download files.'
  ].join('\n'))
  emitTerminalSnapshot()
  void nextTick(() => terminal?.focus())
}

function clearTerminal() {
  terminal?.clear()
}

async function copyTerminalOutput() {
  if (!terminalOutputBuffer.trim()) return
  await writeClipboard(terminalOutputBuffer)
}

function restartLocalTerminal() {
  void connectLocal()
}

function showQuickCommandBarNotice(message: string) {
  quickCommandBarNotice.value = message
  if (quickCommandBarNoticeTimer !== undefined) window.clearTimeout(quickCommandBarNoticeTimer)
  quickCommandBarNoticeTimer = window.setTimeout(() => {
    quickCommandBarNotice.value = ''
    quickCommandBarNoticeTimer = undefined
  }, 2600)
}

function fillCommand(command: string) {
  const value = command.trim()
  if (!value) return false
  if (!terminalLineReadyForAppInput()) {
    showQuickCommandBarNotice(completionInputLine().trim() ? '当前命令行已有输入，请先提交或清空。' : '当前终端不在可识别的命令提示符。')
    focusTerminal()
    return false
  }
  closeCompletion()
  if (sendInteractiveTerminalInput(value, false)) {
    showQuickCommandBarNotice('已填入终端，按 Enter 执行。')
    return true
  }
  showQuickCommandBarNotice('当前终端不可用。')
  return false
}

function terminalInputDestinationAvailable() {
  return status.value === 'preview' || terminalBackendInputReady()
}

function takePendingTrackedCommands() {
  return pendingTrackedCommands.splice(0)
}

function takePendingDeferredCommandCaptures() {
  return pendingDeferredCommandCaptures.splice(0)
}

function runTerminalInputCommit(commit: () => void) {
  try {
    commit()
  } catch (error) {
    console.error('failed to commit terminal input side effect', error)
  }
}

function writePreparedTerminalInput(data: string, options: PreparedTerminalInputOptions) {
  if (!data || !terminalInputDestinationAvailable()) return false
  const submittedCommands = [...(options.submittedCommands ?? [])]
  const commits: Array<() => void> = []
  if (submittedCommands.length > 0) {
    commits.push(() => commitTrackedCommands(submittedCommands))
  }
  if (options.onWritten) commits.push(options.onWritten)

  if (terminalBackendInputReady()) {
    if (!enqueueTerminalInput(data, options.source, commits, options.sourceTerminalId)) return false
    // vim 鼠标模式下 xterm 会以 onData 形式发出鼠标上报等转义序列,并不代表
    // 用户在终端打字;此时不抢焦点,避免把 AI/脚本面板输入框的焦点拉回终端
    if (options.source !== 'interactive' || !data.startsWith('\x1b')) {
      void nextTick(() => terminal?.focus())
    }
    return true
  }
  if (status.value !== 'preview') return false
  writeTerminalView(data, true)
  appendTerminalOutput(data)
  commits.forEach(runTerminalInputCommit)
  if (shellPromptSignature) shellPromptDiscoveryOpen = false
  return true
}

function executeCommand(command: string) {
  const value = command.trim()
  if (!value) return false
  if (terminalBackendInputReady()) {
    if (!terminalLineReadyForAppInput()) return false
    closeCompletion()
    const integrationCaptures = shellIntegrationInputActive()
    const accepted = writePreparedTerminalInput(value + '\r', {
      source: 'command',
      // 集成模式下由 OSC 133;C/D 记录(含退出码),避免重复
      onWritten: () => {
        if (!integrationCaptures) recordCommand(value)
      }
    })
    if (!accepted) return false
    shellCommandAwaitingPrompt = true
    resetTrackedTerminalInput('unknown')
    pendingInputControlSequence = ''
    return true
  }
  if (status.value === 'preview') {
    if (!terminalLineReadyForAppInput()) return false
    const previewLine = `${value}\r\n`
    writeTerminalView(previewLine, true)
    appendTerminalOutput(previewLine)
    recordCommand(value)
    resetTrackedTerminalInput('shell')
    return true
  }
  return false
}

function forwardInteractiveTerminalInput(data: string, synchronize = true) {
  if (!data || !terminalInputDestinationAvailable()) return false
  const beforeState = terminalInputSyncState()
  const inputResult = trackUserInput(data)
  updateCompletionAfterInput(inputResult)
  const afterState = terminalInputSyncState()
  const submittedCommands = takePendingTrackedCommands()
  const deferredCaptures = takePendingDeferredCommandCaptures()
  const event: TerminalInputEvent | undefined = synchronize
    ? {
        terminalId: props.terminalId,
        data,
        beforeState,
        safeToSync: terminalInputSafeForSync(data, beforeState, afterState)
      }
    : undefined
  const accepted = writePreparedTerminalInput(data, {
    source: 'interactive',
    submittedCommands,
    onWritten: () => {
      deferredCaptures.forEach(scheduleDeferredCommandCapture)
      if (event) emit('terminalInput', event)
    }
  })
  if (!accepted) invalidateTrackedTerminalInput()
  return accepted
}

function sendInteractiveTerminalInput(data: string, synchronize = true) {
  return forwardInteractiveTerminalInput(data, synchronize)
}

function writeSyncedTerminalInput(data: string, sourceTerminalId: string) {
  if (!data || !terminalInputDestinationAvailable()) return false
  const inputResult = trackUserInput(data)
  updateCompletionAfterInput(inputResult)
  const submittedCommands = takePendingTrackedCommands()
  const deferredCaptures = takePendingDeferredCommandCaptures()
  const accepted = writePreparedTerminalInput(data, {
    source: 'synced',
    sourceTerminalId,
    submittedCommands,
    onWritten: () => deferredCaptures.forEach(scheduleDeferredCommandCapture)
  })
  if (!accepted) invalidateTrackedTerminalInput()
  return accepted
}

function writeTerminalInput(data: string) {
  if (!data || !terminalInputDestinationAvailable()) return false
  if (data.includes('\r') || data.includes('\n')) shellCommandAwaitingPrompt = true
  resetTrackedTerminalInput('unknown')
  pendingInputControlSequence = ''
  closeCompletion()
  return writePreparedTerminalInput(data, { source: 'direct' })
}

async function pasteClipboardToTerminal() {
  try {
    const text = await readClipboard()
    if (!text) return
    if (terminal && terminalBackendInputReady()) {
      terminal.paste(text)
      return
    }
    sendInteractiveTerminalInput(text.replace(/\r?\n/g, '\r'))
  } catch (error) {
    console.warn('failed to paste terminal clipboard', error)
  }
}

function requestTerminalPaste(event: MouseEvent | PointerEvent) {
  event.preventDefault()
  event.stopPropagation()
  terminal?.focus()
  lastRightClickPasteAt = Date.now()
  void pasteClipboardToTerminal()
}

function handleTerminalPointerDown(event: PointerEvent) {
  if (event.button !== 2) return
  requestTerminalPaste(event)
}

function handleTerminalContextMenu(event: MouseEvent) {
  event.preventDefault()
  event.stopPropagation()
  if (Date.now() - lastRightClickPasteAt < 350) return
  requestTerminalPaste(event)
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function isTauriUnavailableError(error: unknown) {
  const message = formatError(error)
  return message.includes('__TAURI_IPC__') || message.includes('window.__TAURI_IPC__') || message.includes('invoke')
}

function disconnect(renderReady = true, cancelPending = true) {
  if (cancelPending) connectionAttempt += 1
  const previousSessionId = sessionId
  advanceTerminalInputGeneration()
  sessionId = ''
  activeSession.value = 'local'
  activeSessionProfile.value = undefined
  status.value = 'idle'
  resetTrackedTerminalInput('unknown')
  closeCompletion()
  unlisten?.()
  unlistenClosed?.()
  unlisten = undefined
  unlistenClosed = undefined
  if (previousSessionId) {
    void disconnectTerminal(previousSessionId)
  }
  if (renderReady && terminal) renderIdlePrompt(terminal)
}

function disconnectFromButton() {
  disconnect()
}

function focusTerminal() {
  terminal?.focus()
  terminalHost.value?.focus()
}

onBeforeUnmount(() => {
  terminalHost.value?.removeEventListener('pointerdown', handleTerminalPointerDown, true)
  terminalHost.value?.removeEventListener('contextmenu', handleTerminalContextMenu, true)
  document.removeEventListener('pointerdown', handleDocumentPointerDown, true)
  window.removeEventListener(QUICK_COMMANDS_CHANGED_EVENT, handleQuickCommandsChanged)
  if (quickCommandBarNoticeTimer !== undefined) window.clearTimeout(quickCommandBarNoticeTimer)
  if (terminalOutputEmitTimer !== undefined) window.clearTimeout(terminalOutputEmitTimer)
  if (selectionCopyTimer !== undefined) window.clearTimeout(selectionCopyTimer)
  quickCommandSettingsButton.value?.removeEventListener('pointerdown', handleQuickCommandSettingsPointerDown, true)
  if (terminalFitFrame) window.cancelAnimationFrame(terminalFitFrame)
  disconnect(false)
  resizeObserver?.disconnect()
  unlisten?.()
  unlistenClosed?.()
  dataDisposable?.dispose()
  selectionDisposable?.dispose()
  shellIntegrationAttachment?.dispose()
  shellIntegrationAttachment = undefined
  terminal?.dispose()
  fitAddon = undefined
})

defineExpose({
  clearTerminal,
  commandExecutionReadiness,
  disconnectFromButton,
  executeCommand,
  fillCommand,
  focusTerminal,
  pinQuickCommand,
  restartLocalTerminal,
  terminalInputSyncState,
  writeTerminalInput,
  writeSyncedTerminalInput
})
</script>

<template>
  <main class="terminal-pane">
    <section class="terminal-wrap">
      <div class="terminal-frame terminal-native-code">
        <div ref="terminalBodyWrap" class="terminal-body-wrap">
          <div ref="terminalHost" class="xterm-host" aria-label="终端直接输入" />
          <div
            v-if="terminalCompletionOpen"
            ref="terminalCompletion"
            class="terminal-completion"
            :data-side="completionPlacement"
            :style="completionPositionStyle"
            role="listbox"
            aria-label="命令推荐"
          >
            <button
              v-for="(suggestion, index) in completionSuggestions"
              :key="`${suggestion.source}-${suggestion.command}`"
              type="button"
              role="option"
              :class="{ selected: index === selectedCompletionIndex }"
              :aria-selected="index === selectedCompletionIndex"
              @pointerdown.prevent="acceptCompletionSuggestion(suggestion)"
            >
              <code>
                <mark>{{ suggestion.command.slice(0, completionPrefixLength) }}</mark><span class="completion-tail">{{ suggestion.command.slice(completionPrefixLength) }}</span>
              </code>
              <span class="completion-meta">
                <span class="completion-source" :class="suggestion.source">{{ completionSourceLabel(suggestion.source) }}</span>
                <span v-if="suggestion.count" class="completion-count">{{ suggestion.count }}×</span>
              </span>
            </button>
          </div>
        </div>
      </div>
    </section>
    <section class="quick-command-bar" aria-label="固定命令">
      <span>固定命令</span>
      <button v-for="command in quickCommands" :key="command" type="button" title="填入终端" @click="fillCommand(command)">
        {{ command }}
      </button>
      <span v-if="quickCommandBarNotice" class="quick-command-bar-notice" aria-live="polite">{{ quickCommandBarNotice }}</span>
      <button ref="quickCommandSettingsButton" class="icon-button" type="button" title="固定命令设置" aria-label="固定命令设置" @click.stop="openQuickCommandSettings"><UiIcon name="settings" /></button>
    </section>

    <teleport to="body">
      <div v-if="sshAuthPromptOpen" class="modal-backdrop" role="presentation">
        <section class="modal ssh-auth-modal" role="dialog" aria-modal="true" aria-label="SSH &#35748;&#35777;">
          <div class="modal-head">
            <div>
              <strong>SSH &#35748;&#35777;</strong>
              <span>{{ sshAuthTargetLabel(activeSessionProfile) }}&#38656;&#35201;&#30331;&#24405;&#23494;&#30721;</span>
            </div>
            <button class="icon-button" type="button" title="&#20851;&#38381;" aria-label="&#20851;&#38381;" :disabled="sshAuthSaving" @click="closeSshAuthPrompt"><UiIcon name="close" /></button>
          </div>
          <div class="ssh-auth-body">
            <div class="ssh-auth-target">
              <strong>{{ activeSessionProfile?.name ?? props.profile?.name }}</strong>
              <span>{{ activeSessionProfile ? `${activeSessionProfile.target.username || 'user'}@${activeSessionProfile.target.host || 'server'}` : '' }}</span>
            </div>
            <label>
              <span>&#23494;&#30721;</span>
              <input
                v-model="sshAuthPassword"
                type="password"
                autocomplete="current-password"
                placeholder="&#36755;&#20837;&#21518;&#20445;&#23384;&#21040;&#35813;&#36830;&#25509;"
                @keydown.enter.prevent="submitSshAuthPassword"
              />
            </label>
            <p class="ssh-auth-hint">&#23494;&#30721;&#20250;&#20445;&#23384;&#21040;&#24403;&#21069;&#36830;&#25509;&#37197;&#32622;&#12290;&#19979;&#27425;&#36830;&#25509;&#20250;&#22312; SSH &#35748;&#35777;&#38454;&#27573;&#33258;&#21160;&#20351;&#29992;&#65292;&#32456;&#31471;&#37324;&#19981;&#20877;&#37325;&#22797;&#24377;&#23494;&#30721;&#25552;&#31034;&#12290;</p>
            <p v-if="sshAuthFailedDetail" class="ssh-auth-detail">{{ sshAuthFailedDetail }}</p>
            <p v-if="sshAuthError" class="save-feedback error">{{ sshAuthError }}</p>
          </div>
          <div class="modal-actions">
            <button class="text-button" type="button" :disabled="sshAuthSaving" @click="closeSshAuthPrompt">{{ '\u53d6\u6d88' }}</button>
            <button class="text-button primary-action" type="button" :disabled="sshAuthSaving" @click="submitSshAuthPassword">
              {{ sshAuthSaving ? '\u8fde\u63a5\u4e2d...' : '\u4fdd\u5b58\u5e76\u8fde\u63a5' }}
            </button>
          </div>
        </section>
      </div>
    </teleport>

    <teleport to="body">
      <div v-if="sshHostKeyPromptOpen" class="modal-backdrop" role="presentation">
        <section class="modal ssh-host-key-modal" role="dialog" aria-modal="true" aria-label="SSH 主机密钥变更">
          <div class="modal-head">
            <div>
              <strong>SSH 主机密钥变更</strong>
              <span>远端主机身份与 AI Term 记录不一致</span>
            </div>
            <button class="icon-button" type="button" title="关闭" aria-label="关闭" :disabled="sshHostKeySaving" @click="closeSshHostKeyPrompt"><UiIcon name="close" /></button>
          </div>
          <div class="ssh-auth-body ssh-host-key-body">
            <div class="ssh-auth-target ssh-host-key-target">
              <strong>{{ sshHostKeyTarget?.label }}</strong>
              <span v-if="sshHostKeyKnownHosts">记录文件：{{ sshHostKeyKnownHosts }}</span>
              <span v-else>AI Term known_hosts</span>
            </div>
            <p class="ssh-host-key-risk">这通常发生在服务器重装、IP 复用或堡垒机目标变更后，也可能代表中间人攻击。请先确认远端新指纹可信，再更新本机记录。</p>
            <p v-if="sshHostKeyFailedDetail" class="ssh-auth-detail ssh-host-key-detail">{{ sshHostKeyFailedDetail }}</p>
            <p v-if="sshHostKeyError" class="save-feedback error">{{ sshHostKeyError }}</p>
          </div>
          <div class="modal-actions">
            <button class="text-button" type="button" :disabled="sshHostKeySaving" @click="closeSshHostKeyPrompt">取消</button>
            <button class="text-button primary-action" type="button" :disabled="sshHostKeySaving" @click="confirmSshHostKeyReset">
              {{ sshHostKeySaving ? '处理中...' : '已确认，更新并重连' }}
            </button>
          </div>
        </section>
      </div>
    </teleport>

    <teleport to="body">
      <div v-if="quickCommandSettingsOpen" class="modal-backdrop quick-command-backdrop" :class="props.appTheme === 'light' ? 'theme-light' : 'theme-dark'" role="presentation">
        <section class="modal quick-command-modal" role="dialog" aria-modal="true" aria-label="固定命令设置">
          <div class="modal-head">
            <div>
              <strong>固定命令</strong>
              <span>{{ quickCommandEnabledCount }} 个将启用</span>
            </div>
            <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="closeQuickCommandSettings"><UiIcon name="close" /></button>
          </div>

          <div class="quick-command-workbench">
            <div class="quick-command-summary" :class="{ warning: quickCommandHasBlockingIssues }">
              <span>逐条编辑，Enter 新增下一条</span>
              <span>{{ quickCommandHasBlockingIssues ? '存在需处理项' : '保存前会自动合并重复命令' }}</span>
            </div>

            <div class="quick-command-list" role="list">
              <div
                v-for="(command, index) in quickCommandItems"
                :key="index"
                class="quick-command-row"
                :class="{ invalid: quickCommandStatus(command, index).blocking }"
                role="listitem"
              >
                <span class="quick-command-index">{{ index + 1 }}</span>
                <input
                  v-model="quickCommandItems[index]"
                  spellcheck="false"
                  placeholder="输入命令，例如 df -h"
                  aria-label="固定命令"
                  @keydown.enter.prevent="addQuickCommandItem(index)"
                />
                <span
                  class="command-risk-status"
                  :class="`risk-${quickCommandStatus(command, index).level}`"
                  :title="quickCommandStatus(command, index).message"
                >
                  {{ quickCommandStatus(command, index).label }}
                </span>
                <div class="quick-command-row-actions">
                  <button class="icon-button" type="button" title="上移" aria-label="上移" :disabled="index === 0" @click="moveQuickCommandItem(index, -1)"><UiIcon name="arrow-up" /></button>
                  <button class="icon-button" type="button" title="下移" aria-label="下移" :disabled="index === quickCommandItems.length - 1" @click="moveQuickCommandItem(index, 1)"><UiIcon name="arrow-down" /></button>
                  <button class="icon-button danger" type="button" title="删除" aria-label="删除" @click="removeQuickCommandItem(index)"><UiIcon name="trash" /></button>
                </div>
                <small v-if="shouldShowQuickCommandMessage(command, index)">{{ quickCommandStatus(command, index).message }}</small>
              </div>
            </div>

            <button class="text-button quick-command-add-row" type="button" :disabled="quickCommandItems.length >= QUICK_COMMAND_LIMIT" @click="addQuickCommandItem()">
              <UiIcon name="plus" size="13" />
              <span>新增命令</span>
            </button>

            <div v-if="quickCommandRecommendations.length" class="quick-command-recommendations">
              <div class="quick-command-recommendation-head">
                <strong>推荐候选</strong>
                <span>{{ quickCommandRecommendations.length }} 条</span>
              </div>
              <div class="quick-command-recommendation-list">
                <button
                  v-for="command in quickCommandRecommendations"
                  :key="command"
                  class="quick-command-recommendation"
                  type="button"
                  @click="addQuickCommandRecommendation(command)"
                >
                  <code>{{ command }}</code>
                  <UiIcon name="plus" size="13" />
                </button>
              </div>
              <div class="quick-command-recommendation-actions">
                <button class="text-button" type="button" @click="appendQuickCommandRecommendations">全部追加</button>
                <button class="text-button" type="button" @click="replaceQuickCommandsWithRecommendations">替换为推荐</button>
              </div>
            </div>

            <div v-if="quickCommandResetConfirm" class="quick-command-reset-confirm">
              <span>确认恢复默认固定命令？当前草稿会被替换。</span>
              <button class="text-button" type="button" @click="cancelResetQuickCommandDraft">取消</button>
              <button class="text-button danger" type="button" @click="confirmResetQuickCommandDraft">确认恢复</button>
            </div>
          </div>

          <p v-if="quickCommandError" class="save-feedback error">{{ quickCommandError }}</p>
          <p v-else-if="quickCommandNotice" class="save-feedback ok">{{ quickCommandNotice }}</p>
          <div class="modal-actions quick-command-actions">
            <button class="text-button" type="button" @click="resetQuickCommandDraft">恢复默认</button>
            <button class="text-button" type="button" @click="recommendQuickCommandsFromHistory">根据历史推荐</button>
            <button class="text-button" type="button" @click="closeQuickCommandSettings">取消</button>
            <button class="text-button primary-action" type="button" :disabled="!quickCommandCanSave" @click="saveQuickCommandSettings">保存</button>
          </div>
        </section>
      </div>
    </teleport>
  </main>
</template>
