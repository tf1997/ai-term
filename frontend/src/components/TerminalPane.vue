<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import type { IDisposable } from '@xterm/xterm'
import { readText as readClipboardText, writeText as writeClipboardText } from '@tauri-apps/api/clipboard'
import '@xterm/xterm/css/xterm.css'
import {
  connectProfile,
  connectLocalTerminal,
  disconnectTerminal,
  onTerminalClosed,
  onTerminalData,
  terminalResize,
  terminalSessionActive,
  terminalWrite
} from '../lib/tauri'
import type { ConnectionProfile } from '../types/profile'
import type { CommandHistoryEntry, CommandRecordedEvent, TerminalOutputEvent, TerminalSelectionEvent } from '../types/workspace'

type TerminalRuntimeStatus = 'idle' | 'connecting' | 'local' | 'remote' | 'sftp' | 'preview' | 'error'
type TerminalSessionKind = 'local' | 'remote' | 'sftp' | 'preview'
type CompletionSuggestionSource = 'system' | 'history' | 'session'

interface CompletionSuggestion {
  command: string
  source: CompletionSuggestionSource
}

const props = defineProps<{
  terminalId: string
  profile?: ConnectionProfile
  connectRequest: number
  commandHistory: CommandHistoryEntry[]
}>()

const emit = defineEmits<{
  terminalOutput: [event: TerminalOutputEvent]
  terminalSelection: [event: TerminalSelectionEvent]
  commandRecorded: [event: CommandRecordedEvent]
  statusChanged: [terminalId: string, status: TerminalRuntimeStatus]
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
const quickCommands = ['ping', 'top', 'htop', 'df -h', 'free -m', 'ls -la']

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


onMounted(async () => {
  if (!terminalHost.value) return

  terminal = new Terminal({
    cursorBlink: true,
    convertEol: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 13,
    theme: {
      background: '#0b0d0e',
      foreground: '#d5dde5',
      cursor: '#d8f3ff',
      blue: '#88b7ff',
      cyan: '#60d8e8',
      green: '#7ee094',
      yellow: '#ffc95e'
    }
  })
  terminal.open(terminalHost.value)
  syncTerminalSize()
  terminal.focus()
  renderIdlePrompt(terminal)

  dataDisposable = terminal.onData((data) => {
    if (handleCompletionInput(data)) return
    if (sessionId) {
      trackUserInput(data)
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
    const message = `\r\nSSH connection failed: ${String(error)}\r\n`
    terminal.write(message)
    appendTerminalOutput(message)
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
  terminal.writeln(`Mode: ${props.profile.fileTransferMode === 'sftp-gateway' ? 'SFTP via gateway' : 'SFTP direct'}`)
  terminal.writeln('')
  terminal.writeln('Use the SFTP workspace on the right to browse, upload, and download files.')
  terminalOutputBuffer = [
    'SFTP profile is ready.',
    `Profile: ${props.profile.name}`,
    `Target: ${props.profile.target.username || 'user'}@${props.profile.target.host || 'server'}`,
    `Mode: ${props.profile.fileTransferMode === 'sftp-gateway' ? 'SFTP via gateway' : 'SFTP direct'}`,
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
            <span class="terminal-title">{{ activeSessionProfile?.name ?? 'Local Terminal' }}</span>
            <span class="terminal-subtitle">
              {{ activeSessionProfile ? `${activeSessionProfile.target.username || 'user'}@${activeSessionProfile.target.host || 'server'}` : 'localhost' }}
            </span>
          </div>
          <div class="terminal-tools">
            <button class="icon-button" title="复制终端输出" aria-label="复制终端输出" @click="copyTerminalOutput">⧉</button>
            <button class="icon-button" title="清屏" aria-label="清屏" @click="clearTerminal">⌫</button>
            <button class="icon-button" title="新建本地终端" aria-label="新建本地终端" @click="restartLocalTerminal">+</button>
            <button class="icon-button" title="断开连接" aria-label="断开连接" @click="disconnectFromButton">×</button>
          </div>
        </div>
        <div class="terminal-body-wrap">
          <div ref="terminalHost" class="xterm-host" aria-label="Terminal direct input" />
          <div v-if="terminalCompletionOpen" class="terminal-completion" role="listbox" aria-label="Command completion">
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

    <section class="quick-command-bar" aria-label="Quick commands">
      <span>快速命令</span>
      <button v-for="command in quickCommands" :key="command" @click="runQuickCommand(command)">
        {{ command }}
      </button>
      <button class="icon-button" title="Quick command settings">⚙</button>
    </section>

    <footer class="status-bar">
      <span class="chip"><span class="status-dot" :class="{ live: status === 'local' || status === 'remote' || status === 'sftp', connecting: status === 'connecting', error: status === 'error', preview: status === 'preview' }" />{{ status }}</span>
      <span class="chip">{{ activeSessionProfile?.jumpMode ?? 'local-shell' }}</span>
      <span class="chip">{{ terminalSize.cols }}x{{ terminalSize.rows }}</span>
      <span class="chip">gateway:{{ activeSessionProfile?.gateway.authMode ?? '-' }}</span>
      <span class="chip">target:{{ activeSessionProfile?.target.authMode ?? '-' }}</span>
      <span class="chip">keyboard:direct</span>
    </footer>
  </main>
</template>
