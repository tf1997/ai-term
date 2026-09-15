// Extends the existing synthetic SFTP backend with a PTY-like command echo.
// Install after installSftpFixture(), before the real application mounts.
export function installTerminalDebugFixture() {
  const fixture = window.__sftpFixture
  if (!fixture?.nativeBoundaryMocked) throw new Error('The isolated SFTP fixture must be installed first')
  const originalIpc = window.__TAURI_IPC__
  const schedule = window.setTimeout.bind(window)
  const typed = new Map()
  const tails = new Map()
  const debug = window.__terminalDebugFixture = {
    diagnostics: [],
    ordinaryCommands: [],
    rawChunks: [],
    pendingChunks: 0,
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
      ? `\x1b]133;D;${exitCode}\x07\x1b]133;A\x07${label}\x1b]133;B\x07`
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
        output += `\r\n${debug.shellIntegration ? '\x1b]133;C\x07' : ''}${result.body ? `${result.body}\r\n` : ''}${prompt(profileId, result.code)}`
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
    const begin = args.data.match(/AI_TERM_(?:IDENT|FILE)_BEGIN_[A-Za-z0-9_]+/)?.[0]
    const end = args.data.match(/AI_TERM_(?:IDENT|FILE)_END_[A-Za-z0-9_]+/)?.[0]
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
        const body = begin.startsWith('AI_TERM_IDENT_')
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
          void enqueue(args.sessionId, mode === 'echo-only' ? echo : `${echo}\r\n${begin}\r\n${body}\r\n${end}\r\n${prompt(profileId)}`)
        }
      }
    } else ordinaryInput(args.sessionId, args.data, profileId)
    Promise.resolve().then(() => window[`_${callback}`]?.(null))
  }
}
