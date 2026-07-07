<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { parseMessageParts, renderMarkdown, type MessagePart } from '../lib/aiMarkdown'
import { codeBlockLabel, normalizeCodeLanguage, shellCommandFromCodeBlock } from '../lib/shellCommand'
import { scriptRiskStatusForContent } from '../lib/scriptRisk'
import UiIcon from './UiIcon.vue'

const props = withDefaults(defineProps<{
  content: string
  interactiveCommands?: boolean
}>(), {
  interactiveCommands: false
})

const emit = defineEmits<{
  executeCommand: [command: string]
}>()

const copied = ref(false)
const previewBlock = ref<{
  label: string
  content: string
  command: string
} | null>(null)
let copiedTimer: number | undefined

const parts = computed(() => parseMessageParts(props.content))

function shellCommandForPart(part: MessagePart) {
  if (part.type !== 'code') return ''
  return shellCommandFromCodeBlock(part.language, part.content)
}

function commandRiskStatus(command: string) {
  return scriptRiskStatusForContent(command)
}

function displayCodeLabel(part: MessagePart) {
  if (part.type !== 'code') return 'text'
  const command = shellCommandForPart(part)
  if (!command) return codeBlockLabel(part.language, part.content)
  const normalized = normalizeCodeLanguage(part.language)
  const inferred = inferCommandShellLabel(command)
  if (!normalized || normalized === 'shell' || normalized === 'bash' || normalized === 'sh') return inferred
  return codeBlockLabel(part.language, part.content)
}

function isPlainTextResult(part: MessagePart) {
  if (part.type !== 'code') return false
  if (shellCommandForPart(part)) return false
  const language = normalizeCodeLanguage(part.language)
  const label = codeBlockLabel(part.language, part.content)
  const content = part.content.trim()
  if (!content) return false
  if (language && !['text', 'plain', 'plaintext', 'txt'].includes(language)) return false
  const lines = content.split('\n').filter((line) => line.trim())
  return label === 'text' && content.length <= 220 && lines.length <= 5
}

function resultLabel(part: MessagePart) {
  const firstLine = part.type === 'code' ? part.content.trim().split('\n')[0]?.trim() ?? '' : ''
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(firstLine)) return 'IPv4 地址'
  return '结果'
}

function inferCommandShellLabel(command: string) {
  const trimmed = command.trim()
  if (/^(?:powershell|pwsh)\b/i.test(trimmed) || /\b(?:Get|Set|New|Remove|Clear|Format|Select|Where)-[A-Za-z]+\b/.test(trimmed)) return 'powershell'
  if (/^(?:wmic|ipconfig|netsh|tasklist|taskkill|reg|sc|dir|copy|del|type|xcopy|robocopy)\b/i.test(trimmed)) return 'cmd'
  return 'shell'
}

function openPreview(part: MessagePart) {
  if (part.type !== 'code') return
  previewBlock.value = {
    label: displayCodeLabel(part),
    content: part.content,
    command: shellCommandForPart(part)
  }
}

function closePreview() {
  previewBlock.value = null
}

async function copyText(value: string) {
  if (!value.trim()) return
  try {
    await navigator.clipboard.writeText(value)
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }
  copied.value = true
  if (copiedTimer) window.clearTimeout(copiedTimer)
  copiedTimer = window.setTimeout(() => {
    copied.value = false
  }, 1400)
}

function executeCommand(command: string) {
  const value = command.trim()
  if (!value) return
  emit('executeCommand', value)
  closePreview()
}

onBeforeUnmount(() => {
  if (copiedTimer) window.clearTimeout(copiedTimer)
})
</script>

<template>
  <div class="ai-markdown-message">
    <template v-for="(part, index) in parts" :key="index">
      <div
        v-if="part.type === 'text' && part.content.trim()"
        class="markdown-content"
        v-html="renderMarkdown(part.content)"
      />
      <div v-else-if="isPlainTextResult(part)" class="ai-result-block">
        <span class="ai-result-label">{{ resultLabel(part) }}</span>
        <code>{{ part.content.trim() }}</code>
        <button class="icon-button" type="button" :title="copied ? '已复制' : '复制结果'" :aria-label="copied ? '已复制' : '复制结果'" @click="copyText(part.content)">
          <UiIcon name="copy" size="14" />
        </button>
      </div>
      <div v-else-if="part.type === 'code'" class="code-block ai-code-block" :class="{ 'has-command': shellCommandForPart(part) }">
        <div class="code-head ai-code-head">
          <div class="ai-code-meta">
            <span class="ai-code-language">{{ displayCodeLabel(part) }}</span>
            <span
              v-if="shellCommandForPart(part)"
              class="command-risk-status"
              :class="`risk-${commandRiskStatus(shellCommandForPart(part)).level}`"
              :title="commandRiskStatus(shellCommandForPart(part)).message"
            >
              {{ commandRiskStatus(shellCommandForPart(part)).label }}
            </span>
          </div>
          <div class="ai-code-actions">
            <button class="icon-button" type="button" :title="copied ? '已复制' : '复制代码'" :aria-label="copied ? '已复制' : '复制代码'" @click="copyText(part.content)">
              <UiIcon name="copy" size="14" />
            </button>
            <button class="icon-button" type="button" title="预览完整代码" aria-label="预览完整代码" @click="openPreview(part)">
              <UiIcon name="maximize" size="14" />
            </button>
            <button
              v-if="props.interactiveCommands && shellCommandForPart(part)"
              class="text-button primary-action ai-code-run"
              type="button"
              @click="executeCommand(shellCommandForPart(part))"
            >
              <UiIcon name="play" size="13" />
              <span>执行</span>
            </button>
          </div>
        </div>
        <pre><code>{{ part.content }}</code></pre>
      </div>
    </template>

    <div v-if="previewBlock" class="modal-backdrop ai-code-preview-backdrop" role="presentation">
      <section class="modal ai-code-preview-modal" role="dialog" aria-modal="true" aria-label="代码预览">
        <div class="modal-head">
          <div>
            <strong>代码预览</strong>
            <span>{{ previewBlock.label }}</span>
          </div>
          <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="closePreview">
            <UiIcon name="close" />
          </button>
        </div>
        <div class="ai-code-preview-toolbar">
          <span
            v-if="previewBlock.command"
            class="command-risk-status"
            :class="`risk-${commandRiskStatus(previewBlock.command).level}`"
            :title="commandRiskStatus(previewBlock.command).message"
          >
            {{ commandRiskStatus(previewBlock.command).label }}
          </span>
          <button class="text-button" type="button" @click="copyText(previewBlock.content)">复制</button>
          <button
            v-if="props.interactiveCommands && previewBlock.command"
            class="text-button primary-action ai-code-run"
            type="button"
            @click="executeCommand(previewBlock.command)"
          >
            <UiIcon name="play" size="13" />
            <span>执行</span>
          </button>
        </div>
        <pre class="ai-code-preview-content"><code>{{ previewBlock.content }}</code></pre>
      </section>
    </div>
  </div>
</template>
