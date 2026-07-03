<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CommandHistoryEntry } from '../types/workspace'

const MAX_VISIBLE_COMMANDS = 100
const LONG_COMMAND_CHARS = 96
const LONG_COMMAND_LINES = 2

const props = defineProps<{
  commands: CommandHistoryEntry[]
}>()

const emit = defineEmits<{
  rerun: [command: string]
}>()

const historySearch = ref('')
const expandedCommandIds = ref<Record<string, boolean>>({})

const filteredCommands = computed(() => {
  const query = historySearch.value.trim().toLowerCase()
  if (!query) return props.commands
  return props.commands.filter((entry) => {
    return entry.command.toLowerCase().includes(query) || entry.createdAt.toLowerCase().includes(query)
  })
})

const visibleCommands = computed(() => filteredCommands.value.slice(-MAX_VISIBLE_COMMANDS).reverse())

function isLongCommand(command: string) {
  return command.length > LONG_COMMAND_CHARS || command.split(/\r?\n/).length > LONG_COMMAND_LINES
}

function isExpanded(entry: CommandHistoryEntry) {
  return expandedCommandIds.value[entry.id] ?? false
}

function toggleCommand(entry: CommandHistoryEntry) {
  expandedCommandIds.value = {
    ...expandedCommandIds.value,
    [entry.id]: !isExpanded(entry)
  }
}

async function copyCommand(command: string) {
  try {
    await navigator.clipboard?.writeText(command)
  } catch (error) {
    console.warn('failed to copy command history entry', error)
  }
}
</script>

<template>
  <section class="history-panel">
    <div class="workspace-section-head history-head">
      <div>
        <strong>历史命令</strong>
        <span class="history-meta">显示 {{ visibleCommands.length }} / {{ filteredCommands.length }}，保留最近 {{ commands.length }}</span>
      </div>
      <span class="badge">{{ commands.length }}</span>
    </div>
    <div class="history-toolbar">
      <input v-model="historySearch" type="search" placeholder="搜索命令或时间" aria-label="搜索历史命令" />
    </div>
    <div class="history-list">
      <p v-if="commands.length === 0" class="empty-state">No command history</p>
      <p v-else-if="visibleCommands.length === 0" class="empty-state">No matching commands</p>
      <article
        v-for="entry in visibleCommands"
        :key="entry.id"
        class="history-row"
        :class="{ expanded: isExpanded(entry) }"
      >
        <div>
          <code>{{ entry.command }}</code>
          <span>{{ entry.createdAt }}</span>
        </div>
        <div class="history-actions">
          <button
            v-if="isLongCommand(entry.command)"
            class="text-button"
            type="button"
            :title="isExpanded(entry) ? '折叠命令' : '展开命令'"
            @click="toggleCommand(entry)"
          >
            {{ isExpanded(entry) ? '收起' : '展开' }}
          </button>
          <button class="icon-button" type="button" title="复制命令" aria-label="复制命令" @click="copyCommand(entry.command)">C</button>
          <button class="icon-button" type="button" title="再次执行" aria-label="再次执行" @click="emit('rerun', entry.command)">→</button>
        </div>
      </article>
    </div>
  </section>
</template>
