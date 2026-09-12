<script setup lang="ts">
import type { AiMessage } from '../../../domain/conversation'
import { formatMessageUsageLabel, formatMessageUsageTitle } from '../../../domain/tokenUsage'
import UiIcon from '../../../../../shared/ui/UiIcon.vue'
import { useCopyFeedback } from './useCopyFeedback'

const props = defineProps<{
  message: AiMessage
  source: string
  duration: string
}>()

const { copyFeedback, copyText } = useCopyFeedback()
</script>

<template>
  <article class="chat-turn" :class="message.role === 'user' ? 'chat-turn-user' : 'chat-turn-assistant'" :data-message-id="message.id">
    <header v-if="message.role === 'assistant'" class="chat-turn-head">
      <span class="chat-identity"><UiIcon name="ai" size="15" /><strong>AI</strong></span>
      <span class="chat-source" :title="`生成上下文：${source}`">{{ source }}</span>
      <span v-if="duration && !message.streaming" class="chat-duration">{{ duration }}</span>
      <span v-if="message.usage" class="chat-icon chat-usage" tabindex="0" :title="formatMessageUsageTitle(message.usage)" :aria-label="`Token 用量 ${formatMessageUsageLabel(message.usage)}`">
        <UiIcon name="info" size="14" />
      </span>
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
.chat-turn-head { display: flex; align-items: center; gap: 8px; min-height: 32px; margin-bottom: 5px; min-width: 0; }
.chat-copy-feedback { color: var(--chat-muted); font-size: 11px; flex: none; }
.chat-identity { display: inline-flex; align-items: center; gap: 6px; color: var(--chat-text); font-size: 12px; flex: none; }
.chat-identity .ui-icon { color: var(--chat-accent); }
.chat-source { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--chat-muted); font-size: 12px; }
.chat-duration { margin-left: auto; flex: none; color: var(--chat-muted); font-size: 12px; }
.chat-copy { margin-left: auto; opacity: 0; }
.chat-duration ~ .chat-copy, .chat-usage ~ .chat-copy { margin-left: 0; }
.chat-turn:hover .chat-copy, .chat-turn:focus-within .chat-copy { opacity: 1; }
.chat-turn-body { display: grid; min-width: 0; gap: 12px; overflow-wrap: anywhere; font-size: 14px; line-height: 1.6; }
.chat-icon { display: inline-grid; place-items: center; width: 28px; height: 28px; padding: 0; flex: none; border: 0; border-radius: 5px; background: transparent; color: var(--chat-muted); }
.chat-icon:hover { background: var(--chat-hover); color: var(--chat-text); }
.chat-icon:focus-visible { outline: 2px solid var(--chat-accent); outline-offset: 1px; }
.chat-usage { margin-left: auto; }
.chat-duration ~ .chat-usage { margin-left: 0; }
@media (hover: none) { .chat-copy { opacity: 1; } }
</style>
