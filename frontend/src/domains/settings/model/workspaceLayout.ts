export const MIN_WORKSPACE_WIDTH = 360
export const MAX_WORKSPACE_WIDTH = 560
export const DEFAULT_WORKSPACE_WIDTH = 420

const WORKSPACE_RESIZE_STEP = 20
const COLLAPSED_LEFT_WIDTH = 48
const EXPANDED_LEFT_WIDTH = 296
const MIN_TERMINAL_WIDTH = 560

function clampWorkspaceWidth(width: number): number {
  return Math.max(MIN_WORKSPACE_WIDTH, Math.min(MAX_WORKSPACE_WIDTH, width))
}

export function parseWorkspaceWidth(value: string | null): number {
  const width = Number(value)
  return Number.isFinite(width) ? clampWorkspaceWidth(width) : DEFAULT_WORKSPACE_WIDTH
}

export function getWorkspaceWidthForPointer(viewportWidth: number, clientX: number, leftCollapsed: boolean): number {
  const leftWidth = leftCollapsed ? COLLAPSED_LEFT_WIDTH : EXPANDED_LEFT_WIDTH
  const maxForTerminal = Math.max(MIN_WORKSPACE_WIDTH, viewportWidth - leftWidth - MIN_TERMINAL_WIDTH)
  const maxWidth = Math.min(MAX_WORKSPACE_WIDTH, maxForTerminal)
  return Math.round(Math.max(MIN_WORKSPACE_WIDTH, Math.min(maxWidth, viewportWidth - clientX)))
}

export function getWorkspaceWidthForKey(width: number, key: string): number | undefined {
  if (key === 'ArrowLeft') return clampWorkspaceWidth(width + WORKSPACE_RESIZE_STEP)
  if (key === 'ArrowRight') return clampWorkspaceWidth(width - WORKSPACE_RESIZE_STEP)
  if (key === 'Home') return MIN_WORKSPACE_WIDTH
  if (key === 'End') return MAX_WORKSPACE_WIDTH
  return undefined
}
