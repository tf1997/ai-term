import { computed, ref } from 'vue'
import type { Ref } from 'vue'
import type { AiProviderConfig } from '../model/provider'
import type { SaveState, ProfileStoreStatus } from '../../../shared/forms/configuration'
import type { useToasts } from '../../../shared/ui/useToasts'
import * as tauri from '../api'
import { cloneAiConfig, defaultAiConfig } from '../model/providerConfig'
import { formatError } from '../../../shared/platform/errors'

interface AiConfigOptions {
  profileStoreStatus: Ref<ProfileStoreStatus>
  openSettingsPanel: () => void
  showToast: ReturnType<typeof useToasts>['showToast']
  confirm?: (message: string) => boolean
}

type AiConfigStorage = Pick<typeof tauri, 'listAiProviderConfigs' | 'saveAiProviderConfig' | 'deleteAiProviderConfig'>

export function useAiConfigs(options: AiConfigOptions, storage: AiConfigStorage = tauri) {
  const { profileStoreStatus, openSettingsPanel, showToast } = options
  const confirm = options.confirm ?? ((message: string) => window.confirm(message))
  const { listAiProviderConfigs, saveAiProviderConfig, deleteAiProviderConfig } = storage
  const aiConfigs = ref<AiProviderConfig[]>([{ ...defaultAiConfig }])

  const selectedAiConfigId = ref(defaultAiConfig.id)

  const aiRuntimeApiKeys = ref<Record<string, string>>({})

  const aiConfigSaveState = ref<SaveState>('idle')

  const aiConfigSaveError = ref('')

  const aiConfigEditorOpen = ref(false)

  const aiConfigEditorMode = ref<'create' | 'edit'>('edit')

  const aiConfigDraft = ref<AiProviderConfig | undefined>()

  const aiConfig = computed(() => {
    return aiConfigs.value.find((config) => config.id === selectedAiConfigId.value) ?? aiConfigs.value[0] ?? { ...defaultAiConfig }
  })

  const settingsAiConfig = computed(() => {
    return aiConfigEditorOpen.value ? aiConfigDraft.value ?? aiConfig.value : aiConfig.value
  })

  const activeAiRuntimeApiKey = computed(() => aiRuntimeApiKeys.value[aiConfig.value.id] ?? '')

  function isAiConfigUsable(config: AiProviderConfig) {
    return Boolean(config.baseUrl.trim() && config.model.trim() && config.apiKey?.trim())
  }

  function selectPreferredAiConfig(configs: AiProviderConfig[], preferredId = selectedAiConfigId.value) {
    return (
      configs.find((config) => config.id === preferredId && isAiConfigUsable(config)) ??
      configs.find(isAiConfigUsable) ??
      configs.find((config) => config.id === preferredId) ??
      configs.find((config) => config.id === defaultAiConfig.id) ??
      configs[0] ??
      { ...defaultAiConfig }
    )
  }

  function createAiConfig() {
    const nextId = nextAiConfigId()
    const config: AiProviderConfig = {
      ...defaultAiConfig,
      id: nextId,
      apiKeyRef: '',
      apiKey: ''
    }
    aiConfigDraft.value = config
    aiConfigSaveState.value = 'idle'
    aiConfigSaveError.value = ''
    aiConfigEditorMode.value = 'create'
    aiConfigEditorOpen.value = true
    openSettingsPanel()
  }

  function selectAiConfig(configId: string) {
    if (aiConfigs.value.some((config) => config.id === configId)) {
      selectedAiConfigId.value = configId
      aiConfigSaveState.value = 'idle'
      aiConfigSaveError.value = ''
    }
  }

  /**
   * 编辑不改「当前使用」:草稿直接按 configId 取,不经过 selectedAiConfigId。
   * 之前借 selectAiConfig 是为了让 aiConfig 指向目标,副作用是点一下铅笔就把
   * 正在用的配置换了 —— 编辑和启用是两件事。
   */
  function editAiConfig(configId?: string) {
    const target = configId
      ? aiConfigs.value.find((config) => config.id === configId) ?? aiConfig.value
      : aiConfig.value
    aiConfigDraft.value = cloneAiConfig(target)
    aiConfigSaveState.value = 'idle'
    aiConfigSaveError.value = ''
    aiConfigEditorMode.value = 'edit'
    aiConfigEditorOpen.value = true
    openSettingsPanel()
  }

  function closeAiConfigEditor() {
    aiConfigEditorOpen.value = false
    aiConfigDraft.value = undefined
    aiConfigSaveState.value = 'idle'
    aiConfigSaveError.value = ''
  }

  async function saveAiConfig(config: AiProviderConfig, apiKey = '') {
    aiConfigSaveState.value = 'saving'
    aiConfigSaveError.value = ''
    const savedConfig = {
      ...config,
      id: config.id.trim() || defaultAiConfig.id,
      apiKey: apiKey || config.apiKey || ''
    }
    if (savedConfig.apiKey) {
      savedConfig.apiKeyRef = `ai-provider:${savedConfig.id}`
      aiRuntimeApiKeys.value = {
        ...aiRuntimeApiKeys.value,
        [savedConfig.id]: savedConfig.apiKey
      }
    }
    const wasCreating = aiConfigEditorMode.value === 'create'
    const previousSelectedId = selectedAiConfigId.value
    try {
      await saveAiProviderConfig(savedConfig)
      aiConfigs.value = await listAiProviderConfigs()
      // 新建后切到新配置;编辑则保持原来的「当前使用」。改 id 相当于重命名,
      // 原 id 已经不在列表里,这时才跟到新 id,否则 aiConfig 会回落到列表首项。
      selectedAiConfigId.value = wasCreating || !aiConfigs.value.some((config) => config.id === previousSelectedId)
        ? savedConfig.id
        : previousSelectedId
      profileStoreStatus.value = 'ready'
      aiConfigSaveState.value = 'saved'
      aiConfigEditorOpen.value = false
      aiConfigDraft.value = undefined
      showToast('success', 'AI 配置已保存', savedConfig.id)
    } catch (error) {
      profileStoreStatus.value = 'preview'
      aiConfigSaveState.value = 'error'
      aiConfigSaveError.value = formatError(error)
      showToast('error', 'AI 配置保存失败', aiConfigSaveError.value)
    }
  }

  async function deleteSelectedAiConfig(configId: string) {
    if (!confirm(`删除 AI 配置 ${configId}？`)) return
    aiConfigSaveState.value = 'saving'
    aiConfigSaveError.value = ''
    try {
      await deleteAiProviderConfig(configId)
      const configs = await listAiProviderConfigs()
      aiConfigs.value = configs.length ? configs : [{ ...defaultAiConfig }]
      selectedAiConfigId.value = selectPreferredAiConfig(aiConfigs.value).id
      const nextRuntimeKeys = { ...aiRuntimeApiKeys.value }
      delete nextRuntimeKeys[configId]
      aiRuntimeApiKeys.value = nextRuntimeKeys
      if (aiConfigDraft.value?.id === configId) aiConfigDraft.value = undefined
      aiConfigEditorOpen.value = false
      aiConfigSaveState.value = 'saved'
      profileStoreStatus.value = 'ready'
      showToast('success', 'AI 配置已删除', configId)
    } catch (error) {
      aiConfigSaveState.value = 'error'
      aiConfigSaveError.value = formatError(error)
      showToast('error', 'AI 配置删除失败', aiConfigSaveError.value)
    }
  }

  async function loadAiConfig() {
    try {
      const configs = await listAiProviderConfigs()
      aiConfigs.value = configs.length ? configs : [{ ...defaultAiConfig }]
      selectedAiConfigId.value = selectPreferredAiConfig(aiConfigs.value).id
    } catch (error) {
      aiConfigs.value = [{ ...defaultAiConfig }]
      selectedAiConfigId.value = defaultAiConfig.id
    }
  }

  function nextAiConfigId() {
    let index = aiConfigs.value.filter((config) => config.id !== defaultAiConfig.id).length + 1
    let id = `ai-config-${index}`
    while (aiConfigs.value.some((config) => config.id === id)) {
      index += 1
      id = `ai-config-${index}`
    }
    return id
  }

  return { aiConfigs, selectedAiConfigId, aiRuntimeApiKeys, aiConfigSaveState, aiConfigSaveError, aiConfigEditorOpen, aiConfigEditorMode, aiConfigDraft, aiConfig, settingsAiConfig, activeAiRuntimeApiKey, isAiConfigUsable, selectPreferredAiConfig, createAiConfig, selectAiConfig, editAiConfig, closeAiConfigEditor, saveAiConfig, deleteSelectedAiConfig, loadAiConfig, nextAiConfigId }
}
