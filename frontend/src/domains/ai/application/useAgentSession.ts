import { ref, computed, watch, onBeforeUnmount } from 'vue'
import type { Ref } from 'vue'
import type { AiPanelProps, AiPanelEmit } from '../domain/aiPanel'
import type { AiMessage, AgentTimelineEntry } from '../domain/conversation'
import { agentTimelineEntries } from '../domain/agentTimeline'
import { resolveTerminalContext } from '../domain/terminalContext'
import type { TerminalContextMode } from '../domain/terminalContext'
import type { TerminalSelectionEvent } from '../../terminal/types'
import type { AgentApprovalDecision, AgentRunState, AgentStep, AgentStepProposal, AgentTimeoutDecision, AgentTimeoutInfo } from '../domain/agent'
import type { useAiAnswerState } from './useAiAnswerState'
import type { useAiConversationContext } from './useAiConversationContext'
import { runAgentTask } from './agent/agentLoop'
import { createAgentFileSnapshotReader, createBoundAgentFileSnapshotReader } from './agent/readAgentFileSnapshots'
import { normalizeAgentFileChanges } from '../domain/agentFileSnapshots'
import type { AgentLoopDeps } from './agent/agentLoop'
import { canGrantExactCommand, classifyForAutoExec } from '../domain/agentAutoApprove'
import { analyzeScriptRisks } from '../../../shared/security/scriptRisk'
import { createAiStreamErrorMessage } from '../domain/aiStreamError'
import { createAgentRunSnapshot } from '../domain/agentRunSnapshot'
import { conversationMessageContent } from '../domain/conversationContext'
import { mergeMessageUsage } from '../domain/tokenUsage'
import { MAX_AI_CONVERSATION_MESSAGES, buildQuestionWithSelectedTerminalText, formatSelectedLineRange, formatAiError, createMessage, isSensitiveAgentCommand } from '../domain/aiConversation'
import * as tauri from '../infrastructure/api'
import type { AgentCheckpointApi, AgentCheckpoint, AgentRecoveryReview, AgentRecoveryDecision, AgentRunReply } from '../domain/agentCheckpoints'
import { agentGoalWithInputs, recoveredAgentSteps, recoveryEvidenceSteps, recoveryFacts } from '../domain/agentCheckpoints'
import { createAgentCheckpointJournal } from './agent/agentCheckpointJournal'

interface AgentSessionOptions {
  hostKnowledgeContext?: import('../domain/hostKnowledge').HostKnowledgeContextLoader
  props: Readonly<AiPanelProps>
  emit: AiPanelEmit
  askText: Ref<string>
  pendingAgentRiskReview: Ref<boolean>
  canSendMessage: () => boolean
  composerBusy: () => boolean
  selectedTerminalContext: () => TerminalSelectionEvent | undefined
  terminalContextMode?: () => TerminalContextMode
  scrollMessagesToLatest: () => void
  closeAiCommandRiskConfirm: () => void
  answerState: ReturnType<typeof useAiAnswerState>
  conversationContext: ReturnType<typeof useAiConversationContext>
}
type AgentSessionSource = Pick<typeof tauri, 'onAiChatStream' | 'cancelTask' | 'aiAgentTurnStream' | 'touchAgentCommandAllowlistEntry'> & Partial<AgentCheckpointApi>

/** Retry messages are reactive; unwrap both the step and its nested risk records. */
function snapshotAgentStep(step: AgentStep): AgentStep {
  return JSON.parse(JSON.stringify(step)) as AgentStep
}

import { persistableFileResult } from '../domain/agentFileTools'
import { persistableFileEdits } from '../domain/agentFileEdits'
import { persistableVerifications } from '../domain/agentTaskProgress'
import type { CommandIntent } from '../../../shared/security/commandPolicy'
import { commandPolicyRisks } from '../../../shared/security/commandPolicyPresentation'

export function useAgentSession(options: AgentSessionOptions, source: AgentSessionSource = tauri) {
  const { props, emit, askText, pendingAgentRiskReview, canSendMessage, composerBusy, selectedTerminalContext, scrollMessagesToLatest, closeAiCommandRiskConfirm } = options
  const { isAsking, currentAssistantMessageId, startAnswerTimer, finishAnswerTimer, finishAnswerMessage } = options.answerState
  const { aiCommandHistory, conversationContextParts, maybeGenerateSessionTitle, maybeCompactConversation } = options.conversationContext
  const { onAiChatStream, cancelTask, aiAgentTurnStream, touchAgentCommandAllowlistEntry } = source
  // Agent 模式运行态
  const agentRun = ref<AgentRunState | null>(null)
  const interruptedAgentRuns = ref<AgentCheckpoint[]>([])
  const checkpointLoadError = ref('')
  const agentPendingRecovery = ref<{ review: AgentRecoveryReview; resolve: (decision: AgentRecoveryDecision) => void } | null>(null)
  const agentRecoverySaving = ref(false)
  function resolveAgentRecovery(decision: AgentRecoveryDecision) {
    const pending = agentPendingRecovery.value
    if (!pending || agentRecoverySaving.value) return
    if (decision.action === 'continue') {
      const evidence = new Set(recoveryEvidenceSteps(pending.review).map(step => step.id))
      if (decision.resolutions.length !== pending.review.recovery.requiredStepIds.length || decision.resolutions.some(item => !item.observation.trim() || !item.evidenceStepIds.length || item.evidenceStepIds.some(id => !evidence.has(id)))) return
      agentRecoverySaving.value = true
    } else agentPendingRecovery.value = null
    pending.resolve(decision)
  }
  let checkpointLoadSequence = 0
  async function refreshAgentCheckpoints() {
    if (!source.listAgentCheckpoints) return
    const sequence = ++checkpointLoadSequence
    try {
      const saved = await source.listAgentCheckpoints(props.connectionId, props.workspaceSessionId)
      if (sequence !== checkpointLoadSequence) return
      interruptedAgentRuns.value = saved
      checkpointLoadError.value = ''
    } catch (error) {
      if (sequence === checkpointLoadSequence) checkpointLoadError.value = `未能读取中断任务：${formatAiError(error)}`
    }
  }
  watch([() => props.connectionId, () => props.workspaceSessionId], () => { interruptedAgentRuns.value = []; void refreshAgentCheckpoints() }, { immediate: true })

  const agentRunMessageId = ref('')

  const agentStreamText = ref('')

  /** Saved display transcript; never injected into Agent turns. */
  const agentReasoningText = ref('')

  const agentModeNotice = ref('')

  const agentPreparing = ref(false)

  const agentHighRiskArmed = ref(false)
  const agentApprovalSaving = ref(false)
  const sessionCommandGrants = ref(new Map<string, Set<string>>())
  const sessionGrantEnvironments = new Map<string, string>()
  let activeGrantScope = ''
  const currentGrantScope = () => JSON.stringify([props.connectionId, props.workspaceSessionId, props.terminalId, props.terminalConnectionGeneration])
  const agentSessionGrantCount = computed(() => sessionCommandGrants.value.get(currentGrantScope())?.size ?? 0)
  function revokeSessionCommandGrants() {
    sessionCommandGrants.value.clear()
    sessionGrantEnvironments.clear()
    activeGrantScope = ''
  }
  function observeGrantEnvironment(scope: string, intent: CommandIntent | undefined) {
    let environment: string | null = 'legacy'
    if (intent) {
      const { target, policyVersion, operation } = intent.reference
      const context = target.context
      environment = intent.analysis.analysisStatus === 'complete' && intent.analysis.decision === 'allow'
        && policyVersion && policyVersion === intent.analysis.policyVersion
        && target.sessionInstance && context?.shell !== 'unknown'
        && context?.workingDirectory && context.user && context.environmentScope
        ? JSON.stringify([target.sessionId, target.sessionInstance, target.profileId, target.routeVersion,
          context.shell, context.workingDirectory, context.user, context.environmentScope, policyVersion, operation])
        : null
    }
    // Every command gets a fresh native target. Its observation version can
    // advance without an environment change; the actual identity and context
    // must still match. Discard old grants instead of caching them per context.
    if (!environment || sessionGrantEnvironments.get(scope) !== environment) sessionCommandGrants.value.delete(scope)
    if (environment) sessionGrantEnvironments.set(scope, environment)
    else sessionGrantEnvironments.delete(scope)
    activeGrantScope = environment ? scope : ''
  }
  watch([() => props.connectionId, () => props.workspaceSessionId, () => props.terminalId, () => props.terminalConnectionGeneration], () => {
    revokeSessionCommandGrants()
    cancelAgentPreparation()
    agentStopHandle?.()
  })

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

  function agentStatusFromRun(state: AgentRunState): NonNullable<AiMessage['agentStatus']> {
    if (state.status === 'waiting-input') return 'waiting-input'
    if (state.status === 'done') return 'done'
    if (state.status === 'stopped') return 'stopped'
    if (state.status === 'error') return 'error'
    return 'running'
  }

  function proposalHasHighRisk(proposal: AgentStepProposal) {
    return proposal.risks.some((risk) => risk.severity === 'high')
  }

  function resolveAgentApproval(decision: AgentApprovalDecision | 'execute-and-allow-exact', riskReviewed = false) {
    const pending = agentPendingApproval.value
    if (!pending) return
    if (agentApprovalSaving.value) {
      if (decision === 'stop') stopAgentRun()
      return
    }
    if (decision === 'execute-and-allow-exact') {
      if (pending.proposal.toolName === 'run_ssh_task') return
      if (pending.proposal.sensitive || pending.proposal.risks.length || !canGrantExactCommand(pending.proposal.command) || !activeGrantScope || activeGrantScope !== currentGrantScope()) return
      const grants = sessionCommandGrants.value.get(activeGrantScope) ?? new Set<string>()
      grants.add(pending.proposal.command.trim())
      sessionCommandGrants.value.set(activeGrantScope, grants)
      agentPendingApproval.value = null
      agentHighRiskArmed.value = false
      pending.resolve('execute')
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
    'waiting-input': '等待你的回复',
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
      if (step.sensitive && ['run_command', 'run_ssh_task'].includes(step.toolName ?? 'run_command')) {
        step = { ...step, command: '[敏感命令未存储]', commandRedacted: true, reason: '[敏感步骤说明未存储]',
          failureReason: step.failureReason ? '[敏感失败详情未存储]' : undefined,
          risks: step.risks.map(risk => ({ ...risk, text: '[敏感命令未存储]', message: '[敏感风险详情未存储]' })) }
      }
      if (step.fileEdits) return { ...step, fileEdits: persistableFileEdits(step.fileEdits) }
      if (step.toolName === 'run_ssh_task' && step.sensitive) return { ...step, sshRequest: undefined, sshEnvironment: undefined, sshResult: step.sshResult ? { ...step.sshResult, stdout: '[敏感命令输出未存储]', stderr: '[敏感命令输出未存储]' } : undefined, output: '[敏感命令输出未存储]' }
      if (step.fileRequest) return { ...step, fileRequest: { ...step.fileRequest, cursor: undefined }, fileResult: step.fileResult ? persistableFileResult(step.fileResult) : undefined, output: step.sensitive ? '[敏感文件内容未存储]' : step.output }
      if (!step.sensitive || !step.output) return step
      return { ...step, output: '[敏感命令输出未存储]' }
    })
  }

  /** Agent 任务的最大命令输出捕获量(回传模型前的截断上限)。 */
  const AGENT_OUTPUT_MAX_CHARS = 4000
  const AGENT_REASONING_MAX_CHARS = 12_000

  function appendAgentReasoning(delta: string) {
    if (!delta) return
    const next = `${agentReasoningText.value}${delta}`
    agentReasoningText.value = next.length > AGENT_REASONING_MAX_CHARS
      ? next.slice(next.length - AGENT_REASONING_MAX_CHARS)
      : next
  }

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
    const takeoverChange = props.agentTakeoverChange
    // Lock the selected terminal before the asynchronous capability probe so
    // manual input cannot race with the probe command.
    if (takeoverChange?.(target.terminalId, true) === false) {
      return { cancelled: false, blocked: '此终端正在被其他会话的 Agent 使用，请切换空闲终端或新建会话' }
    }
    agentPreparing.value = true
    try {
      let blocked = ''
      try {
        blocked = await ensureAgentReady()
      } catch (error) {
        blocked = `Agent 启动检查失败:${formatAiError(error)}`
      }
      if (sequence !== agentPreparationSequence || !agentTargetIsCurrent(target)) {
        takeoverChange?.(target.terminalId, false)
        return { cancelled: true, blocked: '' }
      }
      if (blocked) {
        takeoverChange?.(target.terminalId, false)
      }
      return { cancelled: false, blocked }
    } finally {
      if (sequence === agentPreparationSequence) agentPreparing.value = false
    }
  }

  async function startAgentTask() {
    return beginAgentTask()
  }
  async function startFileRestore(id: string, path: string) {
    if (!props.agentFileTools?.edits) return
    return beginAgentTask({ id, path })
  }
  async function replyToAgentTask(checkpoint: AgentCheckpoint, text: string, confirmedPlanItemIds: string[] = []) {
    if (!source.replyAgentRun || checkpoint.state.status !== 'waiting-input' || !text.trim() || new TextEncoder().encode(text).length > 8192) return
    return startAgentRecovery(checkpoint, text.trim(), confirmedPlanItemIds)
  }
  async function startAgentRecovery(checkpoint: AgentCheckpoint, replyText?: string, confirmedPlanItemIds: string[] = []) {
    if (!source.recoverAgentRun || !source.confirmAgentRecovery || !canSendMessage() || composerBusy() || checkpoint.target.profileId !== props.connectionId || checkpoint.workspaceSessionId !== props.workspaceSessionId) return
    const target = currentAgentTarget()
    const prepared = await prepareAgentAction(target)
    if (prepared.cancelled) return
    if (prepared.blocked) { agentModeNotice.value = prepared.blocked; return }
    revokeSessionCommandGrants()
    agentModeNotice.value = ''
    const existing = replyText === undefined ? props.messages.find(message => message.id === checkpoint.messageId) : undefined
    const userMessage = replyText === undefined ? undefined : createMessage(target.connectionId, target.workspaceSessionId, target.terminalId, 'user', replyText)
    if (userMessage) {
      emit('appendMessage', userMessage)
      if (askText.value.trim() === replyText) askText.value = ''
    }
    const message: AiMessage = {
      ...(existing ?? createMessage(target.connectionId, target.workspaceSessionId, target.terminalId, 'assistant', '', '', false, true)),
      ...(replyText === undefined ? { id: checkpoint.messageId } : {}), terminalId: target.terminalId, terminalConnectionGeneration: target.connectionGeneration,
      mode: 'agent', agentStatus: 'running', streaming: true, error: false, text: '', errorKind: undefined, stopReason: undefined,
      agentSteps: recoveredAgentSteps(checkpoint), agentPlan: checkpoint.state.plan ?? undefined,
      agentVerifications: checkpoint.state.verifications, payloadJson: undefined
    }
    emit(existing ? 'updateMessage' : 'appendMessage', message)
    const reply = userMessage ? { messageId: userMessage.id, assistantMessageId: message.id, text: replyText!, ...(confirmedPlanItemIds.length ? { confirmedPlanItemIds: [...confirmedPlanItemIds] } : {}) } : undefined
    await runAgentTurn(message, checkpoint.goal, undefined, userMessage?.id ?? message.id, undefined, true, undefined, checkpoint, reply)
  }
  async function beginAgentTask(restoreChange?: { id: string; path: string }) {
    const text = restoreChange ? `恢复文件 ${restoreChange.path} 的这次修改` : askText.value.trim()
    if (!text || !canSendMessage() || composerBusy()) return
    const target = currentAgentTarget()
    if (!restoreChange && source.replyAgentRun) {
      const last = [...props.messages].reverse().find(message => message.connectionId === target.connectionId && message.workspaceSessionId === target.workspaceSessionId)
      if (last?.role === 'assistant' && last.agentStatus === 'waiting-input') {
        let timer: ReturnType<typeof setTimeout> | undefined
        try { await Promise.race([refreshAgentCheckpoints(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('任务记录读取超时，请重新载入后继续')), 5000) })]) }
        catch (error) { agentModeNotice.value = formatAiError(error); return }
        finally { clearTimeout(timer) }
        if (!agentTargetIsCurrent(target)) return
        const waiting = interruptedAgentRuns.value.find(run => run.messageId === last.id && run.state.status === 'waiting-input')
        if (!waiting) { agentModeNotice.value = '未能取得等待回复的原任务记录，请重新载入后继续'; return }
        return replyToAgentTask(waiting, text)
      }
    }
    const selectedContext = restoreChange ? undefined : selectedTerminalContext()
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
    if (!restoreChange) askText.value = ''
    await runAgentTurn(assistantMessage, text, selectedContext, userMessage.id, undefined, true, restoreChange)
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
    retryStep?: AgentStep,
    takeoverAlreadyAcquired = false,
    restoreChange?: { id: string; path: string },
    resumeCheckpoint?: AgentCheckpoint,
    reply?: AgentRunReply
  ) {
    if (retryStep?.commandRedacted) {
      if (takeoverAlreadyAcquired) props.agentTakeoverChange?.(assistantMessage.terminalId, false)
      agentModeNotice.value = '历史命令已脱敏，请核对现场后重新发起任务'
      return
    }
    const runner = props.agentCommandRunner
    if (!runner) {
      if (takeoverAlreadyAcquired) props.agentTakeoverChange?.(assistantMessage.terminalId, false)
      agentModeNotice.value = 'Agent 执行通道未接入,请更新应用或切回对话模式'
      return
    }
    const requestConnectionId = assistantMessage.connectionId
    const requestWorkspaceSessionId = assistantMessage.workspaceSessionId
    const boundTerminalId = assistantMessage.terminalId
    const boundConnectionGeneration = assistantMessage.terminalConnectionGeneration ?? props.terminalConnectionGeneration
    const policy = props.agentCommandPolicy
    let preparedIntent: CommandIntent | undefined
    let policyDisposed = false
    const grantScope = JSON.stringify([requestConnectionId, requestWorkspaceSessionId, boundTerminalId, boundConnectionGeneration])
    activeGrantScope = ''
    const { summary: conversationSummary, unsummarized } = conversationContextParts(
      requestWorkspaceSessionId,
      historyCutoffMessageId
    )
    const conversationMessages = unsummarized
      .slice(-MAX_AI_CONVERSATION_MESSAGES)
      .map((message) => ({ role: message.role, content: conversationMessageContent(message) }))
    const terminalContext = resolveTerminalContext(
      options.terminalContextMode?.() ?? 'auto', props.terminalSnapshot, aiCommandHistory(), selectedContext
    )
    const runSnapshot = createAgentRunSnapshot({
      config: props.config,
      apiKey: props.config.apiKey?.trim() || props.apiKey.trim(),
      terminalSnapshot: terminalContext.terminalSnapshot,
      commandHistory: terminalContext.commandHistory,
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
    let goal = buildQuestionWithSelectedTerminalText(rawGoal, terminalContext.selection)
    const text = rawGoal

    isAsking.value = true
    agentRun.value = null
    agentRunMessageId.value = assistantMessage.id
    agentStreamText.value = ''
    agentReasoningText.value = assistantMessage.agentReasoning ?? ''
    currentAssistantMessageId.value = assistantMessage.id
    startAnswerTimer()

    const timeline = agentTimelineEntries(assistantMessage)
      .filter(entry => entry.kind !== 'tool' || entry.stepId !== retryStep?.id)
    const snapshotTimeline = () => timeline.map(entry => ({ ...entry }))

    function syncAgentRunToMessage(state: AgentRunState) {
      const recordedSteps = new Set(timeline.flatMap(entry => entry.kind === 'tool' ? [entry.stepId] : []))
      for (const step of state.steps) {
        if (!recordedSteps.has(step.id)) timeline.push({ kind: 'tool', id: `tool:${step.id}`, stepId: step.id })
      }
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
        agentRecovery: recoveryFacts(state.recovery),
        agentPlan: state.plan,
        agentVerifications: state.verifications,
        agentOutcome: state.outcome,
        agentFileChanges: state.fileChanges,
        agentReasoning: agentReasoningText.value || undefined,
        agentTimeline: snapshotTimeline(),
        agentStatus: status,
        errorKind: failed ? state.errorKind : undefined,
        stopReason: status === 'stopped' ? state.stopReason : undefined,
        terminalConnectionGeneration: boundConnectionGeneration,
        error: failed,
        streaming: !terminal,
        usage,
        payloadJson: terminal
          ? JSON.stringify({
              payloadVersion: 2,
              mode: 'agent',
              agentSteps: persistableAgentSteps(state.steps),
              agentRecovery: recoveryFacts(state.recovery),
              agentPlan: state.plan,
              agentVerifications: persistableVerifications(state.verifications, state.steps),
              agentOutcome: state.outcome,
              agentFileChanges: state.fileChanges,
              agentStatus: status,
              agentReasoning: agentReasoningText.value || undefined,
              agentTimeline: snapshotTimeline(),
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

    const files = props.agentFileTools
    const edits = files?.edits
    const ssh = props.sshTasks
    const legacySnapshotReader = createAgentFileSnapshotReader((command, options) => runner(boundTerminalId, command, { ...options, connectionGeneration: boundConnectionGeneration }))
    let journal: ReturnType<typeof createAgentCheckpointJournal> | undefined
    let knowledgeRunId: string | undefined
    let recovered: AgentCheckpoint | undefined
    const deps: AgentLoopDeps = {
      requestRecoveryReview: review => new Promise(resolve => { agentRecoverySaving.value = false; agentPendingRecovery.value = { review, resolve }; scrollMessagesToLatest() }),
      confirmRecovery: async resolutions => {
        if (!journal || !source.agentCheckpointTarget) throw new Error('恢复会话已经结束')
        const expected = await (policy?.target?.(boundTerminalId, boundConnectionGeneration) ?? source.agentCheckpointTarget(boundTerminalId))
        const confirmed = await journal.confirm(expected, resolutions)
        if (!confirmed.recovery || confirmed.recovery.phase !== 'continuing') throw new Error('恢复确认没有生效')
        agentPendingRecovery.value = null; agentRecoverySaving.value = false
        return confirmed.recovery
      },
      prepareFileEdit: edits ? (request, signal) => 'changeId' in request ? edits.prepareRestore(boundTerminalId, boundConnectionGeneration, request, signal) : edits.prepare(boundTerminalId, boundConnectionGeneration, request, signal) : undefined,
      approveFileEdit: edits ? proposal => edits.approve(proposal) : undefined,
      executeFileEdit: edits ? (proposal, signal) => edits.execute(boundTerminalId, boundConnectionGeneration, proposal, signal) : undefined,
      cancelFileEdit: edits ? proposal => edits.cancel(proposal) : undefined,
      prepareSshTask: ssh ? request => ssh.prepare(boundTerminalId, boundConnectionGeneration, request) : undefined,
      approveSshTask: ssh ? intent => ssh.approve(intent) : undefined,
      startSshTask: ssh ? (intent, update) => ssh.start(boundTerminalId, boundConnectionGeneration, intent, update) : undefined,
      cancelSshTask: ssh ? intent => ssh.cancel(intent) : undefined,
      prepareFile: files ? (request, signal) => files.prepare(boundTerminalId, boundConnectionGeneration, request, signal) : undefined,
      approveFile: files ? operation => files.approve(operation) : undefined,
      executeFile: files ? (operation, signal) => files.execute(boundTerminalId, boundConnectionGeneration, operation, signal) : undefined,
      cancelFile: files ? operation => files.cancel(operation) : undefined,
      callModel: async (turns, signal, taskContext) => {
        const requestId = `${requestConnectionId}-${requestWorkspaceSessionId}-${boundTerminalId}-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        agentStreamText.value = ''
        const thinking: Extract<AgentTimelineEntry, { kind: 'thinking' }> = {
          kind: 'thinking', id: requestId, reasoning: '', text: ''
        }
        timeline.push(thinking)
        let thinkingFlushTimer: number | undefined
        let thinkingShown = false
        const flushThinking = () => {
          thinkingFlushTimer = undefined
          if (!signal.cancelled && agentRun.value) syncAgentRunToMessage(agentRun.value)
        }
        const syncThinking = () => {
          // Show the first delta immediately, then batch bursts to keep Markdown
          // rendering and transcript copying from competing with terminal input.
          if (!thinkingShown) { thinkingShown = true; flushThinking(); return }
          if (thinkingFlushTimer === undefined) thinkingFlushTimer = window.setTimeout(flushThinking, 80)
        }
        // Keep reasoning from earlier model turns visible after a tool result;
        // this field is display-only and is never added to the next request.
        if (agentReasoningText.value) {
          agentReasoningText.value += '\n\n'
        }
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
              thinking.text = agentStreamText.value
              syncThinking()
            }
            if (event.kind === 'reasoning' && !signal.cancelled) {
              appendAgentReasoning(event.delta)
              thinking.reasoning = `${thinking.reasoning}${event.delta}`.slice(-AGENT_REASONING_MAX_CHARS)
              syncThinking()
            }
          })
          const hostKnowledgeContext = await options.hostKnowledgeContext?.(goal, knowledgeRunId)
          if (signal.cancelled || boundTerminalId !== props.terminalId || boundConnectionGeneration !== props.terminalConnectionGeneration || requestConnectionId !== props.connectionId || requestWorkspaceSessionId !== props.workspaceSessionId) throw new Error('任务已停止或目标已变化')
          const response = await aiAgentTurnStream(requestId, {
            hostKnowledgeContext,
            config: requestConfig,
            apiKey,
            goal,
            turns,
            fileTools: Boolean(files),
            fileEdits: Boolean(edits) && agentRun.value?.recovery?.phase !== 'inspecting',
            taskTools: true,
            taskContext,
            sshTasks: Boolean(ssh) && agentRun.value?.recovery?.phase !== 'inspecting',
            terminalSnapshot,
            commandHistory,
            conversationMessages: runSnapshot.conversationMessages,
            conversationSummary: runSnapshot.conversationSummary
          })
          // Tool-turn commentary used to exist only in agentStreamText, which
          // is cleared for the next request and at completion. Archive the
          // complete response (also covers providers without chunk events).
          // The final answer remains in message.text, without duplication.
          if (!signal.cancelled && response.toolCalls.length && response.text.trim()) {
            appendAgentReasoning(`${agentReasoningText.value.trim() ? '\n\n' : ''}${response.text}`)
          }
          if (!signal.cancelled) thinking.text = response.toolCalls.length ? response.text : ''
          return response
        } catch (error) {
          // Model errors already retain partial answer text in the error body.
          if (!signal.cancelled) thinking.text = ''
          throw error
        } finally {
          if (thinkingFlushTimer !== undefined) window.clearTimeout(thinkingFlushTimer)
          window.clearInterval(cancelWatch)
          unlisten?.()
        }
      },
      readFiles: files ? createBoundAgentFileSnapshotReader(files, boundTerminalId, boundConnectionGeneration, legacySnapshotReader) : legacySnapshotReader,
      startCommand: (command) => runner(boundTerminalId, command, {
        intent: preparedIntent,
        maxOutputChars: AGENT_OUTPUT_MAX_CHARS,
        waitForReady: true,
        connectionGeneration: boundConnectionGeneration
      }),
      classifyStep: async (command) => {
        if (preparedIntent) { void policy?.cancel(preparedIntent).catch(() => {}); preparedIntent = undefined }
        if (policy) {
          const intent = await policy.prepare(boundTerminalId, boundConnectionGeneration, command)
          if (policyDisposed) { void policy.cancel(intent).catch(() => {}); throw new Error('任务已停止') }
          preparedIntent = intent
        }
        observeGrantEnvironment(grantScope, preparedIntent)
        const risks = preparedIntent ? commandPolicyRisks(preparedIntent) : analyzeScriptRisks(command)
        const sensitive = Boolean(preparedIntent?.sourceSensitive) || isSensitiveAgentCommand(command)
        const autoExec = classifyForAutoExec(command, {
          userPatterns: allowlistPatterns,
          includeBuiltin: builtinReadonlyEnabled
        })
        if (preparedIntent?.analysis.decision === 'deny') return { risks, sensitive, autoExec, denied: '命令被后端策略阻止，请修改操作后重新发起任务' }
        if (preparedIntent && preparedIntent.analysis.decision !== 'allow') return { risks, sensitive, autoExec: { ...autoExec, eligible: false, suggestedPatterns: [] } }
        if (!sensitive && risks.length === 0 && canGrantExactCommand(command) && sessionCommandGrants.value.get(grantScope)?.has(command.trim())) {
          return { risks, sensitive, autoExec: { ...autoExec, eligible: true, matched: undefined } }
        }
        // 命中计数只在真正会自动执行时记录(镜像循环的判定顺序:风险/敏感门在前)
        if (autoExec.eligible && autoExec.matched && !sensitive && risks.length === 0) {
          void touchAgentCommandAllowlistEntry(autoExec.matched).catch(() => {})
        }
        return { risks, sensitive, autoExec }
      },
      authorizeStep: policy ? async (command, manuallyApproved) => {
        if (!preparedIntent || preparedIntent.source !== command) throw new Error('执行内容与分析记录不一致')
        if (manuallyApproved) await policy.approve(preparedIntent)
        else if (preparedIntent.analysis.decision !== 'allow') throw new Error('该命令必须逐次确认')
      } : undefined,
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
      onAllowPatterns: async (patterns, sourceCommand) => {
        if (props.agentAllowPatterns) {
          await props.agentAllowPatterns(patterns, sourceCommand)
        } else {
          for (const pattern of patterns) {
            if (!props.agentAllowPattern) throw new Error('允许列表保存通道未接入')
            await props.agentAllowPattern(pattern, sourceCommand)
          }
        }
        patterns.forEach((pattern) => {
          if (!allowlistPatterns.includes(pattern)) allowlistPatterns.push(pattern)
        })
      },
      onStateChange: (state) => {
        agentRun.value = state
        if (state.status !== 'awaiting-approval') {
          agentPendingApproval.value = null
          agentApprovalSaving.value = false
          if (pendingAgentRiskReview.value) closeAiCommandRiskConfirm()
        }
        if (state.status !== 'awaiting-user') agentPendingTimeout.value = null
        if (state.status !== 'awaiting-user') { agentPendingRecovery.value = null; agentRecoverySaving.value = false }
        syncAgentRunToMessage(state)
      }
    }

    // 命令超时来自设置中心;未配置时沿用 agentLoop 的默认值
    // 重试时传入已完成的步骤,恢复执行上下文
    // The task owns the terminal from this point until every model/approval/
    // command promise has settled. The host uses this signal to block manual
    // input and protect the tab from being closed while the task is running.
    const takeoverChange = props.agentTakeoverChange
    let takeoverAcquired = takeoverAlreadyAcquired
    let setupCancelled = false
    let stopSetup!: () => void
    const setupStopped = new Promise<void>(resolve => { stopSetup = resolve })
    agentStopHandle = () => { setupCancelled = true; stopSetup() }
    const waitForSetup = async <T>(request: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          request,
          setupStopped.then(() => { throw new Error('任务已停止，尚未派发操作') }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('检查点准备超时，尚未派发操作')), 10_000) })
        ])
      } catch (error) { setupCancelled = true; throw error }
      finally { clearTimeout(timer) }
    }
    try {
      if (!takeoverAcquired) {
        if (takeoverChange?.(boundTerminalId, true) === false) throw new Error('此终端正在被其他会话的 Agent 使用')
        takeoverAcquired = true
      }
      if (source.beginAgentRun) {
        if (!source.agentCheckpointTarget || !source.saveAgentCheckpoint || !source.releaseAgentRun) throw new Error('任务检查点通道不完整')
        const expected = await waitForSetup(policy?.target?.(boundTerminalId, boundConnectionGeneration) ?? source.agentCheckpointTarget(boundTerminalId))
        if (expected.profileId !== requestConnectionId || boundConnectionGeneration !== props.terminalConnectionGeneration || boundTerminalId !== props.terminalId) throw new Error('任务目标已变化')
        if (setupCancelled) throw new Error('任务已停止，尚未派发操作')
        if (resumeCheckpoint && !source.recoverAgentRun) throw new Error('恢复通道未接入')
        if (reply && !source.replyAgentRun) throw new Error('任务回复通道未接入')
        const starting = resumeCheckpoint
          ? (reply ? source.replyAgentRun!(expected, resumeCheckpoint.runId, resumeCheckpoint.sequence, reply) : source.recoverAgentRun!(expected, resumeCheckpoint.runId, resumeCheckpoint.sequence)).then(value => { recovered = value.checkpoint; return value.lease })
          : source.beginAgentRun(expected, { runId: crypto.randomUUID(), workspaceSessionId: requestWorkspaceSessionId, messageId: assistantMessage.id, goal: rawGoal })
        void starting.then(lease => { if (setupCancelled) void source.releaseAgentRun?.(lease).catch(() => {}) }, () => {})
        const lease = await waitForSetup(starting)
        knowledgeRunId = lease.runId
        journal = createAgentCheckpointJournal({ saveAgentCheckpoint: source.saveAgentCheckpoint, releaseAgentRun: source.releaseAgentRun, confirmAgentRecovery: source.confirmAgentRecovery }, lease)
        deps.checkpoint = async (state, boundary, stepId) => {
          if (boundary === 'prepared' && state.recovery?.phase === 'inspecting') await policy?.target?.(boundTerminalId, boundConnectionGeneration)
          const step = state.steps.find(step => step.id === stepId)
          const reference = step && (step.toolName ?? 'run_command') === 'run_command' && preparedIntent?.source === step.command ? preparedIntent.reference : undefined
          await journal!.save(state, boundary, stepId, reference)
        }
      }
      if (setupCancelled) throw new Error('任务已停止，尚未派发操作')
      if (resumeCheckpoint && !recovered?.recovery) throw new Error('没有取得可恢复的检查点，尚未派发操作')
      if (recovered) {
        goal = buildQuestionWithSelectedTerminalText(agentGoalWithInputs(rawGoal, recovered.userInputs, reply), terminalContext.selection)
        assistantMessage.agentSteps = recoveredAgentSteps(recovered)
        assistantMessage.agentPlan = recovered.state.plan ?? undefined
        assistantMessage.agentVerifications = recovered.state.verifications
      }
      const task = runAgentTask(goal, deps, {
        recovery: recovered?.recovery ?? undefined,
        resolvedEffects: recovered?.resolvedEffects,
        restoreChange,
        initialPlan: assistantMessage.agentPlan ? JSON.parse(JSON.stringify(assistantMessage.agentPlan)) : undefined,
        initialVerifications: assistantMessage.agentVerifications ? JSON.parse(JSON.stringify(assistantMessage.agentVerifications)) : undefined,
        commandTimeoutMs: props.agentCommandTimeoutMs,
        initialFileChanges: normalizeAgentFileChanges(assistantMessage.agentFileChanges),
        initialSteps: assistantMessage.agentSteps
          ?.filter(step => recovered || step.status === 'completed' || step.status === 'skipped' || step.fileEdits?.some(item => item.changeId))
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
      }
    } catch (error) {
      const detail = `Agent 任务异常:${formatAiError(error)}`
      const steps = agentRun.value?.steps ?? [
        ...(assistantMessage.agentSteps ?? []),
        ...(retryStep && !assistantMessage.agentSteps?.some(step => step.id === retryStep.id) ? [retryStep] : [])
      ]
      const fileChanges = agentRun.value?.fileChanges ?? assistantMessage.agentFileChanges
      agentRun.value = null
      const failedMessage: AiMessage = {
        ...assistantMessage,
        mode: 'agent',
        agentSteps: steps,
        agentFileChanges: fileChanges,
        agentReasoning: agentReasoningText.value || undefined,
        agentTimeline: snapshotTimeline(),
        agentStatus: 'error',
        errorKind: 'protocol',
        stopReason: undefined,
        payloadJson: JSON.stringify({
          payloadVersion: 2,
          mode: 'agent',
          agentSteps: persistableAgentSteps(steps),
          agentFileChanges: fileChanges,
          agentStatus: 'error',
          agentReasoning: agentReasoningText.value || undefined,
          agentTimeline: snapshotTimeline(),
          errorKind: 'protocol',
          terminalConnectionGeneration: boundConnectionGeneration,
          usage: assistantMessage.usage
        })
      }
      emit('updateMessage', finishAnswerMessage(createAiStreamErrorMessage(failedMessage, detail, agentStreamText.value)))
      emit('aiError', detail)
    } finally {
      if (journal) await journal.release().catch(error => { agentModeNotice.value = `检查点所有权释放失败：${formatAiError(error)}` })
      void refreshAgentCheckpoints()
      policyDisposed = true
      if (preparedIntent) void policy?.cancel(preparedIntent).catch(() => {})
      if (takeoverAcquired) {
        takeoverAcquired = false
        takeoverChange?.(boundTerminalId, false)
      }
      agentStopHandle = null
      agentPendingApproval.value = null
      agentApprovalSaving.value = false
      agentPendingTimeout.value = null
      agentPendingRecovery.value = null
      agentRecoverySaving.value = false
      agentStreamText.value = ''
      agentReasoningText.value = ''
      agentRunMessageId.value = ''
      finishAnswerTimer(assistantMessage.id)
      if (currentAssistantMessageId.value === assistantMessage.id) currentAssistantMessageId.value = ''
      isAsking.value = false
      void maybeCompactConversation(requestWorkspaceSessionId)
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
    revokeSessionCommandGrants()
    agentStopHandle?.()
  })

  function agentTaskPending() { return agentStopHandle !== null }

  return { replyToAgentTask, startAgentRecovery, agentPendingRecovery, agentRecoverySaving, resolveAgentRecovery, interruptedAgentRuns, checkpointLoadError, refreshAgentCheckpoints, agentSessionGrantCount, revokeSessionCommandGrants, agentTaskPending, agentRun, agentRunMessageId, agentStreamText, agentReasoningText, agentModeNotice, agentPreparing, agentHighRiskArmed, agentApprovalSaving, agentPendingApproval, agentPendingTimeout, agentNowMs, agentRunActive, stopAgentRun, agentStatusFromRun, proposalHasHighRisk, resolveAgentApproval, resolveAgentTimeout, isAwaitingApprovalStep, isAwaitingTimeoutStep, agentRunStatusLabel, messageHasAgentBody, persistableAgentSteps, ensureAgentReady, currentAgentTarget, prepareAgentAction, startAgentTask, startFileRestore, runAgentTurn, agentTargetIsCurrent, cancelAgentPreparation }
}
