import type { AiProviderConfig } from './provider'



export const defaultAiConfig: AiProviderConfig = {
  id: 'default',
  provider: 'open-ai-compatible',
  baseUrl: '',
  model: '',
  apiKeyRef: '',
  apiKey: '',
  contextPolicy: 'selected-output-only',
  systemPrompt: 'You are an assistant for safe server operations.',
  riskPolicy: 'confirm-dangerous',
  timeoutSeconds: 0
}

export function cloneAiConfig(config: AiProviderConfig): AiProviderConfig {
  return JSON.parse(JSON.stringify(config)) as AiProviderConfig
}
