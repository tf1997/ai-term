import { readonly, ref } from 'vue'
import type { AppUserSettings } from '../model/settings'
import { loadUserSettings, persistUserSettings } from '../storage/settingsStorage'
import type { SettingsStorage } from '../storage/settingsStorage'
import { normalizeUserSettings } from '../model/userSettings'
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
