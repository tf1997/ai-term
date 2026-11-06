// Extends the existing synthetic SFTP backend with a PTY-like command echo.
// Install after installSftpFixture(), before the real application mounts.
export function installTerminalDebugFixture() {
  const fixture = window.__sftpFixture
  if (!fixture?.nativeBoundaryMocked) throw new Error('The isolated SFTP fixture must be installed first')
  const originalIpc = window.__TAURI_IPC__
  const schedule = window.setTimeout.bind(window)
  const typed = new Map()
  const tails = new Map()
  const policyTargets = new Map(), policyIntents = new Map()
  let policySequence = 0
  const debug = window.__terminalDebugFixture = {
    diagnostics: [],
    ordinaryCommands: [],
    bracketedPaste: false,
    rawChunks: [],
    pendingChunks: 0,
    promptDelayMs: 0,
    waitingForPrompt: 0,
    fileBody: `${btoa('fixture-file-payload')}\r\nstatus=0`,
    localWrites: [],
    endControlSplit: 3,
    shellIntegration: sessionStorage.getItem('terminal-debug-fixture-shell-integration') !== 'off',
    emitLateDiagnosticStart(profileId) {
      const record = [...debug.diagnostics].reverse().find(item => item.profileId === profileId)
      if (!record) throw new Error(`No synthetic diagnostic for ${profileId}`)
      return enqueue(record.sessionId, `\r\n${record.begin}\r\nuser=${fixture.identities[profileId].username}\r\n`)
    },
    emitPrompt(profileId) {
      const sessionId = [...new Set(fixture.calls.filter(call => call.cmd === 'terminal_write').map(call => call.sessionId))]
        .reverse().find(id => profileFor(id) === profileId)
      if (!sessionId) throw new Error(`No synthetic session for ${profileId}`)
      return enqueue(sessionId, prompt(profileId))
    },
  }
  function profileFor(sessionId) {
    return fixture.profiles.find(profile => sessionId.startsWith(`fixture-${profile.id}-`))?.id
  }
  function prompt(profileId, exitCode = 0) {
    const identity = fixture.identities[profileId]
    const label = identity ? `${identity.username}@${identity.hostname}:${identity.pwd}$ ` : 'PS C:\\fixture> '
    return debug.shellIntegration
      ? `\x1b]133;D;${exitCode}\x07\x1b]133;A\x07${label}\x1b]133;B\x07${debug.bracketedPaste ? '\x1b[?2004h' : '\x1b[?2004l'}`
      : label
  }
  function transportChunks(data) {
    const cuts = new Set([0, data.length])
    const sizes = [1, 7, 23, 2, 51, 13, 89]
    for (let cursor = 0, step = 0; cursor < data.length; step++) {
      cursor = Math.min(data.length, cursor + sizes[step % sizes.length])
      cuts.add(cursor)
    }
    // Guarantee coverage of split CRLF, escape sequences, and result markers.
    for (const match of data.matchAll(/\r\n|\x1b|AI_TERM_(?:IDENT|FILE)_(?:BEGIN|END)_[A-Za-z0-9_]+/g)) {
      cuts.add(match.index + 1)
      if (match[0].startsWith('AI_TERM_')) cuts.add(match.index + Math.floor(match[0].length / 2))
    }
    const boundaries = [...cuts].sort((a, b) => a - b)
    return boundaries.slice(1).map((end, index) => data.slice(boundaries[index], end))
  }
  function enqueue(sessionId, data) {
    return enqueueChunks(sessionId, transportChunks(data))
  }
  function enqueueChunks(sessionId, chunks) {
    debug.pendingChunks += chunks.length
    const previous = tails.get(sessionId) ?? Promise.resolve()
    const next = previous.then(async () => {
      for (const chunk of chunks) {
        if (typeof chunk !== 'string') {
          debug.waitingForPrompt++
          await new Promise(resolve => schedule(resolve, chunk.delay))
          debug.waitingForPrompt--
          debug.pendingChunks--
          continue
        }
        await new Promise(resolve => schedule(resolve, 2))
        debug.rawChunks.push({ sessionId, data: chunk })
        fixture.emit(`terminal:data:${sessionId}`, { sessionId, data: chunk })
        debug.pendingChunks -= 1
      }
    })
    tails.set(sessionId, next)
    return next
  }
  function userOutput(command) {
    if (command === 'pwd') return { body: '/srv/atlas', code: 0 }
    if (command.startsWith('echo ')) return { body: command.slice(5).replace(/^['"]|['"]$/g, ''), code: 0 }
    if (command === 'fixture-missing-command') return { body: 'bash: fixture-missing-command: command not found', code: 127 }
    return { body: command ? `fixture command completed: ${command}` : '', code: 0 }
  }
  function ordinaryInput(sessionId, data, profileId) {
    if (data.includes('\x03')) {
      typed.set(sessionId, '')
      void enqueue(sessionId, `^C\r\n${prompt(profileId, 130)}`)
      return
    }
    let line = typed.get(sessionId) ?? ''
    let output = ''
    for (const char of data.replace(/\x1b\[20[01]~/g, '')) {
      if (char === '\r' || char === '\n') {
        const command = line.trim()
        const result = userOutput(command)
        debug.ordinaryCommands.push(command)
        output += command === 'fixture-parse-error'
          ? `\r\nzsh: parse error near \`then'\r\n${prompt(profileId).replace('\x1b]133;D;0\x07', '\x1b]133;D\x07')}`
          : `\r\n${debug.shellIntegration ? '\x1b]133;C\x07' : ''}${result.body ? `${result.body}\r\n` : ''}${prompt(profileId, result.code)}`
        line = ''
      } else if (char === '\x7f' || char === '\b') {
        if (line) { line = line.slice(0, -1); output += '\b \b' }
      } else {
        line += char
        output += char
      }
    }
    typed.set(sessionId, line)
    if (output) void enqueue(sessionId, output)
  }
  window.__TAURI_IPC__ = payload => {
    const reply = value => Promise.resolve().then(() => window[`_${payload.callback}`]?.(value))
    if (payload.cmd === 'command_execution_target') {
      if (!policyTargets.has(payload.sessionId)) policyTargets.set(payload.sessionId, {
        sessionId: payload.sessionId, sessionInstance: payload.sessionId, profileId: profileFor(payload.sessionId), routeVersion: 0, contextVersion: 0,
        context: { shell: 'unknown', workingDirectory: null, user: null, environmentScope: null },
      })
      reply(policyTargets.get(payload.sessionId)); return
    }
    if (payload.cmd === 'update_command_context') {
      const target = { ...payload.expected, contextVersion: payload.expected.contextVersion + 1, context: payload.context }
      policyTargets.set(target.sessionId, target); reply(target); return
    }
    if (payload.cmd === 'prepare_terminal_probe' || payload.cmd === 'analyze_command_intent') {
      const nonce = (++policySequence).toString(16).padStart(32, '0')
      const internal = payload.cmd === 'prepare_terminal_probe'
      const source = internal ? `fixture ${payload.probe.kind}` : payload.source
      const kind = internal ? payload.probe.kind === 'bracketed-capture' ? 'bracketed' : 'sentinel' : (payload.capture ?? 'none')
      const probeKind = payload.probe?.kind
      let terminalInput = internal
        ? ` : 'AI_TERM_INTERNAL_${nonce}'; printf 'AI_TERM_PROBE_BEGIN_${nonce}'; printf '__AI_TERM_%s__' ${nonce}B; ${source}; printf '__AI_TERM_%s__:%d' ${nonce}E $?; printf 'AI_TERM_PROBE_END_${nonce}'\r`
        : `${source}\r`
      if (kind === 'bracketed') terminalInput = `\x1b[200~${terminalInput.replace(/\r$/, '')}\x1b[201~\r`
      const intent = { reference: { id: nonce, target: payload.expected, operation: 'command', policyVersion: 'fixture' }, source, operation: 'command',
        capture: { kind, nonce, internal }, terminalInput, expiresInMs: 300000,
        analysis: { analysisStatus: 'complete', decision: 'allow', risks: [], unknownReasons: [], highestSeverity: null, policyVersion: 'fixture' } }
      policyIntents.set(nonce, { intent, probeKind }); reply(intent); return
    }
    if (payload.cmd === 'cancel_command_intent') { reply(policyIntents.delete(payload.reference.id)); return }
    if (payload.cmd === 'approve_command_intent') { reply(null); return }
    if (payload.cmd === 'dispatch_command_intent') {
      const stored = policyIntents.get(payload.reference.id)
      if (!stored) { window[`_${payload.error}`]?.('expired fixture intent'); return }
      policyIntents.delete(payload.reference.id)
      window.__TAURI_IPC__({ ...payload, cmd: 'terminal_write', sessionId: stored.intent.reference.target.sessionId, data: stored.intent.terminalInput, fixtureProbeKind: stored.probeKind, fixtureCaptureKind: stored.intent.capture.kind, fixtureSource: stored.intent.source })
      return
    }
    if (payload.cmd === 'tauri' && payload.__tauriModule === 'Event' &&
        payload.message?.cmd === 'listen' && payload.message.event.startsWith('terminal:data:')) {
      const key = `_${payload.message.handler}`
      const original = window[key]
      Object.defineProperty(window, key, {
        configurable: true,
        value: event => original(debug.shellIntegration ? event : {
          ...event, payload: { ...event.payload, data: event.payload.data.replace(/\x1b\]133;[^\x07]*\x07/g, '') },
        }),
      })
    }
    if (payload.cmd === 'local_write_transfer_file') {
      const { cmd, callback, error, ...args } = payload
      fixture.calls.push({ cmd, ...args })
      debug.localWrites.push(args)
      Promise.resolve().then(() => window[`_${callback}`]?.(null))
      return
    }
    if (payload.cmd !== 'terminal_write') return originalIpc(payload)
    const { cmd, callback, error, ...args } = payload
    fixture.calls.push({ cmd, ...args })
    const profileId = profileFor(args.sessionId)
    const identity = fixture.identities[profileId]
    if (args.fixtureCaptureKind === 'bracketed' && !args.fixtureProbeKind) {
      debug.ordinaryCommands.push(args.fixtureSource)
      void enqueue(args.sessionId, `${args.fixtureSource.replace(/\n/g, '\r\n')}\r\n\x1b[?2004l\x1b]633;E;${btoa(args.fixtureSource)};base64\x07\x1b]133;C\x07first\r\n\x1b]133;C\x07second\r\n${prompt(profileId, 9)}`)
      Promise.resolve().then(() => window[`_${callback}`]?.(null)); return
    }
    const begin = args.data.match(/AI_TERM_(?:IDENT|FILE|PROBE)_BEGIN_[A-Za-z0-9_]+/)?.[0]
    const end = args.data.match(/AI_TERM_(?:IDENT|FILE|PROBE)_END_[A-Za-z0-9_]+/)?.[0]
    if (identity && begin && end) {
      const mode = fixture.identityMode[profileId]
      const record = { sessionId: args.sessionId, profileId, command: args.data, begin, end, mode: mode ?? 'complete' }
      debug.diagnostics.push(record)
      if (mode === 'send-error') {
        Promise.resolve().then(() => window[`_${error}`]?.('fixture write failed'))
        return
      }
      if (mode !== 'hold') {
        const echo = `${args.data.replace(/\r?\n/g, '\r\n')}\x1b[?2004l${debug.shellIntegration ? '\x1b]133;C\x07' : ''}`
        const sentinelNonce = args.data.match(/\b([a-f0-9]{8,32})B\b/)?.[1]
        const probeExitCode = args.fixtureProbeKind && !['capture', 'bracketed-capture'].includes(args.fixtureProbeKind) ? 0 : 7
        const probeBody = args.fixtureProbeKind === 'context' ? `bash\r\n${btoa('/srv/atlas')}\r\nAI_TERM_CONTEXT_USER\r\n${btoa('1000')}\r\nAI_TERM_CONTEXT_SCOPE\r\n${btoa('fixture-host\n1000')}\r\nAI_TERM_CONTEXT_END` : args.fixtureProbeKind === 'bracketed-capture' ? 'AI_TERM_MULTILINE_FIRST\r\n\x1b]133;C\x07\nAI_TERM_CAPTURE_OK' : 'AI_TERM_CAPTURE_OK'
        const body = begin.startsWith('AI_TERM_PROBE_')
          ? sentinelNonce ? `__AI_TERM_${sentinelNonce}B__\r\n${probeBody}\r\n\r\n__AI_TERM_${sentinelNonce}E__:${probeExitCode}` : 'probe-result'
          : begin.startsWith('AI_TERM_IDENT_')
          ? `user=${identity.username}\r\nhostname=${identity.hostname}\r\nips=${identity.ips.join(' ')}\r\npwd=${identity.pwd}\r\nmachine=${identity.machine}`
          : debug.fileBody
        if (mode === 'split-end-control') {
          const control = '\x1b[0m'
          record.endControlSplit = debug.endControlSplit
          void enqueueChunks(args.sessionId, [
            ...transportChunks(`${echo}\r\n${begin}\r\n${body}\r\n`),
            `${end}${control.slice(0, debug.endControlSplit)}`,
            `${control.slice(debug.endControlSplit)}\r\n${prompt(profileId)}`,
          ])
        } else {
          void enqueueChunks(args.sessionId, mode === 'echo-only' ? transportChunks(echo) : [
            ...transportChunks(`${echo}\r\n${begin}\r\n${body}\r\n${end}\r\n`),
            { delay: debug.promptDelayMs },
            ...transportChunks(prompt(profileId, ['capture', 'bracketed-capture'].includes(args.fixtureProbeKind) ? 7 : 0)),
          ])
        }
      }
    } else ordinaryInput(args.sessionId, args.data, profileId)
    Promise.resolve().then(() => window[`_${callback}`]?.(null))
  }
}
