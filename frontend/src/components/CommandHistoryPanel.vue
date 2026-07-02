<script setup lang="ts">
import type { CommandHistoryEntry } from '../types/workspace'

defineProps<{
  commands: CommandHistoryEntry[]
}>()

const emit = defineEmits<{
  rerun: [command: string]
}>()
</script>

<template>
  <section class="history-panel">
    <div class="workspace-section-head">
      <strong>历史命令</strong>
      <span class="badge">{{ commands.length }}</span>
    </div>
    <div class="history-list">
      <p v-if="commands.length === 0" class="empty-state">No command history</p>
      <article v-for="entry in commands" :key="entry.id" class="history-row">
        <div>
          <code>{{ entry.command }}</code>
          <span>{{ entry.createdAt }}</span>
        </div>
        <button class="icon-button" title="Run command again" @click="emit('rerun', entry.command)">↵</button>
      </article>
    </div>
  </section>
</template>
