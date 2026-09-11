export type AiProviderType =
  | 'open-ai-compatible'
  | 'open-ai'
  | 'company-gateway'
  | 'ollama'
  | 'custom-http'

export type ContextPolicy =
  | 'selected-output-only'
  | 'active-command-output'
  | 'manual-attachments'

export interface AiProviderConfig {
  id: string
  provider: AiProviderType
  baseUrl: string
  model: string
  apiKeyRef: string
  apiKey?: string
  contextPolicy: ContextPolicy
  systemPrompt: string
  riskPolicy: 'confirm-dangerous'
  timeoutSeconds: number
}
