<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import type { IDisposable } from '@xterm/xterm'
import { readText as readClipboardText, writeText as writeClipboardText } from '@tauri-apps/api/clipboard'
import '@xterm/xterm/css/xterm.css'
import {
  chatWithAiProvider,
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
import type { AiProviderConfig, AuthEndpoint, ConnectionProfile } from '../types/profile'
import type { CommandHistoryEntry, CommandRecordedEvent, TerminalInputEvent, TerminalOutputEvent, TerminalSelectionEvent } from '../types/workspace'
import { scriptRiskStatusForContent } from '../lib/scriptRisk'
import UiIcon from './UiIcon.vue'

type TerminalRuntimeStatus = 'idle' | 'connecting' | 'local' | 'remote' | 'sftp' | 'preview' | 'error'
type TerminalSessionKind = 'local' | 'remote' | 'sftp' | 'preview'
type CompletionSuggestionSource = 'system' | 'history' | 'session'
type TerminalTheme = 'midnight' | 'matrix' | 'light'
type TerminalSelectionViewportCell = { x: number; y: number }
type TerminalInputTrackResult = 'idle' | 'changed' | 'submitted'

interface TerminalVisualSettings {
  terminalFontFamily: string
  terminalFontSize: number
  terminalTheme: TerminalTheme
}

interface SshHostKeyTarget {
  host: string
  port: number
  label: string
}
interface CompletionSuggestion {
  command: string
  source: CompletionSuggestionSource
}

const props = defineProps<{
  terminalId: string
  profile?: ConnectionProfile
  connectRequest: number
  commandHistory: CommandHistoryEntry[]
  terminalSettings?: TerminalVisualSettings
  appTheme?: 'dark' | 'light'
  aiConfig?: AiProviderConfig
  apiKey?: string
}>()

const emit = defineEmits<{
  terminalOutput: [event: TerminalOutputEvent]
  terminalSelection: [event: TerminalSelectionEvent]
  terminalInput: [event: TerminalInputEvent]
  commandRecorded: [event: CommandRecordedEvent]
  statusChanged: [terminalId: string, status: TerminalRuntimeStatus]
  profileUpdated: [profileId: string]
}>()

const terminalHost = ref<HTMLDivElement | null>(null)
const terminalBodyWrap = ref<HTMLDivElement | null>(null)
const quickCommandSettingsButton = ref<HTMLButtonElement | null>(null)
let terminal: Terminal | undefined
let sessionId = ''
let connectionAttempt = 0
let unlisten: (() => void) | undefined
let unlistenClosed: (() => void) | undefined
let resizeObserver: ResizeObserver | undefined
let dataDisposable: IDisposable | undefined
let selectionDisposable: IDisposable | undefined
let terminalSelectionPolishFrame = 0
let terminalSelectionDragging = false
let terminalSelectionDragStart: TerminalSelectionViewportCell | undefined
let terminalSelectionDragCurrent: TerminalSelectionViewportCell | undefined
let terminalOutputBuffer = ''
let inputCommandBuffer = ''
let completionDebounceTimer: number | undefined
let pendingInputControlSequence = ''
let lastRightClickPasteAt = 0
const status = ref<TerminalRuntimeStatus>('idle')
const terminalSize = ref({ cols: 80, rows: 24 })
const activeSession = ref<TerminalSessionKind>('local')
const activeSessionProfile = ref<ConnectionProfile | undefined>(undefined)
const terminalCompletionOpen = ref(false)
const completionSuggestions = ref<CompletionSuggestion[]>([])
const completionActiveIndex = ref(0)
const completionKeyboardMode = ref(false)
const completionSummary = computed(() => {
  const historyCount = completionSuggestions.value.filter((suggestion) => suggestion.source === 'history').length
  const sessionCount = completionSuggestions.value.filter((suggestion) => suggestion.source === 'session').length
  const systemCount = completionSuggestions.value.filter((suggestion) => suggestion.source === 'system').length
  const parts = [
    historyCount ? `历史 ${historyCount}` : '',
    sessionCount ? `本次 ${sessionCount}` : '',
    systemCount ? `系统 ${systemCount}` : ''
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : '没有匹配的命令'
})
const localCommandHistory = ref<string[]>([])
const COMPLETION_DEBOUNCE_MS = 200
const COMPLETION_LIMIT = 12
const COMPLETION_VISIBLE_ROWS = 3
const DEFAULT_QUICK_COMMANDS = ['ping', 'top', 'htop', 'df -h', 'free -m', 'ls -la']
const QUICK_COMMAND_STORAGE_KEY = 'ai-term:quick-commands:v1'
const QUICK_COMMAND_LIMIT = 12
const quickCommands = ref<string[]>(loadQuickCommands())
const quickCommandSettingsOpen = ref(false)
const quickCommandItems = ref<string[]>([...quickCommands.value])
const quickCommandRecommendations = ref<string[]>([])
const quickCommandResetConfirm = ref(false)
const quickCommandNotice = ref('')
const quickCommandError = ref('')
const quickCommandAiLoading = ref(false)
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
  const platform = `${navigator.platform} ${navigator.userAgent}`.toLowerCase()
  if (platform.includes('win')) {
    return ['dir', 'cd', 'cls', 'type', 'copy', 'move', 'del', 'findstr', 'where', 'tasklist', 'taskkill', 'ipconfig', 'netstat -ano', 'powershell', 'wmic cpu get loadpercentage', 'Get-Process', 'Get-Service', 'Get-ChildItem', ...common]
  }
  if (platform.includes('mac')) {
    return ['brew update', 'brew upgrade', 'open .', 'pbcopy', 'pbpaste', 'sw_vers', 'system_profiler', ...common]
  }
  return ['apt update', 'apt list --upgradable', 'systemctl status', 'journalctl -xe', 'ss -tulpn', 'ip addr', ...common]
}

function historyCommandSuggestions() {
  return [...props.commandHistory.map((entry) => entry.command), ...localCommandHistory.value]
}

function loadQuickCommands() {
  try {
    const raw = window.localStorage.getItem(QUICK_COMMAND_STORAGE_KEY)
    if (!raw) return [...DEFAULT_QUICK_COMMANDS]
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return normalizeQuickCommandList(parsed)
  } catch (error) {
    console.warn('failed to load quick commands', error)
  }
  return [...DEFAULT_QUICK_COMMANDS]
}

function persistQuickCommands(commands: string[]) {
  window.localStorage.setItem(QUICK_COMMAND_STORAGE_KEY, JSON.stringify(commands))
}

function normalizeQuickCommandList(commands: string[]) {
  const seen = new Set<string>()
  const result: string[] = []
  commands.forEach((command) => {
    const value = command.replace(/\s+/g, ' ').trim()
    const key = value.toLowerCase()
    if (!value || seen.has(key) || value.length > 140) return
    seen.add(key)
    result.push(value)
  })
  return result.slice(0, QUICK_COMMAND_LIMIT)
}

const normalizedQuickCommandItems = computed(() => normalizeQuickCommandList(
  quickCommandItems.value.filter((command) => {
    const value = command.trim()
    return value && value.length <= 140 && !isHighRiskQuickCommand(value)
  })
))
const quickCommandEnabledCount = computed(() => normalizedQuickCommandItems.value.length)
const quickCommandHasBlockingIssues = computed(() =>
  quickCommandItems.value.some((command) => {
    const value = command.trim()
    return Boolean(value && (value.length > 140 || isHighRiskQuickCommand(value)))
  })
)
const quickCommandCanSave = computed(() => quickCommandEnabledCount.value > 0 && !quickCommandHasBlockingIssues.value)

function syncQuickCommandItems(commands: string[]) {
  quickCommandItems.value = commands.length > 0 ? [...commands] : ['']
}

function quickCommandDuplicate(command: string, index: number) {
  const value = command.trim().toLowerCase()
  if (!value) return false
  return quickCommandItems.value.some((item, itemIndex) => itemIndex !== index && item.trim().toLowerCase() === value)
}

function quickCommandStatus(command: string, index: number) {
  const value = command.trim()
  if (!value) {
    return { label: '未启用', level: 'muted', message: '空行不会保存。', blocking: false }
  }
  if (value.length > 140) {
    return { label: '过长', level: 'high', message: '超过 140 个字符，请缩短后保存。', blocking: true }
  }
  if (isHighRiskQuickCommand(value)) {
    return { label: '高风险', level: 'high', message: '高风险命令不能保存为快速命令。', blocking: true }
  }
  if (quickCommandDuplicate(command, index)) {
    return { label: '重复', level: 'medium', message: '重复命令会在保存时自动合并。', blocking: false }
  }
  const risk = scriptRiskStatusForContent(value)
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
    quickCommandNotice.value = `最多保留 ${QUICK_COMMAND_LIMIT} 条快速命令。`
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
  quickCommandAiLoading.value = false
  quickCommandRecommendations.value = []
  quickCommandResetConfirm.value = false
}

function saveQuickCommandSettings() {
  if (!quickCommandCanSave.value) {
    quickCommandError.value = quickCommandEnabledCount.value === 0 ? '至少保留 1 条快速命令。' : '请先处理高风险或过长命令。'
    return
  }
  const nextCommands = normalizedQuickCommandItems.value
  quickCommands.value = nextCommands
  syncQuickCommandItems(nextCommands)
  persistQuickCommands(nextCommands)
  quickCommandRecommendations.value = []
  quickCommandResetConfirm.value = false
  quickCommandError.value = ''
  quickCommandNotice.value = '快速命令已保存。'
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
  const seen = new Set<string>()
  return historyCommandSuggestions()
    .map((command) => command.trim())
    .filter((command) => {
      const key = command.toLowerCase()
      if (!command || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(-80)
}

function buildQuickCommandPrompt(history: string[]) {
  return [
    '你是 AI Term 的终端效率助手。',
    '请根据用户历史命令推荐 8 个适合放在快速命令栏的常用命令。',
    '只返回命令本身，每行一个，不要编号、不要解释、不要 Markdown。',
    '不要推荐删除、格式化、重启、关机、覆盖写入等高风险命令。',
    '',
    '历史命令：',
    history.join('\n') || '暂无历史命令'
  ].join('\n')
}

function parseQuickCommandRecommendations(answer: string) {
  return normalizeQuickCommandList(
    answer
      .replace(/```[a-zA-Z0-9_-]*\n?/g, '')
      .replace(/```/g, '')
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)、])\s*/, '').replace(/^`|`$/g, '').trim())
      .filter((command) => command && !isHighRiskQuickCommand(command))
  )
}

function isHighRiskQuickCommand(command: string) {
  return /\b(rm\s+-rf|mkfs|shutdown|reboot|halt|poweroff|format\s+|del\s+\/|remove-item\b|dd\s+if=|chmod\s+-R\s+777)\b/i.test(command) || command.includes(':(){')
}

function localQuickCommandRecommendations() {
  const counts = new Map<string, number>()
  quickCommandHistorySeed().forEach((command) => {
    if (isHighRiskQuickCommand(command)) return
    counts.set(command, (counts.get(command) ?? 0) + 1)
  })
  return normalizeQuickCommandList(
    [...counts.entries()]
      .sort((first, second) => second[1] - first[1])
      .map(([command]) => command)
      .concat(DEFAULT_QUICK_COMMANDS)
  )
}

async function recommendQuickCommandsWithAi() {
  if (quickCommandAiLoading.value) return
  quickCommandAiLoading.value = true
  quickCommandError.value = ''
  quickCommandNotice.value = ''
  quickCommandResetConfirm.value = false
  const history = quickCommandHistorySeed()
  const config = props.aiConfig
  const apiKey = config?.apiKey?.trim() || props.apiKey?.trim() || ''

  try {
    if (config?.baseUrl.trim() && config.model.trim() && apiKey) {
      const response = await chatWithAiProvider({
        config,
        apiKey,
        question: buildQuickCommandPrompt(history),
        terminalSnapshot: terminalOutputBuffer.slice(-12_000),
        commandHistory: history
      })
      const recommended = parseQuickCommandRecommendations(response.answer)
      if (recommended.length > 0) {
        quickCommandRecommendations.value = recommended
        quickCommandNotice.value = '已生成推荐候选，可选择追加或替换。'
        return
      }
    }
    const local = localQuickCommandRecommendations()
    quickCommandRecommendations.value = local
    quickCommandNotice.value = config ? 'AI 未返回可用候选，已使用历史命令推荐。' : '未配置 AI，已使用历史命令推荐。'
  } catch (error) {
    const local = localQuickCommandRecommendations()
    quickCommandRecommendations.value = local
    quickCommandError.value = `AI 推荐失败：${formatError(error)}。已生成本地候选。`
  } finally {
    quickCommandAiLoading.value = false
  }
}
function buildCompletionSuggestions(prefix = inputCommandBuffer.trimStart()) {
  const normalizedPrefix = prefix.toLowerCase()
  const historyStats = new Map<string, { command: string; count: number; source: CompletionSuggestionSource; lastIndex: number }>()
  const matchesPrefix = (command: string) => !normalizedPrefix || command.toLowerCase().startsWith(normalizedPrefix)
  const addHistory = (command: string, source: CompletionSuggestionSource, index: number) => {
    const value = command.trim()
    if (!value) return
    if (!matchesPrefix(value)) return
    const key = value.toLowerCase()
    const current = historyStats.get(key)
    if (current) {
      current.count += 1
      current.lastIndex = Math.max(current.lastIndex, index)
      if (source === 'session') current.source = source
      return
    }
    historyStats.set(key, { command: value, count: 1, source, lastIndex: index })
  }

  const historyCommands = props.commandHistory.map((entry) => entry.command)
  historyCommands.forEach((command, index) => addHistory(command, 'history', index))
  localCommandHistory.value.forEach((command, index) => addHistory(command, 'session', historyCommands.length + index))

  const historySuggestions = [...historyStats.values()]
    .sort((a, b) => b.count - a.count || b.lastIndex - a.lastIndex || a.command.localeCompare(b.command))
    .map(({ command, source }) => ({ command, source }))

  const seen = new Set(historySuggestions.map((suggestion) => suggestion.command.toLowerCase()))
  const systemSuggestions = systemCommandSuggestions()
    .map((command) => command.trim())
    .filter((command) => command && matchesPrefix(command) && !seen.has(command.toLowerCase()))
    .map((command) => ({ command, source: 'system' as CompletionSuggestionSource }))

  return [...historySuggestions, ...systemSuggestions].slice(0, COMPLETION_LIMIT)
}

function refreshCompletionSuggestions(options: { force?: boolean; keyboard?: boolean } = {}) {
  const force = options.force ?? false
  const keyboard = options.keyboard ?? false
  completionSuggestions.value = buildCompletionSuggestions()
  completionActiveIndex.value = Math.min(completionActiveIndex.value, Math.max(0, completionSuggestions.value.length - 1))
  completionKeyboardMode.value = keyboard
  terminalCompletionOpen.value = force || completionSuggestions.value.length > 0
}

function clearCompletionTimer() {
  if (completionDebounceTimer === undefined) return
  window.clearTimeout(completionDebounceTimer)
  completionDebounceTimer = undefined
}

function scheduleCompletionSuggestions() {
  clearCompletionTimer()
  completionKeyboardMode.value = false
  completionDebounceTimer = window.setTimeout(() => {
    completionDebounceTimer = undefined
    if (!inputCommandBuffer.trim()) {
      closeCompletion()
      return
    }
    refreshCompletionSuggestions({ force: false, keyboard: false })
  }, COMPLETION_DEBOUNCE_MS)
}

function updateCompletionAfterInput(result: TerminalInputTrackResult) {
  if (result === 'submitted') {
    closeCompletion()
    return
  }
  if (result === 'changed') {
    scheduleCompletionSuggestions()
  }
}

function closeCompletion() {
  clearCompletionTimer()
  terminalCompletionOpen.value = false
  completionSuggestions.value = []
  completionActiveIndex.value = 0
  completionKeyboardMode.value = false
}

function scrollActiveCompletionIntoView() {
  void nextTick(() => {
    const active = terminalBodyWrap.value?.querySelector<HTMLButtonElement>('.terminal-completion button.active')
    active?.scrollIntoView({ block: 'nearest' })
  })
}

function cycleCompletion(delta: number) {
  if (!completionSuggestions.value.length) return
  completionKeyboardMode.value = true
  completionActiveIndex.value = (completionActiveIndex.value + delta + completionSuggestions.value.length) % completionSuggestions.value.length
  scrollActiveCompletionIntoView()
}

function completionSourceLabel(source: CompletionSuggestionSource) {
  if (source === 'system') return '系统'
  if (source === 'history') return '历史'
  return '本次'
}

function handleDocumentPointerDown(event: PointerEvent) {
  if (!terminalCompletionOpen.value) return
  const target = event.target instanceof Node ? event.target : null
  if (target && terminalBodyWrap.value?.contains(target)) return
  closeCompletion()
}

function acceptCompletionSuggestion(suggestion = completionSuggestions.value[completionActiveIndex.value]) {
  if (!suggestion) return false
  const current = inputCommandBuffer.trimStart()
  if (!suggestion.command.toLowerCase().startsWith(current.toLowerCase())) return false
  const tail = suggestion.command.slice(current.length)
  if (tail) writeTerminalInput(tail)
  inputCommandBuffer = suggestion.command
  closeCompletion()
  return true
}

function handleTerminalCustomKeyEvent(event: KeyboardEvent) {
  if (event.type === 'keydown' && event.ctrlKey && !event.altKey && !event.metaKey && event.code === 'Space') {
    clearCompletionTimer()
    if (terminalCompletionOpen.value && completionKeyboardMode.value) {
      cycleCompletion(1)
    } else {
      refreshCompletionSuggestions({ force: true, keyboard: true })
    }
    return false
  }
  return true
}
function handleCompletionInput(data: string) {
  if (!terminalCompletionOpen.value) return false
  if (data === '\x1b[A') {
    cycleCompletion(-1)
    return true
  }
  if (data === '\x1b[B') {
    cycleCompletion(1)
    return true
  }
  if (!completionKeyboardMode.value) {
    if (data === '\x1b') {
      closeCompletion()
      return true
    }
    closeCompletion()
    return false
  }
  if (data === '\r' || data === '\n' || data === '\x1b[C') {
    return acceptCompletionSuggestion()
  }
  if (data === '\x1b') {
    closeCompletion()
    return true
  }
  closeCompletion()
  return false
}

function renderIdlePrompt(term: Terminal) {
  term.clear()
  term.writeln('No active shell.')
  term.writeln('Use New Local Shell to start a local terminal.')
  term.writeln('')
  scrollTerminalToBottom()
}

function isSftpProfile(profile?: ConnectionProfile) {
  return profile?.fileTransferMode === 'sftp-direct' || profile?.fileTransferMode === 'sftp-gateway'
}

function cssPixel(value: string) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function terminalContentBox(element: HTMLElement) {
  const style = window.getComputedStyle(element)
  const horizontalPadding = cssPixel(style.paddingLeft) + cssPixel(style.paddingRight)
  const verticalPadding = cssPixel(style.paddingTop) + cssPixel(style.paddingBottom)
  const scrollbarGutter = cssPixel(style.getPropertyValue('--terminal-scrollbar-gutter'))
  return {
    width: Math.max(0, element.clientWidth - horizontalPadding - scrollbarGutter),
    height: Math.max(0, element.clientHeight - verticalPadding)
  }
}

function measureTerminalCell(element: HTMLElement) {
  const settings = resolvedTerminalSettings()
  const probe = document.createElement('span')
  probe.textContent = 'mmmmmmmmmm'
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  probe.style.pointerEvents = 'none'
  probe.style.whiteSpace = 'pre'
  probe.style.fontFamily = settings.terminalFontFamily
  probe.style.fontSize = `${settings.terminalFontSize}px`
  probe.style.lineHeight = 'normal'
  element.appendChild(probe)
  const rect = probe.getBoundingClientRect()
  probe.remove()
  return {
    width: Math.max(6, rect.width / 10 || settings.terminalFontSize * 0.62),
    height: Math.max(12, rect.height || settings.terminalFontSize * 1.18)
  }
}

function estimateTerminalSize(element: HTMLElement) {
  const box = terminalContentBox(element)
  const cell = measureTerminalCell(element)
  return {
    cols: Math.max(40, Math.floor(box.width / cell.width)),
    rows: Math.max(12, Math.floor(box.height / cell.height))
  }
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
  })
}

function syncTerminalSize() {
  if (!terminal || !terminalHost.value) return
  const size = estimateTerminalSize(terminalHost.value)
  const changed = size.cols !== terminal.cols || size.rows !== terminal.rows
  terminalSize.value = size
  if (changed) terminal.resize(size.cols, size.rows)
  if (sessionId && changed) {
    void terminalResize(sessionId, size.cols, size.rows)
  }
  scrollTerminalToBottom()
}

function appendTerminalOutput(data: string) {
  terminalOutputBuffer = `${terminalOutputBuffer}${data}`.slice(-1_500_000)
  emit('terminalOutput', {
    terminalId: props.terminalId,
    snapshot: terminalOutputBuffer
  })
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

function terminalRowContentRight(row: HTMLElement) {
  const rowRect = row.getBoundingClientRect()
  const text = row.textContent ?? ''
  const contentLength = text.trimEnd().length
  if (!contentLength) return rowRect.left

  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
  let remaining = contentLength
  let right = rowRect.left
  let node = walker.nextNode() as Text | null

  while (node && remaining > 0) {
    const take = Math.min(node.data.length, remaining)
    if (take > 0) {
      const range = document.createRange()
      range.setStart(node, 0)
      range.setEnd(node, take)
      const rect = range.getBoundingClientRect()
      right = Math.max(right, rect.right)
      range.detach()
      remaining -= take
    }
    node = walker.nextNode() as Text | null
  }

  if (right > rowRect.left) return right
  return rowRect.left + contentLength * measureTerminalCell(row).width
}

function terminalSelectionOverlay() {
  const host = terminalHost.value
  const screen = host?.querySelector<HTMLElement>('.xterm-screen')
  if (!host || !screen) return undefined
  let overlay = screen.querySelector<HTMLElement>('.ai-term-selection-overlay')
  if (!overlay) {
    overlay = document.createElement('div')
    overlay.className = 'ai-term-selection-overlay'
    screen.appendChild(overlay)
  }
  return { host, screen, overlay }
}

function clearTerminalSelectionOverlay() {
  const host = terminalHost.value
  host?.classList.remove('ai-term-selection-polished')
  host?.querySelector<HTMLElement>('.ai-term-selection-overlay')?.replaceChildren()
}

function terminalSelectionCellToViewport(cell: { x: number; y: number }) {
  const viewportY = terminal?.buffer.active.viewportY ?? 0
  return {
    x: Math.max(0, cell.x),
    y: Math.max(0, cell.y - viewportY)
  }
}

function terminalPointerViewportCell(event: PointerEvent): TerminalSelectionViewportCell | undefined {
  const host = terminalHost.value
  const firstRow = host?.querySelector<HTMLElement>('.xterm-rows > div')
  if (!host || !firstRow) return undefined

  const cell = measureTerminalCell(host)
  const firstRowRect = firstRow.getBoundingClientRect()
  const rowHeight = Math.max(1, firstRowRect.height || cell.height)
  const rowCount = Math.max(1, terminal?.rows ?? host.querySelectorAll('.xterm-rows > div').length)
  return {
    x: Math.max(0, Math.floor((event.clientX - firstRowRect.left) / cell.width)),
    y: Math.max(0, Math.min(rowCount - 1, Math.floor((event.clientY - firstRowRect.top) / rowHeight)))
  }
}

function polishTerminalSelection() {
  const overlayTarget = terminalSelectionOverlay()
  const selectionPosition = terminal?.getSelectionPosition()
  if (!overlayTarget || !selectionPosition) {
    clearTerminalSelectionOverlay()
    return
  }

  const { host, screen, overlay } = overlayTarget
  const rows = Array.from(host.querySelectorAll<HTMLElement>('.xterm-rows > div'))
  overlay.replaceChildren()
  host.classList.add('ai-term-selection-polished')
  if (!rows.length) return

  const rawStart = terminalSelectionCellToViewport(selectionPosition.start)
  const rawEnd = terminalSelectionCellToViewport(selectionPosition.end)
  const isReverseSelection = rawStart.y > rawEnd.y || (rawStart.y === rawEnd.y && rawStart.x > rawEnd.x)
  const start = { ...rawStart }
  const end = { ...rawEnd }
  if (isReverseSelection) {
    const previousStart = { ...start }
    start.x = end.x
    start.y = end.y
    end.x = previousStart.x
    end.y = previousStart.y
  }
  const isPointerReverseSelection = Boolean(
    terminalSelectionDragStart &&
      terminalSelectionDragCurrent &&
      (terminalSelectionDragCurrent.y < terminalSelectionDragStart.y ||
        (terminalSelectionDragCurrent.y === terminalSelectionDragStart.y && terminalSelectionDragCurrent.x < terminalSelectionDragStart.x))
  )
  const isReverseMultiLineSelection = (isReverseSelection || isPointerReverseSelection) && start.y !== end.y

  const cellWidth = measureTerminalCell(host).width
  const screenRect = screen.getBoundingClientRect()
  const startY = Math.max(0, Math.min(rows.length - 1, start.y))
  const endY = Math.max(0, Math.min(rows.length - 1, end.y))

  for (let rowIndex = startY; rowIndex <= endY; rowIndex += 1) {
    const row = rows[rowIndex]
    const textLength = (row.textContent ?? '').trimEnd().length
    if (!textLength) continue

    const rowRect = row.getBoundingClientRect()
    const contentRight = terminalRowContentRight(row)
    let left = rowRect.left
    let right = contentRight

    if (rowIndex === start.y) {
      left = rowRect.left + (isReverseMultiLineSelection ? 0 : start.x) * cellWidth
    }
    if (rowIndex === end.y) right = Math.min(right, rowRect.left + end.x * cellWidth)

    left = Math.max(rowRect.left, Math.min(left, contentRight))
    right = Math.max(rowRect.left, Math.min(right, contentRight))
    const width = Math.ceil(right - left)
    if (width <= 0) continue

    const line = document.createElement('div')
    line.className = 'ai-term-selection-line'
    line.style.left = `${Math.floor(left - screenRect.left)}px`
    line.style.top = `${Math.floor(rowRect.top - screenRect.top)}px`
    line.style.width = `${width}px`
    line.style.height = `${Math.ceil(rowRect.height)}px`
    overlay.appendChild(line)
  }
}

function scheduleTerminalSelectionPolish() {
  if (terminalSelectionPolishFrame) {
    window.cancelAnimationFrame(terminalSelectionPolishFrame)
  }
  terminalSelectionPolishFrame = window.requestAnimationFrame(() => {
    terminalSelectionPolishFrame = 0
    polishTerminalSelection()
  })
}
function handleTerminalSelectionPointerMove(event: PointerEvent) {
  if (!terminalSelectionDragging || (event.buttons & 1) === 0) return
  terminalSelectionDragCurrent = terminalPointerViewportCell(event) ?? terminalSelectionDragCurrent
  scheduleTerminalSelectionPolish()
}

function stopTerminalSelectionDrag() {
  if (!terminalSelectionDragging) return
  terminalSelectionDragging = false
  window.removeEventListener('pointermove', handleTerminalSelectionPointerMove, true)
  window.removeEventListener('pointerup', stopTerminalSelectionDrag, true)
  window.removeEventListener('pointercancel', stopTerminalSelectionDrag, true)
  scheduleTerminalSelectionPolish()
}

function startTerminalSelectionDrag(event: PointerEvent) {
  terminalSelectionDragging = true
  terminalSelectionDragStart = terminalPointerViewportCell(event)
  terminalSelectionDragCurrent = terminalSelectionDragStart
  scheduleTerminalSelectionPolish()
  window.addEventListener('pointermove', handleTerminalSelectionPointerMove, true)
  window.addEventListener('pointerup', stopTerminalSelectionDrag, true)
  window.addEventListener('pointercancel', stopTerminalSelectionDrag, true)
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

function recordCommand(command: string) {
  const value = command.trim()
  if (!value) return
  localCommandHistory.value = [...localCommandHistory.value.filter((item) => item !== value), value].slice(-120)
  emit('commandRecorded', {
    terminalId: props.terminalId,
    command: value
  })
}

function trackUserInput(data: string): TerminalInputTrackResult {
  const commandInput = stripCommandInputControlSequences(data)
  let result: TerminalInputTrackResult = 'idle'
  for (const character of commandInput) {
    const code = character.charCodeAt(0)
    if (code === 13 || code === 10) {
      recordCommand(inputCommandBuffer)
      inputCommandBuffer = ''
      result = 'submitted'
    } else if (code === 127) {
      inputCommandBuffer = inputCommandBuffer.slice(0, -1)
      result = inputCommandBuffer.trim() ? 'changed' : 'submitted'
    } else if (character >= ' ') {
      inputCommandBuffer += character
      result = 'changed'
    }
  }
  return result
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
  terminal.options.theme = terminalThemeOptions(settings.terminalTheme)
  terminal.refresh(0, terminal.rows - 1)
  syncTerminalSize()
}

onMounted(async () => {
  if (!terminalHost.value) return

  terminal = new Terminal({
    cursorBlink: true,
    convertEol: false,
    fontFamily: resolvedTerminalSettings().terminalFontFamily,
    fontSize: resolvedTerminalSettings().terminalFontSize,
    theme: terminalThemeOptions(resolvedTerminalSettings().terminalTheme)
  })
  terminal.open(terminalHost.value)
  terminal.attachCustomKeyEventHandler(handleTerminalCustomKeyEvent)
  syncTerminalSize()
  terminal.focus()
  renderIdlePrompt(terminal)

  dataDisposable = terminal.onData((data) => {
    if (handleCompletionInput(data)) return
    if (sessionId) {
      const inputResult = trackUserInput(data)
      updateCompletionAfterInput(inputResult)
      emit('terminalInput', { terminalId: props.terminalId, data })
      void terminalWrite(sessionId, data)
    }
  })
  selectionDisposable = terminal.onSelectionChange(() => {
    scheduleTerminalSelectionPolish()
    void copySelectionToClipboard()
  })
  terminalHost.value.addEventListener('pointerdown', handleTerminalPointerDown, true)
  terminalHost.value.addEventListener('contextmenu', handleTerminalContextMenu, true)
  document.addEventListener('pointerdown', handleDocumentPointerDown, true)
  quickCommandSettingsButton.value?.addEventListener('pointerdown', handleQuickCommandSettingsPointerDown, true)

  resizeObserver = new ResizeObserver(() => {
    syncTerminalSize()
  })
  resizeObserver.observe(terminalHost.value)

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
  () => applyTerminalAppearance(),
  { deep: true }
)

watch(
  () => props.appTheme,
  () => applyTerminalAppearance()
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
  sessionId = ''
  status.value = 'idle'
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

async function attachTerminalEvents() {
  unlisten?.()
  unlistenClosed?.()
  if (!sessionId) return
  unlisten = await onTerminalData(sessionId, (event) => {
    if (event.sessionId === sessionId) {
      writeTerminalView(event.data)
      appendTerminalOutput(event.data)
    }
  })
  unlistenClosed = await onTerminalClosed(sessionId, (event) => {
    if (event.sessionId !== sessionId) return
    handleTerminalSessionClosed(event.reason)
  })
}

async function connectRemote() {
  if (!terminal || !terminalHost.value || !props.profile) return
  try {
    disconnect(false)
    activeSession.value = 'remote'
    activeSessionProfile.value = props.profile
    status.value = 'connecting'
    terminal.clear()
    const size = estimateTerminalSize(terminalHost.value)
    terminal.writeln(`Connecting SSH profile: ${activeSessionProfile.value.name}`)
    scrollTerminalToBottom()
    terminalOutputBuffer = `Connecting SSH profile: ${activeSessionProfile.value.name}\n`
    emit('terminalOutput', {
      terminalId: props.terminalId,
      snapshot: terminalOutputBuffer
    })
    sessionId = await connectProfile(props.profile.id, size.cols, size.rows)
    await attachTerminalEvents()
    if (await verifyTerminalSessionStillActive(sessionId)) {
      status.value = 'remote'
    }
    syncTerminalSize()
    await nextTick()
    terminal.focus()
  } catch (error) {
    status.value = 'error'
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
  try {
    disconnect(false, false)
    status.value = 'connecting'
    activeSession.value = 'local'
    activeSessionProfile.value = undefined
    terminal.clear()
    terminal.writeln('Opening local shell...')
    scrollTerminalToBottom()
    terminalOutputBuffer = 'Opening local shell...\n'
    emit('terminalOutput', {
      terminalId: props.terminalId,
      snapshot: terminalOutputBuffer
    })
    const size = estimateTerminalSize(terminalHost.value)
    sessionId = requestedSessionId
    await attachTerminalEvents()
    const connectedSessionId = await connectLocalTerminal(size.cols, size.rows, requestedSessionId)
    if (!isCurrentConnectionAttempt(attempt)) {
      void disconnectTerminal(connectedSessionId)
      return
    }
    if (connectedSessionId !== sessionId) {
      sessionId = connectedSessionId
      await attachTerminalEvents()
    }
    if (await verifyTerminalSessionStillActive(sessionId)) {
      status.value = 'local'
    }
    syncTerminalSize()
    await nextTick()
    terminal.focus()
  } catch (error) {
    if (!isCurrentConnectionAttempt(attempt)) return
    unlisten?.()
    unlistenClosed?.()
    unlisten = undefined
    unlistenClosed = undefined
    if (sessionId === requestedSessionId) sessionId = ''
    if (isTauriUnavailableError(error)) {
      enterPreviewMode()
    } else {
      enterLocalShellErrorMode(error)
    }
  }
}

function enterLocalShellErrorMode(error: unknown) {
  status.value = 'error'
  activeSession.value = 'local'
  activeSessionProfile.value = undefined
  sessionId = ''
  const detail = formatError(error)
  const message = `Local shell failed to start: ${detail}`
  terminal?.clear()
  terminal?.writeln('\x1b[31mLocal shell failed to start.\x1b[0m')
  terminal?.writeln(detail)
  terminal?.writeln('')
  terminal?.writeln('Use New Local Shell to retry.')
  scrollTerminalToBottom()
  appendTerminalOutput(`${message}\nUse New Local Shell to retry.\n`)
}

function enterPreviewMode() {
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
}

function enterSftpProfileMode() {
  if (!terminal || !props.profile) return
  disconnect(false)
  status.value = 'sftp'
  activeSession.value = 'sftp'
  activeSessionProfile.value = props.profile
  sessionId = ''
  terminal.clear()
  terminal.writeln('\x1b[36mSFTP profile is ready.\x1b[0m')
  terminal.writeln(`Profile: ${props.profile.name}`)
  terminal.writeln(`Target: ${props.profile.target.username || 'user'}@${props.profile.target.host || 'server'}`)
  terminal.writeln(`Mode: ${props.profile.fileTransferMode === 'sftp-gateway' ? 'SFTP 经网关' : 'SFTP 直连'}`)
  terminal.writeln('')
  terminal.writeln('Use the SFTP workspace on the right to browse, upload, and download files.')
  scrollTerminalToBottom()
  terminalOutputBuffer = [
    'SFTP profile is ready.',
    `Profile: ${props.profile.name}`,
    `Target: ${props.profile.target.username || 'user'}@${props.profile.target.host || 'server'}`,
    `Mode: ${props.profile.fileTransferMode === 'sftp-gateway' ? 'SFTP 经网关' : 'SFTP 直连'}`,
    'Use the SFTP workspace on the right to browse, upload, and download files.'
  ].join('\n')
  emit('terminalOutput', {
    terminalId: props.terminalId,
    snapshot: terminalOutputBuffer
  })
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

function runQuickCommand(command: string) {
  executeCommand(command)
}

function executeCommand(command: string) {
  const value = command.trim()
  if (!value) return false
  if (sessionId) {
    recordCommand(value)
    closeCompletion()
    void terminalWrite(sessionId, `${value}\r`)
    void nextTick(() => terminal?.focus())
    return true
  }
  if (status.value === 'preview') {
    const previewLine = `${value}\r\n`
    writeTerminalView(previewLine, true)
    appendTerminalOutput(previewLine)
    recordCommand(value)
    return true
  }
  return false
}

function writeTerminalInput(data: string) {
  if (!data) return false
  if (sessionId) {
    void terminalWrite(sessionId, data)
    void nextTick(() => terminal?.focus())
    return true
  }
  if (status.value === 'preview') {
    writeTerminalView(data, true)
    appendTerminalOutput(data)
    return true
  }
  return false
}

async function pasteClipboardToTerminal() {
  try {
    const text = await readClipboard()
    if (!text) return
    const inputResult = trackUserInput(text)
    updateCompletionAfterInput(inputResult)
    emit('terminalInput', { terminalId: props.terminalId, data: text })
    writeTerminalInput(text)
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
  if (event.button === 0) {
    startTerminalSelectionDrag(event)
    return
  }
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
  sessionId = ''
  activeSession.value = 'local'
  activeSessionProfile.value = undefined
  status.value = 'idle'
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
  clearCompletionTimer()
  quickCommandSettingsButton.value?.removeEventListener('pointerdown', handleQuickCommandSettingsPointerDown, true)
  stopTerminalSelectionDrag()
  if (terminalSelectionPolishFrame) window.cancelAnimationFrame(terminalSelectionPolishFrame)
  disconnect(false)
  resizeObserver?.disconnect()
  unlisten?.()
  unlistenClosed?.()
  dataDisposable?.dispose()
  selectionDisposable?.dispose()
  terminal?.dispose()
})

defineExpose({
  clearTerminal,
  disconnectFromButton,
  executeCommand,
  focusTerminal,
  restartLocalTerminal,
  writeTerminalInput
})
</script>

<template>
  <main class="terminal-pane">
    <section class="terminal-wrap">
      <div class="terminal-frame terminal-native-code">
        <div class="terminal-head">
          <div class="terminal-heading">
            <span class="terminal-title">{{ activeSessionProfile?.name ?? '本地终端' }}</span>
            <span class="terminal-subtitle">
              {{ activeSessionProfile ? `${activeSessionProfile.target.username || 'user'}@${activeSessionProfile.target.host || 'server'}` : 'localhost' }}
            </span>
          </div>
          <div class="terminal-tools">
            <button class="icon-button" type="button" title="复制终端输出" aria-label="复制终端输出" @click="copyTerminalOutput"><UiIcon name="copy" /></button>
            <button class="icon-button" type="button" title="清屏" aria-label="清屏" @click="clearTerminal"><UiIcon name="trash" /></button>
            <button class="icon-button" type="button" title="新建本地终端" aria-label="新建本地终端" @click="restartLocalTerminal"><UiIcon name="plus" /></button>
            <button class="icon-button" type="button" title="断开连接" aria-label="断开连接" @click="disconnectFromButton"><UiIcon name="close" /></button>
          </div>
        </div>
        <div ref="terminalBodyWrap" class="terminal-body-wrap">
          <div ref="terminalHost" class="xterm-host" aria-label="终端直接输入" />
          <div v-if="terminalCompletionOpen" class="terminal-completion" :class="{ 'keyboard-mode': completionKeyboardMode }" :style="{ '--completion-visible-rows': COMPLETION_VISIBLE_ROWS }" role="listbox" aria-label="命令推荐">
            <div class="terminal-completion-head">
              <div>
                <strong>命令推荐</strong>
                <span>{{ completionSummary }}</span>
              </div>
              <small>输入停顿 200ms 推荐 · <kbd>&uarr;</kbd><kbd>&darr;</kbd> 选择 · <kbd>Ctrl</kbd><kbd>Space</kbd></small>
            </div>
            <p v-if="!completionSuggestions.length" class="terminal-completion-empty">当前连接还没有匹配的历史命令，继续输入后再试。</p>
            <template v-else>
              <button
                v-for="(suggestion, index) in completionSuggestions"
                :key="`${suggestion.source}-${suggestion.command}`"
                type="button"
                :class="{ active: completionKeyboardMode && index === completionActiveIndex }"
                @pointerdown.prevent="acceptCompletionSuggestion(suggestion)"
              >
                <code>{{ suggestion.command }}</code>
                <span>{{ completionSourceLabel(suggestion.source) }}</span>
              </button>
            </template>
          </div>
        </div>
      </div>
    </section>
    <section class="quick-command-bar" aria-label="快速命令">
      <span>快速命令</span>
      <button v-for="command in quickCommands" :key="command" @click="runQuickCommand(command)">
        {{ command }}
      </button>
      <button ref="quickCommandSettingsButton" class="icon-button" type="button" title="快速命令设置" aria-label="快速命令设置" @click.stop="openQuickCommandSettings"><UiIcon name="settings" /></button>
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
        <section class="modal quick-command-modal" role="dialog" aria-modal="true" aria-label="快速命令设置">
          <div class="modal-head">
            <div>
              <strong>快速命令</strong>
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
                  aria-label="快速命令"
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
              <span>确认恢复默认快速命令？当前草稿会被替换。</span>
              <button class="text-button" type="button" @click="cancelResetQuickCommandDraft">取消</button>
              <button class="text-button danger" type="button" @click="confirmResetQuickCommandDraft">确认恢复</button>
            </div>
          </div>

          <p v-if="quickCommandError" class="save-feedback error">{{ quickCommandError }}</p>
          <p v-else-if="quickCommandNotice" class="save-feedback ok">{{ quickCommandNotice }}</p>
          <div class="modal-actions quick-command-actions">
            <button class="text-button" type="button" @click="resetQuickCommandDraft">恢复默认</button>
            <button class="text-button" type="button" :disabled="quickCommandAiLoading" @click="recommendQuickCommandsWithAi">
              {{ quickCommandAiLoading ? '推荐中...' : '根据历史推荐' }}
            </button>
            <button class="text-button" type="button" @click="closeQuickCommandSettings">取消</button>
            <button class="text-button primary-action" type="button" :disabled="!quickCommandCanSave" @click="saveQuickCommandSettings">保存</button>
          </div>
        </section>
      </div>
    </teleport>
  </main>
</template>
