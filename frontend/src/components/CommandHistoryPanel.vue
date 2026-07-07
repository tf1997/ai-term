<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CommandHistoryEntry } from '../types/workspace'
import UiIcon from './UiIcon.vue'

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
const previewEntry = ref<CommandHistoryEntry | null>(null)

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

function previewCommand(entry: CommandHistoryEntry) {
  previewEntry.value = entry
}

function closePreview() {
  previewEntry.value = null
}

async function copyCommand(command: string) {
  try {
    await navigator.clipboard?.writeText(command)
  } catch (error) {
    console.warn('failed to copy command history entry', error)
  }
}

async function copyPreviewCommand() {
  if (!previewEntry.value) return
  await copyCommand(previewEntry.value.command)
}

function executePreviewCommand() {
  if (!previewEntry.value) return
  emit('rerun', previewEntry.value.command)
  closePreview()
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
      <p v-if="commands.length === 0" class="empty-state">暂无命令历史</p>
      <p v-else-if="visibleCommands.length === 0" class="empty-state">没有匹配的命令</p>
      <article
        v-for="entry in visibleCommands"
        :key="entry.id"
        class="history-row"
        :class="{ 'is-long': isLongCommand(entry.command) }"
        @dblclick="isLongCommand(entry.command) && previewCommand(entry)"
      >
        <div class="history-command-cell">
          <code :title="entry.command">{{ entry.command }}</code>
          <span>{{ entry.createdAt }}</span>
        </div>
        <div class="history-actions">
          <button
            v-if="isLongCommand(entry.command)"
            class="icon-button history-preview-trigger"
            type="button"
            title="预览完整命令"
            aria-label="预览完整命令"
            @click="previewCommand(entry)"
          >
            <UiIcon name="eye" />
          </button>
          <button class="icon-button" type="button" title="复制命令" aria-label="复制命令" @click="copyCommand(entry.command)"><UiIcon name="copy" /></button>
          <button class="icon-button" type="button" title="再次执行" aria-label="再次执行" @click="emit('rerun', entry.command)"><UiIcon name="play" /></button>
        </div>
      </article>
    </div>
  </section>

  <div v-if="previewEntry" class="modal-backdrop history-preview-backdrop" role="presentation">
    <article class="modal history-preview-modal" role="dialog" aria-modal="true" aria-label="历史命令预览">
      <div class="modal-head">
        <div>
          <strong>命令预览</strong>
          <span>{{ previewEntry.createdAt }} · {{ previewEntry.command.length }} 字符</span>
        </div>
        <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="closePreview"><UiIcon name="close" /></button>
      </div>
      <div class="history-preview-body">
        <pre><code>{{ previewEntry.command }}</code></pre>
      </div>
      <div class="modal-actions history-preview-actions">
        <button class="text-button" type="button" @click="copyPreviewCommand">复制命令</button>
        <button class="text-button primary-action" type="button" @click="executePreviewCommand">执行</button>
      </div>
    </article>
  </div>
</template>
