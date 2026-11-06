import type { ExecutionTarget } from '../../../shared/security/commandPolicy'
import type { FileCancellation, FileCapturePlan, FileOperationReference, FileProvider, FileToolError } from './fileTools'

export type FileChange = { action: 'replace'; content: string } | { action: 'patch'; replacements: Array<{ oldText: string; newText: string }> } | { action: 'delete' }
export interface FileEditRequest { baselineId: string; change: FileChange }
export interface FileRestoreRequest { baselineId: string; changeId: string }
export interface FileEditAttributes { mode: number; uid: number; gid: number; extendedMetadata?: boolean | null; metadataBackup?: { platform: string; xattrs: Record<string, string>; acl: string | null } | null }
export type FileWriteStrategy = 'atomic-replace' | 'in-place' | 'create-exclusive' | 'delete'
export interface FileEditView {
  target?: ExecutionTarget
  provider: FileProvider
  writeStrategy: FileWriteStrategy
  path: string
  resolvedPath: string
  environmentScope: string
  revision: string | null
  before: string | null
  after: string | null
  sensitive: boolean
  restoreOf: string | null
  restoreAttributes: FileEditAttributes | null
  redacted?: boolean
}
export interface FileEditProposal extends FileEditView { reference: FileOperationReference; reviewHash: string }
export type FileEditStatus = 'dispatching' | 'applied' | 'conflict' | 'failed' | 'unknown'
export interface FileEditOutcome {
  status: FileEditStatus
  revision: string | null
  contentHash: string | null
  beforeAttributes: FileEditAttributes | null
  afterAttributes: FileEditAttributes | null
  error: FileToolError | null
}
export interface FileChangeRecord {
  id: string
  target: ExecutionTarget
  provider: FileProvider
  writeStrategy: FileWriteStrategy
  path: string
  resolvedPath: string
  environmentScope: string
  before: string | null
  after: string | null
  sensitive: boolean
  restoreOf: string | null
  outcome: FileEditOutcome
  createdAt: number
}
export type FileEditDispatchOutcome = { kind: 'complete'; record: FileChangeRecord } | { kind: 'terminal'; capture: FileCapturePlan }
export interface AgentFileEditService {
  prepare(terminalId: string, generation: number, request: FileEditRequest, signal: FileCancellation): Promise<FileEditProposal>
  prepareRestore(terminalId: string, generation: number, request: FileRestoreRequest, signal: FileCancellation): Promise<FileEditProposal>
  approve(proposal: FileEditProposal): Promise<void>
  execute(terminalId: string, generation: number, proposal: FileEditProposal, signal: FileCancellation): Promise<FileChangeRecord>
  cancel(proposal: FileEditProposal): Promise<unknown>
  getChange(id: string): Promise<FileChangeRecord | null>
  listChanges(profileId: string, limit?: number): Promise<FileChangeRecord[]>
}
export function fileEditView(proposal: FileEditProposal): FileEditView {
  const { reference: _reference, reviewHash: _reviewHash, ...view } = proposal
  return { ...view, target: proposal.reference.target }
}
export function unknownFileChange(proposal: FileEditProposal, error: FileToolError): FileChangeRecord {
  const { reference, reviewHash: _hash, revision: _revision, restoreAttributes: _attrs, redacted: _redacted, ...view } = proposal
  return { ...view, id: reference.id, target: reference.target, createdAt: Date.now(), outcome: { status: 'unknown', revision: null, contentHash: null, beforeAttributes: null, afterAttributes: null, error } }
}
export function fileEditStatusLabel(status: FileEditStatus | 'not-started' | 'skipped' | 'review') {
  return { dispatching: '写入中', applied: '已写入并核对', conflict: '版本冲突', failed: '未写入', unknown: '结果未知', 'not-started': '未开始', skipped: '已跳过', review: '等待确认' }[status]
}
