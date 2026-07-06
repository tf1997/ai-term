<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { AiProviderConfig } from '../types/profile'
import AiConfigPanel from './AiConfigPanel.vue'
import UiIcon from './UiIcon.vue'

type SettingsSection = 'ai' | 'terminal' | 'network'
type TerminalTheme = 'midnight' | 'matrix' | 'light'
type UpdateChannel = 'stable' | 'preview'

interface AppUserSettings {
  terminalFontFamily: string
  terminalFontSize: number
  terminalTheme: TerminalTheme
  defaultShell: string
  proxyUrl: string
  updateChannel: UpdateChannel
}

const props = defineProps<{
  aiConfigs: AiProviderConfig[]
  selectedAiConfigId: string
  aiConfig: AiProviderConfig
  editorOpen: boolean
  editorMode: 'create' | 'edit'
  saveState: 'idle' | 'saving' | 'saved' | 'error'
  saveError: string
  settings: AppUserSettings
}>()

const emit = defineEmits<{
  selectAiConfig: [configId: string]
  createAiConfig: []
  editAiConfig: [configId?: string]
  deleteAiConfig: [configId: string]
  openMenu: [event: MouseEvent, configId: string]
  closeAiConfig: []
  saveAiConfig: [config: AiProviderConfig, apiKey: string]
  updateSettings: [settings: AppUserSettings]
  checkUpdate: []
}>()

const activeSection = ref<SettingsSection>('ai')
const aiConfigSearch = ref('')
const draft = reactive<AppUserSettings>({ ...props.settings })

const settingsGroups: Array<{
  key: SettingsSection
  icon: 'ai' | 'terminal' | 'network'
  title: string
  description: string
  status: string
  ready: boolean
}> = [
  { key: 'ai', icon: 'ai', title: 'AI 配置', description: '模型、API 地址和密钥', status: '已接入', ready: true },
  { key: 'terminal', icon: 'terminal', title: '终端外观', description: '字体、字号、默认 Shell 偏好', status: '已接入', ready: true },
  { key: 'network', icon: 'network', title: '网络与代理', description: '代理地址、超时和远程请求策略', status: '偏好', ready: true }
]

const sortedAiConfigs = computed(() => {
  return [...props.aiConfigs].sort((first, second) => {
    if (first.id === props.selectedAiConfigId) return -1
    if (second.id === props.selectedAiConfigId) return 1
    return first.id.localeCompare(second.id)
  })
})

const filteredAiConfigs = computed(() => {
  const query = aiConfigSearch.value.trim().toLowerCase()
  if (!query) return sortedAiConfigs.value

  return sortedAiConfigs.value.filter((config) =>
    [config.id, config.model, config.baseUrl, config.provider].some((value) => value.toLowerCase().includes(query))
  )
})

const aiConfigMeta = computed(() => {
  const total = props.aiConfigs.length
  if (!aiConfigSearch.value.trim()) return `${total} 个配置`
  return `${filteredAiConfigs.value.length} / ${total} 个配置`
})

watch(
  () => props.settings,
  (settings) => {
    Object.assign(draft, settings)
  },
  { deep: true }
)

function requestCreateAiConfig() {
  emit('createAiConfig')
}

function selectConfig(configId: string) {
  emit('selectAiConfig', configId)
}

function editConfig(configId: string) {
  emit('editAiConfig', configId)
}

function deleteConfig(configId: string) {
  emit('deleteAiConfig', configId)
}

function openConfigMenu(event: MouseEvent, configId: string) {
  emit('openMenu', event, configId)
}

function closeAiConfig() {
  emit('closeAiConfig')
}

function saveSettings() {
  emit('updateSettings', {
    ...draft,
    terminalFontSize: Math.max(11, Math.min(22, Number(draft.terminalFontSize) || 13)),
    terminalFontFamily: draft.terminalFontFamily.trim() || 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    terminalTheme: 'midnight',
    proxyUrl: draft.proxyUrl.trim(),
    defaultShell: draft.defaultShell.trim() || 'system'
  })
}

function resetTerminalAppearance() {
  draft.terminalFontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  draft.terminalFontSize = 13
  saveSettings()
}
</script>

<template>
  <aside class="sidebar settings-sidebar">
    <div class="section-head">
      <span class="section-title">设置中心</span>
      <button class="primary" type="button" title="新建 AI 配置" aria-label="新建 AI 配置" @click="requestCreateAiConfig">
        <UiIcon name="plus" />
        <span>AI 配置</span>
      </button>
    </div>

    <div class="settings-list settings-center">
      <section class="settings-hub" aria-label="设置分类">
        <button
          v-for="group in settingsGroups"
          :key="group.key"
          class="settings-option"
          :class="{ active: activeSection === group.key }"
          type="button"
          @click="activeSection = group.key"
        >
          <span class="settings-option-icon">
            <UiIcon :name="group.icon" />
          </span>
          <span class="settings-option-copy">
            <strong>{{ group.title }}</strong>
            <span>{{ group.description }}</span>
          </span>
          <span class="settings-option-status" :class="{ ready: group.ready }">{{ group.status }}</span>
        </button>
      </section>

      <section v-if="activeSection === 'terminal'" class="settings-section settings-controls" aria-label="终端外观设置">
        <div class="settings-section-head">
          <strong>终端外观</strong>
          <span>即时应用到所有终端</span>
        </div>
        <label class="settings-field">
          <span>字体</span>
          <select v-model="draft.terminalFontFamily" aria-label="选择终端字体">
            <option value="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace">系统等宽</option>
            <option value="Cascadia Mono, Cascadia Code, Consolas, monospace">Cascadia Mono</option>
            <option value="Consolas, Lucida Console, monospace">Consolas</option>
            <option value="JetBrains Mono, Consolas, monospace">JetBrains Mono</option>
            <option value="Fira Code, Consolas, monospace">Fira Code</option>
            <option value="Menlo, Monaco, Consolas, monospace">Menlo / Monaco</option>
          </select>
        </label>
        <label class="settings-field inline">
          <span>字号</span>
          <input v-model.number="draft.terminalFontSize" type="number" min="11" max="22" />
        </label>
        <label class="settings-field">
          <span>默认 Shell 偏好</span>
          <select v-model="draft.defaultShell">
            <option value="system">跟随系统</option>
            <option value="powershell">PowerShell</option>
            <option value="cmd">cmd.exe</option>
            <option value="bash">bash/zsh</option>
          </select>
          <small>当前仅保存偏好，后续接入本地终端启动命令。</small>
        </label>
        <div class="settings-actions">
          <button class="text-button" type="button" @click="resetTerminalAppearance">恢复默认</button>
          <button class="text-button primary-action" type="button" @click="saveSettings">保存设置</button>
        </div>
      </section>

      <section v-else-if="activeSection === 'network'" class="settings-section settings-controls" aria-label="网络与代理">
        <div class="settings-section-head">
          <strong>网络与代理</strong>
          <span>先保存偏好，再接入 Rust 请求层</span>
        </div>
        <label class="settings-field">
          <span>代理地址</span>
          <input v-model="draft.proxyUrl" placeholder="http://127.0.0.1:7890" />
          <small>当前用于记录偏好，后续可传给 AI 请求和更新检查。</small>
        </label>
        <div class="settings-actions">
          <button class="text-button primary-action" type="button" @click="saveSettings">保存网络偏好</button>
        </div>
      </section>

      <section v-else class="settings-section settings-ai-list" aria-label="AI 配置列表">
        <div class="settings-section-head">
          <strong>AI 配置</strong>
          <span>{{ aiConfigMeta }}</span>
        </div>

        <label class="settings-search">
          <UiIcon name="search" size="14" />
          <input v-model="aiConfigSearch" type="search" placeholder="搜索 AI 配置、模型或地址" aria-label="搜索 AI 配置" />
        </label>

        <div class="settings-config-list">
          <article
            v-for="config in filteredAiConfigs"
            :key="config.id"
            class="settings-card"
            :class="{ active: config.id === selectedAiConfigId }"
            role="button"
            tabindex="0"
            @click="selectConfig(config.id)"
            @contextmenu.prevent="openConfigMenu($event, config.id)"
            @keydown.enter="selectConfig(config.id)"
          >
            <div class="settings-card-head">
              <div class="settings-card-main">
                <strong>{{ config.id }}</strong>
                <span v-if="config.id === selectedAiConfigId" class="badge ok">当前使用</span>
              </div>
              <div class="card-actions">
                <button class="icon-button" type="button" title="编辑 AI 配置" aria-label="编辑 AI 配置" @click.stop="editConfig(config.id)">
                  <UiIcon name="edit" />
                </button>
                <button class="icon-button danger" type="button" title="删除 AI 配置" aria-label="删除 AI 配置" @click.stop="deleteConfig(config.id)">
                  <UiIcon name="trash" />
                </button>
              </div>
            </div>
            <span>{{ config.model || '未配置模型' }}</span>
            <small v-if="config.baseUrl">{{ config.baseUrl }}</small>
          </article>

          <p v-if="filteredAiConfigs.length === 0" class="settings-empty">没有匹配的 AI 配置</p>
        </div>
      </section>
    </div>

    <teleport to="body">
      <div v-if="editorOpen" class="modal-backdrop" role="presentation">
        <section class="modal ai-config-modal" role="dialog" aria-modal="true" aria-label="AI 配置">
          <div class="modal-head">
            <div>
              <strong>{{ editorMode === 'create' ? '新建 AI 配置' : '编辑 AI 配置' }}</strong>
              <span>保存后写入 SQLite，可在左侧设置中心切换。</span>
            </div>
            <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="closeAiConfig">
              <UiIcon name="close" />
            </button>
          </div>
          <p v-if="saveState === 'saving'" class="save-feedback">保存中...</p>
          <p v-else-if="saveState === 'saved'" class="save-feedback ok">已保存到 SQLite</p>
          <p v-else-if="saveState === 'error'" class="save-feedback error">{{ saveError }}</p>
          <AiConfigPanel
            :config="aiConfig"
            :editor-mode="editorMode"
            @save="(config, apiKey) => emit('saveAiConfig', config, apiKey)"
          />
        </section>
      </div>
    </teleport>
  </aside>
</template>