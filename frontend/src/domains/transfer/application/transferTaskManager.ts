import { computed, readonly, ref } from 'vue'
import type { ActiveTask } from '../domain/transfer'
import type { FileTargetBinding } from '../domain/fileSession'
import { captureFileTarget } from '../domain/fileSession'
import { formatError } from '../domain/transferPresentation'
import type { SftpTransferEvent, SftpTransferResponse } from '../infrastructure/api'
import { cancelTask, onSftpTransferProgress } from '../infrastructure/api'
import { boundedOperation } from './useSftpConnection'

export interface TransferJob extends ActiveTask {
  binding: FileTargetBinding
  mode: 'sftp' | 'terminal'
  direction: 'upload' | 'download'
  itemName: string
  sourcePath: string
  targetPath: string
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
}
export interface TransferJobRequest {
  binding: FileTargetBinding
  mode?: 'sftp' | 'terminal'
  direction: 'upload' | 'download'
  itemKind?: 'file' | 'folder' | 'item'
  itemName: string
  sourcePath: string
  targetPath: string
  execute: (
    id: string,
    signal: AbortSignal,
    progress: (event: SftpTransferEvent) => void,
  ) => Promise<SftpTransferResponse>
}

export function createTransferTaskManager(
  source = { cancel: cancelTask, listen: onSftpTransferProgress },
  timeouts = { subscription: 5_000, transfer: 600_000 },
) {
  const jobs = ref<TransferJob[]>([])
  const executors = new Map<string, TransferJobRequest['execute']>()
  const controllers = new Map<string, AbortController>()
  const cancellations = new Map<string, Promise<void>>()
  const completions = new Map<string, (job: TransferJob) => void>()
  const activeCount = computed(
    () => jobs.value.filter((job) => job.status === 'queued' || job.status === 'running').length,
  )

  function update(id: string, event: SftpTransferEvent) {
    const job = jobs.value.find((job) => job.id === id)
    if (!job || event.taskId !== id || job.status !== 'running' || job.cancelling) return
    Object.assign(job, {
      progressPercent:
        typeof event.percent === 'number' && Number.isFinite(event.percent)
          ? Math.max(0, Math.min(100, event.percent)) : job.progressPercent,
      progressText: event.text || job.progressText,
      ...Object.fromEntries(
        Object.entries(event).filter(
          ([key, value]) =>
            ['transferredBytes', 'totalBytes', 'bytesPerSecond', 'remainingSeconds', 'etaSeconds',
              'estimatedCompletionEpochMs', 'elapsedSeconds'].includes(key) &&
            typeof value === 'number' &&
            Number.isFinite(value),
        ),
      ),
    })
  }

  function cancelBackend(job: TransferJob) {
    if (job.mode !== 'sftp') return Promise.resolve()
    const pending = cancellations.get(job.id)
    if (pending) return pending
    const operation = Promise.resolve().then(() => source.cancel(job.id)).then(() => {}, () => {})
    cancellations.set(job.id, operation)
    void operation.then(() => {
      if (cancellations.get(job.id) === operation) cancellations.delete(job.id)
    })
    return operation
  }

  async function run(job: TransferJob) {
    const controller = new AbortController()
    controllers.set(job.id, controller)
    job.status = 'running'
    job.startedAt = Date.now()
    let unlisten: (() => void) | undefined
    let acceptingListener = true
    let timedOut = false
    try {
      if (job.mode === 'sftp')
        unlisten = await boundedOperation(
          () =>
            source
              .listen(job.id, (event) => update(job.id, event))
              .then((stop) => {
                if (!acceptingListener || controller.signal.aborted || job.status !== 'running') {
                  stop()
                  throw new Error('任务已取消')
                }
                return stop
              }),
          timeouts.subscription,
          controller.signal,
          () => { acceptingListener = false },
        )
      if (controller.signal.aborted) throw new Error('任务已取消')
      const execute = executors.get(job.id)!
      const response = await boundedOperation(
        () => execute(job.id, controller.signal, (event) => update(job.id, event)),
        timeouts.transfer,
        controller.signal,
        () => {
          if (!controller.signal.aborted) {
            timedOut = true
            controller.abort()
          }
          void cancelBackend(job)
        },
      )
      if (controller.signal.aborted) throw new Error('任务已取消')
      job.status = 'done'
      job.progressPercent = 100
      job.progressText = response.message
      job.targetPath = response.targetPath || response.localPath || response.remotePath || job.targetPath
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      job.status =
        (controller.signal.aborted && !timedOut) || /cancelled|canceled|取消/i.test(message)
          ? 'cancelled' : 'error'
      job.progressText = message.includes('SFTP_TARGET_CHANGED') ? formatError(reason) : message
    } finally {
      acceptingListener = false
      try { unlisten?.() } catch { /* Listener cleanup must not strand completed jobs. */ }
      job.completedAt = Date.now()
      job.cancelling = false
      controllers.delete(job.id)
      executors.delete(job.id)
      completions.get(job.id)?.(job)
      completions.delete(job.id)
      pump()
    }
  }

  function pump() {
    const running = jobs.value.filter((job) => job.status === 'running')
    if (running.length >= 4) return
    const occupied = new Set(
      running.map((job) =>
        job.mode === 'terminal' ? `terminal:${job.binding.terminalId}` : job.binding.serverKey,
      ),
    )
    for (const job of jobs.value) {
      const key = job.mode === 'terminal' ? `terminal:${job.binding.terminalId}` : job.binding.serverKey
      if (job.status !== 'queued' || occupied.has(key)) continue
      occupied.add(key)
      void run(job)
      if (jobs.value.filter((item) => item.status === 'running').length >= 4) break
    }
  }

  function enqueue(request: TransferJobRequest) {
    const id = `sftp_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const job: TransferJob = {
      id,
      binding: captureFileTarget(request.binding),
      mode: request.mode ?? 'sftp',
      direction: request.direction,
      itemKind: request.itemKind ?? 'file',
      itemName: request.itemName,
      sourcePath: request.sourcePath,
      targetPath: request.targetPath,
      label: `${request.direction === 'upload' ? '上传' : '下载'} ${request.itemName}`,
      status: 'queued',
      cancelling: false,
      progressPercent: 0,
    }
    executors.set(id, request.execute)
    const completed = new Promise<TransferJob>((resolve) => completions.set(id, resolve))
    jobs.value.push(job)
    pump()
    return { id, completed }
  }

  async function cancel(id: string) {
    const job = jobs.value.find((job) => job.id === id)
    if (!job || !['queued', 'running'].includes(job.status) || job.cancelling) return
    job.cancelling = true
    if (job.status === 'queued') {
      job.status = 'cancelled'
      job.completedAt = Date.now()
      job.progressText = '排队任务已取消'
      job.cancelling = false
      executors.delete(id)
      completions.get(id)?.(job)
      completions.delete(id)
      return
    }
    const stopping = cancelBackend(job)
    controllers.get(id)?.abort()
    await stopping
  }

  function cancelTerminal(terminalId: string) {
    jobs.value
      .filter((job) => job.mode === 'terminal' && job.binding.terminalId === terminalId)
      .forEach((job) => void cancel(job.id))
  }
  function clearCompleted() {
    jobs.value = jobs.value.filter((job) => job.status === 'queued' || job.status === 'running')
  }
  return { jobs: readonly(jobs), activeCount, enqueue, cancel, cancelTerminal, clearCompleted }
}

export const transferTasks = createTransferTaskManager()
