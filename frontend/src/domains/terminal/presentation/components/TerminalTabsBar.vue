<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRef, watch } from 'vue'
import type { TerminalTab } from '../../domain/terminal'
import { terminalStatusClass, terminalTitleOrdinals } from '../../domain/terminalTabs'
import { useTerminalTabScroll } from '../../application/useTerminalTabScroll'
import UiIcon from '../../../../shared/ui/UiIcon.vue'
import { isMenuOwnedBy } from '../../../../shared/ui/contextMenuInteraction'

const props = defineProps<{
  terminalTabs: readonly TerminalTab[]
  activeTerminalId: string
  targetTerminalIds: readonly string[]
  pausedTerminalIds: readonly string[]
  terminalTargetTitle: string
}>()

const emit = defineEmits<{
  select: [terminalId: string]
  close: [terminalId: string]
  closeOthers: [terminalId: string]
  create: []
  toggleTarget: [terminalId: string]
  setTargets: [terminalIds: string[]]
  selectAllTargets: []
  resetTargets: []
  contextMenu: [event: MouseEvent, tab: TerminalTab]
  openPopover: []
  focusTerminal: []
}>()

const {
  sessionTabStrip, sessionTabOverflow, sessionTabCanScrollLeft, sessionTabCanScrollRight,
  setSessionTabButton, handleSessionTabScroll, handleSessionTabWheel, scrollSessionTabs
} = useTerminalTabScroll({
  terminalTabs: toRef(props, 'terminalTabs'),
  activeTerminalId: toRef(props, 'activeTerminalId')
})

type PopoverMode = 'terminals' | 'sync'
const popoverMode = ref<PopoverMode | null>(null)
const popover = ref<HTMLElement | null>(null)
const listButton = ref<HTMLButtonElement | null>(null)
const syncButton = ref<HTMLButtonElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
const terminalList = ref<HTMLUListElement | null>(null)
const terminalSearch = ref('')
const tabButtons = new Map<string, HTMLButtonElement>()
const targetIds = computed(() => new Set(props.targetTerminalIds))
const pausedIds = computed(() => new Set(props.pausedTerminalIds))
const syncing = computed(() => props.targetTerminalIds.length > 1)
const pausedCount = computed(() => props.targetTerminalIds.filter(id => pausedIds.value.has(id)).length)
const filteredTabs = computed(() => {
  const query = terminalSearch.value.trim().toLocaleLowerCase()
  return props.terminalTabs.filter(tab => [tab.title, tab.profile?.name, tab.profile?.target.host, displayTitle(tab)]
    .some(value => value?.toLocaleLowerCase().includes(query)))
})
const allVisibleSelected = computed(() => filteredTabs.value.every(tab => targetIds.value.has(tab.id)))
const titleOrdinals = computed(() => terminalTitleOrdinals(props.terminalTabs))

function displayTitle(tab: TerminalTab) {
  const ordinal = titleOrdinals.value.get(tab.id)
  return ordinal ? `${tab.title} · ${ordinal}` : tab.title
}

function statusLabel(tab: TerminalTab) {
  return {
    idle: '未连接', connecting: '连接中', local: '本地会话', remote: '已连接',
    sftp: 'SFTP', preview: '预览', error: '连接失败'
  }[tab.status]
}

function tabDescription(tab: TerminalTab) {
  return [tab.profile?.name, statusLabel(tab)].filter(Boolean).join(' · ')
}

function tabTitle(tab: TerminalTab) {
  const syncState = syncing.value && targetIds.value.has(tab.id)
    ? pausedIds.value.has(tab.id) ? '键盘同步已暂停，空提示符时自动恢复' : '同步输入目标'
    : ''
  return [displayTitle(tab), tabDescription(tab), syncState].filter(Boolean).join('\n')
}

function registerTabButton(tabId: string, element: unknown) {
  setSessionTabButton(tabId, element)
  if (element instanceof HTMLButtonElement) tabButtons.set(tabId, element)
  else tabButtons.delete(tabId)
}

function closePopover(restoreFocus = false) {
  const trigger = popoverMode.value === 'sync' ? syncButton.value : listButton.value
  popoverMode.value = null
  if (restoreFocus) trigger?.focus({ preventScroll: true })
}

function togglePopover(mode: PopoverMode) {
  if (popoverMode.value === mode) {
    closePopover(true)
    return
  }
  emit('openPopover')
  popoverMode.value = mode
  terminalSearch.value = ''
  void nextTick(() => {
    searchInput.value?.focus({ preventScroll: true })
    revealListEntry(terminalList.value?.querySelector<HTMLElement>('.terminal-switcher-row.active'))
  })
}

function selectTab(tabId: string, focusTerminal = true) {
  closePopover()
  emit('select', tabId)
  if (focusTerminal) emit('focusTerminal')
  else void nextTick(() => tabButtons.get(tabId)?.focus({ preventScroll: true }))
}

function handleTabKeydown(event: KeyboardEvent, tabId: string) {
  if (document.querySelector('.context-menu')) return
  if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return
  const tabs = props.terminalTabs
  const index = tabs.findIndex(tab => tab.id === tabId)
  let nextIndex: number
  if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length
  else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length
  else if (event.key === 'Home') nextIndex = 0
  else if (event.key === 'End') nextIndex = tabs.length - 1
  else if (event.key === 'Delete' && tabs.length > 1) {
    event.preventDefault()
    emit('close', tabId)
    void nextTick(() => tabButtons.get(props.activeTerminalId)?.focus({ preventScroll: true }))
    return
  } else return
  event.preventDefault()
  selectTab(tabs[nextIndex].id, false)
}

function openTabMenu(event: MouseEvent, tab: TerminalTab) {
  if (!(event.currentTarget instanceof Node) || !popover.value?.contains(event.currentTarget)) closePopover()
  emit('contextMenu', event, tab)
}

function openKeyboardMenu(event: KeyboardEvent, tab: TerminalTab) {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
  event.preventDefault()
  event.stopPropagation()
  const target = event.currentTarget as HTMLElement
  target.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)')?.focus({ preventScroll: true })
  const rect = target.getBoundingClientRect()
  target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 12, clientY: rect.bottom }))
}

function handleMiddleClick(event: MouseEvent, tabId: string) {
  if (event.button !== 1) return
  event.preventDefault()
  emit('close', tabId)
}

function closeTab(tabId: string, event: MouseEvent) {
  emit('close', tabId)
  if (event.detail === 0) {
    void nextTick(() => tabButtons.get(props.activeTerminalId)?.focus({ preventScroll: true }))
  } else emit('focusTerminal')
}

function selectVisibleTargets() {
  if (terminalSearch.value.trim()) {
    emit('setTargets', [...new Set([...props.targetTerminalIds, ...filteredTabs.value.map(tab => tab.id)])])
  } else emit('selectAllTargets')
}

function stopSync() {
  emit('resetTargets')
  closePopover()
  emit('focusTerminal')
}

function closeOtherTabs() {
  emit('closeOthers', props.activeTerminalId)
  closePopover(true)
}

function closeListTab(tabId: string) {
  emit('close', tabId)
  void nextTick(() => searchInput.value?.focus({ preventScroll: true }))
}

function revealListEntry(element?: HTMLElement | null) {
  const list = terminalList.value
  const row = element?.closest<HTMLElement>('.terminal-switcher-row')
  if (!list || !row) return
  const listBounds = list.getBoundingClientRect()
  const rowBounds = row.getBoundingClientRect()
  if (rowBounds.top < listBounds.top) list.scrollTop += rowBounds.top - listBounds.top
  else if (rowBounds.bottom > listBounds.bottom) list.scrollTop += rowBounds.bottom - listBounds.bottom
}

function handleListKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
  const entries = Array.from(popover.value?.querySelectorAll<HTMLElement>(
    '.terminal-switcher-select, .terminal-sync-option input:not(:disabled)'
  ) ?? [])
  if (event.key === 'Enter' && event.target === searchInput.value && popoverMode.value === 'terminals') {
    const tab = terminalSearch.value.trim() ? filteredTabs.value[0] : props.terminalTabs.find(tab => tab.id === props.activeTerminalId)
    if (tab) { event.preventDefault(); selectTab(tab.id) }
    return
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  if (!entries.length) return
  event.preventDefault()
  const focusedRow = document.activeElement?.closest('.terminal-switcher-row')
  const index = entries.findIndex(entry => focusedRow?.contains(entry))
  const nextIndex = index < 0 ? (event.key === 'ArrowDown' ? 0 : entries.length - 1)
    : (index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length
  entries[nextIndex].focus({ preventScroll: true })
  revealListEntry(entries[nextIndex])
}

function dismissOutside(event: Event) {
  if (!popoverMode.value || !(event.target instanceof Node)) return
  if (isMenuOwnedBy(event.target, 'terminal-tabs-popover')) return
  if (popover.value?.contains(event.target) || listButton.value?.contains(event.target) || syncButton.value?.contains(event.target)) return
  closePopover()
}

function handleGlobalKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.defaultPrevented) return
  if (document.querySelector('.context-menu')) return
  if (event.key === 'Escape' && popoverMode.value) {
    event.preventDefault()
    event.stopPropagation()
    closePopover(true)
  } else if (event.key === 'Tab' && event.ctrlKey && !event.metaKey && !event.altKey && props.terminalTabs.length > 1
    && !document.querySelector('[aria-modal="true"], .modal-backdrop, .context-menu')) {
    event.preventDefault()
    event.stopPropagation()
    const index = props.terminalTabs.findIndex(tab => tab.id === props.activeTerminalId)
    const next = (index + (event.shiftKey ? -1 : 1) + props.terminalTabs.length) % props.terminalTabs.length
    selectTab(props.terminalTabs[next].id)
  }
}

watch(terminalSearch, () => {
  if (terminalList.value) terminalList.value.scrollTop = 0
}, { flush: 'post' })

onMounted(() => {
  document.addEventListener('pointerdown', dismissOutside)
  document.addEventListener('focusin', dismissOutside)
  window.addEventListener('keydown', handleGlobalKeydown, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', dismissOutside)
  document.removeEventListener('focusin', dismissOutside)
  window.removeEventListener('keydown', handleGlobalKeydown, true)
  tabButtons.clear()
})
</script>

<template>
  <nav class="session-tabs" aria-label="终端会话">
    <div class="session-tab-scrollarea" :class="{ 'can-scroll-left': sessionTabCanScrollLeft, 'can-scroll-right': sessionTabCanScrollRight }">
      <div ref="sessionTabStrip" class="session-tab-strip" role="tablist" aria-label="终端标签" @scroll="handleSessionTabScroll" @wheel="handleSessionTabWheel">
        <div
          v-for="tab in terminalTabs"
          :key="tab.id"
          class="tab"
          role="presentation"
          :data-terminal-id="tab.id"
          :class="{ active: tab.id === activeTerminalId, target: syncing && targetIds.has(tab.id), 'sync-paused': pausedIds.has(tab.id) }"
          @contextmenu.prevent.stop="openTabMenu($event, tab)"
          @keydown="openKeyboardMenu($event, tab)"
          @mousedown="($event.button === 1) && $event.preventDefault()"
          @auxclick="handleMiddleClick($event, tab.id)"
        >
          <button
            :id="`terminal-tab-${tab.id}`"
            :ref="element => registerTabButton(tab.id, element)"
            type="button"
            class="tab-select"
            role="tab"
            :aria-selected="tab.id === activeTerminalId"
            :aria-controls="`terminal-panel-${tab.id}`"
            :tabindex="tab.id === activeTerminalId ? 0 : -1"
            :title="tabTitle(tab)"
            @click="selectTab(tab.id)"
            @keydown="handleTabKeydown($event, tab.id)"
          >
            <span class="status-dot" :class="terminalStatusClass(tab.status)" aria-hidden="true" />
            <span class="tab-title">{{ tab.title }}</span>
            <span v-if="titleOrdinals.has(tab.id)" class="tab-ordinal">{{ titleOrdinals.get(tab.id) }}</span>
            <UiIcon v-if="syncing && targetIds.has(tab.id)" class="tab-sync-icon" :name="pausedIds.has(tab.id) ? 'alert' : 'network'" size="12" />
          </button>
          <button v-if="terminalTabs.length > 1" type="button" class="tab-close" :tabindex="tab.id === activeTerminalId ? 0 : -1" :title="`关闭 ${displayTitle(tab)}`" :aria-label="`关闭 ${displayTitle(tab)}`" @click.stop="closeTab(tab.id, $event)">
            <UiIcon name="close" size="12" />
          </button>
        </div>
      </div>
    </div>
    <div class="session-tab-actions">
      <div v-if="sessionTabOverflow" class="session-tab-navigation" aria-label="滚动终端标签">
        <button type="button" class="session-tab-action session-tab-scroll-prev" title="向左滚动标签" aria-label="向左滚动标签" :disabled="!sessionTabCanScrollLeft" @click="scrollSessionTabs(-1)"><UiIcon name="arrow-left" size="14" /></button>
        <button type="button" class="session-tab-action session-tab-scroll-next" title="向右滚动标签" aria-label="向右滚动标签" :disabled="!sessionTabCanScrollRight" @click="scrollSessionTabs(1)"><UiIcon name="arrow-right" size="14" /></button>
      </div>
      <button type="button" class="session-tab-action terminal-new-tab" title="新建本地终端" aria-label="新建本地终端" @click="emit('create')"><UiIcon name="plus" size="16" /></button>
      <button ref="listButton" type="button" class="session-tab-action terminal-list-toggle" :class="{ open: popoverMode === 'terminals' }" :title="`全部终端（${terminalTabs.length}）`" :aria-label="`全部终端（${terminalTabs.length}）`" aria-haspopup="dialog" :aria-expanded="popoverMode === 'terminals'" aria-controls="terminal-tabs-popover" @click="togglePopover('terminals')">
        <UiIcon name="list" size="15" /><span class="terminal-tab-count">{{ terminalTabs.length }}</span>
      </button>
      <div class="session-sync-control" :class="{ active: syncing, paused: pausedCount > 0 }">
        <button ref="syncButton" type="button" class="terminal-target-summary" :class="{ active: syncing }" :title="terminalTargetTitle" aria-label="设置同步输入" aria-haspopup="dialog" :aria-expanded="popoverMode === 'sync'" aria-controls="terminal-tabs-popover" @click="togglePopover('sync')">
          <UiIcon name="network" size="14" />
          <span>{{ syncing ? `同步 ${targetTerminalIds.length}` : '同步输入' }}</span>
          <span v-if="pausedCount" class="terminal-sync-paused-count">暂停 {{ pausedCount }}</span>
        </button>
        <button v-if="syncing" type="button" class="terminal-sync-stop" title="停止同步，仅输入当前终端" aria-label="停止同步，仅输入当前终端" @click="stopSync"><UiIcon name="stop" size="12" /></button>
      </div>
    </div>

    <section v-if="popoverMode" id="terminal-tabs-popover" data-overlay-id="terminal-tabs-popover" ref="popover" class="terminal-tabs-popover" :data-mode="popoverMode" role="dialog" :aria-label="popoverMode === 'sync' ? '设置同步输入' : '全部终端'" @keydown="handleListKeydown">
      <div class="terminal-popover-heading">
        <strong>{{ popoverMode === 'sync' ? '同步输入' : '全部终端' }}</strong>
        <span>{{ popoverMode === 'sync' ? `已选 ${targetTerminalIds.length} / ${terminalTabs.length}` : `${terminalTabs.length} 个会话` }}</span>
        <button type="button" class="session-tab-action" :aria-label="popoverMode === 'sync' ? '关闭同步列表' : '关闭终端列表'" :title="`${popoverMode === 'sync' ? '关闭同步列表' : '关闭终端列表'}（Esc）`" @click="closePopover(true)"><UiIcon name="close" size="14" /></button>
      </div>
      <p v-if="popoverMode === 'sync'" class="terminal-sync-description">输入和命令会发送到勾选的终端。<br />切换到未选终端时结束同步。</p>
      <p v-if="popoverMode === 'sync' && pausedCount" class="terminal-sync-notice">{{ pausedCount }} 个终端的键盘同步已暂停，回到空提示符后自动恢复。</p>
      <div class="terminal-tab-search-field">
        <UiIcon name="search" size="15" />
        <input ref="searchInput" v-model="terminalSearch" class="terminal-tab-search" type="search" placeholder="搜索终端、主机或连接…" aria-label="搜索终端" autocomplete="off" spellcheck="false" />
      </div>
      <ul ref="terminalList" class="terminal-switcher-list">
        <li v-for="tab in filteredTabs" :key="tab.id" class="terminal-switcher-row" tabindex="-1" :data-terminal-id="tab.id" :class="{ active: tab.id === activeTerminalId, selected: popoverMode === 'sync' && targetIds.has(tab.id), 'sync-paused': pausedIds.has(tab.id) }" @contextmenu.prevent.stop="openTabMenu($event, tab)" @keydown="openKeyboardMenu($event, tab)">
          <label v-if="popoverMode === 'sync'" class="terminal-sync-option" :title="tab.id === activeTerminalId ? '当前终端始终接收输入' : tabTitle(tab)">
            <input type="checkbox" :checked="targetIds.has(tab.id)" :disabled="tab.id === activeTerminalId" :aria-label="`${displayTitle(tab)}${tab.id === activeTerminalId ? '（当前终端，始终接收输入）' : '，同步输入'}`" @change="emit('toggleTarget', tab.id)" />
            <span class="terminal-entry-copy"><strong>{{ displayTitle(tab) }}</strong><small>{{ tabDescription(tab) }}</small></span>
            <span v-if="tab.id === activeTerminalId" class="terminal-entry-badge">当前 · 必选</span>
            <span v-else-if="pausedIds.has(tab.id)" class="terminal-entry-badge paused">同步暂停</span>
          </label>
          <template v-else>
            <button type="button" class="terminal-switcher-select" :title="tabTitle(tab)" :aria-current="tab.id === activeTerminalId ? 'true' : undefined" @click="selectTab(tab.id)">
              <span class="status-dot" :class="terminalStatusClass(tab.status)" aria-hidden="true" />
              <span class="terminal-entry-copy"><strong>{{ displayTitle(tab) }}</strong><small>{{ tabDescription(tab) }}</small></span>
              <span v-if="tab.id === activeTerminalId" class="terminal-entry-badge">当前</span>
              <span v-else-if="syncing && targetIds.has(tab.id)" class="terminal-entry-badge" :class="{ paused: pausedIds.has(tab.id) }">{{ pausedIds.has(tab.id) ? '同步暂停' : '同步' }}</span>
            </button>
            <button v-if="terminalTabs.length > 1" type="button" class="terminal-entry-close" :title="`关闭 ${displayTitle(tab)}`" :aria-label="`关闭 ${displayTitle(tab)}`" @click="closeListTab(tab.id)"><UiIcon name="close" size="13" /></button>
          </template>
        </li>
        <li v-if="!filteredTabs.length" class="terminal-list-empty">没有找到匹配的终端</li>
      </ul>
      <div class="terminal-popover-footer">
        <template v-if="popoverMode === 'sync'">
          <button type="button" class="terminal-sync-select-all" :disabled="allVisibleSelected" @click="selectVisibleTargets">{{ terminalSearch.trim() ? '选中匹配项' : '全选终端' }}</button>
          <button type="button" class="terminal-sync-stop" :disabled="!syncing" @click="stopSync">停止同步</button>
        </template>
        <template v-else>
          <span>Ctrl + Tab 切换终端</span>
          <button type="button" class="terminal-close-others" :disabled="terminalTabs.length <= 1" :title="`保留当前终端，关闭其他 ${terminalTabs.length - 1} 个终端`" @click="closeOtherTabs">关闭其他终端</button>
        </template>
      </div>
    </section>
  </nav>
</template>
