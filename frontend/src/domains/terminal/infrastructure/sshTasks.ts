import { invoke } from '@tauri-apps/api/tauri'
import { listen } from '@tauri-apps/api/event'
import type { ExecutionTarget } from '../../../shared/security/commandPolicy'
import type { SshTaskIntent, SshTaskReference, SshTaskRequest, SshTaskSnapshot } from '../domain/sshTasks'

export const sshTaskApi = {
  prepare: (expected: ExecutionTarget, request: SshTaskRequest) => invoke<SshTaskIntent>('prepare_ssh_task', { expected, request }),
  approve: (intent: SshTaskIntent) => invoke<void>('approve_ssh_task', { reference: intent.reference, reviewed: intent.request, target: intent.target }),
  start: (reference: SshTaskReference) => invoke<SshTaskSnapshot>('start_ssh_task', { reference }),
  read: (reference: SshTaskReference) => invoke<SshTaskSnapshot>('read_ssh_task', { reference }),
  cancel: (reference: SshTaskReference) => invoke<boolean>('stop_observing_ssh_task', { reference }),
  listen: (reference: SshTaskReference, changed: () => void) => listen(`ssh-task:${reference.id}`, changed)
}
