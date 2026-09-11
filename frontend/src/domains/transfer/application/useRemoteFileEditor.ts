import { ref, computed, nextTick, onBeforeUnmount } from 'vue'
import type { Ref } from 'vue'
import type { SftpFileEntry } from '../api'
import type { RemoteEditorState, LoadDirectoryOptions } from '../model/transfer'
import { formatSize, formatError } from '../model/transferPresentation'
import * as tauri from '../api'

interface RemoteEditorOptions {
  props: { connectionId: string; terminalConnectionGeneration: number }
  currentPath: Ref<string>
  status: Ref<string>
  error: Ref<string>
  remoteReady: () => boolean
  remoteBusy: () => boolean
  remoteRequestEpoch: () => number
  transferStateKey: () => string
  targetOverride: () => { targetHost: string; targetUsername?: string } | undefined
  isCurrentRemoteRequest: (epoch: number, stateKey: string, generation: number) => boolean
  invalidateRemoteDirectoryCache: (path: string) => void
  loadDirectory: (path: string, options?: LoadDirectoryOptions) => Promise<void>
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

  const remoteEditorLineCount = computed(() => remoteEditor.value ? remoteEditor.value.content.split('\n').length : 0)

  const remoteEditorByteSize = computed(() => remoteEditor.value ? new TextEncoder().encode(remoteEditor.value.content).length : 0)

  async function openRemoteFileEditor(entry: SftpFileEntry) {
    if (entry.isDir || !remoteReady() || remoteBusy()) return
    if (entry.size > REMOTE_TEXT_EDITOR_LIMIT) {
      error.value = `文件超过内置编辑器限制 ${formatSize(REMOTE_TEXT_EDITOR_LIMIT)}，请先下载后使用本机编辑器。`
      return
    }
    const request = ++editorRequest
    const operationEpoch = remoteRequestEpoch()
    const operationStateKey = transferStateKey()
    const operationGeneration = props.terminalConnectionGeneration
    remoteEditor.value = {
      name: entry.name,
      path: entry.path,
      content: '',
      savedContent: '',
      revision: '',
      loading: true,
      saving: false,
      error: ''
    }
    error.value = ''
    status.value = `正在打开 ${entry.path}...`
    try {
      const response = await sftpReadTextFile(props.connectionId, entry.path, targetOverride())
      if (disposed || request !== editorRequest || !isCurrentRemoteRequest(operationEpoch, operationStateKey, operationGeneration)) return
      remoteEditor.value = {
        name: entry.name,
        path: response.path,
        content: response.content,
        savedContent: response.content,
        revision: response.revision,
        loading: false,
        saving: false,
        error: ''
      }
      status.value = `已打开远端文件：${response.path}`
      void nextTick(() => remoteEditorTextarea.value?.focus())
    } catch (err) {
      if (disposed || request !== editorRequest || !isCurrentRemoteRequest(operationEpoch, operationStateKey, operationGeneration) || !remoteEditor.value || remoteEditor.value.path !== entry.path) return
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
    editor.saving = true
    editor.error = ''
    try {
      const response = await sftpSaveTextFile(
        props.connectionId,
        editor.path,
        editor.content,
        editor.revision,
        force,
        targetOverride()
      )
      if (disposed || remoteEditor.value !== editor) return
      editor.content = response.content
      editor.savedContent = response.content
      editor.revision = response.revision
      editor.path = response.path
      status.value = `已保存远端文件：${response.path}`
      invalidateRemoteDirectoryCache(currentPath.value)
      await loadDirectory(currentPath.value, { force: true, recordHistory: false })
    } catch (err) {
      if (disposed || remoteEditor.value !== editor) return
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

  return { remoteEditor, remoteEditorTextarea, remoteEditorDirty, remoteEditorLineCount, remoteEditorByteSize, openRemoteFileEditor, closeRemoteFileEditor, saveRemoteFileEditor, remoteEditorErrorMessage, handleRemoteEditorKeydown }
}
