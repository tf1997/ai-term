<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import type { IDisposable } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import {
  connectProfile,
  connectLocalTerminal,
  disconnectTerminal,
  onTerminalClosed,
  onTerminalData,
  terminalResize,
  terminalWrite
} from '../lib/tauri'
import type { ConnectionProfile } from '../types/profile'
import type { CommandRecordedEvent, TerminalOutputEvent } from '../types/workspace'

const props = defineProps<{
  terminalId: string
  profile?: ConnectionProfile
  connectRequest: number
}>()

const emit = defineEmits<{
  terminalOutput: [event: TerminalOutputEvent]
  commandRecorded: [event: CommandRecordedEvent]
}>()

const terminalHost = ref<HTMLDivElement | null>(null)
let terminal: Terminal | undefined
let sessionId = ''
let unlisten: (() => void) | undefined
let unlistenClosed: (() => void) | undefined
let resizeObserver: ResizeObserver | undefined
let dataDisposable: IDisposable | undefined
let terminalOutputBuffer = ''
let inputCommandBuffer = ''
const status = ref<'idle' | 'local' | 'remote' | 'preview' | 'error'>('idle')
const terminalSize = ref({ cols: 80, rows: 24 })
const activeSession = ref<'local' | 'remote' | 'preview'>('local')
const activeSessionProfile = ref<ConnectionProfile | undefined>(undefined)
const quickCommands = ['ping', 'top', 'htop', 'df -h', 'free -m', 'ls -la']

function renderIdlePrompt(term: Terminal) {
  term.clear()
  term.writeln('No active shell.')
  term.writeln('Use New Local Shell to start a local terminal.')
  term.writeln('')
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

function recordCommand(command: string) {
  const value = command.trim()
  if (!value) return
  emit('commandRecorded', {
    terminalId: props.terminalId,
    command: value
  })
}

function trackUserInput(data: string) {
  for (const character of data) {
    if (character === '\r' || character === '\n') {
      recordCommand(inputCommandBuffer)
      inputCommandBuffer = ''
    } else if (character === '\u007f') {
      inputCommandBuffer = inputCommandBuffer.slice(0, -1)
    } else if (character >= ' ') {
      inputCommandBuffer += character
    }
  }
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
    if (sessionId) {
      trackUserInput(data)
      void terminalWrite(sessionId, data)
    }
  })

  resizeObserver = new ResizeObserver(() => {
    syncTerminalSize()
  })
  resizeObserver.observe(terminalHost.value)

  if (props.profile) {
    await connectRemote()
  } else {
    await connectLocal()
  }
})

watch(
  () => props.connectRequest,
  async () => {
    if (!terminal || props.connectRequest === 0) return
    if (props.profile) {
      await connectRemote()
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
    const closedSessionId = sessionId
    sessionId = ''
    status.value = 'idle'
    const message = `\r\nShell exited: ${event.reason}\r\n`
    terminal?.write(message)
    appendTerminalOutput(message)
    void disconnectTerminal(closedSessionId)
  })
}

async function connectRemote() {
  if (!terminal || !terminalHost.value || !props.profile) return
  try {
    disconnect(false)
    activeSession.value = 'remote'
    activeSessionProfile.value = props.profile
    status.value = 'remote'
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
  try {
    disconnect(false)
    terminal.clear()
    terminal.writeln('Opening local shell...')
    terminalOutputBuffer = 'Opening local shell...\n'
    emit('terminalOutput', {
      terminalId: props.terminalId,
      snapshot: terminalOutputBuffer
    })
    const size = estimateTerminalSize(terminalHost.value)
    sessionId = await connectLocalTerminal(size.cols, size.rows)
    activeSession.value = 'local'
    activeSessionProfile.value = undefined
    status.value = 'local'
    await attachTerminalEvents()
    syncTerminalSize()
    await nextTick()
    terminal.focus()
  } catch (error) {
    enterPreviewMode()
  }
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

function clearTerminal() {
  terminal?.clear()
}

async function copyTerminalOutput() {
  if (!terminalOutputBuffer.trim()) return
  await navigator.clipboard?.writeText(terminalOutputBuffer)
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

function disconnect(renderReady = true) {
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
  disconnect(false)
  resizeObserver?.disconnect()
  unlisten?.()
  unlistenClosed?.()
  dataDisposable?.dispose()
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
      <div class="terminal-frame">
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
        <div ref="terminalHost" class="xterm-host" aria-label="Terminal direct input" />
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
      <span class="chip"><span class="status-dot" :class="{ live: status === 'local' || status === 'remote' }" />{{ status }}</span>
      <span class="chip">{{ activeSessionProfile?.jumpMode ?? 'local-shell' }}</span>
      <span class="chip">{{ terminalSize.cols }}x{{ terminalSize.rows }}</span>
      <span class="chip">gateway:{{ activeSessionProfile?.gateway.authMode ?? '-' }}</span>
      <span class="chip">target:{{ activeSessionProfile?.target.authMode ?? '-' }}</span>
      <span class="chip">keyboard:direct</span>
    </footer>
  </main>
</template>
