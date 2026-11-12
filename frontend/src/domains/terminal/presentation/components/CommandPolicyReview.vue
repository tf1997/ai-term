<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CommandReviewItem } from '../../application/useCommandPolicyReview'
import { commandPolicyRisks } from '../../../../shared/security/commandPolicyPresentation'
import UiIcon from '../../../../shared/ui/UiIcon.vue'

const props = defineProps<{ items: CommandReviewItem[]; note?: string }>()
const emit = defineEmits<{ resolve: [approved: boolean] }>()
const dialog = ref<HTMLElement | null>(null)
const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
const reviewed = ref(false)
const expanded = ref(new Set<string>())
const blocked = computed(() => props.items.some(item => item.intent.analysis.decision === 'deny'))
const reviewItems = computed(() => props.items.map(item => ({
  ...item,
  lines: item.intent.source.split('\n'),
  risks: commandPolicyRisks(item.intent),
  tone: item.intent.analysis.highestSeverity === 'high' || item.intent.analysis.decision === 'deny' ? 'high' : 'medium'
})))

watch(() => props.items, items => {
  reviewed.value = false
  // Short commands can be reviewed immediately; long scripts remain expandable in full.
  expanded.value = new Set(items.filter(item => item.intent.source.split('\n').length <= 8 && item.intent.source.length <= 1200).map(item => item.intent.reference.id))
}, { immediate: true })

async function showLine(id: string, line: number) {
  expanded.value.add(id)
  await nextTick()
  window.location.hash = `policy-${id}-${line}`
  document.getElementById(`policy-${id}-${line}`)?.scrollIntoView({ block: 'nearest' })
}
function sourceToggled(id: string, event: Event) {
  if ((event.target as HTMLDetailsElement).open) expanded.value.add(id)
  else expanded.value.delete(id)
}
function handleKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('resolve', false)
  } else if (event.key === 'Tab') {
    const controls = [...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input, summary, a[href], [tabindex="0"]') ?? [])]
      .filter(element => element.getClientRects().length > 0)
    const first = controls[0], last = controls[controls.length - 1]
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
}
onMounted(() => dialog.value?.focus({ preventScroll: true }))
onBeforeUnmount(() => { if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }) })
</script>

<template>
  <div class="policy-review-backdrop" role="presentation">
    <section ref="dialog" class="policy-review-dialog" role="dialog" tabindex="-1" aria-modal="true" :aria-label="blocked ? '命令已被阻止' : '执行前确认'" aria-describedby="policy-review-description" @keydown="handleKey">
      <header class="modal-header">
        <span class="policy-heading-icon" :class="{ 'is-blocked': blocked }"><UiIcon :name="blocked ? 'shield' : 'terminal'" size="20" /></span>
        <div class="policy-heading">
          <h2>{{ blocked ? '命令已被阻止' : '执行前确认' }}</h2>
          <p id="policy-review-description">{{ blocked ? '此命令不符合执行策略，无法继续。' : '请核对执行目标与命令，本次授权仅生效一次。' }}</p>
        </div>
        <button type="button" class="policy-close" aria-label="关闭" title="关闭（Esc）" @click="emit('resolve', false)"><UiIcon name="close" size="18" /></button>
      </header>

      <div class="policy-review-body">
        <p v-if="note" class="policy-note"><UiIcon name="info" size="15" /><span>{{ note }}</span></p>
        <article v-for="item in reviewItems" :key="item.intent.reference.id" class="policy-item">
          <div class="policy-target">
            <div class="policy-section-label">执行目标</div>
            <div class="policy-target-heading">
              <UiIcon name="terminal" size="16" />
              <strong>{{ item.label }}</strong>
              <span class="policy-operation">{{ item.intent.operation === 'bash-script' ? 'Bash 脚本' : '当前终端' }}</span>
            </div>
            <dl class="policy-context">
              <dt>用户</dt><dd>{{ item.intent.reference.target.context.user ?? '身份未确认' }}</dd>
              <dt>目录</dt><dd class="policy-directory">{{ item.intent.reference.target.context.workingDirectory ?? '目录未确认' }}</dd>
            </dl>
            <details class="policy-environment">
              <summary><UiIcon name="chevron-right" size="12" />环境详情</summary>
              <code>{{ item.intent.reference.target.context.environmentScope ?? '环境尚未确认' }}</code>
            </details>
          </div>

          <details class="policy-command" :open="expanded.has(item.intent.reference.id)" @toggle="sourceToggled(item.intent.reference.id, $event)">
            <summary>
              <UiIcon :name="item.intent.operation === 'bash-script' ? 'script' : 'terminal'" size="14" />
              <span>完整{{ item.intent.operation === 'bash-script' ? '脚本' : '命令' }}</span>
              <span class="policy-line-count">{{ item.lines.length }} 行</span>
              <UiIcon class="policy-source-chevron" name="chevron-right" size="14" />
            </summary>
            <pre class="policy-source" tabindex="0" :aria-label="item.intent.operation === 'bash-script' ? '完整脚本内容' : '完整命令内容'"><code><span v-for="(line, index) in item.lines" :id="`policy-${item.intent.reference.id}-${index + 1}`" :key="index" class="policy-source-line" :class="{ 'is-risk': item.risks.some(risk => risk.line === index + 1) }" :data-line="index + 1">{{ line }}{{ '\n' }}</span></code></pre>
          </details>

          <div class="policy-risk" :class="`is-${item.tone}`">
            <div class="policy-risk-heading">
              <UiIcon :name="item.intent.analysis.decision === 'deny' ? 'shield' : 'alert'" size="15" />
              <strong class="policy-summary">{{ item.intent.analysis.highestSeverity === 'high' ? '最高风险：高风险' : item.intent.analysis.highestSeverity === 'medium' ? '最高风险：中风险' : item.intent.analysis.analysisStatus === 'unknown' ? '风险尚未确认' : '无已识别风险' }}</strong>
              <span v-if="item.intent.analysis.risks.length" class="policy-risk-count">{{ item.intent.analysis.risks.length }} 处风险</span>
            </div>
            <p v-if="item.intent.analysis.analysisStatus === 'unknown'" class="policy-analysis-note">分析未完成，需逐次确认。</p>
            <ul v-if="item.risks.length" class="policy-risk-list">
              <li v-for="(risk, index) in item.risks" :key="index">
                <a :href="`#policy-${item.intent.reference.id}-${risk.line}`" :aria-label="`查看第 ${risk.line} 行：${risk.severity === 'high' ? '高风险' : '中风险'}，${risk.message}`" @click.prevent="showLine(item.intent.reference.id, risk.line)">第 {{ risk.line }} 行<UiIcon name="arrow-up" size="11" /></a>
                <span>{{ risk.message }}</span>
              </li>
            </ul>
          </div>
        </article>
      </div>

      <footer class="modal-footer">
        <label v-if="!blocked" class="policy-acknowledgement"><input v-model="reviewed" type="checkbox"><span>我已核对完整命令和执行目标</span></label>
        <div class="policy-actions">
          <button type="button" class="policy-cancel" @click="emit('resolve', false)">{{ blocked ? '关闭' : '取消' }}</button>
          <button v-if="!blocked" type="button" class="primary-button" :disabled="!reviewed" @click="emit('resolve', true)"><UiIcon name="play" size="14" />仅执行这一次</button>
        </div>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.policy-review-backdrop {
  --policy-surface: #15191f;
  --policy-subtle: #1b2027;
  --policy-line: #303741;
  --policy-text: #e6eaf0;
  --policy-muted: #9ca6b4;
  --policy-warning: #e5b567;
  --policy-warning-bg: #e5b5670d;
  --policy-danger: #f29b9b;
  --policy-danger-bg: #f29b9b0d;
  --policy-action-text: #09291a;
  position: fixed;
  inset: 0;
  z-index: 2201;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgb(8 12 20 / 48%);
}
:global(:root[data-theme="light"] .policy-review-backdrop),
:global(.theme-light .policy-review-backdrop) {
  --policy-surface: #fff;
  --policy-subtle: #f6f8fa;
  --policy-line: #e3e7ec;
  --policy-text: #202936;
  --policy-muted: #687384;
  --policy-warning: #996315;
  --policy-warning-bg: #fffbf2;
  --policy-danger: #bf4141;
  --policy-danger-bg: #fff6f5;
  --policy-action-text: #fff;
  background: rgb(24 34 48 / 28%);
}
.policy-review-dialog { width: min(620px, 100%); max-height: min(800px, calc(100dvh - 48px)); min-width: 0; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; overflow: hidden; border: 1px solid var(--policy-line); border-radius: 14px; background: var(--policy-surface); color: var(--policy-text); box-shadow: 0 24px 64px rgb(0 0 0 / 20%), 0 4px 16px rgb(0 0 0 / 8%); font-size: 13px; line-height: 1.6; }
.policy-review-dialog:focus { outline: none; }
.modal-header { display: flex; align-items: center; gap: 12px; padding: 22px 24px 20px; }
.policy-heading-icon { display: grid; place-items: center; width: 40px; height: 40px; flex: none; border: 1px solid var(--policy-line); border-radius: 11px; background: var(--policy-subtle); color: var(--policy-text); }
.policy-heading-icon.is-blocked { background: var(--policy-danger-bg); color: var(--policy-danger); }
.policy-heading { min-width: 0; flex: 1; }
.policy-heading h2 { margin: 0; font-size: 17px; line-height: 1.5; font-weight: 650; }
.policy-heading p { margin: 3px 0 0; font-size: 12px; color: var(--policy-muted); }
.policy-close { display: grid; place-items: center; align-self: flex-start; flex: none; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--policy-muted); }
.policy-close:hover { background: var(--policy-subtle); color: var(--policy-text); }
.policy-review-body { min-width: 0; min-height: 0; padding: 0 24px 22px; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; }
.policy-note { display: flex; align-items: flex-start; gap: 8px; margin: 0 0 16px; color: var(--policy-muted); overflow-wrap: anywhere; }
.policy-note .ui-icon { flex: none; margin-top: 3px; }
.policy-item { min-width: 0; display: grid; gap: 16px; overflow-wrap: anywhere; }
.policy-item + .policy-item { margin-top: 22px; padding-top: 22px; border-top: 1px solid var(--policy-line); }
.policy-section-label { margin-bottom: 7px; color: var(--policy-muted); font-size: 11px; font-weight: 500; }
.policy-target-heading { display: flex; align-items: center; gap: 8px; }
.policy-target-heading > .ui-icon { flex: none; color: var(--policy-muted); }
.policy-target-heading strong { min-width: 0; font-size: 13px; font-weight: 600; }
.policy-operation { flex: none; margin-left: auto; padding: 2px 7px; border-radius: 5px; background: var(--policy-subtle); color: var(--policy-muted); font-size: 11px; }
.policy-context { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 16px; margin: 12px 0 0; font-size: 12px; }
.policy-context dt { color: var(--policy-muted); }
.policy-context dd { margin: 0; user-select: text; }
.policy-directory { font-family: var(--font-mono); }
.policy-environment { margin-top: 8px; color: var(--policy-muted); font-size: 11px; }
.policy-environment summary { display: flex; align-items: center; gap: 4px; width: fit-content; cursor: pointer; }
.policy-environment code { display: block; margin-top: 6px; padding: 8px 10px; border-radius: 6px; background: var(--policy-subtle); color: inherit; font: 11px/1.6 var(--font-mono); user-select: text; }
summary::-webkit-details-marker { display: none; }
.policy-environment[open] > summary .ui-icon, .policy-command[open] .policy-source-chevron { transform: rotate(90deg); }
.policy-command { min-width: 0; overflow: hidden; border: 1px solid var(--policy-line); border-radius: 8px; background: var(--policy-subtle); }
.policy-command > summary { display: flex; align-items: center; gap: 7px; padding: 9px 12px; color: var(--policy-muted); cursor: pointer; font-size: 12px; }
.policy-command > summary > span:first-of-type { color: var(--policy-text); font-weight: 500; }
.policy-line-count { margin-left: auto; font-size: 11px; }
.policy-command[open] > summary { border-bottom: 1px solid var(--policy-line); }
.policy-source { max-height: 240px; margin: 0; padding: 12px 0; overflow: auto; scrollbar-width: thin; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; font: 12px/1.8 var(--font-mono); tab-size: 4; }
.policy-source code { color: inherit; font: inherit; }
.policy-source-line { display: block; position: relative; min-height: 1.8em; padding: 0 14px 0 46px; }
.policy-source-line::before { content: attr(data-line); position: absolute; left: 10px; width: 24px; text-align: right; color: var(--policy-muted); opacity: .7; user-select: none; }
.policy-source-line.is-risk { background: color-mix(in srgb, var(--policy-warning) 6%, transparent); }
.policy-source-line:target { background: color-mix(in srgb, var(--policy-warning) 18%, transparent); box-shadow: inset 2px 0 var(--policy-warning); }
.policy-risk { padding: 12px 14px; border: 1px solid color-mix(in srgb, var(--policy-warning) 20%, transparent); border-radius: 8px; background: var(--policy-warning-bg); color: var(--policy-warning); }
.policy-risk.is-high { border-color: color-mix(in srgb, var(--policy-danger) 20%, transparent); background: var(--policy-danger-bg); color: var(--policy-danger); }
.policy-risk-heading { display: flex; align-items: center; gap: 7px; }
.policy-risk-heading > .ui-icon { flex: none; }
.policy-summary { font-size: 12px; font-weight: 600; }
.policy-risk-count { margin-left: auto; font-size: 11px; }
.policy-analysis-note { margin: 6px 0 0; font-size: 12px; }
.policy-risk-list { display: grid; gap: 7px; margin: 8px 0 0; padding: 0; list-style: none; }
.policy-risk-list li { display: flex; align-items: baseline; gap: 10px; font-size: 12px; }
.policy-risk-list li > span { color: var(--policy-text); }
.policy-risk-list a { display: inline-flex; align-items: center; gap: 2px; flex: none; color: inherit; text-decoration: none; font-size: 11px; }
.policy-risk-list a:hover { text-decoration: underline; text-underline-offset: 3px; }
.modal-footer { display: grid; gap: 16px; padding: 16px 24px 20px; border-top: 1px solid var(--policy-line); background: var(--policy-surface); }
.policy-acknowledgement { display: flex; align-items: center; gap: 8px; width: fit-content; font-size: 12px; cursor: pointer; }
.policy-acknowledgement input { width: 15px; height: 15px; margin: 0; padding: 0; flex: none; accent-color: var(--workbench-accent); cursor: pointer; }
.policy-actions { display: flex; justify-content: flex-end; gap: 8px; }
.policy-actions button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; height: 34px; padding: 0 14px; font-size: 12px; font-weight: 500; border-radius: 7px; }
.policy-cancel { min-width: 76px; border: 1px solid var(--policy-line); background: var(--policy-surface); color: var(--policy-text); }
.policy-cancel:hover { border-color: var(--policy-muted); background: var(--policy-subtle); }
.primary-button { min-width: 144px; border: 1px solid transparent; background: var(--workbench-accent); color: var(--policy-action-text); }
.primary-button:hover:not(:disabled) { background: color-mix(in srgb, var(--workbench-accent) 86%, #000); }
.primary-button:disabled { opacity: 1; border-color: var(--policy-line); background: var(--policy-subtle); color: var(--policy-muted); }
.policy-review-dialog :is(button, input, summary, a):focus-visible { outline: 2px solid var(--workbench-accent); outline-offset: 3px; }
.policy-source:focus-visible { outline: 2px solid var(--workbench-accent); outline-offset: -2px; }
@media (max-width: 480px) {
  .policy-review-backdrop { padding: 12px; }
  .policy-review-dialog { max-height: calc(100dvh - 24px); border-radius: 12px; }
  .modal-header { align-items: flex-start; gap: 10px; padding: 18px 16px; }
  .policy-heading-icon { width: 34px; height: 34px; border-radius: 9px; }
  .policy-heading h2 { font-size: 16px; }
  .policy-review-body { padding: 0 16px 18px; }
  .policy-target-heading { flex-wrap: wrap; }
  .policy-target-heading strong { flex: 1; }
  .policy-operation { margin-left: 24px; }
  .modal-footer { padding: 14px 16px 16px; }
  .policy-actions .primary-button { flex: 1; }
}
</style>
