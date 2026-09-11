export type AuthMode = 'auto' | 'password' | 'key'

export type ConnectionRole = 'direct' | 'bastion'

export type JumpMode = 'direct' | 'interactive-menu'

export type FileTransferMode =
  | 'auto'
  | 'sftp-direct'
  | 'sftp-gateway'
  | 'scp-through-terminal'
  | 'inline-small-file'

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
  connectionRole: ConnectionRole
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

export interface SessionInfo {
  id: string
  profileId: string
  title: string
  connected: boolean
}
