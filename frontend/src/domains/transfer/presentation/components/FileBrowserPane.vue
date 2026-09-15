<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import {
  buildLocalBreadcrumbs,
  buildRemoteBreadcrumbs,
  localParentPath,
  remoteParentPath,
} from '../../domain/transferPaths'
import { formatLocalModified, formatSize, formatError } from '../../domain/transferPresentation'
import type { BrowserEntry, useDirectoryBrowser } from '../../application/useDirectoryBrowser'
import FileLocationControl from './FileLocationControl.vue'
import UiIcon from '../../../../shared/ui/UiIcon.vue'

const props = defineProps<{
  side: 'local' | 'remote'
  browser: ReturnType<typeof useDirectoryBrowser>
  enabled: boolean
  active?: boolean
  transferEnabled?: boolean
  dropHover?: boolean
  identity?: string
  recent: string[]
  bookmarks: string[]
  roots?: string[]
  home: string
}>()
const emit = defineEmits<{
  open: [entry: BrowserEntry]
  menu: [event: MouseEvent | KeyboardEvent, entry: BrowserEntry]
  bookmark: [path: string]
  transfer: []
  drop: [paths: string[]]
}>()
const b = reactive(props.browser),
  list = ref<HTMLElement | null>(null),
  location = ref<InstanceType<typeof FileLocationControl> | null>(null)
const label = computed(() => (props.side === 'local' ? '本地' : '远端'))
const crumbs = computed(() =>
  props.side === 'local' ? buildLocalBreadcrumbs(b.path) : buildRemoteBreadcrumbs(b.path),
)
const updated = computed(() =>
  b.updatedAt
    ? new Date(b.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '',
)
const dropActive = ref(false)

function rowElement(path: string) {
  return [...(list.value?.querySelectorAll<HTMLElement>('[data-file-path]') ?? [])].find(
    (element) => element.dataset.filePath === path,
  )
}
function focusRow(path = b.focused || b.visibleEntries[0]?.path) {
  if (!path) {
    list.value?.focus()
    return
  }
  b.focused = path
  void nextTick(() => rowElement(path)?.focus({ preventScroll: true }))
}
function open(entry: BrowserEntry) {
  if (!props.enabled) return
  if (entry.isDir) void navigate(entry.path)
  else emit('open', entry)
}
function openMenu(event: MouseEvent, entry: BrowserEntry) {
  if (!b.selected.includes(entry.path)) b.select(entry)
  emit('menu', event, entry)
}
function toggleSelection(entry: BrowserEntry) {
  b.select(entry, { ctrlKey: true })
  focusRow(entry.path)
}
async function navigate(path: string) {
  if (await b.load(path, { preserve: false })) focusRow()
}
function goUp() {
  if (props.enabled)
    void navigate(props.side === 'local' ? localParentPath(b.path) : remoteParentPath(b.path))
}
function keydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
    event.preventDefault()
    event.stopPropagation()
    location.value?.focus()
    return
  }
  if (event.altKey && event.key === 'ArrowUp') {
    event.preventDefault()
    goUp()
    return
  }
  if ((event.target as HTMLElement).closest('input,button,textarea')) return
  const rows = b.visibleEntries
  if (!rows.length) return
  let index = rows.findIndex((entry) => entry.path === b.focused)
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
    event.preventDefault()
    b.selected = rows.map((entry) => entry.path)
    return
  }
  const entry = rows[Math.max(0, index)]
  if (event.key === 'Enter') {
    event.preventDefault()
    open(entry)
    return
  }
  if (event.key === ' ') {
    event.preventDefault()
    b.select(entry, { ctrlKey: true })
    return
  }
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    event.preventDefault()
    emit('menu', event, entry)
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  index =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? rows.length - 1
        : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
  if (!event.ctrlKey && !event.metaKey) b.select(rows[index], { shiftKey: event.shiftKey })
  focusRow(rows[index].path)
  void nextTick(() => rowElement(rows[index].path)?.scrollIntoView({ block: 'nearest' }))
}
function sortBy(column: 'name' | 'size' | 'modified') {
  if (b.sort === column) b.descending = !b.descending
  else {
    b.sort = column
    b.descending = false
  }
}
function onDrop(event: DragEvent) {
  dropActive.value = false
  if (!props.enabled || props.side !== 'remote') return
  const paths = Array.from(event.dataTransfer?.files ?? [])
    .map((file) => (file as File & { path?: string }).path ?? '')
    .filter(Boolean)
  emit('drop', paths)
}
function onDragOver() {
  if (props.side === 'remote' && props.enabled) dropActive.value = true
}
function focus(kind: 'path' | 'list' = 'list') {
  if (kind === 'path') location.value?.focus()
  else focusRow()
}
watch(
  () => [b.entries, b.scroll],
  () =>
    void nextTick(() => {
      if (list.value) list.value.scrollTop = b.scroll
    }),
  { flush: 'post' },
)
defineExpose({
  focus,
  element: () => list.value,
  focusKind: () => (location.value?.isEditing() ? 'path' : 'list'),
})
</script>

<template>
  <section
    class="transfer-pane file-browser-pane"
    :class="[`${side}-pane`, { 'drop-active': dropActive || dropHover }]"
    :aria-label="`${label}文件`"
    @keydown="keydown"
    @dragover.prevent="onDragOver"
    @dragleave.self="dropActive = false"
    @drop.prevent.stop="onDrop"
  >
    <header class="file-pane-heading">
      <div>
        <strong>{{ label }}</strong
        ><span v-if="identity" class="file-pane-identity" :title="identity">{{ identity }}</span>
      </div>
      <span
        >{{ enabled ? `${b.visibleEntries.length} 项` : '未连接'
        }}<span v-if="enabled && b.selected.length"> · 已选 {{ b.selected.length }}</span></span
      >
    </header>
    <div class="file-pane-location">
      <button
        class="icon-button"
        type="button"
        :aria-label="`${label}后退`"
        title="后退"
        :disabled="!enabled || !b.canBack"
        @click="b.goHistory(-1)"
      >
        <UiIcon name="arrow-left" size="14" />
      </button>
      <button
        class="icon-button"
        type="button"
        :aria-label="`${label}前进`"
        title="前进"
        :disabled="!enabled || !b.canForward"
        @click="b.goHistory(1)"
      >
        <UiIcon name="arrow-right" size="14" />
      </button>
      <button
        class="icon-button"
        type="button"
        :aria-label="`${label}上级目录`"
        title="上级目录 · Alt+↑"
        :disabled="!enabled"
        @click="goUp"
      >
        <UiIcon name="arrow-up" size="14" />
      </button>
      <FileLocationControl
        ref="location"
        :active="active"
        :label="label"
        :path="b.path"
        v-model:draft="b.draft"
        :disabled="!enabled"
        :breadcrumbs="crumbs"
        :recent="recent"
        :bookmarks="bookmarks"
        :roots="roots"
        :suggest="b.suggestions"
        @navigate="navigate"
        @bookmark="emit('bookmark', $event)"
      />
    </div>
    <div class="file-pane-actions">
      <label class="file-search"
        ><UiIcon name="search" size="14" /><input
          v-model="b.search"
          :aria-label="`筛选${label}文件`"
          placeholder="筛选文件"
      /></label>
      <button
        class="icon-button"
        type="button"
        :aria-label="`刷新${label}目录`"
        title="刷新目录"
        :disabled="!enabled || b.loading || b.refreshing"
        @click="b.load(b.path, { force: true, preserve: true })"
      >
        <UiIcon name="refresh" size="14" />
      </button>
      <button
        type="button"
        :disabled="!enabled || transferEnabled === false || !b.selected.length"
        @click="emit('transfer')"
      >
        <UiIcon :name="side === 'local' ? 'upload' : 'download'" size="14" />{{
          side === 'local' ? '上传' : '下载'
        }}<span v-if="b.selected.length"> {{ b.selected.length }}</span>
      </button>
    </div>
    <div v-if="b.error" class="file-directory-error" role="alert">
      <span>{{ formatError(b.error) }}</span
      ><button type="button" :disabled="!enabled" @click="b.load(b.path || home, { force: true })">
        重试</button
      ><button type="button" :disabled="!enabled" @click="navigate(home)">主目录</button>
    </div>
    <div
      ref="list"
      class="file-list file-grid"
      role="grid"
      :aria-label="`${label}文件列表`"
      aria-multiselectable="true"
      :aria-busy="b.loading || b.refreshing"
      tabindex="0"
      @scroll="b.scroll = ($event.target as HTMLElement).scrollTop"
    >
      <div v-if="enabled" class="file-grid-head" role="row">
        <div
          v-for="column in ['name', 'size', 'modified'] as const"
          :key="column"
          role="columnheader"
          :aria-sort="b.sort === column ? (b.descending ? 'descending' : 'ascending') : 'none'"
        >
          <button type="button" @click="sortBy(column)">
            {{ column === 'name' ? '名称' : column === 'size' ? '大小' : '修改时间'
            }}<span v-if="b.sort === column">{{ b.descending ? ' ↓' : ' ↑' }}</span>
          </button>
        </div>
        <div role="columnheader" aria-label="操作" />
      </div>
      <div v-if="!enabled" class="file-grid-empty"><slot name="empty" /></div>
      <div v-else-if="b.loading && !b.entries.length" class="file-grid-empty" role="status">
        正在读取目录…
      </div>
      <div v-else-if="!b.visibleEntries.length" class="file-grid-empty">
        <strong>{{ b.search ? '没有匹配的文件' : '目录为空' }}</strong
        ><button v-if="b.search" type="button" @click="b.search = ''">清除筛选</button>
      </div>
      <div
        v-for="entry in enabled ? b.visibleEntries : []"
        :key="entry.path"
        class="file-row file-grid-row"
        :class="{
          active: b.selected.includes(entry.path),
          directory: entry.isDir,
          'hidden-entry': entry.name.startsWith('.'),
        }"
        :data-file-path="entry.path"
        role="row"
        :aria-selected="b.selected.includes(entry.path)"
        :aria-label="`${label}${entry.isDir ? '目录' : '文件'} ${entry.name}`"
        :tabindex="(b.focused || b.visibleEntries[0]?.path) === entry.path ? 0 : -1"
        @focus="b.focused = entry.path"
        @click="b.select(entry, $event)"
        @dblclick="open(entry)"
        @contextmenu.prevent.stop="openMenu($event, entry)"
      >
        <div class="file-cell-name" role="gridcell">
          <input
            type="checkbox"
            tabindex="-1"
            :aria-label="`选择 ${entry.name}`"
            :checked="b.selected.includes(entry.path)"
            @click.stop="toggleSelection(entry)"
          /><span class="file-type-icon" :class="entry.isDir ? 'folder' : 'file'"
            ><UiIcon :name="entry.isDir ? 'folder' : 'file'" size="15" /></span
          ><strong :title="entry.name">{{ entry.name }}</strong>
        </div>
        <span class="file-cell-size file-meta" role="gridcell">{{
          entry.isDir ? '—' : formatSize(entry.size)
        }}</span>
        <span
          class="file-cell-time file-meta"
          role="gridcell"
          :title="`${formatLocalModified(entry.modified)}${entry.permissions ? ' · ' + entry.permissions : ''}`"
          >{{ formatLocalModified(entry.modified) }}</span
        >
        <div class="file-actions" role="gridcell">
          <button
            class="icon-button"
            type="button"
            :aria-label="`${entry.name} 的操作`"
            tabindex="-1"
            @click.stop="emit('menu', $event, entry)"
          >
            <UiIcon name="more" size="14" />
          </button>
        </div>
      </div>
    </div>
    <footer class="file-pane-footer">
      <span v-if="b.refreshing" role="status">正在更新目录…</span
      ><span v-else-if="updated">更新于 {{ updated }}</span
      ><span v-else>选择目录开始浏览</span
      ><span v-if="b.selected.length">{{ b.selected.length }} 项已选</span>
    </footer>
    <div v-if="dropActive || dropHover" class="remote-drop-overlay">
      <UiIcon name="upload" size="26" /><strong>释放后上传到此目录</strong><span>{{ b.path }}</span>
    </div>
  </section>
</template>
