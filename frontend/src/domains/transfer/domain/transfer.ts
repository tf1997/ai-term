export interface SftpFileEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  permissions: string
  modified: string
}

export interface SftpProbeResponse {
  available: boolean
  path?: string
  message: string
  profileRoute?: string
}

export interface LoadDirectoryOptions {
  force?: boolean
  recordHistory?: boolean
}

export type TransferDirection = 'download' | 'upload'

export type TransferItemKind = 'file' | 'folder' | 'item'

export type TransferTaskState = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface ActiveTask {
  id: string
  label: string
  cancelling: boolean
  direction?: TransferDirection
  itemKind?: TransferItemKind
  itemName?: string
  sourcePath?: string
  targetPath?: string
  progressPercent?: number | null
  progressText?: string
  transferredBytes?: number
  totalBytes?: number
  bytesPerSecond?: number
  remainingSeconds?: number
  etaSeconds?: number
  estimatedCompletionEpochMs?: number
  elapsedSeconds?: number
  startedAt?: number
  completedAt?: number
  status?: TransferTaskState
}

export interface RemoteEditorState {
  name: string
  path: string
  content: string
  savedContent: string
  revision: string
  loading: boolean
  saving: boolean
  error: string
  target?: {
    connectionId: string
    stateKey: string
    generation: number
    epoch: number
    label: string
    override?: { targetHost?: string; targetUsername?: string; profileRoute?: string }
  }
}
