import type { ConnectionProfile } from './profile'

export type TerminalRuntimeStatus = 'idle' | 'connecting' | 'local' | 'remote' | 'sftp' | 'preview' | 'error'

export interface TerminalTab {
  id: string
  title: string
  connectionId: string
  profile?: ConnectionProfile
  connectRequest: number
  status: TerminalRuntimeStatus
  connectionGeneration: number
}
