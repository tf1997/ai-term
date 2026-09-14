import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Ref } from 'vue'

interface TerminalTabScrollOptions {
  terminalTabs: Readonly<Ref<readonly { id: string }[]>>
  activeTerminalId: Readonly<Ref<string>>
  leftCollapsed?: Readonly<Ref<boolean>>
  rightCollapsed?: Readonly<Ref<boolean>>
}

// scrollLeft can contain subpixels even though clientWidth and scrollWidth are integers.
const SCROLL_EPSILON = 1
const WHEEL_LINE_HEIGHT = 16

export function useTerminalTabScroll(options: TerminalTabScrollOptions) {
  const sessionTabStrip = ref<HTMLDivElement | null>(null)
  const sessionTabElements = new Map<string, HTMLElement>()
  const sessionTabScrollLeft = ref(0)
  const sessionTabClientWidth = ref(0)
  const sessionTabScrollWidth = ref(0)
  let sessionTabResizeObserver: ResizeObserver | null = null
  let revealScheduled = false
  let revealBehavior: ScrollBehavior = 'auto'
  let disposed = false

  const sessionTabMaxScrollLeft = computed(() => Math.max(0, sessionTabScrollWidth.value - sessionTabClientWidth.value))
  const sessionTabOverflow = computed(() => sessionTabClientWidth.value > 0 && sessionTabMaxScrollLeft.value > SCROLL_EPSILON)
  const sessionTabCanScrollLeft = computed(() => sessionTabOverflow.value && sessionTabScrollLeft.value > SCROLL_EPSILON)
  const sessionTabCanScrollRight = computed(() => sessionTabOverflow.value && sessionTabScrollLeft.value < sessionTabMaxScrollLeft.value - SCROLL_EPSILON)

  function updateSessionTabScrollMetrics() {
    if (disposed) return
    const strip = sessionTabStrip.value
    const clientWidth = Math.max(0, strip?.clientWidth ?? 0)
    const scrollWidth = Math.max(0, strip?.scrollWidth ?? 0)
    sessionTabClientWidth.value = clientWidth
    sessionTabScrollWidth.value = scrollWidth
    sessionTabScrollLeft.value = Math.max(0, Math.min(strip?.scrollLeft ?? 0, Math.max(0, scrollWidth - clientWidth)))
  }

  function scrollStripTo(strip: HTMLDivElement, left: number, behavior: ScrollBehavior) {
    const nextLeft = Math.max(0, Math.min(left, strip.scrollWidth - strip.clientWidth))
    if (Math.abs(nextLeft - strip.scrollLeft) <= SCROLL_EPSILON) return
    strip.scrollTo({ left: nextLeft, behavior })
    updateSessionTabScrollMetrics()
  }

  function revealActiveTerminalTab(behavior: ScrollBehavior) {
    const strip = sessionTabStrip.value
    const tab = sessionTabElements.get(options.activeTerminalId.value)
    if (disposed || !strip || !tab || strip.clientWidth <= 0 || !strip.contains(tab)) return
    const stripRect = strip.getBoundingClientRect()
    const tabRect = tab.getBoundingClientRect()
    const visibleLeft = stripRect.left + strip.clientLeft
    const visibleRight = visibleLeft + strip.clientWidth
    let delta = 0
    if (tabRect.width > strip.clientWidth || tabRect.left < visibleLeft) {
      delta = tabRect.left - visibleLeft
    } else if (tabRect.right > visibleRight) {
      delta = tabRect.right - visibleRight
    }
    // Only scroll this strip: scrollIntoView also moves ancestors and can shift the workspace.
    scrollStripTo(strip, strip.scrollLeft + delta, behavior)
  }

  function scheduleActiveTabReveal(behavior: ScrollBehavior = 'auto') {
    if (disposed) return
    if (!revealScheduled || behavior === 'smooth') revealBehavior = behavior
    if (revealScheduled) return
    revealScheduled = true
    void nextTick(() => {
      revealScheduled = false
      if (disposed) return
      updateSessionTabScrollMetrics()
      revealActiveTerminalTab(revealBehavior)
    })
  }

  function setSessionTabButton(tabId: string, element: unknown) {
    if (disposed) return
    // The selection button excludes its sibling close button; measure the complete tab.
    const tab = typeof HTMLButtonElement !== 'undefined' && element instanceof HTMLButtonElement
      ? element.closest<HTMLElement>('.tab') ?? element
      : undefined
    const previousTab = sessionTabElements.get(tabId)
    if (tab === previousTab) return
    if (previousTab) sessionTabResizeObserver?.unobserve(previousTab)
    if (tab) {
      sessionTabElements.set(tabId, tab)
      sessionTabResizeObserver?.observe(tab)
    } else {
      sessionTabElements.delete(tabId)
    }
    scheduleActiveTabReveal()
  }

  function scrollSessionTabs(direction: -1 | 1) {
    const strip = sessionTabStrip.value
    if (disposed || !strip || strip.clientWidth <= 0) return
    updateSessionTabScrollMetrics()
    const currentLeft = Math.max(0, Math.min(strip.scrollLeft, sessionTabMaxScrollLeft.value))
    scrollStripTo(strip, currentLeft + direction * strip.clientWidth * 0.75, 'smooth')
  }

  function handleSessionTabWheel(event: WheelEvent) {
    const strip = sessionTabStrip.value
    if (disposed || !strip || event.ctrlKey || strip.clientWidth <= 0) return
    updateSessionTabScrollMetrics()
    if (!sessionTabOverflow.value) return
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
    if (!delta || !Number.isFinite(delta)) return
    const unit = event.deltaMode === 1 ? WHEEL_LINE_HEIGHT : event.deltaMode === 2 ? strip.clientWidth : 1
    const currentLeft = Math.max(0, Math.min(strip.scrollLeft, sessionTabMaxScrollLeft.value))
    const nextLeft = Math.max(0, Math.min(currentLeft + delta * unit, sessionTabMaxScrollLeft.value))
    if (nextLeft === currentLeft) return
    event.preventDefault()
    strip.scrollLeft = nextLeft
    updateSessionTabScrollMetrics()
  }

  function handleSessionTabResize() {
    if (disposed) return
    updateSessionTabScrollMetrics()
    scheduleActiveTabReveal()
  }

  onMounted(() => {
    window.addEventListener('resize', handleSessionTabResize)
    void nextTick(() => {
      if (disposed) return
      if (typeof ResizeObserver !== 'undefined') {
        sessionTabResizeObserver = new ResizeObserver(handleSessionTabResize)
        if (sessionTabStrip.value) sessionTabResizeObserver.observe(sessionTabStrip.value)
        for (const tab of sessionTabElements.values()) sessionTabResizeObserver.observe(tab)
      }
      updateSessionTabScrollMetrics()
      revealActiveTerminalTab('auto')
    })
  })

  watch(sessionTabStrip, (strip, previousStrip) => {
    if (disposed) return
    if (previousStrip) sessionTabResizeObserver?.unobserve(previousStrip)
    if (strip) sessionTabResizeObserver?.observe(strip)
    scheduleActiveTabReveal()
  }, { flush: 'post' })
  watch([
    () => options.activeTerminalId.value,
    () => options.terminalTabs.value.map(tab => tab.id)
  ], ([activeId, ids], [previousActiveId, previousIds]) => {
    // Status updates replace the tabs array too; preserve any position the user scrolled to.
    if (activeId === previousActiveId && ids.length === previousIds.length && ids.every((id, index) => id === previousIds[index])) return
    scheduleActiveTabReveal('smooth')
  }, { flush: 'post' })
  watch(() => [options.leftCollapsed?.value, options.rightCollapsed?.value], () => scheduleActiveTabReveal(), { flush: 'post' })

  onBeforeUnmount(() => {
    disposed = true
    window.removeEventListener('resize', handleSessionTabResize)
    sessionTabResizeObserver?.disconnect()
    sessionTabResizeObserver = null
    sessionTabElements.clear()
  })

  return {
    sessionTabStrip, sessionTabOverflow, sessionTabCanScrollLeft, sessionTabCanScrollRight,
    setSessionTabButton, scrollSessionTabs,
    handleSessionTabScroll: updateSessionTabScrollMetrics, handleSessionTabWheel
  }
}
