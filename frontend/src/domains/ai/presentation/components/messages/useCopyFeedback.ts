import { onBeforeUnmount, ref } from 'vue'

export function useCopyFeedback() {
  const copyFeedback = ref('')
  let feedbackTimer: number | undefined

  async function copyText(value: string) {
    let didCopy = false
    try {
      await navigator.clipboard.writeText(value)
      didCopy = true
    } catch {
      const previousFocus = document.activeElement as HTMLElement | null
      const textarea = document.createElement('textarea')
      textarea.value = value
      textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
      document.body.appendChild(textarea)
      try {
        textarea.select()
        didCopy = document.execCommand('copy')
      } catch {
        didCopy = false
      } finally {
        textarea.remove()
        previousFocus?.focus({ preventScroll: true })
      }
    }
    copyFeedback.value = didCopy ? '已复制' : '复制失败'
    if (feedbackTimer) window.clearTimeout(feedbackTimer)
    feedbackTimer = window.setTimeout(() => { copyFeedback.value = '' }, 1800)
  }

  onBeforeUnmount(() => {
    if (feedbackTimer) window.clearTimeout(feedbackTimer)
  })

  return { copyFeedback, copyText }
}
