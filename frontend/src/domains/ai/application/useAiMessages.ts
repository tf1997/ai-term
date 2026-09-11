import { computed, onBeforeUnmount, ref } from 'vue'
import type { AiContextStatus, AiMessage } from '../domain/conversation'
import type { useWorkspaceSessions } from './useWorkspaceSessions'
import { listAiConversationMessages, saveAiConversationMessage } from '../infrastructure/api'
import { hydrateAiMessagePayload, nowText, workspaceSessionTitleFromText } from '../domain/workspaceSessions'

const defaultStorage = { listAiConversationMessages, saveAiConversationMessage }

export function useAiMessages(sessions: ReturnType<typeof useWorkspaceSessions>, storage = defaultStorage) {
  const { listAiConversationMessages, saveAiConversationMessage } = storage
  const aiMessagesBySession = ref<Record<string, AiMessage[]>>({})
  const aiContextBySession = ref<Record<string, AiContextStatus>>({})
  const loadedAiSessions = new Map<string, 'draft' | 'persisted'>()
  const loadingAiSessions = new Map<string, Promise<void>>()
  const aiMessagePersistenceQueues = new Map<string, Promise<void>>()
  const deletingAiSessions = new Map<string, Promise<boolean>>()
  const blockedSessionIds = new Set<string>()
  let disposed = false

  function queueAiMessagePersistence(message: AiMessage) {
    const key = message.workspaceSessionId
    const snapshot = JSON.parse(JSON.stringify(message)) as AiMessage
    const previous = aiMessagePersistenceQueues.get(key) ?? Promise.resolve()
    const task = previous
      .then(() => persistWorkspaceSessionForMessage(snapshot))
      .catch((error) => console.error('failed to save AI conversation message', message.id, error))
    aiMessagePersistenceQueues.set(key, task)
    void task.finally(() => {
      if (aiMessagePersistenceQueues.get(key) === task) aiMessagePersistenceQueues.delete(key)
    })
    return task
  }

  function appendAiMessageToActiveTerminal(message: AiMessage) {
    const key = message.workspaceSessionId
    if (disposed || blockedSessionIds.has(key)) return
    aiMessagesBySession.value = {
      ...aiMessagesBySession.value,
      [key]: [...(aiMessagesBySession.value[key] ?? []), message].slice(-300)
    }
    if (message.streaming) return
    return queueAiMessagePersistence(message)
  }

  function updateAiMessage(message: AiMessage) {
    const key = message.workspaceSessionId
    if (disposed || blockedSessionIds.has(key)) return
    const messages = aiMessagesBySession.value[key] ?? []
    aiMessagesBySession.value = {
      ...aiMessagesBySession.value,
      [key]: messages.map((item) => (item.id === message.id ? message : item))
    }
    if (message.streaming) return
    return queueAiMessagePersistence(message)
  }

  function setAiContextForTerminal(_connectionId: string, workspaceSessionId: string, status: AiContextStatus) {
    if (disposed || blockedSessionIds.has(workspaceSessionId)) return
    aiContextBySession.value = { ...aiContextBySession.value, [workspaceSessionId]: status }
  }

  async function persistWorkspaceSessionForMessage(message: AiMessage) {
    const title = message.role === 'user' ? workspaceSessionTitleFromText(message.text) : undefined
    const session = await sessions.ensurePersistedWorkspaceSession(message.connectionId, message.workspaceSessionId, title)
    await saveAiConversationMessage(message)
    const latestSession = sessions.workspaceSessionById(session.id) ?? session
    const updated = { ...latestSession, updatedAt: message.createdAt || nowText() }
    sessions.upsertWorkspaceSession(updated)
    await sessions.saveSession(updated)
  }

  function loadAiSessionState(workspaceSessionId: string): Promise<void> {
    if (disposed || !workspaceSessionId || blockedSessionIds.has(workspaceSessionId)) return Promise.resolve()
    const kind = sessions.isDraftWorkspaceSession(workspaceSessionId) ? 'draft' : 'persisted'
    const pending = loadingAiSessions.get(workspaceSessionId)
    if (pending) return pending
    if (loadedAiSessions.get(workspaceSessionId) === kind) return Promise.resolve()
    if (kind === 'draft') {
      loadedAiSessions.set(workspaceSessionId, kind)
      aiMessagesBySession.value = {
        ...aiMessagesBySession.value,
        [workspaceSessionId]: aiMessagesBySession.value[workspaceSessionId] ?? []
      }
      return Promise.resolve()
    }
    const task = (async () => {
      try {
        const messages = (await listAiConversationMessages(workspaceSessionId)).map(hydrateAiMessagePayload)
        if (disposed || blockedSessionIds.has(workspaceSessionId)) return
        const localMessages = aiMessagesBySession.value[workspaceSessionId] ?? []
        const localById = new Map(localMessages.map((message) => [message.id, message]))
        const persistedIds = new Set(messages.map((message) => message.id))
        aiMessagesBySession.value = {
          ...aiMessagesBySession.value,
          [workspaceSessionId]: [
            ...messages.map((message) => localById.get(message.id) ?? message),
            ...localMessages.filter((message) => !persistedIds.has(message.id))
          ].slice(-300)
        }
        loadedAiSessions.set(workspaceSessionId, kind)
      } catch (error) {
        console.error('failed to load AI conversation', error)
      }
    })()
    loadingAiSessions.set(workspaceSessionId, task)
    void task.finally(() => {
      if (loadingAiSessions.get(workspaceSessionId) === task) loadingAiSessions.delete(workspaceSessionId)
    })
    return task
  }

  function deleteAiSession(sessionId: string): Promise<boolean> {
    const pending = deletingAiSessions.get(sessionId)
    if (pending) return pending
    if (disposed || blockedSessionIds.has(sessionId)) return Promise.resolve(false)
    blockedSessionIds.add(sessionId)
    const task = (async () => {
      let removed = false
      try {
        await aiMessagePersistenceQueues.get(sessionId)
        removed = await sessions.removeWorkspaceSession(sessionId)
        if (!removed) return false
        delete aiMessagesBySession.value[sessionId]
        delete aiContextBySession.value[sessionId]
        loadedAiSessions.delete(sessionId)
        return true
      } finally {
        if (!removed) blockedSessionIds.delete(sessionId)
        deletingAiSessions.delete(sessionId)
      }
    })()
    deletingAiSessions.set(sessionId, task)
    return task
  }

  onBeforeUnmount(() => { disposed = true })

  return {
    aiMessagesBySession: computed(() => aiMessagesBySession.value),
    aiContextBySession: computed(() => aiContextBySession.value),
    appendAiMessageToActiveTerminal, updateAiMessage, setAiContextForTerminal,
    loadAiSessionState, deleteAiSession
  }
}
