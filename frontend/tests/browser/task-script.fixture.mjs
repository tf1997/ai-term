import { createApp, h, reactive } from 'vue'
import WorkspacePanel from '../../src/app/ui/WorkspacePanel.vue'
import { createAgentFileEditService } from '../../src/domains/transfer/application/agentFileEdits'
import '../../src/app/styles/index.css'
const target = { sessionId: 'terminal', sessionInstance: 'fixture', profileId: 'local', routeVersion: 1, contextVersion: 1, context: { shell: 'bash', user: 'operator', environmentScope: 'fixture-host-container', workingDirectory: '/srv/app' } }
const savedStep = { id: 'restart', toolName: 'run_command', command: 'systemctl restart demo.service', reason: '重启测试服务', sensitive: false, status: 'completed', executionPhase: 'finished', output: 'ok', outputTruncated: false, exitCode: 0, executionTarget: target, fileRead: null, fileEdits: [] }
const record = { runId: '00000000-0000-4000-8000-000000000001', messageId: 'answer', workspaceSessionId: 'workspace', goal: '部署完成后整理脚本', target, routeKey: 'fixture-route', sequence: 4, boundary: 'finished', state: { status: 'done', steps: [savedStep], plan: null, verifications: [], finalText: '任务完成', error: null, stopReason: null } }
const attributes = { mode: 416, uid: 1000, gid: 1000, metadataBackup: null }
const fileChange = { id: '00000000-0000-4000-8000-000000000002', target, provider: 'sftp', writeStrategy: 'in-place', path: '/srv/app/demo.conf', resolvedPath: '/srv/app/demo.conf', environmentScope: 'file-scope', before: 'listen 8080;\r\n', after: 'listen 8081;\r\n', sensitive: false, restoreOf: null, createdAt: 1, outcome: { status: 'applied', revision: 'after-revision', contentHash: 'hash', beforeAttributes: attributes, afterAttributes: attributes, error: null } }
const fileStep = { ...savedStep, id: 'config-edit', toolName: 'apply_patch', command: '', exitCode: null, fileEdits: [{ changeId: fileChange.id, path: fileChange.path, environmentScope: fileChange.environmentScope, revision: fileChange.outcome.revision, status: 'applied' }] }
const verifyStep = { ...savedStep, id: 'verify-file', toolName: 'read_file', command: '', fileRead: { path: fileChange.path, resolvedPath: fileChange.resolvedPath, revision: 'after-revision', environmentScope: 'file-scope', complete: true, changedDuringRead: false, content: fileChange.after } }
const metadataChange = { ...fileChange, id: '00000000-0000-4000-8000-000000000003', restoreOf: fileChange.id, outcome: { ...fileChange.outcome, afterAttributes: { ...attributes, mode: 420 } } }
const metadataRestore = { ...fileStep, id: 'metadata-restore', toolName: 'restore_file', fileEdits: [{ changeId: metadataChange.id, path: metadataChange.path, environmentScope: metadataChange.environmentScope, revision: metadataChange.outcome.revision, status: 'applied' }] }
record.state.steps = [fileStep, savedStep, verifyStep,
  { ...savedStep, id: 'manual-inspect', command: 'printf OPTIONAL_OMITTED_COMMAND' },
  { ...savedStep, id: 'independent-ssh', toolName: 'run_ssh_task', command: 'export PASSWORD=PRIVATE_OMITTED_SECRET', sensitive: true },
  metadataRestore,
  { ...savedStep, id: 'other-environment', command: 'printf OTHER_ENVIRONMENT_COMMAND', executionTarget: { ...target, context: { ...target.context, environmentScope: 'different-container' } } }
]
record.state.verifications = [{ id: 'config-value', purpose: '确认配置内容', required: true, status: 'passed', check: { kind: 'file-contains', expected: '8081', stepId: 'verify-file' } },
  { id: 'omitted-health', purpose: 'PRIVATE_OMITTED_CHECK_PURPOSE', required: true, status: 'passed', check: { kind: 'output-contains', expected: 'PRIVATE_OMITTED_CHECK_EXPECTED', stepId: 'manual-inspect' } }]
const state = reactive({ panelVersion: 0, tab: 'ai', scripts: [], executions: [], nativeCalls: [], width: 450 })
const accept = (call, value) => window[`_${call.callback}`]?.(value)
window.__TAURI_IPC__ = call => {
  state.nativeCalls.push(call.cmd)
  if (call.cmd === 'list_agent_checkpoints') accept(call, [])
  else if (call.cmd === 'completed_agent_checkpoint_for_message') accept(call, structuredClone(record))
  else if (call.cmd === 'get_agent_file_change') accept(call, call.id === fileChange.id ? structuredClone(fileChange) : call.id === metadataChange.id ? structuredClone(metadataChange) : null)
  else if (call.cmd === 'list_update_scripts') accept(call, JSON.parse(JSON.stringify(state.scripts)))
  else if (call.cmd === 'save_update_script') { state.scripts = [JSON.parse(JSON.stringify(call.script))]; accept(call, null) }
  else if (call.cmd === 'get_update_script') accept(call, JSON.parse(JSON.stringify(state.scripts.find(script => script.id === call.id) ?? null)))
  else if (call.cmd === 'tauri' && call.__tauriModule === 'Event') accept(call, 1)
  else window[`_${call.error}`]?.(`Unexpected IPC: ${call.cmd}`)
}
const config = { id: 'fixture-config', provider: 'open-ai-compatible', baseUrl: 'https://fixture.invalid', model: 'fixture', apiKey: 'fixture', timeoutSeconds: 30 }
const props = { collapsed: false, terminalId: 'terminal', connectionId: 'local', terminalStatus: 'local', terminalConnectionGeneration: 1, workspaceSessionId: 'workspace', workspaceSessions: [{ id: 'workspace', connectionId: 'local', name: '任务会话', aiMode: 'agent' }], connectionLabels: { local: '本机测试环境' }, executionTargetLabel: '本机测试环境', executionTargetTitle: '本机测试环境', executionTargetConnectionIds: ['local'], selectedAiConfigId: config.id, aiConfigs: [config], aiConfig: config, apiKey: 'fixture', terminalSnapshot: '', commandHistory: [], aiMessages: [{ id: 'answer', connectionId: 'local', terminalId: 'terminal', workspaceSessionId: 'workspace', role: 'assistant', text: '任务完成', mode: 'agent', agentStatus: 'done', agentSteps: [{ ...savedStep, risks: [] }], createdAt: '2026-11-05T00:00:00Z' }], scriptRecording: { commands: [], terminalOutput: '', isRecording: false, connectionId: 'local', workspaceSessionId: 'workspace' }, applicationCommandExecutor: async (content, kind, source) => { state.executions.push({ content, kind, source }); return false } }
props.agentFileTools = { edits: createAgentFileEditService({ target: async () => target, capture: async () => { throw Error('No terminal capture in script export fixture') } }) }
createApp({ render: () => h('main', { class: 'app-shell theme-dark task-script-fixture', style: { width: `${state.width}px` } }, h(WorkspacePanel, { ...props, key: state.panelVersion, activeTab: state.tab, onWorkspaceTabChanged: tab => { state.tab = tab } })) }).mount('#fixture')
const style = document.createElement('style')
style.textContent = 'body { min-width:0; background:#333; } .task-script-fixture { display:block!important; height:100vh; min-width:0; padding:0; } .task-script-fixture > .workspace-panel { width:100%; height:100%; min-width:0; position:relative; }'
document.head.append(style)
window.taskScriptFixture = { state, props, record, fileChange, fileStep }
await document.fonts.ready
window.taskScriptReady = true
