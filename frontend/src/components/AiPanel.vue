<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { AiProviderConfig } from '../types/profile'
import type {
  AiContextStatus,
  AiMessage,
  CommandHistoryEntry,
  TerminalSelectionEvent,
  WorkspaceSession
} from '../types/workspace'
import { cancelTask, chatWithAiProviderStream, generateAiSessionTitle, onAiChatStream } from '../lib/tauri'

type MessagePart =
  | { type: 'text'; content: string }
  | { type: 'code'; content: string; language: string }

const LONG_MESSAGE_CHARS = 900
const LONG_MESSAGE_LINES = 12
const MAX_SELECTED_TERMINAL_CHARS = 20_000
const MAX_AI_COMMAND_HISTORY = 80

const props = defineProps<{
  terminalId: string
  connectionId: string
  workspaceSessionId: string
  workspaceSessions: WorkspaceSession[]
  selectedConfigId: string
  config: AiProviderConfig
  apiKey: string
  terminalSnapshot: string
  terminalSelection?: TerminalSelectionEvent
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
  renameSession: [sessionId: string, name: string]
  deleteSession: [sessionId: string]
  updateSessionTitle: [connectionId: string, sessionId: string, title: string]
}>()

const askText = ref('')
const isAsking = ref(false)
const collapsedMessages = ref<Record<string, boolean>>({})
const messageList = ref<HTMLElement | null>(null)
const historyPopover = ref<HTMLElement | null>(null)
const historyButton = ref<HTMLButtonElement | null>(null)
const composerInput = ref<HTMLTextAreaElement | null>(null)
const historyOpen = ref(false)
const sessionSearch = ref('')
const currentRequestId = ref('')
const currentAssistantMessageId = ref('')
const stopRequested = ref(false)
const renamingSession = ref<WorkspaceSession | null>(null)
const sessionNameDraft = ref('')

const hasUsableConfig = computed(() => {
  return Boolean(props.config.baseUrl.trim() && props.config.model.trim() && (props.config.apiKey?.trim() || props.apiKey.trim()))
})

const composerPlaceholder = computed(() => {
  if (hasUsableConfig.value) return '输入问题，Ctrl+Enter / ⌘+Enter 发送'
  return '请先在左侧配置菜单完善 AI Base URL、Model 和 API Key'
})


const activeSession = computed(() => {
  return props.workspaceSessions.find((session) => session.id === props.workspaceSessionId)
})

const activeSessionTitle = computed(() => activeSession.value?.name?.trim() || 'Untitled')

const selectedTerminalContext = computed(() => {
  const selection = props.terminalSelection
  if (!selection?.text.trim()) return undefined
  return selection
})

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
  const commandHistory = props.commandHistory.map((entry) => entry.command).slice(-MAX_AI_COMMAND_HISTORY)
  const selectedContext = selectedTerminalContext.value
  const userMessageText = selectedContext
    ? `${text}\n\n选中终端内容：${formatSelectedLineRange(selectedContext)}（已加入上下文）`
    : text
  emit('appendMessage', createMessage(requestConnectionId, requestWorkspaceSessionId, requestTerminalId, 'user', userMessageText))
  const assistantMessage = createMessage(requestConnectionId, requestWorkspaceSessionId, requestTerminalId, 'assistant', '', '', false, true)
  emit('appendMessage', assistantMessage)
  askText.value = ''
  isAsking.value = true
  stopRequested.value = false
  let streamedAnswer = ''
  let unlisten: (() => void) | undefined
  const requestId = `${requestConnectionId}-${requestWorkspaceSessionId}-${requestTerminalId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  currentRequestId.value = requestId
  currentAssistantMessageId.value = assistantMessage.id
  try {
    unlisten = await onAiChatStream(requestId, (event) => {
      if (stopRequested.value || currentRequestId.value !== requestId) return
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
        if (stopRequested.value) return
        emit('updateMessage', {
          ...assistantMessage,
          text: `模型流式调用失败。\n\n错误详情：${event.error}`,
          command: '',
          error: true,
          streaming: false
        })
      }
    })
    const response = await callConfiguredModelStream(
      requestId,
      buildQuestionWithSelectedTerminalText(text, selectedContext),
      terminalSnapshot,
      commandHistory
    )
    if (stopRequested.value || currentRequestId.value !== requestId) return
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
    if (stopRequested.value || currentRequestId.value !== requestId) return
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
    if (currentRequestId.value === requestId) {
      currentRequestId.value = ''
      currentAssistantMessageId.value = ''
      stopRequested.value = false
      isAsking.value = false
    }
  }
}

function formatSelectedLineRange(selection: TerminalSelectionEvent) {
  if (!selection.startLine || !selection.endLine) return 'line ?'
  if (selection.startLine === selection.endLine) return `line ${selection.startLine}`
  return `line ${selection.startLine} - line ${selection.endLine}`
}

function truncateSelectedTerminalText(text: string) {
  if (text.length <= MAX_SELECTED_TERMINAL_CHARS) return text
  return `${text.slice(0, MAX_SELECTED_TERMINAL_CHARS)}\n\n[AI Term 已截断用户选中的终端内容：省略 ${text.length - MAX_SELECTED_TERMINAL_CHARS} 个字符]`
}

function buildQuestionWithSelectedTerminalText(question: string, selection?: TerminalSelectionEvent) {
  if (!selection?.text.trim()) return question
  return [
    `用户问题：${question.trim()}`,
    '',
    `用户选中的终端内容（${formatSelectedLineRange(selection)}）：`,
    '```text',
    truncateSelectedTerminalText(selection.text),
    '```',
    '',
    '请优先结合这段选中内容、当前终端内容和历史命令回答。'
  ].join('\n')
}

function stopCurrentAnswer() {
  const requestId = currentRequestId.value
  if (!requestId || !isAsking.value) return
  stopRequested.value = true
  void cancelTask(requestId).catch((error) => {
    console.error('failed to cancel AI request', error)
  })
  const message = props.messages.find((item) => item.id === currentAssistantMessageId.value)
  if (message) {
    const stoppedText = message.text.trim()
      ? `${message.text.trimEnd()}\n\n[已停止回答]`
      : '[已停止回答]'
    emit('updateMessage', {
      ...message,
      text: stoppedText,
      streaming: false
    })
  }
  currentRequestId.value = ''
  currentAssistantMessageId.value = ''
  isAsking.value = false
}

function handleComposerKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter') return
  if (event.isComposing) return
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault()
    void sendMessage()
  }
}

function focusComposer() {
  historyOpen.value = false
  if (!hasUsableConfig.value) return
  void nextTick(() => {
    composerInput.value?.focus()
  })
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


function isShellLanguage(language: string) {
  return ['bash', 'sh', 'shell', 'zsh'].includes(language.trim().toLowerCase())
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

function isMessageCollapsed(message: AiMessage) {
  return shouldCollapseMessage(message) && Boolean(collapsedMessages.value[message.id])
}

function isMessageExpanded(message: AiMessage) {
  return !isMessageCollapsed(message)
}

function toggleMessage(messageId: string) {
  collapsedMessages.value = {
    ...collapsedMessages.value,
    [messageId]: !collapsedMessages.value[messageId]
  }
}

function executeGeneratedCommand(command: string) {
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

function handleDocumentPointerDown(event: PointerEvent) {
  if (!historyOpen.value) return
  const target = event.target
  if (!(target instanceof Node)) return
  if (historyPopover.value?.contains(target)) return
  if (historyButton.value?.contains(target)) return
  historyOpen.value = false
}

function selectSession(sessionId: string) {
  emit('selectSession', sessionId)
  historyOpen.value = false
}

function createSession() {
  emit('createSession')
  historyOpen.value = false
}

function openRenameSessionDialog(session: WorkspaceSession) {
  renamingSession.value = session
  sessionNameDraft.value = session.name || 'Untitled'
  historyOpen.value = false
}

function closeRenameSessionDialog() {
  renamingSession.value = null
  sessionNameDraft.value = ''
}

function submitRenameSession() {
  const session = renamingSession.value
  const nextName = sessionNameDraft.value.trim()
  if (!session || !nextName) return
  emit('renameSession', session.id, nextName)
  closeRenameSessionDialog()
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

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointerDown, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown, true)
})

watch(
  () => hasUsableConfig.value,
  (usable, wasUsable) => {
    if (usable && !wasUsable) focusComposer()
  },
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
        <button ref="historyButton" class="icon-button" type="button" title="历史会话" aria-label="历史会话" @click="toggleHistory">◷</button>
        <button class="icon-button" type="button" title="新建会话" aria-label="新建会话" @click="createSession">＋</button>
      </div>
      <div v-if="historyOpen" ref="historyPopover" class="session-history-popover">
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
              <button class="icon-button" type="button" title="编辑会话" aria-label="编辑会话" @click.stop="openRenameSessionDialog(session)">✎</button>
              <button class="icon-button danger" type="button" title="删除会话" aria-label="删除会话" @click.stop="emit('deleteSession', session.id)">⌫</button>
            </span>
          </article>
          <p v-if="filteredSessions.length === 0" class="empty-state">No sessions</p>
        </div>
      </div>
    </div>
    <div v-if="renamingSession" class="modal-backdrop" role="presentation" @click.self="closeRenameSessionDialog">
      <form class="modal rename-modal" role="dialog" aria-modal="true" aria-label="编辑会话名称" @submit.prevent="submitRenameSession">
        <div class="modal-head">
          <div>
            <strong>编辑会话名称</strong>
            <span>{{ renamingSession.name || 'Untitled' }}</span>
          </div>
          <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="closeRenameSessionDialog">×</button>
        </div>
        <label class="rename-field">
          <span>会话名称</span>
          <input v-model="sessionNameDraft" autofocus maxlength="80" placeholder="输入会话名称" />
        </label>
        <div class="modal-actions">
          <button class="text-button" type="button" @click="closeRenameSessionDialog">取消</button>
          <button class="text-button" type="submit" :disabled="!sessionNameDraft.trim()">保存</button>
        </div>
      </form>
    </div>
    <div class="context-strip">
      <span class="chip">AI {{ selectedConfigId }}</span>
      <span class="chip">terminal {{ terminalSnapshot.length }} chars</span>
      <span class="chip">history {{ Math.min(commandHistory.length, MAX_AI_COMMAND_HISTORY) }}/{{ commandHistory.length }}</span>
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
        :class="{ ai: message.role === 'assistant', error: message.error, collapsed: isMessageCollapsed(message) }"
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
                  v-if="isShellLanguage(part.language) && normalizeShellCommand(part.content)"
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
    <div class="assistant-compose" @pointerdown="focusComposer">
      <div v-if="selectedTerminalContext" class="selected-terminal-note">
        <strong>选中终端内容</strong>
        <span>{{ formatSelectedLineRange(selectedTerminalContext) }} · {{ selectedTerminalContext.text.length }} chars</span>
      </div>
      <textarea
        ref="composerInput"
        v-model="askText"
        :disabled="!hasUsableConfig"
        rows="4"
        :placeholder="composerPlaceholder"
        :title="composerPlaceholder"
        aria-label="Ask AI"
        @focus="historyOpen = false"
        @keydown="handleComposerKeydown"
      />
      <button
        class="icon-button"
        :title="isAsking ? '停止回答' : 'Ctrl+Enter / ⌘+Enter 发送'"
        :aria-label="isAsking ? '停止回答' : '发送'"
        :disabled="!isAsking && !hasUsableConfig"
        @click="isAsking ? stopCurrentAnswer() : sendMessage()"
      >
        {{ isAsking ? '■' : '→' }}
      </button>
    </div>
  </section>
</template>
