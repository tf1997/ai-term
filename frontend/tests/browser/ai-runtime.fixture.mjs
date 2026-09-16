// Synthetic native boundary for real AiPanel interactions. No model, shell or database is contacted.
export function installAiRuntimeFixture(props) {
  const listeners = new Map()
  const runtime = { requests: [], commands: [], pendingCommands: [], pendingSaves: [] }
  const accept = (call, value) => window[`_${call.callback}`]?.(value)
  const reject = (call, error) => window[`_${call.error}`]?.(String(error))
  let listenerId = 0
  window.__TAURI_IPC__ = call => {
    if (call.cmd === 'tauri' && call.__tauriModule === 'Event') {
      if (call.message.cmd === 'listen') {
        const id = ++listenerId
        listeners.set(id, call.message)
        accept(call, id)
      } else {
        listeners.delete(call.message.eventId)
        accept(call, null)
      }
    } else if (call.cmd === 'ai_agent_turn_stream' || call.cmd === 'chat_with_ai_provider_stream') {
      runtime.requests.push(call)
    } else if (call.cmd === 'cancel_task') {
      const index = runtime.requests.findIndex(request => request.requestId === call.taskId)
      if (index >= 0) reject(runtime.requests.splice(index, 1)[0], 'cancelled')
      accept(call, null)
    } else if (call.cmd === 'touch_agent_command_allowlist_entry') {
      accept(call, null)
    } else {
      reject(call, `Unexpected fixture IPC: ${call.cmd}`)
    }
  }
  props.agentCommandRunner = (_terminal, command) => {
    const startedAt = Date.now()
    let finish
    const result = new Promise(resolve => { finish = resolve })
    runtime.commands.push(command)
    runtime.pendingCommands.push({ finish, startedAt })
    return {
      result, peekOutput: () => '',
      cancel: () => finish({ status: 'cancelled', durationMs: Date.now() - startedAt, output: '', truncated: false })
    }
  }
  props.agentAllowPattern = (pattern, sourceCommand) => new Promise((resolve, reject) => {
    runtime.pendingSaves.push({ pattern, sourceCommand, resolve, reject })
  })
  runtime.reply = (text, commands = []) => {
    const call = runtime.requests.shift()
    if (!call) throw Error('No model request is pending')
    const toolCalls = commands.map(({ id, command }) => ({ id, name: 'run_command', arguments: JSON.stringify({ command, reason: text }) }))
    accept(call, call.cmd === 'ai_agent_turn_stream'
      ? { text, toolCalls, contextCompressed: false, contextChars: 0 }
      : { answer: text, contextCompressed: false, contextChars: 0, historyCount: 0 })
  }
  runtime.finishSave = () => {
    const save = runtime.pendingSaves.shift()
    if (!save) throw Error('No permission save is pending')
    props.agentAllowlistPatterns.push(save.pattern)
    save.resolve()
  }
  runtime.finishCommand = () => {
    const command = runtime.pendingCommands.shift()
    if (!command) throw Error('No command is pending')
    command.finish({ status: 'completed', output: 'ok', exitCode: 0, durationMs: Date.now() - command.startedAt, truncated: false })
  }
  runtime.reset = () => {
    if (runtime.requests.length || runtime.pendingSaves.length) throw Error('Finish the previous runtime before resetting')
    runtime.commands = []
    runtime.pendingCommands = []
  }
  return runtime
}
