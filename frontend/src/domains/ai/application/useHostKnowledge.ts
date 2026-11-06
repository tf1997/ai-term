import { computed, ref, watch } from 'vue'
import type { AiPanelProps } from '../domain/aiPanel'
import type { TerminalContextMode } from '../domain/terminalContext'
import type { HostKnowledge, HostKnowledgeDraft, HostKnowledgeScope } from '../domain/hostKnowledge'
import type { ExecutionTarget } from '../../../shared/security/commandPolicy'
import { knowledgeCandidates } from '../domain/hostKnowledge'
import * as api from '../infrastructure/hostKnowledge'
import { agentCheckpointTarget, completedAgentCheckpointForMessage } from '../infrastructure/agentCheckpoints'

const defaultSource = { ...api, agentCheckpointTarget, completedAgentCheckpointForMessage }
export function useHostKnowledge(props: Readonly<AiPanelProps>, mode: () => TerminalContextMode, source = defaultSource) {
  const open = ref(false), busy = ref(false), error = ref(''), notice = ref('')
  const records = ref<HostKnowledge[]>([]), scope = ref<HostKnowledgeScope | null>(null), target = ref<ExecutionTarget | null>(null)
  const candidates = ref<HostKnowledgeDraft[]>([])
  const contextEnabled = computed(() => mode() === 'auto' && props.config.contextPolicy === 'active-command-output')
  const binding = () => JSON.stringify([props.connectionId, props.terminalId, props.terminalConnectionGeneration])
  let generation = 0
  watch(binding, () => { generation++; open.value = false; busy.value = false; error.value = ''; notice.value = ''; records.value = []; scope.value = null; target.value = null; candidates.value = [] })
  async function refresh(verify = false) {
    const version = ++generation, profile = props.connectionId, terminal = props.terminalId, connectionGeneration = props.terminalConnectionGeneration
    busy.value = true; error.value = ''; candidates.value = []; scope.value = null; target.value = null
    try {
      const items = await source.listHostKnowledge(profile)
      if (version !== generation) return
      records.value = items
      const expected = await (verify ? props.agentCommandPolicy?.target?.(terminal, connectionGeneration) ?? source.agentCheckpointTarget(terminal) : source.agentCheckpointTarget(terminal))
      const actualScope = await source.hostKnowledgeScope(expected)
      if (version !== generation) return
      scope.value = actualScope; target.value = expected
    } catch (e) { if (version === generation) error.value = String(e) }
    finally { if (version === generation) busy.value = false }
  }
  async function toggle() { open.value = !open.value; if (open.value) await refresh() }
  async function save(draft: HostKnowledgeDraft): Promise<boolean> {
    if (busy.value || !target.value) return false
    const version = generation
    busy.value = true; error.value = ''
    try {
      const saved = await source.saveHostKnowledge(JSON.parse(JSON.stringify(target.value)), JSON.parse(JSON.stringify(draft)))
      if (version !== generation) return false
      records.value = [saved, ...records.value.filter(item => item.id !== saved.id)]
      notice.value = '已保存，后续请求使用最新记录。'; return true
    } catch (e) { if (version === generation) error.value = String(e); return false }
    finally { if (version === generation) busy.value = false }
  }
  async function remove(record: HostKnowledge) {
    if (busy.value) return
    const version = generation
    busy.value = true; error.value = ''
    try {
      await source.deleteHostKnowledge(record.scope.profileId, record.id, record.revision)
      if (version !== generation) return
      records.value = records.value.filter(item => item.id !== record.id); notice.value = '已删除，后续请求不再附加此条知识。'
    } catch (e) { if (version === generation) error.value = String(e) }
    finally { if (version === generation) busy.value = false }
  }
  async function discover(messageId: string) {
    if (busy.value || !scope.value) return
    const version = generation, actualScope = scope.value
    busy.value = true; error.value = ''
    try {
      const checkpoint = await source.completedAgentCheckpointForMessage(props.connectionId, props.workspaceSessionId, messageId)
      if (version !== generation) return
      candidates.value = checkpoint ? knowledgeCandidates(checkpoint, actualScope) : []
      if (!candidates.value.length) notice.value = '此任务没有可导入的同环境路径或方法。'
    } catch (e) { if (version === generation) error.value = String(e) }
    finally { if (version === generation) busy.value = false }
  }
  async function context(query: string, runId?: string): Promise<string> {
    if (!contextEnabled.value) return ''
    const bound = binding()
    let timer: ReturnType<typeof setTimeout> | undefined
    let lookupActive = true
    try {
      // Read the existing native target; never inject a probe into a chat turn.
      const loading = (async () => {
        const expected = await source.agentCheckpointTarget(props.terminalId)
        if (!lookupActive || bound !== binding() || !contextEnabled.value || expected.profileId !== props.connectionId) return ''
        return source.hostKnowledgeContext(expected, query, runId)
      })()
      const value = await Promise.race([loading, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('知识读取超时')), 5000) })])
      if (bound !== binding() || !contextEnabled.value) return ''
      notice.value = ''
      return value
    } catch {
      if (bound !== binding() || !contextEnabled.value) return ''
      notice.value = '本次未附加主机知识：当前环境或知识库尚未核实。'
      return JSON.stringify({ currentSnapshot: true, entries: [], reason: '当前环境或知识库未核实，不得沿用旧主机知识。' })
    } finally { lookupActive = false; if (timer !== undefined) clearTimeout(timer) }
  }
  return { open, busy, error, notice, records, scope, candidates, contextEnabled, toggle, refresh, save, remove, discover, context }
}
