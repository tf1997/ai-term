
import { invoke } from '@tauri-apps/api/tauri'








export interface TaskOptions {
  taskId?: string
}

export function cancelTask(taskId: string) {
  return invoke<boolean>('cancel_task', { taskId })
}
