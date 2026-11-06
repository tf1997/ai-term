// Synthetic native boundary for real AiPanel interactions. No model, shell or database is contacted.
export function installAiRuntimeFixture(props) {
  const listeners = new Map()
  const runtime = { requests: [], commands: [], pendingCommands: [], pendingSaves: [], snapshotReads: 0, checkpoints: new Map(), checkpointEvents: [], checkpointOwners: new Map() }
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
    } else if (call.cmd === 'command_execution_target') {
      accept(call, { sessionId: props.terminalId, sessionInstance: 'fixture', profileId: props.connectionId, routeVersion: 0, contextVersion: 1, context: { shell: 'bash', user: '1000', workingDirectory: '/workspace', environmentScope: 'fixture' } })
    } else if (call.cmd === 'begin_agent_run') {
      const lease = { runId: call.start.runId, token: crypto.randomUUID(), sequence: 0 }
      runtime.checkpointOwners.set(lease.runId, lease.token)
      runtime.checkpoints.set(lease.runId, { ...call.start, target: call.expected, lastTarget: call.expected, routeKey: 'fixture-route', sequence: 0, boundary: 'started', stepId: null, state: { status: 'calling-model', steps: [], plan: null, verifications: [], finalText: '', error: null, stopReason: null }, createdAt: Date.now(), updatedAt: Date.now() })
      accept(call, lease)
    } else if (call.cmd === 'reply_agent_run') {
      const record = runtime.checkpoints.get(call.runId)
      if (!record || record.sequence !== call.expectedSequence || record.state.status !== 'waiting-input' || runtime.checkpointOwners.has(call.runId)) { reject(call, 'Unavailable waiting task'); return }
      record.userInputs ??= []
      const confirmedAt = Date.now()
      const confirmedPlanItems = (call.reply.confirmedPlanItemIds ?? []).map(id => {
        const item = record.state.plan?.items.find(item => item.id === id)
        if (!item || ['completed', 'cancelled', 'skipped'].includes(item.status)) throw Error('Invalid confirmation item')
        item.status = 'completed'; item.userConfirmation = { messageId: call.reply.messageId, confirmedAt }
        return { id: item.id, description: item.description }
      })
      if (confirmedPlanItems.length) {
        record.state.plan.version++; record.state.plan.reason = '用户确认了已完成事项'
        record.state.plan.changes.push({ version: record.state.plan.version, reason: record.state.plan.reason })
      }
      record.userInputs.push({ messageId: call.reply.messageId, question: record.state.finalText, text: call.reply.text, redacted: false, createdAt: confirmedAt, confirmedPlanItems })
      record.recovery = { phase: 'continuing', sourceSequence: record.sequence, sourceStepIds: record.state.steps.map(step => step.id), requiredStepIds: [], originalTarget: record.lastTarget ?? record.target, currentTarget: call.expected, resolutions: [] }
      record.messageId = call.reply.assistantMessageId
      record.sequence++; record.boundary = 'resumed'; record.state.status = 'calling-model'; record.state.finalText = ''; record.state.error = null
      const lease = { runId: record.runId, sequence: record.sequence, token: crypto.randomUUID() }
      runtime.checkpointOwners.set(record.runId, lease.token)
      accept(call, { lease, checkpoint: structuredClone(record) })
    } else if (call.cmd === 'recover_agent_run') {
      const record = runtime.checkpoints.get(call.runId)
      if (!record || record.sequence !== call.expectedSequence || runtime.checkpointOwners.has(call.runId)) { reject(call, 'Unavailable recovery'); return }
      record.recovery = { phase: 'inspecting', sourceSequence: record.sequence, sourceStepIds: record.state.steps.map(step => step.id), requiredStepIds: record.state.steps.filter(step => step.executionPhase !== 'not-started' && step.executionPhase !== 'finished').map(step => step.id), originalTarget: record.lastTarget ?? record.target, currentTarget: call.expected, resolutions: [] }
      record.sequence++; record.boundary = 'recovering'; record.state.status = 'calling-model'; record.state.finalText = ''; record.state.error = null
      const lease = { runId: record.runId, sequence: record.sequence, token: crypto.randomUUID() }
      runtime.checkpointOwners.set(record.runId, lease.token)
      accept(call, { lease, checkpoint: structuredClone(record) })
    } else if (call.cmd === 'confirm_agent_recovery') {
      const record = runtime.checkpoints.get(call.lease.runId)
      if (!record || record.sequence !== call.expectedSequence || runtime.checkpointOwners.get(record.runId) !== call.lease.token || record.recovery?.phase !== 'inspecting') { reject(call, 'Stale recovery'); return }
      record.recovery.phase = 'continuing'; record.recovery.resolutions = structuredClone(call.resolutions)
      record.resolvedEffects = structuredClone(call.resolutions); record.sequence++; record.boundary = 'resumed'
      runtime.checkpointEvents.push({ boundary: record.boundary })
      accept(call, structuredClone(record))
    } else if (call.cmd === 'save_agent_checkpoint') {
      const record = runtime.checkpoints.get(call.lease.runId)
      if (!record || runtime.checkpointOwners.get(record.runId) !== call.lease.token || record.sequence !== call.update.expectedSequence) { reject(call, 'Stale checkpoint'); return }
      Object.assign(record, structuredClone(call.update), { sequence: record.sequence + 1, updatedAt: Date.now() })
      runtime.checkpointEvents.push({ boundary: record.boundary, stepId: record.stepId, state: structuredClone(record.state) })
      if (record.boundary === 'finished') runtime.checkpointOwners.delete(record.runId)
      accept(call, record.sequence)
    } else if (call.cmd === 'release_agent_run') {
      runtime.checkpointOwners.delete(call.lease.runId); accept(call, null)
    } else if (call.cmd === 'list_agent_checkpoints') {
      accept(call, [...runtime.checkpoints.values()].filter(record => record.target.profileId === call.profileId && record.workspaceSessionId === call.workspaceSessionId && record.state.status !== 'done'))
    } else if (call.cmd === 'touch_agent_command_allowlist_entry') {
      accept(call, null)
    } else {
      reject(call, `Unexpected fixture IPC: ${call.cmd}`)
    }
  }
  props.agentCommandRunner = (_terminal, command, options) => {
    if (options?.internal) {
      const tag = command.match(/AI_TERM_SNAPSHOT_[A-Za-z0-9_]+(?=_SCOPE\\n)/)?.[0]
        ?? command.match(/AI_TERM_SNAPSHOT_([0-9]+_[a-z0-9]+)_SCOPE/)?.[0].replace(/_SCOPE$/, '')
      if (!tag) throw Error('Expected snapshot reader')
      const content = runtime.snapshotReads++ % 2 ? 'after\nnew line\n' : 'before\n'
      const output = `${tag}_SCOPE\n${btoa('fixture-host')}\n${tag}_SCOPE_END\n${tag}_FILE_0\n${btoa('/workspace/fixture-file.txt')}\n${tag}_PATH_END\ntext\n${btoa(content + `\n${tag}_READ_STATUS_0\n`)}\n${tag}_FILE_END\n`
      return { result: Promise.resolve({ status: 'completed', output, exitCode: 0, durationMs: 1, truncated: false }), peekOutput: () => '', cancel() {} }
    }
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
    const toolCalls = commands.map(({ id, command, files, name = 'run_command', arguments: args }) => ({ id, name, arguments: args ?? JSON.stringify({ command, reason: text, files }) }))
    accept(call, call.cmd === 'ai_agent_turn_stream'
      ? { text, toolCalls, contextCompressed: false, contextChars: 0 }
      : { answer: text, contextCompressed: false, contextChars: 0, historyCount: 0 })
  }
  runtime.askUser = question => {
    const call = runtime.requests.shift()
    if (!call || call.cmd !== 'ai_agent_turn_stream') throw Error('No Agent request is pending')
    accept(call, { text: '', toolCalls: [{ id: 'ask-user', name: 'ask_user', arguments: JSON.stringify({ question }) }], contextCompressed: false, contextChars: 0 })
  }
  runtime.stream = (kind, delta) => {
    const requestId = runtime.requests[0]?.requestId
    if (!requestId) throw Error('No model request is pending')
    for (const [id, listener] of listeners) {
      if (listener.event === `ai-chat:stream:${requestId}`) {
        window[`_${listener.handler}`]?.({ event: listener.event, id, payload: { requestId, kind, delta } })
      }
    }
  }
  runtime.finishSave = () => {
    const save = runtime.pendingSaves.shift()
    if (!save) throw Error('No permission save is pending')
    props.agentAllowlistPatterns.push(save.pattern)
    save.resolve()
  }
  runtime.finishCommand = (values = {}) => {
    const command = runtime.pendingCommands.shift()
    if (!command) throw Error('No command is pending')
    command.finish({ status: 'completed', output: 'ok', exitCode: 0, durationMs: Date.now() - command.startedAt, truncated: false, ...values })
  }
  runtime.reset = () => {
    if (runtime.requests.length || runtime.pendingSaves.length) throw Error('Finish the previous runtime before resetting')
    runtime.commands = []
    runtime.snapshotReads = 0
    runtime.pendingCommands = []
  }
  return runtime
}
