<script setup lang="ts">
import type { AiProviderConfig } from '../types/profile'
import AiConfigPanel from './AiConfigPanel.vue'

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
</script>

<template>
  <aside class="sidebar settings-sidebar">
    <div class="section-head">
      <span class="section-title">配置菜单</span>
      <button class="primary" type="button" @click="emit('createAiConfig')">+ AI 配置</button>
    </div>

    <div class="settings-list">
      <article
        v-for="config in aiConfigs"
        :key="config.id"
        class="settings-card"
        :class="{ active: config.id === selectedAiConfigId }"
        role="button"
        tabindex="0"
        @click="emit('selectAiConfig', config.id)"
        @contextmenu.prevent="emit('openMenu', $event, config.id)"
        @keydown.enter="emit('selectAiConfig', config.id)"
      >
        <strong>{{ config.id }}</strong>
        <span>{{ config.model || '未配置模型' }}</span>
        <div class="card-actions">
          <button class="icon-button" type="button" title="编辑 AI 配置" aria-label="编辑 AI 配置" @click.stop="emit('editAiConfig', config.id)">✎</button>
          <button class="icon-button danger" type="button" title="删除 AI 配置" aria-label="删除 AI 配置" @click.stop="emit('deleteAiConfig', config.id)">⌫</button>
        </div>
      </article>
    </div>

    <teleport to="body">
      <div v-if="editorOpen" class="modal-backdrop" role="presentation" @click.self="emit('closeAiConfig')">
        <section class="modal ai-config-modal" role="dialog" aria-modal="true" aria-label="AI 配置">
          <div class="modal-head">
            <div>
              <strong>{{ editorMode === 'create' ? '新建 AI 配置' : '编辑 AI 配置' }}</strong>
              <span>保存后写入 SQLite，可在左侧列表切换。</span>
            </div>
            <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="emit('closeAiConfig')">×</button>
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
