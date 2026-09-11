<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { describeAiError, hasExtraErrorDetail } from '../../../domain/aiErrorPresentation'
import UiIcon from '../../../../../shared/ui/UiIcon.vue'

const props = withDefaults(defineProps<{
  /** AI 请求失败的原始报错正文。 */
  detail: string
  /** 模型不可用时的本地兜底命令,可空。 */
  suggestedCommand?: string
  /** 当前是否允许原地重试(会话/连接已切走或正在请求时为 false)。 */
  canRetry?: boolean
  /** canRetry 为 false 时解释原因,挂在按钮 title 上。 */
  retryDisabledReason?: string
  retryLabel?: string
  retryTitle?: string
}>(), {
  suggestedCommand: '',
  canRetry: false,
  retryDisabledReason: '',
  retryLabel: '重试',
  retryTitle: '用同一个问题重新请求，替换这条失败回复'
})

const emit = defineEmits<{
  retry: []
  executeCommand: [command: string]
}>()

const detailOpen = ref(false)
const copied = ref(false)
let copiedTimer: number | undefined

const view = computed(() => describeAiError(props.detail))
const showDetailToggle = computed(() => hasExtraErrorDetail(view.value))

// 换一条错误(或重试后再次失败)时收起上一次展开的详情,避免旧状态串台
watch(
  () => props.detail,
  () => {
    detailOpen.value = false
  }
)

async function copyDetail() {
  const value = view.value.detail || view.value.title
  if (!value.trim()) return
  try {
    await navigator.clipboard.writeText(value)
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }
  copied.value = true
  if (copiedTimer) window.clearTimeout(copiedTimer)
  copiedTimer = window.setTimeout(() => {
    copied.value = false
  }, 1400)
}

onBeforeUnmount(() => {
  if (copiedTimer) window.clearTimeout(copiedTimer)
})
</script>

<template>
  <section class="ai-error-notice" role="alert">
    <div class="ai-error-head">
      <UiIcon class="ai-error-icon" name="alert" size="14" />
      <strong class="ai-error-title">{{ view.title }}</strong>
      <span v-if="view.code" class="chip ai-error-code">{{ view.code }}</span>
    </div>
    <p v-if="view.hint" class="ai-error-hint">{{ view.hint }}</p>
    <div v-if="suggestedCommand" class="ai-error-suggestion">
      <span class="ai-error-suggestion-label">本地建议</span>
      <code>{{ suggestedCommand }}</code>
      <button class="text-button" type="button" title="发送到当前终端执行" @click="emit('executeCommand', suggestedCommand)">
        执行
      </button>
    </div>
    <div class="ai-error-actions">
      <button
        class="text-button ai-error-retry"
        :class="{ 'primary-action': view.retryable }"
        type="button"
        :disabled="!canRetry"
        :title="canRetry ? retryTitle : retryDisabledReason || '当前无法重试'"
        @click="emit('retry')"
      >
        <UiIcon name="refresh" size="13" />
        <span>{{ retryLabel }}</span>
      </button>
      <button class="text-button" type="button" :title="copied ? '已复制' : '复制原始报错'" @click="copyDetail">
        {{ copied ? '已复制' : '复制详情' }}
      </button>
      <button
        v-if="showDetailToggle"
        class="text-button ai-error-detail-toggle"
        type="button"
        :aria-expanded="detailOpen"
        @click="detailOpen = !detailOpen"
      >
        <span>{{ detailOpen ? '收起详情' : '查看详情' }}</span>
        <UiIcon :name="detailOpen ? 'arrow-up' : 'arrow-down'" size="13" />
      </button>
    </div>
    <pre v-if="detailOpen && showDetailToggle" class="ai-error-detail"><code>{{ view.detail }}</code></pre>
  </section>
</template>
