import { onMounted, onBeforeUnmount } from 'vue'

export function useChromeSelection() {
  const selectableTextSelector = [
    'input',
    'textarea',
    'select',
    '[contenteditable="true"]',
    '.terminal-body',
    '.xterm-host',
    'pre',
    'code',
    '.message-body',
    '.script-risk-preview',
    '.script-code-overlay',
    '.script-preview-code'
  ].join(',')

  function targetElement(target: EventTarget | null) {
    return target instanceof Element ? target : null
  }

  function isSelectableTextTarget(target: EventTarget | null) {
    return Boolean(targetElement(target)?.closest(selectableTextSelector))
  }

  function selectionEndpointElement(node: Node | null) {
    return node instanceof Element ? node : node?.parentElement ?? null
  }

  function clearChromeSelection(target?: EventTarget | null) {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return
    const anchorElement = selectionEndpointElement(selection.anchorNode)
    const focusElement = selectionEndpointElement(selection.focusNode)
    if (
      isSelectableTextTarget(target ?? null) ||
      anchorElement?.closest(selectableTextSelector) ||
      focusElement?.closest(selectableTextSelector)
    ) {
      return
    }
    selection.removeAllRanges()
  }

  function handleAppSelectStart(event: Event) {
    const element = targetElement(event.target)
    if (!element?.closest('.app-shell')) return
    if (isSelectableTextTarget(element)) return
    event.preventDefault()
    clearChromeSelection()
  }

  function handleAppDragStart(event: DragEvent) {
    const element = targetElement(event.target)
    if (!element?.closest('.app-shell')) return
    if (isSelectableTextTarget(element)) return
    event.preventDefault()
  }

  function handleGlobalClick(event: MouseEvent) {
    clearChromeSelection(event.target)
  }

  onMounted(() => {
    window.addEventListener('click', handleGlobalClick)
    document.addEventListener('selectstart', handleAppSelectStart, true)
    document.addEventListener('dragstart', handleAppDragStart, true)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('click', handleGlobalClick)
    document.removeEventListener('selectstart', handleAppSelectStart, true)
    document.removeEventListener('dragstart', handleAppDragStart, true)
  })
}
