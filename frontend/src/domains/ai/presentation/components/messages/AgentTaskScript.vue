<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { TaskScriptSource, TaskScriptDraft } from '../../../../scripts/types'
import { createTaskScriptDraft, taskScriptCandidates, taskScriptEnvironmentKey } from '../../../../scripts/index'
const props = defineProps<{ source: TaskScriptSource }>()
const emit = defineEmits<{ create: [draft: TaskScriptDraft]; close: [] }>()
const selectedScope = ref(''), selectedIds = ref<string[]>([])
const fileActions = { create: '新建', replace: '修改', delete: '删除', verify: '核验' }
const candidates = computed(() => taskScriptCandidates(props.source))
const scopes = computed(() => [...new Map(candidates.value.filter(item => item.eligible).map(({ step }) => [taskScriptEnvironmentKey(step.environment!), step.environment!])).entries()])
watch(() => props.source, () => { selectedScope.value = scopes.value[0]?.[0] ?? '' }, { immediate: true })
watch(selectedScope, () => { selectedIds.value = candidates.value.filter(item => item.eligible && taskScriptEnvironmentKey(item.step.environment!) === selectedScope.value).slice(0, 64).map(item => item.step.id) }, { immediate: true })
const result = computed(() => {
  try { return { draft: createTaskScriptDraft(props.source, selectedIds.value), error: '' } }
  catch (error) { return { draft: undefined, error: error instanceof Error ? error.message : String(error) } }
})
</script>
<template>
  <section class="agent-task-script" aria-label="选择任务脚本步骤">
    <strong>整理为脚本草稿</strong>
    <label v-if="scopes.length">目标范围<select v-model="selectedScope"><option v-for="[key, scope] in scopes" :key="key" :value="key">{{ scope.profileId }} · {{ scope.user }} · {{ scope.environmentScope }}</option></select></label>
    <p>按原顺序整理成功命令和文件变更，目录、服务名和文件路径可填写参数。文件写入先检查基线；命令凭据通过目标环境变量提供，敏感文件内容通过外部文件提供。</p>
    <label v-for="item in candidates" :key="item.step.id" class="task-script-choice">
      <input v-model="selectedIds" type="checkbox" :value="item.step.id" :disabled="!item.eligible || taskScriptEnvironmentKey(item.step.environment!) !== selectedScope" />
      <span><code>{{ item.step.fileChanges?.length ? item.step.fileChanges.map(file => `${fileActions[file.action]} ${file.path}`).join('\n') : item.step.sensitive ? '敏感步骤' : item.step.command || item.step.tool }}</code><small v-if="item.step.fileChanges?.some(file => file.externalContent)">内容需通过外部输入文件提供，不复制进草稿。</small><small v-if="item.step.commandSource?.secrets.length">凭据需通过目标环境变量提供，不复制历史值。</small><small v-if="item.reason">{{ item.reason }}</small></span>
    </label>
    <p v-if="result.error" role="status">{{ result.error }}</p>
    <p v-if="result.draft">{{ selectedIds.length }} 个步骤 · {{ result.draft.metadata.parameters.length }} 个参数 · {{ result.draft.metadata.checks.length }} 项历史验证。草稿不会自动运行。</p>
    <div class="task-script-actions"><button type="button" class="chat-button" :disabled="!result.draft" @click="result.draft && emit('create', result.draft)">在脚本编辑器中打开</button><button type="button" class="chat-text-button" @click="emit('close')">取消</button></div>
  </section>
</template>
<style scoped>
.agent-task-script { padding: 12px; margin: 10px 0; min-width: 0; border: 1px solid var(--chat-line); border-radius: 8px; font-size: var(--ai-font-ui); overflow-wrap: anywhere; }
p { line-height: var(--ai-leading-ui); }
label { display: block; margin: 9px 0; }
select { display: block; max-width: 100%; width: 100%; color: var(--chat-text); background: var(--chat-surface); padding: 6px; border: 1px solid var(--chat-line); }
.task-script-choice { display: flex; gap: 7px; align-items: flex-start; }
code { white-space: pre-wrap; }
small { display: block; color: var(--chat-muted); margin-top: 4px; }
.task-script-actions { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
