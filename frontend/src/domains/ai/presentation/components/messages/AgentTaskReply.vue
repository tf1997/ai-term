<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AgentCheckpoint } from '../../../domain/agentCheckpoints'
const props = defineProps<{ run: AgentCheckpoint; busy?: boolean; showQuestion?: boolean }>()
const emit = defineEmits<{ reply: [run: AgentCheckpoint, text: string, confirmedPlanItemIds: string[]] }>()
const text = ref('')
const confirmedIds = ref<string[]>([])
const confirmableItems = computed(() => props.run.state.plan?.items.filter(item => !['completed', 'cancelled', 'skipped'].includes(item.status)) ?? [])
const tooLong = computed(() => new TextEncoder().encode(text.value).length > 8192)
</script>

<template>
  <form class="agent-task-reply" aria-label="回复并继续任务" @submit.prevent="!busy && text.trim() && !tooLong && emit('reply', run, text.trim(), [...confirmedIds])">
    <p v-if="showQuestion">{{ run.state.finalText }}</p>
    <label>回复任务问题<textarea v-model="text" rows="3" maxlength="8192" :disabled="busy" placeholder="补充说明后，继续原目标和计划" /></label>
    <p v-if="tooLong" role="status">回复过长，请精简后提交。</p>
    <details v-if="confirmableItems.length" class="reply-plan-confirmations">
      <summary>确认已完成的事项（可选）</summary>
      <p>仅勾选你已经核对的事项。将记录为用户确认，后续操作仍需审批。</p>
      <label v-for="item in confirmableItems" :key="item.id"><input v-model="confirmedIds" type="checkbox" :value="item.id" :disabled="busy" />{{ item.description }}</label>
    </details>
    <button type="submit" class="chat-button" :disabled="busy || !run.routeKey || !text.trim() || tooLong">回复并继续任务</button>
    <small>继续前重新核对目标；已有步骤保留，后续操作重新审查。</small>
  </form>
</template>

<style scoped>
.agent-task-reply { margin: 10px 0; min-width: 0; font-size: var(--ai-font-ui); line-height: var(--ai-leading-ui); }
label, textarea, small { display: block; }
textarea { box-sizing: border-box; width: 100%; min-width: 0; resize: vertical; margin: 6px 0; padding: 8px; color: var(--chat-text); background: var(--chat-surface); border: 1px solid var(--chat-line); border-radius: 6px; font: inherit; }
small { margin-top: 6px; color: var(--chat-muted); }
.reply-plan-confirmations { margin: 10px 0; overflow-wrap: anywhere; }
.reply-plan-confirmations summary { cursor: pointer; }
.reply-plan-confirmations p { color: var(--chat-muted); }
.reply-plan-confirmations label { display: flex; align-items: start; gap: 6px; margin: 8px 0; }
.reply-plan-confirmations input { flex: none; width: 14px; height: 14px; min-width: 0; min-height: 0; margin: 3px 0; padding: 0; }
</style>
