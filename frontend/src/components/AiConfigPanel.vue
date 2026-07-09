<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import type { AiProviderConfig } from '../types/profile'

const props = defineProps<{
  config: AiProviderConfig
  editorMode: 'create' | 'edit'
}>()

const emit = defineEmits<{
  save: [config: AiProviderConfig, apiKey: string]
}>()

const draft = reactive<AiProviderConfig>({ ...props.config })
const saved = ref(false)

watch(
  () => props.config,
  (config) => {
    Object.assign(draft, config)
    saved.value = false
  }
)

function save() {
  const id = draft.id.trim() || 'default'
  const apiKey = draft.apiKey?.trim() ?? ''
  const apiKeyRef = apiKey ? `ai-provider:${id}` : draft.apiKeyRef
  emit('save', { ...draft, id, apiKey, apiKeyRef }, apiKey)
  saved.value = true
}

</script>

<template>
  <section class="ai-config" aria-label="AI configuration">
    <div class="config-top">
      <strong>Custom AI Provider</strong>
      <span class="badge" :class="{ ok: draft.baseUrl && draft.model }">
        {{ draft.baseUrl && draft.model ? '已配置' : '待配置' }}
      </span>
    </div>
    <div class="config-grid">
      <label class="wide">
        <span>配置 ID</span>
        <input v-model="draft.id" :disabled="editorMode === 'edit'" placeholder="company-gpt4" />
      </label>
      <label>
        <span>Provider</span>
        <select v-model="draft.provider">
          <option value="open-ai-compatible">OpenAI Compatible</option>
          <option value="open-ai">OpenAI</option>
          <option value="company-gateway">Company Gateway</option>
          <option value="ollama">Ollama</option>
          <option value="custom-http">Custom HTTP</option>
        </select>
      </label>
      <label>
        <span>Model</span>
        <input v-model="draft.model" placeholder="gpt-4.1-mini" />
      </label>
      <label class="wide">
        <span>Base URL（API 根路径，不是网页登录页）</span>
        <input v-model="draft.baseUrl" placeholder="https://ai-gateway.company.com/v1 或完整 /chat/completions" />
      </label>
      <label>
        <span>API Key</span>
        <input v-model="draft.apiKey" type="password" placeholder="保存到系统凭据管理器" />
      </label>
      <label>
        <span>Context</span>
        <select v-model="draft.contextPolicy">
          <option value="selected-output-only">Selected output only</option>
          <option value="active-command-output">Active command output</option>
          <option value="manual-attachments">Manual attachments</option>
        </select>
      </label>
      <label class="wide">
        <span>System Prompt</span>
        <textarea v-model="draft.systemPrompt" rows="3" />
      </label>
    </div>
    <div class="config-footer">
      <span>{{ saved ? '已保存到系统凭据管理器' : 'API Key 将保存到系统凭据管理器' }}</span>
      <button class="primary" @click="save">保存配置</button>
    </div>
  </section>
</template>
