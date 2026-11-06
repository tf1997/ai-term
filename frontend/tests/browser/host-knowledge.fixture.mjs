import { createApp, h, reactive } from 'vue'
import AiPanel from '../../src/domains/ai/presentation/components/AiPanel.vue'
import '../../src/app/styles/index.css'
localStorage.setItem('ai-term:terminal-context-mode', 'auto')
const target = { sessionId: 'terminal', sessionInstance: 'instance', profileId: 'local', routeVersion: 1, contextVersion: 1, context: { shell: 'bash', user: 'operator', environmentScope: 'fixture-container', workingDirectory: '/srv/app' } }
const scope = () => ({ profileId: target.profileId, routeKey: 'fixture-route', user: target.context.user, environmentScope: target.context.environmentScope })
const state = reactive({ width: 450, theme: 'dark', records: [], requests: [] })
const base = { connectionId: 'local', terminalId: 'terminal', workspaceSessionId: 'workspace', createdAt: '2026-11-05T00:00:00Z' }
const props = reactive({ ...base, terminalConnectionGeneration: 1, workspaceSessions: [{ id: 'workspace', connectionId: 'local', name: '主机知识测试', aiMode: 'chat' }], connectionLabels: { local: '本机测试' }, executionTargetLabel: '本机测试', executionTargetTitle: '本机测试', executionTargetConnectionIds: ['local'], selectedConfigId: 'config', config: { id: 'config', provider: 'open-ai-compatible', baseUrl: 'https://fixture.invalid', model: 'fixture', apiKey: 'fixture', contextPolicy: 'active-command-output', systemPrompt: '', riskPolicy: 'confirm-dangerous', timeoutSeconds: 30 }, apiKey: 'fixture', terminalSnapshot: '', commandHistory: [], messages: [{ ...base, id: 'done', role: 'assistant', mode: 'agent', agentStatus: 'done', text: '检查 nginx 配置完成' }] })
const accept = (call, value) => window[`_${call.callback}`]?.(value)
window.__TAURI_IPC__ = call => {
  if (call.cmd === 'list_agent_checkpoints') accept(call, [])
  else if (call.cmd === 'command_execution_target') accept(call, structuredClone(target))
  else if (call.cmd === 'host_knowledge_scope') accept(call, scope())
  else if (call.cmd === 'list_host_knowledge') accept(call, JSON.parse(JSON.stringify(state.records)))
  else if (call.cmd === 'save_host_knowledge') {
    const old = state.records.find(r => r.id === call.draft.id)
    const confirmedAt = Date.now()
    const value = { ...call.draft, id: old?.id ?? crypto.randomUUID(), revision: (old?.revision ?? 0) + 1, scope: scope(), source: call.draft.evidence ? { evidence: call.draft.evidence, resolvedPath: call.draft.value, fileScope: 'fixture-files' } : null, confirmedAt, expiresAt: confirmedAt + call.draft.validForDays * 86400000, createdAt: Date.now(), updatedAt: Date.now(), invalidReason: null }
    state.records = [value, ...state.records.filter(r => r.id !== value.id)]; accept(call, JSON.parse(JSON.stringify(value)))
  } else if (call.cmd === 'delete_host_knowledge') { state.records = state.records.filter(r => r.id !== call.id); accept(call, true) }
  else if (call.cmd === 'host_knowledge_context') accept(call, JSON.stringify({ currentSnapshot: true, scope: scope(), entries: state.records.filter(r => r.scope.environmentScope === target.context.environmentScope && r.status === 'active') }))
  else if (call.cmd === 'completed_agent_checkpoint_for_message') accept(call, { runId: '00000000-0000-4000-8000-000000000001', routeKey: 'fixture-route', state: { steps: [{ id: 'config-read', toolName: 'read_file', executionTarget: structuredClone(target), command: '', status: 'completed', executionPhase: 'finished', exitCode: 0, sensitive: false, fileRead: { path: '/etc/nginx/nginx.conf', environmentScope: 'fixture-files', absent: false, changedDuringRead: false, content: 'NEVER_SAVE_FILE_BODY' } }] } })
  else if (call.cmd === 'chat_with_ai_provider_stream') { state.requests.push(JSON.parse(JSON.stringify(call.request))); accept(call, { answer: '检查完成', contextCompressed: false, contextChars: call.request.hostKnowledgeContext?.length ?? 0, historyCount: 0 }) }
  else if (call.cmd === 'generate_ai_session_title') accept(call, { title: 'nginx 检查' })
  else if (call.cmd === 'tauri' && call.__tauriModule === 'Event') accept(call, 1)
  else window[`_${call.error}`]?.(`Unexpected IPC ${call.cmd}`)
}
createApp({ render: () => h('main', { class: `app-shell theme-${state.theme} knowledge-fixture`, style: { width: `${state.width}px` } }, h(AiPanel, { ...props, onAppendMessage: message => props.messages.push(message), onUpdateMessage: message => { const i = props.messages.findIndex(m => m.id === message.id); if (i >= 0) props.messages[i] = message } })) }).mount('#fixture')
const style = document.createElement('style'); style.textContent = 'body { min-width:0; background:#333; } .knowledge-fixture { display:block!important; height:950px; min-width:0; padding:0; } .knowledge-fixture > .assistant-panel { width:100%; height:100%; min-width:0; }'; document.head.append(style)
window.knowledgeFixture = { state, props, target }; window.knowledgeReady = true
