import type { SftpFileEntry, SftpProbeResponse } from '../api'

export interface TerminalTargetIdentity {
  host: string
  ip: string
  username: string
  hostname: string
  pwd: string
  label: string
}

export interface SftpTarget {
  host: string
  username?: string
  label: string
  sourceLine: string
}

export interface PendingIdentityProbe {
  begin: string
  end: string
  useForSftp: boolean
  output: string
}

export interface SftpProbeState extends SftpProbeResponse {
  probing?: boolean
}

export interface TransferPanelState {
  currentPath: string
  pathDraft: string
  terminalRemotePath: string
  transferMode: 'sftp' | 'terminal'
  entries: SftpFileEntry[]
  selectedTarget: SftpTarget | null
  sftpProbeByHost: Record<string, SftpProbeState>
  currentTerminalTarget: TerminalTargetIdentity | null
  targetConnectionGeneration: number | null
  requiresExplicitBastionProbe: boolean
  bastionAutoProbeAttempted: boolean
  status: string
}

export interface RemoteDirectoryCacheEntry {
  path: string
  entries: SftpFileEntry[]
  cachedAt: number
}

export interface LoadDirectoryOptions {
  force?: boolean
  recordHistory?: boolean
}

export type TransferDirection = 'download' | 'upload'

export type TransferItemKind = 'file' | 'folder' | 'item'

export type TransferTaskState = 'running' | 'done' | 'error' | 'cancelled'

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

export interface FileContextMenuItem {
  id: string
  label: string
  danger?: boolean
  disabled?: boolean
  action: () => void
}

export interface FileContextMenuState {
  x: number
  y: number
  title: string
  items: FileContextMenuItem[]
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
}
