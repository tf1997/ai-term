import { readonly, ref } from 'vue'
import type { AppUserSettings } from '../domain/settings'
import { loadUserSettings, persistUserSettings } from '../infrastructure/storage/settingsStorage'
import type { SettingsStorage } from '../infrastructure/storage/settingsStorage'
import { normalizeUserSettings } from '../domain/userSettings'
import type { SettingsPlatform } from '../domain/userSettings'
import { desktopPlatform } from '../../../shared/platform/platform'

export function useUserSettings(platform: SettingsPlatform = desktopPlatform(), storage?: SettingsStorage) {
  const appSettings = ref<AppUserSettings>(loadUserSettings(platform, storage))

  function updateUserSettings(settings: AppUserSettings): boolean {
    appSettings.value = normalizeUserSettings(settings, platform)
    return persistUserSettings(appSettings.value, storage)
  }

  return {
    appSettings: readonly(appSettings),
    updateUserSettings
  }
}
