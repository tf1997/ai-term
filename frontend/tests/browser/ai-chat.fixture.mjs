import { createApp, h, nextTick, reactive } from 'vue'
import AiPanel from '../../src/domains/ai/presentation/components/AiPanel.vue'
import AgentStepCard from '../../src/domains/ai/presentation/components/messages/AgentStepCard.vue'
import { hydrateAiMessagePayload } from '../../src/domains/ai/domain/workspaceSessions'
import { installAiRuntimeFixture } from './ai-runtime.fixture.mjs'
import '../../src/app/styles/index.css'

const now = '2026-09-12T12:00:00.000Z'
const command = 'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID, VolumeName, FileSystem, Size, FreeSpace'
const longCommand = [
  "echo '=== 1. pid 12290 是什么进程 ==='",
  'ps -p 12290 -o pid,user,etime,args --width 200 | cut -c1-200',
  "echo '=== 2. 本机 ZK 四字命令 ruok ==='",
  "(echo ruok; sleep 1) | timeout 5 nc 127.0.0.1 2181 || echo 'ruok 无响应或失败'",
  "echo '=== 3. srvr 状态 Leader/Follower ==='",
  "(echo srvr; sleep 1) | timeout 5 nc 127.0.0.1 2181 | head -15",
  "echo '=== 4. ZooKeeper 与 ClickHouse 监听端口 ==='",
  "ss -lntp | awk 'NR == 1 || /:2181|:8123|:9000/'",
  "echo '=== 5. 最后输出行，必须可查看和完整复制 ==='"
].join('\n')
const targetLabel = 'ag.hirain.com · tengfei.chu@ag.hirain.com'
const longReason = '确认 2181 端口进程身份，并用 ruok/srvr 检查本机 ZooKeeper 是否正常服务，核对 Leader/Follower 状态以及 ClickHouse 连接情况'
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
  assistant('long-output', 'Collected diagnostic output.', { mode: 'agent', agentStatus: 'done', agentSteps: [step('long-step', { reason: longReason, command: longCommand, output: longOutput })] }),
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
  approvalPreview: false,
  panelVersion: 0,
  props: {
    ...base,
    workspaceSessions: [{ id: base.workspaceSessionId, connectionId: 'local', name: 'Terminal assistant', summary: '', aiMode: 'chat', createdAt: now, updatedAt: now }],
    connectionLabels: { local: targetLabel },
    executionTargetLabel: targetLabel,
    executionTargetTitle: targetLabel,
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
const runtime = installAiRuntimeFixture(state.props)
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { copied.push(value) } } })
const style = document.createElement('style')
style.textContent = `body { min-width: 0; background: #ddd; } #fixture { min-width: 0; } .ai-browser-fixture.app-shell { display: block; min-width: 0; min-height: 0; height: 850px; overflow: hidden; margin: 12px; padding: 0; } .ai-browser-fixture > .assistant-panel { height: 100%; width: 100%; min-width: 0; }`
document.head.append(style)

createApp({
  render() {
    if (state.approvalPreview) {
      return h('main', { class: 'app-shell theme-' + state.theme + ' ai-browser-fixture', style: { width: state.width + 'px', zoom: state.zoom } }, [
        h('section', { class: 'assistant-panel ai-chat-panel', style: { padding: '16px', boxSizing: 'border-box', overflow: 'auto' } }, [
          h(AgentStepCard, {
            step: step('approval-preview', { reason: longReason, command: longCommand, status: 'pending', executionPhase: 'not-started', output: undefined, exitCode: undefined, durationMs: undefined }),
            awaitingApproval: true,
            targetLabel
          })
        ])
      ])
    }
    return h('main', { class: `app-shell theme-${state.theme} ai-browser-fixture`, style: { width: `${state.width}px`, zoom: state.zoom } }, [h(AiPanel, {
      key: state.panelVersion,
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
  runtime,
  messages,
  async configure(value) { Object.assign(state, value); await nextTick(); await new Promise(requestAnimationFrame) },
  async update(id, values) { Object.assign(state.props.messages.find(item => item.id === id), values); await nextTick(); await new Promise(requestAnimationFrame) },
  async reset() { state.props.messages = structuredClone(messages); await nextTick(); await new Promise(requestAnimationFrame) },
  async beginRuntime(mode, values = {}) {
    runtime.reset()
    state.approvalPreview = false
    state.panelVersion++
    state.props.workspaceSessions[0].aiMode = mode
    Object.assign(state.props, { agentAllowlistPatterns: [], agentBuiltinReadonlyEnabled: false, agentCommandTimeoutMs: 120000, ...values })
    state.props.messages = structuredClone(messages.slice(0, 8))
    await nextTick(); await new Promise(requestAnimationFrame)
  },
  async reopen() {
    state.props.messages = state.props.messages.map(message => {
      const { id, connectionId, workspaceSessionId, terminalId, role, text, command, error, payloadJson, createdAt } = message
      return hydrateAiMessagePayload({ id, connectionId, workspaceSessionId, terminalId, role, text, command, error, payloadJson, createdAt })
    })
    state.panelVersion++
    await nextTick(); await new Promise(requestAnimationFrame)
  }
}
await document.fonts.ready
window.aiFixtureReady = true
