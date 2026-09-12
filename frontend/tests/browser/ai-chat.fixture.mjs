import { createApp, h, nextTick, reactive } from 'vue'
import AiPanel from '../../src/domains/ai/presentation/components/AiPanel.vue'
import '../../src/app/styles/index.css'

const now = '2026-09-12T12:00:00.000Z'
const command = 'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID, VolumeName, FileSystem, Size, FreeSpace'
const longCommand = "powershell -Command \"Get-WinEvent -FilterHashtable @{ LogName='System'; Id=41,42,107,109,153,4101,6008,1; StartTime=(Get-Date).AddDays(-7) } | Select-Object TimeCreated, Id, LevelDisplayName, Message | Format-Table -AutoSize\""
const longOutput = Array.from({ length: 48 }, (_, i) => `2026-09-${String(i % 12 + 1).padStart(2, '0')} 16:32:15  ${String(1000 + i).padEnd(6)} System  ${'Long diagnostic output preserving terminal columns. '.repeat(4)}`).join('\n')
const base = { connectionId: 'local', workspaceSessionId: 'fixture-session', terminalId: 'fixture-terminal', terminalConnectionGeneration: 1, createdAt: now }
const assistant = (id, text, values = {}) => ({ ...base, id, role: 'assistant', text, ...values })
const user = (id, text) => ({ ...base, id, role: 'user', text })
const step = (id, values = {}) => ({ id, command, reason: 'Inspect local disk capacity', risks: [], sensitive: false, status: 'completed', executionPhase: 'finished', output: 'DeviceID  Size          FreeSpace\nC:        512000000000  204800000000', exitCode: 0, durationMs: 482, ...values })

const messages = [
  user('question-hello', 'hello'),
  assistant('hello', 'Hello.'),
  user('question-502', 'Inspect disk capacity'),
  assistant('error-502', 'HTTP 502 Bad Gateway: upstream model gateway unavailable. Request id: fixture-502', { error: true, errorKind: 'model', command: longCommand }),
  user('question-completed', 'Inspect local disk capacity'),
  assistant('completed', 'Disk inspection completed.', { mode: 'agent', agentStatus: 'done', agentSteps: [step('completed-step')] }),
  user('question-dispatch', 'Inspect another disk'),
  assistant('dispatch-failed', '命令派发失败:Shell 尚未返回可执行提示符', { error: true, errorKind: 'tool', mode: 'agent', agentStatus: 'error', agentSteps: [step('dispatch-step', { status: 'failed', executionPhase: 'not-started', failureReason: 'Shell 尚未返回可执行提示符', output: undefined, exitCode: undefined, durationMs: undefined })] }),
  user('question-long', 'Collect diagnostic output'),
  assistant('long-output', 'Collected diagnostic output.', { mode: 'agent', agentStatus: 'done', agentSteps: [step('long-step', { command: longCommand, output: longOutput })] }),
  user('question-nonzero', 'Check missing path'),
  assistant('nonzero', 'The command reported an error.', { mode: 'agent', agentStatus: 'done', agentSteps: [step('nonzero-step', { exitCode: 1, output: 'Cannot find path D:\\missing because it does not exist.' })] }),
  user('question-stopped', 'Stop collecting output'),
  assistant('stopped', '', { mode: 'agent', agentStatus: 'stopped', stopReason: '已停止观察，命令可能仍在终端运行', agentSteps: [step('stopped-step', { status: 'running', executionPhase: 'running', output: undefined, exitCode: undefined })] }),
  user('question-pending', 'Inspect current system state'),
  assistant('pending', '', { mode: 'agent', agentStatus: 'running', agentSteps: [step('pending-step', { status: 'pending', executionPhase: 'not-started', output: undefined, exitCode: undefined, durationMs: undefined })] }),
  user('question-stream', 'Explain the result'),
  assistant('streaming', 'Streaming fixture response.', { streaming: true })
]

const state = reactive({
  width: 554,
  zoom: 1,
  theme: 'light',
  props: {
    ...base,
    workspaceSessions: [{ id: base.workspaceSessionId, connectionId: 'local', name: 'Terminal assistant', summary: '', aiMode: 'chat', createdAt: now, updatedAt: now }],
    connectionLabels: { local: '本地终端' },
    executionTargetLabel: '本地终端',
    executionTargetTitle: '本地终端',
    executionTargetConnectionIds: ['local'],
    selectedConfigId: 'fixture-config',
    config: { id: 'fixture-config', provider: 'open-ai-compatible', baseUrl: 'https://fixture.invalid/v1', model: 'gpt-5.5', apiKey: 'fixture-only', apiKeyRef: '', contextPolicy: 'active-command-output', systemPrompt: '', riskPolicy: 'confirm-dangerous', timeoutSeconds: 30 },
    apiKey: 'fixture-only',
    terminalSnapshot: 'PS D:\\workspace> ',
    commandHistory: [],
    messages: structuredClone(messages),
    agentAvailabilityCheck: () => '',
    agentAvailabilityConfirm: async () => ''
  }
})

const copied = []
const events = []
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { copied.push(value) } } })
const style = document.createElement('style')
style.textContent = `body { min-width: 0; background: #ddd; } #fixture { min-width: 0; } .ai-browser-fixture.app-shell { display: block; min-width: 0; min-height: 0; height: 850px; overflow: hidden; margin: 12px; padding: 0; } .ai-browser-fixture > .assistant-panel { height: 100%; width: 100%; min-width: 0; }`
document.head.append(style)

createApp({
  render() {
    return h('main', { class: `app-shell theme-${state.theme} ai-browser-fixture`, style: { width: `${state.width}px`, zoom: state.zoom } }, [h(AiPanel, {
      ...state.props,
      onSetSessionMode: (id, mode) => { state.props.workspaceSessions[0].aiMode = mode; events.push({ type: 'mode', mode }) },
      onAppendMessage: message => state.props.messages.push(message),
      onUpdateMessage: message => { const index = state.props.messages.findIndex(item => item.id === message.id); if (index >= 0) state.props.messages[index] = message },
      onExecuteCommand: value => events.push({ type: 'execute', value })
    })])
  }
}).mount('#fixture')

window.aiFixture = {
  state,
  copied,
  events,
  messages,
  async configure(value) { Object.assign(state, value); await nextTick(); await new Promise(requestAnimationFrame) },
  async update(id, values) { Object.assign(state.props.messages.find(item => item.id === id), values); await nextTick(); await new Promise(requestAnimationFrame) },
  async reset() { state.props.messages = structuredClone(messages); await nextTick(); await new Promise(requestAnimationFrame) }
}
await document.fonts.ready
window.aiFixtureReady = true
