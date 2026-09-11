import { ref, computed, onBeforeUnmount } from 'vue'
import type { Ref } from 'vue'
import type { ActiveTask } from '../domain/transfer'
import type { SftpTransferEvent, SftpTransferResponse } from '../infrastructure/api'
import { transferActionLabel, numericOr, formatError } from '../domain/transferPresentation'
import * as tauri from '../infrastructure/api'

interface TransferTaskOptions {
  loading: Ref<boolean>
  status: Ref<string>
  error: Ref<string>
  remoteReady: () => boolean
  remoteRequestEpoch: () => number
  connectionGeneration: () => number
  transferStateKey: () => string
  isCurrentRemoteRequest: (epoch: number, stateKey: string, generation: number) => boolean
}
type TransferTaskSource = Pick<typeof tauri, 'onSftpTransferProgress' | 'cancelTask'>

export function useTransferTasks(options: TransferTaskOptions, source: TransferTaskSource = tauri) {
  const { loading, status, error, remoteReady, remoteRequestEpoch, connectionGeneration, transferStateKey, isCurrentRemoteRequest } = options
  const { onSftpTransferProgress, cancelTask } = source
  let disposed = false
  const activeTask = ref<ActiveTask | null>(null)

  const lastTransfer = ref<ActiveTask | null>(null)

  const taskInProgress = computed(() => Boolean(activeTask.value))

  const activeTransferTask = computed(() => (activeTask.value?.direction ? activeTask.value : null))

  function cancelActiveRemoteTaskForStateChange() {
    const task = activeTask.value
    if (!task) return
    if (!task.cancelling) {
      task.cancelling = true
      void cancelTask(task.id).catch(() => {})
    }
    activeTask.value = null
    loading.value = false
  }

  async function runTransfer(
    label: string,
    action: (taskId: string) => Promise<SftpTransferResponse>,
    details: Partial<ActiveTask> = {}
  ) {
    if (disposed || !remoteReady()) return null
    const operationEpoch = remoteRequestEpoch()
    const operationStateKey = transferStateKey()
    const operationGeneration = connectionGeneration()
    const taskId = startRemoteTask(label, details)
    if (!taskId) return null
    let unlisten: (() => void) | null = null
    loading.value = true
    error.value = ''
    status.value = label
    try {
      if (details.direction) {
        unlisten = await onSftpTransferProgress(taskId, (event) => updateTransferProgress(taskId, event))
      }
      if (
        disposed ||
        activeTask.value?.id !== taskId ||
        !remoteReady() ||
        !isCurrentRemoteRequest(operationEpoch, operationStateKey, operationGeneration)
      ) return null
      const response = await action(taskId)
      if (disposed || !isCurrentRemoteRequest(operationEpoch, operationStateKey, operationGeneration)) return null
      completeTransferTask(taskId, response)
      if (!details.direction) status.value = response.message
      return response
    } catch (err) {
      if (disposed || !isCurrentRemoteRequest(operationEpoch, operationStateKey, operationGeneration)) return null
      recordTransferFailure(taskId, err)
      handleTaskError(err)
      return null
    } finally {
      unlisten?.()
      finishRemoteTask(taskId)
    }
  }

  function startRemoteTask(label: string, details: Partial<ActiveTask> = {}) {
    if (activeTask.value) {
      status.value = `已有任务进行中：${activeTask.value.label}`
      return ''
    }
    const id = `sftp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    if (details.direction) lastTransfer.value = null
    activeTask.value = {
      ...details,
      id,
      label,
      cancelling: false,
      progressPercent: details.direction ? 0 : details.progressPercent,
      startedAt: Date.now(),
      status: details.direction ? 'running' : details.status
    }
    loading.value = true
    return id
  }

  function updateTransferProgress(taskId: string, event: SftpTransferEvent) {
    const task = activeTask.value
    if (!task || task.id !== taskId) return
    const percent = typeof event.percent === 'number' ? Math.max(0, Math.min(100, Math.round(event.percent))) : task.progressPercent
    activeTask.value = {
      ...task,
      progressPercent: percent,
      progressText: event.text || task.progressText,
      transferredBytes: numericOr(event.transferredBytes, task.transferredBytes),
      totalBytes: numericOr(event.totalBytes, task.totalBytes),
      bytesPerSecond: numericOr(event.bytesPerSecond, task.bytesPerSecond),
      remainingSeconds: numericOr(event.remainingSeconds, task.remainingSeconds),
      etaSeconds: numericOr(event.etaSeconds, task.etaSeconds),
      estimatedCompletionEpochMs: numericOr(event.estimatedCompletionEpochMs, task.estimatedCompletionEpochMs),
      elapsedSeconds: numericOr(event.elapsedSeconds, task.elapsedSeconds)
    }
  }

  function completeTransferTask(taskId: string, response: SftpTransferResponse) {
    const task = activeTask.value
    if (!task || task.id !== taskId || !task.direction) return
    const targetPath = response.targetPath || response.localPath || response.remotePath || task.targetPath || ''
    const completedTask: ActiveTask = {
      ...task,
      targetPath,
      progressPercent: 100,
      progressText: '',
      completedAt: Date.now(),
      status: 'done'
    }
    lastTransfer.value = completedTask
    status.value = targetPath ? `${transferActionLabel(task)}完成：${targetPath}` : response.message
  }

  function recordTransferFailure(taskId: string, err: unknown) {
    const task = activeTask.value
    if (!task || task.id !== taskId || !task.direction) return
    const message = formatTaskError(err)
    lastTransfer.value = {
      ...task,
      progressText: message,
      completedAt: Date.now(),
      status: isTaskCancelledMessage(message) ? 'cancelled' : 'error'
    }
  }

  function finishRemoteTask(taskId: string) {
    if (activeTask.value?.id === taskId) {
      activeTask.value = null
      loading.value = false
    }
  }

  async function cancelActiveTask() {
    const task = activeTask.value
    if (!task || task.cancelling) return
    task.cancelling = true
    status.value = `正在取消：${task.label}`
    error.value = ''
    try {
      await cancelTask(task.id)
    } catch (err) {
      error.value = formatError(err)
    }
  }

  function handleTaskError(err: unknown) {
    const message = formatTaskError(err)
    if (isTaskCancelledMessage(message)) {
      status.value = '任务已取消'
      error.value = ''
    } else {
      error.value = message
      status.value = ''
    }
  }

  function formatTaskError(err: unknown) {
    return formatError(err)
  }

  function isTaskCancelledMessage(message: string) {
    return /cancelled|canceled|取消/i.test(message)
  }

  onBeforeUnmount(() => {
    disposed = true
    cancelActiveRemoteTaskForStateChange()
  })

  return { activeTask, lastTransfer, taskInProgress, activeTransferTask, runTransfer, startRemoteTask, updateTransferProgress, completeTransferTask, recordTransferFailure, finishRemoteTask, cancelActiveTask, handleTaskError, formatTaskError, isTaskCancelledMessage, cancelActiveRemoteTaskForStateChange }
}
