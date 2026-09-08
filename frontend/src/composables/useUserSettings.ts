import { readonly, ref } from 'vue'
import type { AppUserSettings } from '../types/settings'
import { loadUserSettings, persistUserSettings, type SettingsStorage } from '../lib/settingsStorage'
import { normalizeUserSettings } from '../lib/userSettings'
import { isWindowsPlatform } from '../utils/platform'

export function useUserSettings(windowsPlatform = isWindowsPlatform(), storage?: SettingsStorage) {
  const appSettings = ref<AppUserSettings>(loadUserSettings(windowsPlatform, storage))

  function updateUserSettings(settings: AppUserSettings): boolean {
    appSettings.value = normalizeUserSettings(settings, windowsPlatform)
    return persistUserSettings(appSettings.value, storage)
  }

  return {
    appSettings: readonly(appSettings),
    updateUserSettings
  }
}
