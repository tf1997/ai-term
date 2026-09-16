import { ref, onBeforeUnmount } from 'vue'
import type { AiMessage } from '../domain/conversation'
import type { TerminalSelectionEvent } from '../../terminal/types'
import type { AiProviderConfig } from '../domain/provider'
import type { AiPanelProps, AiPanelEmit } from '../domain/aiPanel'
import type { useAiAnswerState } from './useAiAnswerState'
import type { useAiConversationContext } from './useAiConversationContext'
import { MAX_AI_CONVERSATION_MESSAGES, buildQuestionWithSelectedTerminalText, formatAiError, extractPrimaryShellCommand } from '../domain/aiConversation'
import { createAiStreamErrorMessage } from '../domain/aiStreamError'
import { addTokenUsage } from '../domain/tokenUsage'
import * as tauri from '../infrastructure/api'

type ChatSource = Pick<typeof tauri, 'onAiChatStream' | 'chatWithAiProviderStream' | 'cancelTask'>
interface AiChatOptions {
  props: Readonly<AiPanelProps>
  emit: AiPanelEmit
  answerState: ReturnType<typeof useAiAnswerState>
  conversationContext: ReturnType<typeof useAiConversationContext>
}

export function useAiChat({ props, emit, answerState, conversationContext }: AiChatOptions, source: ChatSource = tauri) {
  const { onAiChatStream, chatWithAiProviderStream, cancelTask } = source
  const { isAsking, currentAssistantMessageId, startAnswerTimer, finishAnswerTimer, finishAnswerMessage } = answerState
  const { aiCommandHistory, conversationContextParts, maybeGenerateSessionTitle, maybeCompactConversation } = conversationContext
  let disposed = false
  const currentRequestId = ref('')

  const stopRequested = ref(false)

  /**
   * Runs one chat request against an assistant message that already exists in the
   * transcript. Both the first attempt and an in-place retry go through here, so
   * a retry reuses the same bubble instead of appending a duplicate question.
   */
  async function runChatTurn(
    assistantMessage: AiMessage,
    question: string,
    selectedContext: TerminalSelectionEvent | undefined,
    historyCutoffMessageId: string
  ) {
    if (disposed) return
    const requestConnectionId = assistantMessage.connectionId
    const requestWorkspaceSessionId = assistantMessage.workspaceSessionId
    const requestTerminalId = assistantMessage.terminalId
    const requestConfig = { ...props.config }
    const requestApiKey = requestConfig.apiKey?.trim() || props.apiKey.trim()
    const terminalSnapshot = props.terminalSnapshot
    const commandHistory = aiCommandHistory()
    const { summary: conversationSummary, unsummarized } = conversationContextParts(
      requestWorkspaceSessionId,
      historyCutoffMessageId
    )
    const conversationMessages = unsummarized
      .slice(-MAX_AI_CONVERSATION_MESSAGES)
      .map((message) => ({ role: message.role, content: message.text }))
    isAsking.value = true
    stopRequested.value = false
    let streamedAnswer = ''
    let errorNotified = false
    let unlisten: (() => void) | undefined

    function notifyAiError(detail: string) {
      if (errorNotified) return
      errorNotified = true
      emit('aiError', detail)
    }
    const requestId = `${requestConnectionId}-${requestWorkspaceSessionId}-${requestTerminalId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    currentRequestId.value = requestId
    currentAssistantMessageId.value = assistantMessage.id
    startAnswerTimer()
    // Coalesce chunk-driven message updates: emitting per token re-renders the
    // conversation for every delta, and extracting the shell command re-parses
    // the whole growing answer (O(n²)). Flush on a short trailing timer and let
    // the final updateMessage below carry the complete answer and command.
    let streamFlushTimer: number | undefined
    const cancelStreamFlush = () => {
      if (streamFlushTimer !== undefined) {
        window.clearTimeout(streamFlushTimer)
        streamFlushTimer = undefined
      }
    }
    const flushStreamedAnswer = () => {
      streamFlushTimer = undefined
      if (disposed || stopRequested.value || currentRequestId.value !== requestId) return
      emit('updateMessage', {
        ...assistantMessage,
        text: streamedAnswer,
        command: '',
        streaming: true
      })
    }
    try {
      unlisten = await onAiChatStream(requestId, (event) => {
        if (disposed || stopRequested.value || currentRequestId.value !== requestId || errorNotified) return
        if (event.kind === 'chunk') {
          streamedAnswer += event.delta
          if (streamFlushTimer === undefined) {
            streamFlushTimer = window.setTimeout(flushStreamedAnswer, 80)
          }
        }
        if (event.kind === 'error' && event.error) {
          if (stopRequested.value) return
          cancelStreamFlush()
          notifyAiError(event.error)
          emit('updateMessage', finishAnswerMessage(createAiStreamErrorMessage(assistantMessage, event.error, streamedAnswer)))
        }
      })
      if (disposed || currentRequestId.value !== requestId) return
      const response = await callConfiguredModelStream(
        requestId,
        requestConfig,
        requestApiKey,
        buildQuestionWithSelectedTerminalText(question, selectedContext),
        terminalSnapshot,
        commandHistory,
        conversationMessages,
        conversationSummary
      )
      if (disposed || stopRequested.value || currentRequestId.value !== requestId || errorNotified) return
      cancelStreamFlush()
      const answer = streamedAnswer || response.answer
      const command = extractPrimaryShellCommand(answer)
      // 重试复用同一条消息:累计用量把之前的请求也算进去
      const usage = addTokenUsage(assistantMessage.usage, response.usage)
      emit('setContextStatus', requestConnectionId, requestWorkspaceSessionId, {
        compressed: response.contextCompressed,
        chars: response.contextChars,
        history: response.historyCount
      })
      emit('updateMessage', finishAnswerMessage({
        ...assistantMessage,
        text: answer,
        command,
        error: false,
        streaming: false,
        usage,
        payloadJson: usage ? JSON.stringify({ usage }) : assistantMessage.payloadJson
      }))
      maybeGenerateSessionTitle(
        requestConnectionId,
        requestWorkspaceSessionId,
        question,
        answer,
        terminalSnapshot,
        commandHistory,
        requestConfig,
        requestApiKey
      )
      void maybeCompactConversation(requestWorkspaceSessionId)
    } catch (error) {
      if (disposed || stopRequested.value || currentRequestId.value !== requestId) return
      cancelStreamFlush()
      const detail = formatAiError(error)
      notifyAiError(detail)
      emit('updateMessage', finishAnswerMessage(createAiStreamErrorMessage(assistantMessage, detail, streamedAnswer)))
    } finally {
      cancelStreamFlush()
      unlisten?.()
      if (currentRequestId.value === requestId) {
        finishAnswerTimer(assistantMessage.id)
        currentRequestId.value = ''
        currentAssistantMessageId.value = ''
        stopRequested.value = false
        isAsking.value = false
      }
    }
  }

  function stopCurrentAnswer() {
    const requestId = currentRequestId.value
    if (!requestId || !isAsking.value) return
    stopRequested.value = true
    void cancelTask(requestId).catch((error) => {
      console.error('failed to cancel AI request', error)
    })
    const message = props.messages.find((item) => item.id === currentAssistantMessageId.value)
    if (message) {
      const stoppedText = message.text.trim()
        ? `${message.text.trimEnd()}\n\n[已停止回答]`
        : '[已停止回答]'
      emit('updateMessage', finishAnswerMessage({
        ...message,
        text: stoppedText,
        streaming: false
      }))
    }
    finishAnswerTimer(message?.id ?? currentAssistantMessageId.value)
    currentRequestId.value = ''
    currentAssistantMessageId.value = ''
    isAsking.value = false
  }

  async function callConfiguredModelStream(
    requestId: string,
    config: AiProviderConfig,
    apiKey: string,
    question: string,
    terminalSnapshot: string,
    commandHistory: string[],
    conversationMessages: Array<{ role: 'user' | 'assistant'; content: string }>,
    conversationSummary?: string
  ) {
    if (!config.baseUrl.trim() || !config.model.trim()) {
      throw new Error('请先配置 AI Base URL 和 Model')
    }
    if (!apiKey) {
      throw new Error('请在 AI 配置中填写 API Key 并保存到系统凭据管理器')
    }

    return chatWithAiProviderStream(requestId, {
      config,
      apiKey,
      question,
      terminalSnapshot,
      commandHistory,
      conversationMessages,
      conversationSummary: conversationSummary?.trim() || undefined
    })
  }

  onBeforeUnmount(() => {
    disposed = true
    const requestId = currentRequestId.value
    currentRequestId.value = ''
    if (requestId) void cancelTask(requestId).catch(() => {})
  })

  return { currentRequestId, stopRequested, runChatTurn, stopCurrentAnswer }
}
