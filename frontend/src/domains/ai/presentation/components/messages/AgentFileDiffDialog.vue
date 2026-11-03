<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { AgentFileDiff } from '../../../domain/agentFileDiff'
import { agentDiffText } from '../../../domain/agentFileDiff'
import UiIcon from '../../../../../shared/ui/UiIcon.vue'
import { useCopyFeedback } from './useCopyFeedback'

const props = defineProps<{ diff: AgentFileDiff; trigger: HTMLElement | null }>()
const emit = defineEmits<{ close: []; inspect: [stepId: string] }>()
const dialog = ref<HTMLElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)
const limit = ref(400)
const { copyFeedback, copyText } = useCopyFeedback()
const theme = computed(() => {
  if (!props.trigger) return {}
  const style = getComputedStyle(props.trigger)
  return Object.fromEntries(['--chat-text', '--chat-muted', '--chat-surface', '--chat-elevated', '--chat-line', '--chat-accent', '--chat-hover', '--chat-danger', '--font-mono'].map(token => [token, style.getPropertyValue(token).trim()]))
})
const rows = computed(() => (props.diff.patch?.hunks ?? []).flatMap(hunk => {
  let oldLine = hunk.oldStart, newLine = hunk.newStart
  return [
    { kind: 'hunk', oldLine: '', newLine: '', sign: '', text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` },
    ...hunk.lines.map(line => {
      const sign = line[0]
      const kind = sign === '+' ? 'add' : sign === '-' ? 'remove' : sign === '\\' ? 'note' : 'context'
      return {
        kind, sign: kind === 'note' ? '' : sign,
        oldLine: kind === 'remove' || kind === 'context' ? String(oldLine++) : '',
        newLine: kind === 'add' || kind === 'context' ? String(newLine++) : '',
        text: kind === 'note' ? '文件末尾无换行' : line.slice(1)
      }
    })
  ]
}))
const statusText = computed(() => ({ added: '新建文件', deleted: '删除文件', modified: '修改文件', unchanged: '无净变更', unavailable: '无法比较' }[props.diff.status]))
function close() { emit('close') }
function inspect() {
  const stepId = props.diff.change.stepIds[props.diff.change.stepIds.length - 1]
  close()
  if (stepId) emit('inspect', stepId)
}
function handleKey(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
  else if (event.key === 'Tab') {
    const elements = [...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? [])]
    const first = elements[0], last = elements[elements.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
}
onMounted(async () => { await nextTick(); closeButton.value?.focus({ preventScroll: true }) })
onBeforeUnmount(() => { if (props.trigger?.isConnected) props.trigger.focus({ preventScroll: true }) })
</script>

<template>
  <Teleport to="body">
    <div class="agent-diff-backdrop" :style="theme" @click.self="close">
      <section ref="dialog" class="agent-diff-dialog" role="dialog" aria-modal="true" aria-label="文件变更" @keydown="handleKey">
        <header class="agent-diff-head">
          <div><strong>文件变更</strong><p>{{ diff.change.path }}</p></div>
          <button ref="closeButton" class="agent-diff-icon" type="button" aria-label="关闭" @click="close"><UiIcon name="close" size="16" /></button>
        </header>
        <div class="agent-diff-toolbar">
          <span>{{ statusText }}</span>
          <span v-if="diff.additions !== undefined" class="agent-diff-stats"><span class="is-add">+{{ diff.additions }}</span><span class="is-remove">−{{ diff.deletions }}</span></span>
          <span class="agent-diff-copy-feedback" role="status">{{ copyFeedback }}</span>
          <button v-if="diff.patch" class="agent-diff-action" type="button" @click="copyText(agentDiffText(diff))"><UiIcon name="copy" size="13" />复制差异</button>
        </div>
        <div class="agent-diff-body" tabindex="0" aria-label="逐行差异">
          <table v-if="rows.length" class="agent-diff-lines" aria-label="修改前后逐行对比">
            <thead><tr><th scope="col">原行</th><th scope="col">新行</th><th scope="col" colspan="2">内容</th></tr></thead>
            <tbody><tr v-for="(row, index) in rows.slice(0, limit)" :key="index" :class="`diff-${row.kind}`">
              <td class="diff-line-number">{{ row.oldLine }}</td><td class="diff-line-number">{{ row.newLine }}</td><td class="diff-sign">{{ row.sign }}</td><td class="diff-code">{{ row.text }}</td>
            </tr></tbody>
          </table>
          <p v-else class="agent-diff-empty">{{ diff.reason || (diff.status === 'unchanged' ? '文件内容与本任务首次修改前相同。' : diff.status === 'added' ? '新建了空文件。' : '删除了空文件。') }}</p>
          <button v-if="rows.length > limit" class="agent-diff-more" type="button" @click="limit += 400">继续显示（{{ limit }} / {{ rows.length }} 行）</button>
        </div>
        <footer class="agent-diff-footer"><span>相对本任务首次修改前的文件内容</span><button v-if="diff.change.stepIds.length" class="agent-diff-action" type="button" @click="inspect">查看执行记录<UiIcon name="chevron-right" size="12" /></button></footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.agent-diff-backdrop { position: fixed; z-index: 2200; inset: 0; display: grid; place-items: center; padding: 24px; background: #0007; }
.agent-diff-dialog { display: flex; flex-direction: column; width: min(900px, 100%); max-height: min(820px, calc(100dvh - 48px)); min-width: 0; overflow: hidden; border: 1px solid var(--chat-line); border-radius: var(--ai-card-radius); background: var(--chat-surface); color: var(--chat-text); box-shadow: 0 20px 70px #0004; }
.agent-diff-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--chat-line); }
.agent-diff-head > div { min-width: 0; }
.agent-diff-head strong { font-size: var(--ai-font-heading); font-weight: var(--ai-weight-strong); line-height: var(--ai-leading-heading); }
.agent-diff-head p { margin: 4px 0 0; color: var(--chat-muted); font: var(--ai-font-ui)/var(--ai-leading-ui) var(--font-mono); overflow-wrap: anywhere; }
.agent-diff-icon { display: inline-grid; place-items: center; flex: 0 0 28px; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 4px; color: var(--chat-muted); background: transparent; }
.agent-diff-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 8px 16px; color: var(--chat-muted); font-size: var(--ai-font-ui); line-height: var(--ai-leading-ui); }
.agent-diff-stats { display: inline-flex; gap: 6px; font-variant-numeric: tabular-nums; }
.is-add { color: var(--chat-accent); }.is-remove { color: var(--chat-danger); }
.agent-diff-copy-feedback { margin-left: auto; }
.agent-diff-action { display: inline-flex; align-items: center; flex: none; gap: 5px; padding: 4px 6px; min-height: 26px; border: 0; border-radius: 4px; background: transparent; color: var(--chat-muted); font-size: var(--ai-font-ui); cursor: pointer; line-height: var(--ai-leading-ui); }
.agent-diff-icon:hover, .agent-diff-action:hover, .agent-diff-more:hover { background: var(--chat-hover); color: var(--chat-text); }
.agent-diff-body { overflow: auto; min-height: 0; overscroll-behavior: contain; scrollbar-width: thin; }
.agent-diff-lines { border-collapse: collapse; width: 100%; font: var(--ai-font-ui)/var(--ai-leading-ui) var(--font-mono); white-space: pre; tab-size: 4; }
.agent-diff-lines th { color: var(--chat-muted); font: var(--ai-font-ui)/var(--ai-leading-ui) var(--font-sans); font-weight: var(--ai-weight-medium); text-align: left; padding: 0 8px; border-bottom: 1px solid var(--chat-line); }
.agent-diff-lines td { border: 0; padding: 0; height: var(--ai-leading-ui); vertical-align: top; }
.agent-diff-lines .diff-line-number { width: 1%; min-width: 36px; padding: 0 6px; text-align: right; color: var(--chat-muted); font-size: var(--ai-font-caption); user-select: none; border-right: 1px solid var(--chat-line); line-height: var(--ai-leading-ui); }
.agent-diff-lines .diff-sign { width: 1%; padding: 0 7px; user-select: none; }
.agent-diff-lines .diff-code { padding-right: 16px; }
.diff-add { background: color-mix(in srgb, var(--chat-accent) 10%, transparent); }.diff-add .diff-sign { color: var(--chat-accent); }
.diff-remove { background: color-mix(in srgb, var(--chat-danger) 10%, transparent); }.diff-remove .diff-sign { color: var(--chat-danger); }
.diff-hunk { color: var(--chat-muted); background: var(--chat-elevated); }.diff-hunk .diff-code { padding-block: 6px; }
.diff-note { color: var(--chat-muted); font-size: var(--ai-font-ui); line-height: var(--ai-leading-ui); }
.agent-diff-empty { margin: 0; padding: 24px 16px; color: var(--chat-muted); font-size: var(--ai-font-ui); line-height: var(--ai-leading-ui); }
.agent-diff-more { margin: 8px 16px; padding: 5px 8px; border: 1px solid var(--chat-line); border-radius: 4px; background: transparent; color: var(--chat-muted); font-size: var(--ai-font-ui); line-height: var(--ai-leading-ui); }
.agent-diff-footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding: 8px 16px; border-top: 1px solid var(--chat-line); font-size: var(--ai-font-ui); color: var(--chat-muted); line-height: var(--ai-leading-ui); }
.agent-diff-dialog button:focus-visible, .agent-diff-body:focus-visible { outline: 2px solid var(--chat-accent); outline-offset: -2px; }
@media (max-width: 480px) { .agent-diff-backdrop { padding: 12px; }.agent-diff-dialog { max-height: calc(100dvh - 24px); } }
</style>
