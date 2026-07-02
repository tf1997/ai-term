<script setup lang="ts">
interface ContextMenuItem {
  id: string
  label: string
  danger?: boolean
  disabled?: boolean
  action: () => void
}

defineProps<{
  x: number
  y: number
  title?: string
  items: ContextMenuItem[]
}>()

const emit = defineEmits<{
  close: []
}>()

function runItem(item: ContextMenuItem) {
  if (item.disabled) return
  item.action()
  emit('close')
}
</script>

<template>
  <teleport to="body">
    <div class="context-menu-scrim" role="presentation" @click="emit('close')" @contextmenu.prevent="emit('close')" />
    <section class="context-menu" role="menu" :style="{ left: `${x}px`, top: `${y}px` }">
      <strong v-if="title">{{ title }}</strong>
      <button
        v-for="item in items"
        :key="item.id"
        type="button"
        role="menuitem"
        :class="{ danger: item.danger }"
        :disabled="item.disabled"
        @click="runItem(item)"
      >
        {{ item.label }}
      </button>
    </section>
  </teleport>
</template>
