import { ref, computed, onBeforeUnmount } from 'vue'
import type { Ref } from 'vue'
import type { ScriptChatMessage } from '../domain/scriptPanel'
import type { UpdateScript } from '../domain/recording'
import { formatError, isTauriUnavailableError, nowText } from '../domain/scriptPresentation'
import { createScriptPreviewStorage } from '../infrastructure/storage/scriptPreviewStorage'
import * as tauri from '../infrastructure/api'

interface ScriptLibraryOptions {
  panelError: Ref<string>
  messages: Ref<ScriptChatMessage[]>
  scriptSourceLabel: (script: UpdateScript) => string
}
type ScriptLibrarySource = Pick<typeof tauri, 'listUpdateScripts' | 'saveUpdateScript' | 'deleteUpdateScript'>

export function useScriptLibrary(options: ScriptLibraryOptions, source: ScriptLibrarySource = tauri, preview = createScriptPreviewStorage()) {
  const { panelError, messages, scriptSourceLabel } = options
  const { listUpdateScripts, saveUpdateScript, deleteUpdateScript } = source
  const { migratePreviewScripts, loadPreviewScripts, savePreviewScript, deletePreviewScript } = preview
  let disposed = false
  onBeforeUnmount(() => { disposed = true })
  const scripts = ref<UpdateScript[]>([])

  const selectedScriptId = ref('')

  const scriptStoreMode = ref<'sqlite' | 'preview'>('sqlite')

  const scriptSearch = ref('')

  const renamingScript = ref<UpdateScript | null>(null)

  const scriptNameDraft = ref('')

  const selectedScript = computed(() => scripts.value.find((script) => script.id === selectedScriptId.value))

  const filteredScripts = computed(() => {
    const keyword = scriptSearch.value.trim().toLowerCase()
    if (!keyword) return scripts.value
    return scripts.value.filter((script) => {
      return `${script.name} ${script.description} ${scriptSourceLabel(script)} ${script.connectionId} ${script.workspaceSessionId}`.toLowerCase().includes(keyword)
    })
  })

  const scriptLibraryEmptyHint = computed(() => {
    return scriptSearch.value.trim() ? '没有匹配的脚本，清空搜索后再试。' : '点击新增生成脚本，或直接粘贴并保存你的脚本。'
  })

  async function loadScripts() {
    try {
      panelError.value = ''
      const loaded = await listUpdateScripts()
      if (disposed) return
      scripts.value = loaded
      scriptStoreMode.value = 'sqlite'
      if (!scripts.value.some((script) => script.id === selectedScriptId.value)) {
        selectedScriptId.value = scripts.value[0]?.id ?? ''
      }
    } catch (error) {
      if (disposed) return
      if (!isTauriUnavailableError(error)) {
        panelError.value = formatError(error)
      }
      scriptStoreMode.value = 'preview'
      scripts.value = loadPreviewScripts()
      selectedScriptId.value = scripts.value[0]?.id ?? ''
    }
  }

  function openRenameScriptDialog(script: UpdateScript) {
    renamingScript.value = script
    scriptNameDraft.value = script.name
  }

  function closeRenameScriptDialog() {
    renamingScript.value = null
    scriptNameDraft.value = ''
  }

  async function renameScript() {
    const script = renamingScript.value
    const nextName = scriptNameDraft.value.trim()
    if (!script || !nextName || nextName === script.name) {
      closeRenameScriptDialog()
      return
    }
    const updated: UpdateScript = {
      ...script,
      name: nextName,
      updatedAt: nowText()
    }
    try {
      panelError.value = ''
      if (scriptStoreMode.value === 'sqlite') {
        await saveUpdateScript(updated)
      } else {
        savePreviewScript(updated)
      }
      scripts.value = scripts.value.map((item) => (item.id === script.id ? updated : item))
      messages.value = messages.value.map((message) => {
        if (message.savedScriptId !== script.id) return message
        return {
          ...message,
          text: message.text || `已打开脚本：${updated.name}`
        }
      })
    } catch (error) {
      panelError.value = formatError(error)
    } finally {
      closeRenameScriptDialog()
    }
  }

  async function removeScript(script: UpdateScript) {
    if (!window.confirm(`删除脚本 ${script.name}？`)) return
    try {
      if (scriptStoreMode.value === 'sqlite') {
        await deleteUpdateScript(script.id)
      } else {
        deletePreviewScript(script.id)
      }
      scripts.value = scripts.value.filter((item) => item.id !== script.id)
      selectedScriptId.value = scripts.value[0]?.id ?? ''
      messages.value = messages.value.map((message) => message.savedScriptId === script.id ? { ...message, savedScriptId: undefined } : message)
    } catch (error) {
      panelError.value = formatError(error)
    }
  }

  return { scripts, selectedScriptId, scriptStoreMode, selectedScript, scriptSearch, filteredScripts, scriptLibraryEmptyHint, loadScripts, renamingScript, scriptNameDraft, openRenameScriptDialog, closeRenameScriptDialog, renameScript, removeScript, savePreviewScript, loadPreviewScripts, migratePreviewScripts }
}
