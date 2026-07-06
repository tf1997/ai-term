<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
import UiIcon from './UiIcon.vue'

type TerminalRuntimeStatus = 'idle' | 'connecting' | 'local' | 'remote' | 'sftp' | 'preview' | 'error'
type TerminalSessionKind = 'local' | 'remote' | 'sftp' | 'preview'
type CompletionSuggestionSource = 'system' | 'history' | 'session'
type TerminalTheme = 'midnight' | 'matrix' | 'light'

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
let terminal: Terminal | undefined
let sessionId = ''
let connectionAttempt = 0
let unlisten: (() => void) | undefined
let unlistenClosed: (() => void) | undefined
let resizeObserver: ResizeObserver | undefined
let dataDisposable: IDisposable | undefined
let selectionDisposable: IDisposable | undefined
let terminalOutputBuffer = ''
let inputCommandBuffer = ''
let pendingInputControlSequence = ''
let lastRightClickPasteAt = 0
const status = ref<TerminalRuntimeStatus>('idle')
const terminalSize = ref({ cols: 80, rows: 24 })
const activeSession = ref<TerminalSessionKind>('local')
const activeSessionProfile = ref<ConnectionProfile | undefined>(undefined)
const terminalCompletionOpen = ref(false)
const completionSuggestions = ref<CompletionSuggestion[]>([])
const completionActiveIndex = ref(0)
const localCommandHistory = ref<string[]>([])
const DEFAULT_QUICK_COMMANDS = ['ping', 'top', 'htop', 'df -h', 'free -m', 'ls -la']
const QUICK_COMMAND_STORAGE_KEY = 'ai-term:quick-commands:v1'
const QUICK_COMMAND_LIMIT = 12
const quickCommands = ref<string[]>(loadQuickCommands())
const quickCommandSettingsOpen = ref(false)
const quickCommandDraft = ref(quickCommands.value.join('\n'))
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

function sshAuthTargetLabel(profile?: ConnectionProfile) {
  if (!profile) return 'SSH \u670d\u52a1\u5668'
  return profile.jumpMode === 'interactive-menu' ? '\u5821\u5792\u673a' : '\u76ee\u6807\u670d\u52a1\u5668'
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
    const endpoint = updated.jumpMode === 'interactive-menu' ? updated.gateway : updated.target
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
    terminal?.write(notice)
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

function normalizeQuickCommandText(text: string) {
  return normalizeQuickCommandList(text.split(/\r?\n/))
}

function openQuickCommandSettings() {
  quickCommandDraft.value = quickCommands.value.join('\n')
  quickCommandNotice.value = ''
  quickCommandError.value = ''
  quickCommandSettingsOpen.value = true
}

function closeQuickCommandSettings() {
  quickCommandSettingsOpen.value = false
  quickCommandAiLoading.value = false
}

function saveQuickCommandSettings() {
  const nextCommands = normalizeQuickCommandText(quickCommandDraft.value)
  quickCommands.value = nextCommands
  quickCommandDraft.value = nextCommands.join('\n')
  persistQuickCommands(nextCommands)
  quickCommandError.value = ''
  quickCommandNotice.value = '快速命令已保存。'
}

function resetQuickCommandDraft() {
  quickCommandDraft.value = DEFAULT_QUICK_COMMANDS.join('\n')
  quickCommandError.value = ''
  quickCommandNotice.value = '已恢复默认候选，保存后生效。'
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
        quickCommandDraft.value = recommended.join('\n')
        quickCommandNotice.value = 'AI 已根据历史命令生成候选。'
        return
      }
    }
    const local = localQuickCommandRecommendations()
    quickCommandDraft.value = local.join('\n')
    quickCommandNotice.value = config ? 'AI 未返回可用候选，已使用历史命令推荐。' : '未配置 AI，已使用历史命令推荐。'
  } catch (error) {
    const local = localQuickCommandRecommendations()
    quickCommandDraft.value = local.join('\n')
    quickCommandError.value = `AI 推荐失败：${formatError(error)}。已使用历史命令推荐。`
  } finally {
    quickCommandAiLoading.value = false
  }
}

function buildCompletionSuggestions(prefix = inputCommandBuffer.trimStart()) {
  const normalizedPrefix = prefix.toLowerCase()
  const seen = new Set<string>()
  const add = (command: string, source: CompletionSuggestionSource) => {
    const value = command.trim()
    if (!value) return
    if (normalizedPrefix && !value.toLowerCase().startsWith(normalizedPrefix)) return
    const key = value.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    suggestions.push({ command: value, source })
  }
  const suggestions: CompletionSuggestion[] = []
  historyCommandSuggestions().slice().reverse().forEach((command) => add(command, 'history'))
  systemCommandSuggestions().forEach((command) => add(command, 'system'))
  return suggestions.slice(0, 9)
}

function refreshCompletionSuggestions() {
  completionSuggestions.value = buildCompletionSuggestions()
  completionActiveIndex.value = Math.min(completionActiveIndex.value, Math.max(0, completionSuggestions.value.length - 1))
  terminalCompletionOpen.value = completionSuggestions.value.length > 0
}

function closeCompletion() {
  terminalCompletionOpen.value = false
  completionSuggestions.value = []
  completionActiveIndex.value = 0
}

function cycleCompletion(delta: number) {
  if (!completionSuggestions.value.length) return
  completionActiveIndex.value = (completionActiveIndex.value + delta + completionSuggestions.value.length) % completionSuggestions.value.length
}

function acceptCompletionSuggestion(suggestion = completionSuggestions.value[completionActiveIndex.value]) {
  if (!suggestion) return false
  const current = inputCommandBuffer
  if (!suggestion.command.toLowerCase().startsWith(current.toLowerCase())) return false
  const tail = suggestion.command.slice(current.length)
  if (tail) writeTerminalInput(tail)
  inputCommandBuffer = suggestion.command
  closeCompletion()
  return true
}

function handleCompletionInput(data: string) {
  if (data === '\t') {
    if (terminalCompletionOpen.value) {
      cycleCompletion(1)
    } else {
      refreshCompletionSuggestions()
    }
    return terminalCompletionOpen.value
  }
  if (!terminalCompletionOpen.value) return false
  if (data === '\x1b[A') {
    cycleCompletion(-1)
    return true
  }
  if (data === '\x1b[B') {
    cycleCompletion(1)
    return true
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
}

function isSftpProfile(profile?: ConnectionProfile) {
  return profile?.fileTransferMode === 'sftp-direct' || profile?.fileTransferMode === 'sftp-gateway'
}

function estimateTerminalSize(element: HTMLElement) {
  return {
    cols: Math.max(40, Math.floor(element.clientWidth / 8)),
    rows: Math.max(12, Math.floor(element.clientHeight / 18))
  }
}

function syncTerminalSize() {
  if (!terminal || !terminalHost.value) return
  const size = estimateTerminalSize(terminalHost.value)
  terminalSize.value = size
  terminal.resize(size.cols, size.rows)
  if (sessionId) {
    void terminalResize(sessionId, size.cols, size.rows)
  }
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
  return terminal.buffer.active.baseY + y
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

function emitTerminalSelection(text: string) {
  const normalized = text.trimEnd()
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
  const selectedText = terminal?.getSelection() ?? ''
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

function trackUserInput(data: string) {
  const commandInput = stripCommandInputControlSequences(data)
  for (const character of commandInput) {
    const code = character.charCodeAt(0)
    if (code === 13 || code === 10) {
      recordCommand(inputCommandBuffer)
      inputCommandBuffer = ''
    } else if (code === 127) {
      inputCommandBuffer = inputCommandBuffer.slice(0, -1)
    } else if (character >= ' ') {
      inputCommandBuffer += character
    }
  }
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
}

onMounted(async () => {
  if (!terminalHost.value) return

  terminal = new Terminal({
    cursorBlink: true,
    convertEol: true,
    fontFamily: resolvedTerminalSettings().terminalFontFamily,
    fontSize: resolvedTerminalSettings().terminalFontSize,
    theme: terminalThemeOptions(resolvedTerminalSettings().terminalTheme)
  })
  terminal.open(terminalHost.value)
  syncTerminalSize()
  terminal.focus()
  renderIdlePrompt(terminal)

  dataDisposable = terminal.onData((data) => {
    if (handleCompletionInput(data)) return
    if (sessionId) {
      trackUserInput(data)
      emit('terminalInput', { terminalId: props.terminalId, data })
      void terminalWrite(sessionId, data)
    }
  })
  selectionDisposable = terminal.onSelectionChange(() => {
    void copySelectionToClipboard()
  })
  terminalHost.value.addEventListener('pointerdown', handleTerminalPointerDown, true)
  terminalHost.value.addEventListener('contextmenu', handleTerminalContextMenu, true)

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
  terminal?.write(message)
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
      terminal?.write(event.data)
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
    terminal.write(message)
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
  terminal?.write('\x1b[94mpreview\x1b[0m$ ')
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
    void terminalWrite(sessionId, `${value}\r`)
    void nextTick(() => terminal?.focus())
    return true
  }
  if (status.value === 'preview') {
    const previewLine = `${value}\r\n`
    terminal?.write(previewLine)
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
    terminal?.write(data)
    appendTerminalOutput(data)
    return true
  }
  return false
}

async function pasteClipboardToTerminal() {
  try {
    const text = await readClipboard()
    if (!text) return
    trackUserInput(text)
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

onBeforeUnmount(() => {
  terminalHost.value?.removeEventListener('pointerdown', handleTerminalPointerDown, true)
  terminalHost.value?.removeEventListener('contextmenu', handleTerminalContextMenu, true)
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
        <div class="terminal-body-wrap">
          <div ref="terminalHost" class="xterm-host" aria-label="终端直接输入" />
          <div v-if="terminalCompletionOpen" class="terminal-completion" role="listbox" aria-label="命令补全">
            <button
              v-for="(suggestion, index) in completionSuggestions"
              :key="`${suggestion.source}-${suggestion.command}`"
              type="button"
              :class="{ active: index === completionActiveIndex }"
              @pointerdown.prevent="acceptCompletionSuggestion(suggestion)"
            >
              <code>{{ suggestion.command }}</code>
              <span>{{ suggestion.source === 'system' ? '系统' : suggestion.source === 'history' ? '历史' : '本次' }}</span>
            </button>
          </div>
        </div>
      </div>
    </section>
    <section class="quick-command-bar" aria-label="快速命令">
      <span>快速命令</span>
      <button v-for="command in quickCommands" :key="command" @click="runQuickCommand(command)">
        {{ command }}
      </button>
      <button class="icon-button" type="button" title="快速命令设置" aria-label="快速命令设置" @click="openQuickCommandSettings"><UiIcon name="settings" /></button>
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
      <div v-if="quickCommandSettingsOpen" class="modal-backdrop" role="presentation">
        <section class="modal quick-command-modal" role="dialog" aria-modal="true" aria-label="快速命令设置">
          <div class="modal-head">
            <div>
              <strong>快速命令</strong>
              <span>{{ quickCommands.length }} 个已启用</span>
            </div>
            <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="closeQuickCommandSettings"><UiIcon name="close" /></button>
          </div>
          <textarea
            v-model="quickCommandDraft"
            class="quick-command-editor"
            spellcheck="false"
            placeholder="ping\ndf -h\nfree -m\nsystemctl status"
            aria-label="快速命令列表"
          />
          <p v-if="quickCommandError" class="save-feedback error">{{ quickCommandError }}</p>
          <p v-else-if="quickCommandNotice" class="save-feedback ok">{{ quickCommandNotice }}</p>
          <div class="modal-actions quick-command-actions">
            <button class="text-button" type="button" @click="resetQuickCommandDraft">恢复默认</button>
            <button class="text-button" type="button" :disabled="quickCommandAiLoading" @click="recommendQuickCommandsWithAi">
              {{ quickCommandAiLoading ? '推荐中...' : 'AI 推荐' }}
            </button>
            <button class="text-button" type="button" @click="closeQuickCommandSettings">取消</button>
            <button class="text-button primary-action" type="button" @click="saveQuickCommandSettings">保存</button>
          </div>
        </section>
      </div>
    </teleport>
  </main>
</template>
