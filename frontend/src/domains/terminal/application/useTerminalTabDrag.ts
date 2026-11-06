import { nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue'

type DropTarget = { id: string; side: 'before' | 'after' }
interface Options {
  strip: Ref<HTMLDivElement | null>
  tabs: Readonly<Ref<readonly { id: string }[]>>
  onStart: () => void
  onMove: (id: string, targetId: string, side: DropTarget['side']) => void
}

const DRAG_THRESHOLD = 6
const SCROLL_EDGE = 36
const SCROLL_SPEED = 650

export function useTerminalTabDrag(options: Options) {
  const draggedTabId = ref<string | null>(null)
  const dropTarget = ref<DropTarget | null>(null)
  let gesture: {
    id: string; pointerId: number; button: HTMLElement
    startX: number; startY: number; x: number; y: number
    previousFocus: Element | null
  } | null = null
  let suppressClick = false
  let frame = 0
  let lastFrameTime = 0

  function insideStrip() {
    const bounds = options.strip.value?.getBoundingClientRect()
    return gesture && bounds && gesture.x >= bounds.left && gesture.x <= bounds.right
      && gesture.y >= bounds.top && gesture.y <= bounds.bottom ? bounds : null
  }

  function updateDropTarget() {
    let next: DropTarget | null = null
    if (gesture && insideStrip()) {
      const { id, x } = gesture
      const tabs = Array.from(options.strip.value!.querySelectorAll<HTMLElement>('.tab[data-terminal-id]'))
        .filter(tab => tab.dataset.terminalId !== id)
      const target = tabs.find(tab => x <= tab.getBoundingClientRect().right) ?? tabs[tabs.length - 1]
      if (target?.dataset.terminalId) {
        const bounds = target.getBoundingClientRect()
        next = { id: target.dataset.terminalId, side: x < bounds.left + bounds.width / 2 ? 'before' : 'after' }
      }
    }
    if (next?.id !== dropTarget.value?.id || next?.side !== dropTarget.value?.side) dropTarget.value = next
  }

  function autoScroll(time: number) {
    if (!gesture || !draggedTabId.value) return
    const elapsed = Math.max(0, Math.min(time - lastFrameTime, 32)) / 1000
    lastFrameTime = time
    const strip = options.strip.value
    const bounds = insideStrip()
    if (strip && bounds) {
      const edge = Math.min(SCROLL_EDGE, bounds.width / 3)
      const left = Math.max(0, (bounds.left + edge - gesture.x) / edge)
      const right = Math.max(0, (gesture.x - bounds.right + edge) / edge)
      strip.scrollLeft += (right - left) * SCROLL_SPEED * elapsed
      updateDropTarget()
    }
    frame = requestAnimationFrame(autoScroll)
  }

  function finish() {
    const previous = gesture
    const wasDragging = Boolean(draggedTabId.value)
    gesture = null
    draggedTabId.value = null
    dropTarget.value = null
    cancelAnimationFrame(frame)
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', cancel)
    window.removeEventListener('blur', cancel)
    window.removeEventListener('keydown', keydown, true)
    if (previous) {
      previous.button.removeEventListener('lostpointercapture', cancel)
      if (previous.button.hasPointerCapture(previous.pointerId)) previous.button.releasePointerCapture(previous.pointerId)
      if (wasDragging && previous.previousFocus instanceof HTMLElement) {
        const focused = previous.previousFocus
        // Moving the keyed terminal DOM can blur its input; restore after Vue moves it.
        void nextTick(() => { if (focused.isConnected) focused.focus({ preventScroll: true }) })
      }
    }
  }

  function cancel() { finish() }

  function keydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return
    if (draggedTabId.value) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    finish()
  }

  function move(event: PointerEvent) {
    if (!gesture || event.pointerId !== gesture.pointerId) return
    gesture.x = event.clientX
    gesture.y = event.clientY
    if (!draggedTabId.value) {
      if (Math.hypot(gesture.x - gesture.startX, gesture.y - gesture.startY) < DRAG_THRESHOLD) return
      draggedTabId.value = gesture.id
      suppressClick = true
      gesture.button.setPointerCapture(event.pointerId)
      options.onStart()
      lastFrameTime = performance.now()
      frame = requestAnimationFrame(autoScroll)
    }
    event.preventDefault()
    updateDropTarget()
  }

  function end(event: PointerEvent) {
    if (!gesture || event.pointerId !== gesture.pointerId) return
    const id = draggedTabId.value
    gesture.x = event.clientX
    gesture.y = event.clientY
    updateDropTarget()
    const target = dropTarget.value
    if (id) event.preventDefault()
    finish()
    if (id && target) options.onMove(id, target.id, target.side)
  }

  function startTabDrag(event: PointerEvent, id: string) {
    if (!event.isPrimary || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey
      || options.tabs.value.length < 2 || !(event.currentTarget instanceof HTMLElement)) return
    finish()
    gesture = {
      id, pointerId: event.pointerId, button: event.currentTarget,
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
      previousFocus: document.activeElement
    }
    gesture.button.addEventListener('lostpointercapture', cancel)
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', keydown, true)
  }

  // A completed/cancelled drag must not also select the tab on mouse release.
  function resetDragClick() { suppressClick = false }
  function consumeDragClick(event: MouseEvent) {
    if (!suppressClick || event.detail === 0) return
    suppressClick = false
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  watch(() => options.tabs.value.map(tab => tab.id), ids => {
    if (gesture && !ids.includes(gesture.id)) finish()
  })
  onBeforeUnmount(finish)

  return { draggedTabId, dropTarget, startTabDrag, resetDragClick, consumeDragClick }
}
