import { nextTick, onBeforeUnmount } from 'vue'
import type { AiPanelProps, AiPanelEmit } from '../domain/aiPanel'
import type { AiProviderConfig } from '../domain/provider'
import { MAX_AI_COMMAND_HISTORY, formatSessionDisplayTitle, isAutoSessionName, normalizeGeneratedSessionTitle } from '../domain/aiConversation'
import { planConversationCompaction } from '../domain/conversationCompaction'
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
    const sessionMessages = props.messages.filter((message) => message.workspaceSessionId === sessionId)
    const session = props.workspaceSessions.find((item) => item.id === sessionId)
    let summary = session?.contextSummary?.trim() || ''
    const lastId = session?.contextSummaryLastMessageId || ''
    const cutoff = beforeMessageId ? sessionMessages.findIndex((message) => message.id === beforeMessageId) : -1
    if (cutoff >= 0 && summary && lastId
      && sessionMessages.findIndex((message) => message.id === lastId) >= cutoff) {
      // Inspect the full transcript: the anchor may itself be streaming on retry.
      // A retry inside the summary must not see conclusions from later turns.
      summary = ''
    }
    const eligible = sessionMessages.filter(
      (message, index) => (cutoff < 0 || index < cutoff) && !message.streaming && !message.error && message.text.trim()
    )
    const boundary = summary && lastId ? eligible.findIndex((message) => message.id === lastId) + 1 : 0
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

  const compactingSessionIds = new Set<string>()

  /**
   * Folds older turns into a persisted summary when the count or character
   * budget is reached. Runs after Vue has applied the completed exchange.
   */
  async function maybeCompactConversation(sessionId: string) {
    if (disposed || sessionId !== props.workspaceSessionId || compactingSessionIds.has(sessionId)) return
    compactingSessionIds.add(sessionId)
    try {
      await nextTick()
      if (disposed || sessionId !== props.workspaceSessionId) return
      const config = { ...props.config }
      const apiKey = config.apiKey?.trim() || props.apiKey.trim()
      if (!config.baseUrl.trim() || !config.model.trim() || !apiKey) return
      const session = props.workspaceSessions.find((item) => item.id === sessionId)
      if (!session) return
      const watermark = session.contextSummaryLastMessageId || ''
      const { summary, unsummarized } = conversationContextParts(sessionId)
      const plan = planConversationCompaction(unsummarized)
      if (!plan) return
      const response = await compressAiConversation({
        config,
        apiKey,
        previousSummary: summary || undefined,
        messages: plan.messages
      })
      if (response.sourceCount !== plan.messages.length) return
      const latest = props.workspaceSessions.find((item) => item.id === sessionId)
      // An older background response must not overwrite a newer checkpoint.
      if (!latest || (latest.contextSummary?.trim() || '') !== summary
        || (latest.contextSummaryLastMessageId || '') !== watermark) return
      const nextSummary = response.summary.trim()
      if (nextSummary) emit('updateSessionContextSummary', sessionId, nextSummary, plan.lastMessageId)
    } catch (error) {
      console.error('failed to compress AI conversation context', error)
    } finally {
      compactingSessionIds.delete(sessionId)
    }
  }

  return { aiCommandHistory, conversationContextParts, maybeGenerateSessionTitle, maybeCompactConversation }
}
