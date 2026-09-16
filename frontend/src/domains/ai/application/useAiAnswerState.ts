import { ref, onBeforeUnmount } from 'vue'
import type { AiMessage } from '../domain/conversation'
import { formatAiDuration, withAiMessageDuration } from '../domain/aiTiming'

export function useAiAnswerState() {
  const STREAM_TIMER_INTERVAL_MS = 1000

  const isAsking = ref(false)

  const currentAssistantMessageId = ref('')

  const answerElapsedSeconds = ref(0)

  const answerDurations = ref<Record<string, number>>({})

  let answerTimer: number | undefined
  let answerStartedAt: number | undefined

  function startAnswerTimer() {
    stopAnswerTimer()
    answerStartedAt = Date.now()
    answerElapsedSeconds.value = 0
    answerTimer = window.setInterval(() => {
      answerElapsedSeconds.value = Math.max(0, Math.floor((Date.now() - answerStartedAt!) / 1000))
    }, STREAM_TIMER_INTERVAL_MS)
  }

  function stopAnswerTimer() {
    if (answerTimer !== undefined) window.clearInterval(answerTimer)
    answerTimer = undefined
    answerStartedAt = undefined
  }

  function finishAnswerTimer(messageId?: string) {
    // Read the clock at completion: background tabs can throttle interval ticks.
    // Final state notifications and cleanup may both finish the same message.
    const seconds = answerStartedAt !== undefined
      ? Math.max(1, Math.floor((Date.now() - answerStartedAt) / 1000))
      : (messageId ? answerDurations.value[messageId] : undefined) ?? answerElapsedSeconds.value
    if (messageId) {
      answerDurations.value = {
        ...answerDurations.value,
        [messageId]: seconds
      }
    }
    stopAnswerTimer()
    answerElapsedSeconds.value = 0
    return seconds
  }

  function finishAnswerMessage(message: AiMessage) {
    return withAiMessageDuration(message, finishAnswerTimer(message.id))
  }

  function messageAnswerDuration(message: AiMessage) {
    if (message.streaming && message.id === currentAssistantMessageId.value) return answerElapsedSeconds.value
    return answerDurations.value[message.id] ?? message.durationSeconds ?? 0
  }

  onBeforeUnmount(stopAnswerTimer)
  return { isAsking, currentAssistantMessageId, answerElapsedSeconds, answerDurations, startAnswerTimer, stopAnswerTimer, finishAnswerTimer, finishAnswerMessage, messageAnswerDuration, formatAnswerDuration: formatAiDuration }
}
