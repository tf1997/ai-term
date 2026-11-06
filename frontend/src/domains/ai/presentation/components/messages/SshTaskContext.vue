<script setup lang="ts">
import type { SshTaskRequest, SshTaskTarget } from '../../../../terminal/types'
import { sshTaskTargetLabel } from '../../../../terminal/index'
defineProps<{ request: SshTaskRequest; target: SshTaskTarget; environment?: Record<string, string> }>()
</script>

<template>
  <div class="ssh-task-context" aria-label="独立 SSH 任务环境">
    <strong>独立 SSH · {{ sshTaskTargetLabel(target) }}</strong>
    <p>目录：{{ request.workingDirectory }} · Shell：/bin/sh · 观察时限：{{ request.timeoutMs / 1000 }} 秒</p>
    <p>使用独立登录环境；当前终端的目录、变量、提权和容器状态不带入此任务。</p>
    <pre aria-label="独立任务环境变量">{{ JSON.stringify(environment ?? { PATH: '/usr/local/bin:/usr/bin:/bin', ...request.environment }, null, 2) }}</pre>
  </div>
</template>

<style scoped>
.ssh-task-context { padding: 12px; color: var(--chat-text, var(--workbench-text)); font-size: var(--ai-font-ui); line-height: var(--ai-leading-ui); overflow-wrap: anywhere; }
.ssh-task-context strong { font-weight: var(--ai-weight-medium); }
.ssh-task-context p { margin: 6px 0; color: var(--chat-muted, var(--workbench-muted)); }
.ssh-task-context pre { margin: 8px 0 0; max-height: 180px; overflow: auto; white-space: pre-wrap; font-family: var(--font-mono); }
</style>
