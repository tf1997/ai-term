export type AuthMode = 'auto' | 'password' | 'key'
export type JumpMode = 'direct' | 'interactive-menu'
export type FileTransferMode =
  | 'auto'
  | 'sftp-direct'
  | 'sftp-gateway'
  | 'scp-through-terminal'
  | 'inline-small-file'
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

export interface AuthEndpoint {
  host: string
  port?: number
  username: string
  authMode: AuthMode
  credentialRef?: string
  password?: string
}

export interface ConnectionProfile {
  id: string
  name: string
  gateway: AuthEndpoint
  target: AuthEndpoint
  jumpMode: JumpMode
  menuProfileId: string
  fileTransferMode: FileTransferMode
}

export interface MenuStep {
  expect: string
  send: string
}

export interface MenuProfile {
  id: string
  name: string
  steps: MenuStep[]
  successPatterns: string[]
  failurePatterns: string[]
}

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
}

export interface SessionInfo {
  id: string
  profileId: string
  title: string
  connected: boolean
}
