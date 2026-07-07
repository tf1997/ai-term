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
import { parseMessageParts, type MessagePart } from '../lib/aiMarkdown'
import { looksLikeShellCommand, normalizeShellCommand, shellCommandFromCodeBlock } from '../lib/shellCommand'
import {
  analyzeScriptRisks,
  buildScriptRiskPreviewLines,
  riskLabelsForLine,
  summarizeScriptRisks
} from '../lib/scriptRisk'
import AiMarkdownMessage from './AiMarkdownMessage.vue'
import UiIcon from './UiIcon.vue'


const LONG_MESSAGE_CHARS = 900
const LONG_MESSAGE_LINES = 12
const MAX_SELECTED_TERMINAL_CHARS = 20_000
const MAX_AI_COMMAND_HISTORY = 80
const STREAM_TIMER_INTERVAL_MS = 1000

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
const answerElapsedSeconds = ref(0)
const answerDurations = ref<Record<string, number>>({})
const stopRequested = ref(false)
const contextOpen = ref(false)
const renamingSession = ref<WorkspaceSession | null>(null)
const sessionNameDraft = ref('')
const pendingAiCommandExecution = ref('')
const aiRiskExplanation = ref('')
const aiRiskExplanationError = ref('')
const aiRiskExplanationLoading = ref(false)
const aiRiskExplanationRequestId = ref('')
const aiCommandExecutionNotice = ref('')
const aiCommandExecutionNoticeTitle = ref('')
let aiCommandNoticeTimer: number | undefined
let answerTimer: number | undefined

const pendingAiCommandRisks = computed(() => analyzeScriptRisks(pendingAiCommandExecution.value))
const aiCommandRiskConfirmOpen = computed(() => pendingAiCommandExecution.value.trim().length > 0)
const pendingAiCommandRiskSummary = computed(() => summarizeScriptRisks(pendingAiCommandRisks.value))
const pendingAiCommandRiskLines = computed(() => buildScriptRiskPreviewLines(pendingAiCommandExecution.value, pendingAiCommandRisks.value))

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

const activeSessionTitle = computed(() => activeSession.value?.name?.trim() || '当前会话')

const selectedTerminalContext = computed(() => {
  const selection = props.terminalSelection
  if (!selection?.text.trim()) return undefined
  return selection
})

const aiModelLabel = computed(() => props.config.model.trim() || props.selectedConfigId || '未选择模型')
const aiContextHistoryCount = computed(() => Math.min(props.commandHistory.length, MAX_AI_COMMAND_HISTORY))
const assistantContextSummary = computed(() => `模型 ${aiModelLabel.value}`)
const contextSummaryLabel = computed(() => {
  const selected = selectedTerminalContext.value ? ` · 选中 ${formatCharacterCount(selectedTerminalContext.value.text.length)}` : ''
  return `上下文：${formatCharacterCount(props.terminalSnapshot.length)} · 命令历史 ${aiContextHistoryCount.value} 条${selected}`
})
const contextStatusLabel = computed(() => {
  if (!props.contextStatus) return '未压缩'
  const chars = formatCharacterCount(props.contextStatus.chars)
  return props.contextStatus.compressed ? `已压缩至 ${chars}` : `完整上下文 ${chars}`
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

function formatCharacterCount(count: number) {
  return `${Math.max(0, count).toLocaleString('zh-CN')} 字符`
}

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
  startAnswerTimer()
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
      finishAnswerTimer(assistantMessage.id)
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
  finishAnswerTimer(message?.id ?? currentAssistantMessageId.value)
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

function startAnswerTimer() {
  stopAnswerTimer()
  const startedAt = Date.now()
  answerElapsedSeconds.value = 0
  answerTimer = window.setInterval(() => {
    answerElapsedSeconds.value = Math.floor((Date.now() - startedAt) / 1000)
  }, STREAM_TIMER_INTERVAL_MS)
}

function stopAnswerTimer() {
  if (answerTimer) window.clearInterval(answerTimer)
  answerTimer = undefined
}

function finishAnswerTimer(messageId?: string) {
  const seconds = answerTimer ? Math.max(1, answerElapsedSeconds.value) : answerElapsedSeconds.value
  if (messageId) {
    answerDurations.value = {
      ...answerDurations.value,
      [messageId]: seconds
    }
  }
  stopAnswerTimer()
  answerElapsedSeconds.value = 0
}

function messageAnswerDuration(message: AiMessage) {
  if (message.streaming && message.id === currentAssistantMessageId.value) return answerElapsedSeconds.value
  return answerDurations.value[message.id] ?? 0
}

function formatAnswerDuration(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds))
  if (safeSeconds < 60) return `${safeSeconds} 秒`
  const minutes = Math.floor(safeSeconds / 60)
  const remainder = safeSeconds % 60
  return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分钟`
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
    throw new Error('请在 AI 配置中填写 API Key 并保存到系统凭据管理器')
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
    .find((part) => part.type === 'code' && shellCommandForPart(part))
  if (shellBlock?.type === 'code') return shellCommandForPart(shellBlock)

  const candidate = answer
    .split('\n')
    .map((line) => line.trim())
    .find((line) => looksLikeShellCommand(line))
  return candidate ? normalizeShellCommand(candidate) : ''
}

function shellCommandForPart(part: MessagePart) {
  if (part.type !== 'code') return ''
  return shellCommandFromCodeBlock(part.language, part.content)
}

function buildAiRiskExplanationPrompt(command: string) {
  const riskLines = pendingAiCommandRisks.value
    .map((risk) => `- 第 ${risk.line} 行：${risk.label}（${risk.severity === 'high' ? '高风险' : '中风险'}）${risk.message}；命令：${risk.text.trim()}`)
    .join('\n')
  return [
    '你是 AI Term 的命令安全助手。请用中文解释下面命令为什么存在风险。',
    '要求：',
    '1. 先用 2-4 条说明风险原因。',
    '2. 给出执行前必须确认的目标、路径、服务、权限或备份。',
    '3. 如果可以，给出更安全的替代命令或 dry-run/只读检查方式。',
    '4. 不要替用户确认执行，不要输出夸张恐吓文案。',
    '',
    '风险命中：',
    riskLines || '- 未提供风险摘要',
    '',
    '待执行命令：',
    '```shell',
    command,
    '```'
  ].join('\n')
}

async function explainPendingAiCommandRisk() {
  const command = pendingAiCommandExecution.value.trim()
  if (!command || aiRiskExplanationLoading.value) return
  if (!hasUsableConfig.value) {
    aiRiskExplanationError.value = '暂无可用 AI 配置，请先在左侧设置中心完善配置。'
    return
  }
  const apiKey = props.config.apiKey?.trim() || props.apiKey.trim()
  if (!apiKey) {
    aiRiskExplanationError.value = '请先保存 API Key 后再使用 AI 分析。'
    return
  }
  aiRiskExplanationLoading.value = true
  aiRiskExplanation.value = ''
  aiRiskExplanationError.value = ''
  let streamedAnswer = ''
  let unlisten: (() => void) | undefined
  const requestId = `${props.connectionId}-${props.workspaceSessionId}-${props.terminalId}-risk-${Date.now()}`
  aiRiskExplanationRequestId.value = requestId
  try {
    unlisten = await onAiChatStream(requestId, (event) => {
      if (aiRiskExplanationRequestId.value !== requestId) return
      if (event.kind === 'chunk') {
        streamedAnswer += event.delta
        aiRiskExplanation.value = streamedAnswer
      }
      if (event.kind === 'error' && event.error) {
        aiRiskExplanationError.value = `模型流式调用失败：${event.error}`
      }
    })
    const response = await chatWithAiProviderStream(requestId, {
      config: props.config,
      apiKey,
      question: buildAiRiskExplanationPrompt(command),
      terminalSnapshot: props.terminalSnapshot,
      commandHistory: props.commandHistory.map((entry) => entry.command).slice(-MAX_AI_COMMAND_HISTORY)
    })
    if (aiRiskExplanationRequestId.value !== requestId) return
    aiRiskExplanation.value = (streamedAnswer || response.answer).trim() || 'AI 未返回风险说明。'
  } catch (error) {
    if (aiRiskExplanationRequestId.value !== requestId) return
    aiRiskExplanationError.value = formatAiError(error)
  } finally {
    unlisten?.()
    if (aiRiskExplanationRequestId.value === requestId) {
      aiRiskExplanationLoading.value = false
      aiRiskExplanationRequestId.value = ''
    }
  }
}

function clearAiRiskExplanation() {
  aiRiskExplanation.value = ''
  aiRiskExplanationError.value = ''
  aiRiskExplanationLoading.value = false
  aiRiskExplanationRequestId.value = ''
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
  const risks = analyzeScriptRisks(value)
  if (risks.length > 0) {
    pendingAiCommandExecution.value = value
    clearAiRiskExplanation()
    clearAiCommandNotice()
    return
  }
  emit('executeCommand', value)
  showAiCommandNotice('已安全发送', '未检测到风险命令，已发送到目标终端。')
}
function confirmPendingAiCommandExecution() {
  const command = pendingAiCommandExecution.value.trim()
  if (!command) return
  emit('executeCommand', command)
  showAiCommandNotice('已确认发送', '已确认风险命令，命令已发送到目标终端。')
  closeAiCommandRiskConfirm()
}

function showAiCommandNotice(label: string, title: string) {
  aiCommandExecutionNotice.value = label
  aiCommandExecutionNoticeTitle.value = title
  if (aiCommandNoticeTimer) window.clearTimeout(aiCommandNoticeTimer)
  aiCommandNoticeTimer = window.setTimeout(() => {
    clearAiCommandNotice()
  }, 2600)
}

function clearAiCommandNotice() {
  aiCommandExecutionNotice.value = ''
  aiCommandExecutionNoticeTitle.value = ''
  if (aiCommandNoticeTimer) {
    window.clearTimeout(aiCommandNoticeTimer)
    aiCommandNoticeTimer = undefined
  }
}

function closeAiCommandRiskConfirm() {
  pendingAiCommandExecution.value = ''
  clearAiRiskExplanation()
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
  sessionNameDraft.value = session.name || '当前会话'
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
    if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))} 分钟前`
  if (diff < day) return `${Math.max(1, Math.floor(diff / hour))} 小时前`
  return `${Math.max(1, Math.floor(diff / day))} 天前`
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
  if (aiCommandNoticeTimer) window.clearTimeout(aiCommandNoticeTimer)
  stopAnswerTimer()
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
    <div class="panel-head ai-panel-head">
      <div class="ai-session-head">
        <span class="panel-glyph ai-glyph" aria-hidden="true"><UiIcon name="ai" size="16" /></span>
        <div>
          <strong>{{ activeSessionTitle }}</strong>
          <span>{{ assistantContextSummary }}</span>
        </div>
      </div>
      <div class="panel-actions ai-panel-actions">
        <span v-if="isAsking" class="ai-live-pill">回答中 {{ formatAnswerDuration(answerElapsedSeconds) }}</span>
        <button ref="historyButton" class="icon-button" type="button" title="历史会话" aria-label="历史会话" @click="toggleHistory"><UiIcon name="history" /></button>
        <button class="icon-button" type="button" title="新建会话" aria-label="新建会话" @click="createSession"><UiIcon name="plus" /></button>
      </div>
      <div v-if="historyOpen" ref="historyPopover" class="session-history-popover">
        <div class="session-search">
          <span><UiIcon name="search" size="14" /></span>
          <input v-model="sessionSearch" placeholder="搜索会话..." aria-label="搜索会话" />
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
              <strong>{{ session.name || '当前会话' }}</strong>
              <small v-if="session.summary">{{ session.summary }}</small>
            </span>
            <span class="session-history-time">{{ sessionTimeLabel(session) }}</span>
            <span class="session-history-actions">
              <button class="icon-button" type="button" title="编辑会话" aria-label="编辑会话" @click.stop="openRenameSessionDialog(session)"><UiIcon name="edit" /></button>
              <button class="icon-button danger" type="button" title="删除会话" aria-label="删除会话" @click.stop="emit('deleteSession', session.id)"><UiIcon name="trash" /></button>
            </span>
          </article>
          <p v-if="filteredSessions.length === 0" class="empty-state">暂无会话</p>
        </div>
      </div>
    </div>
    <div v-if="renamingSession" class="modal-backdrop" role="presentation" @click.self="closeRenameSessionDialog">
      <form class="modal rename-modal" role="dialog" aria-modal="true" aria-label="编辑会话名称" @submit.prevent="submitRenameSession">
        <div class="modal-head">
          <div>
            <strong>编辑会话名称</strong>
            <span>{{ renamingSession.name || '当前会话' }}</span>
          </div>
          <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="closeRenameSessionDialog"><UiIcon name="close" /></button>
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
    <div v-if="aiCommandRiskConfirmOpen" class="modal-backdrop script-risk-backdrop" role="presentation">
      <section class="modal script-risk-modal" role="dialog" aria-modal="true" aria-label="危险命令执行确认">
        <div class="modal-head">
          <div>
            <strong>检测到风险命令</strong>
            <span>执行前请确认命中的命令行</span>
          </div>
          <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="closeAiCommandRiskConfirm"><UiIcon name="close" /></button>
        </div>
        <div class="script-risk-body">
          <div class="script-risk-summary" aria-label="风险类型">
            <span
              v-for="risk in pendingAiCommandRiskSummary"
              :key="risk.kind"
              class="script-risk-chip"
              :class="[`risk-${risk.kind}`, risk.severity]"
            >
              <strong>{{ risk.label }}</strong>
              <small>{{ risk.message }}</small>
            </span>
          </div>
          <div class="script-risk-ai">
            <div>
              <strong>不确定原因？</strong>
              <span>让 AI 根据命中的风险行解释影响和执行前检查项。</span>
            </div>
            <button class="text-button" type="button" :disabled="aiRiskExplanationLoading || !hasUsableConfig" @click="explainPendingAiCommandRisk">
              {{ aiRiskExplanationLoading ? '正在分析...' : '借助 AI 分析风险' }}
            </button>
            <div
              v-if="aiRiskExplanationLoading || aiRiskExplanationError || aiRiskExplanation"
              class="script-risk-ai-output"
              :class="{ error: aiRiskExplanationError }"
              aria-live="polite"
            >
              <div v-if="aiRiskExplanationLoading" class="script-risk-thinking">
                <span /><span /><span />AI 正在分析风险...
              </div>
              <p v-if="aiRiskExplanationError">{{ aiRiskExplanationError }}</p>
              <AiMarkdownMessage v-else-if="aiRiskExplanation" :content="aiRiskExplanation" />
              <p v-else class="script-risk-ai-placeholder">正在等待模型首段回复...</p>
            </div>
          </div>
          <div class="script-risk-preview" role="region" aria-label="命令风险预览">
            <div class="script-risk-preview-head">
              <div>
                <strong>命令预览</strong>
                <span>高风险行已标红，执行前请逐行核对。</span>
              </div>
              <span class="script-risk-preview-count">{{ pendingAiCommandRiskLines.length }} 行</span>
            </div>
            <div class="script-risk-lines">
              <div
                v-for="line in pendingAiCommandRiskLines"
                :key="line.number"
                class="script-risk-line"
                :class="[line.riskClass, { flagged: line.risks.length }]"
              >
                <span class="script-risk-line-no">{{ line.number }}</span>
                <code>{{ line.text || ' ' }}</code>
                <span v-if="line.risks.length" class="script-risk-line-label">{{ riskLabelsForLine(line.risks) }}</span>
              </div>
            </div>
          </div>
        </div>
        <div class="modal-actions script-risk-actions">
          <span class="script-risk-action-hint">确认后将发送到当前终端执行。</span>
          <button class="text-button" type="button" @click="closeAiCommandRiskConfirm">取消</button>
          <button class="text-button danger" type="button" @click="confirmPendingAiCommandExecution">确认执行</button>
        </div>
      </section>
    </div>
    <div class="context-strip ai-context-strip" :class="{ expanded: contextOpen }">
      <div class="context-strip-main">
        <button class="context-summary-button" type="button" :aria-expanded="contextOpen" @click="contextOpen = !contextOpen">
          <UiIcon name="database" size="14" />
          <span>{{ contextSummaryLabel }}</span>
          <UiIcon v-if="contextOpen" name="arrow-up" size="14" />
          <UiIcon v-else name="arrow-down" size="14" />
        </button>
        <span v-if="isAsking" class="chip ai-live-status">回答中 {{ formatAnswerDuration(answerElapsedSeconds) }}</span>
        <span v-if="aiCommandExecutionNotice" class="chip command-risk-status risk-safe ai-command-notice" :title="aiCommandExecutionNoticeTitle">{{ aiCommandExecutionNotice }}</span>
      </div>
      <div v-if="contextOpen" class="ai-context-detail">
        <span><strong>终端</strong>{{ formatCharacterCount(terminalSnapshot.length) }}</span>
        <span><strong>命令历史</strong>{{ aiContextHistoryCount }}/{{ commandHistory.length }} 条</span>
        <span><strong>选中内容</strong>{{ selectedTerminalContext ? formatCharacterCount(selectedTerminalContext.text.length) : '未加入' }}</span>
        <span><strong>上下文</strong>{{ contextStatusLabel }}</span>
      </div>
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
          <span class="message-identity">
            <span class="message-avatar">{{ message.role === 'assistant' ? 'AI' : '我' }}</span>
            <strong>
              {{ message.role === 'assistant' ? 'AI' : '我' }}
              <span v-if="message.streaming" class="streaming-dot">等待 {{ formatAnswerDuration(messageAnswerDuration(message)) }}</span>
              <span v-else-if="messageAnswerDuration(message)" class="message-duration">耗时 {{ formatAnswerDuration(messageAnswerDuration(message)) }}</span>
            </strong>
          </span>
        </div>
        <div class="message-body">
          <div v-if="message.streaming && !message.text" class="thinking-row">
            <span />
            <span />
            <span />
            正在回复，已等待 {{ formatAnswerDuration(messageAnswerDuration(message)) }}
          </div>
          <AiMarkdownMessage
            v-if="message.text"
            :content="message.text"
            :interactive-commands="message.role === 'assistant' && !message.error"
            @execute-command="executeGeneratedCommand"
          />
        </div>
        <div v-if="shouldCollapseMessage(message)" class="message-collapse-footer">
          <button class="text-button" type="button" @click="toggleMessage(message.id)">
            <span>{{ isMessageExpanded(message) ? '收起回复' : '展开完整回复' }}</span>
            <UiIcon v-if="isMessageExpanded(message)" name="arrow-up" size="13" />
            <UiIcon v-else name="arrow-down" size="13" />
          </button>
        </div>
      </article>
    </div>
    <div class="assistant-compose" @pointerdown="focusComposer">
      <div v-if="selectedTerminalContext" class="selected-terminal-note">
        <strong>选中终端内容</strong>
        <span>{{ formatSelectedLineRange(selectedTerminalContext) }} · {{ formatCharacterCount(selectedTerminalContext.text.length) }}</span>
      </div>
      <textarea
        ref="composerInput"
        v-model="askText"
        :disabled="!hasUsableConfig"
        rows="3"
        :placeholder="composerPlaceholder"
        :title="composerPlaceholder"
        aria-label="询问 AI"
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
        <UiIcon v-if="isAsking" name="stop" /><UiIcon v-else name="arrow-right" />
      </button>
    </div>
  </section>
</template>
