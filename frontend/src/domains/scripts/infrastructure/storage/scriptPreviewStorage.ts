import type { UpdateScript } from '../../domain/recording'

export function createScriptPreviewStorage(getStorage: () => Storage = () => window.localStorage) {
  const PREVIEW_SCRIPT_STORAGE_KEY = 'ai-term:update-scripts:v2:global'

  const LEGACY_PREVIEW_SCRIPT_STORAGE_PREFIX = 'ai-term:update-scripts:'

  function parsePreviewScripts(raw: string | null) {
    if (!raw) return { scripts: [] as UpdateScript[], valid: true }
    try {
      const value = JSON.parse(raw)
      return { scripts: Array.isArray(value) ? value as UpdateScript[] : [], valid: Array.isArray(value) }
    } catch {
      return { scripts: [] as UpdateScript[], valid: false }
    }
  }

  function mergePreviewScripts(scriptGroups: UpdateScript[][]) {
    const scriptsById = new Map<string, UpdateScript>()
    scriptGroups.flat().forEach((script) => {
      if (!script || typeof script.id !== 'string' || !script.id) return
      const current = scriptsById.get(script.id)
      if (!current || previewScriptUpdatedAt(script) > previewScriptUpdatedAt(current)) {
        scriptsById.set(script.id, script)
      }
    })
    return [...scriptsById.values()].sort((left, right) => previewScriptUpdatedAt(right) - previewScriptUpdatedAt(left))
  }

  function previewScriptUpdatedAt(script: UpdateScript) {
    const updatedAt = Date.parse(script.updatedAt)
    if (Number.isFinite(updatedAt)) return updatedAt
    const createdAt = Date.parse(script.createdAt)
    return Number.isFinite(createdAt) ? createdAt : 0
  }

  function migratePreviewScripts() {
    try {
      const globalStore = parsePreviewScripts(getStorage().getItem(PREVIEW_SCRIPT_STORAGE_KEY))
      const legacyKeys: string[] = []
      for (let index = 0; index < getStorage().length; index += 1) {
        const key = getStorage().key(index)
        if (key && key !== PREVIEW_SCRIPT_STORAGE_KEY && key.startsWith(LEGACY_PREVIEW_SCRIPT_STORAGE_PREFIX)) {
          legacyKeys.push(key)
        }
      }

      const migratedKeys: string[] = []
      const legacyGroups = legacyKeys.flatMap((key) => {
        const legacyStore = parsePreviewScripts(getStorage().getItem(key))
        if (!legacyStore.valid) return []
        migratedKeys.push(key)
        const sourceConnectionId = key.slice(LEGACY_PREVIEW_SCRIPT_STORAGE_PREFIX.length)
        return [legacyStore.scripts.map((script) => ({
          ...script,
          connectionId: script.connectionId || sourceConnectionId
        }))]
      })
      const mergedScripts = mergePreviewScripts([globalStore.scripts, ...legacyGroups])

      if (globalStore.valid && migratedKeys.length > 0) {
        getStorage().setItem(PREVIEW_SCRIPT_STORAGE_KEY, JSON.stringify(mergedScripts))
        migratedKeys.forEach((key) => getStorage().removeItem(key))
      }
      return mergedScripts
    } catch {
      return [] as UpdateScript[]
    }
  }

  function loadPreviewScripts() {
    return migratePreviewScripts()
  }

  function savePreviewScript(script: UpdateScript) {
    const nextScripts = [script, ...loadPreviewScripts().filter((item) => item.id !== script.id)]
    getStorage().setItem(PREVIEW_SCRIPT_STORAGE_KEY, JSON.stringify(nextScripts))
  }

  function deletePreviewScript(scriptId: string) {
    const nextScripts = loadPreviewScripts().filter((item) => item.id !== scriptId)
    getStorage().setItem(PREVIEW_SCRIPT_STORAGE_KEY, JSON.stringify(nextScripts))
  }

  return { migratePreviewScripts, loadPreviewScripts, savePreviewScript, deletePreviewScript }
}
