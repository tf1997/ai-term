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
}

const DEFAULT_STEP_LIMIT = 25
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
/** 低于后端 MAX_AGENT_TURN_CHARS(80k),保证前端先压缩而不是后端拒绝(文档 10.2)。 */
const DEFAULT_MAX_TURN_CHARS = 72_000
const DEFAULT_OUTPUT_SAMPLE_INTERVAL_MS = 2000
/** 压缩时最近保留的完整轮次数(文档 8);探索任务依赖较长证据链。 */
const PROTECTED_RECENT_TURNS = 6
/** 压缩时 Assistant 文本保留的字符数。 */
const COMPRESSED_ASSISTANT_TEXT_CHARS = 200
/** 压缩后仍保留的命令输出尾部字符数:报错通常在尾部,整体丢弃会让模型失忆。 */
const COMPRESSED_OUTPUT_TAIL_CHARS = 300
const OMITTED_OUTPUT_NOTE = '输出已省略'
const TRUNCATED_OUTPUT_NOTE = '仅保留输出尾部'

const INTERACTIVE_PROMPT_PATTERNS = [
  /\$ ?$/,
  /# ?$/,
  /> ?$/,
  /\[.*?\][\$#] ?$/,
  /password[^:]{0,20}:/i,
  /\(y\/n\) ?$/i
]

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

/**
 * 从已完成的步骤重建 turns 数组,供重试时恢复模型上下文。
 * 每个已完成步骤映射为一对 assistant + toolResult turn。
 */
function rebuildTurnsFromSteps(steps: AgentStep[]): AiAgentTurn[] {
  const turns: AiAgentTurn[] = []
  for (const step of steps) {
    if (step.status !== 'completed' && step.status !== 'skipped') continue

    // assistant turn: 模型发起工具调用
    turns.push({
      kind: 'assistant',
      text: '',
      toolCalls: [{
        id: step.id,
        name: 'bash',
        arguments: JSON.stringify({ command: step.command, reason: step.reason })
      }]
    })

    // toolResult turn: 工具执行结果
    const content = step.status === 'completed'
      ? step.output || ''
      : '[用户跳过此步骤]'

    turns.push({
      kind: 'toolResult',
      toolCallId: step.id,
      content
    })
  }
  return turns
}

/** 把一个包裹在 ``` 的代码块脱出;若不匹配则原样返回。 */
function unwrapCodeFence(text: string): string {
  const match = /^```(?:\w+)?\s*\n([\s\S]*?)\n```$/m.exec(text.trim())
  return match ? match[1] : text
}

/** 把命令转成可哈希的普通字符串(JSON.stringify 的转义干扰多段比对,直接拼)。 */
function commandKey(command: string): string {
  return command.trim().replace(/\s+/g, ' ')
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
 * 保留轮次结构(不删除轮次),避免 toolCall 找不到对应结果。
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

/** 对单个工具调用生成审批提案;执行统一流程(classifyStep → autoExec/人工审批)。 */
async function proposeAndApprove(
  tool: AiToolCall,
  deps: AgentLoopDeps,
  stopRequested: boolean
): Promise<{ decision: AgentApprovalDecision; proposal: AgentStepProposal }> {
  const args = JSON.parse(tool.arguments) as { command?: string; reason?: string }
  const command = unwrapCodeFence(args.command || '')
  const reason = args.reason || ''
  const classification = deps.classifyStep(command)

  const proposal: AgentStepProposal = {
    id: tool.id,
    command,
    reason,
    risks: classification.risks,
    sensitive: classification.sensitive,
    suggestedPatterns: classification.autoExec.suggestedPatterns
  }

  // stop 后所有审批直接跳过
  if (stopRequested) {
    return { decision: 'skip', proposal }
  }

  // 自动执行判定(6.4)
  if (classification.autoExec.eligible && classification.autoExec.matched) {
    return { decision: 'execute', proposal }
  }

  // 人工审批
  const decision = await deps.requestApproval(proposal)
  return { decision, proposal }
}

/**
 * 执行单个命令步骤(含超时轮询与用户决策)。
 * 返回完成的 AgentStep;超时停止时 status='timeout',用户跳过时 status='skipped'。
 */
async function executeStep(
  proposal: AgentStepProposal,
  deps: AgentLoopDeps,
  commandTimeoutMs: number,
  outputSampleIntervalMs: number,
  stopSignal: { stopped: boolean }
): Promise<AgentStep> {
  const step: AgentStep = {
    id: proposal.id,
    command: proposal.command,
    reason: proposal.reason,
    risks: proposal.risks,
    sensitive: proposal.sensitive,
    autoApproved: false,
    status: 'running'
  }

  const handle = await deps.startCommand(proposal.command)

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

  try {
    let waitedMs = 0
    while (true) {
      if (stopSignal.stopped) {
        step.status = 'timeout'
        step.deadlineAt = undefined
        return step
      }

      const result = await Promise.race([
        handle.result,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), commandTimeoutMs))
      ])

      if (result) {
        // 命令完成
        step.status = result.status === 'completed' && result.exitCode === 0 ? 'completed' : 'failed'
        step.output = result.output
        step.exitCode = result.exitCode
        step.durationMs = result.durationMs
        step.deadlineAt = undefined
        return step
      }

      // 超时:采样输出,生成 hint,请求用户决策
      waitedMs += commandTimeoutMs
      const partial = sampleOutput()
      const TIMEOUT_PARTIAL_OUTPUT_CHARS = 500
      const partialOutput =
        partial.length > TIMEOUT_PARTIAL_OUTPUT_CHARS
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

      step.deadlineAt = Date.now() + commandTimeoutMs
      const decision = await deps.requestTimeoutDecision(step, info)

      if (decision === 'wait') {
        // 用户选择继续等待
        continue
      } else {
        // 用户选择停止
        handle.cancel()
        step.status = 'timeout'
        step.output = partial
        step.deadlineAt = undefined
        return step
      }
    }
  } finally {
    clearInterval(sampler)
  }
}

/**
 * Agent 循环主入口:调度模型、审批、执行,直到完成、超限或 stop。
 * 返回 { done: Promise<AgentRunState>, stop(): void };done 在循环结束后 resolve,
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
  const initialSteps = options.initialSteps ?? []

  const state: AgentRunState = { status: 'calling-model', steps: [...initialSteps], finalText: '', stepLimit, commandTimeoutMs }
  let turns: AiAgentTurn[] = rebuildTurnsFromSteps(initialSteps)
  let stepsTaken = initialSteps.filter(s => s.status === 'completed' || s.status === 'skipped').length
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
  const stoppedPromise = new Promise<void>((resolve) => {
    resolveStopped = resolve
  })

  function stop() {
    if (finished) return
    stopRequested = true
    signal.cancelled = true
    activeHandle?.cancel()
    resolveStopped()
  }

  function emitState() {
    deps.onStateChange(structuredClone(state))
  }

  async function run() {
    emitState()

    while (!finished && !stopRequested) {
      // 预算检查
      if (stepsTaken >= stepLimit) {
        state.status = 'error'
        state.finalText = `已达步骤上限 ${stepLimit},任务终止。`
        finished = true
        emitState()
        break
      }

      // 轮次压缩(文档 8):超出预算时就地压缩,不删除轮次
      turns = compressAgentTurns(turns, maxTurnChars)

      // 调用模型
      state.status = 'calling-model'
      emitState()

      let response: AiAgentTurnResponse
      try {
        response = await deps.callModel(turns, signal)
      } catch (error) {
        if (stopRequested) {
          state.status = 'stopped'
          state.finalText = '任务已停止。'
          finished = true
          emitState()
          break
        }
        state.status = 'error'
        state.finalText = `模型调用失败: ${error instanceof Error ? error.message : String(error)}`
        state.error = error instanceof Error ? error.message : String(error)
        finished = true
        emitState()
        break
      }

      if (stopRequested) {
        state.status = 'stopped'
        state.finalText = '任务已停止。'
        finished = true
        emitState()
        break
      }

      // 记录 assistant turn
      turns.push({
        kind: 'assistant',
        text: response.text,
        toolCalls: response.toolCalls
      })

      // 无工具调用 → 完成
      if (!response.toolCalls || response.toolCalls.length === 0) {
        state.status = 'done'
        state.finalText = response.text
        finished = true
        emitState()
        break
      }

      // 处理工具调用
      const toolResults: Array<{ kind: 'toolResult'; toolCallId: string; content: string }> = []

      for (const tool of response.toolCalls) {
        if (tool.name !== 'bash') {
          // 非法工具
          parseFailureStreak++
          if (parseFailureStreak >= 3) {
            state.status = 'error'
            state.finalText = `模型连续 ${parseFailureStreak} 次返回非法工具调用,任务终止。`
            finished = true
            emitState()
            break
          }
          toolResults.push({
            kind: 'toolResult',
            toolCallId: tool.id,
            content: `错误:不支持的工具 ${tool.name}`
          })
          continue
        }

        parseFailureStreak = 0

        // 审批
        state.status = 'awaiting-approval'
        emitState()

        const { decision, proposal } = await proposeAndApprove(tool, deps, stopRequested)

        if (stopRequested) {
          state.status = 'stopped'
          state.finalText = '任务已停止。'
          finished = true
          emitState()
          break
        }

        if (decision === 'skip') {
          const step: AgentStep = {
            id: proposal.id,
            command: proposal.command,
            reason: proposal.reason,
            risks: proposal.risks,
            sensitive: proposal.sensitive,
            autoApproved: false,
            status: 'skipped'
          }
          state.steps.push(step)
          stepsTaken++
          emitState()

          toolResults.push({
            kind: 'toolResult',
            toolCallId: tool.id,
            content: '[用户跳过此步骤]'
          })
          continue
        }

        if (decision === 'stop') {
          state.status = 'stopped'
          state.finalText = '用户已停止任务。'
          finished = true
          emitState()
          break
        }

        // execute 或 execute-and-allow
        const classification = deps.classifyStep(proposal.command)
        if (decision === 'execute-and-allow') {
          const suggestedPatterns = proposal.suggestedPatterns || []
          for (const pattern of suggestedPatterns) {
            await deps.onAllowPattern(pattern, proposal.command)
          }
        }

        // 执行
        state.status = 'executing'
        const pendingStep: AgentStep = {
          id: proposal.id,
          command: proposal.command,
          reason: proposal.reason,
          risks: proposal.risks,
          sensitive: proposal.sensitive,
          autoApproved: decision === 'execute' && classification.autoExec.matched !== undefined,
          status: 'running',
          deadlineAt: Date.now() + commandTimeoutMs
        }
        state.steps.push(pendingStep)
        emitState()

        const completedStep = await executeStep(
          proposal,
          deps,
          commandTimeoutMs,
          outputSampleIntervalMs,
          { stopped: stopRequested }
        )

        // 更新 state 中的步骤
        const index = state.steps.findIndex(s => s.id === completedStep.id)
        if (index >= 0) {
          state.steps[index] = completedStep
        }

        if (completedStep.status === 'completed' || completedStep.status === 'failed') {
          stepsTaken++
        }

        emitState()

        toolResults.push({
          kind: 'toolResult',
          toolCallId: tool.id,
          content: completedStep.output || ''
        })

        if (stopRequested) {
          state.status = 'stopped'
          state.finalText = '任务已停止。'
          finished = true
          emitState()
          break
        }
      }

      if (finished) break

      // 记录 toolResult turn
      for (const result of toolResults) {
        turns.push(result)
      }
    }

    resolveDone(state)
  }

  void run()

  return { done, stop }
}
