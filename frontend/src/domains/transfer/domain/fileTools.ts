import type { ExecutionTarget, CommandIntent } from '../../../shared/security/commandPolicy'
import type { AgentFileEditService } from './fileEdits'

export interface FileReadOptions { startLine?: number; maxLines?: number; maxBytes?: number; tail?: boolean }
export type FileToolRequest =
  | { tool: 'read_file'; path: string; options?: FileReadOptions; cursor?: string | null }
  | { tool: 'list_directory'; path: string; limit?: number; cursor?: string | null }
export type FileProvider = 'local' | 'sftp' | 'current-terminal'
export interface FileOperationReference { id: string; target: ExecutionTarget }
export interface FileOperation { reference: FileOperationReference; request: FileToolRequest; provider: FileProvider; resolvedPath: string; revision: string; sensitive: boolean }
export interface FileCapturePlan { reference: FileOperationReference; intent: CommandIntent; maxOutputChars: number }
export type FileErrorKind = 'invalid-request' | 'missing' | 'permission-denied' | 'sensitive-path' | 'binary' | 'unsupported-encoding' | 'not-regular-file' | 'not-directory' | 'cancelled' | 'target-changed' | 'version-changed' | 'scan-limit' | 'unavailable' | 'transport'
export interface FileToolError { kind: FileErrorKind; message: string; absence?: { path: string; resolvedPath: string; environmentScope: string; baselineId?: string | null } }
export interface FilePosition { byte: number; line: number | null; midLine: boolean }
export type FileKind = 'file' | 'directory' | 'symlink' | 'other'
export type FileTruncation = 'bytes' | 'lines' | 'scan-budget' | 'tail-window'
interface FileResultBase { baselineId?: string | null; environmentScope: string; redacted?: boolean; provider: FileProvider; target: ExecutionTarget; path: string; resolvedPath: string; revision: string; changedDuringRead: boolean; nextCursor: string | null; sensitive: boolean; truncation: FileTruncation | null }
export type FileToolResponse = FileResultBase & (
  | { tool: 'read_file'; metadata: { kind: FileKind; size: number; modifiedNs: number | null; identity: string | null }; content: string; start: FilePosition; end: FilePosition; eof: boolean; complete: boolean; scannedBytes: number }
  | { tool: 'list_directory'; startFingerprint: string; endFingerprint: string; entries: { name: string; kind: FileKind; size: number | null }[]; scannedEntries: number; nextOffset: number | null }
)
export type FileDispatchOutcome = { kind: 'complete'; response: FileToolResponse } | { kind: 'terminal'; capture: FileCapturePlan }
export interface FileCancellation { readonly cancelled: boolean }
export interface AgentFileToolService {
  edits?: AgentFileEditService
  prepare(terminalId: string, generation: number, request: FileToolRequest, signal: FileCancellation): Promise<FileOperation>
  approve(operation: FileOperation): Promise<void>
  execute(terminalId: string, generation: number, operation: FileOperation, signal: FileCancellation): Promise<FileToolResponse>
  cancel(operation: FileOperation): Promise<unknown>
}
export function fileToolError(error: unknown): FileToolError {
  if (error && typeof error === 'object' && 'kind' in error && 'message' in error && typeof error.kind === 'string' && typeof error.message === 'string') return error as FileToolError
  return { kind: 'unavailable', message: error instanceof Error ? error.message : String(error) }
}
export function fileProviderLabel(provider: FileProvider) {
  return { local: '本地文件', sftp: 'SFTP · 已核对当前环境', 'current-terminal': '当前终端' }[provider]
}
