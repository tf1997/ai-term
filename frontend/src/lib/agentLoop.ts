import type {
  AgentApprovalDecision,
  AgentAutoExecClassification,
  AgentCommandHandle,
  AgentCommandResult,
  AgentRunState,
  AgentStep,
  AgentStepProposal,
  AgentTimeoutDecision,
  AgentTimeoutInfo,
  AiAgentTurn,
  AiAgentTurnResponse,
  AiToolCall
} from '../types/agent'
import type { ScriptRiskMatch } from './scriptRisk'

// Agent 循环编排器(任务 F3)。纯逻辑模块,不依赖 Vue/Tauri,全部外部能力经 AgentLoopDeps 注入。
// 状态机与数据流见 docs/ai-agent-mode-development.md 4.2/4.3,职责边界见 6.3;
// 审批顺序(敏感/风险 → 自动执行 → 人工)由 classifyStep 判定,本模块只消费其结果(6.4);
// 轮次预算与压缩策略见文档 8。

export interface AgentLoopDeps {
  /** 请求模型一轮决策;stop() 后 signal.cancelled 变 true,实现方应尽快返回(结果会被丢弃)。 */
  callModel(turns: AiAgentTurn[], signal: { readonly cancelled: boolean }): Promise<AiAgentTurnResponse>
  /** 派发命令并返回执行句柄;超时判断留在循环侧,cancel 只放弃等待、不终止命令。 */
  startCommand(command: string): AgentCommandHandle | Promise<AgentCommandHandle>
  /** 风险/敏感/自动执行三合一判定(6.4),顺序语义由循环执行。 */
  classifyStep(command: string): { risks: ScriptRiskMatch[]; sensitive: boolean; autoExec: AgentAutoExecClassification }
  /** 人工审批;stop() 后未决的审批结果作废。 */
  requestApproval(proposal: AgentStepProposal): Promise<AgentApprovalDecision>
  /** 命令超时后的用户决策:继续等待或停止任务;info 给出静默/交互等待的判断依据。 */
  requestTimeoutDecision(step: AgentStep, info: AgentTimeoutInfo): Promise<AgentTimeoutDecision>
  /** 「总是允许」:把 pattern 写入允许列表(先落地再执行)。 */
  onAllowPattern(pattern: string, sourceCommand: string): void | Promise<void>
  /** 每次状态变化的快照回调;收到的是结构化克隆,可安全渲染/暂存。 */
  onStateChange(state: AgentRunState): void
}

export interface AgentLoopOptions {
  stepLimit?: number
  commandTimeoutMs?: number
  maxTurnChars?: number
  /** 执行期间轮询 peekOutput 的周期,用于判断输出是否静默。 */
  outputSampleIntervalMs?: number
  /** 重试时已完成的步骤;循环会从这些步骤继续,恢复 turns 数组和计数。 */
  initialSteps?: AgentStep[]
  /** 用户点击重试时需要直接重新执行的失败步骤。 */
  retryStep?: AgentStep
}

const DEFAULT_STEP_LIMIT = 25
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
/** 采样只比对字符串长度,周期可以密一些而不影响性能。 */
const DEFAULT_OUTPUT_SAMPLE_INTERVAL_MS = 2_000
/** 超时提示里展示的部分输出尾部长度。 */
const TIMEOUT_PARTIAL_OUTPUT_CHARS = 500
/** 低于后端 MAX_AGENT_TURN_CHARS(80k),保证前端先压缩而不是后端拒绝(文档 10.2)。 */
const DEFAULT_MAX_TURN_CHARS = 72_000
/** 压缩时最近保留的完整轮次数(文档 8);探索任务依赖较长证据链。 */
const PROTECTED_RECENT_TURNS = 6
/** 压缩时 Assistant 文本保留的字符数。 */
const COMPRESSED_ASSISTANT_TEXT_CHARS = 200
/** 压缩后仍保留的命令输出尾部字符数:报错通常在尾部,整体丢弃会让模型失忆。 */
const COMPRESSED_OUTPUT_TAIL_CHARS = 300
const OMITTED_OUTPUT_NOTE = '输出已省略'
const TRUNCATED_OUTPUT_NOTE = '仅保留输出尾部'
const RUN_COMMAND_TOOL_NAME = 'run_command'

function toolCallFromStep(step: AgentStep): AiToolCall {
  return {
    id: step.id,
    name: RUN_COMMAND_TOOL_NAME,
    arguments: JSON.stringify({ command: step.command, reason: step.reason })
  }
}

/** 把重试前已完成的步骤还原成符合 OpenAI 工具协议的轮次。 */
function rebuildTurnsFromSteps(steps: AgentStep[]): AiAgentTurn[] {
  return steps.flatMap((step): AiAgentTurn[] => {
    const toolCall = toolCallFromStep(step)
    const content = step.status === 'skipped'
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
 */
function compressToolResultContent(content: string): string {
  let exitCode: number | undefined
  let output: string | undefined
  try {
    const parsed: unknown = JSON.parse(content)
    if (parsed && typeof parsed === 'object') {
      const record = parsed as { exitCode?: unknown; output?: unknown }
      if (typeof record.exitCode === 'number') exitCode = record.exitCode
      if (typeof record.output === 'string') output = record.output
    }
  } catch {
    // 原 content 不是 JSON:退化为仅保留省略说明
  }

  const tail = output && output.length > COMPRESSED_OUTPUT_TAIL_CHARS
    ? output.slice(output.length - COMPRESSED_OUTPUT_TAIL_CHARS)
    : output
  const payload: Record<string, unknown> = {}
  if (exitCode !== undefined) payload.exitCode = exitCode
  if (tail) {
    payload.output = tail
    payload.note = tail === output ? OMITTED_OUTPUT_NOTE : TRUNCATED_OUTPUT_NOTE
  } else {
    payload.note = OMITTED_OUTPUT_NOTE
  }
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

  const compressed = turns.slice()
  const protectedFrom = Math.max(0, compressed.length - PROTECTED_RECENT_TURNS)
  for (let index = 0; index < protectedFrom && total > maxTurnChars; index += 1) {
    const turn = compressed[index]
    let next: AiAgentTurn | undefined
    if (turn.kind === 'toolResult') {
      const content = compressToolResultContent(turn.content)
      // 占位比原文还长时保持原样,避免"压缩"反而膨胀
      if (content.length < turn.content.length) next = { ...turn, content }
    } else if (turn.text.length > COMPRESSED_ASSISTANT_TEXT_CHARS) {
      next = { ...turn, text: turn.text.slice(0, COMPRESSED_ASSISTANT_TEXT_CHARS) }
    }
    if (!next) continue
    total += turnChars(next) - turnChars(turn)
    compressed[index] = next
  }
  return compressed
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

  const stepLimit = options.stepLimit ?? DEFAULT_STEP_LIMIT
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  const maxTurnChars = options.maxTurnChars ?? DEFAULT_MAX_TURN_CHARS
  const outputSampleIntervalMs = options.outputSampleIntervalMs ?? DEFAULT_OUTPUT_SAMPLE_INTERVAL_MS
  const initialSteps = (options.initialSteps ?? [])
    .filter((step) => step.status === 'completed' || step.status === 'skipped')
    .map((step) => structuredClone(step))
  const retryStep = options.retryStep?.status === 'failed'
    ? {
        ...structuredClone(options.retryStep),
        status: 'pending' as const,
        output: undefined,
        exitCode: undefined,
        durationMs: undefined,
        deadlineAt: undefined
      }
    : undefined

  const state: AgentRunState = {
    status: retryStep ? 'executing' : 'calling-model',
    steps: retryStep ? [...initialSteps, retryStep] : initialSteps,
    finalText: '',
    stepLimit,
    commandTimeoutMs
  }
  let turns = rebuildTurnsFromSteps(initialSteps)
  let stepsTaken = initialSteps.length
  let parseFailureStreak = 0
  let finished = false
  let stopRequested = false
  let activeHandle: AgentCommandHandle | undefined

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
    notify()
    resolveDone(structuredClone(state))
  }

  const finishStopped = () => {
    finishRun(() => {
      state.status = 'stopped'
    })
  }

  const finishError = (message: string, errorKind: NonNullable<AgentRunState['errorKind']>) => {
    finishRun(() => {
      state.status = 'error'
      state.error = message
      state.errorKind = errorKind
    })
  }

  const finishStepLimit = () => {
    finishRun(() => {
      const note = `已达到 ${stepLimit} 步上限,任务未确认完成;可在下一条消息里让 Agent 接着排查`
      state.finalText = state.finalText ? `${state.finalText}\n${note}` : note
      state.status = 'stopped'
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
  ): { ok: true; command: string; reason: string } | { ok: false; error: string } => {
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
    const command = typeof record.command === 'string' ? record.command.trim() : ''
    if (!command) return { ok: false, error: 'command 缺失或为空' }
    const reason = typeof record.reason === 'string' ? record.reason : ''
    return { ok: true, command, reason }
  }

  /** 人工审批;返回 undefined 表示任务已在等待期间收尾(stop 或异常)。 */
  const requestManualApproval = async (
    step: AgentStep,
    suggestedPatterns: string[] | undefined
  ): Promise<AgentApprovalDecision | undefined> => {
    setStatus('awaiting-approval')
    const proposal: AgentStepProposal = {
      id: step.id,
      command: step.command,
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
    notify()

    const startPromise = Promise.resolve(deps.startCommand(step.command))
    const startOutcome = await raceWithStop(startPromise)
    if (startOutcome.kind === 'stopped') {
      // stop() 时句柄可能尚未返回:拿到后补一次 cancel,放弃输出等待
      startPromise.then((handle) => handle.cancel()).catch(() => {})
      finishStopped()
      return 'ended'
    }
    if (startOutcome.kind === 'error') {
      step.status = 'failed'
      finishError(`命令启动失败:${errorMessage(startOutcome.error)}`, 'tool')
      return 'ended'
    }
    const handle = startOutcome.value
    activeHandle = handle

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
          finishError(`等待命令结果异常:${errorMessage(outcome.error)}`, 'tool')
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
          finishStopped()
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
          step.status = 'failed'
          notify()
          finishError(`命令派发失败:${result.failureReason ?? '未知原因'}`, 'tool')
          return 'ended'
        }
        if (result.commandMismatch) {
          // 完成的命令与派发命令不一致:用户手动输入串扰(6.2),停止任务并交还终端
          step.status = 'failed'
          notify()
          finishRun(() => {
            state.status = 'stopped'
            state.error = '检测到用户手动输入与 Agent 命令串扰,任务已停止并交还终端'
          })
          return 'ended'
        }
        step.status = 'completed'
        step.output = result.output
        step.exitCode = result.exitCode
        step.durationMs = result.durationMs
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

  /** 处理一个 tool call:解析 → 审批路由(6.4)→ 执行/跳过,并把结果追加进轮次。 */
  const handleToolCall = async (toolCall: AiToolCall): Promise<'continue' | 'ended'> => {
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

    const classification = deps.classifyStep(parsed.command)
    const step: AgentStep = {
      id: toolCall.id,
      command: parsed.command,
      reason: parsed.reason,
      risks: classification.risks,
      sensitive: classification.sensitive,
      status: 'pending'
    }
    state.steps.push(step)
    notify()

    let decision: AgentApprovalDecision
    let suggestedPatterns: string[] = []
    if (classification.sensitive || classification.risks.length > 0) {
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
      stepsTaken += 1
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
      for (const pattern of suggestedPatterns) {
        const allowOutcome = await raceWithStop(Promise.resolve(deps.onAllowPattern(pattern, step.command)))
        if (allowOutcome.kind === 'stopped') {
          finishStopped()
          return 'ended'
        }
        if (allowOutcome.kind === 'error') {
          finishError(`写入允许列表失败:${errorMessage(allowOutcome.error)}`, 'tool')
          return 'ended'
        }
      }
    }

    stepsTaken += 1
    return executeStep(step, toolCall.id)
  }

  const run = async () => {
    notify()
    try {
      if (retryStep) {
        turns.push({ kind: 'assistant', text: '', toolCalls: [toolCallFromStep(retryStep)] })
        stepsTaken += 1
        const retryOutcome = await executeStep(retryStep, retryStep.id)
        if (retryOutcome === 'ended') return
      }

      while (true) {
        if (stopRequested) {
          finishStopped()
          return
        }
        if (stepsTaken >= stepLimit) {
          // 模型仍要继续请求,但步数预算已用完
          finishStepLimit()
          return
        }
        turns = compressAgentTurns(turns, maxTurnChars)
        setStatus('calling-model')
        const modelOutcome = await raceWithStop(deps.callModel(turns, signal))
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
        if (response.toolCalls.length === 0) {
          // 模型不再请求工具:text 即最终总结
          finishRun(() => {
            state.status = 'done'
            state.finalText = response.text
          })
          return
        }
        // Assistant 轮次在首个 toolCall 前记录一次,含 text 与全部 toolCalls
        turns.push({ kind: 'assistant', text: response.text, toolCalls: response.toolCalls })
        for (const toolCall of response.toolCalls) {
          if (stopRequested) {
            finishStopped()
            return
          }
          if (stepsTaken >= stepLimit) {
            // 已达上限但仍有待处理的 tool call
            finishStepLimit()
            return
          }
          const outcome = await handleToolCall(toolCall)
          if (outcome === 'ended') return
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
    resolveStopped()
  }

  void run()

  return { done, stop }
}
