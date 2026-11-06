<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AgentRecoveryReview, AgentRecoveryDecision } from '../../../domain/agentCheckpoints'
import { recoveryEvidenceSteps } from '../../../domain/agentCheckpoints'
import type { AgentStep } from '../../../domain/agent'
import AgentStepDetails from './AgentStepDetails.vue'
const props = defineProps<{ review: AgentRecoveryReview; saving?: boolean; targetLabel: string }>()
const emit = defineEmits<{ decide: [decision: AgentRecoveryDecision] }>()
const confirmedTarget = ref(false)
const note = ref('')
const observations = ref<Record<string, string>>({})
const evidenceIds = ref<Record<string, string[]>>({})
watch(() => props.review, () => { confirmedTarget.value = false; observations.value = {}; evidenceIds.value = {}; note.value = '' }, { immediate: true })
const requirements = computed(() => props.review.recovery.requiredStepIds.map(id => props.review.steps.find(step => step.id === id)).filter((step): step is AgentStep => Boolean(step)))
const evidence = computed(() => recoveryEvidenceSteps(props.review))
const ready = computed(() => confirmedTarget.value && requirements.value.length === props.review.recovery.requiredStepIds.length && requirements.value.every(step => (observations.value[step.id]?.trim().length ?? 0) >= 2 && Boolean(evidenceIds.value[step.id]?.length) && evidenceIds.value[step.id].length <= 8 && evidenceIds.value[step.id].every(id => evidence.value.some(item => item.id === id))))
function confirm() {
  if (!ready.value || props.saving) return
  emit('decide', { action: 'continue', resolutions: requirements.value.map(step => ({ stepId: step!.id, evidenceStepIds: evidenceIds.value[step!.id], observation: observations.value[step!.id].trim() })) })
}
</script>

<template>
  <section class="agent-recovery-review" aria-label="恢复任务前核对">
    <strong>核对后继续原任务</strong>
    <p>{{ targetLabel }}</p>
    <p>账号 {{ review.recovery.currentTarget.context.user }} · 当前目录 {{ review.recovery.currentTarget.context.workingDirectory }}</p>
    <details><summary>当前环境标识</summary><p>{{ review.recovery.currentTarget.context.environmentScope }}</p></details>
    <p v-if="review.recovery.originalTarget.context.workingDirectory !== review.recovery.currentTarget.context.workingDirectory" class="recovery-warning">目录已变化，原目录为 {{ review.recovery.originalTarget.context.workingDirectory }}；后续步骤将依据当前现场重新规划。</p>
    <details open><summary>检查结论</summary><p class="recovery-summary">{{ review.summary }}</p></details>
    <section v-for="step in requirements" :key="step!.id" class="recovery-requirement" :data-recovery-step="step!.id">
      <p><strong>待核对：{{ step!.reason || step!.command || step!.id }}</strong></p>
      <AgentStepDetails :command="step!.command" :output="step!.output" details-title="中断前记录" />
      <label>当前检查依据
        <select multiple v-model="evidenceIds[step!.id]" :disabled="saving" :aria-label="`核验 ${step!.id} 的依据`">

          <option v-for="item in evidence" :key="item.id" :value="item.id">{{ item.reason || item.fileRequest?.path || item.command || item.id }}</option>
        </select>
      </label>
      <label>现场结论<textarea v-model="observations[step!.id]" :disabled="saving" maxlength="1000" rows="2" placeholder="说明当前状态，以及接下来还需要处理什么" :aria-label="`核验 ${step!.id} 的结论`" /></label>
    </section>
    <details v-if="evidence.length"><summary>本次只读检查 · {{ evidence.length }} 项</summary>
      <div v-for="step in evidence" :key="step.id"><p>{{ step.reason }}</p><AgentStepDetails :command="step.command" :output="step.output || (step.fileAbsence ? '已确认文件不存在' : '')" :exit-code="step.exitCode" details-title="查看检查结果" /></div>
    </details>
    <p v-if="requirements.length && !evidence.length" class="recovery-warning">尚无可用的新检查依据，可补充说明并继续只读核对。</p>
    <label class="recovery-target"><input v-model="confirmedTarget" type="checkbox" :disabled="saving" />已核对当前目标和检查结果，继续原任务</label>
    <p>继续后重新审批后续命令和文件差异。中断前未知的操作保留原记录，不会自动重放。</p>
    <div class="recovery-actions"><button type="button" class="chat-button" :disabled="!ready || saving" @click="confirm">{{ saving ? '确认中…' : '确认并继续' }}</button><button type="button" class="chat-text-button" :disabled="saving" @click="emit('decide', { action: 'stop' })">停止恢复</button></div>
    <label>补充现场信息<textarea v-model="note" :disabled="saving" maxlength="2000" rows="2" placeholder="还需核对的文件或服务、对检查结论的修正" /></label>
    <button type="button" class="chat-text-button" :disabled="saving" @click="emit('decide', { action: 'inspect', note })">继续只读检查</button>
  </section>
</template>

<style scoped>
.agent-recovery-review { border: 1px solid var(--chat-line); border-radius: var(--ai-card-radius); padding: 12px; min-width: 0; color: var(--chat-text); font-size: var(--ai-font-ui); line-height: var(--ai-leading-ui); overflow-wrap: anywhere; }
p { margin: 8px 0; }
summary { cursor: pointer; padding: 6px 0; }
.recovery-summary { white-space: pre-wrap; }
.recovery-requirement { border-block: 1px solid var(--chat-line); padding: 6px 0; margin: 8px 0; }
label { display: block; margin: 8px 0; }
textarea, select { display: block; box-sizing: border-box; width: 100%; min-width: 0; margin-top: 6px; padding: 7px; border: 1px solid var(--chat-line); border-radius: 6px; background: var(--chat-surface); color: var(--chat-text); font: inherit; }
textarea { resize: vertical; }
.recovery-target { display: flex; align-items: flex-start; gap: 6px; }
.recovery-target input { margin-top: 3px; }
.recovery-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
.recovery-warning { color: var(--chat-warning, var(--workbench-warning)); }
</style>
