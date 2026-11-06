// Compose synthetic model/checkpoint IPC with the existing PTY fixture. All Vue
// components, conversation routing, terminal ownership and capture code are real.
export function installAiBackgroundFixture(installAiRuntimeFixture) {
  const nativeIpc = window.__TAURI_IPC__
  const runtime = installAiRuntimeFixture({})
  const aiIpc = window.__TAURI_IPC__
  const messages = new Map(), sessions = new Map()
  const accept = (call, value) => window[`_${call.callback}`]?.(value)
  const aiCommands = new Set(['ai_agent_turn_stream', 'chat_with_ai_provider_stream', 'cancel_task',
    'begin_agent_run', 'save_agent_checkpoint', 'release_agent_run', 'list_agent_checkpoints', 'touch_agent_command_allowlist_entry'])
  const config = { id: 'background-fixture', provider: 'open-ai-compatible', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture-only', apiKeyRef: '', contextPolicy: 'active-command-output', systemPrompt: '', riskPolicy: 'confirm-dangerous', timeoutSeconds: 120 }
  const fixture = window.__aiBackground = {
    runtime, cancellations: [], heldWrites: [], messages, sessions,
    app: () => document.querySelector('.app-shell')?.__vueParentComponent?.setupState,
    reply(goal, text, calls = []) {
      const index = runtime.requests.findIndex(call => call.request.goal === goal)
      if (index < 0) throw Error(`No pending request for ${goal}`)
      runtime.requests.unshift(...runtime.requests.splice(index, 1))
      runtime.reply(text, calls)
    },
    releaseWrite() { const call = fixture.heldWrites.shift(); if (!call) throw Error('No held write'); nativeIpc(call) },
  }
  window.__TAURI_IPC__ = call => {
    if (call.cmd === 'cancel_task') fixture.cancellations.push(call.taskId)
    if (aiCommands.has(call.cmd)) return aiIpc(call)
    if (call.cmd === 'tauri' && call.__tauriModule === 'Event' && call.message?.event?.startsWith('ai:')) return aiIpc(call)
    if (call.cmd === 'list_ai_provider_configs') return accept(call, [config])
    if (call.cmd === 'save_workspace_session') { sessions.set(call.session.id, call.session); return accept(call, null) }
    if (call.cmd === 'list_workspace_sessions') return accept(call, [...sessions.values()])
    if (call.cmd === 'save_ai_conversation_message') { messages.set(call.message.id, call.message); return accept(call, null) }
    if (call.cmd === 'list_ai_conversation_messages') return accept(call, [...messages.values()].filter(item => item.workspaceSessionId === call.workspaceSessionId))
    if (call.cmd === 'generate_ai_session_title') return accept(call, { title: call.request.userMessage })
    if (call.cmd === 'host_knowledge_context') return accept(call, '')
    if (call.cmd === 'terminal_write' && call.fixtureSource === 'echo BACKGROUND_A') { fixture.heldWrites.push(call); return }
    return nativeIpc(call)
  }
}
