import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/tauri'






import type { TaskOptions } from '../../../shared/platform/tasks'
import type { SftpFileEntry, SftpProbeResponse } from '../domain/transfer'

export interface SftpListResponse {
  path: string
  entries: SftpFileEntry[]
}

export interface SftpTransferResponse {
  message: string
  localPath?: string
  remotePath?: string
  targetPath?: string
  isDir?: boolean
}

export interface SftpTransferEvent {
  taskId: string
  percent?: number
  text?: string
  transferredBytes?: number
  totalBytes?: number
  bytesPerSecond?: number
  remainingSeconds?: number
  etaSeconds?: number
  estimatedCompletionEpochMs?: number
  elapsedSeconds?: number
}


export interface RemoteTextFileResponse {
  path: string
  content: string
  revision: string
  size: number
}

export interface LocalFileEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  modified: string
}

export interface LocalDirectoryResponse {
  path: string
  home: string
  entries: LocalFileEntry[]
}

export interface BastionServerCandidate {
  host: string
  username?: string
  label: string
  sourceLine: string
}

export function localHomeDirectory() {
  return invoke<string>('local_home_directory')
}

export function localListRoots() {
  return invoke<string[]>('local_list_roots')
}

export function localListDirectory(path: string) {
  return invoke<LocalDirectoryResponse>('local_list_directory', { path })
}

export function localOpenPath(path: string) {
  return invoke<void>('local_open_path', { path })
}

export interface SftpTargetOverride {
  targetHost?: string
  targetUsername?: string
}

export function sftpListDirectory(connectionId: string, path: string, target?: SftpTargetOverride, options?: TaskOptions) {
  return invoke<SftpListResponse>('sftp_list_directory', { connectionId, path, ...target, ...options })
}

export function sftpProbe(connectionId: string, target?: SftpTargetOverride, options?: TaskOptions) {
  return invoke<SftpProbeResponse>('sftp_probe', { connectionId, ...target, ...options })
}

export function sftpCreateDirectory(connectionId: string, path: string, target?: SftpTargetOverride, options?: TaskOptions) {
  return invoke<SftpTransferResponse>('sftp_create_directory', { connectionId, path, ...target, ...options })
}

export function sftpDeletePath(connectionId: string, path: string, isDir: boolean, target?: SftpTargetOverride, options?: TaskOptions) {
  return invoke<SftpTransferResponse>('sftp_delete_path', { connectionId, path, isDir, ...target, ...options })
}

export function sftpUploadFile(connectionId: string, localPath: string, remoteDir: string, target?: SftpTargetOverride, options?: TaskOptions) {
  return invoke<SftpTransferResponse>('sftp_upload_file', { connectionId, localPath, remoteDir, ...target, ...options })
}

export function sftpUploadPath(connectionId: string, localPath: string, remoteDir: string, target?: SftpTargetOverride, options?: TaskOptions) {
  return invoke<SftpTransferResponse>('sftp_upload_path', { connectionId, localPath, remoteDir, ...target, ...options })
}

export function sftpDownloadFile(connectionId: string, remotePath: string, localPath: string, target?: SftpTargetOverride, options?: TaskOptions) {
  return invoke<SftpTransferResponse>('sftp_download_file', { connectionId, remotePath, localPath, ...target, ...options })
}

export function sftpDownloadPath(connectionId: string, remotePath: string, localDir: string, isDir: boolean, target?: SftpTargetOverride, options?: TaskOptions) {
  return invoke<SftpTransferResponse>('sftp_download_path', { connectionId, remotePath, localDir, isDir, ...target, ...options })
}

export function sftpReadTextFile(connectionId: string, remotePath: string, target?: SftpTargetOverride) {
  return invoke<RemoteTextFileResponse>('sftp_read_text_file', { connectionId, remotePath, ...target })
}

export function sftpSaveTextFile(
  connectionId: string,
  remotePath: string,
  content: string,
  expectedRevision: string,
  force: boolean,
  target?: SftpTargetOverride
) {
  return invoke<RemoteTextFileResponse>('sftp_save_text_file', {
    connectionId,
    remotePath,
    content,
    expectedRevision,
    force,
    ...target
  })
}

export function probeBastionServers(connectionId: string) {
  return invoke<BastionServerCandidate[]>('probe_bastion_servers', { connectionId })
}

export function sftpTransferEventName(taskId: string) {
  return `sftp:transfer:${taskId}`
}

export function onSftpTransferProgress(taskId: string, handler: (event: SftpTransferEvent) => void) {
  return listen<SftpTransferEvent>(sftpTransferEventName(taskId), (event) => handler(event.payload))
}

export function onTauriFileDrop(handler: (paths: string[]) => void) {
  return listen<string[]>('tauri://file-drop', (event) => handler(Array.isArray(event.payload) ? event.payload : []))
}

export function onTauriFileDropHover(handler: (paths: string[]) => void) {
  return listen<string[]>('tauri://file-drop-hover', (event) => handler(Array.isArray(event.payload) ? event.payload : []))
}

export function onTauriFileDropCancelled(handler: () => void) {
  return listen('tauri://file-drop-cancelled', () => handler())
}

export { cancelTask } from '../../../shared/platform/tasks'
