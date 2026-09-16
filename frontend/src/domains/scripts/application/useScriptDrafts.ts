import { ref } from 'vue'
import type { UpdateScript } from '../domain/recording'

export interface ScriptDocument {
  id: string
  savedScriptId: string
  title: string
  content: string
  revision: number
  connectionId: string
  workspaceSessionId: string
  sourceCommands: string[]
  pending?: { content: string; messageId: string; baseContent: string; baseRevision: number; baseContext: string }
}

export interface ScriptGenerationTarget {
  id: string
  title: string
  content: string
  revision: number
  context: string
  connectionId: string
  workspaceSessionId: string
  sourceCommands: string[]
}

/** Documents own their edits and AI proposals independently of the visible editor. */
export function useScriptDrafts() {
  const documents = ref<Record<string, ScriptDocument>>({})
  let draftNumber = 0

  function createDraft(source: Partial<Pick<ScriptDocument, 'connectionId' | 'workspaceSessionId' | 'sourceCommands'>> = {}) {
    const id = `script-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    documents.value[id] = {
      id, savedScriptId: '', title: `未命名脚本 ${++draftNumber}`, content: '', revision: 0,
      connectionId: source.connectionId ?? '', workspaceSessionId: source.workspaceSessionId ?? '',
      sourceCommands: [...(source.sourceCommands ?? [])]
    }
    return documents.value[id]
  }

  function ensureSaved(script: UpdateScript) {
    const existing = documents.value[script.id]
    if (existing) {
      existing.title = script.name
      return existing
    }
    documents.value[script.id] = {
      id: script.id, savedScriptId: script.id, title: script.name, content: script.content,
      revision: 0, connectionId: script.connectionId, workspaceSessionId: script.workspaceSessionId,
      sourceCommands: [...script.sourceCommands]
    }
    return documents.value[script.id]
  }

  function updateContent(id: string, content: string) {
    const document = documents.value[id]
    if (!document || document.content === content) return
    document.content = content
    document.revision++
  }

  function snapshot(id: string, context: string): ScriptGenerationTarget {
    const document = documents.value[id]
    return { ...document, context, sourceCommands: [...document.sourceCommands] }
  }

  function receiveGeneration(target: ScriptGenerationTarget, content: string, messageId: string, activeId: string, context: string) {
    const document = documents.value[target.id]
    if (!document) return 'unavailable' as const
    if (document.pending || target.id !== activeId || target.revision !== document.revision || target.context !== context) {
      document.pending = { content, messageId, baseContent: target.content, baseRevision: target.revision, baseContext: target.context }
      return 'pending' as const
    }
    updateContent(target.id, content)
    return 'applied' as const
  }

  function acceptPending(id: string) {
    const document = documents.value[id]
    if (!document?.pending) return
    updateContent(id, document.pending.content)
    document.pending = undefined
  }

  function markSaved(script: UpdateScript) {
    const document = ensureSaved(script)
    document.savedScriptId = script.id
    document.title = script.name
  }

  return { documents, createDraft, ensureSaved, updateContent, snapshot, receiveGeneration, acceptPending, markSaved }
}
