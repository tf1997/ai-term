<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { CommandReviewItem } from '../../application/useCommandPolicyReview'
import { commandPolicyRisks } from '../../../../shared/security/commandPolicyPresentation'
const props = defineProps<{ items: CommandReviewItem[]; note?: string }>()
const emit = defineEmits<{ resolve: [approved: boolean] }>()
const reviewed = ref(false)
const expanded = ref(new Set<string>())
watch(() => props.items, () => { reviewed.value = false; expanded.value.clear() })
const blocked = computed(() => props.items.some(item => item.intent.analysis.decision === 'deny'))
const reviewItems = computed(() => props.items.map(item => ({ ...item, risks: commandPolicyRisks(item.intent) })))
async function showLine(id: string, line: number) {
  expanded.value.add(id)
  await nextTick()
  window.location.hash = `policy-${id}-${line}`
  document.getElementById(`policy-${id}-${line}`)?.scrollIntoView({ block: 'nearest' })
}
function sourceToggled(id: string, event: Event) {
  if ((event.target as HTMLDetailsElement).open) expanded.value.add(id)
  else expanded.value.delete(id)
}
</script>

<template>
  <div class="modal-backdrop script-risk-backdrop" role="presentation">
    <section class="modal script-risk-modal" role="dialog" aria-modal="true" aria-label="执行前确认" @keydown.esc="emit('resolve', false)">
      <header class="modal-header"><strong>{{ blocked ? '命令已被阻止' : '执行前确认' }}</strong><button type="button" class="text-button" @click="emit('resolve', false)">取消</button></header>
      <div class="modal-body policy-review-body">
        <p v-if="note">{{ note }}</p>
        <article v-for="item in reviewItems" :key="item.intent.reference.id">
          <strong>{{ item.label }}</strong>
          <p>{{ item.intent.reference.target.context.user ?? '身份未确认' }} · {{ item.intent.reference.target.context.workingDirectory ?? '目录未确认' }} · {{ item.intent.operation === 'bash-script' ? 'Bash 脚本' : '当前终端' }}</p>
          <p>环境：{{ item.intent.reference.target.context.environmentScope ?? '尚未确认' }}</p>
          <p class="policy-summary">最高风险：{{ item.intent.analysis.highestSeverity === 'high' ? '高风险' : item.intent.analysis.highestSeverity === 'medium' ? '中风险' : '无已识别风险' }} · {{ item.intent.analysis.risks.length }} 处风险<span v-if="item.intent.analysis.analysisStatus === 'unknown'"> · 分析未完成，需逐次确认</span></p>
          <ul v-if="item.risks.length">
            <li v-for="(risk, index) in item.risks" :key="index"><a :href="`#policy-${item.intent.reference.id}-${risk.line}`" @click.prevent="showLine(item.intent.reference.id, risk.line)">第 {{ risk.line }} 行</a> · {{ risk.severity === 'high' ? '高风险' : '中风险' }}：{{ risk.message }}</li>
          </ul>
          <details :open="expanded.has(item.intent.reference.id)" @toggle="sourceToggled(item.intent.reference.id, $event)">
            <summary>完整{{ item.intent.operation === 'bash-script' ? '脚本' : '命令' }} · {{ item.intent.source.split('\n').length }} 行</summary>
            <pre class="policy-source"><code><span v-for="(line, index) in item.intent.source.split('\n')" :id="`policy-${item.intent.reference.id}-${index + 1}`" :key="index">{{ index + 1 }}  {{ line }}{{ '\n' }}</span></code></pre>
          </details>
        </article>
      </div>
      <footer class="modal-footer">
        <label v-if="!blocked"><input v-model="reviewed" type="checkbox"> 已核对完整内容和上述目标</label>
        <button type="button" class="text-button" @click="emit('resolve', false)">取消</button>
        <button v-if="!blocked" type="button" class="primary-button" :disabled="!reviewed" @click="emit('resolve', true)">仅执行这一次</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.script-risk-modal { width: min(760px, calc(100vw - 48px)); min-width: 0; grid-template-rows: auto minmax(0, 1fr) auto; }
.modal-header, .modal-footer { padding: 12px 16px; }
.modal-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.policy-review-body { overflow: auto; max-height: 65vh; padding: 0 16px; min-height: 0; }
.policy-review-body article { min-width: 0; overflow-wrap: anywhere; }
.policy-review-body summary { cursor: pointer; padding: 8px 0; }
.policy-summary { font-weight: 600; }
.policy-source { white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; font-size: 12px; }
.policy-source span:target { background: #a67c1933; }
.modal-footer { display: flex; align-items: center; gap: 12px; }
.modal-footer label { display: inline-flex; align-items: center; gap: 6px; }
.modal-footer input { width: 14px; height: 14px; margin: 0; padding: 0; flex: none; }
@media (max-width: 480px) { .modal-footer { flex-wrap: wrap; } .modal-footer label { width: 100%; } }
</style>
