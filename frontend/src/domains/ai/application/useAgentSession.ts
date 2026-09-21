import { ref, computed, watch, onBeforeUnmount } from 'vue'
import type { Ref } from 'vue'
import type { AiPanelProps, AiPanelEmit } from '../domain/aiPanel'
import type { AiMessage } from '../domain/conversation'
import type { TerminalSelectionEvent } from '../../terminal/types'
import type { AgentApprovalDecision, AgentRunState, AgentStep, AgentStepProposal, AgentTimeoutDecision, AgentTimeoutInfo } from '../domain/agent'
import type { useAiAnswerState } from './useAiAnswerState'
import type { useAiConversationContext } from './useAiConversationContext'
import { runAgentTask } from './agent/agentLoop'
import type { AgentLoopDeps } from './agent/agentLoop'
import { classifyForAutoExec } from '../domain/agentAutoApprove'
import { analyzeScriptRisks } from '../../../shared/security/scriptRisk'
import { createAiStreamErrorMessage } from '../domain/aiStreamError'
import { createAgentRunSnapshot } from '../domain/agentRunSnapshot'
import { mergeMessageUsage } from '../domain/tokenUsage'
import { MAX_AI_CONVERSATION_MESSAGES, buildQuestionWithSelectedTerminalText, formatSelectedLineRange, formatAiError, createMessage, isSensitiveAgentCommand } from '../domain/aiConversation'
import * as tauri from '../infrastructure/api'

interface AgentSessionOptions {
  props: Readonly<AiPanelProps>
  emit: AiPanelEmit
  askText: Ref<string>
  pendingAgentRiskReview: Ref<boolean>
  canSendMessage: () => boolean
  composerBusy: () => boolean
  selectedTerminalContext: () => TerminalSelectionEvent | undefined
  scrollMessagesToLatest: () => void
  closeAiCommandRiskConfirm: () => void
  answerState: ReturnType<typeof useAiAnswerState>
  conversationContext: ReturnType<typeof useAiConversationContext>
}
type AgentSessionSource = Pick<typeof tauri, 'onAiChatStream' | 'cancelTask' | 'aiAgentTurnStream' | 'touchAgentCommandAllowlistEntry'>

/** Retry messages are reactive; unwrap both the step and its nested risk records. */
function snapshotAgentStep(step: AgentStep): AgentStep {
  return { ...step, risks: step.risks.map((risk) => ({ ...risk })) }
}

export function useAgentSession(options: AgentSessionOptions, source: AgentSessionSource = tauri) {
  const { props, emit, askText, pendingAgentRiskReview, canSendMessage, composerBusy, selectedTerminalContext, scrollMessagesToLatest, closeAiCommandRiskConfirm } = options
  const { isAsking, currentAssistantMessageId, startAnswerTimer, finishAnswerTimer, finishAnswerMessage } = options.answerState
  const { aiCommandHistory, conversationContextParts, maybeGenerateSessionTitle, maybeCompactConversation } = options.conversationContext
  const { onAiChatStream, cancelTask, aiAgentTurnStream, touchAgentCommandAllowlistEntry } = source
  // Agent 模式运行态
  const agentRun = ref<AgentRunState | null>(null)

  const agentRunMessageId = ref('')

  const agentStreamText = ref('')

  const agentModeNotice = ref('')

  const agentPreparing = ref(false)

  const agentHighRiskArmed = ref(false)
  const agentApprovalSaving = ref(false)

  const agentPendingApproval = ref<{ proposal: AgentStepProposal; resolve: (decision: AgentApprovalDecision) => void } | null>(null)

  const agentPendingTimeout = ref<{ step: AgentStep; info: AgentTimeoutInfo; resolve: (decision: AgentTimeoutDecision) => void } | null>(null)

  /** 秒级时钟,仅在任务运行期间跳动,驱动步骤卡片的倒计时。 */
  const agentNowMs = ref(Date.now())

  let agentClockTimer: number | undefined

  let agentStopHandle: (() => void) | null = null

  let agentPreparationSequence = 0

  const agentRunActive = computed(() => {
    const status = agentRun.value?.status
    return status === 'calling-model' || status === 'awaiting-approval' || status === 'executing' || status === 'awaiting-user'
  })

  function cancelAgentPreparation() {
    agentPreparationSequence += 1
    agentPreparing.value = false
  }

  function stopAgentRun() {
    agentStopHandle?.()
  }

  function agentStatusFromRun(state: AgentRunState): 'running' | 'done' | 'stopped' | 'error' {
    if (state.status === 'done') return 'done'
    if (state.status === 'stopped') return 'stopped'
    if (state.status === 'error') return 'error'
    return 'running'
  }

  function proposalHasHighRisk(proposal: AgentStepProposal) {
    return proposal.risks.some((risk) => risk.severity === 'high')
  }

  function resolveAgentApproval(decision: AgentApprovalDecision, riskReviewed = false) {
    const pending = agentPendingApproval.value
    if (!pending) return
    if (agentApprovalSaving.value) {
      if (decision === 'stop') stopAgentRun()
      return
    }
    if (decision === 'execute-and-allow') {
      if (pending.proposal.sensitive || pending.proposal.risks.length || !pending.proposal.suggestedPatterns?.length) return
      agentApprovalSaving.value = true
    }
    // 兼容未走风险弹窗的旧入口;弹窗确认会显式传入 riskReviewed。
    if (decision === 'execute' && proposalHasHighRisk(pending.proposal) && !riskReviewed && !agentHighRiskArmed.value) {
      agentHighRiskArmed.value = true
      return
    }
    if (!agentApprovalSaving.value) agentPendingApproval.value = null
    agentHighRiskArmed.value = false
    pending.resolve(decision)
  }

  function resolveAgentTimeout(decision: AgentTimeoutDecision) {
    const pending = agentPendingTimeout.value
    if (!pending) return
    agentPendingTimeout.value = null
    pending.resolve(decision)
  }

  function isAwaitingApprovalStep(message: AiMessage, step: AgentStep) {
    return message.id === agentRunMessageId.value && agentPendingApproval.value?.proposal.id === step.id
  }

  function isAwaitingTimeoutStep(message: AiMessage, step: AgentStep) {
    return message.id === agentRunMessageId.value && agentPendingTimeout.value?.step.id === step.id
  }

  const AGENT_RUN_STATUS_LABELS: Record<NonNullable<AiMessage['agentStatus']>, string> = {
    running: '任务执行中',
    done: '任务完成',
    stopped: '任务已停止',
    error: '任务出错'
  }

  function agentRunStatusLabel(message: AiMessage) {
    return message.agentStatus ? AGENT_RUN_STATUS_LABELS[message.agentStatus] : ''
  }

  function messageHasAgentBody(message: AiMessage) {
    if (message.mode !== 'agent') return false
    if (message.agentSteps?.length) return true
    return message.id === agentRunMessageId.value && Boolean(agentStreamText.value)
  }

  function persistableAgentSteps(steps: AgentStep[]) {
    return steps.map((step) => {
      if (!step.sensitive || !step.output) return step
      return { ...step, output: '[敏感命令输出未存储]' }
    })
  }

  /** Agent 任务的最大命令输出捕获量(回传模型前的截断上限)。 */
  const AGENT_OUTPUT_MAX_CHARS = 4000

  /**
   * Agent 发起前的通道预检。返回空串表示可以开跑,否则是要显示在编辑器上方的提示。
   * 首次发起与原地重试共用,避免重试绕过终端可用性判定。
   */
  async function ensureAgentReady() {
    const availability = props.agentAvailabilityCheck?.() ?? ''
    if (availability) return availability
    // 首次在无标记终端发起任务时,探针在此处兜底(切换模式时可能还没跑完)
    const confirmed = (await props.agentAvailabilityConfirm?.()) ?? ''
    if (confirmed) return confirmed
    if (!props.agentCommandRunner) return 'Agent 执行通道未接入,请更新应用或切回对话模式'
    return ''
  }

  interface AgentPreparationTarget {
    connectionId: string
    workspaceSessionId: string
    terminalId: string
    connectionGeneration: number
  }

  function currentAgentTarget(): AgentPreparationTarget {
    return {
      connectionId: props.connectionId,
      workspaceSessionId: props.workspaceSessionId,
      terminalId: props.terminalId,
      connectionGeneration: props.terminalConnectionGeneration
    }
  }

  function agentTargetIsCurrent(target: AgentPreparationTarget) {
    return target.connectionId === props.connectionId &&
      target.workspaceSessionId === props.workspaceSessionId &&
      target.terminalId === props.terminalId &&
      target.connectionGeneration === props.terminalConnectionGeneration
  }

  async function prepareAgentAction(target: AgentPreparationTarget) {
    const sequence = ++agentPreparationSequence
    agentPreparing.value = true
    try {
      let blocked = ''
      try {
        blocked = await ensureAgentReady()
      } catch (error) {
        blocked = `Agent 启动检查失败:${formatAiError(error)}`
      }
      if (sequence !== agentPreparationSequence || !agentTargetIsCurrent(target)) {
        return { cancelled: true, blocked: '' }
      }
      return { cancelled: false, blocked }
    } finally {
      if (sequence === agentPreparationSequence) agentPreparing.value = false
    }
  }

  async function startAgentTask() {
    const text = askText.value.trim()
    if (!text || !canSendMessage() || composerBusy()) return
    const target = currentAgentTarget()
    const selectedContext = selectedTerminalContext()
    const prepared = await prepareAgentAction(target)
    if (prepared.cancelled) return
    if (prepared.blocked) {
      agentModeNotice.value = prepared.blocked
      return
    }
    agentModeNotice.value = ''

    const userMessageText = selectedContext
      ? `${text}\n\n选中终端内容：${formatSelectedLineRange(selectedContext)}（已加入上下文）`
      : text

    const userMessage = createMessage(target.connectionId, target.workspaceSessionId, target.terminalId, 'user', userMessageText)
    emit('appendMessage', userMessage)
    const assistantMessage: AiMessage = {
      ...createMessage(target.connectionId, target.workspaceSessionId, target.terminalId, 'assistant', '', '', false, true),
      mode: 'agent',
      agentSteps: [],
      agentStatus: 'running',
      terminalConnectionGeneration: target.connectionGeneration
    }
    emit('appendMessage', assistantMessage)
    askText.value = ''
    await runAgentTurn(assistantMessage, text, selectedContext, userMessage.id)
  }

  /**
   * Runs one agent task against an assistant message that already exists in the
   * transcript. Shared by the first attempt and by an in-place retry.
   */
  async function runAgentTurn(
    assistantMessage: AiMessage,
    rawGoal: string,
    selectedContext: TerminalSelectionEvent | undefined,
    historyCutoffMessageId: string,
    retryStep?: AgentStep
  ) {
    const runner = props.agentCommandRunner
    if (!runner) {
      agentModeNotice.value = 'Agent 执行通道未接入,请更新应用或切回对话模式'
      return
    }
    const requestConnectionId = assistantMessage.connectionId
    const requestWorkspaceSessionId = assistantMessage.workspaceSessionId
    const boundTerminalId = assistantMessage.terminalId
    const boundConnectionGeneration = assistantMessage.terminalConnectionGeneration ?? props.terminalConnectionGeneration
    const { summary: conversationSummary, unsummarized } = conversationContextParts(
      requestWorkspaceSessionId,
      historyCutoffMessageId
    )
    const conversationMessages = unsummarized
      .slice(-MAX_AI_CONVERSATION_MESSAGES)
      .map((message) => ({ role: message.role, content: message.text }))
    const runSnapshot = createAgentRunSnapshot({
      config: props.config,
      apiKey: props.config.apiKey?.trim() || props.apiKey.trim(),
      terminalSnapshot: props.terminalSnapshot,
      commandHistory: aiCommandHistory(),
      conversationMessages,
      conversationSummary,
      allowlistPatterns: props.agentAllowlistPatterns ?? [],
      builtinReadonlyEnabled: props.agentBuiltinReadonlyEnabled ?? false
    })
    const {
      config: requestConfig,
      apiKey,
      terminalSnapshot,
      commandHistory,
      allowlistPatterns,
      builtinReadonlyEnabled
    } = runSnapshot
    const goal = buildQuestionWithSelectedTerminalText(rawGoal, selectedContext)
    const text = rawGoal

    isAsking.value = true
    agentRun.value = null
    agentRunMessageId.value = assistantMessage.id
    agentStreamText.value = ''
    currentAssistantMessageId.value = assistantMessage.id
    startAnswerTimer()

    function syncAgentRunToMessage(state: AgentRunState) {
      const status = agentStatusFromRun(state)
      const terminal = status !== 'running'
      const failed = status === 'error'
      // 重试复用同一条消息:累计用量要把上一次尝试的请求也算进去
      const usage = mergeMessageUsage(assistantMessage.usage, state.usage)
      const updated: AiMessage = {
        ...assistantMessage,
        mode: 'agent',
        text: failed ? state.error || '任务出错' : state.finalText,
        agentSteps: state.steps,
        agentStatus: status,
        errorKind: failed ? state.errorKind : undefined,
        stopReason: status === 'stopped' ? state.stopReason : undefined,
        terminalConnectionGeneration: boundConnectionGeneration,
        error: failed,
        streaming: !terminal,
        usage,
        payloadJson: terminal
          ? JSON.stringify({
              mode: 'agent',
              agentSteps: persistableAgentSteps(state.steps),
              agentStatus: status,
              errorKind: failed ? state.errorKind : undefined,
              stopReason: status === 'stopped' ? state.stopReason : undefined,
              terminalConnectionGeneration: boundConnectionGeneration,
              usage
            })
          : undefined
      }
      const message = failed
        ? createAiStreamErrorMessage(
            updated,
            updated.text,
            state.errorKind === 'model' ? agentStreamText.value : ''
          )
        : updated
      emit('updateMessage', terminal ? finishAnswerMessage(message) : message)
    }

    const deps: AgentLoopDeps = {
      callModel: async (turns, signal) => {
        const requestId = `${requestConnectionId}-${requestWorkspaceSessionId}-${boundTerminalId}-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        agentStreamText.value = ''
        let unlisten: (() => void) | undefined
        let cancelRequested = false
        // stop() 只翻转 signal.cancelled,由这里把取消传导给后端流式请求
        const cancelWatch = window.setInterval(() => {
          if (signal.cancelled && !cancelRequested) {
            cancelRequested = true
            void cancelTask(requestId).catch(() => {})
          }
        }, 120)
        try {
          unlisten = await onAiChatStream(requestId, (event) => {
            if (event.kind === 'chunk' && !signal.cancelled) {
              agentStreamText.value += event.delta
            }
          })
          return await aiAgentTurnStream(requestId, {
            config: requestConfig,
            apiKey,
            goal,
            turns,
            terminalSnapshot,
            commandHistory,
            conversationMessages: runSnapshot.conversationMessages,
            conversationSummary: runSnapshot.conversationSummary
          })
        } finally {
          window.clearInterval(cancelWatch)
          unlisten?.()
        }
      },
      startCommand: (command) => runner(boundTerminalId, command, {
        maxOutputChars: AGENT_OUTPUT_MAX_CHARS,
        connectionGeneration: boundConnectionGeneration
      }),
      classifyStep: (command) => {
        const risks = analyzeScriptRisks(command)
        const sensitive = isSensitiveAgentCommand(command)
        const autoExec = classifyForAutoExec(command, {
          userPatterns: allowlistPatterns,
          includeBuiltin: builtinReadonlyEnabled
        })
        // 命中计数只在真正会自动执行时记录(镜像循环的判定顺序:风险/敏感门在前)
        if (autoExec.eligible && autoExec.matched && !sensitive && risks.length === 0) {
          void touchAgentCommandAllowlistEntry(autoExec.matched).catch(() => {})
        }
        return { risks, sensitive, autoExec }
      },
      requestApproval: (proposal) =>
        new Promise<AgentApprovalDecision>((resolve) => {
          agentHighRiskArmed.value = false
          agentPendingApproval.value = { proposal, resolve }
          scrollMessagesToLatest()
        }),
      requestTimeoutDecision: (step, info) =>
        new Promise<AgentTimeoutDecision>((resolve) => {
          agentPendingTimeout.value = { step, info, resolve }
          scrollMessagesToLatest()
        }),
      onAllowPattern: async (pattern, sourceCommand) => {
        if (!props.agentAllowPattern) throw new Error('允许列表保存通道未接入')
        await props.agentAllowPattern(pattern, sourceCommand)
        // The run keeps its target/config snapshot, but explicit approvals made
        // within this run must apply to its following steps immediately.
        if (!allowlistPatterns.includes(pattern)) allowlistPatterns.push(pattern)
      },
      onStateChange: (state) => {
        agentRun.value = state
        if (state.status !== 'awaiting-approval') {
          agentPendingApproval.value = null
          agentApprovalSaving.value = false
          if (pendingAgentRiskReview.value) closeAiCommandRiskConfirm()
        }
        if (state.status !== 'awaiting-user') agentPendingTimeout.value = null
        syncAgentRunToMessage(state)
      }
    }

    // 步数上限与命令超时来自设置中心;未配置时沿用 agentLoop 的默认值
    // 重试时传入已完成的步骤,恢复执行上下文
    try {
      const task = runAgentTask(goal, deps, {
        stepLimit: props.agentStepLimit,
        commandTimeoutMs: props.agentCommandTimeoutMs,
        initialSteps: assistantMessage.agentSteps
          ?.filter(step => step.status === 'completed' || step.status === 'skipped')
          .map(snapshotAgentStep),
        retryStep: retryStep ? snapshotAgentStep(retryStep) : undefined
      })
      agentStopHandle = task.stop
      const finalState = await task.done
      agentRun.value = finalState
      syncAgentRunToMessage(finalState)
      if (finalState.status === 'error' && finalState.error) emit('aiError', finalState.error)
      if (finalState.status === 'done' && finalState.finalText) {
        maybeGenerateSessionTitle(
          requestConnectionId,
          requestWorkspaceSessionId,
          text,
          finalState.finalText,
          terminalSnapshot,
          commandHistory,
          requestConfig,
          apiKey
        )
        void maybeCompactConversation(requestWorkspaceSessionId)
      }
    } catch (error) {
      const detail = `Agent 任务异常:${formatAiError(error)}`
      const steps = agentRun.value?.steps ?? [
        ...(assistantMessage.agentSteps ?? []),
        ...(retryStep && !assistantMessage.agentSteps?.some(step => step.id === retryStep.id) ? [retryStep] : [])
      ]
      agentRun.value = null
      const failedMessage: AiMessage = {
        ...assistantMessage,
        mode: 'agent',
        agentSteps: steps,
        agentStatus: 'error',
        errorKind: 'protocol',
        stopReason: undefined,
        payloadJson: JSON.stringify({
          mode: 'agent',
          agentSteps: persistableAgentSteps(steps),
          agentStatus: 'error',
          errorKind: 'protocol',
          terminalConnectionGeneration: boundConnectionGeneration,
          usage: assistantMessage.usage
        })
      }
      emit('updateMessage', finishAnswerMessage(createAiStreamErrorMessage(failedMessage, detail, agentStreamText.value)))
      emit('aiError', detail)
    } finally {
      agentStopHandle = null
      agentPendingApproval.value = null
      agentApprovalSaving.value = false
      agentPendingTimeout.value = null
      agentStreamText.value = ''
      agentRunMessageId.value = ''
      finishAnswerTimer(assistantMessage.id)
      if (currentAssistantMessageId.value === assistantMessage.id) currentAssistantMessageId.value = ''
      isAsking.value = false
    }
  }

  // 倒计时时钟:只在任务运行期间跳动,空闲时不留定时器
  watch(agentRunActive, (active) => {
    if (active) {
      if (agentClockTimer !== undefined) return
      agentNowMs.value = Date.now()
      agentClockTimer = window.setInterval(() => {
        agentNowMs.value = Date.now()
      }, 1000)
      return
    }
    if (agentClockTimer !== undefined) {
      window.clearInterval(agentClockTimer)
      agentClockTimer = undefined
    }
  }, { immediate: true })

  onBeforeUnmount(() => {
    if (agentClockTimer !== undefined) {
      window.clearInterval(agentClockTimer)
      agentClockTimer = undefined
    }
  })

  onBeforeUnmount(() => {
    cancelAgentPreparation()
    agentStopHandle?.()
  })

  function agentTaskPending() { return agentStopHandle !== null }

  return { agentTaskPending, agentRun, agentRunMessageId, agentStreamText, agentModeNotice, agentPreparing, agentHighRiskArmed, agentApprovalSaving, agentPendingApproval, agentPendingTimeout, agentNowMs, agentRunActive, stopAgentRun, agentStatusFromRun, proposalHasHighRisk, resolveAgentApproval, resolveAgentTimeout, isAwaitingApprovalStep, isAwaitingTimeoutStep, agentRunStatusLabel, messageHasAgentBody, persistableAgentSteps, ensureAgentReady, currentAgentTarget, prepareAgentAction, startAgentTask, runAgentTurn, agentTargetIsCurrent, cancelAgentPreparation }
}
