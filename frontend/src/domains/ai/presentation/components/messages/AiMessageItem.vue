<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { AiMessage } from '../../../domain/conversation'
import { formatMessageUsageLabel, formatMessageUsageTitle, formatTokenCount } from '../../../domain/tokenUsage'
import UiIcon from '../../../../../shared/ui/UiIcon.vue'
import { useCopyFeedback } from './useCopyFeedback'

const props = defineProps<{
  message: AiMessage
  source: string
  duration: string
}>()

const { copyFeedback, copyText } = useCopyFeedback()

const usageOpen = ref(false)
const usageButton = ref<HTMLButtonElement | null>(null)
const usagePopover = ref<HTMLElement | null>(null)

function toggleUsage() {
  usageOpen.value = !usageOpen.value
  if (usageOpen.value) void nextTick(() => usagePopover.value?.focus())
}

function closeUsage(focusButton = false) {
  if (!usageOpen.value) return
  usageOpen.value = false
  if (focusButton) void nextTick(() => usageButton.value?.focus())
}

function handleDocumentPointerDown(event: PointerEvent) {
  const target = event.target
  if (!(target instanceof Node)) return
  if (usageButton.value?.contains(target) || usagePopover.value?.contains(target)) return
  closeUsage()
}

function handleDocumentKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') closeUsage(true)
}

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointerDown, true)
  document.addEventListener('keydown', handleDocumentKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown, true)
  document.removeEventListener('keydown', handleDocumentKeydown)
})
</script>

<template>
  <article class="chat-turn" :class="message.role === 'user' ? 'chat-turn-user' : 'chat-turn-assistant'" :data-message-id="message.id">
    <header v-if="message.role === 'assistant'" class="chat-turn-head">
      <span class="chat-identity"><UiIcon name="ai" size="15" /><strong>AI</strong></span>
      <span class="chat-source" :title="`生成上下文：${source}`">{{ source }}</span>
      <span v-if="duration && !message.streaming" class="chat-duration" :title="message.mode === 'agent' ? '任务总耗时，包含执行命令与等待确认' : '回答耗时'">耗时 {{ duration }}</span>
      <button
        v-if="message.usage"
        ref="usageButton"
        class="chat-icon chat-usage"
        type="button"
        :title="formatMessageUsageTitle(message.usage)"
        :aria-label="`Token 用量 ${formatMessageUsageLabel(message.usage)}`"
        :aria-expanded="usageOpen"
        aria-haspopup="dialog"
        @click="toggleUsage"
      >
        <UiIcon name="info" size="14" />
      </button>
      <div v-if="usageOpen && message.usage" ref="usagePopover" class="chat-usage-popover" role="dialog" aria-label="Token 用量详情" tabindex="-1">
        <div class="chat-usage-popover-head">
          <strong>Token 用量</strong>
          <button class="chat-usage-close" type="button" aria-label="关闭 Token 用量详情" title="关闭" @click="closeUsage(true)"><UiIcon name="close" size="13" /></button>
        </div>
        <dl class="chat-usage-list">
          <template v-if="message.usage.inputTokens !== undefined">
            <dt>输入</dt><dd>{{ formatTokenCount(message.usage.inputTokens) }}</dd>
          </template>
          <template v-if="message.usage.cachedInputTokens !== undefined">
            <dt>缓存命中</dt><dd>{{ formatTokenCount(message.usage.cachedInputTokens) }}</dd>
          </template>
          <template v-if="message.usage.outputTokens !== undefined">
            <dt>输出</dt><dd>{{ formatTokenCount(message.usage.outputTokens) }}</dd>
          </template>
          <template v-if="message.usage.reasoningTokens !== undefined">
            <dt>推理</dt><dd>{{ formatTokenCount(message.usage.reasoningTokens) }}</dd>
          </template>
          <template v-if="message.usage.totalTokens !== undefined">
            <dt>合计</dt><dd>{{ formatTokenCount(message.usage.totalTokens) }}</dd>
          </template>
          <dt>模型请求</dt><dd>{{ message.usage.requests }} 次</dd>
        </dl>
        <p class="chat-usage-note">仅统计模型服务返回用量的请求</p>
      </div>
      <span v-if="copyFeedback" class="chat-copy-feedback" role="status">{{ copyFeedback }}</span>
      <button v-if="message.text && !message.error && !message.streaming" class="chat-icon chat-copy" type="button" :title="copyFeedback || '复制回复'" :aria-label="copyFeedback || '复制回复'" @click="copyText(props.message.text)">
        <UiIcon name="copy" size="14" />
      </button>
    </header>
    <div class="chat-turn-body"><slot /></div>
  </article>
</template>

<style scoped>
.chat-turn { min-width: 0; width: 100%; margin: 0; padding: 0; border: 0; background: transparent; overflow-anchor: none; }
.chat-turn-user { align-self: flex-end; width: fit-content; max-width: 85%; border-radius: 8px; background: var(--chat-user); padding: 9px 12px; }
.chat-turn-head { position: relative; display: flex; align-items: center; gap: 8px; min-height: 32px; margin-bottom: 5px; min-width: 0; }
.chat-copy-feedback { color: var(--chat-muted); font-size: 11px; flex: none; }
.chat-identity { display: inline-flex; align-items: center; gap: 6px; color: var(--chat-text); font-size: 12px; flex: none; }
.chat-identity .ui-icon { color: var(--chat-accent); }
.chat-source { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--chat-muted); font-size: 12px; }
.chat-duration { margin-left: auto; flex: none; color: var(--chat-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.chat-copy { margin-left: auto; opacity: 0; }
.chat-duration ~ .chat-copy, .chat-usage ~ .chat-copy { margin-left: 0; }
.chat-turn:hover .chat-copy, .chat-turn:focus-within .chat-copy { opacity: 1; }
.chat-turn-body { display: grid; min-width: 0; gap: 12px; overflow-wrap: anywhere; font-size: var(--font-md); line-height: 1.6; }
.chat-icon { display: inline-grid; place-items: center; width: 28px; height: 28px; padding: 0; flex: none; border: 0; border-radius: 5px; background: transparent; color: var(--chat-muted); }
.chat-icon:hover { background: var(--chat-hover); color: var(--chat-text); }
.chat-icon:focus-visible { outline: 2px solid var(--chat-accent); outline-offset: 1px; }
.chat-usage { margin-left: auto; }
.chat-duration ~ .chat-usage { margin-left: 0; }
.chat-usage-popover { position: absolute; top: 35px; right: 0; z-index: 5; width: min(250px, calc(100% - 8px)); padding: 10px 12px; border: 1px solid var(--chat-line); border-radius: 8px; background: var(--chat-surface); color: var(--chat-text); box-shadow: 0 8px 24px #0000001f; outline: none; }
.chat-usage-popover-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding-bottom: 8px; border-bottom: 1px solid var(--chat-line); font-size: 12px; }
.chat-usage-close { display: inline-grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--chat-muted); cursor: pointer; }
.chat-usage-close:hover { background: var(--chat-hover); color: var(--chat-text); }
.chat-usage-close:focus-visible { outline: 2px solid var(--chat-accent); outline-offset: 1px; }
.chat-usage-list { display: grid; grid-template-columns: 1fr auto; gap: 5px 16px; margin: 9px 0 0; font-size: 12px; line-height: 1.45; }
.chat-usage-list dt { color: var(--chat-muted); }
.chat-usage-list dd { margin: 0; color: var(--chat-text); font-variant-numeric: tabular-nums; text-align: right; }
.chat-usage-note { margin: 9px 0 0; color: var(--chat-muted); font-size: 11px; line-height: 1.4; }
@media (hover: none) { .chat-copy { opacity: 1; } }
</style>
