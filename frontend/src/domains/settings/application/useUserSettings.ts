import { readonly, ref } from 'vue'
import type { AppUserSettings } from '../domain/settings'
import { loadUserSettings, persistUserSettings } from '../infrastructure/storage/settingsStorage'
import type { SettingsStorage } from '../infrastructure/storage/settingsStorage'
import { normalizeUserSettings } from '../domain/userSettings'
import { isWindowsPlatform } from '../../../shared/platform/platform'

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
