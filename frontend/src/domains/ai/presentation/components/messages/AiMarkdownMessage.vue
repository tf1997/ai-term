<script setup lang="ts">
import { computed } from 'vue'
import { parseMessageParts, renderMarkdown } from '../../../../../shared/content/aiMarkdown'
import type { MessagePart } from '../../../../../shared/content/aiMarkdown'
import { codeBlockLabel, normalizeCodeLanguage, shellCommandFromCodeBlock } from '../../../../../shared/shell/shellCommand'
import { scriptRiskStatusForContent } from '../../../../../shared/security/scriptRisk'
import UiIcon from '../../../../../shared/ui/UiIcon.vue'
import AiCodeBlock from './AiCodeBlock.vue'

const props = withDefaults(defineProps<{
  content: string
  interactiveCommands?: boolean
}>(), { interactiveCommands: false })

const emit = defineEmits<{ executeCommand: [command: string] }>()
const parts = computed(() => parseMessageParts(props.content).map((part) => {
  if (part.type !== 'code') return { ...part, command: '', label: '', risk: null, plainResult: false }
  const command = shellCommandFromCodeBlock(part.language, part.content)
  const plainResult = isPlainTextResult(part, command)
  return {
    ...part,
    command,
    label: plainResult ? resultLabel(part) : displayCodeLabel(part, command),
    risk: command ? scriptRiskStatusForContent(command) : null,
    plainResult
  }
}))

function displayCodeLabel(part: MessagePart, command: string) {
  if (part.type !== 'code') return 'text'
  if (!command) return codeBlockLabel(part.language, part.content)
  const normalized = normalizeCodeLanguage(part.language)
  if (!normalized || normalized === 'shell' || normalized === 'bash' || normalized === 'sh') return inferCommandShellLabel(command)
  return codeBlockLabel(part.language, part.content)
}

function isPlainTextResult(part: MessagePart, command: string) {
  if (part.type !== 'code' || command) return false
  const language = normalizeCodeLanguage(part.language)
  const content = part.content.trim()
  if (!content || (language && !['text', 'plain', 'plaintext', 'txt'].includes(language))) return false
  return codeBlockLabel(part.language, part.content) === 'text' && content.length <= 220 && content.split('\n').filter((line) => line.trim()).length <= 5
}

function resultLabel(part: MessagePart) {
  const firstLine = part.type === 'code' ? part.content.trim().split('\n')[0]?.trim() ?? '' : ''
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(firstLine) ? 'IPv4 地址' : '结果'
}

function inferCommandShellLabel(command: string) {
  const trimmed = command.trim()
  if (/^(?:powershell|pwsh)\b/i.test(trimmed) || /\b(?:Get|Set|New|Remove|Clear|Format|Select|Where)-[A-Za-z]+\b/.test(trimmed)) return 'powershell'
  if (/^(?:wmic|ipconfig|netsh|tasklist|taskkill|reg|sc|dir|copy|del|type|xcopy|robocopy)\b/i.test(trimmed)) return 'cmd'
  return 'shell'
}
</script>

<template>
  <div class="chat-markdown">
    <template v-for="(part, index) in parts" :key="index">
      <div v-if="part.type === 'text' && part.content.trim()" class="markdown-content" v-html="renderMarkdown(part.content)" />
      <AiCodeBlock v-else-if="part.type === 'code'" :content="part.content" :label="part.label" :kind="part.command ? 'command' : part.plainResult ? 'output' : 'code'">
        <template #meta>
          <span v-if="part.risk" class="chat-code-risk" :class="`is-${part.risk.level}`" :title="part.risk.message">
            <UiIcon name="shield" size="11" />{{ part.risk.label }}
          </span>
        </template>
        <template #actions>
          <button v-if="interactiveCommands && part.command" class="chat-code-run" type="button" title="发送到终端执行" @click="emit('executeCommand', part.command.trim())"><UiIcon name="play" size="12" />执行</button>
        </template>
        <template #preview-actions="{ close }">
          <button v-if="interactiveCommands && part.command" class="chat-code-run" type="button" title="发送到终端执行" @click="close(); emit('executeCommand', part.command.trim())"><UiIcon name="play" size="12" />执行</button>
        </template>
      </AiCodeBlock>
    </template>
  </div>
</template>

<style scoped>
.chat-markdown { display: grid; gap: 10px; min-width: 0; width: 100%; color: var(--chat-text, var(--workbench-text)); }
.chat-markdown > .markdown-content { min-width: 0; margin: 0; font-size: 14px; line-height: 1.8; overflow-wrap: anywhere; }
.chat-markdown :deep(.markdown-content > :first-child) { margin-top: 0; }
.chat-markdown :deep(.markdown-content > :last-child) { margin-bottom: 0; }
.chat-markdown :deep(.markdown-content table) { display: block; width: 100%; max-width: 100%; overflow-x: auto; }
.chat-markdown :deep(.markdown-content h1) { font-size: 20px; line-height: 1.5; }
.chat-markdown :deep(.markdown-content h2) { font-size: 17px; line-height: 1.5; }
.chat-markdown :deep(.markdown-content h3) { font-size: 15px; line-height: 1.6; }
.chat-code-risk { display: inline-flex; align-items: center; align-self: center; gap: 3px; height: 18px; color: var(--chat-muted, var(--workbench-muted)); font-size: 10px; line-height: 1; white-space: nowrap; transform: translateY(1px); }
.chat-code-risk .ui-icon { display: block; width: 11px; height: 11px; flex: 0 0 11px; }
.chat-code-risk.is-medium { color: var(--chat-warning, #996015); }
.chat-code-risk.is-high { color: var(--chat-danger, #c24150); }
.chat-code-run { display: inline-flex; align-items: center; gap: 4px; min-height: 26px; padding: 3px 7px; background: var(--chat-button, var(--workbench-accent)); color: #fff; border: 0; border-radius: 4px; cursor: pointer; font-size: 11px; line-height: 1.5; }
.chat-code-run:focus-visible { outline: 2px solid var(--chat-accent, var(--workbench-accent)); outline-offset: 2px; }
.chat-code-run:hover { filter: brightness(.94); }
</style>
