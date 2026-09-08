import { onBeforeUnmount, onMounted, readonly, ref, watch } from 'vue'
import type { AppTheme } from '../types/settings'
import { loadAppTheme, persistAppTheme, type SettingsStorage } from '../lib/settingsStorage'

interface AppThemeOptions {
  storage?: SettingsStorage
  onThemeChange?: (theme: AppTheme) => void
}

export function useAppTheme(options: AppThemeOptions = {}) {
  const appTheme = ref<AppTheme>(loadAppTheme(options.storage))
  const themeToggleButton = ref<HTMLButtonElement | null>(null)
  let mountedThemeToggleButton: HTMLButtonElement | null = null
  let lastThemeToggleAt = Number.NEGATIVE_INFINITY

  function toggleAppTheme() {
    appTheme.value = appTheme.value === 'light' ? 'dark' : 'light'
    options.onThemeChange?.(appTheme.value)
  }

  function handleThemeTogglePointerDown(event: Event) {
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    const now = performance.now()
    if (now - lastThemeToggleAt < 160) return
    lastThemeToggleAt = now
    toggleAppTheme()
  }

  watch(appTheme, (theme) => {
    persistAppTheme(theme, options.storage)
    const root = document.documentElement
    root.dataset.theme = theme
    root.classList.toggle('theme-light', theme === 'light')
    root.classList.toggle('theme-dark', theme === 'dark')
  }, { immediate: true })

  onMounted(() => {
    mountedThemeToggleButton = themeToggleButton.value
    mountedThemeToggleButton?.addEventListener('pointerdown', handleThemeTogglePointerDown, true)
    mountedThemeToggleButton?.addEventListener('mousedown', handleThemeTogglePointerDown, true)
    mountedThemeToggleButton?.addEventListener('click', handleThemeTogglePointerDown, true)
  })

  onBeforeUnmount(() => {
    mountedThemeToggleButton?.removeEventListener('pointerdown', handleThemeTogglePointerDown, true)
    mountedThemeToggleButton?.removeEventListener('mousedown', handleThemeTogglePointerDown, true)
    mountedThemeToggleButton?.removeEventListener('click', handleThemeTogglePointerDown, true)
    mountedThemeToggleButton = null
  })

  return {
    appTheme: readonly(appTheme),
    themeToggleButton,
    toggleAppTheme
  }
}
