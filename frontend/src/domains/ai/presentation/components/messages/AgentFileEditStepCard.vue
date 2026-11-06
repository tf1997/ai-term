<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AgentStep } from '../../../domain/agent'
import { agentFileDiff, agentDiffText } from '../../../domain/agentFileDiff'
import { fileProviderLabel, fileEditStatusLabel } from '../../../../transfer/index'
import UiIcon from '../../../../../shared/ui/UiIcon.vue'

const props = defineProps<{ step: AgentStep; awaitingApproval?: boolean; approvalSaving?: boolean; targetLabel?: string; observationStopped?: boolean; canRestore?: boolean }>()
const emit = defineEmits<{ execute: []; skip: []; stop: []; restore: [changeId: string, path: string] }>()
const expanded = ref(false)
const open = computed(() => expanded.value || props.awaitingApproval || props.step.status !== 'completed')
const items = computed(() => (props.step.fileEdits ?? []).map(item => {
  const view = item.view
  const diff = view && !view.redacted ? agentFileDiff({ path: view.resolvedPath, requestedPaths: [view.path], scope: view.environmentScope, before: view.before === null ? { state: 'missing' } : { state: 'text', content: view.before }, after: view.after === null ? { state: 'missing' } : { state: 'text', content: view.after }, stepIds: [props.step.id] }) : undefined
  return { ...item, diff, patch: diff ? agentDiffText(diff) : '' }
}))
const status = computed(() => {
  const applied = items.value.filter(item => item.status === 'applied').length
  if (props.awaitingApproval) return '等待确认'
  if (items.value.some(item => item.status === 'unknown' || item.status === 'dispatching' && props.observationStopped)) return `${applied} 项已写入 · 存在未知结果`
  if (props.step.status === 'running') return `写入中 · ${applied} / ${items.value.length}`
  if (applied === items.value.length && applied) return `${applied} 项已写入并核对`
  if (applied) return `${applied} / ${items.value.length} 项已写入`
  return props.step.status === 'skipped' ? '已跳过' : props.step.status === 'failed' ? '修改未完成' : props.observationStopped ? '未开始' : '准备差异'
})
</script>

<template>
  <article class="file-edit-step tool-step" :data-step-id="step.id" :data-tool="step.toolName" :data-status="step.status" :data-execution-phase="step.executionPhase">
    <button type="button" class="file-edit-heading" :aria-expanded="open" @click="expanded = !expanded">
      <UiIcon :name="step.status === 'failed' ? 'alert' : 'file'" size="15" /><span>{{ step.reason }}</span><small>{{ status }}</small><UiIcon :name="open ? 'arrow-up' : 'arrow-down'" size="13" />
    </button>
    <div v-if="open" class="file-edit-body">
      <p class="file-edit-muted">{{ targetLabel }}</p>
      <section v-for="(item, index) in items" :key="index" class="file-edit-item" :data-edit-status="item.status">
        <header><strong>{{ item.view?.path || item.historyPath || `文件 ${index + 1}` }}</strong><span>{{ fileEditStatusLabel(item.status) }}</span></header>
        <p v-if="!item.view && item.changeId" class="file-edit-muted">已保存变更 {{ item.changeId }}；后续修改需重新读取。</p>
        <template v-if="item.view">
          <p class="file-edit-muted">{{ fileProviderLabel(item.view.provider) }}<template v-if="item.view.target?.context.user"> · 用户 {{ item.view.target.context.user }}</template></p>
          <p v-if="item.view.path !== item.view.resolvedPath">实际路径：<code>{{ item.view.resolvedPath }}</code></p>
          <p v-if="item.view.writeStrategy === 'in-place'" class="file-edit-warning">原位写入；中断可能留下部分内容。</p>
          <p v-if="item.view.writeStrategy === 'delete'" class="file-edit-warning">将删除此文件。</p>
          <p v-if="item.view.sensitive" class="file-edit-warning">敏感内容不会保存到会话和恢复记录。</p>
          <p v-if="item.view.redacted" class="file-edit-muted">敏感文件差异未保存。</p>
          <template v-else>
            <p v-if="item.diff?.additions !== undefined" class="file-edit-count"><span>+{{ item.diff.additions }}</span><span>−{{ item.diff.deletions }}</span></p>
            <pre v-if="item.patch" class="file-edit-patch" tabindex="0" aria-label="拟议文件差异">{{ item.patch }}</pre>
            <template v-else-if="item.diff?.status === 'unavailable'">
              <p>{{ item.diff.reason }}；以下展示完整修改前后内容。</p>
              <label>修改前<pre class="file-edit-patch" tabindex="0">{{ item.view.before ?? '[文件不存在]' }}</pre></label>
              <label>修改后<pre class="file-edit-patch" tabindex="0">{{ item.view.after ?? '[删除文件]' }}</pre></label>
            </template>
            <p v-else>{{ item.view.before === null ? '新建空文件' : item.view.after === null ? '删除空文件' : '内容未变化' }}</p>
          </template>
          <p v-if="item.view.restoreAttributes" class="file-edit-muted">恢复权限 {{ item.view.restoreAttributes.mode.toString(8) }} · UID {{ item.view.restoreAttributes.uid }} · GID {{ item.view.restoreAttributes.gid }}</p>
        </template>
        <p v-if="item.error" class="file-edit-warning">{{ item.error }}</p>
        <button v-if="item.status === 'applied' && item.changeId && item.view && !item.view.sensitive && (item.view.writeStrategy !== 'delete' || item.outcome?.beforeAttributes?.extendedMetadata === false || Boolean(item.outcome?.beforeAttributes?.metadataBackup))" type="button" class="file-edit-action" :disabled="!canRestore" title="重新读取并核对文件后，展示恢复差异供确认" @click="emit('restore', item.changeId, item.view.path)">恢复这次修改</button>
        <p v-else-if="item.status === 'applied' && item.view?.writeStrategy === 'delete'" class="file-edit-muted">删除前的扩展权限或属性未完整备份，此记录不支持自动恢复。</p>
      </section>
      <p v-if="step.failureReason" class="file-edit-warning">{{ step.failureReason }}</p>
      <div v-if="awaitingApproval" class="file-edit-actions">
        <button type="button" class="file-edit-action is-primary" :disabled="approvalSaving" @click="emit('execute')">{{ approvalSaving ? '保存审批中…' : '仅应用本次差异' }}</button>
        <button type="button" class="file-edit-action" :disabled="approvalSaving" @click="emit('skip')">跳过</button>
        <button type="button" class="file-edit-action" @click="emit('stop')">停止任务</button>
      </div>
      <div v-else-if="step.status === 'running' && !observationStopped" class="file-edit-actions"><button type="button" class="file-edit-action" @click="emit('stop')">停止观察写入</button></div>
    </div>
  </article>
</template>

<style scoped>
.file-edit-step { width: 100%; min-width: 0; border: 1px solid var(--chat-line); border-radius: var(--ai-card-radius); color: var(--chat-text); background: var(--chat-surface); overflow: hidden; }
.file-edit-heading { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto 13px; align-items: start; gap: 8px; width: 100%; height: auto; min-height: 36px; padding: 10px var(--ai-card-inset); border: 0; color: inherit; background: transparent; text-align: left; white-space: normal; }
.file-edit-heading span { min-width: 0; overflow-wrap: anywhere; }
.file-edit-heading small, .file-edit-muted { color: var(--chat-muted); font-size: var(--ai-font-ui); }
.file-edit-body { padding: 0 var(--ai-card-inset) 10px; min-width: 0; font-size: var(--ai-font-ui); line-height: var(--ai-leading-ui); }
.file-edit-body p { margin: 7px 0; overflow-wrap: anywhere; }
.file-edit-item { padding: 10px 0; border-top: 1px solid var(--chat-line); min-width: 0; }
.file-edit-item header { display: flex; flex-wrap: wrap; gap: 5px 10px; align-items: baseline; }
.file-edit-item strong { flex: 1; min-width: 0; overflow-wrap: anywhere; font-weight: var(--ai-weight-medium); }
.file-edit-item header span { color: var(--chat-muted); }
.file-edit-warning { color: var(--chat-danger); }
.file-edit-count { display: flex; gap: 12px; font-family: var(--font-mono); }
.file-edit-count span:first-child { color: var(--chat-accent); }.file-edit-count span:last-child { color: var(--chat-danger); }
.file-edit-patch { max-width: 100%; max-height: 320px; margin: 8px 0; padding: 10px; overflow: auto; border: 1px solid var(--chat-line); border-radius: 4px; background: var(--chat-elevated); font: var(--ai-font-ui)/1.6 var(--font-mono); white-space: pre; tab-size: 4; }
.file-edit-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
.file-edit-action { height: auto; min-height: 30px; padding: 5px 9px; border: 1px solid var(--chat-line); border-radius: 5px; color: var(--chat-text); background: var(--chat-elevated); }
.file-edit-action.is-primary { color: var(--workbench-action-text); background: var(--workbench-action-bg); border-color: var(--workbench-action-border); }
.file-edit-action:disabled { color: var(--chat-disabled); cursor: not-allowed; }
.file-edit-action:focus-visible, .file-edit-heading:focus-visible, .file-edit-patch:focus-visible { outline: 2px solid var(--chat-accent); outline-offset: -2px; }
</style>
