<script setup lang="ts">
import { computed } from 'vue'
import { detectShellScriptLanguage } from '../../../../shared/shell/shellCommand'
import { scriptReadinessStatusForContent } from '../../domain/scriptReadiness'
import { readinessLinesText } from '../../domain/scriptEditor'

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
    <div class="script-execution-target" :title="targetTitle">运行到：{{ target || '当前终端' }} <span>· 需要 Bash</span></div>
    <p v-if="incompatible" class="script-compatibility-hint">当前内容为 {{ language === 'powershell' ? 'PowerShell' : 'CMD' }}；请先转换为 Bash 脚本后运行。</p>
    <div v-if="readiness.issues.length || risk.level === 'medium' || risk.level === 'high'" class="script-condition-status">
      <button v-if="readiness.issues.length" class="script-readiness-status readiness-pending" type="button" :title="`查看并补全：${readiness.message}`" @click="$emit('focusReadiness')">待填 {{ readiness.issues.length }} 项 · 第 {{ readinessLinesText(readiness.issues) }} 行 · 查看并补全</button>
      <span v-if="readiness.issues.length" class="script-run-reason">补全 {{ readiness.issues.length }} 项后可运行</span>
      <details v-if="risk.level === 'medium' || risk.level === 'high'" class="script-risk-details" :class="`risk-${risk.level}`">
        <summary>{{ risk.level === 'high' ? '高风险' : '中风险' }} · 运行前需确认</summary>
        <p v-for="(item, index) in risk.risks" :key="index">第 {{ item.line }} 行 · {{ item.label }}：{{ item.message }}</p>
      </details>
    </div>
  </div>
</template>
