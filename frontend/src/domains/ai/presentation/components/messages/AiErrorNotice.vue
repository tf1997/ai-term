<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { describeAiError, hasExtraErrorDetail } from '../../../domain/aiErrorPresentation'
import UiIcon from '../../../../../shared/ui/UiIcon.vue'
import AiCodeBlock from './AiCodeBlock.vue'
import { useCopyFeedback } from './useCopyFeedback'

const props = withDefaults(defineProps<{
  detail: string
  suggestedCommand?: string
  canRetry?: boolean
  retryDisabledReason?: string
  retryLabel?: string
  retryTitle?: string
}>(), {
  suggestedCommand: '',
  canRetry: false,
  retryDisabledReason: '',
  retryLabel: '重试请求',
  retryTitle: '用同一个问题重新请求'
})

const emit = defineEmits<{
  retry: []
  executeCommand: [command: string]
}>()
const detailOpen = ref(false)
const { copyFeedback, copyText } = useCopyFeedback()
const view = computed(() => describeAiError(props.detail))
const showDetailToggle = computed(() => hasExtraErrorDetail(view.value))

watch(() => props.detail, () => { detailOpen.value = false })
</script>

<template>
  <div class="chat-error-group">
    <section class="chat-error" role="alert">
      <div class="chat-error-head">
        <UiIcon class="chat-error-icon" name="alert" size="15" />
        <strong class="chat-error-title">{{ view.title }}</strong>
        <span v-if="view.code" class="chat-error-code">{{ view.code }}</span>
      </div>
      <p v-if="view.hint" class="chat-error-hint">{{ view.hint }}</p>
      <div class="chat-error-actions">
        <button class="chat-error-action" :class="{ 'is-primary': view.retryable }" type="button" :disabled="!canRetry" :title="canRetry ? retryTitle : retryDisabledReason || '当前无法重试'" @click="emit('retry')"><UiIcon name="refresh" size="13" />{{ retryLabel }}</button>
        <button class="chat-error-action is-icon" type="button" :title="copyFeedback || '复制错误详情'" :aria-label="copyFeedback || '复制错误详情'" @click="copyText(view.detail || view.title)"><UiIcon name="copy" size="14" /></button>
        <button v-if="showDetailToggle" class="chat-error-action is-quiet" type="button" :aria-expanded="detailOpen" @click="detailOpen = !detailOpen">{{ detailOpen ? '收起详情' : '查看详情' }}<UiIcon :name="detailOpen ? 'arrow-up' : 'arrow-down'" size="12" /></button>
        <span class="chat-error-feedback" role="status" aria-live="polite">{{ copyFeedback }}</span>
      </div>
      <pre v-if="detailOpen && showDetailToggle" class="chat-error-detail" tabindex="0"><code>{{ view.detail }}</code></pre>
    </section>
    <AiCodeBlock v-if="suggestedCommand" :content="suggestedCommand" label="本地建议" kind="command" class="chat-error-suggestion">
      <template #actions>
        <button class="chat-error-action is-suggestion" type="button" title="发送到当前终端执行" @click="emit('executeCommand', suggestedCommand)"><UiIcon name="play" size="12" />执行</button>
      </template>
      <template #preview-actions="{ close }">
        <button class="chat-error-action is-suggestion" type="button" title="发送到当前终端执行" @click="close(); emit('executeCommand', suggestedCommand)"><UiIcon name="play" size="12" />执行</button>
      </template>
    </AiCodeBlock>
  </div>
</template>

<style scoped>
.chat-error-group { display: grid; gap: 10px; min-width: 0; width: 100%; }
.chat-error { width: 100%; min-width: 0; box-sizing: border-box; padding: 12px; border: 1px solid var(--chat-line, var(--workbench-line)); border-radius: 8px; color: var(--chat-text, var(--workbench-text)); background: var(--chat-surface, var(--workbench-panel-strong)); letter-spacing: 0; }
.chat-error-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.chat-error-icon { flex: 0 0 auto; color: var(--chat-danger, #c24150); }
.chat-error-title { min-width: 0; flex: 1; font-size: 13px; font-weight: 550; line-height: 1.6; overflow-wrap: anywhere; }
.chat-error-code { flex: 0 0 auto; color: var(--chat-muted, var(--workbench-muted)); font: 11px/1.5 var(--font-mono, 'JetBrains Mono', Consolas, monospace); }
.chat-error-hint { margin: 8px 0 0; font-size: 12px; line-height: 1.8; overflow-wrap: anywhere; color: var(--chat-muted, var(--workbench-muted)); }
.chat-error-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.chat-error-action { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-height: 29px; padding: 4px 8px; border: 1px solid var(--chat-line, var(--workbench-line)); border-radius: 5px; color: var(--chat-text, var(--workbench-text)); background: transparent; font-size: 12px; line-height: 1.5; cursor: pointer; }
.chat-error-action.is-primary { color: #fff; background: var(--chat-button, var(--workbench-accent)); border-color: transparent; }
.chat-error-action.is-icon { width: 29px; flex: 0 0 29px; padding: 0; }
.chat-error-action.is-quiet { border-color: transparent; color: var(--chat-muted, var(--workbench-muted)); }
.chat-error-action.is-suggestion { min-height: 26px; padding: 2px 7px; }
.chat-error-action:hover:not(:disabled) { filter: brightness(.94); }
.chat-error-action:disabled { opacity: .45; cursor: not-allowed; }
.chat-error-action:focus-visible, .chat-error-detail:focus-visible { outline: 2px solid var(--chat-accent, var(--workbench-accent)); outline-offset: 2px; }
.chat-error-feedback { color: var(--chat-muted, var(--workbench-muted)); font-size: 11px; }
.chat-error-detail { margin: 12px 0 0; padding-top: 10px; border-top: 1px solid var(--chat-line, var(--workbench-line)); max-height: 200px; overflow: auto; color: var(--chat-muted, var(--workbench-muted)); font: 11px/1.7 var(--font-mono, 'JetBrains Mono', Consolas, monospace); white-space: pre-wrap; overflow-wrap: anywhere; }
.chat-error-detail code { font: inherit; }
</style>
