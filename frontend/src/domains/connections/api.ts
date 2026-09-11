
import { invoke } from '@tauri-apps/api/tauri'

import type { ConnectionProfile } from './model/profile'






export function listConnectionProfiles() {
  return invoke<ConnectionProfile[]>('list_connection_profiles')
}

export function saveConnectionProfile(profile: ConnectionProfile) {
  return invoke<void>('save_connection_profile', { profile })
}

export function deleteConnectionProfile(id: string) {
  return invoke<boolean>('delete_connection_profile', { id })
}
