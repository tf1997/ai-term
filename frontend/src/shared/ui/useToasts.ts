import { onBeforeUnmount, readonly, ref } from 'vue'
import type { AppToast, ToastKind } from './overlays'

export function useToasts() {
  const toasts = ref<AppToast[]>([])
  const toastTimers = new Map<string, number>()
  let toastSequence = 0
  let disposed = false

  function clearToastTimer(id: string) {
    const timer = toastTimers.get(id)
    if (timer === undefined) return
    window.clearTimeout(timer)
    toastTimers.delete(id)
  }

  function dismissToast(id: string) {
    clearToastTimer(id)
    toasts.value = toasts.value.filter((toast) => toast.id !== id)
  }

  function showToast(kind: ToastKind, title: string, message = '') {
    if (disposed) return
    const id = `toast-${Date.now()}-${toastSequence++}`
    const toastKey = `${kind}\u0000${title}\u0000${message}`
    const nextToasts = toasts.value.filter((toast) => `${toast.kind}\u0000${toast.title}\u0000${toast.message ?? ''}` !== toastKey)
    const visibleToasts = [...nextToasts, { id, kind, title, message }].slice(-3)
    const visibleIds = new Set(visibleToasts.map((toast) => toast.id))
    for (const toast of toasts.value) {
      if (!visibleIds.has(toast.id)) clearToastTimer(toast.id)
    }
    toasts.value = visibleToasts
    toastTimers.set(id, window.setTimeout(() => dismissToast(id), kind === 'error' ? 6200 : 3600))
  }

  onBeforeUnmount(() => {
    disposed = true
    for (const timer of toastTimers.values()) window.clearTimeout(timer)
    toastTimers.clear()
    toasts.value = []
  })

  return {
    toasts: readonly(toasts),
    showToast,
    dismissToast
  }
}
