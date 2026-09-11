import { ref, onBeforeUnmount } from 'vue'
import type { AiPanelProps, AiPanelEmit } from '../domain/aiPanel'
import type { AiProviderConfig } from '../domain/provider'
import { MAX_AI_COMMAND_HISTORY, MAX_AI_CONVERSATION_MESSAGES, AI_CONTEXT_COMPACT_THRESHOLD, formatSessionDisplayTitle, isAutoSessionName, normalizeGeneratedSessionTitle } from '../domain/aiConversation'
import { isSensitiveCommand } from '../../../shared/security/commandPrivacy'
import * as tauri from '../infrastructure/api'

type ConversationSource = Pick<typeof tauri, 'generateAiSessionTitle' | 'compressAiConversation'>

export function useAiConversationContext(props: Readonly<AiPanelProps>, emit: AiPanelEmit, source: ConversationSource = tauri) {
  const { generateAiSessionTitle, compressAiConversation } = source
  let disposed = false
  onBeforeUnmount(() => { disposed = true })
  function aiCommandHistory() {
    return props.commandHistory
      .map((entry) => entry.command)
      .filter((command) => !isSensitiveCommand(command))
      .slice(-MAX_AI_COMMAND_HISTORY)
  }

  /**
   * Splits the session conversation at the compaction watermark: turns covered
   * by the stored AI summary vs. turns that still ship verbatim. If the anchor
   * message no longer exists (cleared or pruned), everything counts as
   * unsummarized and the summary still rides along as extra context.
   *
   * `beforeMessageId` cuts the history short right before that message, so a
   * re-run of an existing turn sees the same history the first attempt saw
   * instead of feeding the model its own question twice.
   */
  function conversationContextParts(sessionId: string, beforeMessageId = '') {
    let eligible = props.messages.filter(
      (message) => !message.streaming && !message.error && message.text.trim()
    )
    if (beforeMessageId) {
      const cutoff = eligible.findIndex((message) => message.id === beforeMessageId)
      if (cutoff >= 0) eligible = eligible.slice(0, cutoff)
    }
    const session = props.workspaceSessions.find((item) => item.id === sessionId)
    const summary = session?.contextSummary?.trim() || ''
    const lastId = session?.contextSummaryLastMessageId || ''
    const boundary =
      summary && lastId ? eligible.findIndex((message) => message.id === lastId) + 1 : 0
    return { summary, eligibleCount: eligible.length, unsummarized: eligible.slice(boundary) }
  }

  function maybeGenerateSessionTitle(
    connectionId: string,
    sessionId: string,
    userMessage: string,
    assistantMessage: string,
    terminalSnapshot: string,
    commandHistory: string[],
    config: AiProviderConfig,
    apiKey: string
  ) {
    const session = props.workspaceSessions.find((item) => item.id === sessionId)
    const currentName = session?.name?.trim() || formatSessionDisplayTitle(props.workspaceSessions.find(item => item.id === props.workspaceSessionId)?.name)
    if (!isAutoSessionName(currentName)) return
    if (!config.baseUrl.trim() || !config.model.trim() || !apiKey) return

    void generateAiSessionTitle({
      config,
      apiKey,
      userMessage,
      assistantMessage,
      terminalSnapshot,
      commandHistory
    })
      .then((response) => {
        if (disposed) return
        const title = normalizeGeneratedSessionTitle(response.title, userMessage)
        if (!title || !isAutoSessionName(currentName)) return
        emit('updateSessionTitle', connectionId, sessionId, title)
      })
      .catch((error) => {
        console.error('failed to generate AI session title', error)
      })
  }

  const compactingSessionIds = ref<Record<string, boolean>>({})

  /**
   * Folds older conversation turns into an AI-generated summary once enough of
   * them pile up beyond the recent window, then persists the summary on the
   * workspace session. Runs in the background after an exchange completes.
   */
  function maybeCompactConversation(sessionId: string) {
    if (sessionId !== props.workspaceSessionId) return
    if (compactingSessionIds.value[sessionId]) return
    const apiKey = props.config.apiKey?.trim() || props.apiKey.trim()
    if (!props.config.baseUrl.trim() || !props.config.model.trim() || !apiKey) return
    const { summary, unsummarized } = conversationContextParts(sessionId)
    const overflowCount = unsummarized.length - MAX_AI_CONVERSATION_MESSAGES
    if (overflowCount < AI_CONTEXT_COMPACT_THRESHOLD) return
    const toCompact = unsummarized.slice(0, overflowCount)
    const lastMessageId = toCompact[toCompact.length - 1]?.id
    if (!lastMessageId) return

    compactingSessionIds.value = { ...compactingSessionIds.value, [sessionId]: true }
    void compressAiConversation({
      config: props.config,
      apiKey,
      previousSummary: summary || undefined,
      messages: toCompact.map((message) => ({ role: message.role, content: message.text }))
    })
      .then((response) => {
        const nextSummary = response.summary.trim()
        if (!nextSummary) return
        emit('updateSessionContextSummary', sessionId, nextSummary, lastMessageId)
      })
      .catch((error) => {
        console.error('failed to compress AI conversation context', error)
      })
      .finally(() => {
        const next = { ...compactingSessionIds.value }
        delete next[sessionId]
        compactingSessionIds.value = next
      })
  }

  return { aiCommandHistory, conversationContextParts, maybeGenerateSessionTitle, maybeCompactConversation }
}
