<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { AiProviderConfig } from '../types/profile'
import type { AiContextStatus, AiMessage, CommandHistoryEntry, WorkspaceSession } from '../types/workspace'
import { chatWithAiProviderStream, generateAiSessionTitle, onAiChatStream } from '../lib/tauri'

type MessagePart =
  | { type: 'text'; content: string }
  | { type: 'code'; content: string; language: string }

const LONG_MESSAGE_CHARS = 900
const LONG_MESSAGE_LINES = 12

const props = defineProps<{
  terminalId: string
  connectionId: string
  workspaceSessionId: string
  workspaceSessions: WorkspaceSession[]
  selectedConfigId: string
  config: AiProviderConfig
  apiKey: string
  terminalSnapshot: string
  commandHistory: CommandHistoryEntry[]
  messages: AiMessage[]
  contextStatus?: AiContextStatus
}>()

const emit = defineEmits<{
  appendMessage: [message: AiMessage]
  updateMessage: [message: AiMessage]
  setContextStatus: [connectionId: string, workspaceSessionId: string, status: AiContextStatus]
  executeCommand: [command: string]
  selectSession: [sessionId: string]
  createSession: []
  renameSession: [sessionId: string]
  deleteSession: [sessionId: string]
  updateSessionTitle: [connectionId: string, sessionId: string, title: string]
}>()

const askText = ref('')
const isAsking = ref(false)
const expandedMessages = ref<Record<string, boolean>>({})
const messageList = ref<HTMLElement | null>(null)
const historyOpen = ref(false)
const sessionSearch = ref('')

const hasUsableConfig = computed(() => {
  return Boolean(props.config.baseUrl.trim() && props.config.model.trim() && (props.config.apiKey?.trim() || props.apiKey.trim()))
})

const generatedCommand = computed(() => {
  return [...props.messages].reverse().find((message) => message.role === 'assistant' && message.command)?.command ?? ''
})

const activeSession = computed(() => {
  return props.workspaceSessions.find((session) => session.id === props.workspaceSessionId)
})

const activeSessionTitle = computed(() => activeSession.value?.name?.trim() || 'Untitled')

const filteredSessions = computed(() => {
  const keyword = sessionSearch.value.trim().toLowerCase()
  const sessions = props.workspaceSessions.length
    ? props.workspaceSessions
    : [
        {
          id: props.workspaceSessionId,
          connectionId: props.connectionId,
          name: activeSessionTitle.value,
          summary: '',
          createdAt: '',
          updatedAt: ''
        }
      ]
  if (!keyword) return sessions
  return sessions.filter((session) => {
    return `${session.name} ${session.summary}`.toLowerCase().includes(keyword)
  })
})

function inferCommand(question: string, terminalSnapshot = props.terminalSnapshot, commandHistory = props.commandHistory.map((entry) => entry.command)) {
  const text = question.toLowerCase()
  const recentCommands = commandHistory.slice(-8).join('\n')
  const context = `${terminalSnapshot}\n${recentCommands}`.toLowerCase()

  if (text.includes('磁盘') || text.includes('空间') || text.includes('disk')) return 'df -h'
  if (text.includes('内存') || text.includes('memory')) return 'free -h'
  if (text.includes('端口') || text.includes('port')) return 'ss -tulpn'
  if (text.includes('进程') || text.includes('process')) return 'ps aux --sort=-%mem | head'
  if (text.includes('日志') || text.includes('log')) return 'journalctl -n 100 --no-pager'
  if (text.includes('更新') || text.includes('upgrade') || context.includes('apt list --upgradable')) {
    return 'apt list --upgradable'
  }
  const fallbackCommands = recentCommands.split('\n').filter(Boolean)
  return fallbackCommands[fallbackCommands.length - 1] ?? 'uname -a'
}

async function sendMessage() {
  const text = askText.value.trim()
  if (!text) return
  const requestTerminalId = props.terminalId
  const requestConnectionId = props.connectionId
  const requestWorkspaceSessionId = props.workspaceSessionId
  const terminalSnapshot = props.terminalSnapshot
  const commandHistory = props.commandHistory.map((entry) => entry.command)
  emit('appendMessage', createMessage(requestConnectionId, requestWorkspaceSessionId, requestTerminalId, 'user', text))
  const assistantMessage = createMessage(requestConnectionId, requestWorkspaceSessionId, requestTerminalId, 'assistant', '', '', false, true)
  emit('appendMessage', assistantMessage)
  askText.value = ''
  isAsking.value = true
  let streamedAnswer = ''
  let unlisten: (() => void) | undefined
  try {
    const requestId = `${requestConnectionId}-${requestWorkspaceSessionId}-${requestTerminalId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    unlisten = await onAiChatStream(requestId, (event) => {
      if (event.kind === 'chunk') {
        streamedAnswer += event.delta
        emit('updateMessage', {
          ...assistantMessage,
          text: streamedAnswer,
          command: extractPrimaryShellCommand(streamedAnswer),
          streaming: true
        })
      }
      if (event.kind === 'error' && event.error) {
        emit('updateMessage', {
          ...assistantMessage,
          text: `模型流式调用失败。\n\n错误详情：${event.error}`,
          command: '',
          error: true,
          streaming: false
        })
      }
    })
    const response = await callConfiguredModelStream(requestId, text, terminalSnapshot, commandHistory)
    const answer = streamedAnswer || response.answer
    const command = extractPrimaryShellCommand(answer)
    emit('setContextStatus', requestConnectionId, requestWorkspaceSessionId, {
      compressed: response.contextCompressed,
      chars: response.contextChars,
      history: response.historyCount
    })
    emit('updateMessage', {
      ...assistantMessage,
      text: answer,
      command,
      streaming: false
    })
    maybeGenerateSessionTitle(requestConnectionId, requestWorkspaceSessionId, text, answer, terminalSnapshot, commandHistory)
  } catch (error) {
    const detail = formatAiError(error)
    const command = inferCommand(text, terminalSnapshot, commandHistory)
    emit('updateMessage', {
      ...assistantMessage,
      text: `模型调用失败，未执行任何远程请求结果。\n\n错误详情：${detail}\n\n可临时参考本地建议：${command}`,
      command,
      error: true,
      streaming: false
    })
  } finally {
    unlisten?.()
    isAsking.value = false
  }
}

function handleComposerKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter') return
  if (event.isComposing) return
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault()
    void sendMessage()
  }
}

function scrollMessagesToLatest() {
  void nextTick(() => {
    requestAnimationFrame(() => {
      const list = messageList.value
      if (!list) return
      list.scrollTop = list.scrollHeight
    })
  })
}

function createMessage(
  connectionId: string,
  workspaceSessionId: string,
  terminalId: string,
  role: AiMessage['role'],
  text: string,
  command = '',
  error = false,
  streaming = false
): AiMessage {
  return {
    id: `${connectionId}-${terminalId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    connectionId,
    workspaceSessionId,
    terminalId,
    role,
    text,
    command,
    error,
    streaming,
    createdAt: new Date().toISOString()
  }
}

async function callConfiguredModelStream(requestId: string, question: string, terminalSnapshot: string, commandHistory: string[]) {
  if (!props.config.baseUrl.trim() || !props.config.model.trim()) {
    throw new Error('请先配置 AI Base URL 和 Model')
  }
  const apiKey = props.config.apiKey?.trim() || props.apiKey.trim()
  if (!apiKey) {
    throw new Error('请在 AI Config 中填写 API Key 并保存到 SQLite')
  }

  return chatWithAiProviderStream(requestId, {
    config: props.config,
    apiKey,
    question,
    terminalSnapshot,
    commandHistory
  })
}

function formatAiError(error: unknown) {
  if (!(error instanceof Error)) return String(error)
  if (error.message.includes('__TAURI_IPC__') || error.message.includes('invoke')) {
    return `AI 后端调用不可用：${error.message}\n请通过 Tauri 客户端运行，或在 src-tauri 目录执行 cargo run。`
  }
  return error.message
}

function extractPrimaryShellCommand(answer: string) {
  const shellBlock = parseMessageParts(answer)
    .find((part) => part.type === 'code' && isShellLanguage(part.language))
  if (shellBlock?.type === 'code') {
    return normalizeShellCommand(shellBlock.content)
  }

  const candidate = answer
    .split('\n')
    .map((line) => line.trim())
    .find((line) => looksLikeShellCommand(line))
  return candidate ? normalizeShellCommand(candidate) : ''
}

function parseMessageParts(text: string): MessagePart[] {
  const parts: MessagePart[] = []
  const pattern = /```([a-zA-Z0-9_.+-]*)[ \t]*\n?([\s\S]*?)```/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', content: text.slice(lastIndex, match.index) })
    }
    parts.push({
      type: 'code',
      language: match[1]?.trim() || 'text',
      content: match[2]?.trimEnd() ?? ''
    })
    lastIndex = pattern.lastIndex
  }

  if (lastIndex < text.length) {
    parts.push({ type: 'text', content: text.slice(lastIndex) })
  }

  return parts.length ? parts : [{ type: 'text', content: text }]
}

function executableCommands(message: AiMessage) {
  const commands = parseMessageParts(message.text)
    .filter((part): part is Extract<MessagePart, { type: 'code' }> => part.type === 'code' && isShellLanguage(part.language))
    .map((part) => normalizeShellCommand(part.content))
    .filter(Boolean)

  if (message.command) commands.unshift(normalizeShellCommand(message.command))
  return Array.from(new Set(commands))
}

function isShellLanguage(language: string) {
  return ['bash', 'sh', 'shell', 'zsh', ''].includes(language.trim().toLowerCase())
}

function looksLikeShellCommand(line: string) {
  return /^(sudo\s+)?[\w./~$-]+(\s|$)/.test(line) && !line.startsWith('<')
}

function normalizeShellCommand(command: string) {
  return command
    .split('\n')
    .map((line) => line.trim())
    .map((line) => line.replace(/^\$ /, ''))
    .filter((line) => line && !line.startsWith('#'))
    .join(' && ')
}

function isDangerousCommand(command: string) {
  const normalized = command.toLowerCase().replace(/\s+/g, ' ').trim()
  const dangerousPatterns = [
    /\brm\s+(-[a-z]*[rf][a-z]*|-r|-f)\b/,
    /\bsudo\s+rm\b/,
    /\bdd\s+.*\bof=\/dev\//,
    /\bmkfs(\.| |$)/,
    /\bformat\b/,
    /\bshutdown\b/,
    /\breboot\b/,
    /\bpoweroff\b/,
    /\bhalt\b/,
    /\bkill\s+-9\b/,
    /\bpkill\b/,
    /\bkillall\b/,
    /\bchmod\s+(-r\s+)?777\b/,
    /\bchown\s+(-r\s+)?[^&|;]+\/\b/,
    /\btruncate\s+.*\s+\/\b/,
    /\bfind\b.*\s-delete\b/,
    /\bdocker\s+system\s+prune\b.*\s-a\b/,
    /\bkubectl\s+delete\b/,
    /\biptables\s+-f\b/,
    /\bnft\s+flush\b/,
    />\s*\/dev\/sd[a-z]/,
    /:\(\)\s*\{\s*:\|:\s*&\s*\}/
  ]
  return dangerousPatterns.some((pattern) => pattern.test(normalized))
}

function shouldCollapseMessage(message: AiMessage) {
  return message.text.length > LONG_MESSAGE_CHARS || message.text.split('\n').length > LONG_MESSAGE_LINES
}

function isMessageExpanded(message: AiMessage) {
  return !shouldCollapseMessage(message) || Boolean(expandedMessages.value[message.id])
}

function toggleMessage(messageId: string) {
  expandedMessages.value = {
    ...expandedMessages.value,
    [messageId]: !expandedMessages.value[messageId]
  }
}

function executeGeneratedCommand(command = generatedCommand.value) {
  const value = command.trim()
  if (!value) return
  if (isDangerousCommand(value)) {
    const confirmed = window.confirm(`检测到高风险命令，确认要在当前终端执行吗？\n\n${value}`)
    if (!confirmed) return
  }
  emit('executeCommand', value)
}

function toggleHistory() {
  historyOpen.value = !historyOpen.value
}

function selectSession(sessionId: string) {
  emit('selectSession', sessionId)
  historyOpen.value = false
}

function createSession() {
  emit('createSession')
  historyOpen.value = false
}

function maybeGenerateSessionTitle(
  connectionId: string,
  sessionId: string,
  userMessage: string,
  assistantMessage: string,
  terminalSnapshot: string,
  commandHistory: string[]
) {
  const session = props.workspaceSessions.find((item) => item.id === sessionId)
  const currentName = session?.name?.trim() || activeSessionTitle.value
  if (!isAutoSessionName(currentName)) return
  const apiKey = props.config.apiKey?.trim() || props.apiKey.trim()
  if (!props.config.baseUrl.trim() || !props.config.model.trim() || !apiKey) return

  void generateAiSessionTitle({
    config: props.config,
    apiKey,
    userMessage,
    assistantMessage,
    terminalSnapshot,
    commandHistory
  })
    .then((response) => {
      const title = response.title.trim()
      if (!title || !isAutoSessionName(currentName)) return
      emit('updateSessionTitle', connectionId, sessionId, title)
    })
    .catch((error) => {
      console.error('failed to generate AI session title', error)
    })
}

function isAutoSessionName(name: string) {
  return ['untitled', '默认会话', '本地默认会话', '当前会话'].includes(name.trim().toLowerCase())
}

function sessionTimeLabel(session: WorkspaceSession) {
  const value = session.updatedAt || session.createdAt
  if (!value) return ''
  const time = Date.parse(value)
  if (Number.isNaN(time)) return value
  const diff = Date.now() - time
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return 'now'
  if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))}m`
  if (diff < day) return `${Math.max(1, Math.floor(diff / hour))}h`
  return `${Math.max(1, Math.floor(diff / day))}d`
}

watch(
  () => props.messages.map((message) => `${message.id}:${message.text.length}:${message.streaming ? '1' : '0'}`).join('|'),
  scrollMessagesToLatest,
  { flush: 'post' }
)
</script>

<template>
  <section class="assistant-panel">
    <div class="panel-head">
      <div class="ai-session-head">
        <strong>{{ activeSessionTitle }}</strong>
        <span>AI 助手</span>
      </div>
      <div class="panel-actions">
        <button class="icon-button" type="button" title="历史会话" aria-label="历史会话" @click="toggleHistory">◷</button>
        <button class="icon-button" type="button" title="新建会话" aria-label="新建会话" @click="createSession">＋</button>
        <button class="icon-button" title="执行命令" aria-label="执行命令" :disabled="!generatedCommand || isAsking" @click="executeGeneratedCommand()">▶</button>
      </div>
      <div v-if="historyOpen" class="session-history-popover">
        <div class="session-search">
          <span>⌕</span>
          <input v-model="sessionSearch" placeholder="Search sessions..." aria-label="Search sessions" />
        </div>
        <div class="session-history-list">
          <article
            v-for="session in filteredSessions"
            :key="session.id"
            class="session-history-row"
            :class="{ active: session.id === workspaceSessionId }"
            role="button"
            tabindex="0"
            @click="selectSession(session.id)"
            @keydown.enter.prevent="selectSession(session.id)"
          >
            <span class="session-history-main">
              <strong>{{ session.name || 'Untitled' }}</strong>
              <small v-if="session.summary">{{ session.summary }}</small>
            </span>
            <span class="session-history-time">{{ sessionTimeLabel(session) }}</span>
            <span class="session-history-actions">
              <button class="icon-button" type="button" title="编辑会话" aria-label="编辑会话" @click.stop="emit('renameSession', session.id)">✎</button>
              <button class="icon-button danger" type="button" title="删除会话" aria-label="删除会话" @click.stop="emit('deleteSession', session.id)">⌫</button>
            </span>
          </article>
          <p v-if="filteredSessions.length === 0" class="empty-state">No sessions</p>
        </div>
      </div>
    </div>
    <div class="context-strip">
      <span class="chip">AI {{ selectedConfigId }}</span>
      <span class="chip">terminal {{ terminalSnapshot.length }} chars</span>
      <span class="chip">history {{ commandHistory.length }}</span>
      <span v-if="contextStatus" class="chip">
        {{ contextStatus.compressed ? 'context compressed' : 'context full' }} {{ contextStatus.chars }} chars
      </span>
      <span v-if="isAsking" class="chip">模型调用中</span>
    </div>
    <div ref="messageList" class="message-list">
      <p v-if="!hasUsableConfig" class="empty-state">暂无可用 AI 配置，请在左侧配置菜单中新建或完善配置。</p>
      <p v-else-if="messages.length === 0" class="empty-state">当前终端暂无对话</p>
      <article
        v-for="message in messages"
        :key="message.id"
        class="message"
        :class="{ ai: message.role === 'assistant', error: message.error, collapsed: !isMessageExpanded(message) }"
      >
        <div class="message-title">
          <strong>{{ message.role === 'assistant' ? 'AI' : 'You' }}<span v-if="message.streaming" class="streaming-dot">输出中</span></strong>
          <div class="message-actions">
            <button
              v-if="shouldCollapseMessage(message)"
              class="text-button"
              type="button"
              @click="toggleMessage(message.id)"
            >
              {{ isMessageExpanded(message) ? '收起' : '展开' }}
            </button>
            <button
              v-if="executableCommands(message).length"
              class="icon-button"
              title="执行第一条 bash 命令"
              aria-label="执行第一条 bash 命令"
              @click="executeGeneratedCommand(executableCommands(message)[0])"
            >▶</button>
          </div>
        </div>
        <div class="message-body">
          <div v-if="message.streaming && !message.text" class="thinking-row">
            <span />
            <span />
            <span />
            正在回复...
          </div>
          <template v-for="(part, index) in parseMessageParts(message.text)" :key="`${message.id}-${index}`">
            <p v-if="part.type === 'text' && part.content.trim()">{{ part.content.trim() }}</p>
            <div v-else-if="part.type === 'code'" class="code-block">
              <div class="code-head">
                <span>{{ part.language || 'text' }}</span>
                <button
                  v-if="isShellLanguage(part.language)"
                  class="text-button"
                  type="button"
                  @click="executeGeneratedCommand(normalizeShellCommand(part.content))"
                >
                  执行
                </button>
              </div>
              <pre><code>{{ part.content }}</code></pre>
            </div>
          </template>
        </div>
      </article>
    </div>
    <div class="assistant-compose">
      <textarea
        v-model="askText"
        :disabled="!hasUsableConfig"
        rows="4"
        placeholder="输入问题，Ctrl+Enter / ⌘+Enter 发送"
        aria-label="Ask AI"
        @keydown="handleComposerKeydown"
      />
      <button class="icon-button" :title="isAsking ? '调用中' : 'Ctrl+Enter / ⌘+Enter 发送'" :aria-label="isAsking ? '调用中' : '发送'" :disabled="isAsking || !hasUsableConfig" @click="sendMessage">
        {{ isAsking ? '…' : '→' }}
      </button>
    </div>
  </section>
</template>
