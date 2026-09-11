import { computed, ref } from 'vue'
import type { AiPanelMode } from '../domain/agent'
import type { WorkspaceSession } from '../domain/conversation'
import { listWorkspaceSessions, saveWorkspaceSession, deleteWorkspaceSession } from '../infrastructure/api'
import { DEFAULT_AI_SESSION_ID, isAutoWorkspaceSessionName, newWorkspaceSession, nowText } from '../domain/workspaceSessions'

const defaultStorage = { listWorkspaceSessions, saveWorkspaceSession, deleteWorkspaceSession }

interface WorkspaceSessionOptions {
  onRenameError?: (error: unknown) => void
}

export function useWorkspaceSessions(options: WorkspaceSessionOptions = {}, storage = defaultStorage) {
  const { listWorkspaceSessions, deleteWorkspaceSession } = storage
  const workspaceSessions = ref<WorkspaceSession[]>([])
  const draftWorkspaceSessionIds = ref<Record<string, boolean>>({})
  const workspaceSessionListLoaded = ref(false)
  let workspaceSessionListLoadPromise: Promise<void> | null = null
  const pendingSessionSaves = new Map<string, Promise<void>>()
  const deletingSessionIds = new Set<string>()
  const removedSessionIds = new Set<string>()

  function saveWorkspaceSession(session: WorkspaceSession) {
    if (deletingSessionIds.has(session.id) || removedSessionIds.has(session.id)) return Promise.resolve()
    const snapshot = { ...session }
    const previous = pendingSessionSaves.get(session.id) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(() => storage.saveWorkspaceSession(snapshot))
    pendingSessionSaves.set(session.id, task)
    const clear = () => {
      if (pendingSessionSaves.get(session.id) === task) pendingSessionSaves.delete(session.id)
    }
    void task.then(clear, clear)
    return task
  }

  function markDraftWorkspaceSession(sessionId: string) {
    draftWorkspaceSessionIds.value = {
      ...draftWorkspaceSessionIds.value,
      [sessionId]: true
    }
  }

  function clearDraftWorkspaceSession(sessionId: string) {
    const nextDrafts = { ...draftWorkspaceSessionIds.value }
    delete nextDrafts[sessionId]
    draftWorkspaceSessionIds.value = nextDrafts
  }

  function isDraftWorkspaceSession(sessionId: string) {
    return Boolean(draftWorkspaceSessionIds.value[sessionId])
  }

  function workspaceSessionById(sessionId: string) {
    return workspaceSessions.value.find((session) => session.id === sessionId)
  }

  function upsertWorkspaceSession(session: WorkspaceSession) {
    workspaceSessions.value = [session, ...workspaceSessions.value.filter((item) => item.id !== session.id)]
  }

  function replaceWorkspaceSession(session: WorkspaceSession) {
    workspaceSessions.value = workspaceSessions.value.map((item) => (item.id === session.id ? session : item))
  }

  function createDraftWorkspaceSession(connectionId: string, sessionId?: string, name = 'Untitled') {
    const existing = sessionId ? workspaceSessionById(sessionId) : undefined
    if (existing) return existing
    const session = newWorkspaceSession(connectionId, name, sessionId)
    markDraftWorkspaceSession(session.id)
    upsertWorkspaceSession(session)
    return session
  }

  async function ensurePersistedWorkspaceSession(connectionId: string, sessionId = DEFAULT_AI_SESSION_ID, title?: string) {
    await loadWorkspaceSessionList()
    let session = workspaceSessionById(sessionId)
    if (!session) {
      session = createDraftWorkspaceSession(connectionId, sessionId, title || 'Untitled')
    }
    const nextTitle = title?.trim()
    let changed = false
    if (nextTitle && isAutoWorkspaceSessionName(session.name)) {
      session = { ...session, name: nextTitle, updatedAt: nowText() }
      replaceWorkspaceSession(session)
      changed = true
    }
    if (!isDraftWorkspaceSession(session.id)) {
      if (changed) await saveWorkspaceSession(session)
      return session
    }
    await saveWorkspaceSession(session)
    clearDraftWorkspaceSession(session.id)
    return session
  }

  async function renameWorkspaceSession(sessionId: string, name: string) {
    const session = workspaceSessionById(sessionId)
    if (!session) return
    const nextName = name.trim()
    if (!nextName) return
    const updated = { ...session, name: nextName, updatedAt: nowText() }
    replaceWorkspaceSession(updated)
    if (isDraftWorkspaceSession(sessionId)) return
    try {
      await saveWorkspaceSession(updated)
    } catch (error) {
      options.onRenameError?.(error)
    }
  }

  async function updateWorkspaceSessionTitle(connectionId: string, sessionId: string, title: string) {
    const session = workspaceSessionById(sessionId)
    if (!session || !isAutoWorkspaceSessionName(session.name)) return
    const nextTitle = title.trim()
    if (!nextTitle) return
    const updated = { ...session, name: nextTitle, updatedAt: nowText() }
    replaceWorkspaceSession(updated)
    try {
      await saveWorkspaceSession({ ...updated, connectionId: session.connectionId || connectionId })
      clearDraftWorkspaceSession(sessionId)
    } catch (error) {
      console.error('failed to update AI generated session title', error)
    }
  }

  async function updateWorkspaceSessionContextSummary(sessionId: string, summary: string, lastMessageId: string) {
    const session = workspaceSessionById(sessionId)
    if (!session) return
    // Background compaction keeps updatedAt untouched so it never reorders the
    // session list on its own.
    const updated = { ...session, contextSummary: summary, contextSummaryLastMessageId: lastMessageId }
    replaceWorkspaceSession(updated)
    if (isDraftWorkspaceSession(sessionId)) return
    try {
      await saveWorkspaceSession(updated)
    } catch (error) {
      console.error('failed to persist AI conversation context summary', error)
    }
  }

  async function setWorkspaceSessionMode(sessionId: string, mode: AiPanelMode) {
    const session = workspaceSessionById(sessionId)
    if (!session || (session.aiMode ?? 'chat') === mode) return
    const updated = { ...session, aiMode: mode }
    replaceWorkspaceSession(updated)
    if (isDraftWorkspaceSession(sessionId)) return
    try {
      await saveWorkspaceSession(updated)
    } catch (error) {
      console.error('failed to persist AI session mode', error)
    }
  }

  async function loadWorkspaceSessionList() {
    if (workspaceSessionListLoaded.value) return
    if (workspaceSessionListLoadPromise) return workspaceSessionListLoadPromise
    workspaceSessionListLoadPromise = (async () => {
      try {
        const sessions = (await listWorkspaceSessions()).filter((session) => !removedSessionIds.has(session.id))
        const drafts = workspaceSessions.value.filter((session) => isDraftWorkspaceSession(session.id))
        sessions.forEach((session) => {
          if (!isDraftWorkspaceSession(session.id)) return
          clearDraftWorkspaceSession(session.id)
        })
        workspaceSessions.value = [
          ...drafts.filter((draft) => !sessions.some((session) => session.id === draft.id)),
          ...sessions
        ]
        workspaceSessionListLoaded.value = true
      } catch (error) {
        console.error('failed to load global AI sessions', error)
      }
    })()
    try {
      await workspaceSessionListLoadPromise
    } finally {
      workspaceSessionListLoadPromise = null
    }
  }

  async function removeWorkspaceSession(sessionId: string) {
    if (workspaceSessions.value.length - deletingSessionIds.size <= 1 || !workspaceSessionById(sessionId) || deletingSessionIds.has(sessionId)) return false
    deletingSessionIds.add(sessionId)
    try {
      await pendingSessionSaves.get(sessionId)?.catch(() => undefined)
      if (!isDraftWorkspaceSession(sessionId)) await deleteWorkspaceSession(sessionId)
      removedSessionIds.add(sessionId)
      clearDraftWorkspaceSession(sessionId)
      workspaceSessions.value = workspaceSessions.value.filter((session) => session.id !== sessionId)
      return true
    } finally {
      deletingSessionIds.delete(sessionId)
    }
  }

  return {
    workspaceSessions: computed(() => workspaceSessions.value),
    isDraftWorkspaceSession, workspaceSessionById, createDraftWorkspaceSession,
    ensurePersistedWorkspaceSession, upsertWorkspaceSession, saveSession: saveWorkspaceSession,
    renameWorkspaceSession, updateWorkspaceSessionTitle, updateWorkspaceSessionContextSummary,
    setWorkspaceSessionMode, loadWorkspaceSessionList, removeWorkspaceSession
  }
}
