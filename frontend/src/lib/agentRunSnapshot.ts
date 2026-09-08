import type { AiProviderConfig } from '../types/profile'

interface AgentRunSnapshotInput {
  config: AiProviderConfig
  apiKey: string
  terminalSnapshot: string
  commandHistory: string[]
  conversationMessages: Array<{ role: 'user' | 'assistant'; content: string }>
  conversationSummary?: string
  allowlistPatterns: string[]
  builtinReadonlyEnabled: boolean
}

export function createAgentRunSnapshot(input: AgentRunSnapshotInput): AgentRunSnapshotInput {
  return {
    config: { ...input.config },
    apiKey: input.apiKey,
    terminalSnapshot: input.terminalSnapshot,
    commandHistory: [...input.commandHistory],
    conversationMessages: input.conversationMessages.map((message) => ({ ...message })),
    conversationSummary: input.conversationSummary,
    allowlistPatterns: [...input.allowlistPatterns],
    builtinReadonlyEnabled: input.builtinReadonlyEnabled
  }
}
