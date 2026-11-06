import type { AgentApprovalDecision, AgentAutoExecClassification, AgentCommandHandle, AgentCommandResult, AgentRunState, AgentStep, AgentStepProposal, AgentTimeoutDecision, AgentTimeoutInfo, AiAgentTurn, AiAgentTurnResponse, AiToolCall } from '../../domain/agent'
import { isFileTool, parseFileToolArguments, fileToolArguments, fileToolModelResult, fileToolOutput } from '../../domain/agentFileTools'
import { fileToolError } from '../../../transfer/index'
import type { FileToolRequest, FileOperation, FileToolResponse } from '../../../transfer/index'
import { addTokenUsage } from '../../domain/tokenUsage'
import { normalizeAgentFiles } from '../../domain/agentFiles'
import { createAgentFileTracker, unavailableFile } from '../../domain/agentFileSnapshots'
import type { AgentFileChange, AgentFileSnapshot } from '../../domain/agentFileSnapshots'
import type { ScriptRiskMatch } from '../../../../shared/security/scriptRisk'
import type { SshTaskHandle, SshTaskIntent, SshTaskRequest, SshTaskSnapshot } from '../../../terminal/types'
import { sshTaskOutput, sshTaskResult } from '../../../terminal/index'
import { parseSshTaskArguments, sensitiveSshTask, sshTaskModelResult } from '../../domain/agentSshTasks'
import { commandPolicyRisks } from '../../../../shared/security/commandPolicyPresentation'
import { updateAgentPlan, recordAgentVerification, invalidateAgentVerifications, agentTaskOutcome, agentTaskContext } from '../../domain/agentTaskProgress'
import type { AgentTaskPlan, AgentVerification } from '../../domain/agentTaskProgress'
import { isFileEditTool, parseFileEditArguments, fileEditModelResult } from '../../domain/agentFileEdits'
import type { FileEditRequest, FileRestoreRequest, FileEditProposal, FileChangeRecord } from '../../../transfer/index'
import { fileEditView } from '../../../transfer/index'
import type { AgentCheckpointBoundary } from '../../domain/agentCheckpoints'
import type { AgentRecovery, AgentRecoveryReview, AgentRecoveryDecision, RecoveryResolution } from '../../domain/agentCheckpoints'
import { agentRunContext } from '../../domain/agentCheckpoints'
import { classifyForAutoExec } from '../../domain/agentAutoApprove'

// Agent 循环编排器(任务 F3)。纯逻辑模块,不依赖 Vue/Tauri,全部外部能力经 AgentLoopDeps 注入。
// 状态机与数据流见 docs/ai-agent-mode-development.md 4.2/4.3,职责边界见 6.3;
// 审批顺序(敏感/风险 → 自动执行 → 人工)由 classifyStep 判定,本模块只消费其结果(6.4);
// 轮次预算与压缩策略见文档 8。

export interface AgentStepClassification { risks: ScriptRiskMatch[]; sensitive: boolean; autoExec: AgentAutoExecClassification; denied?: string }
export interface AgentLoopDeps {
  requestRecoveryReview?(review: AgentRecoveryReview): Promise<AgentRecoveryDecision>
  confirmRecovery?(resolutions: RecoveryResolution[]): Promise<AgentRecovery>
  checkpoint?(state: AgentRunState, boundary: AgentCheckpointBoundary, stepId?: string): Promise<void>
  prepareFileEdit?(request: FileEditRequest | FileRestoreRequest, signal: { readonly cancelled: boolean }): Promise<FileEditProposal>
  approveFileEdit?(proposal: FileEditProposal): Promise<void>
  executeFileEdit?(proposal: FileEditProposal, signal: { readonly cancelled: boolean }): Promise<FileChangeRecord>
  cancelFileEdit?(proposal: FileEditProposal): Promise<unknown>
  prepareSshTask?(request: SshTaskRequest): Promise<SshTaskIntent>
  approveSshTask?(intent: SshTaskIntent): Promise<void>
  startSshTask?(intent: SshTaskIntent, update: (snapshot: SshTaskSnapshot) => void): Promise<SshTaskHandle>
  cancelSshTask?(intent: SshTaskIntent): Promise<unknown>
  prepareFile?(request: FileToolRequest, signal: { readonly cancelled: boolean }): Promise<FileOperation>
  approveFile?(operation: FileOperation): Promise<void>
  executeFile?(operation: FileOperation, signal: { readonly cancelled: boolean }): Promise<FileToolResponse>
  cancelFile?(operation: FileOperation): Promise<unknown>
  /** 请求模型一轮决策;stop() 后 signal.cancelled 变 true,实现方应尽快返回(结果会被丢弃)。 */
  callModel(turns: AiAgentTurn[], signal: { readonly cancelled: boolean }, taskContext?: string): Promise<AiAgentTurnResponse>
  /** 派发命令并返回执行句柄;超时判断留在循环侧,cancel 只放弃等待、不终止命令。 */
  startCommand(command: string): AgentCommandHandle | Promise<AgentCommandHandle>
  /** Read only approved write targets in the bound terminal; contents never enter model turns. */
  readFiles?(paths: string[], signal: { readonly cancelled: boolean }): Promise<AgentFileSnapshot[]>
  /** 风险/敏感/自动执行三合一判定(6.4),顺序语义由循环执行。 */
  classifyStep(command: string): AgentStepClassification | Promise<AgentStepClassification>
  authorizeStep?(command: string, manuallyApproved: boolean): Promise<void>
  /** 人工审批;stop() 后未决的审批结果作废。 */
  requestApproval(proposal: AgentStepProposal): Promise<AgentApprovalDecision>
  /** 命令超时后的用户决策:继续等待或停止任务;info 给出静默/交互等待的判断依据。 */
  requestTimeoutDecision(step: AgentStep, info: AgentTimeoutInfo): Promise<AgentTimeoutDecision>
  /** 「总是允许」:把 pattern 写入允许列表(先落地再执行)。 */
  onAllowPattern(pattern: string, sourceCommand: string): void | Promise<void>
  /** Atomic multi-pattern grant for compound commands. */
  onAllowPatterns?(patterns: string[], sourceCommand: string): void | Promise<void>
  /** 每次状态变化的快照回调;收到的是结构化克隆,可安全渲染/暂存。 */
  onStateChange(state: AgentRunState): void
}

export interface AgentLoopOptions {
  recovery?: AgentRecovery
  resolvedEffects?: RecoveryResolution[]
  restoreChange?: { id: string; path: string }
  initialPlan?: AgentTaskPlan
  initialVerifications?: AgentVerification[]
  commandTimeoutMs?: number
  maxTurnChars?: number
  /** 执行期间轮询 peekOutput 的周期,用于判断输出是否静默。 */
  outputSampleIntervalMs?: number
  /** 重试时已完成的步骤;循环会从这些步骤继续,恢复 turns 数组。 */
  initialSteps?: AgentStep[]
  initialFileChanges?: AgentFileChange[]
  /** 用户点击重试时需要直接重新执行的失败步骤。 */
  retryStep?: AgentStep
}

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
// Each user-started continuation gets a fresh allowance; reaching it preserves
// the checkpoint and requires an explicit continuation, never an automatic retry.
export const AGENT_RUN_BUDGET = Object.freeze({ modelTurns: 64, toolCalls: 128 })
/** 采样只比对字符串长度,周期可以密一些而不影响性能。 */
const DEFAULT_OUTPUT_SAMPLE_INTERVAL_MS = 2_000
/** 超时提示里展示的部分输出尾部长度。 */
const TIMEOUT_PARTIAL_OUTPUT_CHARS = 500
/** 软预算:提早压缩重复回传的旧证据,后端 80k 仍是协议硬上限。 */
const DEFAULT_MAX_TURN_CHARS = 24_000
/** 一次压缩留出 25% 余量,减少连续改写历史导致的前缀缓存失效。 */
const COMPACTED_TURN_BUDGET_RATIO = 0.75
/** 压缩时最近保留的完整轮次数(文档 8);探索任务依赖较长证据链。 */
const PROTECTED_RECENT_TURNS = 6
/** 压缩时 Assistant 文本保留的字符数。 */
const COMPRESSED_ASSISTANT_TEXT_CHARS = 200
/** 压缩后仍保留的命令输出尾部字符数:报错通常在尾部,整体丢弃会让模型失忆。 */
const COMPRESSED_OUTPUT_TAIL_CHARS = 300
const MAX_EARLY_TURN_SUMMARY_CHARS = 6_000
const OMITTED_OUTPUT_NOTE = '输出已省略'
const TRUNCATED_OUTPUT_NOTE = '仅保留输出尾部'
const RUN_COMMAND_TOOL_NAME = 'run_command'
const ASK_USER_TOOL_NAME = 'ask_user'

function toolCallFromStep(step: AgentStep): AiToolCall {
  if (step.checkpointHistory) return { id: step.id, name: step.toolName ?? 'run_command', arguments: JSON.stringify({ historyOnly: true, commandExcerpt: step.sensitive ? '[敏感命令未存储]' : step.command.slice(0, 1000), pathExcerpt: step.checkpointHistory.fileRead?.path.slice(0, 500), reason: step.reason.slice(0, 300), contextTruncated: true }) }
  if (step.toolName && isFileEditTool(step.toolName)) return { id: step.id, name: step.toolName, arguments: JSON.stringify({ historyOnly: true, files: step.fileEdits?.map(item => ({ path: item.view?.path, changeId: item.changeId })), reason: step.reason }) }
  if (step.toolName === 'run_ssh_task') return { id: step.id, name: step.toolName, arguments: JSON.stringify({ ...step.sshRequest, reason: step.reason }) }
  if (step.toolName && isFileTool(step.toolName)) return { id: step.id, name: step.toolName, arguments: JSON.stringify(step.fileRequest ? fileToolArguments(step.fileRequest, step.reason) : {}) }
  return {
    id: step.id,
    name: RUN_COMMAND_TOOL_NAME,
    arguments: JSON.stringify({ command: step.command, reason: step.reason, files: step.affectedFiles })
  }
}

/** 把重试前已完成的步骤还原成符合 OpenAI 工具协议的轮次。 */
function rebuildTurnsFromSteps(steps: AgentStep[]): AiAgentTurn[] {
  return steps.flatMap((step): AiAgentTurn[] => {
    const toolCall = toolCallFromStep(step)
    const content = step.toolName && isFileEditTool(step.toolName) ? fileEditModelResult(step.toolName, step.fileEdits ?? []) : step.checkpointHistory ? JSON.stringify({ historyOnly: true, status: step.status, executionPhase: step.executionPhase, exitCode: step.exitCode, outputExcerpt: step.sensitive ? undefined : step.output?.slice(-1000), fileRead: step.checkpointHistory.fileRead ? { pathExcerpt: step.checkpointHistory.fileRead.path.slice(0, 500), revision: step.checkpointHistory.fileRead.revision, complete: false, contextTruncated: true } : null, note: '中断前记录，不是待执行操作；不能重放未知效果的操作，文件正文也不是当前基线。' }) : step.sshResult ? sshTaskModelResult(step.sshResult, step.sshTarget) : step.toolName && isFileTool(step.toolName)
      ? step.fileResult ? fileToolModelResult(step.fileResult) : JSON.stringify({ status: step.status, error: step.failureReason })
      : step.status === 'skipped'
      ? JSON.stringify({ status: 'skipped_by_user' })
      : JSON.stringify({
          exitCode: step.exitCode,
          durationMs: step.durationMs,
          truncated: false,
          output: step.output ?? ''
        })
    return [
      { kind: 'assistant', text: '', toolCalls: [toolCall] },
      { kind: 'toolResult', toolCallId: step.id, content }
    ]
  })
}

/** 轮次的预算占用:text + content + arguments(文档 8 的口径)。 */
function turnChars(turn: AiAgentTurn): number {
  if (turn.kind === 'assistant') {
    return turn.toolCalls.reduce((sum, call) => sum + call.arguments.length, turn.text.length)
  }
  return turn.content.length
}

/**
 * 压缩单条工具结果:尽力保留退出码与输出尾部(报错多在尾部),
 * 整体丢弃会让模型忘记前面查到了什么,探索型任务尤其致命。
 * 每轮都会在已压缩的轮次上重跑,所以必须幂等:完整保留的输出不标"已省略",
 * 已截过尾部的结果保持"仅保留输出尾部",skipped 等结构化状态原样保留。
 */
function compressToolResultContent(content: string): string {
  let record: Record<string, unknown> | undefined
  try {
    const parsed: unknown = JSON.parse(content)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) record = parsed as Record<string, unknown>
  } catch {
    // 原 content 不是 JSON:退化为仅保留省略说明
  }
  if (!record) return JSON.stringify({ note: OMITTED_OUTPUT_NOTE })

  const payload: Record<string, unknown> = {}
  if (typeof record.tool === 'string' && isFileEditTool(record.tool)) return JSON.stringify({ tool: record.tool, status: record.status, files: Array.isArray(record.files) ? record.files.slice(0, 8).map(raw => {
    const item = raw as Record<string, unknown>
    return { changeId: item.changeId, status: item.status, pathExcerpt: typeof item.path === 'string' ? item.path.slice(-200) : undefined }
  }) : [], contextTruncated: true, note: '文件变更记录是历史证据；重新完整读取后才能修改或恢复。未知写入不能重放。' })
  if (record.tool === 'run_ssh_task') {
    for (const key of ['tool', 'target', 'status', 'exitCode', 'exitSignal', 'exitEvidence', 'reason', 'truncated']) if (record[key] !== undefined) payload[key] = record[key]
    for (const key of ['stdout', 'stderr']) if (typeof record[key] === 'string') payload[key] = record[key].slice(-COMPRESSED_OUTPUT_TAIL_CHARS)
    payload.contextTruncated = true
    return JSON.stringify(payload)
  }
  if (typeof record.tool === 'string' && isFileTool(record.tool)) {
    for (const key of ['tool', 'path', 'resolvedPath', 'revision', 'provider', 'changedDuringRead', 'status']) if (record[key] !== undefined) payload[key] = record[key]
    payload.contextTruncated = true
    payload.note = '历史文件结果已压缩；不能视为完整文件或当前版本，需要时重新读取。'
    if (typeof record.content === 'string') payload.contentExcerpt = record.content.slice(-COMPRESSED_OUTPUT_TAIL_CHARS)
    return JSON.stringify(payload)
  }
  if (typeof record.status === 'string') payload.status = record.status
  if (typeof record.exitCode === 'number') payload.exitCode = record.exitCode
  if (typeof record.output === 'string') {
    if (record.output.length > COMPRESSED_OUTPUT_TAIL_CHARS) {
      payload.output = record.output.slice(record.output.length - COMPRESSED_OUTPUT_TAIL_CHARS)
      payload.note = TRUNCATED_OUTPUT_NOTE
    } else {
      payload.output = record.output
      if (record.note === TRUNCATED_OUTPUT_NOTE) payload.note = TRUNCATED_OUTPUT_NOTE
    }
  } else if (typeof record.note === 'string') {
    payload.note = record.note
  }
  if (Object.keys(payload).length === 0) payload.note = OMITTED_OUTPUT_NOTE
  return JSON.stringify(payload)
}

/**
 * 轮次预算压缩(文档 8):总字符超过 maxTurnChars 时从最早轮次开始压缩,
 * ToolResult.content 保留退出码与输出尾部,Assistant.text 截断;
 * 最近 PROTECTED_RECENT_TURNS 个轮次保持原样。
 * 不修改入参,返回新数组(未超限时原样返回)。
 */
export function compressAgentTurns(turns: AiAgentTurn[], maxTurnChars: number): AiAgentTurn[] {
  let total = turns.reduce((sum, turn) => sum + turnChars(turn), 0)
  if (total <= maxTurnChars) return turns

  const targetChars = Math.floor(maxTurnChars * COMPACTED_TURN_BUDGET_RATIO)
  const compressed = turns.slice()
  const protectedFrom = Math.max(0, compressed.length - PROTECTED_RECENT_TURNS)
  for (let index = 0; index < protectedFrom && total > targetChars; index += 1) {
    const turn = compressed[index]
    let next: AiAgentTurn | undefined
    if (turn.kind === 'toolResult') {
      const content = compressToolResultContent(turn.content)
      // 占位比原文还长时保持原样,避免"压缩"反而膨胀
      if (content.length < turn.content.length) next = { ...turn, content }
    } else if (turn.toolCalls.length && turn.text.length > COMPRESSED_ASSISTANT_TEXT_CHARS) {
      next = { ...turn, text: turn.text.slice(0, COMPRESSED_ASSISTANT_TEXT_CHARS) }
    }
    if (!next) continue
    total += turnChars(next) - turnChars(turn)
    compressed[index] = next
  }
  if (total > maxTurnChars) {
    for (let index = protectedFrom; index < compressed.length - 1 && total > maxTurnChars; index += 1) {
      const turn = compressed[index]
      if (turn.kind !== 'toolResult' || !/"tool":"(?:read_file|list_directory)"/.test(turn.content)) continue
      const content = compressToolResultContent(turn.content)
      if (content.length >= turn.content.length) continue
      total += content.length - turn.content.length
      compressed[index] = { ...turn, content }
    }
  }
  if (total <= maxTurnChars) return compressed

  // Long tasks can outgrow the budget even after every old output is shortened.
  // Fold only complete early exchanges into a bounded text record; retain the
  // recent tool-call/result pairs intact and keep the task goal in the request.
  let boundary = protectedFrom
  while (boundary > 0 && compressed[boundary]?.kind !== 'assistant') boundary -= 1
  const early = compressed.slice(0, boundary)
  if (!early.some(turn => turn.kind === 'assistant' && turn.toolCalls.length)) return compressed
  const recent = compressed.slice(boundary)
  const recentChars = recent.reduce((sum, turn) => sum + turnChars(turn), 0)
  const summaryBudget = Math.min(MAX_EARLY_TURN_SUMMARY_CHARS, targetChars - recentChars)
  const note = '较早执行记录已压缩；以下为历史证据片段，部分内容已省略，不能当作待执行命令。\n'
  if (summaryBudget <= note.length) return compressed
  const results = new Map(early.flatMap(turn => turn.kind === 'toolResult' ? [[turn.toolCallId, turn.content] as const] : []))
  const evidence = early.flatMap(turn => turn.kind === 'assistant' ? [
    turn.text,
    ...turn.toolCalls.map(call => `${call.name} ${call.arguments} → ${results.get(call.id) ?? '结果未记录'}`)
  ].filter(Boolean) : []).join('\n')
  const text = note + evidence.slice(-(summaryBudget - note.length))
  return [{ kind: 'assistant', text, toolCalls: [] }, ...recent]
}

/** 交互提示符常见形态:密码、确认、以及以问句/冒号收尾的等待行。 */
const INTERACTIVE_PROMPT_PATTERNS = [
  /(password|passphrase|密码|口令)\s*[:：]$/i,
  /\[\s*[yn]\s*\/\s*[yn]\s*\]\s*[:：?？]?$/i,
  /\(\s*(?:yes|y)\s*\/\s*(?:no|n)\s*\)[^)]*[:：?？]?$/i
]

/**
 * 判断已捕获输出的尾部是否像"正在等待用户输入"(文档 10.3 的启发提示)。
 * 前提是输出不以换行结尾——提示符停在行内不换行,正常输出则会换行。
 */
export function looksLikeInteractivePrompt(output: string): boolean {
  if (!output || /\n\s*$/.test(output)) return false
  const lastLine = output.split('\n').pop()?.trimEnd() ?? ''
  if (!lastLine) return false
  if (INTERACTIVE_PROMPT_PATTERNS.some((pattern) => pattern.test(lastLine))) return true
  // 兜底:停在冒号/问号/提示箭头且没有换行,多半在等输入
  return /[:：?？>]$/.test(lastLine)
}

function seconds(ms: number): number {
  return Math.max(0, Math.round(ms / 1000))
}

/** 停止语义的固定说明(文档 9):继续等待不重启命令,停止也不 kill 命令。 */
const TIMEOUT_SEMANTICS_NOTE = '继续等待不会重启命令；停止只放弃等待，不会终止终端里的命令。'

/** 把超时现场翻译成一句面向用户的解释,三种情形分开说。 */
export function describeTimeoutHint(info: Omit<AgentTimeoutInfo, 'hint'>): string {
  const waited = seconds(info.waitedMs)
  if (info.outputGrowing) {
    return `已运行 ${waited}s，命令仍在持续输出，可继续等待。`
  }
  const silent = seconds(info.silentMs)
  if (info.likelyInteractive) {
    return `已运行 ${waited}s，最近 ${silent}s 无新输出，末尾像是在等待你的输入。可切到终端手动响应后点「继续等待」，或停止任务。${TIMEOUT_SEMANTICS_NOTE}`
  }
  return `已运行 ${waited}s，最近 ${silent}s 无新输出，命令可能仍在运行或已卡住。${TIMEOUT_SEMANTICS_NOTE}`
}

type RaceOutcome<T> =
  | { kind: 'value'; value: T }
  | { kind: 'error'; error: unknown }
  | { kind: 'stopped' }

type CommandWaitOutcome =
  | { kind: 'result'; result: AgentCommandResult }
  | { kind: 'error'; error: unknown }
  | { kind: 'timeout' }
  | { kind: 'stopped' }

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 启动一次 agent 任务(4.3 状态机)。done 永不 reject,错误落在 state.status='error' + state.error;
 * stop() 任意阶段可调:模型请求置 signal.cancelled、未决审批作废、执行中放弃等待(不终止命令)。
 */
export function runAgentTask(
  goal: string,
  deps: AgentLoopDeps,
  options: AgentLoopOptions = {}
): { done: Promise<AgentRunState>; stop(): void } {
  // goal 由 callModel 的实现方在请求构造时携带(6.3),循环本身不消费
  void goal

  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  const maxTurnChars = options.maxTurnChars ?? DEFAULT_MAX_TURN_CHARS
  const outputSampleIntervalMs = options.outputSampleIntervalMs ?? DEFAULT_OUTPUT_SAMPLE_INTERVAL_MS
  let modelTurns = 0, toolCalls = 0
  const initialSteps = (options.initialSteps ?? [])
    .filter((step) => options.recovery || step.status === 'completed' || step.status === 'skipped' || step.fileEdits?.some(item => item.changeId))
    .map((step) => structuredClone(step))
  const retryStep = options.retryStep?.status === 'failed'
    ? {
        ...structuredClone(options.retryStep),
        status: 'pending' as const,
        executionPhase: 'not-started' as const,
        failureReason: undefined,
        output: undefined,
        exitCode: undefined,
        durationMs: undefined,
        startedAt: undefined,
        deadlineAt: undefined
      }
    : undefined

  const fileTracker = createAgentFileTracker(options.initialFileChanges)
  const state: AgentRunState = {
    recovery: options.recovery ? structuredClone(options.recovery) : undefined,
    plan: options.initialPlan ? structuredClone(options.initialPlan) : undefined,
    verifications: structuredClone(options.initialVerifications ?? []),
    outcome: 'unverified',
    status: retryStep ? 'executing' : 'calling-model',
    steps: retryStep ? [...initialSteps, retryStep] : initialSteps,
    finalText: '',
    commandTimeoutMs,
    ...(fileTracker.values() ? { fileChanges: fileTracker.values() } : {})
  }
  let turns = rebuildTurnsFromSteps(initialSteps)
  let parseFailureStreak = 0
  let recoveryBlockedCalls = 0
  let recoveryUserNote = ''
  const resolvedEffects = [...(options.resolvedEffects ?? [])]
  let finished = false
  let stopRequested = false
  let activeHandle: AgentCommandHandle | undefined
  let activeFileOperation: FileOperation | undefined
  let activeFileEdits: FileEditProposal[] = []
  const liveFileBaselines = new Map<string, string>()
  let activeSshIntent: SshTaskIntent | undefined
  let activeSshHandle: SshTaskHandle | undefined

  const signal = { cancelled: false }

  let resolveDone!: (finalState: AgentRunState) => void
  const done = new Promise<AgentRunState>((resolve) => {
    resolveDone = resolve
  })
  let resolveStopped!: () => void
  const stopPromise = new Promise<void>((resolve) => {
    resolveStopped = resolve
  })

  const notify = () => {
    state.verifications = invalidateAgentVerifications(state.verifications ?? [], state.steps)
    state.outcome = agentTaskOutcome(state.plan, state.verifications)
    try {
      deps.onStateChange(structuredClone(state))
    } catch {
      // 快照回调异常不阻断循环(done 永不 reject)
    }
  }

  const setStatus = (status: AgentRunState['status']) => {
    if (state.status === status) return
    state.status = status
    notify()
  }

  const finishRun = (mutate: () => void) => {
    if (finished) return
    finished = true
    mutate()
    for (const step of state.steps) {
      step.startedAt = undefined
      step.deadlineAt = undefined
      if (state.status === 'stopped' || state.status === 'error') for (const item of step.fileEdits ?? []) {
        if (item.status === 'review') item.status = 'not-started'
        if (item.status === 'dispatching') { item.status = 'unknown'; item.error = '观察结束，写入效果仍需核对'; step.status = 'failed' }
      }
    }
    notify()
    if (!deps.checkpoint) { resolveDone(structuredClone(state)); return }
    void deps.checkpoint(structuredClone(state), 'finished').then(() => resolveDone(structuredClone(state)), error => {
      state.status = 'error'; state.errorKind = 'tool'
      state.error = `任务检查点保存失败，已停止后续操作；请核对已有执行记录：${errorMessage(error)}`
      notify(); resolveDone(structuredClone(state))
    })
  }

  const finishStopped = (reason?: string) => {
    finishRun(() => {
      state.status = 'stopped'
      state.stopReason = reason ?? (state.steps.some((step) => (!step.toolName || step.toolName === 'run_command') && (step.status === 'running' || step.status === 'timeout'))
        ? '任务已停止；已发出的命令可能仍在终端运行。'
        : '用户已停止任务。')
    })
  }

  const takeToolBudget = () => {
    if (toolCalls >= AGENT_RUN_BUDGET.toolCalls) {
      finishStopped(`本轮已处理 ${toolCalls} 次工具调用，已保存已有结果并停止后续操作。请核对进度后选择继续；未完成事项仍需处理。`)
      return false
    }
    toolCalls++
    return true
  }

  const finishError = (message: string, errorKind: NonNullable<AgentRunState['errorKind']>) => {
    finishRun(() => {
      state.status = 'error'
      state.error = message
      state.errorKind = errorKind
    })
  }

  /** 与 stop() 竞速:stop 抢先则本次 await 的结果作废。 */
  const raceWithStop = <T>(promise: Promise<T>): Promise<RaceOutcome<T>> => {
    return Promise.race([
      promise.then(
        (value): RaceOutcome<T> => ({ kind: 'value', value }),
        (error): RaceOutcome<T> => ({ kind: 'error', error })
      ),
      stopPromise.then((): RaceOutcome<T> => ({ kind: 'stopped' }))
    ])
  }

  const checkpoint = async (boundary: AgentCheckpointBoundary, step?: AgentStep): Promise<boolean> => {
    if (stopRequested) { finishStopped(); return false }
    if (!deps.checkpoint) return true
    const saved = await raceWithStop(deps.checkpoint(structuredClone(state), boundary, step?.id))
    if (saved.kind === 'stopped') { finishStopped(); return false }
    if (saved.kind === 'error') {
      if (boundary === 'before-dispatch' && step) {
        step.executionPhase = step.fileEdits?.some(item => item.status === 'applied') ? 'finished' : 'not-started'
        step.status = 'failed'
        for (const item of step.fileEdits ?? []) if (item.status === 'dispatching') item.status = 'not-started'
      }
      activeHandle?.cancel(); activeSshHandle?.cancel()
      finishError(`检查点未能保存，已停止后续派发：${errorMessage(saved.error)}`, 'tool')
      return false
    }
    return !stopRequested
  }

  /** 用 setTimeout 实现循环侧超时,与命令结果、stop() 三方竞速;超时不终止命令。 */
  const raceCommandResult = async (handle: AgentCommandHandle): Promise<CommandWaitOutcome> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<CommandWaitOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), commandTimeoutMs)
    })
    try {
      return await Promise.race([
        handle.result.then(
          (result): CommandWaitOutcome => ({ kind: 'result', result }),
          (error): CommandWaitOutcome => ({ kind: 'error', error })
        ),
        timeout,
        stopPromise.then((): CommandWaitOutcome => ({ kind: 'stopped' }))
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** 解析 run_command 的 arguments;失败或 command 为空视为 invalid_arguments。 */
  const parseRunCommandArguments = (
    raw: string
  ): { ok: true; command: string; reason: string; affectedFiles?: string[] } | { ok: false; error: string } => {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      return { ok: false, error: `arguments 不是合法 JSON:${errorMessage(error)}` }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'arguments 必须是包含 command 的 JSON 对象' }
    }
    const record = parsed as Record<string, unknown>
    if (record.historyOnly) return { ok: false, error: '历史记录不能作为可执行参数，请根据当前现场提出新操作' }
    const command = typeof record.command === 'string' ? record.command.trim() : ''
    if (!command) return { ok: false, error: 'command 缺失或为空' }
    const reason = typeof record.reason === 'string' ? record.reason : ''
    return { ok: true, command, reason, affectedFiles: normalizeAgentFiles(record.files) }
  }

  /** 人工审批;返回 undefined 表示任务已在等待期间收尾(stop 或异常)。 */
  const requestManualApproval = async (
    step: AgentStep,
    suggestedPatterns: string[] | undefined
  ): Promise<AgentApprovalDecision | undefined> => {
    setStatus('awaiting-approval')
    if (!await checkpoint('prepared', step)) return undefined
    const proposal: AgentStepProposal = {
      id: step.id,
      command: step.command,
      toolName: step.toolName, fileRequest: step.fileRequest, fileResolvedPath: step.fileResolvedPath, fileRevision: step.fileRevision,
      sshRequest: step.sshRequest, sshTarget: step.sshTarget,
      fileEdits: step.fileEdits ? structuredClone(step.fileEdits) : undefined,
      reason: step.reason,
      risks: structuredClone(step.risks),
      sensitive: step.sensitive,
      suggestedPatterns: suggestedPatterns?.length ? [...suggestedPatterns] : undefined
    }
    const outcome = await raceWithStop(deps.requestApproval(proposal))
    if (outcome.kind === 'stopped') {
      finishStopped()
      return undefined
    }
    if (outcome.kind === 'error') {
      finishError(`审批流程异常:${errorMessage(outcome.error)}`, 'tool')
      return undefined
    }
    return outcome.value
  }

  /** 执行单个步骤:'continue' = 结果已回传可继续,'ended' = 任务已收尾。 */
  const executeStep = async (step: AgentStep, toolCallId: string): Promise<'continue' | 'ended'> => {
    setStatus('executing')
    step.status = 'running'
    step.executionPhase = 'not-started'
    const paths = deps.readFiles ? (step.affectedFiles ?? []).filter(path => !step.sensitive || fileTracker.values()?.some(change => change.requestedPaths.includes(path))) : []
    let transaction: ReturnType<typeof fileTracker.begin> | undefined
    const readFiles = async () => {
      if (step.sensitive) return paths.map(path => ({ requestedPath: path, path, scope: '', version: unavailableFile('后续敏感步骤不记录文件内容，无法核对最终变更') }))
      try { return await deps.readFiles!(paths, signal) }
      catch { return paths.map(path => ({ requestedPath: path, path, scope: '', version: unavailableFile('文件快照读取失败') })) }
    }
    if (paths.length) {
      notify()
      const before = await raceWithStop(readFiles())
      if (before.kind === 'stopped') { finishStopped('任务已停止，尚未派发修改命令。'); return 'ended' }
      if (before.kind === 'value') transaction = fileTracker.begin(step.id, before.value)
      state.fileChanges = fileTracker.values()
    }
    step.executionPhase = 'dispatching'
    step.startedAt = Date.now()
    notify()

    if (!await checkpoint('before-dispatch', step)) return 'ended'

    const startPromise = Promise.resolve().then(() => deps.startCommand(step.command))
    const startOutcome = await raceWithStop(startPromise)
    if (startOutcome.kind === 'stopped') {
      // stop() 时句柄可能尚未返回:拿到后补一次 cancel,放弃输出等待
      startPromise.then((handle) => handle.cancel()).catch(() => {})
      finishStopped()
      return 'ended'
    }
    if (startOutcome.kind === 'error') {
      transaction?.rollback()
      state.fileChanges = fileTracker.values()
      step.status = 'failed'
      step.executionPhase = 'not-started'
      step.failureReason = `命令启动失败:${errorMessage(startOutcome.error)}`
      finishError(step.failureReason, 'tool')
      return 'ended'
    }
    const handle = startOutcome.value
    activeHandle = handle
    if (!await checkpoint('observing', step)) return 'ended'

    // 输出静默采样(文档 10.3):只比对 peekOutput 的长度,超时时据此说明卡在哪。
    // 派发瞬间先取一次基线,否则"静默的旧输出"会在超时那一刻被误判成刚刚增长。
    let lastOutputLength = -1
    let lastOutputAt = Date.now()
    const sampleOutput = (): string => {
      let partial = ''
      try {
        partial = handle.peekOutput()
      } catch {
        // 捕获侧异常不应中断循环:按"无新输出"处理
        return ''
      }
      if (partial.length !== lastOutputLength) {
        lastOutputLength = partial.length
        lastOutputAt = Date.now()
      }
      if (partial && step.executionPhase === 'dispatching') {
        step.executionPhase = 'running'
        notify()
      }
      return partial
    }
    sampleOutput()
    const sampler = setInterval(sampleOutput, outputSampleIntervalMs)

    step.deadlineAt = Date.now() + commandTimeoutMs
    notify()

    try {
      let waitedMs = 0
      while (true) {
        const outcome = await raceCommandResult(handle)
        if (outcome.kind === 'stopped') {
          // stop() 已 cancel 句柄;命令仍留在终端,由用户接管
          step.deadlineAt = undefined
          finishStopped()
          return 'ended'
        }
        if (outcome.kind === 'error') {
          step.status = 'failed'
          step.deadlineAt = undefined
          step.failureReason = `等待命令结果异常:${errorMessage(outcome.error)}`
          finishError(step.failureReason, 'tool')
          return 'ended'
        }
        if (outcome.kind === 'timeout') {
          waitedMs += commandTimeoutMs
          const partial = sampleOutput()
          const partialOutput = partial.length > TIMEOUT_PARTIAL_OUTPUT_CHARS
            ? partial.slice(partial.length - TIMEOUT_PARTIAL_OUTPUT_CHARS)
            : partial
          const silentMs = Date.now() - lastOutputAt
          const outputGrowing = silentMs <= outputSampleIntervalMs
          const facts = {
            waitedMs,
            silentMs,
            partialOutput,
            outputGrowing,
            likelyInteractive: !outputGrowing && looksLikeInteractivePrompt(partialOutput)
          }
          const info: AgentTimeoutInfo = { ...facts, hint: describeTimeoutHint(facts) }
          setStatus('awaiting-user')
          const decision = await raceWithStop(deps.requestTimeoutDecision(structuredClone(step), info))
          if (decision.kind === 'stopped') {
            step.deadlineAt = undefined
            finishStopped()
            return 'ended'
          }
          if (decision.kind === 'error') {
            step.deadlineAt = undefined
            finishError(`超时决策异常:${errorMessage(decision.error)}`, 'tool')
            return 'ended'
          }
          if (decision.value === 'wait') {
            // 继续等待:回到 executing 并重新计时(倒计时随 deadlineAt 一起复位)
            step.deadlineAt = Date.now() + commandTimeoutMs
            setStatus('executing')
            notify()
            continue
          }
          // 用户选择停止:放弃等待(不终止命令),任务收尾为 stopped
          handle.cancel()
          step.status = 'timeout'
          step.deadlineAt = undefined
          // 已捕获的部分输出留在卡片上,否则超时步骤只剩一条命令
          if (!step.output && partialOutput) step.output = partialOutput
          notify()
          finishStopped('已停止等待命令结果；命令可能仍在终端运行。')
          return 'ended'
        }

        const result = outcome.result
        step.deadlineAt = undefined
        if (result.status === 'cancelled') {
          // cancel 由 stop() 主导,按 stopped 收尾
          finishStopped()
          return 'ended'
        }
        if (result.status === 'dispatch-failed') {
          transaction?.rollback()
          state.fileChanges = fileTracker.values()
          step.status = 'failed'
          step.executionPhase = 'not-started'
          step.failureReason = `命令派发失败:${result.failureReason ?? '未知原因'}`
          notify()
          finishError(step.failureReason, 'tool')
          return 'ended'
        }
        if (result.commandMismatch || result.completionUnconfirmed) {
          // Preserve the observed output without assigning another command's
          // exit status to this dispatch or treating it as manual-input proof.
          step.status = 'failed'
          step.executionPhase = 'running'
          step.output = result.output
          step.outputTruncated = result.truncated
          step.durationMs = result.durationMs
          step.startedAt = undefined
          step.failureReason = result.completionUnconfirmed
            ? 'Shell 已返回提示符，但没有收到完整的命令完成标记，无法确认本次执行结果。任务已停止，请核对终端输出。'
            : '终端返回的命令与 Agent 派发的内容不一致，无法确认本次执行结果。任务已停止，请核对终端输出。'
          notify()
          finishRun(() => {
            state.status = 'stopped'
            state.stopReason = step.failureReason
            state.error = step.failureReason
          })
          return 'ended'
        }
        step.status = 'completed'
        step.executionPhase = 'finished'
        step.output = result.output
        step.outputTruncated = result.truncated
        step.exitCode = result.exitCode
        step.durationMs = result.durationMs
        step.startedAt = undefined
        if (!await checkpoint('result', step)) return 'ended'
        if (transaction) {
          // The write is complete. A stopped/failed read leaves the result explicitly unknown.
          activeHandle = undefined
          clearInterval(sampler)
          const after = await raceWithStop(readFiles())
          if (after.kind === 'stopped') { finishStopped('命令已结束，文件变更快照尚未完成。'); return 'ended' }
          if (after.kind === 'value') transaction.finish(after.value)
          state.fileChanges = fileTracker.values()
        }
        notify()
        turns.push({
          kind: 'toolResult',
          toolCallId,
          content: JSON.stringify({
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            truncated: result.truncated,
            output: result.output
          })
        })
        return 'continue'
      }
    } finally {
      clearInterval(sampler)
      activeHandle = undefined
    }
  }

  const handleFileTool = async (toolCall: AiToolCall): Promise<'continue' | 'ended'> => {
    if (!isFileTool(toolCall.name)) return 'continue'
    const parsed = parseFileToolArguments(toolCall.name, toolCall.arguments)
    if (!parsed.ok) {
      parseFailureStreak += 1
      turns.push({ kind: 'toolResult', toolCallId: toolCall.id, content: JSON.stringify({ status: 'invalid_arguments', error: parsed.error }) })
      if (parseFailureStreak >= 2) { finishError(`模型连续 2 次给出无法解析的文件工具参数：${parsed.error}`, 'protocol'); return 'ended' }
      return 'continue'
    }
    parseFailureStreak = 0
    const step: AgentStep = { id: toolCall.id, toolName: toolCall.name, fileRequest: parsed.request, command: '', reason: parsed.reason || (toolCall.name === 'read_file' ? '读取文件' : '列出目录'), risks: [], sensitive: false, status: 'pending', executionPhase: 'not-started' }
    state.steps.push(step)
    setStatus('executing')
    notify()
    const fail = (error: unknown): 'continue' | 'ended' => {
      const detail = fileToolError(error)
      if (detail.kind === 'missing' && detail.absence) {
        const { baselineId: _baseline, ...absence } = detail.absence
        step.fileAbsence = absence
      }
      if (detail.kind === 'missing' && detail.absence?.baselineId) liveFileBaselines.set(detail.absence.path, detail.absence.baselineId)
      step.status = 'failed'; step.failureReason = detail.message
      step.executionPhase = step.executionPhase === 'not-started' ? 'not-started' : 'finished'
      step.startedAt = undefined
      notify()
      if (detail.kind === 'cancelled' || detail.kind === 'target-changed') { finishStopped(detail.message); return 'ended' }
      turns.push({ kind: 'toolResult', toolCallId: toolCall.id, content: JSON.stringify({ status: 'error', error: detail }) })
      return 'continue'
    }
    if (!deps.prepareFile || !deps.executeFile) return fail({ kind: 'unavailable', message: '文件工具通道尚未接入' })
    let operation: FileOperation | undefined
    try {
      if (!await checkpoint('prepared', step)) return 'ended'
      const prepared = await raceWithStop(deps.prepareFile(parsed.request, signal).then(value => {
        if (stopRequested) void deps.cancelFile?.(value).catch(() => {})
        return value
      }))
      if (prepared.kind === 'stopped') { finishStopped(); return 'ended' }
      if (prepared.kind === 'error') return fail(prepared.error)
      operation = prepared.value; activeFileOperation = operation
      step.sensitive = operation.sensitive; step.fileProvider = operation.provider; step.fileResolvedPath = operation.resolvedPath; step.fileRevision = operation.revision
      notify()
      if (operation.sensitive) {
        const decision = await requestManualApproval(step, undefined)
        if (decision === undefined) return 'ended'
        if (decision === 'stop') { finishStopped(); return 'ended' }
        if (decision === 'skip') {
          step.status = 'skipped'; notify()
          turns.push({ kind: 'toolResult', toolCallId: toolCall.id, content: JSON.stringify({ status: 'skipped_by_user' }) })
          return 'continue'
        }
        if (!deps.approveFile) return fail({ kind: 'sensitive-path', message: '文件审批通道尚未接入' })
        const approved = await raceWithStop(deps.approveFile(operation))
        if (approved.kind === 'stopped') { finishStopped(); return 'ended' }
        if (approved.kind === 'error') return fail(approved.error)
      } else { step.autoApproved = true }
      step.status = 'running'; step.executionPhase = 'running'; step.startedAt = Date.now(); setStatus('executing'); notify()
      if (!await checkpoint('before-dispatch', step)) return 'ended'
      const result = await raceWithStop(deps.executeFile(operation, signal))
      if (result.kind === 'stopped') { finishStopped('文件读取已取消，未接收迟到结果。'); return 'ended' }
      if (result.kind === 'error') return fail(result.error)
      step.fileResult = result.value; step.output = fileToolOutput(result.value)
      if (result.value.baselineId && result.value.tool === 'read_file') liveFileBaselines.set(result.value.path, result.value.baselineId)
      step.status = 'completed'; step.executionPhase = 'finished'; step.durationMs = Date.now() - step.startedAt; step.startedAt = undefined
      notify()
      turns.push({ kind: 'toolResult', toolCallId: toolCall.id, content: fileToolModelResult(result.value) })
      return 'continue'
    } finally {
      activeFileOperation = undefined
      if (operation) void deps.cancelFile?.(operation).catch(() => {})
    }
  }

  const handleFileEdit = async (toolCall: AiToolCall): Promise<'continue' | 'ended'> => {
    if (!isFileEditTool(toolCall.name)) return 'continue'
    let parsed: ReturnType<typeof parseFileEditArguments>
    try { parsed = parseFileEditArguments(toolCall.name, toolCall.arguments) } catch (error) {
      turns.push({ kind: 'toolResult', toolCallId: toolCall.id, content: JSON.stringify({ status: 'invalid_arguments', error: errorMessage(error) }) })
      if (++parseFailureStreak >= 2) { finishError('模型连续给出无效的文件修改参数', 'protocol'); return 'ended' }
      return 'continue'
    }
    parseFailureStreak = 0
    const items = parsed.files.map(() => ({ status: 'not-started' as const })) as NonNullable<AgentStep['fileEdits']>
    const step: AgentStep = { id: toolCall.id, toolName: toolCall.name, command: '', reason: parsed.reason || (toolCall.name === 'restore_file' ? '恢复文件修改' : '修改文件'), fileEdits: items, risks: [], sensitive: false, status: 'pending', executionPhase: 'not-started' }
    state.steps.push(step); setStatus('executing'); notify()
    const proposals: FileEditProposal[] = []
    activeFileEdits = proposals
    let current = 0
    const report = () => {
      // Completed edit arguments can contain several full files. Keep durable
      // change references in subsequent model context, not replayable content.
      toolCall.arguments = JSON.stringify({ historyOnly: true, files: items.map(item => ({ changeId: item.changeId, status: item.status })), note: '拟议全文保存在应用差异中；继续修改需重新完整读取。' })
      turns.push({ kind: 'toolResult', toolCallId: toolCall.id, content: fileEditModelResult(toolCall.name as import('../../domain/agentFileEdits').FileEditToolName, items) })
    }
    const fail = (error: unknown): 'continue' | 'ended' => {
      const detail = fileToolError(error)
      items[current].status = items[current].status === 'dispatching' ? 'unknown' : 'failed'
      items[current].error = detail.message
      step.status = 'failed'; step.failureReason = detail.message; step.startedAt = undefined
      for (const item of items) if (item.status === 'review') item.status = 'not-started'
      notify(); report()
      if (items.some(item => item.status === 'unknown') || detail.kind === 'target-changed' || detail.kind === 'cancelled') { finishStopped(detail.message); return 'ended' }
      return 'continue'
    }
    try {
      if (!deps.prepareFileEdit || !deps.approveFileEdit || !deps.executeFileEdit) return fail({ kind: 'unavailable', message: '文件编辑通道尚未接入' })
      for (current = 0; current < parsed.files.length; current++) {
        const prepared = await raceWithStop(deps.prepareFileEdit(parsed.files[current], signal).then(value => {
          if (stopRequested) void deps.cancelFileEdit?.(value).catch(() => {})
          return value
        }))
        if (prepared.kind === 'stopped') { finishStopped(); return 'ended' }
        if (prepared.kind === 'error') return fail(prepared.error)
        const proposal = prepared.value
        proposals.push(proposal)
        if (proposals.slice(0, -1).some(previous => previous.environmentScope === proposal.environmentScope && previous.resolvedPath === proposal.resolvedPath)) return fail({ kind: 'invalid-request', message: '同一实际文件不能在一批中重复修改，请合并补丁' })
        if (JSON.stringify(proposals[0].reference.target) !== JSON.stringify(proposal.reference.target)) return fail({ kind: 'target-changed', message: '整批文件修改必须属于同一执行目标' })
        items[current].view = fileEditView(proposal); items[current].status = 'review'
        step.sensitive ||= proposal.sensitive
        notify()
      }
      current = 0
      const decision = await requestManualApproval(step, undefined)
      if (decision === undefined) return 'ended'
      if (decision === 'stop') { for (const item of items) item.status = 'not-started'; finishStopped(); return 'ended' }
      if (decision === 'skip') { for (const item of items) item.status = 'skipped'; step.status = 'skipped'; notify(); report(); return 'continue' }
      // All proposals must receive their own exact backend approval before the
      // first write. No allowlist or persisted approval can authorize this path.
      for (current = 0; current < proposals.length; current++) {
        const approved = await raceWithStop(deps.approveFileEdit(proposals[current]))
        if (approved.kind === 'stopped') { finishStopped(); return 'ended' }
        if (approved.kind === 'error') return fail(approved.error)
      }
      for (const item of items) item.status = 'not-started'
      step.status = 'running'; step.executionPhase = 'dispatching'; step.startedAt = Date.now(); setStatus('executing')
      for (current = 0; current < proposals.length; current++) {
        const item = items[current]
        item.status = 'dispatching'; item.changeId = proposals[current].reference.id; notify()
        if (!await checkpoint('before-dispatch', step)) return 'ended'
        const result = await raceWithStop(deps.executeFileEdit(proposals[current], signal))
        if (result.kind === 'stopped' || stopRequested) {
          item.status = 'unknown'; item.error = '已停止观察，此文件的写入结果需重新核对'; step.status = 'failed'; step.failureReason = item.error
          finishStopped('文件写入结果未知；已完成项保留，后续文件未开始。'); return 'ended'
        }
        if (result.kind === 'error') return fail(result.error)
        item.outcome = result.value.outcome; item.changeId = result.value.id
        item.status = result.value.outcome.status === 'dispatching' ? 'unknown' : result.value.outcome.status
        item.error = result.value.outcome.error?.message
        notify()
        if (!await checkpoint('result', step)) return 'ended'
        if (item.status !== 'applied') {
          step.status = 'failed'; step.failureReason = item.error || '部分文件未完成写入'; step.startedAt = undefined
          if (item.status !== 'unknown') step.executionPhase = 'finished'
          notify(); report()
          if (item.status === 'unknown') { finishStopped('文件写入结果未知，已停止后续修改；请先核对当前文件。'); return 'ended' }
          return 'continue'
        }
      }
      step.durationMs = Date.now() - step.startedAt!; step.startedAt = undefined; step.status = 'completed'; step.executionPhase = 'finished'
      notify(); report(); return 'continue'
    } finally {
      activeFileEdits = []
      for (const proposal of proposals) void deps.cancelFileEdit?.(proposal).catch(() => {})
    }
  }

  const handleSshTask = async (toolCall: AiToolCall): Promise<'continue' | 'ended'> => {
    let parsed: ReturnType<typeof parseSshTaskArguments>
    try { parsed = parseSshTaskArguments(toolCall.arguments) } catch (error) {
      turns.push({ kind: 'toolResult', toolCallId: toolCall.id, content: JSON.stringify({ status: 'invalid_arguments', error: errorMessage(error) }) })
      if (++parseFailureStreak >= 2) { finishError('模型连续给出无效的独立任务参数', 'protocol'); return 'ended' }
      return 'continue'
    }
    parseFailureStreak = 0
    const step: AgentStep = { id: toolCall.id, toolName: 'run_ssh_task', command: parsed.request.command, sshRequest: parsed.request, reason: parsed.reason || '独立 SSH 任务', risks: [], sensitive: sensitiveSshTask(parsed.request), status: 'pending', executionPhase: 'not-started' }
    state.steps.push(step); notify()
    let intent: SshTaskIntent | undefined
    try {
      if (!deps.prepareSshTask || !deps.approveSshTask || !deps.startSshTask) throw new Error('当前连接不支持独立 SSH 任务')
      const prepared = await raceWithStop(deps.prepareSshTask(parsed.request).then(value => {
        if (stopRequested) void deps.cancelSshTask?.(value).catch(() => {})
        return value
      }))
      if (prepared.kind === 'stopped') { finishStopped(); return 'ended' }
      if (prepared.kind === 'error') throw prepared.error
      intent = prepared.value; activeSshIntent = intent
      step.sshTarget = intent.target; step.sshEnvironment = intent.effectiveEnvironment
      step.risks = commandPolicyRisks({ source: intent.request.command, analysis: intent.analysis }); notify()
      if (intent.analysis.decision === 'deny') throw new Error('独立任务被后端策略阻止')
      const decision = await requestManualApproval(step, undefined)
      if (decision === undefined) return 'ended'
      if (decision === 'stop') { finishStopped(); return 'ended' }
      if (decision === 'skip') {
        step.status = 'skipped'; notify()
        turns.push({ kind: 'toolResult', toolCallId: toolCall.id, content: JSON.stringify({ status: 'skipped_by_user' }) }); return 'continue'
      }
      const approved = await raceWithStop(deps.approveSshTask(intent))
      if (approved.kind === 'stopped') { finishStopped(); return 'ended' }
      if (approved.kind === 'error') throw approved.error
      step.status = 'running'; step.executionPhase = 'dispatching'; step.startedAt = Date.now(); setStatus('executing'); notify()
      if (!await checkpoint('before-dispatch', step)) return 'ended'
      const update = (snapshot: SshTaskSnapshot) => {
        if (finished || stopRequested) return
        step.sshResult = sshTaskResult(snapshot); step.output = sshTaskOutput(snapshot)
        if (snapshot.status === 'running') step.executionPhase = 'running'
        notify()
      }
      const starting = deps.startSshTask(intent, update)
      const started = await raceWithStop(starting)
      if (started.kind === 'stopped') { starting.then(handle => handle.cancel()).catch(() => {}); finishStopped('已停止观察；独立任务可能仍在远端运行。'); return 'ended' }
      if (started.kind === 'error') { step.executionPhase = 'not-started'; throw started.error }
      activeSshHandle = started.value
      if (!await checkpoint('observing', step)) return 'ended'
      const outcome = await raceWithStop(started.value.result)
      if (outcome.kind === 'stopped' || stopRequested) { finishStopped('已停止观察；独立任务可能仍在远端运行，请先核验实际状态。'); return 'ended' }
      if (outcome.kind === 'error') throw outcome.error
      const result = outcome.value
      update(result); step.startedAt = undefined
      step.durationMs = (result.finishedAt ?? Date.now()) - result.startedAt
      step.exitCode = result.exitCode ?? undefined
      if (result.status !== 'completed') {
        step.executionPhase = result.status === 'not-started' ? 'not-started' : 'running'
        throw new Error(result.reason || '独立任务结果未知，请先核验实际状态')
      }
      step.executionPhase = 'finished'; step.status = 'completed'; notify()
      turns.push({ kind: 'toolResult', toolCallId: toolCall.id, content: sshTaskModelResult(result, step.sshTarget) })
      return 'continue'
    } catch (error) {
      step.status = 'failed'; step.failureReason = errorMessage(error)
      finishError(step.failureReason, 'tool'); return 'ended'
    } finally {
      activeSshIntent = undefined; activeSshHandle = undefined
      if (intent) void deps.cancelSshTask?.(intent).catch(() => {})
    }
  }

  const reviewRecovery = async (summary: string): Promise<'continue' | 'ended'> => {
    if (!deps.requestRecoveryReview || !deps.confirmRecovery) { finishError('恢复核对确认通道未接入', 'tool'); return 'ended' }
    setStatus('awaiting-user')
    if (!await checkpoint('progress')) return 'ended'
    const review = await raceWithStop(deps.requestRecoveryReview({ recovery: structuredClone(state.recovery!), steps: structuredClone(state.steps), summary }))
    if (review.kind === 'stopped') { finishStopped('恢复检查已停止，未重放原任务操作。'); return 'ended' }
    if (review.kind === 'error') { finishError(errorMessage(review.error), 'tool'); return 'ended' }
    if (review.value.action === 'stop') { finishStopped('恢复检查已停止，未重放原任务操作。'); return 'ended' }
    if (review.value.action === 'inspect') { recoveryUserNote = review.value.note || '用户要求继续只读核对，尚未确认恢复执行。'; return 'continue' }
    const confirmed = await raceWithStop(deps.confirmRecovery(review.value.resolutions))
    if (confirmed.kind === 'stopped') { finishStopped(); return 'ended' }
    if (confirmed.kind === 'error') { finishError(`恢复确认失败：${errorMessage(confirmed.error)}`, 'tool'); return 'ended' }
    state.recovery = confirmed.value
    resolvedEffects.push(...confirmed.value.resolutions)
    recoveryUserNote = ''; recoveryBlockedCalls = 0; notify()
    return 'continue'
  }

  /** 处理一个 tool call:解析 → 审批路由(6.4)→ 执行/跳过,并把结果追加进轮次。 */
  const handleToolCall = async (toolCall: AiToolCall): Promise<'continue' | 'ended'> => {
    if (!takeToolBudget()) return 'ended'
    if (state.steps.some(step => step.id === toolCall.id)) {
      finishError('模型重复使用已有步骤 ID，已停止以避免重放历史操作。', 'protocol'); return 'ended'
    }
    if (state.recovery?.phase === 'inspecting' && (isFileEditTool(toolCall.name) || toolCall.name === 'run_ssh_task')) {
      turns.push({ kind: 'toolResult', toolCallId: toolCall.id, content: JSON.stringify({ status: 'recovery_read_only', error: '尚未确认恢复执行；请先读取文件或执行只读检查。旧允许项不能覆盖此限制。' }) })
      if (++recoveryBlockedCalls >= 3) { finishError('模型反复尝试在恢复核对完成前修改状态，已停止任务。', 'tool'); return 'ended' }
      return 'continue'
    }
    if (toolCall.name === 'update_plan' || toolCall.name === 'record_verification') {
      try {
        if (toolCall.name === 'update_plan') state.plan = updateAgentPlan(toolCall.arguments, state.plan, state.steps)
        else state.verifications = recordAgentVerification(toolCall.arguments, state.verifications ?? [], state.steps)
        parseFailureStreak = 0; notify()
        turns.push({ kind: 'toolResult', toolCallId: toolCall.id, content: agentTaskContext(state.plan, state.verifications ?? []) })
      } catch (error) {
        turns.push({ kind: 'toolResult', toolCallId: toolCall.id, content: JSON.stringify({ status: 'invalid_arguments', error: errorMessage(error) }) })
        if (++parseFailureStreak >= 2) { finishError('模型连续给出无效的计划或验证参数', 'protocol'); return 'ended' }
      }
      return 'continue'
    }
    if (toolCall.name === ASK_USER_TOOL_NAME) {
      let question = ''
      try {
        const args: unknown = JSON.parse(toolCall.arguments)
        if (args && typeof args === 'object' && 'question' in args && typeof args.question === 'string') {
          question = args.question.trim()
        }
      } catch { /* Invalid questions use the same bounded protocol retry as commands. */ }
      if (!question || new TextEncoder().encode(question).length > 8192) {
        parseFailureStreak += 1
        turns.push({ kind: 'toolResult', toolCallId: toolCall.id, content: JSON.stringify({
          status: 'invalid_arguments', error: 'ask_user 需要非空且不超过 8 KiB 的 question 字符串'
        }) })
        if (parseFailureStreak >= 2) {
          finishError('模型连续 2 次给出无法解析的工具参数:ask_user 缺少有效问题', 'protocol')
          return 'ended'
        }
        return 'continue'
      }
      if (state.recovery?.phase === 'inspecting') {
        const reviewed = await reviewRecovery(question)
        turns.push({ kind: 'toolResult', toolCallId: toolCall.id, content: JSON.stringify({ status: 'recovery_review', question }) })
        return reviewed
      }
      finishRun(() => {
        state.status = 'waiting-input'
        state.finalText = question
      })
      return 'ended'
    }
    if (isFileTool(toolCall.name)) return handleFileTool(toolCall)
    if (isFileEditTool(toolCall.name)) return handleFileEdit(toolCall)
    if (toolCall.name === 'run_ssh_task') return handleSshTask(toolCall)
    if (toolCall.name !== RUN_COMMAND_TOOL_NAME) {
      parseFailureStreak += 1
      const error = `不支持的工具:${toolCall.name || '(空名称)'}`
      turns.push({
        kind: 'toolResult',
        toolCallId: toolCall.id,
        content: JSON.stringify({ status: 'unsupported_tool', error })
      })
      if (parseFailureStreak >= 2) {
        finishError(`模型连续 2 次调用了不支持的工具:${toolCall.name || '(空名称)'}`, 'protocol')
        return 'ended'
      }
      return 'continue'
    }
    const parsed = parseRunCommandArguments(toolCall.arguments)
    if (!parsed.ok) {
      parseFailureStreak += 1
      turns.push({
        kind: 'toolResult',
        toolCallId: toolCall.id,
        content: JSON.stringify({ status: 'invalid_arguments', error: parsed.error })
      })
      if (parseFailureStreak >= 2) {
        finishError(`模型连续 2 次给出无法解析的工具参数:${parsed.error}`, 'protocol')
        return 'ended'
      }
      return 'continue'
    }
    parseFailureStreak = 0

    if (state.recovery?.phase === 'inspecting' && !classifyForAutoExec(parsed.command, { userPatterns: [], includeBuiltin: true }).eligible) {
      turns.push({ kind: 'toolResult', toolCallId: toolCall.id, content: JSON.stringify({ status: 'recovery_read_only', error: '恢复阶段只接受内置只读命令，不能使用用户允许项、脚本、解释器或修改命令。可使用 read_file/list_directory 核对文件。' }) })
      if (++recoveryBlockedCalls >= 3) { finishError('恢复核对命令反复包含无法确定的行为，已停止任务。', 'tool'); return 'ended' }
      return 'continue'
    }

    const classified = await raceWithStop(Promise.resolve().then(() => deps.classifyStep(parsed.command)))
    if (classified.kind === 'stopped') { finishStopped(); return 'ended' }
    if (classified.kind === 'error') { finishError(`命令分析失败：${errorMessage(classified.error)}`, 'tool'); return 'ended' }
    const classification = classified.value
    const step: AgentStep = {
      id: toolCall.id,
      command: parsed.command,
      reason: parsed.reason,
      ...(parsed.affectedFiles ? { affectedFiles: parsed.affectedFiles } : {}),
      risks: classification.risks,
      sensitive: classification.sensitive,
      status: 'pending',
      executionPhase: 'not-started'
    }
    state.steps.push(step)
    notify()

    if (classification.denied) {
      step.status = 'failed'
      step.failureReason = classification.denied
      finishError(classification.denied, 'tool')
      return 'ended'
    }

    let decision: AgentApprovalDecision
    let suggestedPatterns: string[] = []
    if (classification.sensitive || classification.risks.length > 0 || state.recovery?.phase === 'continuing') {
      // 硬门槛在前(6.4):敏感或有风险必须人工审批,且不提供「总是允许」
      const manual = await requestManualApproval(step, undefined)
      if (manual === undefined) return 'ended'
      decision = manual
    } else if (classification.autoExec.eligible) {
      // 只读判定通过:跳过 awaiting-approval 直接执行(4.3)
      step.autoApproved = true
      notify()
      decision = 'execute'
    } else {
      suggestedPatterns = classification.autoExec.suggestedPatterns
      const manual = await requestManualApproval(step, suggestedPatterns)
      if (manual === undefined) return 'ended'
      decision = manual
    }

    if (decision === 'stop') {
      // 不回传结果、不再调模型
      finishStopped()
      return 'ended'
    }
    if (decision === 'skip') {
      step.status = 'skipped'
      notify()
      turns.push({
        kind: 'toolResult',
        toolCallId: toolCall.id,
        content: JSON.stringify({ status: 'skipped_by_user' })
      })
      return 'continue'
    }
    if (decision === 'execute-and-allow' && suggestedPatterns.length) {
      // 先落地允许列表再执行,保证「总是允许」点击即持久化。
      // 多段命令需要补齐每一段,只写第一段会导致下次仍然要人工审批。
      const savePatterns = deps.onAllowPatterns
        ? deps.onAllowPatterns(suggestedPatterns, step.command)
        : suggestedPatterns.reduce<Promise<void>>(
          (previous, pattern) => previous.then(() => deps.onAllowPattern(pattern, step.command)),
          Promise.resolve()
        )
      const allowOutcome = await raceWithStop(Promise.resolve(savePatterns))
      if (allowOutcome.kind === 'stopped') {
        finishStopped()
        return 'ended'
      }
      if (allowOutcome.kind === 'error') {
        step.status = 'failed'
        step.failureReason = `保存授权失败：${errorMessage(allowOutcome.error)}`
        finishError(step.failureReason, 'tool')
        return 'ended'
      }
    }

    if (deps.authorizeStep) {
      const authorized = await raceWithStop(deps.authorizeStep(step.command, !step.autoApproved))
      if (authorized.kind === 'stopped') { finishStopped(); return 'ended' }
      if (authorized.kind === 'error') {
        step.status = 'failed'
        step.failureReason = `批准已失效或未能保存：${errorMessage(authorized.error)}`
        finishError(step.failureReason, 'tool')
        return 'ended'
      }
    }
    return executeStep(step, toolCall.id)
  }

  const run = async () => {
    notify()
    try {
      if (state.recovery?.phase === 'inspecting') {
        const paths = [...new Set(state.steps.filter(step => state.recovery!.requiredStepIds.includes(step.id)).flatMap(step => (step.fileEdits ?? []).map(item => item.view?.path ?? item.historyPath).filter((path): path is string => Boolean(path))))]
        for (const path of paths) {
          if (!takeToolBudget()) return
          const readCall = { id: `recovery-read-${Date.now()}-${state.steps.length}`, name: 'read_file', arguments: JSON.stringify({ path, maxBytes: 65536, maxLines: 65536, reason: '恢复前核对未知写入的当前文件' }) }
          turns.push({ kind: 'assistant', text: '', toolCalls: [readCall] })
          if (await handleFileTool(readCall) === 'ended') return
          if (!await checkpoint('result', state.steps[state.steps.length - 1])) return
        }
      }
      if (options.restoreChange) {
        if (!takeToolBudget()) return
        const readCall: AiToolCall = { id: `restore-read-${Date.now()}`, name: 'read_file', arguments: JSON.stringify({ path: options.restoreChange.path, maxBytes: 65536, maxLines: 65536, reason: '恢复前重新核对当前文件' }) }
        turns.push({ kind: 'assistant', text: '', toolCalls: [readCall] })
        if (await handleFileTool(readCall) === 'ended') return
        const baselineId = liveFileBaselines.get(options.restoreChange.path)
        if (!baselineId) {
          state.steps.push({ id: `restore-unavailable-${Date.now()}`, toolName: 'restore_file', command: '', reason: `恢复 ${options.restoreChange.path}`, risks: [], sensitive: false, status: 'failed', executionPhase: 'not-started', fileEdits: [{ status: 'not-started', error: '未取得完整、稳定的当前文件基线' }], failureReason: '未取得完整、稳定的当前文件基线，不能恢复。' })
          finishError('未取得完整、稳定的当前文件基线，不能恢复。', 'tool'); return
        }
        const restoreCall: AiToolCall = { id: `restore-write-${Date.now()}`, name: 'restore_file', arguments: JSON.stringify({ files: [{ baselineId, changeId: options.restoreChange.id }], reason: '恢复这次文件修改' }) }
        if (!takeToolBudget()) return
        turns.push({ kind: 'assistant', text: '', toolCalls: [restoreCall] })
        if (await handleFileEdit(restoreCall) === 'ended') return
        const restored = state.steps[state.steps.length - 1]
        if (restored.status === 'failed') { finishError(restored.failureReason || '文件恢复未完成。', 'tool'); return }
        finishRun(() => { state.status = 'done'; state.finalText = restored.status === 'skipped' ? '已跳过本次恢复。' : '已恢复这次文件修改，并重新读取核对文件内容。' })
        return
      }
      if (retryStep) {
        if (retryStep.commandRedacted) { finishError('历史命令已脱敏，请核对现场后重新发起任务', 'tool'); return }
        if (retryStep.toolName && isFileEditTool(retryStep.toolName)) {
          finishError('文件修改不能直接重试。请重新完整读取当前文件，再生成差异并审批。', 'tool'); return
        }
        if (retryStep.toolName === 'run_ssh_task' && options.retryStep?.executionPhase !== 'not-started') {
          finishError('不能重放结果未知或已派发的独立任务，请先核验远端状态后发起新任务。', 'tool'); return
        }
        turns.push({ kind: 'assistant', text: '', toolCalls: [toolCallFromStep(retryStep)] })
        // A retry is a fresh operation; saved risks and old approval are not authority.
        state.steps = state.steps.filter(step => step !== retryStep)
        const retryOutcome = await handleToolCall(toolCallFromStep(retryStep))
        if (retryOutcome === 'ended') return
      }

      while (true) {
        if (stopRequested) {
          finishStopped()
          return
        }
        if (modelTurns >= AGENT_RUN_BUDGET.modelTurns) {
          finishStopped(`本轮已完成 ${modelTurns} 次模型请求，已保存已有结果并停止后续操作。请核对进度后选择继续；未完成事项仍需处理。`)
          return
        }
        turns = compressAgentTurns(turns, maxTurnChars)
        setStatus('calling-model')
        if (!await checkpoint('progress')) return
        const taskContext = agentRunContext(state.plan, state.verifications ?? [], state.recovery, resolvedEffects, recoveryUserNote)
        modelTurns++
        const modelOutcome = await raceWithStop(deps.callModel(turns, signal, taskContext))
        if (modelOutcome.kind === 'stopped' || stopRequested) {
          // stop() 后不再使用模型结果
          finishStopped()
          return
        }
        if (modelOutcome.kind === 'error') {
          finishError(errorMessage(modelOutcome.error), 'model')
          return
        }
        const response = modelOutcome.value
        state.usage = addTokenUsage(state.usage, response.usage)
        if (response.toolCalls.length === 0) {
          if (state.recovery?.phase === 'inspecting') {
            if (await reviewRecovery(response.text) === 'ended') return
            continue
          }
          // 模型不再请求工具:text 即最终总结
          finishRun(() => {
            state.status = 'done'
            state.finalText = response.text
          })
          return
        }
        // A question takes precedence if a provider ignores parallel_tool_calls:
        // none of the commands in that response should run before the user replies.
        const questionCall = response.toolCalls.find(call => call.name === ASK_USER_TOOL_NAME)
        const toolCalls = questionCall ? [questionCall] : response.toolCalls
        turns.push({ kind: 'assistant', text: response.text, toolCalls })
        for (const toolCall of toolCalls) {
          if (stopRequested) {
            finishStopped()
            return
          }
          const outcome = await handleToolCall(toolCall)
          if (outcome === 'ended') return
          if (!await checkpoint('result', state.steps[state.steps.length - 1])) return
        }
      }
    } catch (error) {
      // 兜底:任何未归类异常都收敛为 error 终态,done 永不 reject
      const running = state.steps.find((step) => step.status === 'running')
      if (running) running.status = 'failed'
      finishError(errorMessage(error), 'protocol')
    }
  }

  const stop = () => {
    if (finished || stopRequested) return
    stopRequested = true
    signal.cancelled = true
    activeHandle?.cancel()
    activeSshHandle?.cancel()
    if (activeSshIntent) void deps.cancelSshTask?.(activeSshIntent).catch(() => {})
    if (activeFileOperation) void deps.cancelFile?.(activeFileOperation).catch(() => {})
    for (const proposal of activeFileEdits) void deps.cancelFileEdit?.(proposal).catch(() => {})
    resolveStopped()
  }

  void run()

  return { done, stop }
}
