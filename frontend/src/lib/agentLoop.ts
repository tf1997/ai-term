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
const DEFAULT_MAX_TURN_CHARS = 500_000
const DEFAULT_OUTPUT_SAMPLE_INTERVAL_MS = 2000

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

/** 从 maxTurnChars 推导压缩门限(文档 8 的「50% 触发、剩 25%」策略)。 */
function compactionThreshold(maxTurnChars: number): number {
  return Math.floor(maxTurnChars * 0.5)
}

/** 从 maxTurnChars 推导压缩后应保留的字符数量。 */
function compactionTarget(maxTurnChars: number): number {
  return Math.floor(maxTurnChars * 0.25)
}

/** 把 turns 压缩到目标长度(删除中段的 toolResult,保留首尾);返回新数组。 */
function compactTurns(turns: AiAgentTurn[], targetChars: number): AiAgentTurn[] {
  const total = sumTurnChars(turns)
  if (total <= targetChars) return turns

  // 保留前 1/3 与后 2/3 的 turn(按索引),中间的 toolResult 全删
  const keepHead = Math.max(1, Math.floor(turns.length / 3))
  const keepTail = turns.length - Math.floor(turns.length / 3)
  const compacted: AiAgentTurn[] = []
  for (let i = 0; i < turns.length; i++) {
    if (i < keepHead || i >= keepTail) {
      compacted.push(turns[i])
    } else if (turns[i].kind !== 'toolResult') {
      // assistant 保留,只删 toolResult
      compacted.push(turns[i])
    }
  }
  return compacted
}

function sumTurnChars(turns: AiAgentTurn[]): number {
  return turns.reduce((sum, turn) => sum + JSON.stringify(turn).length, 0)
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
  const handle = await deps.startCommand(proposal.command)
  let waitedMs = 0

  const step: AgentStep = {
    id: proposal.id,
    command: proposal.command,
    reason: proposal.reason,
    risks: proposal.risks,
    sensitive: proposal.sensitive,
    autoApproved: false,
    status: 'running',
    deadlineAt: Date.now() + commandTimeoutMs
  }

  // 轮询:命令结束或超时
  while (true) {
    if (stopSignal.stopped) {
      step.status = 'timeout'
      delete step.deadlineAt
      return step
    }

    const startWait = Date.now()
    const result = await Promise.race([
      handle.result,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), outputSampleIntervalMs))
    ])
    waitedMs += Date.now() - startWait

    if (result) {
      step.status = result.status === 'completed' && result.exitCode === 0 ? 'completed' : 'failed'
      step.output = result.output
      step.exitCode = result.exitCode
      step.durationMs = result.durationMs
      delete step.deadlineAt
      return step
    }

    if (waitedMs >= commandTimeoutMs) {
      // 超时:采样部分输出并请求决策
      const partialOutput = handle.peekOutput()
      const info: AgentTimeoutInfo = {
        waitedMs,
        silentMs: waitedMs,
        partialOutput: partialOutput.slice(-500),
        outputGrowing: false,
        likelyInteractive: /[:?]\s*$/.test(partialOutput),
        hint: waitedMs > commandTimeoutMs * 0.8
          ? `命令已静默 ${Math.round(waitedMs / 1000)}s,可能已卡住`
          : '命令仍在运行,可继续等待或停止任务'
      }

      step.deadlineAt = Date.now() + commandTimeoutMs
      const decision = await deps.requestTimeoutDecision(step, info)
      if (decision === 'wait') {
        waitedMs = 0
        step.deadlineAt = Date.now() + commandTimeoutMs
        continue
      } else {
        // stop
        handle.cancel()
        step.status = 'timeout'
        step.output = partialOutput
        delete step.deadlineAt
        return step
      }
    }
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

      // 轮次压缩(文档 8)
      const currentChars = sumTurnChars(turns)
      if (currentChars > compactionThreshold(maxTurnChars)) {
        turns = compactTurns(turns, compactionTarget(maxTurnChars))
      }

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
          const patterns = proposal.suggestedPatterns || []
          for (const pattern of patterns) {
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
