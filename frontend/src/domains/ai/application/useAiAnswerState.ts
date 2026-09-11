import { ref, onBeforeUnmount } from 'vue'
import type { AiMessage } from '../model/conversation'

export function useAiAnswerState() {
  const STREAM_TIMER_INTERVAL_MS = 1000

  const isAsking = ref(false)

  const currentAssistantMessageId = ref('')

  const answerElapsedSeconds = ref(0)

  const answerDurations = ref<Record<string, number>>({})

  let answerTimer: number | undefined

  function startAnswerTimer() {
    stopAnswerTimer()
    const startedAt = Date.now()
    answerElapsedSeconds.value = 0
    answerTimer = window.setInterval(() => {
      answerElapsedSeconds.value = Math.floor((Date.now() - startedAt) / 1000)
    }, STREAM_TIMER_INTERVAL_MS)
  }

  function stopAnswerTimer() {
    if (answerTimer !== undefined) window.clearInterval(answerTimer)
    answerTimer = undefined
  }

  function finishAnswerTimer(messageId?: string) {
    const seconds = answerTimer !== undefined ? Math.max(1, answerElapsedSeconds.value) : answerElapsedSeconds.value
    if (messageId) {
      answerDurations.value = {
        ...answerDurations.value,
        [messageId]: seconds
      }
    }
    stopAnswerTimer()
    answerElapsedSeconds.value = 0
  }

  function messageAnswerDuration(message: AiMessage) {
    if (message.streaming && message.id === currentAssistantMessageId.value) return answerElapsedSeconds.value
    return answerDurations.value[message.id] ?? 0
  }

  function formatAnswerDuration(seconds: number) {
    const safeSeconds = Math.max(0, Math.floor(seconds))
    if (safeSeconds < 60) return `${safeSeconds} 秒`
    const minutes = Math.floor(safeSeconds / 60)
    const remainder = safeSeconds % 60
    return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分钟`
  }

  onBeforeUnmount(stopAnswerTimer)
  return { isAsking, currentAssistantMessageId, answerElapsedSeconds, answerDurations, startAnswerTimer, stopAnswerTimer, finishAnswerTimer, messageAnswerDuration, formatAnswerDuration }
}
