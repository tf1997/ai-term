import { onBeforeUnmount, shallowReadonly, shallowRef } from 'vue'
import type { ContextMenuItem, ContextMenuState } from './overlays'
import { contextMenuSource } from './contextMenuInteraction'

export function useContextMenu() {
  const contextMenu = shallowRef<ContextMenuState | null>(null)
  let disposed = false

  function openContextMenu(event: MouseEvent, title: string, items: readonly ContextMenuItem[], description?: string) {
    if (disposed) return
    const sourceElement = contextMenuSource(event)
    contextMenu.value = {
      x: event.clientX,
      y: event.clientY,
      title,
      items,
      ...(description ? { description } : {}),
      ...(sourceElement ? { sourceElement, parentId: sourceElement.closest<HTMLElement>('[data-overlay-id]')?.dataset.overlayId } : {}),
    }
  }

  function closeContextMenu() {
    contextMenu.value = null
  }

  onBeforeUnmount(() => {
    disposed = true
    closeContextMenu()
  })

  return {
    contextMenu: shallowReadonly(contextMenu),
    openContextMenu,
    closeContextMenu
  }
}
