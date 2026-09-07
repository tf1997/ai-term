<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import type { AiProviderConfig } from '../types/profile'
import { parseAiTimeoutSeconds } from '../lib/aiTimeout'

const props = defineProps<{
  config: AiProviderConfig
  editorMode: 'create' | 'edit'
}>()

const emit = defineEmits<{
  save: [config: AiProviderConfig, apiKey: string]
}>()

const draft = reactive<AiProviderConfig>({ ...props.config, timeoutSeconds: props.config.timeoutSeconds ?? 0 })
const saved = ref(false)
const validationError = ref('')

watch(
  () => props.config,
  (config) => {
    Object.assign(draft, config, { timeoutSeconds: config.timeoutSeconds ?? 0 })
    saved.value = false
    validationError.value = ''
  }
)

function save() {
  let timeoutSeconds: number
  try {
    timeoutSeconds = parseAiTimeoutSeconds(draft.timeoutSeconds)
  } catch (error) {
    validationError.value = error instanceof Error ? error.message : String(error)
    saved.value = false
    return
  }
  validationError.value = ''
  draft.timeoutSeconds = timeoutSeconds
  const id = draft.id.trim() || 'default'
  const apiKey = draft.apiKey?.trim() ?? ''
  const apiKeyRef = apiKey ? `ai-provider:${id}` : draft.apiKeyRef
  emit('save', {
    ...draft,
    id,
    provider: 'open-ai-compatible',
    apiKey,
    apiKeyRef,
    contextPolicy: 'selected-output-only'
  }, apiKey)
  saved.value = true
}

</script>

<template>
  <section class="ai-config" aria-label="AI configuration">
    <div class="config-top">
      <strong>OpenAI 兼容接口</strong>
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
        <span>Model</span>
        <input v-model="draft.model" placeholder="gpt-4.1-mini" />
      </label>
      <label>
        <span>API Key</span>
        <input v-model="draft.apiKey" type="password" placeholder="保存到系统凭据管理器" />
      </label>
      <label class="wide">
        <span>Base URL（API 根路径，不是网页登录页）</span>
        <input v-model="draft.baseUrl" placeholder="https://ai-gateway.company.com/v1 或完整 /chat/completions" />
      </label>
      <label class="wide">
        <span>请求超时（秒）</span>
        <input
          v-model.number="draft.timeoutSeconds"
          type="number"
          min="0"
          max="4294967295"
          step="1"
          placeholder="0（不超时）"
          aria-describedby="ai-request-timeout-hint"
          :aria-invalid="Boolean(validationError)"
          @input="validationError = ''; saved = false"
        />
        <small id="ai-request-timeout-hint" class="ai-config-hint">
          默认 0，不限制等待时间。设为正整数后，流式回复按等待首个或后续数据的空闲时间计时，持续输出不会被总时长截断；非流式请求按总耗时计时。模型服务或代理仍可能自行超时。
        </small>
      </label>
      <label class="wide">
        <span>System Prompt</span>
        <textarea v-model="draft.systemPrompt" rows="3" />
      </label>
    </div>
    <p v-if="validationError" class="ai-config-validation-error" role="alert">{{ validationError }}</p>
    <div class="config-footer">
      <span>{{ saved ? '已保存到系统凭据管理器' : 'API Key 将保存到系统凭据管理器' }}</span>
      <button class="primary" @click="save">保存配置</button>
    </div>
  </section>
</template>

<style scoped>
.ai-config-hint {
  font-size: var(--font-xs);
  line-height: 1.5;
  opacity: .8;
}

.ai-config-validation-error {
  margin: 0;
  color: #e05260;
  font-size: var(--font-xs);
}
</style>
