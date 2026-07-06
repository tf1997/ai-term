<script setup lang="ts">
import { open as openShellPath } from '@tauri-apps/api/shell'
import { computed, onMounted, ref, watch } from 'vue'
import {
  cancelTask,
  localHomeDirectory,
  localListDirectory,
  onSftpTransferProgress,
  probeBastionServers,
  sftpCreateDirectory,
  sftpDeletePath,
  sftpDownloadFile,
  sftpDownloadPath,
  sftpListDirectory,
  sftpProbe,
  sftpUploadFile,
  sftpUploadPath,
  type BastionServerCandidate,
  type LocalFileEntry,
  type SftpFileEntry,
  type SftpProbeResponse,
  type SftpTransferResponse
} from '../lib/tauri'
import UiIcon from './UiIcon.vue'

const props = defineProps<{
  connectionId: string
  terminalSnapshot: string
}>()

const emit = defineEmits<{
  writeTerminalInput: [data: string]
}>()

const INLINE_TRANSFER_LIMIT = 700 * 1024

interface TerminalTargetIdentity {
  host: string
  ip: string
  username: string
  hostname: string
  pwd: string
  label: string
}

interface SftpProbeState extends SftpProbeResponse {
  probing?: boolean
}

type TransferDirection = 'download' | 'upload'
type TransferItemKind = 'file' | 'folder'
type TransferTaskState = 'running' | 'done' | 'error' | 'cancelled'

interface ActiveTask {
  id: string
  label: string
  cancelling: boolean
  direction?: TransferDirection
  itemKind?: TransferItemKind
  itemName?: string
  sourcePath?: string
  targetPath?: string
  progressPercent?: number | null
  progressText?: string
  startedAt?: number
  completedAt?: number
  status?: TransferTaskState
}

interface FileContextMenuItem {
  id: string
  label: string
  danger?: boolean
  disabled?: boolean
  action: () => void
}

interface FileContextMenuState {
  x: number
  y: number
  title: string
  items: FileContextMenuItem[]
}

const fileInput = ref<HTMLInputElement | null>(null)
const currentPath = ref('.')
const pathDraft = ref('.')
const localPath = ref('')
const localPathDraft = ref('')
const localHome = ref('')
const transferMode = ref<'sftp' | 'terminal'>('sftp')
const terminalRemotePath = ref('')
const entries = ref<SftpFileEntry[]>([])
const localEntries = ref<LocalFileEntry[]>([])
const selectedRemoteEntry = ref<SftpFileEntry | null>(null)
const selectedLocalEntry = ref<LocalFileEntry | null>(null)
const loading = ref(false)
const localLoading = ref(false)
const probing = ref(false)
const identifying = ref(false)
const activeTask = ref<ActiveTask | null>(null)
const lastTransfer = ref<ActiveTask | null>(null)
const fileContextMenu = ref<FileContextMenuState | null>(null)
const status = ref('')
const error = ref('')
const candidates = ref<BastionServerCandidate[]>([])
const selectedTarget = ref<BastionServerCandidate | null>(null)
const sftpProbeByHost = ref<Record<string, SftpProbeState>>({})
const currentTerminalTarget = ref<TerminalTargetIdentity | null>(null)
const pendingDownload = ref<{
  begin: string
  end: string
  name: string
} | null>(null)
const pendingIdentify = ref<{
  begin: string
  end: string
} | null>(null)

const remoteReady = computed(() => props.connectionId && props.connectionId !== 'local')
const taskInProgress = computed(() => Boolean(activeTask.value))
const activeTransferTask = computed(() => (activeTask.value?.direction ? activeTask.value : null))
const targetOverride = computed(() => {
  if (!selectedTarget.value) return undefined
  return {
    targetHost: selectedTarget.value.host,
    targetUsername: selectedTarget.value.username
  }
})
const sortedEntries = computed(() => {
  return [...entries.value].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
})
const sortedLocalEntries = computed(() => {
  return [...localEntries.value].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
})

watch(
  () => props.connectionId,
  () => {
    currentPath.value = '.'
    pathDraft.value = '.'
    entries.value = []
    selectedRemoteEntry.value = null
    candidates.value = []
    selectedTarget.value = null
    sftpProbeByHost.value = {}
    currentTerminalTarget.value = null
    pendingIdentify.value = null
    status.value = ''
    error.value = ''
    if (remoteReady.value) void loadDirectory('.')
  }
)

onMounted(() => {
  if (remoteReady.value) void loadDirectory(currentPath.value)
  void loadLocalHome()
})

watch(
  () => props.terminalSnapshot,
  (snapshot) => {
    if (pendingDownload.value) finishTerminalDownloadIfReady(snapshot)
    if (pendingIdentify.value) finishTerminalIdentifyIfReady(snapshot)
  }
)

async function loadDirectory(path = currentPath.value) {
  if (!remoteReady.value) return
  const taskId = startRemoteTask('读取远端目录')
  if (!taskId) return
  loading.value = true
  error.value = ''
  status.value = '正在读取目录...'
  try {
    const response = await sftpListDirectory(props.connectionId, path, targetOverride.value, { taskId })
    currentPath.value = response.path
    pathDraft.value = response.path
    entries.value = response.entries
    selectedRemoteEntry.value = null
    status.value = `${response.entries.length} 项`
  } catch (err) {
    handleTaskError(err)
  } finally {
    loading.value = false
    finishRemoteTask(taskId)
  }
}

async function loadLocalHome() {
  try {
    const home = await localHomeDirectory()
    localHome.value = home
    await loadLocalDirectory(home)
  } catch (err) {
    error.value = formatError(err)
  }
}

async function loadLocalDirectory(path = localPath.value || localHome.value) {
  localLoading.value = true
  error.value = ''
  try {
    const response = await localListDirectory(path)
    localHome.value = response.home
    localPath.value = response.path
    localPathDraft.value = response.path
    localEntries.value = response.entries
    selectedLocalEntry.value = null
  } catch (err) {
    error.value = formatError(err)
  } finally {
    localLoading.value = false
  }
}

async function probeTargets() {
  if (!remoteReady.value) return
  probing.value = true
  error.value = ''
  status.value = '正在探测堡垒机可访问服务器...'
  try {
    const response = await probeBastionServers(props.connectionId)
    candidates.value = response
    sftpProbeByHost.value = {}
    status.value = response.length ? `发现 ${response.length} 台服务器` : '没有从堡垒机菜单中解析到服务器 IP'
  } catch (err) {
    error.value = formatError(err)
    status.value = ''
  } finally {
    probing.value = false
  }
}

async function selectTarget(candidate: BastionServerCandidate) {
  selectedTarget.value = candidate
  currentPath.value = '.'
  pathDraft.value = '.'
  entries.value = []
  const probe = await probeSelectedTarget(candidate)
  if (!probe) return
  if (!probe.available) {
    error.value = probe.message
    status.value = ''
    return
  }
  const path = probe.path || '.'
  currentPath.value = path
  pathDraft.value = path
  await loadDirectory(path)
}

async function useTerminalTargetForSftp() {
  if (!currentTerminalTarget.value) return
  const target = {
    host: currentTerminalTarget.value.host,
    username: currentTerminalTarget.value.username,
    label: currentTerminalTarget.value.label,
    sourceLine: currentTerminalTarget.value.label
  }
  selectedTarget.value = target
  transferMode.value = 'sftp'
  entries.value = []
  const probe = await probeSelectedTarget(target)
  if (!probe) return
  if (!probe.available) {
    error.value = probe.message
    status.value = ''
    return
  }
  currentPath.value = currentTerminalTarget.value.pwd || probe.path || '.'
  pathDraft.value = currentPath.value
  await loadDirectory(currentPath.value)
}

async function probeSelectedTarget(candidate: BastionServerCandidate) {
  if (!remoteReady.value) return null
  const taskId = startRemoteTask(`探测 ${candidate.host}`)
  if (!taskId) return null
  const key = candidateKey(candidate)
  sftpProbeByHost.value = {
    ...sftpProbeByHost.value,
    [key]: {
      available: false,
      message: '正在探测 SFTP...',
      probing: true
    }
  }
  status.value = `正在探测 ${candidate.username || 'user'}@${candidate.host} 的 SFTP...`
  error.value = ''
  try {
    const response = await sftpProbe(props.connectionId, {
      targetHost: candidate.host,
      targetUsername: candidate.username
    }, { taskId })
    sftpProbeByHost.value = {
      ...sftpProbeByHost.value,
      [key]: response
    }
    status.value = response.message
    return response
  } catch (err) {
    const response: SftpProbeResponse = {
      available: false,
      message: formatTaskError(err)
    }
    sftpProbeByHost.value = {
      ...sftpProbeByHost.value,
      [key]: response
    }
    error.value = response.message
    status.value = ''
    return response
  } finally {
    finishRemoteTask(taskId)
  }
}

function clearSelectedTarget() {
  selectedTarget.value = null
  currentPath.value = '.'
  pathDraft.value = '.'
  void loadDirectory('.')
}

function switchToTerminalMode() {
  transferMode.value = 'terminal'
  if (!currentTerminalTarget.value) void identifyCurrentTerminalTarget()
}

function candidateKey(candidate: Pick<BastionServerCandidate, 'host' | 'username'>) {
  return `${candidate.username || 'user'}@${candidate.host}`.toLowerCase()
}

function probeStateFor(candidate: BastionServerCandidate) {
  return sftpProbeByHost.value[candidateKey(candidate)]
}

function probeStateLabel(candidate: BastionServerCandidate) {
  const state = probeStateFor(candidate)
  if (!state) return '未探测'
  if (state.probing) return '探测中'
  return state.available ? 'SFTP 可用' : '不可用'
}

function identifyCurrentTerminalTarget() {
  if (!remoteReady.value || identifying.value) return
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const begin = `__AI_TERM_IDENT_BEGIN_${id}__`
  const end = `__AI_TERM_IDENT_END_${id}__`
  pendingIdentify.value = { begin, end }
  identifying.value = true
  error.value = ''
  status.value = '正在识别当前终端服务器...'
  emit(
    'writeTerminalInput',
    [
      `printf '\\n${begin}\\n'`,
      `printf 'user='; (whoami 2>/dev/null || id -un 2>/dev/null || printf unknown)`,
      `printf '\\nhostname='; (hostname 2>/dev/null || printf unknown)`,
      `printf '\\nips='; ((hostname -I 2>/dev/null || ip -o -4 addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1) | tr '\\n' ' ')`,
      `printf '\\npwd='; (pwd 2>/dev/null || printf .)`,
      `printf '\\n${end}\\n'`
    ].join('; ') + '\n'
  )
}

function openEntry(entry: SftpFileEntry) {
  if (!entry.isDir) return
  void loadDirectory(entry.path)
}

function selectRemoteEntry(entry: SftpFileEntry) {
  selectedRemoteEntry.value = entry
}

function openRemoteContextMenu(event: MouseEvent, entry: SftpFileEntry) {
  selectRemoteEntry(entry)
  openFileContextMenu(event, entry.name, [
    {
      id: 'open',
      label: '打开目录',
      disabled: !entry.isDir,
      action: () => openEntry(entry)
    },
    {
      id: 'download',
      label: '下载到本地目录',
      action: () => void downloadRemoteEntry(entry)
    },
    {
      id: 'copy-path',
      label: '复制远端路径',
      action: () => void copyText(entry.path)
    },
    {
      id: 'delete',
      label: '删除',
      danger: true,
      action: () => void deleteEntry(entry)
    }
  ])
}

function openLocalEntry(entry: LocalFileEntry) {
  if (!entry.isDir) {
    selectedLocalEntry.value = entry
    return
  }
  void loadLocalDirectory(entry.path)
}

function selectLocalEntry(entry: LocalFileEntry) {
  selectedLocalEntry.value = entry
}

function openLocalContextMenu(event: MouseEvent, entry: LocalFileEntry) {
  selectLocalEntry(entry)
  openFileContextMenu(event, entry.name, [
    {
      id: 'open',
      label: entry.isDir ? '打开文件夹' : '打开文件位置',
      action: () => void openLocalFileLocation(entry)
    },
    {
      id: 'upload',
      label: '上传到远端目录',
      disabled: !remoteReady.value || loading.value,
      action: () => {
        selectedLocalEntry.value = entry
        void uploadSelectedLocalEntry()
      }
    },
    {
      id: 'copy-path',
      label: '复制本地路径',
      action: () => void copyText(entry.path)
    }
  ])
}

function openFileContextMenu(event: MouseEvent, title: string, items: FileContextMenuItem[]) {
  const menuWidth = 220
  const menuHeight = Math.min(280, 32 + items.length * 36)
  fileContextMenu.value = {
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
    title,
    items
  }
}

function closeFileContextMenu() {
  fileContextMenu.value = null
}

function runFileContextMenuItem(item: FileContextMenuItem) {
  if (item.disabled) return
  item.action()
  closeFileContextMenu()
}

async function openLocalFileLocation(entry: LocalFileEntry) {
  const path = entry.isDir ? entry.path : localParentPath(entry.path)
  if (!path) return
  try {
    await openShellPath(path)
  } catch (err) {
    error.value = formatError(err)
  }
}

function goParent() {
  if (currentPath.value === '/' || currentPath.value === '.') return
  const parts = currentPath.value.split('/').filter(Boolean)
  parts.pop()
  void loadDirectory(parts.length ? `/${parts.join('/')}` : '/')
}

function goLocalParent() {
  if (!localPath.value || localPath.value === '/') return
  void loadLocalDirectory(localParentPath(localPath.value) || '/')
}

function localParentPath(path: string) {
  const normalized = path.replace(/[\\/]+$/, '')
  if (!normalized || normalized === '/') return '/'
  if (/^[A-Za-z]:$/.test(normalized)) return `${normalized}\\`
  if (/^[A-Za-z]:\\?$/.test(normalized)) return normalized.endsWith('\\') ? normalized : `${normalized}\\`
  const slash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  if (slash <= 0) return '/'
  if (slash === 2 && /^[A-Za-z]:/.test(normalized)) return `${normalized.slice(0, 2)}\\`
  return normalized.slice(0, slash)
}

function triggerUpload() {
  if (!remoteReady.value || loading.value) return
  if (transferMode.value === 'terminal') {
    fileInput.value?.click()
    return
  }
  void uploadSelectedLocalEntry()
}

async function uploadSelectedFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length) return

  if (transferMode.value === 'terminal') {
    await uploadFilesThroughTerminal(files)
    return
  }

  let lastUploadedPath = ''
  for (const file of files) {
    const localPath =
      (file as File & { path?: string }).path ?? window.prompt('输入本地文件完整路径', file.name) ?? ''
    if (!localPath) {
      error.value = '当前环境没有提供本地文件路径，请在 Tauri 客户端中上传文件。'
      return
    }
    const targetPath = joinRemotePath(currentPath.value, localFileName(localPath) || file.name)
    const response = await runTransfer(
      `正在上传 ${file.name}...`,
      (taskId) => sftpUploadFile(props.connectionId, localPath, currentPath.value, targetOverride.value, { taskId }),
      {
        direction: 'upload',
        itemKind: 'file',
        itemName: file.name,
        sourcePath: localPath,
        targetPath
      }
    )
    if (!response) return
    lastUploadedPath = response.targetPath || response.remotePath || targetPath
  }
  await loadDirectory(currentPath.value)
  if (lastUploadedPath) selectRemoteEntryByPath(lastUploadedPath)
}

async function uploadFilesThroughTerminal(files: File[]) {
  for (const file of files) {
    if (file.size > INLINE_TRANSFER_LIMIT) {
      error.value = `${file.name} 超过终端通道限制 ${formatSize(INLINE_TRANSFER_LIMIT)}，请使用 SFTP。`
      return
    }
    const defaultBase = currentTerminalTarget.value?.pwd || currentPath.value || '.'
    const defaultPath = joinRemotePath(defaultBase === '.' ? '.' : defaultBase, file.name)
    const remotePath = window.prompt('上传到远程路径', defaultPath)
    if (!remotePath) return
    status.value = `正在通过终端上传 ${file.name}...`
    error.value = ''
    const base64 = wrapBase64(arrayBufferToBase64(await file.arrayBuffer()))
    const marker = `AI_TERM_UPLOAD_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const command = [
      `base64 -d > ${shellQuote(remotePath)} <<'${marker}'`,
      base64,
      marker,
      `printf '\\nAI Term uploaded: %s\\n' ${shellQuote(remotePath)}`
    ].join('\n')
    emit('writeTerminalInput', `${command}\n`)
    status.value = `已发送上传命令：${remotePath}`
  }
}

async function downloadEntry(entry: SftpFileEntry) {
  await downloadRemoteEntry(entry)
}

async function uploadSelectedLocalEntry() {
  if (!remoteReady.value || !selectedLocalEntry.value) {
    error.value = '请先在本地用户目录中选择要上传的文件或文件夹。'
    return
  }
  const item = selectedLocalEntry.value
  const targetPath = joinRemotePath(currentPath.value, item.name)
  const response = await runTransfer(
    `正在上传 ${item.name}...`,
    (taskId) => sftpUploadPath(props.connectionId, item.path, currentPath.value, targetOverride.value, { taskId }),
    {
      direction: 'upload',
      itemKind: item.isDir ? 'folder' : 'file',
      itemName: item.name,
      sourcePath: item.path,
      targetPath
    }
  )
  if (!response) return
  await loadDirectory(currentPath.value)
  selectRemoteEntryByPath(response.targetPath || response.remotePath || targetPath)
}

async function downloadSelectedRemoteEntry() {
  if (!selectedRemoteEntry.value) {
    error.value = '请先在远端目录中选择要下载的文件或文件夹。'
    return
  }
  await downloadRemoteEntry(selectedRemoteEntry.value)
}

async function downloadRemoteEntry(entry: SftpFileEntry) {
  if (!localPath.value) await loadLocalHome()
  if (!localPath.value) return
  const targetPath = joinLocalPath(localPath.value, entry.name)
  const response = await runTransfer(
    `正在下载 ${entry.name}...`,
    (taskId) => sftpDownloadPath(props.connectionId, entry.path, localPath.value, entry.isDir, targetOverride.value, { taskId }),
    {
      direction: 'download',
      itemKind: entry.isDir ? 'folder' : 'file',
      itemName: entry.name,
      sourcePath: entry.path,
      targetPath
    }
  )
  if (!response) return
  await loadLocalDirectory(localPath.value)
  selectLocalEntryByPath(response.localPath || response.targetPath || targetPath)
}

function downloadThroughTerminal(path = terminalRemotePath.value) {
  const remotePath = path.trim() || window.prompt('远程文件路径') || ''
  if (!remotePath) return
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const begin = `__AI_TERM_DOWNLOAD_BEGIN_${id}__`
  const end = `__AI_TERM_DOWNLOAD_END_${id}__`
  pendingDownload.value = {
    begin,
    end,
    name: remotePath.split('/').filter(Boolean).pop() || 'download.bin'
  }
  terminalRemotePath.value = remotePath
  status.value = `正在通过终端下载 ${remotePath}...`
  error.value = ''
  emit(
    'writeTerminalInput',
    `printf '\\n${begin}\\n'; base64 ${shellQuote(remotePath)}; printf '\\n${end}\\n'\n`
  )
}

async function createDirectory() {
  const name = window.prompt('新建目录名')
  if (!name?.trim()) return
  await runTransfer(`正在创建 ${name.trim()}...`, (taskId) =>
    sftpCreateDirectory(props.connectionId, joinRemotePath(currentPath.value, name.trim()), targetOverride.value, { taskId })
  )
  await loadDirectory(currentPath.value)
}

async function deleteEntry(entry: SftpFileEntry) {
  if (!window.confirm(`删除 ${entry.name}？`)) return
  await runTransfer(`正在删除 ${entry.name}...`, (taskId) =>
    sftpDeletePath(props.connectionId, entry.path, entry.isDir, targetOverride.value, { taskId })
  )
  await loadDirectory(currentPath.value)
}

async function runTransfer(
  label: string,
  action: (taskId: string) => Promise<SftpTransferResponse>,
  details: Partial<ActiveTask> = {}
) {
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
    const response = await action(taskId)
    completeTransferTask(taskId, response)
    if (!details.direction) status.value = response.message
    return response
  } catch (err) {
    recordTransferFailure(taskId, err)
    handleTaskError(err)
    return null
  } finally {
    unlisten?.()
    loading.value = false
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

function updateTransferProgress(taskId: string, event: { percent?: number; text?: string }) {
  const task = activeTask.value
  if (!task || task.id !== taskId) return
  const percent = typeof event.percent === 'number' ? Math.max(0, Math.min(100, Math.round(event.percent))) : task.progressPercent
  activeTask.value = {
    ...task,
    progressPercent: percent,
    progressText: event.text || task.progressText
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

function joinRemotePath(base: string, name: string) {
  if (base === '/') return `/${name}`
  if (base.endsWith('/')) return `${base}${name}`
  return `${base}/${name}`
}

function joinLocalPath(base: string, name: string) {
  const trimmed = base.replace(/[\\/]+$/, '')
  if (!trimmed) return name
  if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}\\${name}`
  if (trimmed === '/') return `/${name}`
  const separator = base.includes('\\') ? '\\' : '/'
  return `${trimmed}${separator}${name}`
}

function localFileName(path: string) {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).filter(Boolean).pop() || ''
}

function remoteParentPath(path: string) {
  const normalized = path.replace(/\/+$/, '')
  if (!normalized || normalized === '/') return '/'
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '/' : normalized.slice(0, index)
}

function selectRemoteEntryByPath(path: string) {
  const normalized = normalizeRemoteComparePath(path)
  selectedRemoteEntry.value = entries.value.find((entry) => normalizeRemoteComparePath(entry.path) === normalized) ?? null
}

function selectLocalEntryByPath(path: string) {
  const normalized = normalizeLocalComparePath(path)
  selectedLocalEntry.value = localEntries.value.find((entry) => normalizeLocalComparePath(entry.path) === normalized) ?? null
}

function normalizeRemoteComparePath(path: string) {
  return path.replace(/\/+$/, '') || '/'
}

function normalizeLocalComparePath(path: string) {
  const normalized = path.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized
}

function transferActionLabel(task: Pick<ActiveTask, 'direction'>) {
  return task.direction === 'download' ? '下载' : '上传'
}

function transferKindLabel(task: Pick<ActiveTask, 'itemKind'>) {
  return task.itemKind === 'folder' ? '文件夹' : '文件'
}

function hasDeterminateProgress(task: ActiveTask) {
  return typeof task.progressPercent === 'number' && task.progressPercent > 0
}

function transferProgressWidth(task: ActiveTask) {
  const percent = typeof task.progressPercent === 'number' ? Math.max(0, Math.min(100, task.progressPercent)) : 0
  return `${percent}%`
}

function transferStatusLabel(task: ActiveTask) {
  if (task.status === 'done') return '完成'
  if (task.status === 'error') return '失败'
  if (task.status === 'cancelled') return '已取消'
  if (task.cancelling) return '取消中'
  return hasDeterminateProgress(task) ? `${Math.round(task.progressPercent ?? 0)}%` : '传输中'
}

async function openLastTransferLocation() {
  const task = lastTransfer.value
  if (!task?.targetPath) return
  try {
    if (task.direction === 'download') {
      const path = task.itemKind === 'folder' ? task.targetPath : localParentPath(task.targetPath)
      if (path) await openShellPath(path)
      return
    }
    const remotePath = task.itemKind === 'folder' ? task.targetPath : remoteParentPath(task.targetPath)
    await loadDirectory(remotePath)
    selectRemoteEntryByPath(task.targetPath)
  } catch (err) {
    error.value = formatError(err)
  }
}

async function copyLastTransferPath() {
  const path = lastTransfer.value?.targetPath
  if (!path) return
  await copyText(path)
}

function formatSize(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function formatLocalModified(value: string) {
  if (!value) return '-'
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return value
  return new Date(seconds * 1000).toLocaleString()
}

function formatError(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

async function copyText(value: string) {
  if (!value) return
  if (!navigator.clipboard?.writeText) {
    error.value = '当前环境不支持剪贴板写入。'
    return
  }
  try {
    await navigator.clipboard.writeText(value)
    status.value = '已复制路径'
  } catch (err) {
    error.value = formatError(err)
  }
}

function finishTerminalDownloadIfReady(snapshot: string) {
  const pending = pendingDownload.value
  if (!pending) return
  const beginIndex = snapshot.lastIndexOf(pending.begin)
  const endIndex = snapshot.lastIndexOf(pending.end)
  if (beginIndex === -1 || endIndex === -1 || endIndex <= beginIndex) return
  const raw = snapshot.slice(beginIndex + pending.begin.length, endIndex)
  const base64 = raw.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/[^A-Za-z0-9+/=]/g, '')
  if (!base64) {
    error.value = '没有从终端输出中解析到文件内容。'
    pendingDownload.value = null
    return
  }
  if (base64.length > Math.ceil((INLINE_TRANSFER_LIMIT * 4) / 3) + 1024) {
    error.value = `终端通道下载超过 ${formatSize(INLINE_TRANSFER_LIMIT)}，请使用 SFTP。`
    pendingDownload.value = null
    return
  }
  try {
    saveBase64File(base64, pending.name)
    status.value = `已生成下载文件：${pending.name}`
  } catch (err) {
    error.value = formatError(err)
  } finally {
    pendingDownload.value = null
  }
}

function finishTerminalIdentifyIfReady(snapshot: string) {
  const pending = pendingIdentify.value
  if (!pending) return
  const beginIndex = snapshot.lastIndexOf(pending.begin)
  const endIndex = snapshot.lastIndexOf(pending.end)
  if (beginIndex === -1 || endIndex === -1 || endIndex <= beginIndex) return
  const raw = cleanTerminalText(snapshot.slice(beginIndex + pending.begin.length, endIndex))
  const values = parseIdentityOutput(raw)
  const ip = firstUsableIp(values.ips)
  const host = ip || values.hostname || ''
  if (!host) {
    error.value = '没有识别到当前服务器 IP 或主机名。'
  } else {
    currentTerminalTarget.value = {
      host,
      ip,
      username: values.user || 'user',
      hostname: values.hostname || host,
      pwd: values.pwd || '.',
      label: `${values.user || 'user'}@${host} · ${values.hostname || host} · ${values.pwd || '.'}`
    }
    terminalRemotePath.value = values.pwd || terminalRemotePath.value
    status.value = `已识别当前终端：${currentTerminalTarget.value.label}`
  }
  identifying.value = false
  pendingIdentify.value = null
}

function parseIdentityOutput(raw: string) {
  const values = {
    user: '',
    hostname: '',
    ips: '',
    pwd: ''
  }
  for (const line of raw.split('\n')) {
    const [key, ...rest] = line.trim().split('=')
    const value = rest.join('=').trim()
    if (key === 'user') values.user = value
    if (key === 'hostname') values.hostname = value
    if (key === 'ips') values.ips = value
    if (key === 'pwd') values.pwd = value
  }
  return values
}

function firstUsableIp(value: string) {
  return (
    value
      .split(/\s+/)
      .map((item) => item.trim())
      .find((item) => /^\d{1,3}(\.\d{1,3}){3}$/.test(item) && item !== '127.0.0.1') ?? ''
  )
}

function cleanTerminalText(value: string) {
  return value.replace(/\r/g, '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

function wrapBase64(value: string) {
  return value.match(/.{1,76}/g)?.join('\n') ?? value
}

function saveBase64File(base64: string, name: string) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  const url = URL.createObjectURL(new Blob([bytes]))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`
}
</script>

<template>
  <section class="files-panel">
    <div class="panel-head">
      <strong>文件传输</strong>
      <div class="panel-actions">
        <button class="icon-button" type="button" title="识别当前终端服务器" aria-label="识别当前终端服务器" :disabled="!remoteReady || identifying" @click="identifyCurrentTerminalTarget"><UiIcon name="terminal" /></button>
        <button v-if="transferMode === 'sftp'" class="icon-button" type="button" title="探测堡垒机服务器" aria-label="探测堡垒机服务器" :disabled="!remoteReady || probing || loading" @click="probeTargets"><UiIcon name="search" /></button>
        <button v-if="transferMode === 'sftp'" class="icon-button" type="button" title="刷新" aria-label="刷新" :disabled="!remoteReady || loading" @click="loadDirectory()"><UiIcon name="refresh" /></button>
        <button v-if="transferMode === 'sftp'" class="icon-button" type="button" title="新建目录" aria-label="新建目录" :disabled="!remoteReady || loading" @click="createDirectory"><UiIcon name="folder" /></button>
        <button v-if="transferMode === 'sftp'" class="icon-button" type="button" title="下载选中远端项到本地目录" aria-label="下载选中远端项到本地目录" :disabled="!remoteReady || loading || !selectedRemoteEntry" @click="downloadSelectedRemoteEntry"><UiIcon name="download" /></button>
        <button class="icon-button" type="button" :title="transferMode === 'sftp' ? '上传选中本地项到远端目录' : '上传小文件'" :aria-label="transferMode === 'sftp' ? '上传选中本地项到远端目录' : '上传小文件'" :disabled="!remoteReady || loading || (transferMode === 'sftp' && !selectedLocalEntry)" @click="triggerUpload"><UiIcon name="upload" /></button>
        <button v-if="activeTask" class="icon-button danger" type="button" title="取消当前任务" aria-label="取消当前任务" :disabled="activeTask.cancelling" @click="cancelActiveTask">
          <span v-if="activeTask.cancelling" class="spinner-dot" aria-hidden="true" /><UiIcon v-else name="close" />
        </button>
        <input ref="fileInput" type="file" multiple class="visually-hidden" @change="uploadSelectedFiles" />
      </div>
    </div>

    <div class="transfer-mode-tabs">
      <button type="button" :class="{ active: transferMode === 'sftp' }" @click="transferMode = 'sftp'">SFTP</button>
      <button type="button" :class="{ active: transferMode === 'terminal' }" @click="transferMode = 'terminal'">终端通道</button>
    </div>

    <div v-if="status || error || activeTask || lastTransfer" class="sftp-feedback" :class="{ error: Boolean(error) }">
      <p v-if="error">{{ error }}</p>
      <template v-else-if="activeTransferTask">
        <div class="transfer-task-head">
          <strong>{{ transferActionLabel(activeTransferTask) }}{{ transferKindLabel(activeTransferTask) }} · {{ activeTransferTask.itemName }}</strong>
          <span>{{ transferStatusLabel(activeTransferTask) }}</span>
        </div>
        <div class="transfer-progress" :class="{ indeterminate: !hasDeterminateProgress(activeTransferTask) }">
          <span :style="hasDeterminateProgress(activeTransferTask) ? { width: transferProgressWidth(activeTransferTask) } : undefined" />
        </div>
        <div class="transfer-task-paths">
          <span>{{ activeTransferTask.sourcePath }}</span>
          <span>{{ activeTransferTask.targetPath }}</span>
        </div>
      </template>
      <template v-else-if="lastTransfer">
        <div class="transfer-task-head">
          <strong>{{ transferActionLabel(lastTransfer) }}{{ transferKindLabel(lastTransfer) }} · {{ lastTransfer.itemName }}</strong>
          <span>{{ transferStatusLabel(lastTransfer) }}</span>
        </div>
        <div class="transfer-progress complete">
          <span />
        </div>
        <div class="transfer-task-paths">
          <span>{{ lastTransfer.sourcePath }}</span>
          <span>{{ lastTransfer.targetPath || lastTransfer.progressText }}</span>
        </div>
        <div v-if="lastTransfer.status === 'done'" class="transfer-task-actions">
          <button type="button" @click="openLastTransferLocation">{{ lastTransfer.direction === 'download' ? '打开位置' : '打开远端目录' }}</button>
          <button type="button" @click="copyLastTransferPath">复制路径</button>
        </div>
      </template>
      <p v-else>{{ status || activeTask?.label }}</p>
    </div>

    <div v-if="currentTerminalTarget" class="terminal-target-card">
      <div>
        <span>当前终端</span>
        <strong>{{ currentTerminalTarget.username }}@{{ currentTerminalTarget.host }}</strong>
        <small>{{ currentTerminalTarget.hostname }} · {{ currentTerminalTarget.pwd }}</small>
      </div>
      <button type="button" @click="useTerminalTargetForSftp">用作 SFTP 目标</button>
    </div>

    <div v-if="transferMode === 'sftp' && (selectedTarget || candidates.length)" class="bastion-targets">
      <div v-if="selectedTarget" class="selected-target">
        <span>当前目标</span>
        <strong>{{ selectedTarget.username || 'user' }}@{{ selectedTarget.host }}</strong>
        <button type="button" @click="clearSelectedTarget">使用配置目标</button>
      </div>
      <div v-if="candidates.length" class="target-list">
        <article
          v-for="candidate in candidates"
          :key="`${candidate.username || 'user'}@${candidate.host}`"
          :class="{ active: selectedTarget?.host === candidate.host }"
          tabindex="0"
          @click="selectTarget(candidate)"
          @keydown.enter="selectTarget(candidate)"
        >
          <div>
            <strong>{{ candidate.username || 'user' }}@{{ candidate.host }}</strong>
            <span>{{ candidate.label }}</span>
          </div>
          <span
            class="target-probe-state"
            :class="{
              probing: probeStateFor(candidate)?.probing,
              ok: probeStateFor(candidate)?.available,
              failed: probeStateFor(candidate) && !probeStateFor(candidate)?.available && !probeStateFor(candidate)?.probing
            }"
          >
            {{ probeStateLabel(candidate) }}
          </span>
        </article>
      </div>
      <button v-if="selectedTarget && probeStateFor(selectedTarget) && !probeStateFor(selectedTarget)?.available" class="terminal-fallback-button" type="button" @click="switchToTerminalMode">
        切到终端通道
      </button>
    </div>

    <div v-if="transferMode === 'terminal'" class="terminal-transfer-panel">
      <p class="terminal-transfer-note">
        通过当前已登录终端传输小文件，适合只支持交互式菜单的堡垒机。单文件限制 {{ formatSize(INLINE_TRANSFER_LIMIT) }}。
      </p>
      <button type="button" :disabled="!remoteReady || identifying" @click="identifyCurrentTerminalTarget">
        {{ identifying ? '识别中...' : '识别当前服务器' }}
      </button>
      <label>
        <span>远程文件路径</span>
        <input v-model="terminalRemotePath" placeholder="/tmp/app.log" :disabled="!remoteReady || Boolean(pendingDownload)" />
      </label>
      <div class="terminal-transfer-actions">
        <button type="button" :disabled="!remoteReady || Boolean(pendingDownload)" @click="triggerUpload">上传小文件</button>
        <button type="button" :disabled="!remoteReady || Boolean(pendingDownload)" @click="downloadThroughTerminal()">下载远程文件</button>
      </div>
    </div>

    <div v-else class="sftp-transfer-workbench">
      <div class="transfer-target-strip">
        <span><strong>下载到</strong>{{ localPath || localHome || '本地目录未加载' }}</span>
        <span><strong>上传到</strong>{{ currentPath }}</span>
      </div>
      <div class="transfer-browser">
      <section class="transfer-pane local-pane">
        <div class="transfer-pane-head">
          <strong>本地</strong>
          <span>{{ localPath || localHome }}</span>
        </div>
        <div class="local-pathbar">
          <button class="icon-button" type="button" title="上级目录" aria-label="上级目录" :disabled="localLoading" @click="goLocalParent"><UiIcon name="arrow-left" /></button>
          <input v-model="localPathDraft" :disabled="localLoading" placeholder="用户目录" @keydown.enter="loadLocalDirectory(localPathDraft)" />
          <button type="button" :disabled="localLoading" @click="loadLocalDirectory(localPathDraft)">打开</button>
          <button type="button" :disabled="localLoading || !localHome" @click="loadLocalDirectory(localHome)">用户目录</button>
        </div>
        <div class="file-list">
          <p v-if="localLoading && localEntries.length === 0" class="empty-state">正在加载本地目录...</p>
          <p v-else-if="sortedLocalEntries.length === 0" class="empty-state">本地目录为空</p>
          <article
            v-for="entry in sortedLocalEntries"
            :key="entry.path"
            class="file-row"
            :class="{ directory: entry.isDir, active: selectedLocalEntry?.path === entry.path }"
            @click="selectLocalEntry(entry)"
            @dblclick="openLocalEntry(entry)"
            @contextmenu.prevent.stop="openLocalContextMenu($event, entry)"
          >
            <div class="file-main">
              <span class="file-type-icon" :class="{ folder: entry.isDir, file: !entry.isDir }" aria-hidden="true" />
              <div class="file-copy">
                <strong>{{ entry.name }}</strong>
                <span>{{ entry.isDir ? '目录' : formatSize(entry.size) }} · {{ formatLocalModified(entry.modified) }}</span>
              </div>
            </div>
            <div class="file-actions">
              <button class="icon-button" type="button" title="打开文件位置" aria-label="打开文件位置" @click.stop="openLocalFileLocation(entry)"><UiIcon name="external-link" /></button>
              <button class="icon-button" type="button" title="上传到远端目录" aria-label="上传到远端目录" :disabled="!remoteReady || loading" @click.stop="selectedLocalEntry = entry; uploadSelectedLocalEntry()"><UiIcon name="upload" /></button>
            </div>
          </article>
        </div>
      </section>

      <section class="transfer-pane remote-pane">
        <div class="transfer-pane-head">
          <strong>远端</strong>
          <span>{{ currentPath }}</span>
        </div>
        <div class="sftp-pathbar">
          <button class="icon-button" type="button" title="上级目录" aria-label="上级目录" :disabled="!remoteReady || loading" @click="goParent"><UiIcon name="arrow-left" /></button>
          <input v-model="pathDraft" :disabled="!remoteReady || loading" placeholder="/home/app" @keydown.enter="loadDirectory(pathDraft)" />
          <button type="button" :disabled="!remoteReady || loading" @click="loadDirectory(pathDraft)">打开</button>
        </div>
        <div class="file-list">
          <p v-if="!remoteReady" class="empty-state">SFTP 需要打开一个远程连接。</p>
          <p v-else-if="loading && entries.length === 0" class="empty-state">正在加载 SFTP 目录...</p>
          <p v-else-if="sortedEntries.length === 0" class="empty-state">当前目录为空</p>
          <article
            v-for="entry in sortedEntries"
            :key="entry.path"
            class="file-row"
            :class="{ directory: entry.isDir, active: selectedRemoteEntry?.path === entry.path }"
            @click="selectRemoteEntry(entry)"
            @dblclick="openEntry(entry)"
            @contextmenu.prevent.stop="openRemoteContextMenu($event, entry)"
          >
            <div class="file-main">
              <span class="file-type-icon" :class="{ folder: entry.isDir, file: !entry.isDir }" aria-hidden="true" />
              <div class="file-copy">
                <strong>{{ entry.name }}</strong>
                <span>{{ entry.permissions }} · {{ entry.isDir ? '目录' : formatSize(entry.size) }} · {{ entry.modified }}</span>
              </div>
            </div>
            <div class="file-actions">
              <button v-if="entry.isDir" class="icon-button" type="button" title="打开目录" aria-label="打开目录" @click.stop="openEntry(entry)"><UiIcon name="folder-open" /></button>
              <button class="icon-button" type="button" title="下载到本地目录" aria-label="下载到本地目录" @click.stop="downloadEntry(entry)"><UiIcon name="download" /></button>
              <button class="icon-button danger" type="button" title="删除" aria-label="删除" @click.stop="deleteEntry(entry)"><UiIcon name="trash" /></button>
            </div>
          </article>
        </div>
      </section>
    </div>

        </div>

    <teleport to="body">
      <div v-if="fileContextMenu" class="context-menu-scrim" role="presentation" @click="closeFileContextMenu" @contextmenu.prevent="closeFileContextMenu" />
      <section v-if="fileContextMenu" class="context-menu file-context-menu" role="menu" :style="{ left: `${fileContextMenu.x}px`, top: `${fileContextMenu.y}px` }">
        <strong>{{ fileContextMenu.title }}</strong>
        <button
          v-for="item in fileContextMenu.items"
          :key="item.id"
          type="button"
          role="menuitem"
          :class="{ danger: item.danger }"
          :disabled="item.disabled"
          @click="runFileContextMenuItem(item)"
        >
          {{ item.label }}
        </button>
      </section>
    </teleport>
  </section>
</template>
