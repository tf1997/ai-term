<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import UiIcon from '../../../../../shared/ui/UiIcon.vue'
import { useCopyFeedback } from './useCopyFeedback'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  content: string
  label?: string
  kind?: 'command' | 'output' | 'code'
  flat?: boolean
  full?: boolean
  emptyText?: string
}>(), {
  label: '代码',
  kind: 'code',
  flat: false,
  full: false,
  emptyText: '无输出'
})

const { copyFeedback, copyText } = useCopyFeedback()
const previewOpen = ref(false)
const previewWrap = ref(false)
const codeBlock = ref<HTMLElement | null>(null)
const previewTheme = ref<Record<string, string>>({})
const previewDialog = ref<HTMLElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)
let returnFocus: HTMLElement | null = null
const copyLabel = computed(() => copyFeedback.value || `复制${props.label}`)
const expandLabel = computed(() => `展开${props.label}`)

async function openPreview() {
  returnFocus = document.activeElement as HTMLElement | null
  if (codeBlock.value) {
    const style = getComputedStyle(codeBlock.value)
    // Teleported dialogs retain the active workbench theme outside the panel.
    const tokens = ['--chat-text', '--chat-muted', '--chat-surface', '--chat-subtle', '--chat-line', '--chat-accent', '--chat-button', '--workbench-text', '--workbench-muted', '--workbench-panel', '--workbench-panel-strong', '--workbench-line', '--workbench-accent', '--font-mono']
    previewTheme.value = Object.fromEntries(tokens.map((token) => [token, style.getPropertyValue(token).trim()]).filter(([, value]) => value))
  }
  previewWrap.value = props.kind === 'command'
  previewOpen.value = true
  await nextTick()
  closeButton.value?.focus()
}

function closePreview() {
  previewOpen.value = false
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
  returnFocus = null
}

function handleDialogKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closePreview()
    return
  }
  if (event.key !== 'Tab') return
  const elements = [...(previewDialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input, [tabindex="0"]') ?? [])]
  const first = elements[0]
  const last = elements[elements.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}

onBeforeUnmount(() => {
  if (previewOpen.value && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
})
</script>

<template>
  <section ref="codeBlock" v-bind="$attrs" class="tool-code" :class="[{ 'tool-code-flat': flat, 'tool-code-full': full }, `tool-code-${kind}`]" :aria-label="label">
    <div class="tool-code-toolbar">
      <div class="tool-code-meta">
        <span class="tool-code-label">{{ label }}</span>
        <slot name="meta" />
      </div>
      <div class="tool-code-actions">
        <span class="tool-code-feedback" role="status" aria-live="polite">{{ copyFeedback }}</span>
        <button class="tool-code-icon" type="button" :title="copyLabel" :aria-label="copyLabel" :disabled="!content" @click="copyText(content)">
          <UiIcon name="copy" size="14" />
        </button>
        <button v-if="content" class="tool-code-icon" type="button" :title="expandLabel" :aria-label="expandLabel" @click="openPreview">
          <UiIcon name="maximize" size="14" />
        </button>
        <slot name="actions" />
      </div>
    </div>
    <pre v-if="content" class="tool-code-content" tabindex="0" :aria-label="`${label}内容`"><code>{{ content }}</code></pre>
    <p v-else class="tool-code-empty">{{ emptyText }}</p>
  </section>

  <Teleport to="body">
    <div v-if="previewOpen" class="tool-preview-backdrop" :style="previewTheme" @click.self="closePreview">
      <section ref="previewDialog" class="tool-preview-dialog" role="dialog" aria-modal="true" :aria-label="`${label}详情`" @keydown="handleDialogKey">
        <header class="tool-preview-header">
          <strong>{{ label }}详情</strong>
          <div class="tool-preview-actions">
            <button class="tool-code-icon" type="button" :title="copyLabel" :aria-label="copyLabel" @click="copyText(content)">
              <UiIcon name="copy" size="15" />
            </button>
            <button ref="closeButton" class="tool-code-icon" type="button" title="关闭" aria-label="关闭" @click="closePreview">
              <UiIcon name="close" size="17" />
            </button>
          </div>
        </header>
        <div class="tool-preview-options">
          <label><input v-model="previewWrap" type="checkbox">自动换行</label>
          <div class="tool-preview-actions">
            <span role="status" aria-live="polite">{{ copyFeedback }}</span>
            <slot name="preview-actions" :close="closePreview" />
          </div>
        </div>
        <pre class="tool-preview-content" :class="{ 'is-wrapped': previewWrap }" tabindex="0"><code>{{ content }}</code></pre>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.tool-code {
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  overflow: hidden;
  border: 1px solid var(--chat-line, var(--workbench-line));
  border-radius: 7px;
  background: var(--chat-subtle, var(--workbench-panel));
  color: var(--chat-text, var(--workbench-text));
  letter-spacing: 0;
}
.tool-code-flat { border: 0; border-radius: 0; }
.tool-code-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 35px; padding: 2px 8px 2px 12px; }
.tool-code-meta, .tool-code-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; min-width: 0; }
.tool-code-meta { min-height: 28px; }
.tool-code-meta .ui-icon, .tool-code-actions .ui-icon { display: block; flex: 0 0 auto; }
.tool-code-actions { position: relative; flex: 0 0 auto; justify-content: flex-end; gap: 3px; }
.tool-code-label { color: var(--chat-muted, var(--workbench-muted)); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
.tool-code-icon { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; flex: 0 0 28px; padding: 0; border: 0; border-radius: 4px; color: var(--chat-muted, var(--workbench-muted)); background: transparent; cursor: pointer; }
.tool-code-icon:hover:not(:disabled) { background: var(--chat-line, var(--workbench-line)); color: var(--chat-text, var(--workbench-text)); }
.tool-code-icon:disabled { opacity: .4; cursor: default; }
.tool-code-icon:focus-visible, .tool-code-content:focus-visible, .tool-preview-content:focus-visible { outline: 2px solid var(--chat-accent, var(--workbench-accent)); outline-offset: -2px; }
.tool-code-feedback { position: absolute; bottom: -22px; right: 0; z-index: 1; padding: 1px 6px; border-radius: 3px; background: var(--chat-text, var(--workbench-text)); color: var(--chat-surface, var(--workbench-panel-strong)); font-size: 11px; line-height: 18px; white-space: nowrap; pointer-events: none; }
.tool-code-feedback:empty { display: none; }
.tool-code-content, .tool-preview-content { margin: 0; padding: 0 12px 12px; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; tab-size: 4; font-family: var(--font-mono, 'JetBrains Mono', Consolas, monospace); font-size: 12px; font-weight: 400; line-height: 1.7; white-space: pre; letter-spacing: 0; }
.tool-code-content { max-height: 184px; }
.tool-code-content code, .tool-preview-content code { font: inherit; color: inherit; background: transparent; padding: 0; }
.tool-code-command .tool-code-content { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 124px; }
.tool-code-full .tool-code-content { max-height: none; }
.tool-code-empty { margin: 0; padding: 0 12px 12px; color: var(--chat-muted, var(--workbench-muted)); font-size: 12px; }
.tool-preview-backdrop { position: fixed; inset: 0; z-index: 2200; display: grid; place-items: center; padding: 24px; background: #0007; }
.tool-preview-dialog { display: flex; flex-direction: column; width: min(960px, 100%); max-height: min(760px, calc(100dvh - 48px)); min-width: 0; overflow: hidden; border: 1px solid var(--chat-line, var(--workbench-line)); border-radius: 8px; background: var(--chat-surface, var(--workbench-panel-strong)); color: var(--chat-text, var(--workbench-text)); box-shadow: 0 20px 70px #0004; }
.tool-preview-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--chat-line, var(--workbench-line)); }
.tool-preview-header strong { min-width: 0; font-size: 14px; overflow-wrap: anywhere; }
.tool-preview-actions { display: flex; align-items: center; gap: 6px; }
.tool-preview-options { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 16px; color: var(--chat-muted, var(--workbench-muted)); font-size: 12px; }
.tool-preview-options label { display: inline-flex; align-items: center; gap: 6px; min-height: 24px; line-height: 1.4; cursor: pointer; }
.tool-preview-options input[type='checkbox'] { appearance: auto; display: inline-block; width: 14px; height: 14px; flex: 0 0 14px; margin: 0; padding: 0; border: 0; border-radius: 2px; background: transparent; box-shadow: none; accent-color: var(--chat-accent, var(--workbench-accent)); }
.tool-preview-content { padding: 8px 16px 20px; min-height: 80px; }
.tool-preview-content.is-wrapped { white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 480px) {
  .tool-preview-backdrop { padding: 12px; }
  .tool-preview-dialog { max-height: calc(100dvh - 24px); }
}
</style>
