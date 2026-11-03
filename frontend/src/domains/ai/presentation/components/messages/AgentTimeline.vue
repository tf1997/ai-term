<script setup lang="ts">
import { computed } from 'vue'
import type { AiMessage } from '../../../domain/conversation'
import type { AgentStep } from '../../../domain/agent'
import { agentDisplayTimeline, agentPresentationTimeline } from '../../../domain/agentTimeline'
import UiIcon from '../../../../../shared/ui/UiIcon.vue'

const props = withDefaults(defineProps<{ message: AiMessage; groupCompleted?: boolean }>(), { groupCompleted: true })
const entries = computed(() => props.groupCompleted ? agentPresentationTimeline(props.message) : agentDisplayTimeline(props.message))
function duration(steps: AgentStep[]) {
  if (steps.some(step => step.durationMs === undefined)) return ''
  const milliseconds = steps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0)
  return milliseconds < 1000 ? `${milliseconds}ms` : `${(milliseconds / 1000).toFixed(1)}s`
}
</script>

<template>
  <div class="agent-timeline">
    <template v-for="entry in entries" :key="entry.id">
      <details v-if="entry.kind === 'completed-group'" class="agent-completed-group">
        <summary>
          <UiIcon name="check" size="14" />
          <span>已完成 {{ entry.steps.length }} 个步骤</span>
          <span class="agent-completed-duration" title="这些步骤的命令执行总耗时">{{ duration(entry.steps) }}</span>
          <UiIcon class="agent-completed-chevron" name="arrow-down" size="13" />
        </summary>
        <div class="agent-completed-content">
          <slot v-for="item in entry.entries" :key="item.id" :entry="item" />
        </div>
      </details>
      <slot v-else :entry="entry" />
    </template>
  </div>
</template>

<style scoped>
.agent-timeline { display: grid; gap: var(--ai-card-gap); min-width: 0; }
.agent-completed-group { min-width: 0; border-block: 1px solid var(--chat-line); }
.agent-completed-group > summary { display: flex; align-items: center; min-height: 40px; gap: 8px; color: var(--chat-muted); font-size: var(--ai-font-ui); cursor: pointer; list-style: none; line-height: var(--ai-leading-ui); }
.agent-completed-group > summary::-webkit-details-marker { display: none; }
.agent-completed-group > summary > .ui-icon:first-child { color: var(--chat-accent); }
.agent-completed-group > summary:focus-visible { outline: 2px solid var(--chat-accent); outline-offset: -2px; border-radius: 4px; }
.agent-completed-duration { margin-left: auto; font-size: var(--ai-font-ui); font-variant-numeric: tabular-nums; line-height: var(--ai-leading-ui); }
.agent-completed-chevron { flex-shrink: 0; }
.agent-completed-group[open] > summary .agent-completed-chevron { transform: rotate(180deg); }
.agent-completed-content { display: grid; min-width: 0; gap: var(--ai-card-gap); padding-bottom: 10px; }
</style>
