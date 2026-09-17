<script setup lang="ts">
import { computed } from 'vue'
import { detectShellScriptLanguage } from '../../../../shared/shell/shellCommand'
import { scriptReadinessStatusForContent } from '../../domain/scriptReadiness'
import { readinessLinesText } from '../../domain/scriptEditor'
import UiIcon from '../../../../shared/ui/UiIcon.vue'

const props = defineProps<{
  content: string
  name: string
  target: string
  targetTitle: string
  risk: { level: string; message: string; risks: Array<{ line: number; label: string; message: string }> }
}>()
defineEmits<{ focusReadiness: [] }>()
const readiness = computed(() => scriptReadinessStatusForContent(props.content))
const language = computed(() => detectShellScriptLanguage(props.content, props.name))
const incompatible = computed(() => language.value === 'powershell' || language.value === 'cmd')
</script>

<template>
  <div class="script-editor-context">
    <div class="script-execution-target" :title="`运行到：${targetTitle || target || '当前终端'}`">
      <UiIcon name="terminal" size="13" />
      <span class="script-target-name">{{ target || '当前终端' }}</span>
      <span class="script-runtime-requirement">需要 Bash</span>
    </div>
    <p v-if="incompatible" class="script-compatibility-hint">当前内容为 {{ language === 'powershell' ? 'PowerShell' : 'CMD' }}；请先转换为 Bash 脚本后运行。</p>
    <div v-if="readiness.issues.length || risk.level === 'medium' || risk.level === 'high'" class="script-condition-status">
      <button v-if="readiness.issues.length" class="script-readiness-status readiness-pending" type="button" :title="`查看并补全：${readiness.message}`" @click="$emit('focusReadiness')">
        <UiIcon name="edit" size="12" />
        <span>补全 {{ readiness.issues.length }} 项</span>
        <span class="script-readiness-lines">第 {{ readinessLinesText(readiness.issues) }} 行</span>
        <UiIcon name="arrow-right" size="12" />
      </button>
      <details v-if="risk.level === 'medium' || risk.level === 'high'" class="script-risk-details" :class="`risk-${risk.level}`">
        <summary>{{ risk.level === 'high' ? '高风险' : '中风险' }} · 运行前需确认</summary>
        <p v-for="(item, index) in risk.risks" :key="index">第 {{ item.line }} 行 · {{ item.label }}：{{ item.message }}</p>
      </details>
    </div>
  </div>
</template>

<style scoped>
.script-editor-context { --script-readiness-ink: #d8b777; }
.theme-light .script-editor-context { --script-readiness-ink: #8a621f; }
.script-execution-target { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; min-height: 20px; color: var(--workbench-muted); }
.script-execution-target > .ui-icon { flex: none; }
.script-target-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.script-runtime-requirement { margin-left: auto; color: var(--workbench-quiet); }
.script-editor-context .script-condition-status { margin-top: 4px; }
.script-editor-context .script-readiness-status { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; min-height: 26px; padding: 3px 6px; border: 0; border-radius: 4px; background: color-mix(in srgb, var(--script-readiness-ink) 8%, transparent); color: var(--script-readiness-ink); font-size: 11px; font-weight: 400; }
.script-editor-context .script-readiness-status:hover { background: color-mix(in srgb, var(--script-readiness-ink) 12%, transparent); }
.script-readiness-status:focus-visible { outline: 2px solid var(--script-readiness-ink); outline-offset: 1px; }
.script-readiness-lines { opacity: .85; }
</style>
