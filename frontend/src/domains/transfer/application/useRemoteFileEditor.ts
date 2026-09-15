import { ref, computed, nextTick, onBeforeUnmount } from 'vue'
import type { Ref } from 'vue'
import type { SftpFileEntry } from '../domain/transfer'
import type { RemoteEditorState, LoadDirectoryOptions } from '../domain/transfer'
import { formatSize, formatError } from '../domain/transferPresentation'
import * as tauri from '../infrastructure/api'

interface RemoteEditorOptions {
  props: { connectionId: string; terminalConnectionGeneration: number }
  currentPath: Ref<string>
  status: Ref<string>
  error: Ref<string>
  remoteReady: () => boolean
  remoteBusy: () => boolean
  remoteRequestEpoch: () => number
  transferStateKey: () => string
  targetOverride: () => { targetHost?: string; targetUsername?: string; profileRoute?: string } | undefined
  isCurrentRemoteRequest: (epoch: number, stateKey: string, generation: number) => boolean
  invalidateRemoteDirectoryCache: (path: string) => void
  loadDirectory: (path: string, options?: LoadDirectoryOptions) => Promise<void>
  targetLabel?: () => string
  verifyBeforeWrite?: () => Promise<unknown>
  onTargetChanged?: (reason: string) => void
}
type RemoteEditorSource = Pick<typeof tauri, 'sftpReadTextFile' | 'sftpSaveTextFile'>

export function useRemoteFileEditor(options: RemoteEditorOptions, source: RemoteEditorSource = tauri) {
  const { props, currentPath, status, error, remoteReady, remoteBusy, remoteRequestEpoch, transferStateKey, targetOverride, isCurrentRemoteRequest, invalidateRemoteDirectoryCache, loadDirectory } = options
  const { sftpReadTextFile, sftpSaveTextFile } = source
  let disposed = false
  let editorRequest = 0
  const REMOTE_TEXT_EDITOR_LIMIT = 2 * 1024 * 1024

  const remoteEditor = ref<RemoteEditorState | null>(null)

  const remoteEditorTextarea = ref<HTMLTextAreaElement | null>(null)

  const remoteEditorDirty = computed(() => Boolean(remoteEditor.value && remoteEditor.value.content !== remoteEditor.value.savedContent))

  function targetIsCurrent(editor: RemoteEditorState) {
    const target = editor.target
    return Boolean(target && remoteReady() && target.connectionId === props.connectionId &&
      target.stateKey === transferStateKey() && target.generation === props.terminalConnectionGeneration &&
      target.epoch === remoteRequestEpoch() && JSON.stringify(target.override ?? {}) === JSON.stringify(targetOverride() ?? {}))
  }

  function reportTargetChange(reason: unknown, editor: RemoteEditorState) {
    const message = reason instanceof Error ? reason.message : String(reason)
    if (message.includes('SFTP_TARGET_CHANGED') && targetIsCurrent(editor))
      options.onTargetChanged?.(message)
  }

  const remoteEditorTargetChanged = computed(() => Boolean(remoteEditor.value && !targetIsCurrent(remoteEditor.value)))

  const remoteEditorLineCount = computed(() => remoteEditor.value ? remoteEditor.value.content.split('\n').length : 0)

  const remoteEditorByteSize = computed(() => remoteEditor.value ? new TextEncoder().encode(remoteEditor.value.content).length : 0)

  async function openRemoteFileEditor(entry: SftpFileEntry) {
    if (entry.isDir || !remoteReady() || remoteBusy()) return
    if (remoteEditor.value) {
      closeRemoteFileEditor()
      if (remoteEditor.value) return
    }
    if (entry.size > REMOTE_TEXT_EDITOR_LIMIT) {
      error.value = `文件超过内置编辑器限制 ${formatSize(REMOTE_TEXT_EDITOR_LIMIT)}，请先下载后使用本机编辑器。`
      return
    }
    const request = ++editorRequest
    const operationEpoch = remoteRequestEpoch()
    const operationStateKey = transferStateKey()
    const operationGeneration = props.terminalConnectionGeneration
    const target = {
      connectionId: props.connectionId, stateKey: operationStateKey, generation: operationGeneration,
      epoch: operationEpoch, label: options.targetLabel?.() || props.connectionId,
      override: targetOverride() ? { ...targetOverride() } : undefined
    }
    remoteEditor.value = {
      name: entry.name,
      path: entry.path,
      content: '',
      savedContent: '',
      revision: '',
      loading: true,
      saving: false,
      error: '',
      target
    }
    error.value = ''
    status.value = `正在打开 ${entry.path}...`
    try {
      const response = await sftpReadTextFile(target.connectionId, entry.path, target.override)
      if (disposed || request !== editorRequest) return
      remoteEditor.value = {
        name: entry.name,
        path: response.path,
        content: response.content,
        savedContent: response.content,
        revision: response.revision,
        loading: false,
        saving: false,
        error: '',
        target
      }
      status.value = `已打开远端文件：${response.path}`
      void nextTick(() => remoteEditorTextarea.value?.focus())
    } catch (err) {
      if (disposed || request !== editorRequest || !remoteEditor.value || remoteEditor.value.path !== entry.path) return
      reportTargetChange(err, remoteEditor.value)
      remoteEditor.value.loading = false
      remoteEditor.value.error = remoteEditorErrorMessage(err)
      status.value = ''
    }
  }

  function closeRemoteFileEditor() {
    const editor = remoteEditor.value
    if (!editor || editor.loading || editor.saving) return
    if (remoteEditorDirty.value && !window.confirm(`放弃对 ${editor.name} 的未保存修改？`)) return
    remoteEditor.value = null
  }

  async function saveRemoteFileEditor(force = false) {
    const editor = remoteEditor.value
    if (!editor || editor.loading || editor.saving || !remoteEditorDirty.value) return
    if (!targetIsCurrent(editor)) {
      editor.error = '原服务器、账号或连接已变化，已停止保存。草稿仍保留，请复制草稿后重新打开目标文件。'
      return
    }
    editor.saving = true
    editor.error = ''
    try {
      await options.verifyBeforeWrite?.()
      if (disposed || remoteEditor.value !== editor) return
      if (!targetIsCurrent(editor)) throw new Error('保存前目标已变化，已阻止写入，草稿仍保留。')
      const target = editor.target!
      const submittedContent = editor.content
      const response = await sftpSaveTextFile(
        target.connectionId,
        editor.path,
        submittedContent,
        editor.revision,
        force,
        target.override
      )
      if (disposed || remoteEditor.value !== editor) return
      if (editor.content === submittedContent) editor.content = response.content
      editor.savedContent = response.content
      editor.revision = response.revision
      editor.path = response.path
      status.value = `已保存远端文件：${response.path}`
      if (targetIsCurrent(editor)) {
        invalidateRemoteDirectoryCache(currentPath.value)
        await loadDirectory(currentPath.value, { force: true, recordHistory: false })
      }
    } catch (err) {
      if (disposed || remoteEditor.value !== editor) return
      reportTargetChange(err, editor)
      const message = formatError(err)
      if (message.includes('REMOTE_FILE_CHANGED:')) {
        const overwrite = window.confirm(`${editor.name} 在远端已被修改。是否覆盖远端版本？`)
        editor.saving = false
        if (overwrite) await saveRemoteFileEditor(true)
        return
      }
      editor.error = remoteEditorErrorMessage(err)
    } finally {
      if (remoteEditor.value === editor) editor.saving = false
    }
  }

  function remoteEditorErrorMessage(err: unknown) {
    const message = formatError(err)
    if (message.includes('editor limit')) return '文件超过 2 MB，不能在内置编辑器中打开。'
    if (message.includes('not valid UTF-8') || message.includes('binary data')) return '该文件不是 UTF-8 文本，不能在内置编辑器中打开。'
    return message
  }

  function handleRemoteEditorKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void saveRemoteFileEditor()
    }
  }

  onBeforeUnmount(() => {
    disposed = true
    editorRequest += 1
    remoteEditor.value = null
  })

  return { remoteEditor, remoteEditorTextarea, remoteEditorDirty, remoteEditorTargetChanged, remoteEditorLineCount, remoteEditorByteSize, openRemoteFileEditor, closeRemoteFileEditor, saveRemoteFileEditor, remoteEditorErrorMessage, handleRemoteEditorKeydown }
}
