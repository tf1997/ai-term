import type { AiProviderConfig } from './provider'
import type { AiMessageUsage, AiTokenUsage } from './tokenUsage'
import type { ScriptRiskMatch } from '../../../shared/security/scriptRisk'

// Agent 模式共享类型。与后端 domain/ai/agent.rs 的 serde(camelCase)结构一一对应,
// 设计见 docs/ai-agent-mode-development.md 5.2 / 6.2 / 6.3 / 6.4。

/** 模型请求的一次工具调用;arguments 为原样 JSON 字符串,由前端解析。 */
export interface AiToolCall {
  id: string
  name: string
  arguments: string
}

/** 任务内的一个轮次(与后端 AiAgentTurn 的 tag=kind 序列化对应)。 */
export type AiAgentTurn =
  | { kind: 'assistant'; text: string; toolCalls: AiToolCall[] }
  | { kind: 'toolResult'; toolCallId: string; content: string }

export interface AiAgentTurnRequest {
  config: AiProviderConfig
  apiKey: string
  goal: string
  turns: AiAgentTurn[]
  terminalSnapshot: string
  commandHistory: string[]
  conversationMessages: { role: 'user' | 'assistant'; content: string }[]
  conversationSummary?: string
}

export interface AiAgentTurnResponse {
  text: string
  /** 空数组 = 模型认为任务完成。 */
  toolCalls: AiToolCall[]
  contextCompressed: boolean
  contextChars: number
  /** 本轮请求的 token 用量;网关未上报时缺省。 */
  usage?: AiTokenUsage
}

/** runCommandAndCapture 的最终结果。超时由循环层控制,不在此枚举内。 */
export interface AgentCommandResult {
  status: 'completed' | 'cancelled' | 'dispatch-failed'
  /** 截断后的命令输出(不含命令回显行与下一个提示符)。 */
  output: string
  exitCode?: number
  durationMs: number
  truncated: boolean
  /** 完成的命令与派发命令不一致(用户手动输入串扰),按执行失败处理。 */
  commandMismatch?: boolean
  /** dispatch-failed 时的原因说明。 */
  failureReason?: string
}

/** 执行句柄:超时决策留在循环层,cancel 只放弃等待、不终止命令。 */
export interface AgentCommandHandle {
  result: Promise<AgentCommandResult>
  /** 当前已捕获的输出(截断规则同最终输出),用于超时时上报部分输出。 */
  peekOutput(): string
  cancel(): void
}

export interface AgentCommandRunOptions {
  maxOutputChars?: number
  /** 防止旧任务在同一标签重连后误发到新的终端会话。 */
  connectionGeneration?: number
}

/**
 * 命令捕获方式。`markers` 为 OSC 133 语义标记;`sentinel` 为无标记终端(远端 SSH)
 * 的 printf 哨兵兜底(文档 10.3);`unsupported` 表示两者都不可用。
 */
export type AgentCaptureMode = 'markers' | 'sentinel' | 'unsupported'

export type AgentStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'skipped'
  | 'timeout'
  | 'failed'

export type AgentErrorKind = 'model' | 'tool' | 'protocol'

export type AgentExecutionPhase = 'not-started' | 'dispatching' | 'running' | 'finished'

export interface AgentStep {
  /** 即 tool_call_id。 */
  id: string
  command: string
  reason: string
  risks: ScriptRiskMatch[]
  sensitive: boolean
  autoApproved?: boolean
  status: AgentStepStatus
  /** Missing on older records when the actual execution phase is unknown. */
  executionPhase?: AgentExecutionPhase
  failureReason?: string
  output?: string
  exitCode?: number
  durationMs?: number
  /**
   * 下一次超时询问的时刻(epoch ms),供卡片倒计时;「继续等待」会把它推后。
   * 仅 running 期间有值,步骤结算时清除,因此不会进入持久化 payload。
   */
  deadlineAt?: number
}

export type AgentRunStatus =
  | 'calling-model'
  | 'awaiting-approval'
  | 'executing'
  | 'awaiting-user'
  | 'done'
  | 'stopped'
  | 'error'

export interface AgentRunState {
  status: AgentRunStatus
  steps: AgentStep[]
  finalText: string
  stepLimit: number
  /** 单条命令等待多久后询问用户(与 deadlineAt 配合显示倒计时)。 */
  commandTimeoutMs: number
  /** 本次运行内所有模型请求的累计用量;网关从未上报时缺省。 */
  usage?: AiMessageUsage
  error?: string
  errorKind?: AgentErrorKind
  /** Stopping observation does not terminate a command in the terminal. */
  stopReason?: string
}

export type AgentApprovalDecision = 'execute' | 'execute-and-allow' | 'skip' | 'stop'

/** 超时后的用户决策:继续等待或停止任务。 */
export type AgentTimeoutDecision = 'wait' | 'stop'

/**
 * 命令超时时的现场判断(文档 10.3):循环侧按 peekOutput 的增长情况给出依据,
 * 供卡片解释"为什么停在这里"而不是只报一个等待时长。
 */
export interface AgentTimeoutInfo {
  /** 本步骤累计等待时长(含此前的「继续等待」)。 */
  waitedMs: number
  /** 距最后一次观察到输出增长的时长;从未见输出时即为派发至今。 */
  silentMs: number
  /** 已捕获输出的尾部片段,供用户判断卡在哪。 */
  partialOutput: string
  /** 最近一个采样周期内仍有新输出。 */
  outputGrowing: boolean
  /** 输出静默且尾部形似输入提示符(密码、[y/N] 等)。 */
  likelyInteractive: boolean
  /** 面向用户的启发说明。 */
  hint: string
}

export interface AgentStepProposal {
  id: string
  command: string
  reason: string
  risks: ScriptRiskMatch[]
  sensitive: boolean
  /**
   * 「总是允许」需要补充的全部 pattern(多段命令会列出每个未覆盖段);
   * 仅无风险命中且非敏感时提供,为空/缺省表示不展示该按钮。
   */
  suggestedPatterns?: string[]
}

/** classifyForAutoExec 的判定结果。 */
export interface AgentAutoExecClassification {
  eligible: boolean
  /** 命中的允许来源(内置条目或用户 pattern)。 */
  matched?: string
  /**
   * 让该命令可自动执行仍需补充的 token 前缀 pattern(已覆盖的段不列出)。
   * 空数组 = 无法通过允许列表放行(一票否决),不应展示「总是允许」。
   */
  suggestedPatterns: string[]
}

/** 允许列表条目(与 agent_command_allowlist 表对应)。 */
export interface AgentAllowlistEntry {
  pattern: string
  sourceCommand: string
  createdAt: string
  lastUsedAt?: string
  useCount: number
}

export type AiPanelMode = 'chat' | 'agent'
