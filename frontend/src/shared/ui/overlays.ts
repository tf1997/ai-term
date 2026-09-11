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
