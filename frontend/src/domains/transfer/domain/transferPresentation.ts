import type { ActiveTask } from './transfer'

export function transferActionLabel(task: Pick<ActiveTask, 'direction'>) {
  return task.direction === 'download' ? '下载' : '上传'
}

export function transferKindLabel(task: Pick<ActiveTask, 'itemKind'>) {
  if (task.itemKind === 'folder') return '文件夹'
  if (task.itemKind === 'item') return '项目'
  return '文件'
}

export function hasDeterminateProgress(task: ActiveTask) {
  return typeof task.progressPercent === 'number' && task.progressPercent > 0
}

export function transferProgressWidth(task: ActiveTask) {
  const percent = typeof task.progressPercent === 'number' ? Math.max(0, Math.min(100, task.progressPercent)) : 0
  return `${percent}%`
}

export function transferStatusLabel(task: ActiveTask) {
  if (task.status === 'done') return '完成'
  if (task.status === 'error') return '失败'
  if (task.status === 'cancelled') return '已取消'
  if (task.cancelling) return '取消中'
  return hasDeterminateProgress(task) ? `${Math.round(task.progressPercent ?? 0)}%` : '传输中'
}

export function numericOr(value: number | undefined, fallback?: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function transferAmountLabel(task: ActiveTask) {
  if (typeof task.transferredBytes === 'number' && typeof task.totalBytes === 'number') {
    return `${formatSize(task.transferredBytes)} / ${formatSize(task.totalBytes)}`
  }
  if (typeof task.transferredBytes === 'number') return formatSize(task.transferredBytes)
  return task.progressText || '等待数据'
}

export function transferSpeedLabel(task: ActiveTask) {
  if (typeof task.bytesPerSecond !== 'number' || task.bytesPerSecond <= 0) return '--'
  return `${formatSize(task.bytesPerSecond)}/s`
}

export function transferRemainingLabel(task: ActiveTask) {
  const seconds = task.remainingSeconds ?? task.etaSeconds
  return formatDuration(seconds)
}

export function transferElapsedLabel(task: ActiveTask) {
  if (typeof task.elapsedSeconds === 'number') return formatDuration(task.elapsedSeconds)
  if (!task.startedAt) return '--'
  const end = task.completedAt ?? Date.now()
  return formatDuration((end - task.startedAt) / 1000)
}

export function transferCompletionLabel(task: ActiveTask) {
  return formatClock(task.completedAt ?? task.estimatedCompletionEpochMs)
}

export function formatSize(size: number) {
  if (!Number.isFinite(size) || size <= 0) return '0 B'
  if (size < 1024) return `${Math.round(size)} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function formatDuration(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '--'
  const seconds = Math.max(0, Math.round(value))
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}时${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}分`
  if (seconds >= 60) return `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒`
  return `${seconds}秒`
}

export function formatClock(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '--'
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function formatLocalModified(value: string) {
  if (!value) return '-'
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return value
  return new Date(seconds * 1000).toLocaleString([], {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function formatRemoteModified(value: string) {
  return formatLocalModified(value)
}

export function formatError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  if (message.includes('SFTP_TARGET_CHANGED')) {
    return '原连接配置的地址、端口或跳转方式已变化，已停止操作。请按新配置打开会话后重试。'
  }
  if (isTauriPreviewUnavailable(message)) {
    return '浏览器预览中无法使用本地文件和 SFTP 能力，请在 AI Term 桌面端中操作。'
  }
  return message
}

export function isTauriPreviewUnavailable(message: string) {
  return message.includes('__TAURI_IPC__') || message.includes('window.__TAURI_IPC__') || message.includes('invoke')
}
