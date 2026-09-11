import { onBeforeUnmount, onMounted, readonly, ref } from 'vue'
import type { ContextMenuItem, ContextMenuState } from './overlays'

export function useContextMenu() {
  const contextMenu = ref<ContextMenuState | null>(null)
  let disposed = false

  function openContextMenu(event: MouseEvent, title: string, items: readonly ContextMenuItem[]) {
    if (disposed) return
    const menuWidth = 220
    const menuHeight = Math.min(320, 34 + items.length * 38)
    contextMenu.value = {
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
      title,
      items
    }
  }

  function closeContextMenu() {
    contextMenu.value = null
  }

  function handleContextMenuKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') closeContextMenu()
  }

  onMounted(() => {
    window.addEventListener('click', closeContextMenu)
    window.addEventListener('keydown', handleContextMenuKeydown)
  })

  onBeforeUnmount(() => {
    disposed = true
    window.removeEventListener('click', closeContextMenu)
    window.removeEventListener('keydown', handleContextMenuKeydown)
    closeContextMenu()
  })

  return {
    contextMenu: readonly(contextMenu),
    openContextMenu,
    closeContextMenu
  }
}
