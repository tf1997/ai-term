<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  content: string
  lineNumbers?: boolean
  wrap?: boolean
}>(), { lineNumbers: true, wrap: false })

const lines = computed(() => {
  if (!props.lineNumbers) return []
  // Keep separators as text nodes so partial selections retain the source exactly.
  const parts = props.content.split(/(\r\n|\r|\n)/)
  const result: { text: string; ending: string }[] = []
  for (let index = 0; index < parts.length; index += 2) {
    result.push({ text: parts[index], ending: parts[index + 1] ?? '' })
  }
  return result
})
const numbered = computed(() => props.lineNumbers && lines.value.length > 1)
const numberWidth = computed(() => ({
  '--code-line-number-width': Math.max(2, String(lines.value.length).length) + 'ch'
}))

</script>

<template>
  <code class="ai-code-text" :class="{ 'is-numbered': numbered, 'is-wrapped': wrap }" :style="numberWidth"><template v-if="numbered"><template v-for="(line, index) in lines" :key="index"><span class="ai-code-line-number" :data-line="index + 1" aria-hidden="true"></span><span class="ai-code-line-text">{{ line.text }}</span>{{ line.ending }}</template></template><template v-else>{{ content }}</template></code>
</template>

<style scoped>
.ai-code-text {
  display: block;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  font: inherit;
  color: inherit;
  background: transparent;
  white-space: inherit;
}
.ai-code-text.is-numbered {
  display: grid;
  grid-template-columns: calc(var(--code-line-number-width) + 10px) minmax(0, 1fr);
  align-items: start;
  width: max-content;
  min-width: 100%;
}
.ai-code-text.is-wrapped {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.ai-code-text.is-numbered.is-wrapped {
  width: 100%;
  min-width: 0;
}
.ai-code-line-number {
  position: sticky;
  left: 0;
  z-index: 1;
  align-self: stretch;
  padding-right: 10px;
  color: var(--chat-muted, var(--workbench-muted));
  background: var(--code-line-background, var(--workbench-panel));
  font-variant-numeric: tabular-nums;
  text-align: right;
  -webkit-user-select: none;
  user-select: none;
  pointer-events: none;
}
.ai-code-line-number::before {
  content: attr(data-line);
}
.ai-code-line-text {
  min-width: 0;
  min-height: 1.7em;
}
</style>
