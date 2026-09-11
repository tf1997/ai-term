import { computed, onBeforeUnmount, readonly, ref } from 'vue'
import type { Ref } from 'vue'
import { loadWorkspaceWidth, persistWorkspaceWidth } from '../../domains/settings/index'
import type { SettingsStorage } from '../../domains/settings/types'
import { getWorkspaceWidthForKey, getWorkspaceWidthForPointer } from '../../domains/settings/index'

interface WorkspaceResizeOptions {
  leftCollapsed: Readonly<Ref<boolean>>
  rightCollapsed: Readonly<Ref<boolean>>
  sftpWorkbenchActive: Readonly<Ref<boolean>>
  storage?: SettingsStorage
}

export function useWorkspaceResize(options: WorkspaceResizeOptions) {
  const workspaceWidth = ref(loadWorkspaceWidth(options.storage))
  const workspaceResizing = ref(false)
  const workspaceLayoutStyle = computed(() => ({ '--workspace-user-width': workspaceWidth.value + 'px' }))

  function handleWorkspaceResize(event: PointerEvent) {
    if (!workspaceResizing.value) return
    workspaceWidth.value = getWorkspaceWidthForPointer(window.innerWidth, event.clientX, options.leftCollapsed.value)
  }

  function endWorkspaceResize() {
    if (!workspaceResizing.value) return
    workspaceResizing.value = false
    document.body.classList.remove('workspace-resizing')
    window.removeEventListener('pointermove', handleWorkspaceResize)
    window.removeEventListener('pointerup', endWorkspaceResize)
    window.removeEventListener('pointercancel', endWorkspaceResize)
    persistWorkspaceWidth(workspaceWidth.value, options.storage)
  }

  function beginWorkspaceResize(event: PointerEvent) {
    if (event.button !== 0 || options.rightCollapsed.value || options.sftpWorkbenchActive.value) return
    workspaceResizing.value = true
    document.body.classList.add('workspace-resizing')
    window.addEventListener('pointermove', handleWorkspaceResize)
    window.addEventListener('pointerup', endWorkspaceResize)
    window.addEventListener('pointercancel', endWorkspaceResize)
    event.preventDefault()
  }

  function handleWorkspaceResizeKeydown(event: KeyboardEvent) {
    const nextWidth = getWorkspaceWidthForKey(workspaceWidth.value, event.key)
    if (nextWidth === undefined) return
    event.preventDefault()
    workspaceWidth.value = nextWidth
    persistWorkspaceWidth(workspaceWidth.value, options.storage)
  }

  onBeforeUnmount(endWorkspaceResize)

  return {
    workspaceWidth: readonly(workspaceWidth),
    workspaceResizing: readonly(workspaceResizing),
    workspaceLayoutStyle,
    beginWorkspaceResize,
    handleWorkspaceResizeKeydown
  }
}
