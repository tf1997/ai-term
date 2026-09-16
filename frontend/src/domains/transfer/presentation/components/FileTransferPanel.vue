<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import ContextMenu from '../../../../shared/ui/ContextMenu.vue'
import { contextMenuSource } from '../../../../shared/ui/contextMenuInteraction'
import type { ConnectionProfile } from '../../../connections/types'
import type { TerminalOutputDeltaEvent } from '../../../terminal/types'
import type { FileTargetBinding, TerminalFileBridge } from '../../domain/fileSession'
import {
  captureFileTarget,
  CONNECTION_FAILURE_LABELS,
  sameFileTarget,
  serverIdentityKey,
} from '../../domain/fileSession'
import { boundedOperation, useSftpConnection } from '../../application/useSftpConnection'
import { useDirectoryBrowser } from '../../application/useDirectoryBrowser'
import type { BrowserEntry, BrowserSnapshot } from '../../application/useDirectoryBrowser'
import { useFileLocations } from '../../application/fileLocations'
import { transferTasks } from '../../application/transferTaskManager'
import type { TransferJob } from '../../application/transferTaskManager'
import { useRemoteFileEditor } from '../../application/useRemoteFileEditor'
import { INLINE_TRANSFER_LIMIT, useTerminalFileTransfer } from '../../application/useTerminalFileTransfer'
import {
  joinLocalPath,
  joinRemotePath,
  localFileName,
  localParentPath,
  remoteParentPath,
} from '../../domain/transferPaths'
import { formatSize, formatError } from '../../domain/transferPresentation'
import {
  cancelTask,
  localHomeDirectory,
  localListDirectory,
  localListRoots,
  localOpenPath,
  onTauriFileDrop,
  onTauriFileDropHover,
  onTauriFileDropCancelled,
  sftpCreateDirectory,
  sftpDeletePath,
  sftpDownloadPath,
  sftpListDirectory,
  sftpUploadPath,
} from '../../infrastructure/api'
import FileBrowserPane from './FileBrowserPane.vue'
import UiIcon from '../../../../shared/ui/UiIcon.vue'
import { trapTabFocus } from '../../../../shared/ui/overlays'

const props = defineProps<{
  terminalId: string
  connectionId: string
  profile?: ConnectionProfile
  terminalStatus: string
  terminalConnectionGeneration: number
  terminalContextVersion?: number
  terminalBridge?: TerminalFileBridge
  profileRoute?: string
  active: boolean
  terminalSnapshot?: string
  terminalOutputEvent?: TerminalOutputDeltaEvent
  profiles?: ConnectionProfile[]
  sessions?: { id: string; title: string }[]
}>()
const emit = defineEmits<{
  focusTerminal: []
  selectSession: [id: string]
  connectProfile: [id: string]
  createConnection: []
}>()
const panel = ref<HTMLElement | null>(null),
  localPane = ref<InstanceType<typeof FileBrowserPane> | null>(null),
  remotePane = ref<InstanceType<typeof FileBrowserPane> | null>(null)
const browsersElement = ref<HTMLElement | null>(null),
  fileInput = ref<HTMLInputElement | null>(null)
const locations = useFileLocations(),
  preferences = locations.preferences
const localHome = ref(''),
  localRoots = ref<string[]>([]),
  serverKey = ref(props.connectionId === 'local' ? 'local' : '')
const mode = ref<'sftp' | 'terminal'>('sftp'),
  terminalPath = ref(''),
  notice = ref(''),
  operationError = ref('')
const manualOpen = ref(false),
  manualHost = ref(''),
  manualUsername = ref(''),
  chosenProfile = ref(''),
  chosenSession = ref('')
const pairsOpen = ref(false),
  pairName = ref(''),
  actionBusy = ref(false)
let actionController: AbortController | null = null,
  disposed = false,
  restoreSequence = 0
const directoryOperations = new Map<string, AbortController>()
const dropHover = ref(false)
let lastDroppedPaths = { signature: '', at: 0 }
let lastFocus: { side: 'local' | 'remote'; kind: 'path' | 'list' } = { side: 'local', kind: 'list' }
const snapshots = new Map<
  string,
  { local: BrowserSnapshot; remote: BrowserSnapshot; mode: 'sftp' | 'terminal'; terminalPath: string }
>()
const connection = useSftpConnection({
  context: () => ({
    terminalId: props.terminalId,
    connectionId: props.connectionId,
    generation: props.terminalConnectionGeneration,
    contextVersion: props.terminalContextVersion ?? 0,
    status: props.terminalStatus,
    profile: props.profile,
  }),
  bridge: () => props.terminalBridge,
  profileRoute: () => props.profileRoute,
  preferredHost: (key) => locations.get(key).preferredHost,
  rememberHost: locations.rememberHost,
})
const c = reactive(connection)
const ready = computed(() => c.phase === 'ready' && Boolean(c.binding))
const saved = computed(() => locations.get(serverKey.value))
const localBrowser = useDirectoryBrowser({
  contextKey: () => serverKey.value || props.terminalId,
  read: async (path) => localListDirectory(resolveLocal(path)),
  onVisited: (path) => locations.remember(serverKey.value, 'local', path),
})
const remoteBrowser = useDirectoryBrowser({
  contextKey: () => serverKey.value,
  enabled: () => ready.value,
  read: async (path) => {
    const target = c.binding ? captureFileTarget(c.binding) : null
    if (!target) throw new Error('请先连接远端服务器。')
    const id = taskId('list'),
      operation = new AbortController()
    const destination = resolveRemote(path)
    directoryOperations.set(id, operation)
    try {
      const result = await boundedOperation(
        () =>
          sftpListDirectory(target.connectionId, destination, target.override, {
            taskId: id,
            timeoutMs: 45_000,
          }),
        45_000,
        operation.signal,
        () => {
          void cancelTask(id).catch(() => {})
        },
      )
      if (!sameFileTarget(target, c.binding)) throw new Error('目录所属目标已变化，已忽略旧结果。')
      return result
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      if (message.includes('SFTP_TARGET_CHANGED') && sameFileTarget(target, c.binding))
        connection.invalidate(message)
      throw reason
    } finally {
      directoryOperations.delete(id)
    }
  },
  onVisited: (path) => locations.remember(serverKey.value, 'remote', path),
})
const terminalTransfer = useTerminalFileTransfer({
  bridge: () => props.terminalBridge,
  generation: () => props.terminalConnectionGeneration,
})
const editorState = useRemoteFileEditor({
  props,
  currentPath: remoteBrowser.path,
  status: notice,
  error: operationError,
  remoteReady: () => ready.value,
  remoteBusy: () => actionBusy.value,
  remoteRequestEpoch: () => c.binding?.revision ?? -1,
  transferStateKey: () => serverKey.value,
  targetOverride: () => c.binding?.override,
  isCurrentRemoteRequest: (epoch, key, generation) =>
    epoch === c.binding?.revision &&
    key === serverKey.value &&
    generation === props.terminalConnectionGeneration,
  invalidateRemoteDirectoryCache: remoteBrowser.invalidate,
  loadDirectory: async (path, options) => {
    await remoteBrowser.load(path, { ...options, preserve: true })
  },
  targetLabel: () => c.binding?.label ?? '',
  verifyBeforeWrite: () => connection.verifyBeforeWrite(),
  onTargetChanged: (reason) => connection.invalidate(reason),
})
const editor = reactive(editorState)
const activeJob = computed(() =>
  transferTasks.jobs.value.find(
    (job) =>
      job.binding.terminalId === props.terminalId &&
      job.binding.serverKey === serverKey.value &&
      (job.status === 'running' || job.status === 'queued'),
  ),
)
const canUseTerminal = computed(() => props.terminalStatus === 'remote')
const headerLabel = computed(() => c.binding?.label || props.profile?.name || '选择远程连接')
const routeChanged = computed(
  () =>
    c.error.includes('SFTP_TARGET_CHANGED') ||
    c.failures.some((failure) => failure.message.includes('SFTP_TARGET_CHANGED')),
)
const stageLabel = computed(() =>
  c.phase === 'identifying'
    ? '正在识别当前服务器'
    : c.phase === 'connecting'
      ? `正在连接 ${c.attempt?.index ?? 1}/${c.attempt?.total ?? 1}：${c.attempt?.host ?? props.profile?.target.host ?? ''}`
      : routeChanged.value
        ? '连接配置已变化，已停止使用旧路线。请按新配置打开会话。'
        : c.error,
)
const currentContextMenu = ref<{
  x: number
  y: number
  name: string
  sourceElement?: HTMLElement
  items: { label: string; danger?: boolean; disabled?: boolean; action: () => void }[]
} | null>(null)
const localInit = Promise.all([
  localHomeDirectory().catch(() => ''),
  localListRoots().catch(() => [] as string[]),
]).then(([home, roots]) => {
  localHome.value = home
  localRoots.value = roots
})

function taskId(kind: string) {
  return `sftp_${kind}_${Date.now()}_${Math.random().toString(36).slice(2)}`
}
function resolveLocal(path: string) {
  const value = path.trim()
  if (!value || value === '~') return localHome.value
  if (/^[a-z]:[\\/]|^[\\/]/i.test(value)) return value
  if (/^~[\\/]/.test(value)) return joinLocalPath(localHome.value, value.slice(2))
  return joinLocalPath(localBrowser.path.value || localHome.value, value)
}
function resolveRemote(path: string) {
  const value = path.trim()
  if (!value || value === '.' || value === '~') return value === '~' ? c.home : value || '.'
  if (value.startsWith('/')) return value
  if (value.startsWith('~/')) return joinRemotePath(c.home, value.slice(2))
  return joinRemotePath(remoteBrowser.path.value || '.', value)
}
function storeView() {
  if (!serverKey.value) return
  snapshots.set(serverKey.value, {
    local: localBrowser.snapshot(),
    remote: remoteBrowser.snapshot(),
    mode: mode.value,
    terminalPath: terminalPath.value,
  })
}
async function restoreServer(target: FileTargetBinding, pathOverride?: string) {
  const sequence = ++restoreSequence
  storeView()
  serverKey.value = target.serverKey
  const runtime = snapshots.get(target.serverKey),
    saved = locations.get(target.serverKey)
  localBrowser.restore(runtime?.local)
  remoteBrowser.restore(runtime?.remote)
  if (runtime) {
    mode.value = runtime.mode
    terminalPath.value = runtime.terminalPath
  } else terminalPath.value = target.identity?.pwd ?? ''
  await localInit
  if (sequence !== restoreSequence || disposed) return
  const localPath = runtime?.local.path || saved.local || localHome.value
  const remotePath =
    pathOverride || runtime?.remote.path || saved.remote || target.identity?.pwd || c.home || '.'
  await Promise.all([
    localBrowser.load(localPath, { preserve: true, recordHistory: !runtime }),
    remoteBrowser.load(remotePath, {
      force: true,
      preserve: !pathOverride,
      recordHistory: !runtime || Boolean(pathOverride),
    }),
  ])
}
async function establish(manual?: { host: string; username: string; profileRoute?: string }, path?: string) {
  currentContextMenu.value = null
  operationError.value = ''
  storeView()
  const target = await connection.connect(manual)
  if (target && !disposed) {
    manualOpen.value = false
    await restoreServer(target, path)
  }
}
function acceptTerminalOutput(event: TerminalOutputDeltaEvent) {
  connection.feedOutput(event)
  terminalTransfer.feedOutput(event)
}
watch(
  () => props.terminalOutputEvent,
  (event) => {
    if (event) acceptTerminalOutput(event)
  },
)
async function activate() {
  if (!props.active || disposed) return
  await localInit
  if (!props.active || disposed) return
  if (!localBrowser.path.value) await localBrowser.load(saved.value.local || localHome.value)
  if (props.profile && ['idle', 'stale'].includes(c.phase)) await establish()
  else if (ready.value) {
    const terminalBusy = transferTasks.jobs.value.some(
      (job) =>
        job.binding.terminalId === props.terminalId &&
        job.mode === 'terminal' &&
        ['running', 'queued'].includes(job.status),
    )
    if (
      c.binding?.source === 'terminal' &&
      !actionBusy.value &&
      !editor.remoteEditor?.saving &&
      !terminalBusy
    ) {
      const target = c.binding
      try {
        await connection.verifyBeforeWrite()
      } catch (reason) {
        if (c.phase === 'stale') await establish()
        else if (sameFileTarget(target, c.binding))
          operationError.value = `未能核对当前终端：${reason instanceof Error ? reason.message : String(reason)}`
        return
      }
    }
    await Promise.all([localBrowser.refreshIfStale(), remoteBrowser.refreshIfStale()])
  }
}
function selectTransferMode(value: 'sftp' | 'terminal') {
  if (mode.value === value) return
  mode.value = value
  if (value === 'sftp') void activate()
}
function toggleDensity() {
  preferences.value.density = preferences.value.density === 'compact' ? 'comfortable' : 'compact'
  locations.persist()
}
function toggleHidden() {
  preferences.value.showHidden = !preferences.value.showHidden
  locations.persist()
}
function dismissNotice() {
  notice.value = ''
  operationError.value = ''
}
function abortDirectoryOperations() {
  directoryOperations.forEach((operation) => operation.abort())
}
watch(() => c.binding?.revision, abortDirectoryOperations, { flush: 'sync' })
watch(
  () => props.active,
  (active) => {
    if (active) void nextTick(activate)
    else {
      storeView()
      currentContextMenu.value = null
      const focused = document.activeElement
      if (focused && panel.value?.contains(focused)) {
        const side = focused.closest('.remote-pane') ? 'remote' : 'local'
        lastFocus = { side, kind: focused.closest('.file-location-control') ? 'path' : 'list' }
      }
    }
  },
  { immediate: true },
)
watch(
  () => [props.terminalStatus, props.terminalConnectionGeneration, props.terminalContextVersion],
  (current, previous) => {
    if (props.terminalStatus !== 'remote' || current[1] !== previous[1] || current[2] !== previous[2]) {
      terminalTransfer.disconnect()
      transferTasks.cancelTerminal(props.terminalId)
    }
    if (props.active && props.profile && ['idle', 'stale'].includes(c.phase)) void nextTick(activate)
  },
)
watch(
  () => preferences.value.showHidden,
  (value) => {
    localBrowser.showHidden.value = value
    remoteBrowser.showHidden.value = value
  },
  { immediate: true },
)

function focusView() {
  void nextTick(() => {
    if (!props.active) return
    if (editor.remoteEditor) {
      editorState.remoteEditorTextarea.value?.focus()
      return
    }
    ;(lastFocus.side === 'local' ? localPane.value : remotePane.value)?.focus(lastFocus.kind)
  })
}
function focusWithin(event: FocusEvent) {
  const target = event.target as HTMLElement
  if (target.closest('.local-pane,.remote-pane'))
    lastFocus = {
      side: target.closest('.remote-pane') ? 'remote' : 'local',
      kind: target.closest('.file-location-control') ? 'path' : 'list',
    }
}
async function openLocation(job: TransferJob) {
  if (job.direction === 'download') {
    await localOpenPath(localParentPath(job.targetPath))
    return
  }
  mode.value = 'sftp'
  await establish(
    {
      host: job.binding.host,
      username: job.binding.username,
      profileRoute: job.binding.override.profileRoute,
    },
    remoteParentPath(job.targetPath),
  )
  const entry = remoteBrowser.entries.value.find((item) => item.path === job.targetPath)
  if (entry) remoteBrowser.select(entry)
  focusView()
}
function confirmClose() {
  if (editor.remoteEditor?.saving || editor.remoteEditor?.loading) return false
  return (
    !editor.remoteEditorDirty ||
    window.confirm(`关闭此会话并放弃 ${editor.remoteEditor?.name} 的未保存修改？`)
  )
}
defineExpose({ focusView, acceptTerminalOutput, openLocation, confirmClose })
watch(
  () => Boolean(editor.remoteEditor),
  (open, wasOpen) => {
    if (!open && wasOpen) focusView()
  },
)

async function guardedAction(action: (signal: AbortSignal) => Promise<void>) {
  if (actionBusy.value || editor.remoteEditor?.saving) return
  actionBusy.value = true
  operationError.value = ''
  actionController = new AbortController()
  const actionTarget = c.binding ? captureFileTarget(c.binding) : null
  try {
    await action(actionController.signal)
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason)
    if (message.includes('SFTP_TARGET_CHANGED') && sameFileTarget(actionTarget, c.binding))
      connection.invalidate(message)
    operationError.value = formatError(reason)
  } finally {
    actionBusy.value = false
    actionController = null
  }
}
function cancelAction() {
  actionController?.abort()
}
async function verify(expected: FileTargetBinding, signal?: AbortSignal) {
  await connection.verifyBeforeWrite(signal)
  if (!sameFileTarget(expected, c.binding)) throw new Error('操作目标已变化，请重新确认。')
  return expected
}
function currentTarget() {
  if (!c.binding || !ready.value) throw new Error('请先连接并确认远端目标。')
  return captureFileTarget(c.binding)
}
function refreshAfter(job: TransferJob) {
  if (disposed || job.status !== 'done' || job.binding.serverKey !== serverKey.value) return
  const browser = job.direction === 'upload' ? remoteBrowser : localBrowser
  const parent =
    job.direction === 'upload' ? remoteParentPath(job.targetPath) : localParentPath(job.targetPath)
  browser.invalidate(parent)
  if (props.active && browser.path.value === parent)
    void browser.load(parent, { force: true, preserve: true, recordHistory: false })
}
async function uploadPaths(paths: string[]) {
  const chosen = [...new Set(paths.filter(Boolean))],
    directory = remoteBrowser.path.value
  if (!chosen.length) {
    operationError.value = '没有读取到本地文件路径，请使用桌面文件管理器或左侧列表。'
    return
  }
  let target: FileTargetBinding
  try {
    target = currentTarget()
  } catch (reason) {
    operationError.value = String(reason)
    return
  }
  await guardedAction(async (signal) => {
    await verify(target, signal)
    for (const source of chosen) {
      const name = localFileName(source),
        destination = joinRemotePath(directory, name)
      const ticket = transferTasks.enqueue({
        binding: target,
        direction: 'upload',
        itemKind: 'item',
        itemName: name,
        sourcePath: source,
        targetPath: destination,
        execute: (id) =>
          sftpUploadPath(target.connectionId, source, directory, target.override, { taskId: id }),
      })
      void ticket.completed.then(refreshAfter)
    }
    notice.value = `已加入 ${chosen.length} 项上传，切换终端后仍会继续。`
  })
}
function uploadDroppedPaths(paths: string[]) {
  dropHover.value = false
  const signature = JSON.stringify([serverKey.value, remoteBrowser.path.value, [...new Set(paths)].sort()])
  if (signature === lastDroppedPaths.signature && Date.now() - lastDroppedPaths.at < 800) return
  if (paths.length) lastDroppedPaths = { signature, at: Date.now() }
  void uploadPaths(paths)
}
async function downloadEntries(entries: BrowserEntry[], expected?: FileTargetBinding) {
  const chosen = entries.map((entry) => ({ ...entry })),
    directory = localBrowser.path.value
  let target: FileTargetBinding
  try {
    target = expected ?? currentTarget()
  } catch (reason) {
    operationError.value = String(reason)
    return
  }
  await guardedAction(async (signal) => {
    await verify(target, signal)
    for (const entry of chosen) {
      const destination = joinLocalPath(directory, entry.name)
      const ticket = transferTasks.enqueue({
        binding: target,
        direction: 'download',
        itemKind: entry.isDir ? 'folder' : 'file',
        itemName: entry.name,
        sourcePath: entry.path,
        targetPath: destination,
        execute: (id) =>
          sftpDownloadPath(target.connectionId, entry.path, directory, entry.isDir, target.override, {
            taskId: id,
          }),
      })
      void ticket.completed.then(refreshAfter)
    }
    notice.value = `已加入 ${chosen.length} 项下载。`
  })
}
async function mutation(
  action: (target: FileTargetBinding, id: string, signal: AbortSignal) => Promise<unknown>,
  expected: FileTargetBinding,
) {
  await guardedAction(async (signal) => {
    await verify(expected, signal)
    const id = taskId('operation')
    await boundedOperation(
      () => action(expected, id, signal),
      45_000,
      signal,
      () => {
        void cancelTask(id).catch(() => {})
      },
    )
    if (sameFileTarget(expected, c.binding)) {
      remoteBrowser.invalidate()
      await remoteBrowser.load(remoteBrowser.path.value, { force: true, preserve: true })
    }
  })
}
function createDirectory() {
  let target: FileTargetBinding
  try {
    target = currentTarget()
  } catch {
    return
  }
  const base = remoteBrowser.path.value,
    name = window.prompt(`在 ${target.label} 的 ${base} 下创建目录`, 'new-folder')
  if (name?.trim())
    void mutation(
      (target, id) =>
        sftpCreateDirectory(target.connectionId, joinRemotePath(base, name.trim()), target.override, {
          taskId: id,
        }),
      target,
    )
}
function deleteEntries(entries: BrowserEntry[], expected?: FileTargetBinding) {
  let target: FileTargetBinding
  try {
    target = expected ?? currentTarget()
  } catch {
    return
  }
  const chosen = entries.map((entry) => ({ ...entry }))
  if (
    !chosen.length ||
    !window.confirm(
      `从 ${target.label} 删除 ${chosen.length} 项？\n${chosen.map((entry) => entry.path).join('\n')}\n此操作无法撤销。`,
    )
  )
    return
  void mutation(async (target, id, signal) => {
    for (const entry of chosen) {
      if (signal.aborted) throw new Error('操作已取消')
      await sftpDeletePath(target.connectionId, entry.path, entry.isDir, target.override, { taskId: id })
    }
  }, target)
}
function runMenuAction(action: () => void) {
  currentContextMenu.value = null
  action()
  focusView()
}
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    notice.value = '已复制'
  } catch {
    operationError.value = '复制失败，请选择文本后手动复制。'
  }
}
function showMenu(event: MouseEvent | KeyboardEvent, entry: BrowserEntry, side: 'local' | 'remote') {
  const rect = (event.target as HTMLElement).getBoundingClientRect(),
    x = event instanceof MouseEvent ? event.clientX : rect.left,
    y = event instanceof MouseEvent ? event.clientY : rect.bottom
  const target = c.binding ? captureFileTarget(c.binding) : undefined
  const items =
    side === 'local'
      ? [
          {
            label: entry.isDir ? '打开目录' : '打开文件位置',
            action: () => {
              if (entry.isDir) void localBrowser.load(entry.path)
              else void localOpenPath(localParentPath(entry.path))
            },
          },
          {
            label: '上传到当前远端目录',
            disabled: !ready.value,
            action: () => void uploadPaths([entry.path]),
          },
          { label: '复制路径', action: () => void copyText(entry.path) },
        ]
      : [
          {
            label: entry.isDir ? '打开目录' : '编辑文件',
            disabled: !ready.value,
            action: () => {
              if (!sameFileTarget(target ?? null, c.binding)) return
              if (entry.isDir) void remoteBrowser.load(entry.path)
              else void editor.openRemoteFileEditor({ ...entry, permissions: entry.permissions ?? '' })
            },
          },
          {
            label: '下载到本地目录',
            disabled: !ready.value,
            action: () => void downloadEntries([entry], target),
          },
          { label: '复制路径', action: () => void copyText(entry.path) },
          {
            label: '删除',
            danger: true,
            disabled: !ready.value,
            action: () => deleteEntries([entry], target),
          },
        ]
  currentContextMenu.value = {
    x,
    y,
    name: entry.name,
    sourceElement: contextMenuSource(event as MouseEvent),
    items,
  }
}

async function locateTerminalDirectory() {
  await guardedAction(async (signal) => {
    const actual = await connection.readIdentity(signal)
    if (!c.binding || serverIdentityKey(props.connectionId, actual) !== c.binding.serverKey) {
      await establish()
      return
    }
    await remoteBrowser.load(actual.pwd, { preserve: false })
  })
}
async function terminalBinding(signal: AbortSignal): Promise<FileTargetBinding> {
  const identity = await connection.readIdentity(signal)
  const host = identity.ips[0] || identity.hostname
  terminalPath.value = terminalPath.value || identity.pwd
  return {
    terminalId: props.terminalId,
    connectionId: props.connectionId,
    generation: props.terminalConnectionGeneration,
    revision: props.terminalContextVersion ?? 0,
    serverKey: serverIdentityKey(props.connectionId, identity),
    host,
    username: identity.username,
    label: `${identity.username}@${host}`,
    source: 'terminal',
    identity,
    override: { targetHost: host, targetUsername: identity.username },
  }
}
async function uploadSmallFiles(event: Event) {
  const input = event.target as HTMLInputElement,
    files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length) return
  await guardedAction(async (signal) => {
    const target = await terminalBinding(signal),
      base = terminalPath.value || target.identity!.pwd
    for (const file of files) {
      if (file.size > INLINE_TRANSFER_LIMIT) throw new Error(`${file.name} 超过 700 KB，请使用 SFTP。`)
      const destination = joinRemotePath(base, file.name)
      const ticket = transferTasks.enqueue({
        binding: target,
        mode: 'terminal',
        direction: 'upload',
        itemName: file.name,
        sourcePath: file.name,
        targetPath: destination,
        execute: (_, signal) => terminalTransfer.upload(file, destination, target, signal),
      })
      void ticket.completed.then(refreshAfter)
    }
  })
}
async function downloadSmallFile() {
  const path = terminalPath.value.trim()
  if (!path) return
  await guardedAction(async (signal) => {
    const target = await terminalBinding(signal),
      name = localFileName(path),
      destination = joinLocalPath(localBrowser.path.value || localHome.value, name)
    const exists = localBrowser.entries.value.some((entry) => entry.path === destination)
    if (exists && !window.confirm(`覆盖本地文件 ${destination}？`)) return
    const ticket = transferTasks.enqueue({
      binding: target,
      mode: 'terminal',
      direction: 'download',
      itemName: name,
      sourcePath: path,
      targetPath: destination,
      execute: (_, signal) => terminalTransfer.download(path, destination, target, signal, exists),
    })
    void ticket.completed.then(refreshAfter)
  })
}
function savePair() {
  locations.savePair(serverKey.value, pairName.value, localBrowser.path.value, remoteBrowser.path.value)
  pairName.value = ''
}
async function usePair(local: string, remote: string) {
  pairsOpen.value = false
  await Promise.all([
    localBrowser.load(local, { preserve: false }),
    remoteBrowser.load(remote, { preserve: false }),
  ])
}
function setSplit(value: number) {
  preferences.value.split = Math.max(35, Math.min(65, value))
}
function resizeMove(event: PointerEvent) {
  const rect = browsersElement.value?.getBoundingClientRect()
  if (rect) setSplit(((event.clientX - rect.left) / rect.width) * 100)
}
function resizeEnd() {
  window.removeEventListener('pointermove', resizeMove)
  window.removeEventListener('pointerup', resizeEnd)
  window.removeEventListener('pointercancel', resizeEnd)
  locations.persist()
}
function resizeStart(event: PointerEvent) {
  if (event.button !== 0) return
  event.preventDefault()
  window.addEventListener('pointermove', resizeMove)
  window.addEventListener('pointerup', resizeEnd)
  window.addEventListener('pointercancel', resizeEnd)
}
function resizeKey(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  setSplit(
    event.key === 'Home'
      ? 35
      : event.key === 'End'
        ? 65
        : preferences.value.split + (event.key === 'ArrowRight' ? 2 : -2),
  )
  locations.persist()
}
function editorKeydown(event: KeyboardEvent) {
  event.stopPropagation()
  if (event.key === 'Escape') {
    event.preventDefault()
    editor.closeRemoteFileEditor()
  } else if (event.key === 'Tab') {
    trapTabFocus(event, event.currentTarget as HTMLElement)
  }
}
function windowFocus() {
  if (props.active && ready.value && !actionBusy.value && !editor.remoteEditor?.saving) void activate()
}
const dropUnlisteners: (() => void)[] = []
function canAcceptDrop() {
  return props.active && mode.value === 'sftp' && ready.value && !actionBusy.value && !editor.remoteEditor
}
function registerDropListener(subscription: Promise<() => void>) {
  void subscription
    .then((stop) => {
      if (disposed) stop()
      else dropUnlisteners.push(stop)
    })
    .catch(() => {})
}
onMounted(() => {
  window.addEventListener('focus', windowFocus)
  registerDropListener(
    onTauriFileDrop((paths) => {
      if (canAcceptDrop()) uploadDroppedPaths(paths)
    }),
  )
  registerDropListener(
    onTauriFileDropHover((paths) => {
      dropHover.value = Boolean(paths.length && canAcceptDrop())
    }),
  )
  registerDropListener(
    onTauriFileDropCancelled(() => {
      dropHover.value = false
    }),
  )
})
onBeforeUnmount(() => {
  disposed = true
  storeView()
  cancelAction()
  abortDirectoryOperations()
  resizeEnd()
  dropUnlisteners.forEach((stop) => stop())
  window.removeEventListener('focus', windowFocus)
  transferTasks.cancelTerminal(props.terminalId)
})
</script>

<template>
  <section
    ref="panel"
    class="files-panel file-workspace"
    :class="`density-${preferences.density}`"
    :style="{ '--file-split': `${preferences.split}%` }"
    @focusin="focusWithin"
  >
    <header class="sftp-panel-head file-workspace-head">
      <div class="sftp-title-copy">
        <strong>文件</strong><span :title="headerLabel">{{ headerLabel }}</span>
      </div>
      <div class="transfer-mode-tabs" role="group" aria-label="传输方式">
        <button
          type="button"
          :class="{ active: mode === 'sftp' }"
          :aria-pressed="mode === 'sftp'"
          @click="selectTransferMode('sftp')"
        >
          SFTP</button
        ><button
          type="button"
          :class="{ active: mode === 'terminal' }"
          :aria-pressed="mode === 'terminal'"
          @click="selectTransferMode('terminal')"
        >
          终端传输
        </button>
      </div>
      <div class="panel-actions">
        <button v-if="props.profile" type="button" :disabled="c.busy || actionBusy" @click="establish()">
          <UiIcon name="network" size="14" />{{ ready ? '重新检测' : '连接' }}</button
        ><button v-if="c.busy" type="button" @click="connection.cancel">取消连接</button
        ><button v-if="actionBusy" type="button" @click="cancelAction">取消操作</button
        ><button
          class="icon-button"
          type="button"
          aria-label="文件显示设置"
          :title="preferences.density === 'compact' ? '切换舒适行高' : '切换紧凑行高'"
          @click="toggleDensity"
        >
          <UiIcon name="list" size="15" /></button
        ><button
          class="icon-button"
          type="button"
          :aria-label="preferences.showHidden ? '隐藏隐藏文件' : '显示隐藏文件'"
          :aria-pressed="preferences.showHidden"
          @click="toggleHidden"
        >
          <UiIcon :name="preferences.showHidden ? 'eye' : 'eye-off'" size="15" />
        </button>
      </div>
    </header>

    <div v-if="c.busy || c.error" class="file-connection-status" :class="{ error: !c.busy }" role="status">
      <div>
        <strong>{{ stageLabel }}</strong
        ><span v-if="c.busy">可以切换终端，当前连接流程会保留。</span>
      </div>
      <button v-if="routeChanged" type="button" @click="emit('connectProfile', connectionId)">
        按新配置打开
      </button>
      <button v-if="!c.busy && profile" type="button" @click="establish()">重试</button
      ><button v-if="profile" type="button" :disabled="c.busy" @click="manualOpen = !manualOpen">
        手动指定
      </button>
    </div>
    <details v-if="c.failures.length" class="file-connection-failures">
      <summary>{{ c.failures.length }} 个地址的连接记录</summary>
      <ul>
        <li v-for="failure in c.failures" :key="failure.host">
          <strong>{{ failure.host }} · {{ CONNECTION_FAILURE_LABELS[failure.kind] }}</strong>
          <p>{{ formatError(failure.message) }}</p>
        </li>
      </ul>
    </details>
    <form
      v-if="manualOpen"
      class="file-manual-target"
      @submit.prevent="establish({ host: manualHost, username: manualUsername })"
    >
      <label>服务器 IP / 主机名<input v-model="manualHost" required placeholder="10.20.0.17" /></label
      ><label>账号<input v-model="manualUsername" required placeholder="deploy" /></label
      ><button type="submit" :disabled="c.busy">连接此目标</button
      ><button type="button" @click="manualOpen = false">收起</button>
    </form>
    <div
      v-if="notice || operationError"
      class="file-operation-notice"
      :class="{ error: Boolean(operationError) }"
      role="status"
    >
      <span>{{ operationError || notice }}</span
      ><button class="icon-button" type="button" aria-label="关闭提示" @click="dismissNotice">
        <UiIcon name="close" size="13" />
      </button>
    </div>

    <div v-if="mode === 'sftp'" class="file-workspace-tools">
      <div>
        <button type="button" :disabled="!ready" :aria-expanded="pairsOpen" @click="pairsOpen = !pairsOpen">
          <UiIcon name="pin" size="14" />路径组合</button
        ><button
          type="button"
          :disabled="!ready || !canUseTerminal || actionBusy"
          title="定位到终端当前目录"
          @click="locateTerminalDirectory"
        >
          <UiIcon name="terminal" size="14" />终端目录
        </button>
      </div>
      <div>
        <button type="button" :disabled="!ready || actionBusy" @click="createDirectory">新建目录</button
        ><button
          type="button"
          :disabled="!ready || actionBusy || !remoteBrowser.selectedEntries.value.length"
          @click="deleteEntries(remoteBrowser.selectedEntries.value)"
        >
          删除选中
        </button>
      </div>
    </div>
    <section v-if="pairsOpen && mode === 'sftp'" class="file-path-pairs">
      <form @submit.prevent="savePair">
        <label
          >保存当前路径组合<input
            v-model="pairName"
            maxlength="80"
            placeholder="例如：发布目录"
            required /></label
        ><button type="submit">保存</button><button type="button" @click="pairsOpen = false">收起</button>
      </form>
      <ul>
        <li v-for="pair in saved.pairs" :key="pair.id">
          <button type="button" @click="usePair(pair.local, pair.remote)">
            <strong>{{ pair.name }}</strong
            ><span>{{ pair.local }} → {{ pair.remote }}</span></button
          ><button
            class="icon-button"
            type="button"
            :aria-label="`删除路径组合 ${pair.name}`"
            @click="locations.deletePair(serverKey, pair.id)"
          >
            <UiIcon name="trash" size="14" />
          </button>
        </li>
      </ul>
      <p v-if="!saved.pairs.length">当前本地和远端目录可以一起保存，之后一次打开。</p>
    </section>

    <div v-if="activeJob" class="file-active-transfer" role="status">
      <div>
        <strong>{{ activeJob.itemName }}</strong
        ><span
          >{{ activeJob.binding.label }} ·
          {{
            activeJob.status === 'queued' ? '排队中' : `${Math.round(activeJob.progressPercent ?? 0)}%`
          }}</span
        ><button type="button" :disabled="activeJob.cancelling" @click="transferTasks.cancel(activeJob.id)">
          取消
        </button>
      </div>
      <progress max="100" :value="activeJob.progressPercent ?? undefined" aria-label="文件传输进度" />
    </div>

    <div v-show="mode === 'sftp'" ref="browsersElement" class="transfer-browser file-browsers">
      <FileBrowserPane
        ref="localPane"
        :active="props.active && mode === 'sftp'"
        :transfer-enabled="ready && !actionBusy"
        side="local"
        :browser="localBrowser"
        :enabled="true"
        :recent="saved.localRecent"
        :bookmarks="saved.localBookmarks"
        :roots="localRoots"
        :home="localHome"
        @open="localOpenPath($event.path)"
        @menu="(event, entry) => showMenu(event, entry, 'local')"
        @bookmark="locations.toggleBookmark(serverKey, 'local', $event)"
        @transfer="uploadPaths(localBrowser.selectedEntries.value.map((entry) => entry.path))"
      />
      <div
        class="file-pane-resizer"
        role="separator"
        aria-label="调整本地和远端宽度"
        aria-orientation="vertical"
        :aria-valuenow="Math.round(preferences.split)"
        aria-valuemin="35"
        aria-valuemax="65"
        tabindex="0"
        @pointerdown="resizeStart"
        @keydown="resizeKey"
      />
      <FileBrowserPane
        ref="remotePane"
        :active="props.active && mode === 'sftp'"
        :transfer-enabled="!actionBusy"
        :drop-hover="dropHover"
        side="remote"
        :browser="remoteBrowser"
        :enabled="ready"
        :identity="c.binding?.label"
        :recent="saved.remoteRecent"
        :bookmarks="saved.remoteBookmarks"
        :home="c.home"
        @open="editor.openRemoteFileEditor({ ...$event, permissions: $event.permissions ?? '' })"
        @menu="(event, entry) => showMenu(event, entry, 'remote')"
        @bookmark="locations.toggleBookmark(serverKey, 'remote', $event)"
        @transfer="downloadEntries(remoteBrowser.selectedEntries.value)"
        @drop="uploadDroppedPaths"
        ><template #empty
          ><UiIcon :name="c.busy ? 'network' : 'folder'" size="28" /><strong>{{
            c.busy ? '正在准备远端文件' : profile ? '连接远端服务器' : '选择一个远程会话'
          }}</strong>
          <p>
            {{
              c.busy
                ? '连接成功后将恢复这台服务器的工作目录。'
                : profile
                  ? '检测当前服务器，或手动指定 IP 和账号。'
                  : '连接后即可在此浏览、上传和下载文件。'
            }}
          </p>
          <template v-if="!c.busy"
            ><div v-if="sessions?.length" class="file-connection-choice">
              <select v-model="chosenSession" aria-label="选择已打开的远程会话">
                <option value="" disabled>已打开的远程会话</option>
                <option v-for="session in sessions" :key="session.id" :value="session.id">
                  {{ session.title }}
                </option></select
              ><button type="button" :disabled="!chosenSession" @click="emit('selectSession', chosenSession)">
                切换到此会话
              </button>
            </div>
            <div v-if="!profile && profiles?.length" class="file-connection-choice">
              <select v-model="chosenProfile" aria-label="选择远程连接">
                <option value="" disabled>选择远程连接</option>
                <option v-for="item in profiles" :key="item.id" :value="item.id">
                  {{ item.name }}
                </option></select
              ><button
                type="button"
                :disabled="!chosenProfile"
                @click="emit('connectProfile', chosenProfile)"
              >
                连接并浏览
              </button>
            </div>
            <div class="file-empty-actions">
              <button v-if="profile" type="button" @click="establish()">
                {{ c.phase === 'error' || c.phase === 'cancelled' ? '重新连接' : '检测并连接' }}</button
              ><button v-if="profile" type="button" @click="manualOpen = true">手动指定目标</button
              ><button v-else type="button" @click="emit('createConnection')">新建连接</button
              ><button type="button" @click="emit('focusTerminal')">前往终端</button>
            </div></template
          ></template
        ></FileBrowserPane
      >
    </div>

    <section v-if="mode === 'terminal'" class="terminal-transfer-panel file-terminal-transfer">
      <div>
        <strong>通过当前终端传输</strong>
        <p>
          适合不支持 SFTP 的服务器。每个文件不超过
          {{ formatSize(INLINE_TRANSFER_LIMIT) }}，执行前会核对服务器和账号。
        </p>
      </div>
      <label
        >远端路径<input
          v-model="terminalPath"
          aria-label="终端传输远端路径"
          placeholder="上传填写目录，下载填写完整文件路径" /></label
      ><label
        >本地下载目录<input
          v-model="localBrowser.draft.value"
          aria-label="终端传输本地目录"
          @keydown.enter="localBrowser.load(localBrowser.draft.value)" /></label
      ><button type="button" @click="localBrowser.load(localBrowser.draft.value)">使用本地目录</button>
      <div>
        <button type="button" :disabled="!canUseTerminal || actionBusy" @click="fileInput?.click()">
          选择文件上传</button
        ><button
          type="button"
          :disabled="!canUseTerminal || !terminalPath || actionBusy"
          @click="downloadSmallFile"
        >
          下载远端文件</button
        ><button type="button" @click="emit('focusTerminal')">前往终端</button>
      </div>
      <p v-if="!canUseTerminal">请先连接一个可执行命令的 SSH 终端。</p>
      <input ref="fileInput" type="file" class="visually-hidden" multiple @change="uploadSmallFiles" />
    </section>

    <ContextMenu v-if="currentContextMenu" :x="currentContextMenu.x" :y="currentContextMenu.y"
      :title="currentContextMenu.name" :source-element="currentContextMenu.sourceElement"
      :items="currentContextMenu.items.map(item => ({ ...item, id: item.label, group: item.danger ? 'danger' : 'common', action: () => runMenuAction(item.action) }))"
      @close="currentContextMenu = null" />
    <Teleport to="body"
      ><div v-if="editor.remoteEditor && props.active" class="modal-backdrop remote-file-editor-backdrop">
        <section
          class="modal remote-file-editor-modal"
          role="dialog"
          aria-modal="true"
          :aria-label="`编辑 ${editor.remoteEditor.name}`"
          @keydown="editorKeydown"
        >
          <header class="modal-head">
            <div>
              <strong>{{ editor.remoteEditor.name }}</strong
              ><span :title="editor.remoteEditor.path"
                >{{ editor.remoteEditor.target?.label }} · {{ editor.remoteEditor.path }}</span
              >
            </div>
            <button
              class="icon-button"
              type="button"
              aria-label="关闭编辑器"
              :disabled="editor.remoteEditor.loading || editor.remoteEditor.saving"
              @click="editor.closeRemoteFileEditor"
            >
              <UiIcon name="close" />
            </button>
          </header>
          <p v-if="editor.remoteEditorTargetChanged" class="file-editor-target-warning" role="alert">
            原服务器或连接已变化，已禁止保存。草稿仍保留，可以复制后重新打开原目标文件。
          </p>
          <div v-if="editor.remoteEditor.loading" class="remote-file-editor-loading">正在读取文件…</div>
          <textarea
            v-else
            :ref="(element) => (editorState.remoteEditorTextarea.value = element as HTMLTextAreaElement)"
            v-model="editor.remoteEditor.content"
            class="remote-file-editor-textarea"
            :aria-label="`编辑 ${editor.remoteEditor.name}`"
            :disabled="editor.remoteEditor.saving"
            spellcheck="false"
            @keydown="editor.handleRemoteEditorKeydown"
          />
          <div
            class="remote-file-editor-status"
            :class="{ error: Boolean(editor.remoteEditor.error) }"
            role="status"
          >
            <span>{{ editor.remoteEditor.error || (editor.remoteEditorDirty ? '未保存' : '已保存') }}</span
            ><span
              >{{ editor.remoteEditorLineCount }} 行 · {{ formatSize(editor.remoteEditorByteSize) }} ·
              UTF-8</span
            >
          </div>
          <footer class="modal-actions">
            <button type="button" @click="copyText(editor.remoteEditor.content)">复制草稿</button
            ><button
              type="button"
              :disabled="editor.remoteEditor.loading || editor.remoteEditor.saving"
              @click="editor.closeRemoteFileEditor"
            >
              关闭</button
            ><button
              type="button"
              :disabled="
                editor.remoteEditorTargetChanged ||
                !editor.remoteEditorDirty ||
                editor.remoteEditor.loading ||
                editor.remoteEditor.saving
              "
              @click="editor.saveRemoteFileEditor()"
            >
              {{ editor.remoteEditor.saving ? '正在保存' : '保存到原服务器' }}
            </button>
          </footer>
        </section>
      </div></Teleport
    >
  </section>
</template>
