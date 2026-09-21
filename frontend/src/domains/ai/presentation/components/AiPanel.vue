<script setup lang="ts">
import { useAgentSession } from '../../application/useAgentSession'
import { useAiChat } from '../../application/useAiChat'
import { useAiAnswerState } from '../../application/useAiAnswerState'
import { useAiConversationContext } from '../../application/useAiConversationContext'
import { MAX_AI_COMMAND_HISTORY, formatSelectedLineRange, createMessage, formatAiError, isSensitiveAgentCommand, formatSessionDisplayTitle } from '../../domain/aiConversation'
import type { AiPanelProps, AiPanelEvents } from '../../domain/aiPanel'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import type { AiMessage, WorkspaceSession } from '../../domain/conversation'
import type { AiMessageUsage } from '../../domain/tokenUsage'
import { formatMessageUsageLabel, formatMessageUsageTitle, mergeMessageUsage } from '../../domain/tokenUsage'

import { chatWithAiProviderStream, onAiChatStream } from '../../infrastructure/api'


import { isSensitiveCommand } from '../../../../shared/security/commandPrivacy'



import type { AiPanelMode } from '../../domain/agent'
import { analyzeScriptRisks, buildScriptRiskPreviewLines, riskLabelsForLine, summarizeScriptRisks } from '../../../../shared/security/scriptRisk'

import { aiStreamPartialText } from '../../domain/aiStreamError'

import AiMarkdownMessage from './messages/AiMarkdownMessage.vue'
import AiErrorNotice from './messages/AiErrorNotice.vue'
import AgentStepCard from './messages/AgentStepCard.vue'
import AiMessageItem from './messages/AiMessageItem.vue'
import UiIcon from '../../../../shared/ui/UiIcon.vue'


const LONG_MESSAGE_CHARS = 1400
const LONG_MESSAGE_LINES = 18

const props = defineProps<AiPanelProps>()

const emit = defineEmits<AiPanelEvents>()

// A terminal's unsent context must never become another session's question.
const composerDrafts = ref<Record<string, string>>({})
const composerContextKey = computed(() => JSON.stringify([props.workspaceSessionId, props.connectionId, props.terminalId]))
const askText = computed({
  get: () => composerDrafts.value[composerContextKey.value] ?? '',
  set: (value: string) => { composerDrafts.value[composerContextKey.value] = value }
})
const answerState = useAiAnswerState()
const { isAsking, currentAssistantMessageId, answerElapsedSeconds, stopAnswerTimer, messageAnswerDuration, formatAnswerDuration } = answerState
const conversationContext = useAiConversationContext(props, emit)
const { currentRequestId, stopRequested, runChatTurn, stopCurrentAnswer } = useAiChat({ props, emit, answerState, conversationContext })
const { aiCommandHistory, conversationContextParts, maybeGenerateSessionTitle, maybeCompactConversation } = conversationContext
const collapsedMessages = ref<Record<string, boolean>>({})
const messageList = ref<HTMLElement | null>(null)
const followingLatest = ref(true)
const hasNewContent = ref(false)
const messageContent = ref<HTMLElement | null>(null)
let contentResizeObserver: ResizeObserver | undefined
const historyPopover = ref<HTMLElement | null>(null)
const historyButton = ref<HTMLButtonElement | null>(null)
const composerInput = ref<HTMLTextAreaElement | null>(null)
const historyOpen = ref(false)
const sessionSearch = ref('')
const contextOpen = ref(false)
const renamingSession = ref<WorkspaceSession | null>(null)
const sessionNameDraft = ref('')
const pendingAiCommandExecution = ref('')
const pendingAiCommandSourceConnectionId = ref('')
const pendingAgentRiskReview = ref(false)
const { agentTaskPending, agentRun, agentRunMessageId, agentStreamText, agentModeNotice, agentPreparing, agentHighRiskArmed, agentApprovalSaving, agentPendingApproval, agentPendingTimeout, agentNowMs, agentRunActive, stopAgentRun, agentStatusFromRun, proposalHasHighRisk, resolveAgentApproval, resolveAgentTimeout, isAwaitingApprovalStep, isAwaitingTimeoutStep, agentRunStatusLabel, messageHasAgentBody, persistableAgentSteps, ensureAgentReady, currentAgentTarget, prepareAgentAction, startAgentTask, runAgentTurn, agentTargetIsCurrent, cancelAgentPreparation } = useAgentSession({
  props, emit, askText, pendingAgentRiskReview, answerState, conversationContext,
  canSendMessage: () => canSendMessage.value,
  composerBusy: () => composerBusy.value,
  selectedTerminalContext: () => selectedTerminalContext.value,
  scrollMessagesToLatest, closeAiCommandRiskConfirm
})
const aiRiskExplanation = ref('')
const aiRiskExplanationError = ref('')
const aiRiskExplanationLoading = ref(false)
const aiRiskExplanationRequestId = ref('')
const aiCommandExecutionNotice = ref('')
const aiCommandExecutionNoticeTitle = ref('')
let aiCommandNoticeTimer: number | undefined

const pendingAiCommandRisks = computed(() => analyzeScriptRisks(pendingAiCommandExecution.value))
const aiCommandRiskConfirmOpen = computed(() => pendingAiCommandExecution.value.trim().length > 0)
const pendingAiCommandRiskSummary = computed(() => summarizeScriptRisks(pendingAiCommandRisks.value))
const pendingAiCommandRiskLines = computed(() => buildScriptRiskPreviewLines(pendingAiCommandExecution.value, pendingAiCommandRisks.value))
const pendingAiCommandSensitive = computed(() => isSensitiveAgentCommand(pendingAiCommandExecution.value))
const pendingAiCommandCrossConnection = computed(() => {
  return executionTargetsDifferFromSource(pendingAiCommandSourceConnectionId.value)
})
const agentRiskReviewOpen = computed(() => pendingAgentRiskReview.value && Boolean(agentPendingApproval.value))
const pendingAiCommandDialogTitle = computed(() => {
  if (agentRiskReviewOpen.value) return '确认 Agent 风险命令'
  if (pendingAiCommandCrossConnection.value && pendingAiCommandRisks.value.length) return '确认跨连接风险命令'
  if (pendingAiCommandCrossConnection.value) return '确认跨连接执行'
  return '检测到风险命令'
})
const pendingAiCommandDialogDescription = computed(() => {
  if (agentRiskReviewOpen.value) return 'Agent 提议执行以下命令，请检查风险和目标后再继续。'
  if (pendingAiCommandCrossConnection.value) return '命令生成时的连接与当前执行目标不同，请核对来源和目标。'
  return '执行前请确认命中的命令行'
})

const hasUsableConfig = computed(() => {
  return Boolean(props.config.baseUrl.trim() && props.config.model.trim() && (props.config.apiKey?.trim() || props.apiKey.trim()))
})
const canSendMessage = computed(() => hasUsableConfig.value && Boolean(props.workspaceSessionId))

const activeSession = computed(() => {
  return props.workspaceSessions.find((session) => session.id === props.workspaceSessionId)
})

const panelMode = computed<AiPanelMode>(() => (activeSession.value?.aiMode === 'agent' ? 'agent' : 'chat'))
const composerBusy = computed(() => agentPreparing.value || isAsking.value || agentRunActive.value)
const activeAnswer = computed(() => props.messages.find(message => message.id === currentAssistantMessageId.value))
const needsAgentDecision = computed(() => Boolean(agentPendingApproval.value || agentPendingTimeout.value) && !agentApprovalSaving.value)
const activityLabel = computed(() => {
  if (agentPreparing.value) return '正在检查终端'
  if (agentApprovalSaving.value) return '正在保存授权'
  if (agentPendingApproval.value) return '等待确认命令'
  if (agentPendingTimeout.value) return '等待超时处理'
  if (agentRunActive.value) {
    if (agentRun.value?.status === 'executing') return '正在执行命令'
    return agentRun.value?.steps.length ? '正在分析执行结果' : '正在规划任务'
  }
  return activeAnswer.value?.text ? '正在回复' : '正在思考'
})
const activityStepLabel = computed(() => {
  const steps = agentRun.value?.steps
  if (!agentRunActive.value || !steps?.length) return ''
  const current = steps.findIndex(step => step.status === 'running' || step.status === 'pending')
  return current >= 0 ? `第 ${current + 1} 步` : `已执行 ${steps.filter(step => step.status === 'completed').length} 步`
})

const composerPlaceholder = computed(() => {
  if (!props.workspaceSessionId) return '正在载入全局 AI 会话...'
  if (!hasUsableConfig.value) return '选择或配置模型'
  if (panelMode.value === 'agent') return '描述任务目标...'
  return '输入问题'
})

const activeSessionTitle = computed(() => formatSessionDisplayTitle(activeSession.value?.name))
const currentConnectionLabel = computed(() => connectionLabel(props.connectionId))

const selectedTerminalContext = computed(() => {
  const selection = props.terminalSelection
  if (!selection?.text.trim()) return undefined
  return selection
})

const aiModelLabel = computed(() => props.config.model.trim() || props.selectedConfigId || '未选择模型')
const aiEligibleHistoryCount = computed(() => props.commandHistory.filter((entry) => !isSensitiveCommand(entry.command)).length)
const aiContextHistoryCount = computed(() => Math.min(aiEligibleHistoryCount.value, MAX_AI_COMMAND_HISTORY))
const modelOptions = computed(() => props.configs?.length ? props.configs : [props.config])
const contextSummaryLabel = computed(() => {
  const selected = selectedTerminalContext.value ? ` · 选中 ${formatCharacterCount(selectedTerminalContext.value.text.length)}` : ''
  return `${currentConnectionLabel.value} · 上下文 ${formatCharacterCount(props.terminalSnapshot.length)} · ${aiContextHistoryCount.value} 条命令${selected}`
})
const contextStatusLabel = computed(() => {
  if (!props.contextStatus) return '未压缩'
  const chars = formatCharacterCount(props.contextStatus.chars)
  return props.contextStatus.compressed ? `已压缩至 ${chars}` : `完整上下文 ${chars}`
})
// 本会话累计用量:只把网关上报过用量的消息加起来,看不到的不估算
const sessionUsage = computed(() => props.messages.reduce<AiMessageUsage | undefined>(
  (total, message) => mergeMessageUsage(total, message.usage),
  undefined
))

const compactedConversationCount = computed(() => {
  const { summary, eligibleCount, unsummarized } = conversationContextParts(props.workspaceSessionId)
  if (!summary) return 0
  return Math.max(0, eligibleCount - unsummarized.length)
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
    return `${session.name} ${session.summary} ${sessionSourceLabel(session)}`.toLowerCase().includes(keyword)
  })
})

function connectionLabel(connectionId: string) {
  return props.connectionLabels[connectionId] || connectionId || '未知连接'
}

function messageSourceLabel(message: AiMessage) {
  return connectionLabel(message.connectionId)
}

function sessionSourceLabel(session: WorkspaceSession) {
  return connectionLabel(session.connectionId)
}

function executionTargetsDifferFromSource(sourceConnectionId: string) {
  if (!sourceConnectionId) return false
  const targetConnectionIds = props.executionTargetConnectionIds.length
    ? props.executionTargetConnectionIds
    : [props.connectionId]
  return targetConnectionIds.some((connectionId) => connectionId !== sourceConnectionId)
}

function formatCharacterCount(count: number) {
  return `${Math.max(0, count).toLocaleString('zh-CN')} 字符`
}

async function sendMessage() {
  const text = askText.value.trim()
  if (!text || !canSendMessage.value) return
  if (panelMode.value === 'agent') return
  const requestTerminalId = props.terminalId
  const requestConnectionId = props.connectionId
  const requestWorkspaceSessionId = props.workspaceSessionId
  const selectedContext = selectedTerminalContext.value
  const userMessageText = selectedContext
    ? `${text}\n\n选中终端内容：${formatSelectedLineRange(selectedContext)}（已加入上下文）`
    : text
  const userMessage = createMessage(requestConnectionId, requestWorkspaceSessionId, requestTerminalId, 'user', userMessageText)
  emit('appendMessage', userMessage)
  const assistantMessage = createMessage(requestConnectionId, requestWorkspaceSessionId, requestTerminalId, 'assistant', '', '', false, true)
  emit('appendMessage', assistantMessage)
  askText.value = ''
  scrollMessagesToLatest()
  await runChatTurn(assistantMessage, text, selectedContext, userMessage.id)
}

function stopActiveAiWork() {
  if (agentPreparing.value) cancelAgentPreparation()
  if (agentRunActive.value || agentTaskPending()) stopAgentRun()
  else if (isAsking.value) stopCurrentAnswer()
}

function selectPanelMode(mode: AiPanelMode) {
  if (mode === panelMode.value || composerBusy.value || !props.workspaceSessionId) return
  agentModeNotice.value = mode === 'agent' ? (props.agentAvailabilityCheck?.() ?? '') : ''
  emit('setSessionMode', props.workspaceSessionId, mode)
  // 无语义标记的终端要跑一次哨兵探针才能给出结论;结果回来再更新提示
  if (mode === 'agent' && !agentModeNotice.value && props.agentAvailabilityConfirm) {
    const confirmedFor = props.workspaceSessionId
    void props.agentAvailabilityConfirm()
      .then((notice) => {
        if (panelMode.value === 'agent' && props.workspaceSessionId === confirmedFor) {
          agentModeNotice.value = notice
        }
      })
      .catch((error) => {
        if (panelMode.value === 'agent' && props.workspaceSessionId === confirmedFor) {
          agentModeNotice.value = `Agent 启动检查失败:${formatAiError(error)}`
        }
      })
  }
}

function composerPrimaryAction() {
  if (composerBusy.value) return stopActiveAiWork()
  if (panelMode.value === 'agent') return void startAgentTask()
  return void sendMessage()
}

/** 用户消息里附带的选中范围备注,重试时要剥掉才能拿回原始提问。 */
const SELECTED_CONTEXT_NOTE = /\n\n选中终端内容：[^\n]*（已加入上下文）$/

/** 找到某条助手消息对应的提问(它上面最近的一条用户消息)。 */
function pairedUserMessage(message: AiMessage) {
  const index = props.messages.findIndex((item) => item.id === message.id)
  if (index < 0) return undefined
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = props.messages[cursor]
    if (candidate.role === 'user' && candidate.text.trim()) return candidate
  }
  return undefined
}

/** 重试按钮不可用时的原因;返回空串表示可以重试。 */
function retryBlockedReason(message: AiMessage) {
  if (!message.error) return '这条消息没有失败'
  if (composerBusy.value) return '当前还有请求在进行,稍后再试'
  if (!canSendMessage.value) return '当前没有可用的 AI 配置'
  if (message.workspaceSessionId !== props.workspaceSessionId) return '该消息不属于当前会话'
  if (message.connectionId !== props.connectionId) return '已切换到其它连接,请切回原连接后重试'
  if (message.terminalId !== props.terminalId) return '已切换到其它终端,请切回任务原终端后重试'
  if (
    message.mode === 'agent' &&
    message.terminalConnectionGeneration !== undefined &&
    message.terminalConnectionGeneration !== props.terminalConnectionGeneration
  ) {
    return '原终端已经重新连接,为避免重复或误执行命令,请重新发起任务'
  }
  if (!pairedUserMessage(message)) return '找不到对应的提问,无法重试'
  return ''
}

function canRetryMessage(message: AiMessage) {
  return retryBlockedReason(message) === ''
}

function failedAgentStep(message: AiMessage) {
  if (message.mode !== 'agent') return undefined
  const steps = message.agentSteps ?? []
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index].status === 'failed') return steps[index]
  }
  return undefined
}

function retryButtonLabel(message: AiMessage) {
  return failedAgentStep(message) ? '重试命令' : '重试请求'
}

function retryButtonTitle(message: AiMessage) {
  const step = failedAgentStep(message)
  return step
    ? `重新执行失败命令：${step.command}`
    : '用同一个问题重新请求，替换这条失败回复'
}

/**
 * 原地重试:复用同一条助手消息重新发起请求,成功后直接替换掉错误卡片,
 * 不会在对话里追加一条重复的提问。
 */
async function retryMessage(message: AiMessage) {
  if (!canRetryMessage(message)) return
  const userMessage = pairedUserMessage(message)
  if (!userMessage) return
  const question = userMessage.text.replace(SELECTED_CONTEXT_NOTE, '').trim()
  if (!question) return
  const agentMode = message.mode === 'agent'
  if (agentMode) {
    const target = currentAgentTarget()
    const prepared = await prepareAgentAction(target)
    if (prepared.cancelled) return
    if (prepared.blocked) {
      agentModeNotice.value = prepared.blocked
      return
    }
    agentModeNotice.value = ''
  }

  // 先把消息打回进行中:streaming 的更新只改内存不落库,重试的终态会覆盖原来的错误行
  // Agent 模式:工具执行失败时先重跑失败命令;模型请求失败时才重新请求模型
  const retryStep = agentMode ? failedAgentStep(message) : undefined
  const completedSteps = agentMode && message.agentSteps
    ? message.agentSteps.filter(s => s.status === 'completed' || s.status === 'skipped')
    : []
  const pending: AiMessage = {
    ...message,
    text: '',
    command: '',
    error: false,
    errorKind: undefined,
    stopReason: undefined,
    streaming: true,
    agentSteps: agentMode ? completedSteps : undefined,
    agentStatus: agentMode ? 'running' : undefined,
    payloadJson: undefined
  }
  emit('updateMessage', pending)
  scrollMessagesToLatest()

  // 选中内容是实时的:仍然选中就沿用,已经取消则本次不带终端片段
  const selectedContext = selectedTerminalContext.value
  if (agentMode) await runAgentTurn(pending, question, selectedContext, userMessage.id, retryStep)
  else await runChatTurn(pending, question, selectedContext, userMessage.id)
}

function handleComposerKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter') return
  if (event.isComposing) return
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault()
    if (composerBusy.value) return
    if (panelMode.value === 'agent') void startAgentTask()
    else void sendMessage()
  }
}

function focusComposer() {
  historyOpen.value = false
  if (!canSendMessage.value) return
  void nextTick(() => {
    composerInput.value?.focus()
  })
}

function scrollMessagesToLatest() {
  followingLatest.value = true
  hasNewContent.value = false
  followMessageContent()
}

function handleMessageScroll() {
  const list = messageList.value
  if (!list) return
  followingLatest.value = list.scrollHeight - list.scrollTop - list.clientHeight < 48
  if (followingLatest.value) hasNewContent.value = false
}

function followMessageContent() {
  void nextTick(() => {
    requestAnimationFrame(() => {
      const list = messageList.value
      if (!list || !followingLatest.value) return
      list.scrollTop = list.scrollHeight
    })
  })
}

function resizeComposer() {
  const input = composerInput.value
  if (!input) return
  input.style.height = 'auto'
  input.style.height = `${Math.min(144, Math.max(56, input.scrollHeight))}px`
}

function revealActiveStep() {
  const stepId = agentPendingApproval.value?.proposal.id || agentPendingTimeout.value?.step.id
  const step = Array.from(messageList.value?.querySelectorAll<HTMLElement>('[data-step-id]') ?? [])
    .find(element => element.dataset.stepId === stepId)
  if (!step) return scrollMessagesToLatest()
  step.scrollIntoView({ block: 'start', behavior: 'instant' })
  step.querySelector<HTMLButtonElement>('.tool-step-decision button:not(:disabled)')?.focus({ preventScroll: true })
}

function stepOwnsError(message: AiMessage) {
  return Boolean(message.error && failedAgentStep(message) && (!message.errorKind || message.errorKind === 'tool'))
}

function taskSummary(message: AiMessage) {
  if (!message.agentStatus || message.agentStatus === 'running') return ''
  if (!message.agentSteps?.length && message.agentStatus === 'done') return ''
  const label = message.agentStatus === 'done' ? '任务已结束' : message.agentStatus === 'stopped' ? '任务已停止' : '任务中断'
  return `${label}${message.agentSteps?.length ? ` · ${message.agentSteps.length} 个步骤` : ''}`
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
      commandHistory: aiCommandHistory(),
      conversationMessages: []
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

function executeGeneratedCommand(command: string, message?: AiMessage) {
  const value = command.trim()
  if (!value) return
  const risks = analyzeScriptRisks(value)
  const sourceConnectionId = message?.connectionId || props.connectionId
  if (risks.length > 0 || isSensitiveAgentCommand(value) || executionTargetsDifferFromSource(sourceConnectionId)) {
    pendingAiCommandExecution.value = value
    pendingAiCommandSourceConnectionId.value = sourceConnectionId
    clearAiRiskExplanation()
    clearAiCommandNotice()
    return
  }
  emit('executeCommand', value)
  showAiCommandNotice('已安全发送', `未检测到风险命令，已发送到${props.executionTargetLabel}。`)
}

function openAgentRiskReview() {
  const pending = agentPendingApproval.value
  if (!pending || (!pending.proposal.risks.length && !pending.proposal.sensitive)) return
  pendingAgentRiskReview.value = true
  pendingAiCommandExecution.value = pending.proposal.command
  pendingAiCommandSourceConnectionId.value = props.messages.find((message) => message.id === agentRunMessageId.value)?.connectionId || props.connectionId
  clearAiRiskExplanation()
  clearAiCommandNotice()
}

function skipAgentRiskReview() {
  if (!agentRiskReviewOpen.value) return
  resolveAgentApproval('skip')
  closeAiCommandRiskConfirm()
}

function stopAgentRiskReview() {
  if (!agentRiskReviewOpen.value) return
  resolveAgentApproval('stop')
  closeAiCommandRiskConfirm()
}

function confirmPendingAiCommandExecution() {
  const command = pendingAiCommandExecution.value.trim()
  if (!command) return
  if (agentRiskReviewOpen.value) {
    resolveAgentApproval('execute', true)
    closeAiCommandRiskConfirm()
    return
  }
  emit('executeCommand', command)
  showAiCommandNotice('已确认发送', `已确认来源、风险与目标，命令已发送到${props.executionTargetLabel}。`)
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
  pendingAiCommandSourceConnectionId.value = ''
  pendingAgentRiskReview.value = false
  clearAiRiskExplanation()
}
function toggleHistory() {
  historyOpen.value = !historyOpen.value
  if (historyOpen.value) void nextTick(() => historyPopover.value?.querySelector('input')?.focus())
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
  if (sessionId !== props.workspaceSessionId && composerBusy.value) stopActiveAiWork()
  emit('selectSession', sessionId)
  historyOpen.value = false
}

function createSession() {
  if (composerBusy.value) stopActiveAiWork()
  emit('createSession')
  historyOpen.value = false
}

function deleteSession(sessionId: string) {
  if (sessionId === props.workspaceSessionId && composerBusy.value) stopActiveAiWork()
  emit('deleteSession', sessionId)
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
  () => props.messages.map((message) => `${message.id}:${message.text.length}:${message.streaming ? '1' : '0'}:${message.agentSteps?.map(step => `${step.status}:${step.output?.length}`).join(',')}`).join('|'),
  () => {
    if (!followingLatest.value) hasNewContent.value = true
    followMessageContent()
  },
  { flush: 'post' }
)

watch(() => props.workspaceSessionId, scrollMessagesToLatest, { flush: 'post' })
watch(askText, resizeComposer, { flush: 'post' })

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointerDown, true)
  contentResizeObserver = new ResizeObserver(() => {
    // A completed step may grow when expanded. Keep the AI header anchored; only
    // active streaming/agent runs should follow the newest content.
    if (isAsking.value || agentRunActive.value) followMessageContent()
  })
  if (messageContent.value) contentResizeObserver.observe(messageContent.value)
  scrollMessagesToLatest()
  resizeComposer()
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown, true)
  contentResizeObserver?.disconnect()
  if (aiCommandNoticeTimer) window.clearTimeout(aiCommandNoticeTimer)
  stopAnswerTimer()
})

watch(
  () => canSendMessage.value,
  (usable, wasUsable) => {
    if (usable && !wasUsable) focusComposer()
  },
  { flush: 'post' }
)
</script>

<template>
  <section class="assistant-panel ai-chat-panel">
    <div class="chat-head">
      <strong class="chat-session-title" :title="activeSessionTitle">{{ activeSessionTitle }}</strong>
      <div class="chat-head-actions">
        <button ref="historyButton" class="chat-icon" type="button" title="会话列表" aria-label="会话列表" :aria-expanded="historyOpen" @click="toggleHistory"><UiIcon name="history" /></button>
        <button class="chat-icon" type="button" title="新建会话" aria-label="新建会话" @click="createSession"><UiIcon name="plus" /></button>
      </div>
      <div v-if="historyOpen" ref="historyPopover" class="session-history-popover" @keydown.esc.stop="historyOpen = false; historyButton?.focus()">
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
              <strong>{{ formatSessionDisplayTitle(session.name) }}</strong>
              <small>{{ session.summary ? `${session.summary} · 来源 ${sessionSourceLabel(session)}` : `来源 · ${sessionSourceLabel(session)}` }}</small>
            </span>
            <span class="session-history-time">{{ sessionTimeLabel(session) }}</span>
            <span class="session-history-actions">
              <button class="icon-button" type="button" title="编辑会话" aria-label="编辑会话" @click.stop="openRenameSessionDialog(session)"><UiIcon name="edit" /></button>
              <button class="icon-button danger" type="button" title="删除会话" aria-label="删除会话" @click.stop="deleteSession(session.id)"><UiIcon name="trash" /></button>
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
      <section class="modal script-risk-modal" :class="{ 'agent-risk-modal': agentRiskReviewOpen }" role="dialog" aria-modal="true" :aria-label="pendingAiCommandDialogTitle">
        <div class="modal-head">
          <div>
            <strong>{{ pendingAiCommandDialogTitle }}</strong>
            <span>{{ pendingAiCommandDialogDescription }}</span>
          </div>
          <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="closeAiCommandRiskConfirm"><UiIcon name="close" /></button>
        </div>
        <div class="script-risk-body">
          <div v-if="pendingAiCommandCrossConnection && !agentRiskReviewOpen" class="script-risk-ai" role="note" aria-label="命令来源与当前目标">
            <div>
              <strong>命令来源：{{ connectionLabel(pendingAiCommandSourceConnectionId) }}</strong>
              <span :title="executionTargetTitle">当前目标：{{ executionTargetLabel }}</span>
            </div>
          </div>
          <div v-if="pendingAiCommandRiskSummary.length" class="script-risk-summary" aria-label="风险类型">
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
          <div v-if="pendingAiCommandSensitive" class="script-risk-sensitive" role="note">
            <UiIcon name="shield" size="14" />
            <span>该命令包含敏感路径或数据，请确认命令中没有不应暴露或执行的内容。</span>
          </div>
          <div v-if="pendingAiCommandRisks.length || pendingAiCommandSensitive" class="script-risk-ai">
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
                <span>{{ pendingAiCommandRisks.length ? '风险行已标记，执行前请逐行核对。' : '请核对命令内容与当前执行目标。' }}</span>
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
          <span class="script-risk-action-hint" :title="executionTargetTitle">{{ agentRiskReviewOpen ? '确认后继续 Agent 任务，并在当前终端执行' : `确认后发送到：${executionTargetLabel}` }}</span>
          <button class="text-button" type="button" @click="closeAiCommandRiskConfirm">取消</button>
          <template v-if="agentRiskReviewOpen">
            <button class="text-button" type="button" @click="skipAgentRiskReview">跳过命令</button>
            <button class="text-button danger" type="button" @click="stopAgentRiskReview">停止任务</button>
          </template>
          <button class="text-button danger" type="button" @click="confirmPendingAiCommandExecution">确认执行</button>
        </div>
      </section>
    </div>
    <div class="chat-context" :class="{ expanded: contextOpen }">
      <div class="chat-context-main">
        <span class="chat-target" :title="executionTargetTitle || currentConnectionLabel"><UiIcon name="terminal" size="13" /><span>{{ executionTargetLabel || currentConnectionLabel }}</span></span>
        <button class="chat-context-toggle" type="button" :title="contextSummaryLabel" :aria-expanded="contextOpen" @click="contextOpen = !contextOpen">
          <span>上下文 {{ terminalSnapshot.length.toLocaleString('zh-CN') }} 字符</span>
          <UiIcon :name="contextOpen ? 'arrow-up' : 'arrow-down'" size="12" />
        </button>
      </div>
      <p v-if="aiCommandExecutionNotice" class="chat-inline-notice" role="status" :title="aiCommandExecutionNoticeTitle">{{ aiCommandExecutionNotice }}</p>
      <div v-if="contextOpen" class="chat-context-detail">
        <span><strong>终端</strong>{{ formatCharacterCount(terminalSnapshot.length) }}</span>
        <span><strong>命令历史</strong>{{ aiContextHistoryCount }}/{{ aiEligibleHistoryCount }} 条</span>
        <span><strong>选中内容</strong>{{ selectedTerminalContext ? formatCharacterCount(selectedTerminalContext.text.length) : '未加入' }}</span>
        <span><strong>上下文</strong>{{ contextStatusLabel }}</span>
        <span v-if="sessionUsage" :title="formatMessageUsageTitle(sessionUsage)"><strong>Token</strong>{{ formatMessageUsageLabel(sessionUsage) }} · {{ sessionUsage.requests }} 次请求</span>
        <span v-if="compactedConversationCount > 0" title="更早的对话已由 AI 压缩为摘要，并继续作为背景提供给模型"><strong>历史压缩</strong>{{ compactedConversationCount }} 条早期消息已并入摘要</span>
      </div>
    </div>
    <div class="chat-viewport">
    <div ref="messageList" class="chat-message-list" tabindex="0" aria-label="对话记录" @scroll="handleMessageScroll">
    <div ref="messageContent" class="chat-message-content">
      <div v-if="!hasUsableConfig" class="chat-empty">
        <UiIcon name="settings" size="24" />
        <span>尚未配置模型</span>
        <button class="chat-button" type="button" @click="emit('configureAi')">配置模型</button>
      </div>
      <div v-else-if="messages.length === 0" class="chat-empty"><UiIcon name="ai" size="24" /><span>新对话</span></div>
      <AiMessageItem
        v-for="message in messages"
        :key="message.id"
        :message="message"
        :source="messageSourceLabel(message)"
        :duration="messageAnswerDuration(message) ? formatAnswerDuration(messageAnswerDuration(message)) : ''"
      >
          <div v-if="message.streaming" class="chat-progress">
            <span class="chat-progress-dot" />
            {{ message.id === currentAssistantMessageId ? activityLabel : message.mode === 'agent' ? '任务执行中' : message.text ? '正在回复' : '正在思考' }} · {{ formatAnswerDuration(messageAnswerDuration(message)) }}
          </div>
          <div v-if="message.mode === 'agent' && message.agentSteps?.length" class="chat-tool-steps">
            <AgentStepCard
              v-for="step in message.agentSteps ?? []"
              :key="step.id"
              :step="step"
              :awaiting-approval="isAwaitingApprovalStep(message, step)"
              :approval-saving="isAwaitingApprovalStep(message, step) && agentApprovalSaving"
              :awaiting-timeout="isAwaitingTimeoutStep(message, step)"
              :proposal="agentPendingApproval?.proposal"
              :timeout-info="agentPendingTimeout?.info"
              :now-ms="agentNowMs"
              :high-risk-armed="agentHighRiskArmed"
              :target-label="messageSourceLabel(message)"
              :failure-detail="stepOwnsError(message) && step.id === failedAgentStep(message)?.id ? message.text : ''"
              :can-retry="stepOwnsError(message) && step.id === failedAgentStep(message)?.id && canRetryMessage(message)"
              :retry-disabled-reason="retryBlockedReason(message)"
              :observation-stopped="message.agentStatus === 'stopped'"
              @execute="resolveAgentApproval('execute')"
              @review-risk="openAgentRiskReview"
              @execute-and-allow="resolveAgentApproval('execute-and-allow')"
              @skip="resolveAgentApproval('skip')"
              @stop="resolveAgentApproval('stop')"
              @wait="resolveAgentTimeout('wait')"
              @timeout-stop="resolveAgentTimeout('stop')"
              @retry="retryMessage(message)"
              @focus-terminal="emit('focusTerminal')"
            />
          </div>
          <p v-if="message.id === agentRunMessageId && agentStreamText && !message.error" class="chat-progress">{{ agentStreamText }}</p>
          <p v-if="taskSummary(message)" class="chat-task-summary">{{ taskSummary(message) }}</p>
          <p v-if="message.stopReason && message.stopReason !== message.text" class="chat-stop-reason">{{ message.stopReason }}</p>
          <template v-if="aiStreamPartialText(message)">
            <p class="chat-inline-notice">回复已中断，已保留收到的内容。</p>
            <AiMarkdownMessage :content="aiStreamPartialText(message)" :interactive-commands="false" />
          </template>
          <AiErrorNotice
            v-if="message.error && !stepOwnsError(message)"
            :detail="message.text"
            :suggested-command="message.mode === 'agent' ? '' : message.command || ''"
            :can-retry="canRetryMessage(message)"
            :retry-disabled-reason="retryBlockedReason(message)"
            :retry-label="retryButtonLabel(message)"
            :retry-title="retryButtonTitle(message)"
            @retry="retryMessage(message)"
            @execute-command="executeGeneratedCommand($event, message)"
          />
          <p v-if="message.text && !message.error && isMessageCollapsed(message)" class="chat-response-preview">{{ message.text.slice(0, 400) }}...</p>
          <AiMarkdownMessage
            v-else-if="message.text && !message.error"
            :content="message.text"
            :interactive-commands="message.role === 'assistant' && message.mode !== 'agent'"
            @execute-command="executeGeneratedCommand($event, message)"
          />
        <div v-if="!message.error && shouldCollapseMessage(message)" class="chat-collapse-footer">
          <button class="chat-text-button" type="button" :aria-expanded="isMessageExpanded(message)" @click="toggleMessage(message.id)">
            <span>{{ isMessageExpanded(message) ? '收起回复' : '展开完整回复' }}</span>
            <UiIcon v-if="isMessageExpanded(message)" name="arrow-up" size="13" />
            <UiIcon v-else name="arrow-down" size="13" />
          </button>
        </div>
      </AiMessageItem>
    </div>
    </div>
    <button v-if="!followingLatest" class="chat-latest chat-icon" type="button" :title="hasNewContent ? '有新内容，回到最新' : '回到最新'" aria-label="回到最新" @click="scrollMessagesToLatest"><UiIcon name="arrow-down" size="16" /></button>
    </div>
    <div class="chat-composer">
      <div v-if="composerBusy" class="chat-activity" :class="{ 'needs-decision': needsAgentDecision }">
        <span class="chat-activity-stage" role="status"><span class="chat-progress-dot" aria-hidden="true" />{{ activityLabel }}</span>
        <span v-if="activityStepLabel" class="chat-activity-step">{{ activityStepLabel }}</span>
        <span v-if="!agentPreparing" class="chat-activity-time" role="timer" aria-live="off" title="本次总耗时，包含执行命令与等待确认">{{ formatAnswerDuration(answerElapsedSeconds) }}</span>
        <button v-if="needsAgentDecision" type="button" class="chat-text-button chat-activity-jump" :aria-label="agentPendingApproval ? '查看待确认命令' : '查看超时命令'" :title="agentPendingApproval ? '查看待确认命令' : '查看超时命令'" @click="revealActiveStep">查看<UiIcon name="arrow-up" size="12" /></button>
      </div>
      <div v-if="selectedTerminalContext" class="chat-selection">
        <UiIcon name="terminal" size="14" />
        <span>{{ formatSelectedLineRange(selectedTerminalContext) }} · {{ formatCharacterCount(selectedTerminalContext.text.length) }}</span>
        <button class="chat-icon" type="button" title="移除选中上下文" aria-label="移除选中上下文" @click="emit('clearSelection')"><UiIcon name="close" size="13" /></button>
      </div>
      <div v-if="panelMode === 'agent' && agentModeNotice" class="chat-mode-notice">{{ agentModeNotice }}</div>
      <div class="chat-input-shell">
      <textarea
        ref="composerInput"
        v-model="askText"
        :disabled="!canSendMessage"
        rows="2"
        :placeholder="composerPlaceholder"
        :title="composerPlaceholder"
        aria-label="询问 AI"
        @focus="historyOpen = false"
        @keydown="handleComposerKeydown"
      />
      <div class="chat-composer-toolbar">
      <div class="chat-mode-switch" role="group" aria-label="AI 模式">
        <button
          type="button"
          :aria-pressed="panelMode === 'chat'"
          :class="{ active: panelMode === 'chat' }"
          :disabled="composerBusy"
          title="普通对话:AI 回答问题并给出可点击执行的命令"
          @click="selectPanelMode('chat')"
        >对话</button>
        <button
          type="button"
          :aria-pressed="panelMode === 'agent'"
          :class="{ active: panelMode === 'agent' }"
          :disabled="composerBusy"
          title="Agent:AI 循环提出命令,经审批在当前终端执行并观察结果"
          @click="selectPanelMode('agent')"
        >Agent</button>
      </div>
      <select class="chat-model-select" :value="selectedConfigId" :disabled="composerBusy" :title="aiModelLabel" aria-label="选择模型" @change="emit('selectConfig', ($event.target as HTMLSelectElement).value)">
        <option v-for="option in modelOptions" :key="option.id" :value="option.id">{{ option.model || option.id }}</option>
      </select>
      <button class="chat-icon" type="button" title="配置模型" aria-label="配置模型" @click="emit('configureAi')"><UiIcon name="settings" size="14" /></button>
      <button
        class="chat-icon chat-send"
        type="button"
        :title="composerBusy ? (agentPreparing || agentRunActive ? '停止任务' : '停止回答') : 'Ctrl+Enter / ⌘+Enter 发送'"
        :aria-label="composerBusy ? '停止' : '发送'"
        :disabled="!composerBusy && (!canSendMessage || !askText.trim())"
        @click="composerPrimaryAction()"
      >
        <UiIcon v-if="composerBusy" name="stop" /><UiIcon v-else name="arrow-up" />
      </button>
      </div>
      </div>
    </div>
  </section>
</template>

<style src="../styles/ai-final.css" scoped></style>
