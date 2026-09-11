import { computed, ref } from 'vue'
import type { ConnectionProfile } from '../domain/profile'
import type { SaveState, ProfileStoreStatus } from '../../../shared/forms/configuration'
import type { useToasts } from '../../../shared/ui/useToasts'
import * as tauri from '../infrastructure/api'
import { cloneConnectionProfile, normalizeConnectionProfileForSave } from '../domain/profileConfig'
import { formatError } from '../../../shared/platform/errors'

interface ConnectionProfileOptions {
  openConnectionsPanel: () => void
  showToast: ReturnType<typeof useToasts>['showToast']
  confirm?: (message: string) => boolean
}

type ConnectionProfileStorage = Pick<typeof tauri, 'listConnectionProfiles' | 'saveConnectionProfile' | 'deleteConnectionProfile'>

export function useConnectionProfiles(options: ConnectionProfileOptions, storage: ConnectionProfileStorage = tauri) {
  const { openConnectionsPanel, showToast } = options
  const confirm = options.confirm ?? ((message: string) => window.confirm(message))
  const { listConnectionProfiles, saveConnectionProfile, deleteConnectionProfile } = storage
  const LOCAL_CONNECTION_ID = 'local'
  const profiles = ref<ConnectionProfile[]>([])

  const selectedProfileId = ref(profiles.value[0]?.id ?? '')

  const profileStoreStatus = ref<ProfileStoreStatus>('loading')

  const connectionError = ref('')

  const connectionSaveState = ref<SaveState>('idle')

  const connectionSaveError = ref('')

  const connectionEditorOpen = ref(false)

  const connectionEditorMode = ref<'create' | 'edit'>('edit')

  const connectionDraft = ref<ConnectionProfile | undefined>()

  const selectedProfile = computed(() => {
    if (!selectedProfileId.value) return undefined
    return profiles.value.find((profile) => profile.id === selectedProfileId.value)
  })

  const sidebarProfile = computed(() => {
    return connectionEditorOpen.value ? connectionDraft.value : selectedProfile.value
  })

  const connectionLabels = computed<Record<string, string>>(() => {
    const labels: Record<string, string> = {
      [LOCAL_CONNECTION_ID]: '本地终端'
    }
    profiles.value.forEach((profile) => {
      const endpoint = profile.target.host
        ? `${profile.target.username || 'user'}@${profile.target.host}`
        : profile.name
      labels[profile.id] = profile.name && profile.name !== profile.id ? `${profile.name} · ${endpoint}` : endpoint
    })
    return labels
  })

  function selectProfile(profileId: string) {
    selectedProfileId.value = profileId
    connectionError.value = ''
    connectionSaveState.value = 'idle'
    connectionSaveError.value = ''
  }

  function createProfile() {
    const id = nextConnectionProfileId('connection')
    const profile: ConnectionProfile = {
      id,
      name: id,
      connectionRole: 'direct',
      gateway: {
        host: '',
        port: 22,
        username: '',
        authMode: 'auto',
        password: ''
      },
      target: {
        host: '',
        port: 22,
        username: '',
        authMode: 'auto',
        password: ''
      },
      jumpMode: 'direct',
      menuProfileId: '',
      fileTransferMode: 'auto'
    }
    connectionDraft.value = profile
    selectedProfileId.value = ''
    connectionError.value = ''
    connectionSaveState.value = 'idle'
    connectionSaveError.value = ''
    connectionEditorMode.value = 'create'
    connectionEditorOpen.value = true
    openConnectionsPanel()
  }

  function editSelectedProfile(profileId: string) {
    const profile = profiles.value.find((item) => item.id === profileId)
    if (!profile) return
    selectedProfileId.value = profileId
    connectionDraft.value = cloneConnectionProfile(profile)
    connectionSaveState.value = 'idle'
    connectionSaveError.value = ''
    connectionEditorMode.value = 'edit'
    connectionEditorOpen.value = true
    openConnectionsPanel()
  }

  function copySelectedProfile(profileId: string) {
    const profile = profiles.value.find((item) => item.id === profileId)
    if (!profile) return
    const draft = cloneConnectionProfile(profile)
    draft.id = nextConnectionProfileId(`${profile.id}-copy`)
    draft.name = nextConnectionProfileName(`${profile.name || profile.id} \u526f\u672c`)
    draft.gateway.credentialRef = undefined
    draft.target.credentialRef = undefined
    connectionDraft.value = draft
    selectedProfileId.value = ''
    connectionSaveState.value = 'idle'
    connectionSaveError.value = ''
    connectionEditorMode.value = 'create'
    connectionEditorOpen.value = true
    openConnectionsPanel()
  }

  function closeConnectionEditor() {
    connectionEditorOpen.value = false
    connectionDraft.value = undefined
    connectionSaveState.value = 'idle'
    connectionSaveError.value = ''
  }

  async function loadProfiles() {
    try {
      profiles.value = await listConnectionProfiles()
      profileStoreStatus.value = 'ready'
      if (!profiles.value.some((profile) => profile.id === selectedProfileId.value)) {
        selectedProfileId.value = ''
      }
    } catch (error) {
      profileStoreStatus.value = 'preview'
    }
  }

  function nextConnectionProfileId(base = 'connection') {
    const baseId = base
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'connection'
    let index = baseId === 'connection' ? profiles.value.length + 1 : 1
    let id = baseId === 'connection' ? `${baseId}-${index}` : baseId
    while (profiles.value.some((profile) => profile.id === id)) {
      index += 1
      id = `${baseId}-${index}`
    }
    return id
  }

  function nextConnectionProfileName(base: string) {
    const baseName = base.trim() || 'connection \u526f\u672c'
    let index = 1
    let name = baseName
    while (profiles.value.some((profile) => profile.name === name)) {
      index += 1
      name = `${baseName} ${index}`
    }
    return name
  }

  async function saveSelectedProfile() {
    const profileToSave = connectionEditorOpen.value ? connectionDraft.value : selectedProfile.value
    if (!profileToSave) return
    let normalizedProfile: ConnectionProfile
    try {
      normalizedProfile = normalizeConnectionProfileForSave(profileToSave)
    } catch (error) {
      connectionSaveState.value = 'error'
      connectionSaveError.value = formatError(error)
      showToast('error', '连接参数无效', connectionSaveError.value)
      return
    }
    const savedProfileId = normalizedProfile.id
    try {
      connectionSaveState.value = 'saving'
      connectionSaveError.value = ''
      await saveConnectionProfile(normalizedProfile)
      profileStoreStatus.value = 'ready'
      profiles.value = await listConnectionProfiles()
      selectedProfileId.value = savedProfileId
      connectionError.value = ''
      connectionSaveState.value = 'saved'
      connectionEditorOpen.value = false
      connectionDraft.value = undefined
      showToast('success', '连接已保存', normalizedProfile.name)
    } catch (error) {
      profileStoreStatus.value = 'preview'
      connectionSaveState.value = 'error'
      connectionSaveError.value = formatError(error)
      showToast('error', '连接保存失败', connectionSaveError.value)
    }
  }

  async function deleteSelectedProfile(profileId: string) {
    const profileName = profiles.value.find((profile) => profile.id === profileId)?.name ?? profileId
    if (!confirm(`删除连接 ${profileName}？`)) return
    connectionSaveState.value = 'saving'
    connectionSaveError.value = ''
    try {
      await deleteConnectionProfile(profileId)
      profiles.value = await listConnectionProfiles()
      if (selectedProfileId.value === profileId) selectedProfileId.value = ''
      if (connectionDraft.value?.id === profileId) connectionDraft.value = undefined
      connectionEditorOpen.value = false
      connectionSaveState.value = 'saved'
      profileStoreStatus.value = 'ready'
    } catch (error) {
      connectionSaveState.value = 'error'
      connectionSaveError.value = formatError(error)
    }
  }

  return { profiles, selectedProfileId, profileStoreStatus, connectionError, connectionSaveState, connectionSaveError, connectionEditorOpen, connectionEditorMode, connectionDraft, selectedProfile, sidebarProfile, connectionLabels, selectProfile, createProfile, editSelectedProfile, copySelectedProfile, closeConnectionEditor, loadProfiles, nextConnectionProfileId, nextConnectionProfileName, saveSelectedProfile, deleteSelectedProfile }
}
