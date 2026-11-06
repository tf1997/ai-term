import { invoke } from '@tauri-apps/api/tauri'
import type { ExecutionTarget } from '../../../shared/security/commandPolicy'
import type { FileCapturePlan, FileDispatchOutcome, FileOperation, FileOperationReference, FileToolRequest, FileToolResponse } from '../domain/fileTools'

export const fileToolApi = {
  inspect: (expected: ExecutionTarget, request: FileToolRequest) => invoke<FileCapturePlan>('prepare_agent_file_inspection', { expected, request }),
  finishInspection: (reference: FileOperationReference, output: string) => invoke<FileOperation>('finish_agent_file_inspection', { reference, output }),
  approve: (operation: FileOperation) => invoke<void>('approve_agent_file_operation', { reference: operation.reference, reviewedPath: operation.resolvedPath, reviewedRevision: operation.revision }),
  dispatch: (reference: FileOperationReference) => invoke<FileDispatchOutcome>('dispatch_agent_file_operation', { reference }),
  finishTerminal: (reference: FileOperationReference, output: string) => invoke<FileToolResponse>('finish_agent_terminal_file', { reference, output }),
  cancel: (reference: FileOperationReference) => invoke<boolean>('cancel_agent_file_operation', { reference })
}
