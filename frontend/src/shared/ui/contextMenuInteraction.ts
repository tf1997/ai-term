/** Position from the rendered size, allowing the menu to use the entire viewport. */
export function placeContextMenu(x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number) {
  const margin = 8
  return {
    x: Math.max(margin, Math.min(x, viewportWidth - width - margin)),
    y: Math.max(margin, Math.min(y, viewportHeight - height - margin)),
  }
}

export function nextMenuIndex(count: number, current: number, key: string) {
  if (!count) return -1
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (current < 0) return key === 'ArrowUp' ? count - 1 : 0
  return (current + (key === 'ArrowDown' ? 1 : -1) + count) % count
}

export function contextMenuSource(event: MouseEvent): HTMLElement | undefined {
  if (typeof HTMLElement === 'undefined') return undefined
  const target = event.currentTarget instanceof HTMLElement ? event.currentTarget
    : event.target instanceof HTMLElement ? event.target : undefined
  if (!target) return document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  return target.matches('button, input:not(:disabled), [tabindex]') ? target
    : target.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex]') ?? target
}

export function isMenuOwnedBy(target: EventTarget | null, ownerId: string) {
  return target instanceof Element && target.closest<HTMLElement>('[data-menu-parent]')?.dataset.menuParent === ownerId
}

let currentLayer: { close: () => void } | undefined

/** A new menu replaces the previous one without returning focus to its old target. */
export function activateMenuLayer(close: () => void) {
  currentLayer?.close()
  const layer = { close }
  currentLayer = layer
  return {
    isTop: () => currentLayer === layer,
    release: () => { if (currentLayer === layer) currentLayer = undefined },
  }
}
