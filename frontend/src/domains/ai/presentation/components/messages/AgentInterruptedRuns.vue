<script setup lang="ts">
import type { AgentCheckpoint } from '../../../domain/agentCheckpoints'
import { checkpointStepEffect } from '../../../domain/agentCheckpoints'
import AgentTaskReply from './AgentTaskReply.vue'
defineProps<{ runs: AgentCheckpoint[]; error?: string; busy?: boolean }>()
const emit = defineEmits<{ recover: [run: AgentCheckpoint]; reply: [run: AgentCheckpoint, text: string, confirmedPlanItemIds: string[]] }>()
const effectLabels = { 'not-started': '未派发', known: '结果已记录', unknown: '效果未知，需核对' }
const planLabels = { pending: '待执行', 'in-progress': '待继续', completed: '已完成', waiting: '等待输入', skipped: '已跳过', cancelled: '已取消', failed: '失败' }
</script>

<template>
  <section v-if="runs.length || error" class="agent-interrupted-runs" aria-label="未完成任务记录">
    <p v-if="error" role="status">{{ error }}</p>
    <details v-if="runs.length">
      <summary>已保存的未完成任务 · {{ runs.length }}</summary>
      <p>记录可在重新打开应用后查看。继续前需核对目标与未知结果；旧批准不会恢复。</p>
      <details v-for="run in runs" :key="run.runId" class="interrupted-run" :data-run-id="run.runId">
        <summary>{{ run.goal }}</summary>
        <p>{{ run.target.context.user || '账号未知' }} · {{ run.target.context.workingDirectory || '目录未知' }}</p>
        <p>{{ new Date(run.updatedAt).toLocaleString() }} · 第 {{ run.sequence }} 次保存</p>
        <ol v-if="run.state.plan"><li v-for="item in run.state.plan.items" :key="item.id">{{ planLabels[item.status] }} · {{ item.description }}</li></ol>
        <details v-for="step in run.state.steps" :key="step.id" :data-effect="checkpointStepEffect(step)">
          <summary>{{ effectLabels[checkpointStepEffect(step)] }} · {{ step.reason || step.toolName }}</summary>
          <pre v-if="step.command">{{ step.command }}</pre>
          <p v-if="step.fileRead">{{ step.fileRead.path }} · {{ step.fileRead.complete ? '已完整读取' : '读取记录' }}</p>
          <p v-for="(file, index) in step.fileEdits" :key="index">{{ file.path || '文件' }} · {{ file.status }}<small v-if="file.changeId">变更 {{ file.changeId }}</small></p>
          <p v-if="step.exitCode !== null">退出码 {{ step.exitCode }}</p>
          <pre v-if="step.output">{{ step.output }}</pre>
          <p v-if="step.failureReason">{{ step.failureReason }}</p>
        </details>
        <p v-if="run.state.error || run.state.stopReason">{{ run.state.error || run.state.stopReason }}</p>
        <AgentTaskReply v-if="run.state.status === 'waiting-input' && run.routeKey" :run="run" :busy="busy" show-question @reply="(run, text, confirmedIds) => emit('reply', run, text, confirmedIds)" />
        <button v-else type="button" class="chat-button" :disabled="busy || !run.routeKey" @click="emit('recover', run)">核对并恢复任务</button>
        <p v-if="!run.routeKey">此旧记录没有完整恢复证据，可查看历史后发起新任务。</p>
      </details>
    </details>
  </section>
</template>

<style scoped>
.agent-interrupted-runs { border-bottom: 1px solid var(--chat-line); margin: 4px 0 12px; padding-bottom: 10px; color: var(--chat-text); font-size: var(--ai-font-ui); line-height: var(--ai-leading-ui); overflow-wrap: anywhere; min-width: 0; }
summary { cursor: pointer; padding: 6px 0; }
p, small { color: var(--chat-muted); margin: 6px 0; }
small { display: block; }
.interrupted-run { margin: 6px 0; padding: 4px 10px; border: 1px solid var(--chat-line); border-radius: 8px; }
[data-effect=unknown] > summary { color: var(--chat-warning, var(--workbench-warning)); }
pre { max-height: 160px; overflow: auto; white-space: pre-wrap; font: var(--ai-font-ui)/var(--ai-leading-ui) var(--font-mono); }
ol { padding-left: 20px; }
</style>
