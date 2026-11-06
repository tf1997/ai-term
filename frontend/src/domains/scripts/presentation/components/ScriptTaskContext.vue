<script setup lang="ts">
import { computed, ref } from 'vue'
import type { TaskScriptMetadata } from '../../domain/taskScript'
import { taskScriptOmissionDescription } from '../../domain/taskScript'
const props = defineProps<{ metadata: TaskScriptMetadata; values: Record<string, string> }>()
const emit = defineEmits<{ parameter: [name: string, value: string] }>()
const showAllOmissions = ref(false)
const omittedSteps = computed(() => props.metadata.omittedSteps ?? [])
const omittedChecks = computed(() => props.metadata.omittedChecks ?? [])
const visibleOmissions = computed(() => showAllOmissions.value ? omittedSteps.value : omittedSteps.value.slice(0, 20))
const toolLabels: Record<string, string> = { run_command: '命令', run_ssh_task: '独立 SSH', read_file: '文件读取', list_directory: '目录读取', apply_patch: '文件补丁', write_file: '文件写入', delete_file: '文件删除', restore_file: '文件恢复' }
const statusLabels: Record<string, string> = { pending: '待执行', running: '运行中', completed: '已完成', skipped: '已跳过', timeout: '超时', failed: '失败' }
const checkStatusLabels: Record<string, string> = { pending: '待验证', passed: '通过', failed: '失败', unavailable: '尚无法确认' }
</script>
<template>
  <details class="script-task-context" open>
    <summary>任务来源与运行参数 · 版本 {{ metadata.revision }}</summary>
    <p>来源任务 {{ metadata.source.runId }} · {{ metadata.source.stepIds.length }} 个步骤</p>
    <p>适用环境：{{ metadata.environment.profileId }} · {{ metadata.environment.user }} · {{ metadata.environment.environmentScope }}</p>
    <label v-for="parameter in metadata.parameters" :key="parameter.name">
      {{ parameter.label }} · {{ parameter.name }}{{ parameter.required ? '（必填）' : '' }}
      <small v-if="parameter.type === 'secret'">在目标环境导出 AI_TERM_SECRET_{{ parameter.name }}，当前值不会写入脚本。</small>
      <input v-else :value="values[parameter.name] ?? parameter.defaultValue ?? ''" :aria-label="parameter.name" @input="emit('parameter', parameter.name, ($event.target as HTMLInputElement).value)" />
    </label>
    <p>这些值只用于本次运行，保存和复制保留参数模板。运行前会重新分析完整脚本。</p>
    <details><summary>前置条件与验证</summary><p v-for="item in metadata.prerequisites" :key="item">{{ item }}</p><p v-for="check in metadata.checks" :key="check.id">{{ check.purpose }}：{{ check.expected }}（需重新核验）</p></details>
    <details v-if="omittedSteps.length || omittedChecks.length" class="script-task-omissions">
      <summary>未纳入或待整理 · {{ omittedSteps.length }} 个步骤<template v-if="omittedChecks.length"> · {{ omittedChecks.length }} 项验证</template></summary>
      <p>以下为生成草稿时未纳入的来源步骤，不会随脚本执行。请结合原任务核对依赖；原命令、文件正文及凭据未复制。</p>
      <ol>
        <li v-for="item in visibleOmissions" :key="item.stepId" :data-omitted-step="item.stepId">
          <span>{{ toolLabels[item.tool] || item.tool }} · {{ statusLabels[item.status] || item.status }}</span>
          <code>来源步骤 {{ item.stepId }}</code><p>{{ taskScriptOmissionDescription(item) }}</p>
        </li>
      </ol>
      <button v-if="omittedSteps.length > 20" type="button" class="chat-text-button" @click="showAllOmissions = !showAllOmissions">{{ showAllOmissions ? '收起部分条目' : `显示全部 ${omittedSteps.length} 项` }}</button>
      <p v-for="check in omittedChecks" :key="check.id" :data-omitted-check="check.id">{{ check.required ? '必要验证未纳入' : '补充验证未纳入' }} · {{ check.id }}（历史：{{ checkStatusLabels[check.status] || check.status }}）<br />{{ check.stepId ? `原证据步骤 ${check.stepId}` : '原任务尚未关联执行证据' }}。需要另外安排检查，历史结果不能证明本次脚本完成目标。</p>
    </details>
  </details>
</template>
<style scoped>
.script-task-context { min-width: 0; max-height: 32vh; overflow: auto; flex-shrink: 0; margin: 10px; padding: 10px; border: 1px solid var(--line); border-radius: 8px; font-size: var(--ui-font-size, 12px); overflow-wrap: anywhere; }
summary { cursor: pointer; }
p { line-height: 1.6; }
label, small { display: block; margin: 8px 0; }
input { box-sizing: border-box; display: block; width: 100%; min-width: 0; padding: 6px; margin-top: 4px; }
.script-task-omissions ol { padding-left: 20px; }
.script-task-omissions li { margin: 10px 0; }
.script-task-omissions code { display: block; white-space: pre-wrap; }
</style>
