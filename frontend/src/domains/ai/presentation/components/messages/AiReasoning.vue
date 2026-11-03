<script setup lang="ts">
import { ref } from 'vue'
import AiMarkdownMessage from './AiMarkdownMessage.vue'
import UiIcon from '../../../../../shared/ui/UiIcon.vue'

defineProps<{ content: string; legacy?: boolean }>()
const expanded = ref(false)
</script>

<template>
  <details class="chat-reasoning" @toggle="expanded = ($event.target as HTMLDetailsElement).open">
    <summary>
      <UiIcon name="chevron-right" size="14" />
      <span>{{ legacy ? '历史思考记录' : '思考过程' }}</span>
      <small v-if="legacy">旧记录未区分正文</small>
    </summary>
    <AiMarkdownMessage v-if="expanded" :content="content" :interactive-commands="false" />
  </details>
</template>

<style scoped>
.chat-reasoning { min-width: 0; color: var(--chat-muted, var(--workbench-muted)); }
summary { display: flex; align-items: center; gap: 5px; min-height: 24px; font-size: var(--ai-font-ui); line-height: var(--ai-leading-ui); cursor: pointer; list-style: none; }
summary::-webkit-details-marker { display: none; }
summary .ui-icon { flex: none; }
[open] > summary .ui-icon { transform: rotate(90deg); }
summary:hover { color: var(--chat-text, var(--workbench-text)); }
summary:focus-visible { outline: 2px solid var(--chat-muted); outline-offset: 2px; border-radius: 3px; }
summary small { font-size: var(--ai-font-ui); line-height: var(--ai-leading-ui); }
.chat-markdown { padding-block: 6px; }
.chat-reasoning :deep(.chat-markdown > .markdown-content) { font-size: var(--ai-font-ui); line-height: var(--ai-leading-body); }
.chat-reasoning :deep(.chat-markdown .markdown-content :is(h1, h2, h3, h4, h5, h6)) { font-size: var(--ai-font-body); line-height: var(--ai-leading-body); }
</style>
