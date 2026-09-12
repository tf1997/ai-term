import type { AgentErrorKind, AgentStep } from './agent'
import type { AiMessageUsage } from './tokenUsage'


export interface WorkspaceSession {
  id: string
  /** Connection active when the global AI conversation was created. */
  connectionId: string
  name: string
  summary: string
  /** AI-compressed summary of conversation turns older than the recent window. */
  contextSummary?: string
  /** Id of the last conversation message covered by contextSummary. */
  contextSummaryLastMessageId?: string
  /** AI 面板模式(普通对话 / Agent),会话级持久化;缺省视为 chat。 */
  aiMode?: 'chat' | 'agent'
  createdAt: string
  updatedAt: string
}

export interface AiContextStatus {
  compressed: boolean
  chars: number
  history: number
}

export interface AiMessage {
  id: string
  /** Source connection for this turn; it does not control conversation visibility. */
  connectionId: string
  workspaceSessionId: string
  terminalId: string
  role: 'user' | 'assistant'
  text: string
  command?: string
  error?: boolean
  errorKind?: AgentErrorKind
  streaming?: boolean
  /** 产生该消息的模式;缺省视为 chat。 */
  mode?: 'chat' | 'agent'
  /** Agent 任务步骤时间线(运行时字段,持久化走 payloadJson)。 */
  agentSteps?: AgentStep[]
  agentStatus?: 'running' | 'done' | 'stopped' | 'error'
  stopReason?: string
  /** Agent 启动时绑定的终端连接代次；用于阻止重连后误执行旧任务。 */
  terminalConnectionGeneration?: number
  /** Agent 载荷序列化(与后端 payload_json 列对应)。 */
  payloadJson?: string
  /** 生成该回复消耗的 token(运行时字段,持久化走 payloadJson);网关未上报时缺省。 */
  usage?: AiMessageUsage
  createdAt: string
}
