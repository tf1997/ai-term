import { invoke } from '@tauri-apps/api/tauri'
import type { ExecutionTarget } from '../../../shared/security/commandPolicy'
import type { FileOperationReference } from '../domain/fileTools'
import type { FileChangeRecord, FileEditDispatchOutcome, FileEditProposal, FileEditRequest, FileRestoreRequest } from '../domain/fileEdits'

export const fileEditApi = {
  prepare: (expected: ExecutionTarget, request: FileEditRequest) => invoke<FileEditProposal>('prepare_agent_file_edit', { expected, request }),
  prepareRestore: (expected: ExecutionTarget, request: FileRestoreRequest) => invoke<FileEditProposal>('prepare_agent_file_restore', { expected, ...request }),
  approve: (proposal: FileEditProposal) => invoke<void>('approve_agent_file_edit', { reference: proposal.reference, reviewHash: proposal.reviewHash }),
  dispatch: (reference: FileOperationReference) => invoke<FileEditDispatchOutcome>('dispatch_agent_file_edit', { reference }),
  finishTerminal: (reference: FileOperationReference, output: string) => invoke<FileChangeRecord>('finish_agent_terminal_file_edit', { reference, output }),
  cancel: (reference: FileOperationReference) => invoke<boolean>('cancel_agent_file_operation', { reference }),
  getChange: (id: string) => invoke<FileChangeRecord | null>('get_agent_file_change', { id }),
  listChanges: (profileId: string, limit = 30) => invoke<FileChangeRecord[]>('list_agent_file_changes', { profileId, limit })
}
