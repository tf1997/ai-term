<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import UiIcon from '../../../../../shared/ui/UiIcon.vue'
import AiCodeText from './AiCodeText.vue'
import { useCopyFeedback } from './useCopyFeedback'

const props = defineProps<{
  command: string
  output?: string
  failureDetail?: string
  targetLabel?: string
  exitCode?: number
  duration?: string
  autoApproved?: boolean
}>()
const open = ref(false)
const wrap = ref(false)
const trigger = ref<HTMLButtonElement | null>(null)
const dialog = ref<HTMLElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)
const theme = ref<Record<string, string>>({})
const { copyFeedback, copyText } = useCopyFeedback()
const sections = computed(() => [
  { kind: 'command', label: '命令', content: props.command },
  ...(props.output !== undefined ? [{ kind: 'output', label: props.exitCode === undefined ? '输出' : `输出 · exit ${props.exitCode}`, content: props.output }] : []),
  ...(props.failureDetail ? [{ kind: 'error', label: '错误详情', content: props.failureDetail }] : [])
])

async function show() {
  if (trigger.value) {
    const style = getComputedStyle(trigger.value)
    const tokens = ['--chat-text', '--chat-muted', '--chat-surface', '--chat-elevated', '--chat-line', '--chat-accent', '--chat-hover', '--font-mono']
    theme.value = Object.fromEntries(tokens.map(token => [token, style.getPropertyValue(token).trim()]))
  }
  wrap.value = false
  open.value = true
  await nextTick()
  closeButton.value?.focus({ preventScroll: true })
}
function close() {
  open.value = false
  if (trigger.value?.isConnected) trigger.value.focus({ preventScroll: true })
}
function handleKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close()
  } else if (event.key === 'Tab') {
    const elements = [...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input, [tabindex="0"]') ?? [])]
    const first = elements[0], last = elements[elements.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
}
onBeforeUnmount(() => { if (open.value && trigger.value?.isConnected) trigger.value.focus({ preventScroll: true }) })
</script>

<template>
  <button ref="trigger" class="tool-step-details" type="button" aria-haspopup="dialog" :aria-expanded="open" @click="show">
    <UiIcon name="terminal" size="13" /><span>查看命令与完整输出</span>
    <UiIcon name="chevron-right" size="13" />
  </button>
  <Teleport to="body">
    <Transition name="dialog-motion">
      <div v-if="open" class="agent-detail-backdrop" :style="theme" @click.self="close">
        <section ref="dialog" class="agent-detail-dialog" role="dialog" aria-modal="true" aria-label="命令与完整输出" @keydown="handleKey">
          <header class="agent-detail-head">
            <div>
              <strong>命令与完整输出</strong>
              <p v-if="targetLabel">此步骤来源 · {{ targetLabel }}</p>
              <p v-if="autoApproved || duration" class="agent-detail-meta"><span v-if="autoApproved">自动执行</span><span v-if="duration">{{ duration }}</span></p>
            </div>
            <button ref="closeButton" class="agent-detail-icon" type="button" aria-label="关闭" title="关闭" @click="close"><UiIcon name="close" size="16" /></button>
          </header>
          <div class="agent-detail-options"><label><input v-model="wrap" type="checkbox" />输出自动换行</label><span role="status">{{ copyFeedback }}</span></div>
          <div class="agent-detail-body" tabindex="0" aria-label="执行详情">
            <section v-for="section in sections" :key="section.kind" class="agent-detail-section" :data-kind="section.kind">
              <header><span>{{ section.label }}</span><button class="agent-detail-icon" type="button" :disabled="!section.content" :aria-label="`复制${section.kind === 'output' ? '输出' : section.label}`" :title="`复制${section.kind === 'output' ? '输出' : section.label}`" @click="copyText(section.content)"><UiIcon name="copy" size="14" /></button></header>
              <pre v-if="section.content" :class="{ 'is-wrapped': section.kind !== 'output' || wrap }"><AiCodeText :content="section.content" :line-numbers="false" :wrap="section.kind !== 'output' || wrap" /></pre>
              <p v-else class="agent-detail-empty">命令已结束，没有输出。</p>
            </section>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.tool-step-details { display: flex; align-items: center; width: 100%; min-width: 0; min-height: 34px; height: auto; gap: 6px; padding: 7px 12px; border: 0; border-top: 1px solid var(--chat-line); border-radius: 0; color: var(--chat-muted); background: transparent; text-align: left; font-size: var(--ai-font-ui); line-height: var(--ai-leading-ui); }
.tool-step-details:hover:not(:disabled) { background: var(--chat-hover); color: var(--chat-text); }
.tool-step-details > .ui-icon { flex-shrink: 0; }
.tool-step-details > .ui-icon:last-child { margin-left: auto; }
.tool-step-details:focus-visible { outline: 2px solid var(--chat-accent); outline-offset: -2px; }
.agent-detail-backdrop { position: fixed; z-index: 2200; inset: 0; display: grid; place-items: center; padding: 24px; background: #0007; }
.agent-detail-dialog { display: flex; flex-direction: column; width: min(760px, 100%); max-height: min(820px, calc(100dvh - 48px)); min-width: 0; overflow: hidden; border: 1px solid var(--chat-line); border-radius: var(--ai-card-radius); background: var(--chat-surface); color: var(--chat-text); box-shadow: 0 20px 70px #0004; }
.agent-detail-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--chat-line); }
.agent-detail-head > div { min-width: 0; }
.agent-detail-head strong { font-size: var(--ai-font-heading); font-weight: var(--ai-weight-strong); line-height: var(--ai-leading-heading); }
.agent-detail-head p { margin: 4px 0 0; font-size: var(--ai-font-ui); color: var(--chat-muted); overflow-wrap: anywhere; line-height: var(--ai-leading-ui); }
.agent-detail-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; font-variant-numeric: tabular-nums; }
.agent-detail-icon { display: inline-grid; place-items: center; flex: 0 0 28px; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 4px; color: var(--chat-muted); background: transparent; }
.agent-detail-icon:hover:not(:disabled) { background: var(--chat-hover); color: var(--chat-text); }
.agent-detail-icon:focus-visible, .agent-detail-options input:focus-visible, .agent-detail-body:focus-visible { outline: 2px solid var(--chat-accent); outline-offset: -2px; }
.agent-detail-options { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 16px; color: var(--chat-muted); font-size: var(--ai-font-ui); line-height: var(--ai-leading-ui); }
.agent-detail-options label { display: inline-flex; align-items: center; gap: 6px; }
.agent-detail-options input { appearance: auto; flex: none; width: 14px; height: 14px; margin: 0; padding: 0; accent-color: var(--chat-accent); }
.agent-detail-body { min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 0 16px 16px; scrollbar-width: thin; scrollbar-color: var(--chat-muted) transparent; }
.agent-detail-section { margin-bottom: 16px; min-width: 0; }
.agent-detail-section:last-child { margin-bottom: 0; }
.agent-detail-section > header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 5px; color: var(--chat-muted); font-size: var(--ai-font-ui); line-height: var(--ai-leading-ui); }
.agent-detail-section pre { margin: 0; padding: 12px; min-width: 100%; width: max-content; border: 1px solid var(--chat-line); border-radius: 6px; background: var(--chat-elevated); color: var(--chat-text); font: var(--ai-font-ui)/var(--ai-leading-ui) var(--font-mono); white-space: pre; }
.agent-detail-section pre.is-wrapped { width: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.agent-detail-empty { margin: 0; padding: 12px; color: var(--chat-muted); font-size: var(--ai-font-ui); line-height: var(--ai-leading-ui); }
@media (max-width: 480px) { .agent-detail-backdrop { padding: 12px; } .agent-detail-dialog { max-height: calc(100dvh - 24px); } }
</style>
