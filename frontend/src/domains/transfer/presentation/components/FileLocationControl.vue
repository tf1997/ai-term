<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import UiIcon from '../../../../shared/ui/UiIcon.vue'
import { trapTabFocus } from '../../../../shared/ui/overlays'
const props = defineProps<{
  label: string
  path: string
  draft: string
  disabled?: boolean
  active?: boolean
  breadcrumbs: { label: string; path: string }[]
  recent: string[]
  bookmarks: string[]
  roots?: string[]
  suggest: (draft: string) => Promise<string[]>
}>()
const emit = defineEmits<{
  'update:draft': [value: string]
  navigate: [path: string]
  bookmark: [path: string]
}>()
const id = useId(),
  editing = ref(false),
  input = ref<HTMLInputElement | null>(null),
  trigger = ref<HTMLButtonElement | null>(null)
const menuOpen = ref(false),
  menuStyle = ref({ left: '0px', top: '0px' }),
  suggestions = ref<string[]>([])
const completions = computed(() =>
  [...new Set([...suggestions.value, ...props.bookmarks, ...props.recent, ...(props.roots ?? [])])].slice(
    0,
    80,
  ),
)
let timer: ReturnType<typeof setTimeout> | undefined,
  request = 0
function edit() {
  if (props.disabled) return
  editing.value = true
  void nextTick(() => {
    input.value?.focus()
    input.value?.select()
  })
}
function cancelEdit() {
  editing.value = false
  emit('update:draft', props.path)
}
function open(path = props.draft) {
  if (props.disabled || !path.trim()) return
  menuOpen.value = false
  editing.value = false
  emit('navigate', path)
}
function closeMenu() {
  menuOpen.value = false
  void nextTick(() => trigger.value?.focus())
}
function toggleMenu() {
  if (props.disabled) return
  const rect = trigger.value?.getBoundingClientRect()
  if (!rect) return
  menuStyle.value = {
    left: `${Math.max(8, Math.min(rect.right - 340, window.innerWidth - 348))}px`,
    top: `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 350))}px`,
  }
  menuOpen.value = !menuOpen.value
  if (menuOpen.value)
    void nextTick(() =>
      document.getElementById(`${id}-menu`)?.querySelector<HTMLButtonElement>('button')?.focus(),
    )
}
watch(
  () => [props.active, props.disabled],
  () => {
    if (props.active === false || props.disabled) {
      menuOpen.value = false
      clearTimeout(timer)
      request++
    }
  },
)
watch(
  () => [props.draft, editing.value] as const,
  ([draft, active]) => {
    clearTimeout(timer)
    const current = ++request
    if (!active) return
    timer = setTimeout(async () => {
      const values = await props.suggest(draft)
      if (current === request) suggestions.value = values
    }, 180)
  },
)
onBeforeUnmount(() => {
  clearTimeout(timer)
  request++
})
defineExpose({ focus: edit, isEditing: () => editing.value })
</script>

<template>
  <div class="file-location-control">
    <div class="file-location-value" @dblclick="edit">
      <input
        v-if="editing"
        :id="id"
        ref="input"
        :value="draft"
        :aria-label="`${label}目录路径`"
        :list="`${id}-suggestions`"
        :disabled="disabled"
        @input="emit('update:draft', ($event.target as HTMLInputElement).value)"
        @keydown.enter.prevent.stop="open()"
        @keydown.esc.prevent.stop="cancelEdit"
      />
      <nav v-else class="file-location-crumbs" :aria-label="`${label}目录`" @click.self="edit">
        <button
          v-for="crumb in breadcrumbs"
          :key="crumb.path"
          type="button"
          :title="crumb.path"
          :disabled="disabled"
          @click="open(crumb.path)"
        >
          {{ crumb.label }}
        </button>
        <button
          v-if="!breadcrumbs.length"
          class="file-location-placeholder"
          type="button"
          :disabled="disabled"
          @click="edit"
        >
          输入目录路径
        </button>
      </nav>
      <button
        class="icon-button"
        type="button"
        :aria-label="`编辑${label}目录路径`"
        title="输入路径 · Ctrl+L"
        :disabled="disabled"
        @click="editing ? open() : edit()"
      >
        <UiIcon :name="editing ? 'arrow-right' : 'edit'" size="14" />
      </button>
    </div>
    <button
      ref="trigger"
      class="icon-button"
      type="button"
      :aria-label="`${label}收藏与最近目录`"
      :aria-expanded="menuOpen"
      :aria-controls="`${id}-menu`"
      title="收藏与最近目录"
      :disabled="disabled"
      @click="toggleMenu"
    >
      <UiIcon name="history" size="15" />
    </button>
    <datalist :id="`${id}-suggestions`">
      <option v-for="value in completions" :key="value" :value="value" />
    </datalist>
    <Teleport to="body">
      <div v-if="menuOpen" class="file-popover-scrim" @click="closeMenu" @contextmenu.prevent="closeMenu" />
      <section
        v-if="menuOpen"
        :id="`${id}-menu`"
        class="file-location-menu"
        :style="menuStyle"
        role="dialog"
        :aria-label="`${label}快捷目录`"
        @keydown.esc.prevent.stop="closeMenu"
        @keydown="trapTabFocus($event, $event.currentTarget as HTMLElement)"
      >
        <header>
          <strong>{{ label }}快捷目录</strong
          ><button class="icon-button" type="button" aria-label="关闭快捷目录" @click="closeMenu">
            <UiIcon name="close" size="14" />
          </button>
        </header>
        <button class="file-bookmark-current" type="button" :disabled="!path" @click="emit('bookmark', path)">
          <UiIcon name="pin" size="14" />{{ bookmarks.includes(path) ? '取消收藏当前目录' : '收藏当前目录' }}
        </button>
        <div v-if="roots?.length" class="file-location-section">
          <strong>根目录</strong
          ><button v-for="root in roots" :key="root" type="button" @click="open(root)">{{ root }}</button>
        </div>
        <div class="file-location-section">
          <strong>收藏</strong
          ><button v-for="item in bookmarks" :key="item" type="button" :title="item" @click="open(item)">
            {{ item }}
          </button>
          <p v-if="!bookmarks.length">常用目录可以在这里收藏。</p>
        </div>
        <div class="file-location-section">
          <strong>最近访问</strong
          ><button v-for="item in recent" :key="item" type="button" :title="item" @click="open(item)">
            {{ item }}
          </button>
          <p v-if="!recent.length">打开目录后会自动记录。</p>
        </div>
      </section>
    </Teleport>
  </div>
</template>
