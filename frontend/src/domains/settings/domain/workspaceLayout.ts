export const MIN_WORKSPACE_WIDTH = 320
export const MAX_WORKSPACE_WIDTH = 560
export const DEFAULT_WORKSPACE_WIDTH = MIN_WORKSPACE_WIDTH
export const MIN_TERMINAL_WIDTH = 560
export const RAIL_WIDTH = 48

const WORKSPACE_RESIZE_STEP = 20

export interface WorkspaceLayoutPreferences {
  leftCollapsed: boolean
  rightCollapsed: boolean
  workspacePanelTab: 'history' | 'ai' | 'scripts'
  leftPanelMode: 'connections' | 'settings'
}

export function parseWorkspaceLayoutPreferences(value: string | null): WorkspaceLayoutPreferences {
  let stored: Partial<WorkspaceLayoutPreferences> = {}
  try {
    const parsed = JSON.parse(value ?? '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed
  } catch { /* Invalid preferences use the same defaults as a new installation. */ }
  return {
    leftCollapsed: stored.leftCollapsed === true,
    rightCollapsed: stored.rightCollapsed === true,
    workspacePanelTab: stored.workspacePanelTab === 'history' || stored.workspacePanelTab === 'scripts' ? stored.workspacePanelTab : 'ai',
    leftPanelMode: stored.leftPanelMode === 'settings' ? 'settings' : 'connections'
  }
}

function clampWorkspaceWidth(width: number, min = MIN_WORKSPACE_WIDTH, max = MAX_WORKSPACE_WIDTH): number {
  return Math.max(min, Math.min(max, width))
}

export function parseWorkspaceWidth(value: string | null): number {
  if (value === null || value.trim() === '') return DEFAULT_WORKSPACE_WIDTH
  const width = Number(value)
  return Number.isFinite(width) ? clampWorkspaceWidth(width) : DEFAULT_WORKSPACE_WIDTH
}

// One geometry calculation serves rendering, resizing and ARIA ranges.
// Keep the saved preference intact when a smaller viewport constrains it.
export function getWorkspaceLayout(viewportWidth: number, preferredWidth: number, leftCollapsed: boolean, rightCollapsed = false) {
  const sidebarWidth = viewportWidth <= 1280 ? 224 : 248
  const requestedWidth = clampWorkspaceWidth(preferredWidth)
  const sidebarOverlay = viewportWidth - RAIL_WIDTH - sidebarWidth - (rightCollapsed ? 0 : requestedWidth) < MIN_TERMINAL_WIDTH
  const leftWidth = RAIL_WIDTH + (leftCollapsed || sidebarOverlay ? 0 : sidebarWidth)
  const maxWidth = Math.max(0, Math.min(MAX_WORKSPACE_WIDTH, viewportWidth - leftWidth - MIN_TERMINAL_WIDTH))
  const minWidth = Math.min(MIN_WORKSPACE_WIDTH, maxWidth)
  return {
    sidebarWidth,
    sidebarOverlay,
    minWidth,
    maxWidth,
    width: clampWorkspaceWidth(requestedWidth, minWidth, maxWidth)
  }
}

export function getWorkspaceWidthForPointer(viewportWidth: number, clientX: number, leftCollapsed: boolean, preferredWidth = DEFAULT_WORKSPACE_WIDTH): number {
  const { minWidth, maxWidth } = getWorkspaceLayout(viewportWidth, preferredWidth, leftCollapsed)
  return Math.round(clampWorkspaceWidth(viewportWidth - clientX, minWidth, maxWidth))
}

export function getWorkspaceWidthForKey(width: number, key: string, min = MIN_WORKSPACE_WIDTH, max = MAX_WORKSPACE_WIDTH): number | undefined {
  if (key === 'ArrowLeft') return clampWorkspaceWidth(width + WORKSPACE_RESIZE_STEP, min, max)
  if (key === 'ArrowRight') return clampWorkspaceWidth(width - WORKSPACE_RESIZE_STEP, min, max)
  if (key === 'Home') return min
  if (key === 'End') return max
  return undefined
}
