<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import type { AgentStep } from '../../../domain/agent'
import { agentFileReferences } from '../../../domain/agentFiles'
import type { AgentFileChange } from '../../../domain/agentFileSnapshots'
import { agentFileDiff } from '../../../domain/agentFileDiff'
import type { AgentFileDiff } from '../../../domain/agentFileDiff'
import AgentFileDiffDialog from './AgentFileDiffDialog.vue'
import UiIcon from '../../../../../shared/ui/UiIcon.vue'

const props = defineProps<{ steps?: AgentStep[]; changes?: AgentFileChange[] }>()
const emit = defineEmits<{ inspect: [stepId: string] }>()
const diffs = computed(() => (props.changes ?? []).map(agentFileDiff))
const files = computed(() => [
  ...diffs.value.map(diff => ({ path: diff.change.path, stepIds: diff.change.stepIds, uncertain: diff.status === 'unavailable', diff })),
  ...agentFileReferences(props.steps).filter(file => !diffs.value.some(diff => diff.change.requestedPaths.includes(file.path) && file.stepIds.every(id => diff.change.stepIds.includes(id)))).map(file => ({ ...file, diff: undefined }))
])
const totals = computed(() => diffs.value.reduce((total, diff) => ({ additions: total.additions + (diff.additions ?? 0), deletions: total.deletions + (diff.deletions ?? 0), known: total.known + Number(diff.status !== 'unavailable') }), { additions: 0, deletions: 0, known: 0 }))
const unknownCount = computed(() => files.value.filter(file => !file.diff || file.diff.status === 'unavailable').length)
const selected = shallowRef<AgentFileDiff>()
const trigger = shallowRef<HTMLElement | null>(null)
function inspect(file: typeof files.value[number], event: MouseEvent) {
  if (file.diff) { trigger.value = event.currentTarget as HTMLElement; selected.value = file.diff }
  else { const id = file.stepIds[file.stepIds.length - 1]; if (id) emit('inspect', id) }
}
function statusText(diff: AgentFileDiff) { return { added: '新建', deleted: '删除', modified: '', unchanged: '无净变更', unavailable: '无法比较' }[diff.status] }
const expanded = ref(false)
const visibleFiles = computed(() => expanded.value ? files.value : files.value.slice(0, 5))
function basename(path: string) { return path.split(/[\\/]/).pop() || path }
function directory(path: string) { return path.slice(0, -basename(path).length) }
</script>

<template>
  <section v-if="files.length" class="agent-file-changes" aria-label="涉及的文件">
    <header><UiIcon name="file" size="16" /><strong>涉及 {{ files.length }} 个文件</strong><span v-if="totals.known" class="agent-files-stats"><span class="is-add">+{{ totals.additions }}</span><span class="is-remove">−{{ totals.deletions }}</span></span></header>
    <p class="agent-files-note">{{ totals.known ? '本任务净变更，点击文件查看差异。' : '未记录完整快照，点击查看详情。' }}<span v-if="totals.known && unknownCount">{{ unknownCount }} 个文件未计入统计。</span></p>
    <div class="agent-file-list">
      <button v-for="file in visibleFiles" :key="`${file.path}:${file.stepIds[0]}`" class="agent-file-row" type="button" :title="`${file.path} · ${file.diff ? '查看文件差异' : '查看关联执行记录'}`" @click="inspect(file, $event)">
        <span class="agent-file-path"><span>{{ basename(file.path) }}</span><small v-if="directory(file.path)">{{ directory(file.path) }}</small></span>
        <template v-if="file.diff"><span v-if="statusText(file.diff)" class="agent-file-count">{{ statusText(file.diff) }}</span><span v-if="file.diff.additions !== undefined && file.diff.status !== 'unchanged'" class="agent-files-stats"><span class="is-add">+{{ file.diff.additions }}</span><span class="is-remove">−{{ file.diff.deletions }}</span></span></template>
        <span v-else-if="file.uncertain" class="agent-file-uncertain">待核实</span>
        <span v-else-if="file.stepIds.length > 1" class="agent-file-count">{{ file.stepIds.length }} 条记录</span>
        <UiIcon name="chevron-right" size="13" />
      </button>
    </div>
    <button v-if="files.length > 5" class="agent-files-more" type="button" :aria-expanded="expanded" @click="expanded = !expanded">{{ expanded ? '收起文件列表' : `查看全部 ${files.length} 个文件` }}<UiIcon :name="expanded ? 'arrow-up' : 'arrow-down'" size="12" /></button>
  </section>
  <AgentFileDiffDialog v-if="selected" :diff="selected" :trigger="trigger" @close="selected = undefined" @inspect="emit('inspect', $event)" />
</template>

<style scoped>
.agent-file-changes { min-width: 0; border: 1px solid var(--chat-line); border-radius: var(--ai-card-radius); overflow: hidden; }
.agent-file-changes > header { display: flex; align-items: center; gap: 8px; padding: var(--ai-card-gap) var(--ai-card-inset) 0; color: var(--chat-text); font-size: var(--ai-font-body); line-height: var(--ai-leading-body); }
.agent-file-changes > header .ui-icon { flex: none; color: var(--chat-muted); }
.agent-file-changes > header strong { font-weight: var(--ai-weight-medium); }
.agent-file-changes > header .agent-files-stats { margin-left: auto; }
.agent-files-stats { display: inline-flex; flex: none; gap: 5px; font-size: var(--ai-font-caption); font-variant-numeric: tabular-nums; white-space: nowrap; line-height: var(--ai-leading-ui); }
.is-add { color: var(--chat-accent); }.is-remove { color: var(--chat-danger); }
.agent-files-note { margin: 4px var(--ai-card-inset) 8px; font-size: var(--ai-font-ui); line-height: var(--ai-leading-ui); color: var(--chat-muted); }
.agent-file-list { border-top: 1px solid var(--chat-line); }
.agent-file-row { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; height: auto; padding: 8px var(--ai-card-inset); border: 0; border-radius: 0; background: transparent; color: var(--chat-text); text-align: left; font-size: var(--ai-font-ui); font-weight: var(--ai-weight-normal); line-height: var(--ai-leading-ui); cursor: pointer; }
.agent-file-row + .agent-file-row { border-top: 1px solid var(--chat-line); }
.agent-file-row:hover:not(:disabled) { background: var(--chat-hover); color: var(--chat-text); }
.agent-file-row:focus-visible, .agent-files-more:focus-visible { outline: 2px solid var(--chat-accent); outline-offset: -2px; }
.agent-file-path { display: grid; flex: 1; min-width: 0; }
.agent-file-path > span, .agent-file-path > small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-file-path small { font-size: var(--ai-font-ui); color: var(--chat-muted); line-height: var(--ai-leading-ui); }
.agent-file-row > .ui-icon { flex: none; color: var(--chat-muted); }
.agent-file-uncertain { flex: none; font-size: var(--ai-font-ui); color: var(--chat-warning); white-space: nowrap; line-height: var(--ai-leading-ui); }
.agent-file-count { flex: none; font-size: var(--ai-font-caption); color: var(--chat-muted); white-space: nowrap; line-height: var(--ai-leading-ui); }
.agent-files-more { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; min-height: 30px; padding: 4px var(--ai-card-inset); border: 0; border-top: 1px solid var(--chat-line); border-radius: 0; background: transparent; color: var(--chat-muted); font-size: var(--ai-font-ui); cursor: pointer; line-height: var(--ai-leading-ui); }
.agent-files-more:hover:not(:disabled) { background: var(--chat-hover); color: var(--chat-text); }
</style>
