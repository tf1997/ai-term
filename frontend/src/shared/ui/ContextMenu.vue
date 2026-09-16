<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ContextMenuItem } from './overlays'
import { activateMenuLayer, nextMenuIndex, placeContextMenu } from './contextMenuInteraction'

const props = defineProps<{
  x: number
  y: number
  title?: string
  description?: string
  sourceElement?: HTMLElement
  parentId?: string
  items: readonly ContextMenuItem[]
}>()

const emit = defineEmits<{ close: [] }>()
const menu = ref<HTMLElement | null>(null)
const position = ref({ x: props.x, y: props.y })
const ready = ref(false)
let source = props.sourceElement ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined)
let ownerModal = source?.closest('[aria-modal="true"], .modal-backdrop')
let layer: ReturnType<typeof activateMenuLayer> | undefined
let resizeObserver: ResizeObserver | undefined
let modalObserver: MutationObserver | undefined
let closing = false
let disposed = false

function buttons() {
  return Array.from(menu.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
}

function positionMenu() {
  if (!menu.value) return
  const bounds = menu.value.getBoundingClientRect()
  position.value = placeContextMenu(props.x, props.y, bounds.width, bounds.height, window.innerWidth, window.innerHeight)
  ready.value = true
}

function restoreSourceFocus() {
  if (source?.isConnected) {
    source.focus({ preventScroll: true })
    return
  }
  const owner = props.parentId ? document.getElementById(props.parentId) : undefined
  const fallback = owner?.querySelector<HTMLElement>('.terminal-switcher-select, .terminal-sync-option input:not(:disabled), input')
    ?? document.querySelector<HTMLElement>('.tab-select[aria-selected="true"]')
  fallback?.focus({ preventScroll: true })
}

function close(restoreFocus = false) {
  if (closing) return
  closing = true
  layer?.release()
  emit('close')
  if (restoreFocus) void nextTick(restoreSourceFocus)
}

function runItem(item: ContextMenuItem) {
  if (item.disabled) return
  // Returning focus before the action lets a newly opened dialog own its initial focus.
  if (item.restoreFocus !== false) restoreSourceFocus()
  close()
  item.action()
  if (item.restoreFocus !== false) void nextTick(() => {
    if (!source?.isConnected && (document.activeElement === document.body || document.activeElement === menu.value)) restoreSourceFocus()
  })
}

function handleKeydown(event: KeyboardEvent) {
  if (!layer?.isTop() || event.isComposing) return
  const key = event.key
  if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' ', 'Escape', 'Tab'].includes(key)) return
  event.stopImmediatePropagation()
  if (key === 'Tab') {
    // A nonmodal menu exits into the normal tab order from its trigger.
    restoreSourceFocus()
    close()
    return
  }
  event.preventDefault()
  if (key === 'Escape') { close(true); return }
  const enabled = buttons()
  if (key === 'Enter' || key === ' ') {
    enabled.find(button => button === document.activeElement)?.click()
  } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) {
    const index = nextMenuIndex(enabled.length, enabled.indexOf(document.activeElement as HTMLButtonElement), key)
    enabled[index]?.focus({ preventScroll: true })
    enabled[index]?.scrollIntoView({ block: 'nearest' })
  }
}

function dismissOutside(event: Event) {
  if (!layer?.isTop() || !(event.target instanceof Node) || menu.value?.contains(event.target)) return
  // Other right-click targets receive the original gesture and can replace this menu.
  close()
}

async function prepareMenu() {
  if (closing) layer = activateMenuLayer(() => close())
  closing = false
  source = props.sourceElement ?? source
  ownerModal = source?.closest('[aria-modal="true"], .modal-backdrop')
  ready.value = false
  await nextTick()
  if (closing || disposed) return
  positionMenu()
  await nextTick()
  if (closing || disposed) return
  ;(buttons()[0] ?? menu.value)?.focus({ preventScroll: true })
}

watch(() => [props.x, props.y, props.items, props.sourceElement], () => void prepareMenu())

onMounted(() => {
  layer = activateMenuLayer(() => close())
  window.addEventListener('keydown', handleKeydown, true)
  window.addEventListener('pointerdown', dismissOutside, true)
  window.addEventListener('focusin', dismissOutside)
  window.addEventListener('resize', positionMenu)
  resizeObserver = new ResizeObserver(positionMenu)
  if (menu.value) resizeObserver.observe(menu.value)
  modalObserver = new MutationObserver(() => {
    const modals = document.querySelectorAll<HTMLElement>('[aria-modal="true"], .modal-backdrop')
    if ([...modals].some(modal => modal.getClientRects().length && modal !== ownerModal && !modal.contains(source ?? null))) close()
  })
  modalObserver.observe(document.body, { childList: true, subtree: true })
  void prepareMenu()
})

onBeforeUnmount(() => {
  disposed = true
  layer?.release()
  resizeObserver?.disconnect()
  modalObserver?.disconnect()
  window.removeEventListener('keydown', handleKeydown, true)
  window.removeEventListener('pointerdown', dismissOutside, true)
  window.removeEventListener('focusin', dismissOutside)
  window.removeEventListener('resize', positionMenu)
})
</script>

<template>
  <teleport to="body">
    <section ref="menu" class="context-menu" :class="{ 'context-menu-in-modal': ownerModal }" role="menu" tabindex="-1"
      :aria-label="title || '操作菜单'" :data-menu-parent="parentId" :style="{ left: `${position.x}px`, top: `${position.y}px`, visibility: ready ? 'visible' : 'hidden' }"
      @contextmenu.prevent.stop>
      <strong v-if="title" :title="title">{{ title }}</strong>
      <p v-if="description" class="context-menu-description">{{ description }}</p>
      <template v-for="(item, index) in items" :key="item.id">
        <hr v-if="index > 0 && item.group !== items[index - 1].group" role="separator" />
        <button type="button" role="menuitem" tabindex="-1" :class="{ danger: item.danger }" :disabled="item.disabled"
          :title="item.disabled ? item.disabledReason : undefined" @click.stop="runItem(item)">
          <span>{{ item.label }}</span>
          <small v-if="item.disabled && item.disabledReason">{{ item.disabledReason }}</small>
        </button>
      </template>
    </section>
  </teleport>
</template>
