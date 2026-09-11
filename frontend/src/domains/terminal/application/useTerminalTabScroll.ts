import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Ref } from 'vue'

interface TerminalTabScrollOptions {
  terminalTabs: Readonly<Ref<readonly { id: string }[]>>
  activeTerminalId: Readonly<Ref<string>>
  leftCollapsed: Readonly<Ref<boolean>>
  rightCollapsed: Readonly<Ref<boolean>>
}

export function useTerminalTabScroll(options: TerminalTabScrollOptions) {
  const sessionTabStrip = ref<HTMLDivElement | null>(null)
  const sessionTabButtons = new Map<string, HTMLButtonElement>()
  const sessionTabScrollLeft = ref(0)
  const sessionTabClientWidth = ref(1)
  const sessionTabScrollWidth = ref(1)
  let sessionTabResizeObserver: ResizeObserver | null = null
  let stopDragging: (() => void) | null = null
  let disposed = false

  const sessionTabOverflow = computed(() => sessionTabScrollWidth.value - sessionTabClientWidth.value > 2)
  const sessionTabThumbStyle = computed(() => {
    const clientWidth = Math.max(1, sessionTabClientWidth.value)
    const scrollWidth = Math.max(clientWidth, sessionTabScrollWidth.value)
    const scrollableWidth = Math.max(1, scrollWidth - clientWidth)
    const widthPercent = Math.max(8, (clientWidth / scrollWidth) * 100)
    const leftPercent = (sessionTabScrollLeft.value / scrollableWidth) * (100 - widthPercent)
    return { left: `${leftPercent}%`, width: `${widthPercent}%` }
  })

  function setSessionTabButton(tabId: string, element: unknown) {
    if (disposed) return
    if (element instanceof HTMLButtonElement) sessionTabButtons.set(tabId, element)
    else sessionTabButtons.delete(tabId)
  }

  function updateSessionTabScrollMetrics() {
    const strip = sessionTabStrip.value
    if (disposed || !strip) return
    sessionTabScrollLeft.value = strip.scrollLeft
    sessionTabClientWidth.value = Math.max(1, strip.clientWidth)
    sessionTabScrollWidth.value = Math.max(1, strip.scrollWidth)
  }

  function handleSessionTabWheel(event: WheelEvent) {
    const strip = sessionTabStrip.value
    if (disposed || !strip || !sessionTabOverflow.value) return
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
    if (!delta) return
    const nextLeft = Math.max(0, Math.min(strip.scrollLeft + delta, strip.scrollWidth - strip.clientWidth))
    if (nextLeft === strip.scrollLeft) return
    event.preventDefault()
    strip.scrollLeft = nextLeft
    updateSessionTabScrollMetrics()
  }

  function handleSessionTabScrollbarPointerDown(event: PointerEvent) {
    if (event.target !== event.currentTarget) return
    const strip = sessionTabStrip.value
    const track = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
    if (disposed || !strip || !track || !sessionTabOverflow.value) return
    const trackRect = track.getBoundingClientRect()
    const widthRatio = sessionTabClientWidth.value / sessionTabScrollWidth.value
    const thumbWidth = Math.max(28, trackRect.width * widthRatio)
    const targetLeft = event.clientX - trackRect.left - thumbWidth / 2
    const scrollableTrack = Math.max(1, trackRect.width - thumbWidth)
    const scrollableContent = Math.max(1, strip.scrollWidth - strip.clientWidth)
    strip.scrollLeft = Math.max(0, Math.min(targetLeft / scrollableTrack, 1)) * scrollableContent
    updateSessionTabScrollMetrics()
  }

  function handleSessionTabThumbPointerDown(event: PointerEvent) {
    const strip = sessionTabStrip.value
    const thumb = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
    const track = thumb?.parentElement
    if (disposed || !strip || !thumb || !track || !sessionTabOverflow.value) return
    stopDragging?.()
    event.preventDefault()
    const startX = event.clientX
    const startLeft = strip.scrollLeft
    const scrollableTrack = Math.max(1, track.clientWidth - thumb.clientWidth)
    const scrollableContent = Math.max(1, strip.scrollWidth - strip.clientWidth)
    const scrollPerPixel = scrollableContent / scrollableTrack
    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextLeft = startLeft + (moveEvent.clientX - startX) * scrollPerPixel
      strip.scrollLeft = Math.max(0, Math.min(nextLeft, scrollableContent))
      updateSessionTabScrollMetrics()
    }
    const finishDragging = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', finishDragging)
      window.removeEventListener('pointercancel', finishDragging)
      if (thumb.hasPointerCapture?.(event.pointerId)) thumb.releasePointerCapture(event.pointerId)
      stopDragging = null
    }
    stopDragging = finishDragging
    thumb.setPointerCapture?.(event.pointerId)
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', finishDragging, { once: true })
    window.addEventListener('pointercancel', finishDragging, { once: true })
  }

  function scrollActiveTerminalTabIntoView() {
    void nextTick(() => {
      if (disposed) return
      sessionTabButtons.get(options.activeTerminalId.value)?.scrollIntoView({
        behavior: 'smooth', block: 'nearest', inline: 'nearest'
      })
      updateSessionTabScrollMetrics()
    })
  }

  onMounted(() => {
    void nextTick(() => {
      if (disposed) return
      updateSessionTabScrollMetrics()
      if (typeof ResizeObserver !== 'undefined' && sessionTabStrip.value) {
        sessionTabResizeObserver = new ResizeObserver(updateSessionTabScrollMetrics)
        sessionTabResizeObserver.observe(sessionTabStrip.value)
      }
    })
    window.addEventListener('resize', updateSessionTabScrollMetrics)
  })

  watch(() => [options.activeTerminalId.value, options.terminalTabs.value.length], scrollActiveTerminalTabIntoView)
  watch(() => [options.leftCollapsed.value, options.rightCollapsed.value], () => void nextTick(updateSessionTabScrollMetrics))

  onBeforeUnmount(() => {
    disposed = true
    stopDragging?.()
    window.removeEventListener('resize', updateSessionTabScrollMetrics)
    sessionTabResizeObserver?.disconnect()
    sessionTabResizeObserver = null
    sessionTabButtons.clear()
  })

  return {
    sessionTabStrip, sessionTabOverflow, sessionTabThumbStyle, setSessionTabButton,
    handleSessionTabScroll: updateSessionTabScrollMetrics, handleSessionTabWheel,
    handleSessionTabScrollbarPointerDown, handleSessionTabThumbPointerDown
  }
}
