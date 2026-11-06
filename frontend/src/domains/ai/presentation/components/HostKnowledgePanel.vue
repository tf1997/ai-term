<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { useHostKnowledge } from '../../application/useHostKnowledge'
import type { AiMessage } from '../../domain/conversation'
import { emptyKnowledgeDraft, hostKnowledgeKinds, hostKnowledgeStatuses, sameKnowledgeScope } from '../../domain/hostKnowledge'
import type { HostKnowledge, HostKnowledgeDraft } from '../../domain/hostKnowledge'
const props = defineProps<{ model: ReturnType<typeof useHostKnowledge>; messages: AiMessage[]; taskBusy: boolean }>()
const { open, busy, error, notice, records, scope, candidates, contextEnabled } = props.model
const draft = ref<HostKnowledgeDraft | null>(null), confirmed = ref(false), sourceMessage = ref('')
const completed = computed(() => props.messages.filter(message => message.role === 'assistant' && message.mode === 'agent' && message.agentStatus === 'done').slice(-12).reverse())
const date = (value: number | null) => value ? new Date(value).toLocaleString() : '尚未确认'
watch([open, scope], () => { draft.value = null; confirmed.value = false; sourceMessage.value = '' })
function edit(record?: HostKnowledge) {
  draft.value = record ? { validForDays: record.expiresAt && record.confirmedAt ? Math.max(1, Math.min(365, Math.round((record.expiresAt - record.confirmedAt) / 86400000))) : 90, id: record.id, expectedRevision: record.revision, kind: record.kind, title: record.title, value: record.value, status: record.status, evidence: record.source?.evidence ?? null } : emptyKnowledgeDraft()
  confirmed.value = false
}
function importCandidate(candidate: HostKnowledgeDraft) { draft.value = JSON.parse(JSON.stringify(candidate)); confirmed.value = false }
function editedValue() { if (draft.value) draft.value.evidence = null }
async function save() {
  if (!draft.value || (draft.value.status === 'active' && !confirmed.value)) return
  if (await props.model.save(draft.value)) { draft.value = null; confirmed.value = false }
}
</script>
<template>
  <div class="host-knowledge">
    <button class="knowledge-toggle" type="button" :aria-expanded="open" @click="model.toggle()">主机知识 <span>{{ open ? '收起' : '管理' }}</span></button>
    <section v-if="open" class="knowledge-panel" aria-label="主机知识管理">
      <p>{{ contextEnabled ? '按当前问题附加相关知识；关键路径和状态仍需检查。' : '当前上下文策略不自动附加主机知识。' }}</p>
      <p v-if="scope" class="knowledge-scope">当前：{{ scope.user }} · {{ scope.environmentScope }}<small :title="scope.routeKey">连接：{{ scope.profileId }} · 路由：{{ scope.routeKey }}</small></p>
      <p v-else>当前实际环境尚未确认，已有记录可查看和删除。</p>
      <div class="knowledge-actions"><button type="button" :disabled="busy || taskBusy" @click="model.refresh(true)">核对当前环境</button><button type="button" :disabled="busy" @click="model.refresh()">刷新记录</button><button type="button" :disabled="busy || !scope" @click="edit()">添加知识</button></div>
      <p v-if="error" class="knowledge-error" role="alert">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
      <div v-if="completed.length && scope" class="knowledge-import">
        <label>从成功任务选择路径或方法<select v-model="sourceMessage" :disabled="busy"><option value="">选择任务</option><option v-for="message in completed" :key="message.id" :value="message.id">{{ (message.text || message.id).slice(0, 70) }}</option></select></label>
        <button type="button" :disabled="busy || !sourceMessage" @click="model.discover(sourceMessage)">查看候选</button>
        <button v-for="(candidate, index) in candidates" :key="index" class="knowledge-candidate" type="button" :disabled="busy" @click="importCandidate(candidate)">{{ candidate.value }}<small>来源步骤 {{ candidate.evidence?.stepId }} · 点击后编辑并确认保存</small></button>
      </div>
      <form v-if="draft && scope" class="knowledge-form" @submit.prevent="save">
        <strong>{{ draft.id ? '修改知识' : '添加知识' }}</strong>
        <label>类型<select v-model="draft.kind" :disabled="busy" @change="editedValue"><option v-for="(label, kind) in hostKnowledgeKinds" :key="kind" :value="kind">{{ label }}</option></select></label>
        <label>标题<input v-model="draft.title" :disabled="busy" maxlength="80" required placeholder="例如 nginx 配置" /></label>
        <label>路径或方法<input v-model="draft.value" :disabled="busy" maxlength="600" required placeholder="例如 /etc/nginx/nginx.conf" @input="editedValue" /></label>
        <small>只保存简短路径或方法，不要填写密码、令牌、环境变量或文件正文。</small>
        <label>有效性<select v-model="draft.status" :disabled="busy"><option v-for="(label, status) in hostKnowledgeStatuses" :key="status" :value="status">{{ label }}</option></select></label>
        <label v-if="draft.status === 'active'">确认后有效天数<input v-model.number="draft.validForDays" type="number" min="1" max="365" step="1" required :disabled="busy" /></label>
        <small v-if="draft.status === 'active'">到期自动转为待确认，不再附加旧值。读取知识不会延长有效期。</small>
        <small>{{ draft.evidence ? `来源：任务 ${draft.evidence.runId} / ${draft.evidence.stepId}` : '来源：用户手动记录' }}</small>
        <label v-if="draft.status === 'active'" class="knowledge-confirm"><input v-model="confirmed" type="checkbox" :disabled="busy" />我已确认适用于上方账号与环境</label>
        <div class="knowledge-actions"><button type="submit" :disabled="busy || (draft.status === 'active' && !confirmed)">保存知识</button><button type="button" :disabled="busy" @click="draft = null">取消编辑</button></div>
      </form>
      <p v-if="!records.length && !busy">还没有保存的主机知识。</p>
      <article v-for="record in records" :key="record.id" class="knowledge-record">
        <strong>{{ record.title }}</strong><small>{{ hostKnowledgeKinds[record.kind] }} · {{ hostKnowledgeStatuses[record.status] }} · {{ sameKnowledgeScope(scope, record.scope) ? '当前环境' : '其他环境，不自动附加' }}</small>
        <code>{{ record.value }}</code>
        <small>{{ record.scope.user }} · {{ record.scope.environmentScope }}<br />最近确认：{{ date(record.confirmedAt) }}<br />有效至：{{ date(record.expiresAt ?? null) }}</small>
        <details><summary>来源与适用范围</summary><p>{{ record.source ? `任务 ${record.source.evidence.runId} / 步骤 ${record.source.evidence.stepId}` : '用户手动记录' }}</p><p>连接 {{ record.scope.profileId }} · 路由 {{ record.scope.routeKey }}</p><p>更新 {{ date(record.updatedAt) }} · 版本 {{ record.revision }}</p></details>
        <p v-if="record.invalidReason" class="knowledge-error">{{ record.invalidReason }}<small v-if="record.lastObservation">观察步骤 {{ record.lastObservation.stepId }}</small></p>
        <div class="knowledge-actions"><button type="button" :disabled="busy || !sameKnowledgeScope(scope, record.scope)" @click="edit(record)">编辑</button><button type="button" :disabled="busy" @click="model.remove(record)">删除</button></div>
      </article>
    </section>
  </div>
</template>
<style scoped>
.host-knowledge { border-bottom: 1px solid var(--border-color, #5554); font-size: 12px; min-width: 0; }
.knowledge-toggle { display: flex; justify-content: space-between; width: 100%; padding: 7px 12px; background: transparent; color: inherit; border: 0; text-align: left; cursor: pointer; }
.knowledge-toggle span, small { opacity: .72; }
.knowledge-panel { padding: 0 12px 12px; max-height: min(65vh, 600px); overflow: auto; }
p { margin: 7px 0; overflow-wrap: anywhere; } small { display: block; overflow-wrap: anywhere; }
button, input, select { font: inherit; color: inherit; background: var(--panel-bg, #8881); border: 1px solid var(--border-color, #8885); border-radius: 4px; padding: 5px 7px; min-width: 0; }
button { cursor: pointer; } button:disabled { opacity: .5; cursor: default; }
.knowledge-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.knowledge-form, .knowledge-record, .knowledge-import { border: 1px solid var(--border-color, #8884); padding: 9px; border-radius: 5px; margin-top: 10px; }
.knowledge-form { display: grid; gap: 7px; }
label { display: grid; gap: 4px; } .knowledge-confirm { display: flex; align-items: start; }
.knowledge-candidate { display: block; width: 100%; height: auto; min-height: 32px; line-height: 1.5; white-space: normal; text-align: left; margin-top: 6px; overflow-wrap: anywhere; }
.knowledge-import select { width: 100%; margin-bottom: 6px; }
.knowledge-error { color: var(--danger-color, #d77d6f); }
.knowledge-record code { display: block; white-space: pre-wrap; overflow-wrap: anywhere; margin: 7px 0; }
.knowledge-record details { margin-top: 6px; } .knowledge-scope small { overflow-wrap: anywhere; }
</style>
