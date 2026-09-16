<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AgentStep, AgentStepProposal, AgentTimeoutInfo } from '../../../domain/agent'
import { formatAiDuration } from '../../../domain/aiTiming'
import UiIcon from '../../../../../shared/ui/UiIcon.vue'
import AiCodeBlock from './AiCodeBlock.vue'
import { useCopyFeedback } from './useCopyFeedback'

const props = withDefaults(defineProps<{
  step: AgentStep
  awaitingApproval?: boolean
  approvalSaving?: boolean
  awaitingTimeout?: boolean
  proposal?: AgentStepProposal
  timeoutInfo?: AgentTimeoutInfo
  nowMs?: number
  highRiskArmed?: boolean
  failureDetail?: string
  canRetry?: boolean
  retryDisabledReason?: string
  targetLabel?: string
  observationStopped?: boolean
}>(), { failureDetail: '', canRetry: false, retryDisabledReason: '', targetLabel: '' })

const emit = defineEmits<{
  execute: []
  reviewRisk: []
  executeAndAllow: []
  skip: []
  stop: []
  wait: []
  timeoutStop: []
  retry: []
  focusTerminal: []
}>()

const { copyFeedback, copyText } = useCopyFeedback()
const explicitlyExpanded = ref<boolean | null>(null)
const failureDetailsOpen = ref(false)
const nonzeroExit = computed(() => props.step.exitCode !== undefined && props.step.exitCode !== 0)
const isFailed = computed(() => props.step.status === 'failed' || (props.step.status === 'completed' && nonzeroExit.value))
const didNotStart = computed(() => props.step.executionPhase === 'not-started')
const stoppedWhileWaiting = computed(() => props.observationStopped && (props.step.status === 'running' || props.step.status === 'timeout' || props.step.status === 'pending'))
const resultUnknown = computed(() => props.step.status === 'failed' && !didNotStart.value && props.step.executionPhase !== 'finished' && props.step.exitCode === undefined)
const canCollapse = computed(() => !props.awaitingApproval && !props.awaitingTimeout && (stoppedWhileWaiting.value || (props.step.status !== 'running' && props.step.status !== 'pending')))
const collapsed = computed(() => canCollapse.value && (explicitlyExpanded.value === null
  ? props.step.status === 'skipped' || (props.step.status === 'completed' && !nonzeroExit.value)
  : !explicitlyExpanded.value))
const statusLabel = computed(() => {
  if (props.approvalSaving) return '正在保存授权'
  if (stoppedWhileWaiting.value) return didNotStart.value || props.step.status === 'pending' ? '未执行' : '已停止等待'
  if (props.awaitingTimeout) return '等待确认'
  if (props.step.status === 'failed' && didNotStart.value) return '未执行'
  if (resultUnknown.value) return '结果未知'
  if (isFailed.value) return '执行异常'
  return { pending: '待审批', running: '执行中', completed: '已完成', skipped: '已跳过', timeout: '等待已停止', failed: '执行异常' }[props.step.status]
})
const statusIcon = computed(() => {
  if (stoppedWhileWaiting.value) return 'history'
  if (isFailed.value) return 'alert'
  if (props.step.status === 'running') return 'refresh'
  if (props.step.status === 'timeout') return 'history'
  return 'terminal'
})
const riskLabels = computed(() => [...new Set(props.step.risks.map((risk) => risk.label))])
const hasHighRisk = computed(() => props.step.risks.some((risk) => risk.severity === 'high'))
const hasRisk = computed(() => props.step.risks.length > 0 || props.step.sensitive)
const durationLabel = computed(() => {
  if (!props.observationStopped && props.step.status === 'running' && props.step.startedAt !== undefined && props.nowMs !== undefined) {
    return `已等待 ${formatAiDuration((props.nowMs - props.step.startedAt) / 1000)}`
  }
  const value = props.step.durationMs
  if (value === undefined) return ''
  return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`
})
const countdownLabel = computed(() => {
  if (props.observationStopped || props.awaitingTimeout || props.step.status !== 'running' || props.step.deadlineAt === undefined || props.nowMs === undefined) return ''
  const remaining = props.step.deadlineAt - props.nowMs
  return remaining <= 0 ? '即将询问' : `${Math.ceil(remaining / 1000)}s 后询问`
})
const allowPatterns = computed(() => !hasRisk.value && props.proposal?.id === props.step.id ? props.proposal.suggestedPatterns ?? [] : [])
const allowUnavailableReason = computed(() => {
  if (props.step.sensitive) return '涉及敏感信息，需每次确认，不能总是允许。'
  if (hasRisk.value) return '命中风险规则，需每次确认，不能总是允许。'
  return '此命令无法按前缀自动授权，仅支持本次确认。'
})
const failureReason = computed(() => {
  if (stoppedWhileWaiting.value) return didNotStart.value || props.step.status === 'pending' ? '任务已停止，命令未执行。' : '已停止等待；命令可能仍在终端运行。'
  if (didNotStart.value && isFailed.value) {
    const detail = props.step.failureReason || props.failureDetail
    return /Shell 尚未返回可执行提示符/i.test(detail)
      ? '终端尚未就绪，命令未执行。'
      : detail ? `命令未执行。${detail}` : '命令未执行，请查看终端。'
  }
  if (resultUnknown.value) return '未能确认命令执行结果，请查看终端。'
  if (props.step.status === 'timeout') return '已停止等待；命令可能仍在终端运行。'
  if (nonzeroExit.value) return `命令已结束，退出码为 ${props.step.exitCode}。`
  return props.step.failureReason || props.failureDetail
})
const failureDetailText = computed(() => props.step.failureReason || props.failureDetail)
const showFailureDetail = computed(() => failureDetailText.value && failureDetailText.value !== failureReason.value)
const outputContent = computed(() => props.step.output || (props.awaitingTimeout ? props.timeoutInfo?.partialOutput : '') || '')
const showOutput = computed(() => !didNotStart.value && (Boolean(outputContent.value) || props.step.status === 'completed'))

watch(() => props.step.id, () => {
  explicitlyExpanded.value = null
  failureDetailsOpen.value = false
})

function toggleDetails() {
  explicitlyExpanded.value = collapsed.value
}
</script>

<template>
  <article class="tool-step" :class="{ 'is-error': isFailed, 'is-running': step.status === 'running' && !observationStopped, 'is-success': step.status === 'completed' && !nonzeroExit, 'is-collapsed': collapsed }" :data-step-id="step.id" :data-status="step.status" :data-execution-phase="step.executionPhase">
    <header class="tool-step-header">
      <button v-if="canCollapse" type="button" class="tool-step-toggle" :aria-expanded="!collapsed" :aria-label="collapsed ? '展开执行步骤' : '收起执行步骤'" @click="toggleDetails">
        <UiIcon :name="statusIcon" size="15" class="tool-step-state-icon" />
        <span class="tool-step-title">{{ step.reason || '终端命令' }}</span>
        <UiIcon :name="collapsed ? 'arrow-down' : 'arrow-up'" size="13" class="tool-step-chevron" />
      </button>
      <div v-else class="tool-step-heading">
        <UiIcon :name="statusIcon" size="15" class="tool-step-state-icon" />
        <span class="tool-step-title">{{ step.reason || '终端命令' }}</span>
      </div>
      <div class="tool-step-meta">
        <span class="tool-step-status">{{ statusLabel }}</span>
        <span v-if="step.autoApproved" class="tool-step-auto" title="通过只读判定或允许列表">自动执行</span>
        <span v-if="step.exitCode !== undefined" class="tool-step-exit" :class="{ 'tool-step-exit-error': nonzeroExit }">exit {{ step.exitCode }}</span>
        <span v-if="durationLabel" class="tool-step-duration">{{ durationLabel }}</span>
        <span v-if="countdownLabel">{{ countdownLabel }}</span>
      </div>
    </header>

    <div v-if="!collapsed" class="tool-step-body">
      <div v-if="targetLabel" class="tool-step-target" :title="targetLabel"><UiIcon name="terminal" size="13" /><span>{{ targetLabel }}</span></div>
      <div v-if="riskLabels.length || step.sensitive" class="tool-step-risk-row">
        <span v-for="label in riskLabels" :key="label" class="tool-step-risk" :class="{ 'is-high': hasHighRisk }"><UiIcon name="shield" size="12" />{{ label }}</span>
        <span v-if="step.sensitive" class="tool-step-risk is-high">敏感命令</span>
      </div>
      <AiCodeBlock :content="step.command" label="命令" kind="command" flat :full="awaitingApproval" />
      <AiCodeBlock v-if="showOutput" :content="outputContent" label="输出" kind="output" flat empty-text="命令已结束，没有输出。" class="tool-step-output" />

      <div v-if="isFailed || step.status === 'timeout' || stoppedWhileWaiting" class="tool-step-recovery">
        <p v-if="failureReason" class="tool-step-failure-reason">{{ failureReason }}</p>
        <div class="tool-step-actions">
          <button v-if="isFailed" type="button" class="tool-step-action is-primary" :disabled="!canRetry" :title="canRetry ? '重新执行此命令' : retryDisabledReason || '当前无法重试'" @click="emit('retry')"><UiIcon name="refresh" size="13" />重试命令</button>
          <button type="button" class="tool-step-action" @click="emit('focusTerminal')"><UiIcon name="terminal" size="13" />查看终端</button>
          <button v-if="failureDetailText" type="button" class="tool-step-action is-icon" :title="copyFeedback || '复制错误详情'" :aria-label="copyFeedback || '复制错误详情'" @click="copyText(failureDetailText)"><UiIcon name="copy" size="14" /></button>
          <button v-if="showFailureDetail" type="button" class="tool-step-action" :aria-expanded="failureDetailsOpen" @click="failureDetailsOpen = !failureDetailsOpen">详情<UiIcon :name="failureDetailsOpen ? 'arrow-up' : 'arrow-down'" size="12" /></button>
          <span class="tool-step-copy-feedback" role="status">{{ copyFeedback }}</span>
        </div>
        <pre v-if="showFailureDetail && failureDetailsOpen" class="tool-step-error-detail">{{ failureDetailText }}</pre>
      </div>

      <div v-if="awaitingApproval" class="tool-step-decision">
        <div class="tool-step-actions">
          <button type="button" class="tool-step-action is-primary" :disabled="approvalSaving" :class="{ 'is-risk': hasRisk, 'is-armed': hasHighRisk && highRiskArmed }" :title="hasRisk ? '检查风险后确认执行' : '仅执行本次命令，不改变允许列表'" @click="hasRisk ? emit('reviewRisk') : emit('execute')"><UiIcon :name="hasRisk ? 'shield' : 'play'" size="13" />{{ hasRisk ? '查看风险' : '仅执行本次' }}</button>
          <button type="button" class="tool-step-action is-allow" :disabled="approvalSaving || !allowPatterns.length" :title="allowPatterns.length ? `执行本次并加入允许列表：${allowPatterns.join('、')}` : allowUnavailableReason" @click="emit('executeAndAllow')"><UiIcon name="shield" size="13" />{{ approvalSaving ? '保存授权中…' : '总是允许' }}</button>
          <button type="button" class="tool-step-action" :disabled="approvalSaving" @click="emit('skip')">跳过</button>
          <button type="button" class="tool-step-action" @click="emit('stop')"><UiIcon name="stop" size="12" />停止任务</button>
        </div>
        <div v-if="allowPatterns.length" class="tool-step-allow">
          <span>允许前缀</span><code v-for="pattern in allowPatterns" :key="pattern">{{ pattern }}</code>
          <p>对所有会话生效；风险命令仍需确认。可在设置 → Agent 中移除。</p>
        </div>
        <p v-else class="tool-step-allow-reason">{{ allowUnavailableReason }}</p>
      </div>

      <div v-if="awaitingTimeout" class="tool-step-decision">
        <p v-if="timeoutInfo?.hint" class="tool-step-timeout-hint">{{ timeoutInfo.hint }}</p>
        <div class="tool-step-actions">
          <button type="button" class="tool-step-action is-primary" @click="emit('wait')"><UiIcon name="history" size="13" />继续等待</button>
          <button type="button" class="tool-step-action" @click="emit('timeoutStop')"><UiIcon name="stop" size="12" />停止等待</button>
          <button type="button" class="tool-step-action" @click="emit('focusTerminal')"><UiIcon name="terminal" size="13" />查看终端</button>
        </div>
      </div>
    </div>
  </article>
</template>

<style scoped>
.tool-step { width: 100%; min-width: 0; flex: none; box-sizing: border-box; border: 1px solid var(--chat-line, var(--workbench-line)); border-radius: 8px; overflow: hidden; color: var(--chat-text, var(--workbench-text)); background: var(--chat-surface, var(--workbench-panel-strong)); letter-spacing: 0; overflow-anchor: none; }
.tool-step-header { min-width: 0; padding: 12px; }
.tool-step-toggle, .tool-step-heading { display: grid; grid-template-columns: 16px minmax(0, 1fr) 16px; align-items: start; gap: 8px; width: 100%; min-width: 0; height: auto; color: inherit; text-align: left; white-space: normal; }
.tool-step-toggle { border: 0; padding: 0; background: transparent; cursor: pointer; }
.tool-step-toggle:hover .tool-step-chevron { color: var(--chat-accent, var(--workbench-accent)); }
.tool-step-toggle:focus-visible { outline: 2px solid var(--chat-accent, var(--workbench-accent)); outline-offset: 5px; border-radius: 2px; }
.tool-step-title { min-width: 0; font-size: 13px; font-weight: 550; line-height: 1.65; white-space: normal; overflow-wrap: anywhere; }
.tool-step-state-icon, .tool-step-chevron { color: var(--chat-muted, var(--workbench-muted)); margin-top: 4px; }
.tool-step-status { display: inline-flex; align-items: center; gap: 5px; min-width: 0; color: var(--chat-muted, var(--workbench-muted)); font-size: 12px; font-weight: 400; white-space: nowrap; }
.tool-step-status::before { content: ''; width: 5px; height: 5px; flex: none; border-radius: 50%; background: currentColor; }
.tool-step.is-success .tool-step-status { color: var(--chat-accent, var(--workbench-accent)); }
.tool-step.is-error .tool-step-state-icon, .tool-step.is-error .tool-step-status, .tool-step-exit-error { color: var(--chat-danger, #c24150); }
.tool-step.is-running .tool-step-status, .tool-step.is-running .tool-step-state-icon { color: var(--chat-accent, var(--workbench-accent)); }
.tool-step.is-running .tool-step-state-icon { animation: tool-step-spin 1.6s linear infinite; }
.tool-step-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; min-height: 18px; margin-top: 6px; padding-left: 24px; color: var(--chat-muted, var(--workbench-muted)); font-size: 12px; line-height: 1.5; }
.tool-step-exit { padding-left: 10px; border-left: 1px solid var(--chat-line, var(--workbench-line)); }
.tool-step-exit, .tool-step-duration { font-variant-numeric: tabular-nums; white-space: nowrap; }
.tool-step-duration { margin-left: auto; }
.tool-step-target { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 8px 12px; border-bottom: 1px solid var(--chat-line, var(--workbench-line)); color: var(--chat-muted, var(--workbench-muted)); font-size: 12px; line-height: 1.5; }
.tool-step-target .ui-icon { flex: none; }
.tool-step-target span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-step-body { border-top: 1px solid var(--chat-line, var(--workbench-line)); transform-origin: top center; animation: tool-step-reveal 150ms ease-out; }
.tool-step-risk-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 9px 12px 0; background: var(--chat-subtle, var(--workbench-panel)); font-size: 11px; line-height: 1.6; }
.tool-step-auto { color: var(--chat-muted, var(--workbench-muted)); }
.tool-step-risk { display: inline-flex; align-items: center; gap: 4px; color: var(--chat-warning, #996015); line-height: 1.4; }
.tool-step-risk .ui-icon { display: block; flex: 0 0 auto; margin-top: 1px; }
.tool-step-risk.is-high { color: var(--chat-danger, #c24150); }
.tool-step-output { border-top: 1px solid var(--chat-line, var(--workbench-line)); }
.tool-step-recovery, .tool-step-decision { padding: 10px 12px 12px; border-top: 1px solid var(--chat-line, var(--workbench-line)); }
.tool-step-failure-reason, .tool-step-timeout-hint { margin: 0 0 10px; font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.tool-step-failure-reason { color: var(--chat-muted, var(--workbench-muted)); }
.tool-step.is-error .tool-step-failure-reason { color: var(--chat-danger, #c24150); }
.tool-step-timeout-hint { color: var(--chat-muted, var(--workbench-muted)); }
.tool-step-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.tool-step-action { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-height: 29px; padding: 4px 8px; border: 1px solid var(--chat-line, var(--workbench-line)); border-radius: 5px; background: var(--chat-surface, var(--workbench-panel-strong)); color: var(--chat-text, var(--workbench-text)); font-size: 12px; line-height: 1.5; cursor: pointer; }
.tool-step-action.is-primary { background: var(--chat-button, var(--workbench-accent)); color: #fff; border-color: transparent; }
.tool-step-action.is-primary.is-risk { background: var(--chat-warning-button, #855b18); }
.tool-step-action:hover:not(:disabled) { filter: brightness(.95); }
.tool-step-action:disabled { opacity: .45; cursor: not-allowed; }
.tool-step-action:focus-visible, .tool-step-allow:focus-visible { outline: 2px solid var(--chat-accent, var(--workbench-accent)); outline-offset: 2px; }
.tool-step-action.is-icon { width: 29px; padding: 0; flex: 0 0 29px; }
.tool-step-copy-feedback { color: var(--chat-muted, var(--workbench-muted)); font-size: 11px; }
.tool-step-error-detail { margin: 10px 0 0; max-height: 180px; padding: 0 12px 12px 0; overflow: auto; scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--chat-muted, #8d98a5) 58%, transparent) transparent; scrollbar-gutter: stable; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.7 var(--font-mono, 'JetBrains Mono', Consolas, monospace); color: var(--chat-muted, var(--workbench-muted)); }
.tool-step-error-detail::-webkit-scrollbar { width: 10px; height: 10px; }
.tool-step-error-detail::-webkit-scrollbar-track { background: transparent; }
.tool-step-error-detail::-webkit-scrollbar-thumb { min-height: 32px; border: 3px solid transparent; border-radius: 999px; background: color-mix(in srgb, var(--chat-muted, #8d98a5) 58%, transparent); background-clip: padding-box; }
.tool-step-error-detail::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--chat-text, #22272d) 42%, transparent); background-clip: padding-box; }
.tool-step-error-detail::-webkit-scrollbar-corner { background: transparent; }
.tool-step-action.is-allow:not(:disabled) { color: var(--chat-accent, var(--workbench-accent)); border-color: var(--chat-accent, var(--workbench-accent)); }
.tool-step-allow { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 6px; max-width: 100%; margin-top: 10px; color: var(--chat-muted, var(--workbench-muted)); font-size: 12px; line-height: 1.7; }
.tool-step-allow code { min-width: 0; overflow-wrap: anywhere; padding: 0 5px; border: 1px solid var(--chat-line, var(--workbench-line)); border-radius: 4px; color: var(--chat-text, var(--workbench-text)); font: inherit; font-family: var(--font-mono, 'JetBrains Mono', Consolas, monospace); }
.tool-step-allow p { flex-basis: 100%; margin: 2px 0 0; }
.tool-step-allow-reason { margin: 10px 0 0; color: var(--chat-muted, var(--workbench-muted)); font-size: 12px; line-height: 1.7; }
@keyframes tool-step-spin { to { transform: rotate(360deg); } }
@keyframes tool-step-reveal { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
@media (prefers-reduced-motion: reduce) { .tool-step.is-running .tool-step-state-icon, .tool-step-body { animation: none; } }
</style>
