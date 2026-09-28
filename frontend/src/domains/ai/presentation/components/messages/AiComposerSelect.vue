<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import UiIcon from '../../../../../shared/ui/UiIcon.vue'

const props = defineProps<{
  modelValue: string
  label: string
  title?: string
  icon?: 'terminal' | 'file' | 'eye-off'
  disabled?: boolean
  options: { value: string; label: string; description?: string }[]
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const root = ref<HTMLElement>()
const trigger = ref<HTMLButtonElement>()
const menu = ref<HTMLElement>()
const open = ref(false)

async function toggle() {
  if (props.disabled) return
  open.value = !open.value
  if (open.value) {
    await nextTick()
    const options = menu.value?.querySelectorAll<HTMLButtonElement>('[role="option"]')
    const index = Math.max(0, props.options.findIndex(option => option.value === props.modelValue))
    options?.[index]?.focus()
  }
}
function close(restoreFocus = false) {
  open.value = false
  if (restoreFocus) trigger.value?.focus()
}
function select(value: string) {
  if (props.disabled) return
  emit('update:modelValue', value)
  close(true)
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
  const options = Array.from(menu.value?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])
  const index = options.indexOf(document.activeElement as HTMLButtonElement)
  if ((event.key === 'Enter' || event.key === ' ') && index >= 0) {
    event.preventDefault()
    options[index].click()
    return
  }
  const next = event.key === 'ArrowDown' ? (index + 1) % options.length
    : event.key === 'ArrowUp' ? (index - 1 + options.length) % options.length
    : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : -1
  if (next >= 0) { event.preventDefault(); options[next]?.focus() }
}
function outside(event: PointerEvent) {
  if (event.target instanceof Node && !root.value?.contains(event.target)) close()
}
function focusout(event: FocusEvent) {
  if (event.relatedTarget instanceof Node && !root.value?.contains(event.relatedTarget)) close()
}
watch(() => props.disabled, disabled => { if (disabled) close() })
onMounted(() => document.addEventListener('pointerdown', outside, true))
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside, true))
</script>

<template>
  <div ref="root" class="composer-select" :class="{ 'icon-only': icon }" @focusout="focusout">
    <button ref="trigger" class="composer-select-trigger" :class="{ 'is-open': open }" type="button"
      :disabled="disabled" :title="title || label" :aria-label="label" aria-haspopup="listbox" :aria-expanded="open"
      @click="toggle" @keydown.down.prevent="!open && toggle()" @keydown.up.prevent="!open && toggle()">
      <UiIcon v-if="icon" :name="icon" size="16" />
      <template v-else>
        <span>{{ options.find(option => option.value === modelValue)?.label || modelValue || label }}</span>
        <UiIcon name="chevron-right" size="12" class="select-chevron" />
      </template>
    </button>
    <div v-if="open" ref="menu" class="composer-select-menu" role="listbox" :aria-label="label" @keydown="keydown">
      <div class="composer-select-heading">{{ label }}</div>
      <button v-for="option in options" :key="option.value" type="button" role="option" tabindex="-1" :data-value="option.value" :aria-selected="option.value === modelValue"
        class="composer-select-option" @click="select(option.value)">
        <span class="composer-select-copy"><span>{{ option.label }}</span><small v-if="option.description">{{ option.description }}</small></span>
        <UiIcon v-if="option.value === modelValue" name="check" size="15" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.composer-select { position: static; min-width: 0; }
.composer-select-trigger { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; height: 30px; min-height: 30px; padding: 0 7px; border: 0; border-radius: 5px; background: transparent; color: var(--chat-muted); font: inherit; font-size: 12px; cursor: pointer; }
.composer-select-trigger > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.composer-select-trigger .ui-icon { flex: none; }
.composer-select-trigger:hover:not(:disabled), .composer-select-trigger.is-open { background: var(--chat-hover); color: var(--chat-text); }
.composer-select-trigger:disabled { opacity: .45; cursor: default; }
.composer-select-trigger:focus-visible { outline: 2px solid var(--chat-muted); outline-offset: -2px; }
.select-chevron { transform: rotate(90deg); }
.is-open .select-chevron { transform: rotate(-90deg); }
.icon-only { flex: 0 0 30px; }
.icon-only .composer-select-trigger { padding: 0; }
.composer-select-menu { position: absolute; z-index: 20; bottom: calc(100% + 8px); left: 0; width: 256px; max-width: calc(100cqw - 32px); max-height: min(320px, 50vh); overflow: auto; padding: 5px; border: 1px solid var(--chat-line); border-radius: 9px; background: var(--chat-surface); color: var(--chat-text); box-shadow: 0 6px 24px #00000024; }
.icon-only .composer-select-menu { left: auto; right: 0; }
.composer-select-heading { padding: 6px 8px 7px; font-size: 11px; color: var(--chat-muted); }
.composer-select-option { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 42px; padding: 8px; border: 0; border-radius: 5px; background: transparent; color: var(--chat-text); text-align: left; cursor: pointer; }
.composer-select-option:hover, .composer-select-option:focus-visible { background: var(--chat-hover); outline: none; }
.composer-select-option[aria-selected="true"] { background: var(--chat-accent-soft); }
.composer-select-option > .ui-icon { flex: none; color: var(--chat-accent); }
.composer-select-copy { display: grid; gap: 3px; flex: 1; min-width: 0; font-size: 12px; overflow-wrap: anywhere; }
.composer-select-copy small { color: var(--chat-muted); font-size: 11px; line-height: 1.5; }
</style>
