export type ToastKind = 'success' | 'error' | 'warning' | 'info'

export interface AppToast {
  id: string
  kind: ToastKind
  title: string
  message?: string
}

export interface ContextMenuItem {
  id: string
  label: string
  danger?: boolean
  disabled?: boolean
  action: () => void
}

export interface ContextMenuState {
  x: number
  y: number
  title?: string
  items: readonly ContextMenuItem[]
}

export function trapTabFocus(event: KeyboardEvent, container: HTMLElement) {
  if (event.key !== 'Tab') return
  const items = [
    ...container.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
    ),
  ].filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0)
  const first = items[0],
    last = items[items.length - 1]
  if (!first) {
    event.preventDefault()
    return
  }
  if (
    !container.contains(document.activeElement) ||
    (event.shiftKey ? document.activeElement === first : document.activeElement === last)
  ) {
    event.preventDefault()
    ;(event.shiftKey ? last : first)?.focus()
  }
}
