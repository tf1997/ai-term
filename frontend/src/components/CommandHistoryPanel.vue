<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { CommandHistoryEntry } from '../types/workspace'
import UiIcon from './UiIcon.vue'

const MAX_VISIBLE_COMMANDS = 100
const MAX_FREQUENT_COMMANDS = 50
const LONG_COMMAND_CHARS = 96
const LONG_COMMAND_LINES = 2

type HistoryView = 'recent' | 'frequent'

interface HistoryListItem {
  entry: CommandHistoryEntry
  count: number
  lastIndex: number
}

const props = defineProps<{
  commands: CommandHistoryEntry[]
  connectionLabel: string
}>()

const emit = defineEmits<{
  fill: [command: string]
  pin: [command: string]
}>()

const activeView = ref<HistoryView>('recent')
const recentTab = ref<HTMLButtonElement | null>(null)
const frequentTab = ref<HTMLButtonElement | null>(null)
const historySearch = ref('')
const previewEntry = ref<CommandHistoryEntry | null>(null)
const previewModal = ref<HTMLElement | null>(null)
const previewCloseButton = ref<HTMLButtonElement | null>(null)
const copyStatus = ref('')
let previewTrigger: HTMLElement | null = null
let copyStatusTimer: number | undefined

const normalizedSearch = computed(() => historySearch.value.trim().toLowerCase())

function entryMatchesSearch(entry: CommandHistoryEntry) {
  const query = normalizedSearch.value
  if (!query) return true
  return entry.command.toLowerCase().includes(query)
    || entry.createdAt.toLowerCase().includes(query)
    || formatHistoryTime(entry.createdAt).toLowerCase().includes(query)
}

const recentCommands = computed<HistoryListItem[]>(() => props.commands
  .filter(entryMatchesSearch)
  .slice(-MAX_VISIBLE_COMMANDS)
  .reverse()
  .map((entry, index) => ({ entry, count: 1, lastIndex: props.commands.length - index - 1 })))

const matchingFrequentCommands = computed<HistoryListItem[]>(() => {
  const grouped = new Map<string, HistoryListItem>()
  props.commands.forEach((entry, index) => {
    const command = entry.command.trim()
    if (!command) return
    const current = grouped.get(command)
    if (current) {
      current.count += 1
      current.entry = entry
      current.lastIndex = index
    } else {
      grouped.set(command, { entry, count: 1, lastIndex: index })
    }
  })
  return [...grouped.values()]
    .filter(({ entry }) => entryMatchesSearch(entry))
    .sort((first, second) => (
      second.count - first.count
      || second.lastIndex - first.lastIndex
      || first.entry.command.localeCompare(second.entry.command)
    ))
})

const frequentCommands = computed(() => matchingFrequentCommands.value.slice(0, MAX_FREQUENT_COMMANDS))
const visibleCommands = computed(() => activeView.value === 'recent' ? recentCommands.value : frequentCommands.value)
const matchingCommandCount = computed(() => {
  if (activeView.value === 'frequent') return matchingFrequentCommands.value.length
  return props.commands.filter(entryMatchesSearch).length
})

function selectView(view: HistoryView, focus = false) {
  activeView.value = view
  if (!focus) return
  void nextTick(() => (view === 'recent' ? recentTab.value : frequentTab.value)?.focus())
}

function handleViewTabKeydown(event: KeyboardEvent) {
  let view: HistoryView | undefined
  if (event.key === 'Home') view = 'recent'
  else if (event.key === 'End') view = 'frequent'
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    view = activeView.value === 'recent' ? 'frequent' : 'recent'
  }
  if (!view) return
  event.preventDefault()
  selectView(view, true)
}

function clearSearch() {
  historySearch.value = ''
}

function isLongCommand(command: string) {
  return command.length > LONG_COMMAND_CHARS || command.split(/\r?\n/).length > LONG_COMMAND_LINES
}

function formatHistoryTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const dayOffset = Math.round((startOfToday - startOfDate) / 86_400_000)
  const time = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date)

  if (dayOffset === 0) return `今天 ${time}`
  if (dayOffset === 1) return `昨天 ${time}`
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date)
}

function previewCommand(entry: CommandHistoryEntry, event?: Event) {
  clearCopyStatus()
  previewTrigger = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null
  previewEntry.value = entry
  void nextTick(() => previewCloseButton.value?.focus())
}

function closePreview(restoreFocus = true) {
  const trigger = previewTrigger
  clearCopyStatus()
  previewEntry.value = null
  previewTrigger = null
  if (restoreFocus && trigger) void nextTick(() => {
    if (trigger.isConnected) trigger.focus()
  })
}

function handlePreviewKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    closePreview()
    return
  }
  if (event.key !== 'Tab') return

  const focusable = [...(previewModal.value?.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  ) ?? [])]
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (!first || !last) return
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function showCopyStatus(message: string) {
  copyStatus.value = message
  if (copyStatusTimer !== undefined) window.clearTimeout(copyStatusTimer)
  copyStatusTimer = window.setTimeout(() => {
    copyStatus.value = ''
    copyStatusTimer = undefined
  }, 2200)
}

function clearCopyStatus() {
  if (copyStatusTimer !== undefined) window.clearTimeout(copyStatusTimer)
  copyStatusTimer = undefined
  copyStatus.value = ''
}

async function copyCommand(command: string) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
    await navigator.clipboard.writeText(command)
    showCopyStatus('命令已复制')
  } catch (error) {
    console.warn('failed to copy command history entry', error)
    showCopyStatus('复制失败，请重试')
  }
}

async function copyPreviewCommand() {
  if (!previewEntry.value) return
  await copyCommand(previewEntry.value.command)
}

function fillCommand(command: string) {
  emit('fill', command)
}

function fillPreviewCommand() {
  if (!previewEntry.value) return
  emit('fill', previewEntry.value.command)
  closePreview(false)
}

watch(
  () => props.commands,
  (commands) => {
    if (previewEntry.value && !commands.some((entry) => entry.id === previewEntry.value?.id)) closePreview(false)
  }
)

onBeforeUnmount(() => {
  if (copyStatusTimer !== undefined) window.clearTimeout(copyStatusTimer)
})
</script>

<template>
  <section class="history-panel">
    <div class="workspace-section-head history-head">
      <div>
        <strong>历史命令</strong>
        <span class="history-meta">{{ connectionLabel }} · 已加载 {{ commands.length }} 条</span>
      </div>
    </div>

    <div class="history-toolbar">
      <div class="history-view-tabs" role="tablist" aria-label="历史命令视图" @keydown="handleViewTabKeydown">
        <button
          id="history-tab-recent"
          ref="recentTab"
          class="history-view-tab"
          type="button"
          role="tab"
          :tabindex="activeView === 'recent' ? 0 : -1"
          :aria-selected="activeView === 'recent'"
          aria-controls="history-command-list"
          @click="selectView('recent')"
        >
          最近
        </button>
        <button
          id="history-tab-frequent"
          ref="frequentTab"
          class="history-view-tab"
          type="button"
          role="tab"
          :tabindex="activeView === 'frequent' ? 0 : -1"
          :aria-selected="activeView === 'frequent'"
          aria-controls="history-command-list"
          @click="selectView('frequent')"
        >
          常用
        </button>
        <span>{{ visibleCommands.length }} / {{ matchingCommandCount }}</span>
      </div>
      <div class="history-search-wrap">
        <UiIcon name="search" size="14" />
        <input v-model="historySearch" type="search" placeholder="搜索命令或时间" aria-label="搜索历史命令" />
        <button v-if="historySearch" class="history-search-clear" type="button" title="清除搜索" aria-label="清除搜索" @click="clearSearch">
          <UiIcon name="close" size="13" />
        </button>
      </div>
    </div>

    <div
      id="history-command-list"
      class="history-list"
      role="tabpanel"
      :aria-labelledby="activeView === 'recent' ? 'history-tab-recent' : 'history-tab-frequent'"
    >
      <div v-if="commands.length === 0" class="empty-state">执行命令后，记录会显示在这里。</div>
      <div v-else-if="visibleCommands.length === 0" class="empty-state history-empty-search">
        <span>没有匹配的命令</span>
        <button class="text-button" type="button" @click="clearSearch">清除搜索</button>
      </div>
      <ul v-else class="history-results">
        <li v-for="item in visibleCommands" :key="`${activeView}-${item.entry.id}`" class="history-row">
          <div class="history-command-cell">
            <code :title="item.entry.command">{{ item.entry.command }}</code>
            <span v-if="activeView === 'frequent'" class="history-frequency">使用 {{ item.count }} 次 · 最近 {{ formatHistoryTime(item.entry.createdAt) }}</span>
            <span v-else>{{ formatHistoryTime(item.entry.createdAt) }}</span>
          </div>
          <div class="history-actions">
            <button
              v-if="isLongCommand(item.entry.command)"
              class="icon-button history-preview-trigger"
              type="button"
              title="预览完整命令"
              aria-label="预览完整命令"
              @click.stop="previewCommand(item.entry, $event)"
            >
              <UiIcon name="eye" />
            </button>
            <button class="icon-button" type="button" title="复制命令" aria-label="复制命令" @click.stop="copyCommand(item.entry.command)"><UiIcon name="copy" /></button>
            <button class="icon-button" type="button" title="固定到固定命令栏" aria-label="固定到固定命令栏" @click.stop="emit('pin', item.entry.command)"><UiIcon name="pin" /></button>
            <button class="icon-button history-action-fill" type="button" title="填入终端" aria-label="填入终端" @click.stop="fillCommand(item.entry.command)"><UiIcon name="terminal" /></button>
          </div>
        </li>
      </ul>
    </div>

    <p v-if="!previewEntry" class="history-status" role="status" aria-live="polite" aria-atomic="true">{{ copyStatus }}</p>
  </section>

  <div v-if="previewEntry" class="modal-backdrop history-preview-backdrop" role="presentation" @click.self="closePreview()">
    <article
      ref="previewModal"
      class="modal history-preview-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="history-preview-title"
      aria-describedby="history-preview-meta"
      @keydown="handlePreviewKeydown"
    >
      <div class="modal-head">
        <div>
          <strong id="history-preview-title">命令预览</strong>
          <span id="history-preview-meta">{{ formatHistoryTime(previewEntry.createdAt) }} · {{ previewEntry.command.length }} 字符</span>
        </div>
        <button ref="previewCloseButton" class="icon-button" type="button" title="关闭" aria-label="关闭" @click="closePreview()"><UiIcon name="close" /></button>
      </div>
      <div class="history-preview-body">
        <pre><code>{{ previewEntry.command }}</code></pre>
      </div>
      <div class="modal-actions history-preview-actions">
        <span class="history-preview-copy-status" role="status" aria-live="polite" aria-atomic="true">{{ copyStatus }}</span>
        <button class="text-button" type="button" @click="copyPreviewCommand">复制命令</button>
        <button class="text-button primary-action" type="button" @click="fillPreviewCommand">填入终端</button>
      </div>
    </article>
  </div>
</template>
