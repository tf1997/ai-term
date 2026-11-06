<script setup lang="ts">
import { computed } from 'vue'
import type { AiMessage } from '../../../domain/conversation'
import { agentPlanProgress } from '../../../domain/agentTaskProgress'
import AgentStepDetails from './AgentStepDetails.vue'

const props = defineProps<{ message: AiMessage }>()
const plan = computed(() => props.message.agentPlan)
const checks = computed(() => props.message.agentVerifications ?? [])
const progress = computed(() => agentPlanProgress(plan.value))
const labels = { pending: '待执行', 'in-progress': '进行中', completed: '已完成', waiting: '等待输入', skipped: '已跳过', cancelled: '已取消', failed: '失败' }
const checkLabels = { pending: '待验证', passed: '通过', failed: '失败', unavailable: '尚无法确认' }
const outcomeLabels = { verified: '已验证', partial: '部分完成', unverified: '尚未验证', 'verification-failed': '验证失败' }
const evidence = (stepId?: string) => props.message.agentSteps?.find(step => step.id === stepId)
</script>

<template>
  <section v-if="plan || checks.length || (!message.streaming && message.agentOutcome && message.agentSteps?.length)" class="agent-task-progress" aria-label="任务计划与验证">
    <details v-if="plan" class="task-plan" :open="message.streaming">
      <summary>任务计划 · 已完成 {{ progress.completed }} · 剩余 {{ progress.remaining }}<template v-if="progress.skipped"> · 跳过 {{ progress.skipped }}</template><template v-if="progress.cancelled"> · 取消 {{ progress.cancelled }}</template></summary>
      <p class="task-plan-reason">{{ plan.reason }} · 版本 {{ plan.version }}</p>
      <ol>
        <li v-for="item in plan.items" :key="item.id" :data-plan-id="item.id" :data-plan-status="item.status"><span>{{ labels[item.status] }}</span>{{ item.description }}<small v-if="item.stepIds.length">关联 {{ item.stepIds.length }} 个执行步骤</small><small v-if="item.userConfirmation" :data-user-confirmation="item.userConfirmation.messageId">用户确认 · {{ new Date(item.userConfirmation.confirmedAt).toLocaleString() }}</small></li>
      </ol>
      <details v-if="plan.changes.length > 1"><summary>计划调整记录</summary><p v-for="change in plan.changes" :key="change.version">版本 {{ change.version }} · {{ change.reason }}</p></details>
    </details>
    <div class="task-verification-heading" :data-outcome="message.agentOutcome || 'unverified'">{{ outcomeLabels[message.agentOutcome || 'unverified'] }}</div>
    <p v-if="!checks.length" class="task-verification-note">尚未记录任务结果检查。</p>
    <details v-for="check in checks" :key="check.id" class="task-verification" :data-verification-id="check.id" :data-verification-status="check.status">
      <summary>{{ checkLabels[check.status] }} · {{ check.purpose }}<small>{{ check.required ? '必要项' : '补充项' }}</small></summary>
      <p>预期：{{ check.check.expected }}</p><pre>{{ check.actual }}</pre>
      <p v-if="check.check.stepId">证据步骤：{{ evidence(check.check.stepId)?.reason || check.check.stepId }}</p>
      <p v-if="check.observedAt">记录时间：{{ new Date(check.observedAt).toLocaleString() }}</p>
      <AgentStepDetails v-if="evidence(check.check.stepId)" :command="evidence(check.check.stepId)!.sensitive ? '[敏感命令已隐藏]' : evidence(check.check.stepId)!.command" :output="evidence(check.check.stepId)!.sensitive ? '[敏感输出已隐藏]' : evidence(check.check.stepId)!.output" :exit-code="evidence(check.check.stepId)!.exitCode" details-title="验证依据" />
    </details>
    <p v-if="checks.length && message.agentOutcome === 'unverified'" class="task-verification-note">仍有检查缺失或无法确认；进程退出成功本身不能证明任务目标已达成。</p>
  </section>
</template>

<style scoped>
.agent-task-progress { margin: 10px 0; padding: 10px 0; border-block: 1px solid var(--chat-line); color: var(--chat-text); font-size: var(--ai-font-ui); line-height: var(--ai-leading-ui); min-width: 0; overflow-wrap: anywhere; }
summary { cursor: pointer; padding: 5px 0; }
p { margin: 6px 0; }
.task-plan-reason, small, .task-verification-note { color: var(--chat-muted); }
ol { margin: 8px 0; padding-left: 20px; }
li { margin: 6px 0; }
li > span { margin-right: 8px; color: var(--chat-muted); }
small { margin-left: 8px; }
.task-verification-heading { margin-top: 8px; font-weight: var(--ai-weight-medium); }
[data-outcome=verified] { color: var(--chat-accent); }
[data-outcome=verification-failed], [data-verification-status=failed] > summary { color: var(--chat-danger); }
pre { margin: 8px 0; max-height: 180px; overflow: auto; white-space: pre-wrap; font: var(--ai-font-ui)/var(--ai-leading-ui) var(--font-mono); }
</style>
