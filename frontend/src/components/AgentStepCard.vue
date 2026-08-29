<script setup lang="ts">
import { computed } from 'vue'
import type { AgentStep, AgentStepProposal } from '../types/agent'
import type { ScriptRiskMatch } from '../lib/scriptRisk'

// Agent 单步卡片:展示命令、理由、风险与执行结果,并在等待审批/超时决策时提供操作。
// 只负责呈现与事件外发,审批状态由 AiPanel 持有(见 docs/ai-agent-mode-development.md 6.4)。

const props = defineProps<{
  step: AgentStep
  /** 该步骤正在等待人工审批。 */
  awaitingApproval?: boolean
  /** 该步骤正在等待超时决策。 */
  awaitingTimeout?: boolean
  /** 审批提案;提供「总是允许」所需的 pattern 列表。 */
  proposal?: AgentStepProposal
  timeoutWaitedMs?: number
  /** 高风险命令的二次确认已激活。 */
  highRiskArmed?: boolean
}>()

const emit = defineEmits<{
  execute: []
  executeAndAllow: []
  skip: []
  stop: []
  wait: []
  timeoutStop: []
}>()

const STATUS_LABELS: Record<AgentStep['status'], string> = {
  pending: '待审批',
  running: '执行中',
  completed: '已完成',
  skipped: '已跳过',
  timeout: '已超时',
  failed: '失败'
}

const statusLabel = computed(() => STATUS_LABELS[props.step.status] ?? props.step.status)

const riskLabels = computed(() => [...new Set(props.step.risks.map((risk: ScriptRiskMatch) => risk.label))])

const hasHighRisk = computed(() => props.step.risks.some((risk) => risk.severity === 'high'))

/** 已产生执行结果,可展示输出区(含"无输出"占位)。 */
const hasRun = computed(() =>
  props.step.status === 'completed' || props.step.status === 'failed' || props.step.status === 'timeout'
)

const durationLabel = computed(() => {
  const value = props.step.durationMs
  if (value === undefined) return ''
  return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`
})

const executeLabel = computed(() => {
  if (!hasHighRisk.value) return '执行'
  return props.highRiskArmed ? '确认执行' : '执行'
})

const allowPatterns = computed(() => props.proposal?.suggestedPatterns ?? [])

/** 多段命令需要补齐每一段,标签只显示首项 + 总数,完整清单放 title。 */
const allowLabel = computed(() => {
  const patterns = allowPatterns.value
  if (!patterns.length) return ''
  if (patterns.length === 1) return `总是允许 ${patterns[0]}`
  return `总是允许 ${patterns[0]} 等 ${patterns.length} 项`
})

const allowTitle = computed(() => {
  const patterns = allowPatterns.value
  if (!patterns.length) return ''
  return `加入允许列表后自动执行:${patterns.join('、')}`
})

const waitedSecondsLabel = computed(() => `${Math.round((props.timeoutWaitedMs ?? 0) / 1000)}s`)
</script>

<template>
  <article class="agent-step-card" :class="`agent-step-${step.status}`">
    <div class="agent-step-head">
      <span class="agent-step-status" :class="step.status">{{ statusLabel }}</span>
      <span v-if="step.autoApproved" class="chip agent-step-auto" title="通过只读判定或允许列表,已自动执行">自动执行</span>
      <span v-for="label in riskLabels" :key="label" class="chip agent-step-risk">{{ label }}</span>
      <span v-if="step.sensitive" class="chip agent-step-risk">敏感</span>
      <span v-if="step.exitCode !== undefined || durationLabel" class="agent-step-meta">
        <span v-if="step.exitCode !== undefined" class="agent-step-exit" :class="{ failed: step.exitCode !== 0 }">exit {{ step.exitCode }}</span>
        <span v-if="durationLabel" class="agent-step-duration">{{ durationLabel }}</span>
      </span>
    </div>

    <p v-if="step.reason" class="agent-step-reason">{{ step.reason }}</p>

    <pre class="agent-step-command"><code>{{ step.command }}</code></pre>

    <pre v-if="step.output" class="agent-step-output"><code>{{ step.output }}</code></pre>
    <p v-else-if="hasRun" class="agent-step-empty-output">（无输出）</p>

    <div v-if="awaitingApproval" class="agent-step-actions">
      <p v-if="hasHighRisk && highRiskArmed" class="agent-step-confirm-note">高风险命令，再次点击「确认执行」以继续。</p>
      <button
        type="button"
        class="agent-action primary"
        :class="{ armed: hasHighRisk && highRiskArmed }"
        @click="emit('execute')"
      >{{ executeLabel }}</button>
      <button
        v-if="allowPatterns.length"
        type="button"
        class="agent-action agent-action-allow"
        :title="allowTitle"
        @click="emit('executeAndAllow')"
      >{{ allowLabel }}</button>
      <button type="button" class="agent-action" @click="emit('skip')">跳过</button>
      <button type="button" class="agent-action danger" @click="emit('stop')">停止</button>
    </div>

    <div v-if="awaitingTimeout" class="agent-step-actions">
      <p class="agent-step-timeout-note">已运行 {{ waitedSecondsLabel }} 未结束，可能在等待输入。</p>
      <button type="button" class="agent-action primary" @click="emit('wait')">继续等待</button>
      <button type="button" class="agent-action danger" @click="emit('timeoutStop')">停止</button>
    </div>
  </article>
</template>
