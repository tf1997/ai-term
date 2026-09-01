<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { AgentStep, AgentStepProposal, AgentTimeoutInfo } from '../types/agent'
import type { ScriptRiskMatch } from '../lib/scriptRisk'
import UiIcon from './UiIcon.vue'

// Agent 单步卡片:展示命令、理由、风险与执行结果,并在等待审批/超时决策时提供操作。
// 只负责呈现与事件外发,审批状态由 AiPanel 持有(见 docs/ai-agent-mode-development.md 6.4)。
// 倒计时同样只负责呈现:时钟由 AiPanel 统一驱动并经 nowMs 注入,避免每张卡各起一个定时器。

const props = defineProps<{
  step: AgentStep
  /** 该步骤正在等待人工审批。 */
  awaitingApproval?: boolean
  /** 该步骤正在等待超时决策。 */
  awaitingTimeout?: boolean
  /** 审批提案;提供「总是允许」所需的 pattern 列表。 */
  proposal?: AgentStepProposal
  /** 超时现场判断(静默时长、部分输出与启发说明)。 */
  timeoutInfo?: AgentTimeoutInfo
  /** AiPanel 的秒级时钟,仅用于倒计时渲染。 */
  nowMs?: number
  /** 高风险命令的二次确认已激活。 */
  highRiskArmed?: boolean
}>()

const emit = defineEmits<{
  execute: []
  reviewRisk: []
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
const hasRisk = computed(() => hasHighRisk.value || props.step.risks.length > 0 || props.step.sensitive)

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
  return hasRisk.value ? '查看风险' : '执行'
})

const allowPatterns = computed(() => props.proposal?.suggestedPatterns ?? [])

/**
 * 多段命令需要补齐每一段,标签只显示首项 + 总数,完整清单放 title。
 * 中文与 pattern 分开返回:pattern 要等宽(和终端里的命令观感一致),中文不能吃等宽——
 * 等宽栈里没有中文字形,中文会落到兜底脸上,与相邻按钮的字体和字号都对不上。
 */
const allowLabel = computed(() => {
  const patterns = allowPatterns.value
  if (!patterns.length) return null
  return {
    pattern: patterns[0],
    suffix: patterns.length === 1 ? '' : `等 ${patterns.length} 项`
  }
})

const allowTitle = computed(() => {
  const patterns = allowPatterns.value
  if (!patterns.length) return ''
  return `加入允许列表后自动执行:${patterns.join('、')}`
})

/**
 * 执行中的倒计时:距下一次超时询问还有多久。deadlineAt 由循环侧维护,
 * 「继续等待」会把它推后,因此这里天然表现为重新计时。
 */
const countdownLabel = computed(() => {
  if (props.step.status !== 'running') return ''
  const deadline = props.step.deadlineAt
  if (deadline === undefined || props.nowMs === undefined) return ''
  const remaining = deadline - props.nowMs
  if (remaining <= 0) return '即将询问'
  return `剩余 ${Math.ceil(remaining / 1000)}s`
})

const timeoutHint = computed(() => props.timeoutInfo?.hint ?? '')

const timeoutPartialOutput = computed(() => props.timeoutInfo?.partialOutput ?? '')

type ScrollTarget = 'command' | 'output' | 'preview'
type ScrollMetrics = { overflow: boolean; thumbWidth: number; thumbOffset: number }

const commandScroll = ref<HTMLElement | null>(null)
const outputScroll = ref<HTMLElement | null>(null)
const previewScroll = ref<HTMLElement | null>(null)
const commandScrollbar = ref<HTMLElement | null>(null)
const outputScrollbar = ref<HTMLElement | null>(null)
const previewScrollbar = ref<HTMLElement | null>(null)
const scrollMetrics = ref<Record<ScrollTarget, ScrollMetrics>>({
  command: { overflow: false, thumbWidth: 100, thumbOffset: 0 },
  output: { overflow: false, thumbWidth: 100, thumbOffset: 0 },
  preview: { overflow: false, thumbWidth: 100, thumbOffset: 0 }
})
let scrollResizeObserver: ResizeObserver | undefined
let stopScrollbarDrag: (() => void) | undefined

function scrollElement(target: ScrollTarget) {
  if (target === 'command') return commandScroll.value
  if (target === 'output') return outputScroll.value
  return previewScroll.value
}

function scrollbarElement(target: ScrollTarget) {
  if (target === 'command') return commandScrollbar.value
  if (target === 'output') return outputScrollbar.value
  return previewScrollbar.value
}

function updateScrollMetrics(target: ScrollTarget) {
  const element = scrollElement(target)
  const track = scrollbarElement(target)
  if (!element || !track) return
  const maxScroll = Math.max(0, element.scrollWidth - element.clientWidth)
  if (!maxScroll) {
    scrollMetrics.value = {
      ...scrollMetrics.value,
      [target]: { overflow: false, thumbWidth: 100, thumbOffset: 0 }
    }
    return
  }
  const trackWidth = Math.max(1, track.clientWidth)
  const thumbWidth = Math.max(12, (element.clientWidth / element.scrollWidth) * trackWidth)
  const maxThumbOffset = Math.max(0, trackWidth - thumbWidth)
  scrollMetrics.value = {
    ...scrollMetrics.value,
    [target]: {
      overflow: true,
      thumbWidth: (thumbWidth / trackWidth) * 100,
      thumbOffset: maxThumbOffset ? (element.scrollLeft / maxScroll) * (maxThumbOffset / trackWidth) * 100 : 0
    }
  }
}

function updateAllScrollMetrics() {
  updateScrollMetrics('command')
  updateScrollMetrics('output')
  updateScrollMetrics('preview')
}

function handleScroll(target: ScrollTarget) {
  updateScrollMetrics(target)
}

function startScrollbarDrag(target: ScrollTarget, event: PointerEvent) {
  const element = scrollElement(target)
  const track = scrollbarElement(target)
  if (!element || !track || !scrollMetrics.value[target].overflow) return
  event.preventDefault()
  const startX = event.clientX
  const startScrollLeft = element.scrollLeft
  const trackWidth = Math.max(1, track.clientWidth)
  const thumbWidth = (scrollMetrics.value[target].thumbWidth / 100) * trackWidth
  const scrollRange = Math.max(1, element.scrollWidth - element.clientWidth)
  const thumbRange = Math.max(1, trackWidth - thumbWidth)
  const move = (moveEvent: PointerEvent) => {
    element.scrollLeft = startScrollLeft + ((moveEvent.clientX - startX) / thumbRange) * scrollRange
    updateScrollMetrics(target)
  }
  const stop = () => {
    document.removeEventListener('pointermove', move)
    document.removeEventListener('pointerup', stop)
    document.removeEventListener('pointercancel', stop)
    stopScrollbarDrag = undefined
  }
  stopScrollbarDrag?.()
  stopScrollbarDrag = stop
  document.addEventListener('pointermove', move)
  document.addEventListener('pointerup', stop)
  document.addEventListener('pointercancel', stop)
}

const previewKind = ref<'command' | 'output' | null>(null)
const previewTitle = computed(() => previewKind.value === 'output' ? '输出详情' : '命令详情')
const previewContent = computed(() => {
  if (previewKind.value === 'output') return props.step.output || '（无输出）'
  return props.step.command
})

function openPreview(kind: 'command' | 'output') {
  previewKind.value = kind
}

function closePreview() {
  previewKind.value = null
}

watch(previewKind, () => {
  void nextTick(updateAllScrollMetrics)
})

onMounted(() => {
  void nextTick(updateAllScrollMetrics)
  if (typeof ResizeObserver !== 'undefined') {
    scrollResizeObserver = new ResizeObserver(updateAllScrollMetrics)
    ;[commandScroll.value, outputScroll.value, previewScroll.value].forEach((element) => {
      if (element) scrollResizeObserver?.observe(element)
    })
  }
})

onBeforeUnmount(() => {
  stopScrollbarDrag?.()
  scrollResizeObserver?.disconnect()
  scrollResizeObserver = undefined
})
</script>

<template>
  <article class="agent-step-card" :class="`agent-step-${step.status}`">
    <div class="agent-step-head">
      <span class="agent-step-status" :class="step.status">{{ statusLabel }}</span>
      <span v-if="step.autoApproved" class="chip agent-step-auto" title="通过只读判定或允许列表,已自动执行">自动执行</span>
      <span v-for="label in riskLabels" :key="label" class="chip agent-step-risk">{{ label }}</span>
      <span v-if="step.sensitive" class="chip agent-step-risk">敏感</span>
      <span v-if="step.exitCode !== undefined || durationLabel || countdownLabel" class="agent-step-meta">
        <span v-if="countdownLabel" class="agent-step-countdown" title="距下一次询问是否继续等待的剩余时间">{{ countdownLabel }}</span>
        <span v-if="step.exitCode !== undefined" class="agent-step-exit" :class="{ failed: step.exitCode !== 0 }">exit {{ step.exitCode }}</span>
        <span v-if="durationLabel" class="agent-step-duration">{{ durationLabel }}</span>
      </span>
    </div>

    <p v-if="step.reason" class="agent-step-reason">{{ step.reason }}</p>

    <div class="agent-step-code-block agent-step-command-block">
      <div class="agent-step-code-head">
        <span>命令</span>
        <button class="icon-button agent-step-expand" type="button" title="放大查看命令" aria-label="放大查看命令" @click="openPreview('command')">
          <UiIcon name="maximize" size="13" />
        </button>
      </div>
        <pre ref="commandScroll" class="agent-step-command" @scroll="handleScroll('command')"><code>{{ step.command }}</code></pre>
        <div
          ref="commandScrollbar"
          class="agent-step-scrollbar"
          :class="{ 'is-hidden': !scrollMetrics.command.overflow }"
          role="scrollbar"
          aria-label="命令横向滚动条"
          aria-orientation="horizontal"
          :aria-valuenow="Math.round(scrollMetrics.command.thumbOffset)"
          @pointerdown="startScrollbarDrag('command', $event)"
        >
          <span class="agent-step-scrollbar-thumb" :style="{ width: `${scrollMetrics.command.thumbWidth}%`, left: `${scrollMetrics.command.thumbOffset}%` }" />
        </div>
    </div>

    <div v-if="step.output || hasRun" class="agent-step-code-block agent-step-output-block">
      <div class="agent-step-code-head">
        <span>输出</span>
        <button v-if="step.output" class="icon-button agent-step-expand" type="button" title="放大查看输出" aria-label="放大查看输出" @click="openPreview('output')">
          <UiIcon name="maximize" size="13" />
        </button>
      </div>
      <pre v-if="step.output" ref="outputScroll" class="agent-step-output" @scroll="handleScroll('output')"><code>{{ step.output }}</code></pre>
      <div
        v-if="step.output"
        ref="outputScrollbar"
        class="agent-step-scrollbar"
        :class="{ 'is-hidden': !scrollMetrics.output.overflow }"
        role="scrollbar"
        aria-label="输出横向滚动条"
        aria-orientation="horizontal"
        :aria-valuenow="Math.round(scrollMetrics.output.thumbOffset)"
        @pointerdown="startScrollbarDrag('output', $event)"
      >
        <span class="agent-step-scrollbar-thumb" :style="{ width: `${scrollMetrics.output.thumbWidth}%`, left: `${scrollMetrics.output.thumbOffset}%` }" />
      </div>
      <p v-else class="agent-step-empty-output">（无输出）</p>
    </div>

    <div v-if="awaitingApproval" class="agent-step-actions">
      <button
        type="button"
        class="agent-action primary"
        :class="{ armed: hasHighRisk && highRiskArmed, 'agent-action-risk': hasRisk }"
        @click="hasRisk ? emit('reviewRisk') : emit('execute')"
      >{{ executeLabel }}</button>
      <button
        v-if="allowLabel"
        type="button"
        class="agent-action agent-action-allow"
        :title="allowTitle"
        @click="emit('executeAndAllow')"
      ><span class="agent-allow-lead">总是允许</span><code class="agent-allow-pattern">{{ allowLabel.pattern }}</code><span
        v-if="allowLabel.suffix"
        class="agent-allow-lead"
      >{{ allowLabel.suffix }}</span></button>
      <button type="button" class="agent-action" @click="emit('skip')">跳过</button>
      <button type="button" class="agent-action danger" @click="emit('stop')">停止</button>
    </div>

    <div v-if="awaitingTimeout" class="agent-step-actions">
      <p class="agent-step-timeout-note">{{ timeoutHint }}</p>
      <pre v-if="timeoutPartialOutput" class="agent-step-output agent-timeout-partial"><code>{{ timeoutPartialOutput }}</code></pre>
      <button type="button" class="agent-action primary" @click="emit('wait')">继续等待</button>
      <button type="button" class="agent-action danger" @click="emit('timeoutStop')">停止</button>
    </div>

    <div v-if="previewKind" class="modal-backdrop agent-step-preview-backdrop" role="presentation">
      <section class="modal agent-step-preview-modal" role="dialog" aria-modal="true" :aria-label="previewTitle">
        <div class="modal-head">
          <div>
            <strong>{{ previewTitle }}</strong>
            <span>只读查看完整内容</span>
          </div>
          <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="closePreview">
            <UiIcon name="close" />
          </button>
        </div>
        <pre ref="previewScroll" class="agent-step-preview-content" @scroll="handleScroll('preview')"><code>{{ previewContent }}</code></pre>
        <div
          ref="previewScrollbar"
          class="agent-step-scrollbar agent-step-preview-scrollbar"
          :class="{ 'is-hidden': !scrollMetrics.preview.overflow }"
          role="scrollbar"
          aria-label="详情横向滚动条"
          aria-orientation="horizontal"
          :aria-valuenow="Math.round(scrollMetrics.preview.thumbOffset)"
          @pointerdown="startScrollbarDrag('preview', $event)"
        >
          <span class="agent-step-scrollbar-thumb" :style="{ width: `${scrollMetrics.preview.thumbWidth}%`, left: `${scrollMetrics.preview.thumbOffset}%` }" />
        </div>
      </section>
    </div>
  </article>
</template>
