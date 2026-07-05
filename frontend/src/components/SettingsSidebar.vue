<script setup lang='ts'>
import type { AiProviderConfig } from '../types/profile'
import AiConfigPanel from './AiConfigPanel.vue'
import UiIcon from './UiIcon.vue'

const settingsGroups = [
  {
    icon: 'ai',
    title: 'AI 配置',
    description: '模型、API 地址和密钥',
    status: '可用',
    active: true,
    ready: true
  },
  {
    icon: 'terminal',
    title: '终端外观',
    description: '字体、字号、主题、默认 Shell',
    status: '待接入',
    active: false,
    ready: false
  },
  {
    icon: 'shield',
    title: '安全与密钥',
    description: 'SSH 密钥、凭据和敏感操作策略',
    status: '待接入',
    active: false,
    ready: false
  },
  {
    icon: 'network',
    title: '网络与代理',
    description: '代理、超时和远程请求策略',
    status: '待接入',
    active: false,
    ready: false
  },
  {
    icon: 'database',
    title: '更新与数据',
    description: '数据目录、更新检查和备份',
    status: '待接入',
    active: false,
    ready: false
  }
] as const

defineProps<{
  aiConfigs: AiProviderConfig[]
  selectedAiConfigId: string
  aiConfig: AiProviderConfig
  editorOpen: boolean
  editorMode: 'create' | 'edit'
  saveState: 'idle' | 'saving' | 'saved' | 'error'
  saveError: string
}>()

const emit = defineEmits<{
  selectAiConfig: [configId: string]
  createAiConfig: []
  editAiConfig: [configId?: string]
  deleteAiConfig: [configId: string]
  openMenu: [event: MouseEvent, configId: string]
  closeAiConfig: []
  saveAiConfig: [config: AiProviderConfig, apiKey: string]
}>()

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

</script>

<template>
  <aside class='sidebar settings-sidebar'>
    <div class='section-head'>
      <span class='section-title'>设置中心</span>
      <button class='primary' type='button' title='新建 AI 配置' aria-label='新建 AI 配置' @click='requestCreateAiConfig'>
        <UiIcon name='plus' />
        <span>AI 配置</span>
      </button>
    </div>

    <div class='settings-list settings-center'>
      <section class='settings-hub' aria-label='设置分类'>
        <article v-for='group in settingsGroups' :key='group.title' class='settings-option' :class='{ active: group.active }'>
          <span class='settings-option-icon'>
            <UiIcon :name='group.icon' />
          </span>
          <div>
            <strong>{{ group.title }}</strong>
            <span>{{ group.description }}</span>
          </div>
          <span class='settings-option-status' :class='{ ready: group.ready }'>{{ group.status }}</span>
        </article>
      </section>

      <section class='settings-section' aria-label='AI 配置列表'>
        <div class='settings-section-head'>
          <strong>AI 配置</strong>
          <span>{{ aiConfigs.length }} 个配置</span>
        </div>
        <article
          v-for='config in aiConfigs'
          :key='config.id'
          class='settings-card'
          :class='{ active: config.id === selectedAiConfigId }'
          role='button'
          tabindex='0'
          @click='selectConfig(config.id)'
          @contextmenu.prevent='openConfigMenu($event, config.id)'
          @keydown.enter='selectConfig(config.id)'
        >
          <div class='settings-card-head'>
            <div class='settings-card-main'>
              <strong>{{ config.id }}</strong>
              <span v-if='config.id === selectedAiConfigId' class='badge ok'>当前使用</span>
            </div>
            <div class='card-actions'>
              <button class='icon-button' type='button' title='编辑 AI 配置' aria-label='编辑 AI 配置' @click.stop='editConfig(config.id)'>
                <UiIcon name='edit' />
              </button>
              <button class='icon-button danger' type='button' title='删除 AI 配置' aria-label='删除 AI 配置' @click.stop='deleteConfig(config.id)'>
                <UiIcon name='trash' />
              </button>
            </div>
          </div>
          <span>{{ config.model || '未配置模型' }}</span>
        </article>
      </section>
    </div>

    <teleport to='body'>
      <div v-if='editorOpen' class='modal-backdrop' role='presentation'>
        <section class='modal ai-config-modal' role='dialog' aria-modal='true' aria-label='AI 配置'>
          <div class='modal-head'>
            <div>
              <strong>{{ editorMode === 'create' ? '新建 AI 配置' : '编辑 AI 配置' }}</strong>
              <span>保存后写入 SQLite，可在左侧设置中心切换。</span>
            </div>
            <button class='icon-button' type='button' title='关闭' aria-label='关闭' @click='closeAiConfig'>
              <UiIcon name='close' />
            </button>
          </div>
          <p v-if='saveState === "saving"' class='save-feedback'>保存中...</p>
          <p v-else-if='saveState === "saved"' class='save-feedback ok'>已保存到 SQLite</p>
          <p v-else-if='saveState === "error"' class='save-feedback error'>{{ saveError }}</p>
          <AiConfigPanel
            :config='aiConfig'
            :editor-mode="editorMode"
            @save="(config, apiKey) => emit('saveAiConfig', config, apiKey)"
          />
        </section>
      </div>
    </teleport>
  </aside>
</template>