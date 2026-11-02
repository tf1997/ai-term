<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AiMessage } from '../../../domain/conversation'
import { agentWorkedLabel, hasCompletedAgentWork } from '../../../domain/agentWorkLog'
import UiIcon from '../../../../../shared/ui/UiIcon.vue'

const props = defineProps<{ message: AiMessage }>()
const finished = computed(() => hasCompletedAgentWork(props.message))
const expanded = ref(false)
const errors = computed(() => props.message.agentSteps?.filter(step => step.status === 'failed' || (step.exitCode !== undefined && step.exitCode !== 0)).length ?? 0)
watch([() => props.message.id, finished], () => { expanded.value = false })
</script>

<template>
  <div class="agent-work-log" :class="{ 'is-finished': finished, 'is-expanded': expanded }">
    <button v-if="finished" class="agent-work-toggle" type="button" :aria-expanded="expanded" :title="expanded ? '收起任务执行过程' : '查看任务执行过程'" @click="expanded = !expanded">
      <span>{{ agentWorkedLabel(message) }}</span>
      <span v-if="message.agentSteps?.length" class="agent-work-count">{{ message.agentSteps.length }} 个步骤</span>
      <span v-if="errors" class="agent-work-errors">{{ errors }} 次异常</span>
      <UiIcon :name="expanded ? 'arrow-down' : 'chevron-right'" size="13" />
    </button>
    <div v-if="!finished || expanded" class="agent-work-content"><slot /></div>
  </div>
</template>

<style scoped>
.agent-work-log { min-width: 0; }
.agent-work-log.is-finished { border-bottom: 1px solid var(--chat-line); }
.agent-work-toggle { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; height: auto; min-height: 34px; padding: 5px 0 8px; border: 0; background: transparent; color: var(--chat-muted); font-size: 12px; font-weight: 400; line-height: 20px; text-align: left; cursor: pointer; }
.agent-work-toggle > span:first-child { font-variant-numeric: tabular-nums; }
.agent-work-toggle > .ui-icon { flex: none; }
.agent-work-toggle:hover:not(:disabled) { color: var(--chat-text); background: transparent; }
.agent-work-toggle:focus-visible { outline: 2px solid var(--chat-accent); outline-offset: 2px; border-radius: 3px; }
.agent-work-count { font-size: 11px; margin-left: auto; white-space: nowrap; }
.agent-work-errors { color: var(--chat-danger); font-size: 11px; white-space: nowrap; }
.agent-work-content { min-width: 0; }
.is-finished > .agent-work-content { padding: 8px 0 14px; }
</style>
