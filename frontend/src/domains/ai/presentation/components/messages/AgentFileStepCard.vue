<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AgentStep } from '../../../domain/agent'
import { fileProviderLabel } from '../../../../transfer/index'
import UiIcon from '../../../../../shared/ui/UiIcon.vue'
import AgentStepDetails from './AgentStepDetails.vue'

const props = defineProps<{ step: AgentStep; awaitingApproval?: boolean; approvalSaving?: boolean; nowMs?: number; targetLabel?: string; observationStopped?: boolean; canRetry?: boolean; retryDisabledReason?: string }>()
const emit = defineEmits<{ execute: []; skip: []; stop: []; retry: [] }>()
const expanded = ref(false)
const isDirectory = computed(() => props.step.toolName === 'list_directory')
const title = computed(() => props.step.reason || (isDirectory.value ? '列出目录' : '读取文件'))
const open = computed(() => expanded.value || props.awaitingApproval || props.step.status !== 'completed')
const provider = computed(() => props.step.fileProvider ? fileProviderLabel(props.step.fileProvider) : props.step.checkpointHistory ? '中断前读取记录' : '正在核对当前环境')
const path = computed(() => props.step.fileRequest?.path ?? props.step.checkpointHistory?.fileRead?.path)
const resolvedPath = computed(() => props.step.fileResolvedPath ?? props.step.checkpointHistory?.fileRead?.resolvedPath)
const result = computed(() => props.step.fileResult)
const status = computed(() => props.observationStopped && ['pending', 'running'].includes(props.step.status) ? '已取消读取' : { pending: '检查路径', running: '读取中', completed: '已读取', failed: '读取失败', skipped: '已跳过', timeout: '读取超时' }[props.step.status])
const range = computed(() => {
  const value = result.value
  if (!value) {
    const history = props.step.checkpointHistory?.fileRead
    if (history) return history.absent ? '当时已确认不存在，继续前需重新核对' : `${history.complete ? '当时完整读取' : '历史读取片段'}，不能作为当前版本`
    const request = props.step.fileRequest
    if (request?.tool === 'list_directory') return `最多 ${request.limit ?? 100} 项`
    if (request?.tool === 'read_file') return `${request.options?.tail ? '从末尾读取' : request.cursor ? '继续上一页' : `从第 ${request.options?.startLine ?? 1} 行读取`}，最多 ${request.options?.maxLines ?? 200} 行、${request.options?.maxBytes ?? 16384} 字节`
    return ''
  }
  if (value.redacted) return '敏感内容未保存'
  if (value.tool === 'list_directory') return `${value.entries.length} 项${value.truncation ? ' · 列表未完整返回' : ''}`
  const lines = value.start.line === null ? '' : `第 ${value.start.line} 行起${value.start.midLine ? '（行内续读）' : ''} · `
  return `${lines}${value.start.byte}–${value.end.byte} 字节 · ${value.complete ? '完整文件' : '文件片段'}`
})
const truncation = computed(() => result.value?.truncation ? { bytes: '达到本次字节上限', lines: '达到本次条目或行数上限', 'scan-budget': '达到扫描预算，请缩小范围或从末尾读取', 'tail-window': '只读取了末尾窗口' }[result.value.truncation] : '')
const detailInput = computed(() => [path.value, resolvedPath.value && resolvedPath.value !== path.value ? `实际路径：${resolvedPath.value}` : '', range.value].filter(Boolean).join('\n'))
</script>

<template>
  <article class="file-tool-step tool-step" :data-step-id="step.id" :data-tool="step.toolName" :data-status="step.status" :data-execution-phase="step.executionPhase">
    <button class="file-tool-heading" type="button" :aria-expanded="open" @click="expanded = !expanded">
      <UiIcon :name="step.status === 'failed' ? 'alert' : isDirectory ? 'folder' : 'file'" size="15" />
      <span>{{ title }}</span><small>{{ awaitingApproval ? '等待确认' : status }}</small><UiIcon :name="open ? 'arrow-up' : 'arrow-down'" size="13" />
    </button>
    <div v-if="open" class="file-tool-body">
      <p class="file-tool-target">{{ targetLabel }}<span v-if="targetLabel"> · </span>{{ provider }}</p>
      <code class="file-tool-path">{{ path }}</code>
      <p v-if="resolvedPath && resolvedPath !== path" class="file-tool-path">实际路径：{{ resolvedPath }}</p>
      <p>{{ range }}</p>
      <p v-if="truncation">{{ truncation }}</p>
      <p v-if="result?.changedDuringRead" class="file-tool-warning">读取期间文件发生变化，结果不能作为完整快照。</p>
      <p v-if="step.failureReason" class="file-tool-warning">{{ step.failureReason }}</p>
      <template v-if="awaitingApproval">
        <p class="file-tool-warning">此路径可能包含凭据。确认后，本次读取内容会提供给当前 AI 模型；敏感内容不会保存到会话历史。</p>
        <div class="file-tool-actions">
          <button type="button" :disabled="approvalSaving" @click="emit('execute')">仅允许本次读取</button>
          <button type="button" :disabled="approvalSaving" @click="emit('skip')">跳过</button>
          <button type="button" @click="emit('stop')">停止任务</button>
        </div>
      </template>
      <div v-if="step.status === 'failed'" class="file-tool-actions"><button type="button" :disabled="!canRetry" :title="retryDisabledReason" @click="emit('retry')">重新读取</button></div>
      <AgentStepDetails v-if="result || step.failureReason || step.checkpointHistory?.fileRead" :command="detailInput" :output="step.output" :failure-detail="step.failureReason" :target-label="targetLabel" input-label="路径和范围" details-title="文件读取结果" />
    </div>
  </article>
</template>

<style scoped>
.file-tool-step { min-width: 0; width: 100%; color: var(--chat-text); border: 1px solid var(--chat-line); border-radius: var(--ai-card-radius); background: var(--chat-surface); overflow: hidden; }
.file-tool-heading { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto 13px; align-items: start; gap: 8px; width: 100%; min-height: 36px; height: auto; padding: 10px var(--ai-card-inset); border: 0; background: transparent; text-align: left; color: inherit; white-space: normal; }
.file-tool-heading span { min-width: 0; overflow-wrap: anywhere; }
.file-tool-heading small, .file-tool-target { color: var(--chat-muted); font-size: var(--ai-font-ui); }
.file-tool-body { padding: 0 var(--ai-card-inset) 10px; min-width: 0; font-size: var(--ai-font-ui); line-height: var(--ai-leading-ui); }
.file-tool-body p { margin: 6px 0; overflow-wrap: anywhere; }
.file-tool-path { display: block; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--font-mono); }
.file-tool-warning { color: var(--chat-danger); }
.file-tool-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.file-tool-actions button { height: auto; min-height: 30px; padding: 5px 9px; border: 1px solid var(--chat-line); border-radius: 5px; color: var(--chat-text); background: var(--chat-elevated); }
.file-tool-actions button:disabled { color: var(--chat-disabled); cursor: not-allowed; }
.file-tool-heading:focus-visible, .file-tool-actions button:focus-visible { outline: 2px solid var(--chat-accent); outline-offset: -2px; }
</style>
