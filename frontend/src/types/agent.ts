import type { AiProviderConfig } from './profile'
import type { ScriptRiskMatch } from '../lib/scriptRisk'

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

export type AgentStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'skipped'
  | 'timeout'
  | 'failed'

export interface AgentStep {
  /** 即 tool_call_id。 */
  id: string
  command: string
  reason: string
  risks: ScriptRiskMatch[]
  sensitive: boolean
  autoApproved?: boolean
  status: AgentStepStatus
  output?: string
  exitCode?: number
  durationMs?: number
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
  error?: string
}

export type AgentApprovalDecision = 'execute' | 'execute-and-allow' | 'skip' | 'stop'

/** 超时后的用户决策:继续等待或停止任务。 */
export type AgentTimeoutDecision = 'wait' | 'stop'

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
