import { computed, onBeforeUnmount, onMounted, readonly, ref } from 'vue'
import type { Ref } from 'vue'
import { loadWorkspaceWidth, persistWorkspaceWidth, getWorkspaceLayout, getWorkspaceWidthForKey, getWorkspaceWidthForPointer } from '../../domains/settings/index'
import type { SettingsStorage } from '../../domains/settings/types'

interface WorkspaceResizeOptions {
  leftCollapsed: Readonly<Ref<boolean>>
  rightCollapsed: Readonly<Ref<boolean>>
  sftpWorkbenchActive: Readonly<Ref<boolean>>
  storage?: SettingsStorage
}

export function useWorkspaceResize(options: WorkspaceResizeOptions) {
  const preferredWidth = ref(loadWorkspaceWidth(options.storage))
  const viewportWidth = ref(window.innerWidth)
  const workspaceResizing = ref(false)
  const layout = computed(() => getWorkspaceLayout(viewportWidth.value, preferredWidth.value, options.leftCollapsed.value, options.rightCollapsed.value || options.sftpWorkbenchActive.value))
  const workspaceWidth = computed(() => layout.value.width)
  const workspaceMinWidth = computed(() => layout.value.minWidth)
  const workspaceMaxWidth = computed(() => layout.value.maxWidth)
  const sidebarOverlay = computed(() => layout.value.sidebarOverlay)
  const workspaceLayoutStyle = computed(() => ({
    '--sidebar-width': layout.value.sidebarWidth + 'px',
    '--workspace-width': workspaceWidth.value + 'px'
  }))

  function updateViewportWidth() { viewportWidth.value = window.innerWidth }

  function handleWorkspaceResize(event: PointerEvent) {
    if (!workspaceResizing.value) return
    updateViewportWidth()
    preferredWidth.value = getWorkspaceWidthForPointer(viewportWidth.value, event.clientX, options.leftCollapsed.value, preferredWidth.value)
  }

  function endWorkspaceResize() {
    if (!workspaceResizing.value) return
    workspaceResizing.value = false
    document.body.classList.remove('workspace-resizing')
    window.removeEventListener('pointermove', handleWorkspaceResize)
    window.removeEventListener('pointerup', endWorkspaceResize)
    window.removeEventListener('pointercancel', endWorkspaceResize)
    persistWorkspaceWidth(preferredWidth.value, options.storage)
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
    if (options.rightCollapsed.value || options.sftpWorkbenchActive.value) return
    updateViewportWidth()
    const nextWidth = getWorkspaceWidthForKey(workspaceWidth.value, event.key, workspaceMinWidth.value, workspaceMaxWidth.value)
    if (nextWidth === undefined) return
    event.preventDefault()
    preferredWidth.value = nextWidth
    persistWorkspaceWidth(preferredWidth.value, options.storage)
  }

  onMounted(() => window.addEventListener('resize', updateViewportWidth))
  onBeforeUnmount(() => {
    endWorkspaceResize()
    window.removeEventListener('resize', updateViewportWidth)
  })

  return { workspaceWidth, workspaceMinWidth, workspaceMaxWidth, sidebarOverlay,
    workspaceResizing: readonly(workspaceResizing), workspaceLayoutStyle,
    beginWorkspaceResize, handleWorkspaceResizeKeydown }
}
