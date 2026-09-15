// Loaded before the real Vue application. Native IPC is synthetic; the clock
// offset only ages directory caches. Application timers and identity deadlines run normally.
// All hosts, paths, files and terminal sessions below are synthetic test data.
export function installSftpFixture() {
  const nativeSetTimeout = window.setTimeout.bind(window)
  const nativeNow = Date.now.bind(Date)
  let clockOffset = 0
  Date.now = () => nativeNow() + clockOffset
  const listeners = new Map()
  const sessions = new Map()
  const pendingTransfers = new Map()
  const pendingProbes = new Map()
  let listenerId = 0
  let sessionSequence = 0
  const endpoint = (host, username = 'deploy') => ({ host, port: 22, username, authMode: 'auto' })
  const profile = (id, name, host) => ({
    id, name, connectionRole: 'bastion', gateway: endpoint('bastion.example.test', 'operator'),
    target: endpoint(host), jumpMode: 'interactive-menu', menuProfileId: '', fileTransferMode: 'auto',
  })
  const identities = {
    alpha: { username: 'deploy', hostname: 'atlas', ips: ['127.0.1.1', '10.20.0.17', '172.20.0.17', '172.20.0.17', '2001:db8::17'], pwd: '/srv/atlas', machine: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    beta: { username: 'ops', hostname: 'borealis', ips: ['10.30.0.23'], pwd: '/srv/borealis', machine: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
  }
  const f = window.__sftpFixture = {
    nativeBoundaryMocked: true,
    profiles: [profile('alpha', 'Atlas · 双网卡', 'atlas.example.test'), profile('beta', 'Borealis · 日志', 'borealis.example.test')],
    identities,
    calls: [],
    probePlan: { '10.20.0.17': { error: 'network unreachable: fixture first interface' } },
    identityMode: {},
    directoryErrors: {},
    uploads: [],
    savedFiles: [],
    emit,
    terminalOutput(profileId, data) {
      for (const [id, session] of sessions) if (session.profileId === profileId) emit(`terminal:data:${id}`, { sessionId: id, data })
    },
    prompt(profileId) {
      const identity = identities[profileId]
      this.terminalOutput(profileId, `\r\n\x1b]133;D;0\x07\x1b]133;A\x07${identity.username}@${identity.hostname}:${identity.pwd}$ \x1b]133;B\x07`)
    },
    disconnect(profileId) {
      for (const [id, session] of sessions) if (session.profileId === profileId) emit(`terminal:closed:${id}`, { sessionId: id, reason: 'fixture disconnect' })
    },
    finishTransfer(taskId) {
      const pending = pendingTransfers.get(taskId)
      if (!pending) throw new Error(`Missing synthetic transfer ${taskId}`)
      pendingTransfers.delete(taskId)
      emit(`sftp:transfer:${taskId}`, { taskId, percent: 100, transferredBytes: 4096, totalBytes: 4096 })
      pending.resolve({ message: 'Synthetic transfer complete', targetPath: pending.targetPath, remotePath: pending.targetPath })
    },
    finishProbe(taskId) {
      const pending = pendingProbes.get(taskId)
      if (!pending) throw new Error(`Missing synthetic probe ${taskId}`)
      pendingProbes.delete(taskId)
      pending.resolve({ available: true, path: '/home/deploy', message: 'Synthetic SFTP ready' })
    },
    pendingTransferIds: () => [...pendingTransfers.keys()],
    pendingProbeIds: () => [...pendingProbes.keys()],
    // Model elapsed cache age without waiting 30 seconds or changing application timers.
    advanceWallClock(ms) {
      clockOffset += ms
    },
  }
  function emit(event, payload) {
    for (const [id, record] of listeners) {
      if (record.event === event) window[`_${record.handler}`]?.({ event, id, windowLabel: 'main', payload })
    }
  }
  function entry(parent, name, isDir = false, size = 2048) {
    return { name, path: `${parent.replace(/\/$/, '')}/${name}`, isDir, size: isDir ? 0 : size, modified: '2026-09-15 09:41:00', permissions: isDir ? 'drwxr-xr-x' : '-rw-r--r--' }
  }
  function directory(path, local) {
    const normalized = (path || (local ? 'C:/fixture' : '/home/deploy')).replaceAll('\\', '/').replace(/\/$/, '') || '/'
    if (f.directoryErrors[normalized]) throw new Error(f.directoryErrors[normalized])
    const names = local ? ['release-a', 'release-b', 'output'] : ['archive', 'config', 'logs']
    const entries = [
      ...names.map(name => entry(normalized, name, true)),
      entry(normalized, '.env'), entry(normalized, 'bundle.tar', false, 4096),
      entry(normalized, 'config.txt'), entry(normalized, 'notes.txt'),
      ...Array.from({ length: 70 }, (_, index) => entry(normalized, `service-${String(index + 1).padStart(2, '0')}.log`, false, (index + 1) * 1000)),
    ]
    return { path: normalized, home: 'C:/fixture', entries }
  }
  async function invoke(payload) {
    const { cmd, callback, error, ...args } = payload
    if (cmd === 'tauri') {
      const message = args.message || {}
      if (args.__tauriModule === 'Event') {
        if (message.cmd === 'listen') {
          const id = ++listenerId
          listeners.set(id, message)
          if (message.event.startsWith('terminal:data:')) {
            const sessionId = message.event.slice('terminal:data:'.length)
            nativeSetTimeout(() => {
              const session = sessions.get(sessionId)
              const identity = identities[session?.profileId]
              const prompt = identity ? `${identity.username}@${identity.hostname}:${identity.pwd}$ ` : 'PS C:\\fixture> '
              emit(message.event, { sessionId, data: `\r\n\x1b]133;A\x07${prompt}\x1b]133;B\x07` })
            }, 50)
          }
          return id
        }
        if (message.cmd === 'unlisten') { listeners.delete(message.eventId); return null }
        if (message.cmd === 'emit') { emit(message.event, message.payload); return null }
      }
      if (args.__tauriModule === 'App') return message.cmd === 'getVersion' ? '0.0.0-fixture' : 'ai-term-browser-fixture'
      if (args.__tauriModule === 'Window') return null
      if (args.__tauriModule === 'Clipboard') return ''
      throw new Error(`Unmocked Tauri module: ${args.__tauriModule}/${message.cmd}`)
    }
    f.calls.push({ cmd, ...args })
    if (cmd === 'list_connection_profiles') return structuredClone(f.profiles)
    if (cmd.startsWith('list_')) return []
    if (cmd === 'get_ai_provider_config') return null
    if (cmd === 'save_connection_profile') {
      const index = f.profiles.findIndex(profile => profile.id === args.profile.id)
      if (index >= 0) f.profiles[index] = structuredClone(args.profile)
      else f.profiles.push(structuredClone(args.profile))
      return null
    }
    if (cmd === 'local_home_directory') return 'C:/fixture'
    if (cmd === 'local_list_roots') return ['C:/', 'D:/']
    if (cmd === 'local_list_directory') return directory(args.path, true)
    if (cmd === 'local_open_path') return null
    if (cmd === 'sftp_list_directory') return directory(args.path, false)
    if (cmd === 'sftp_probe') {
      const plan = f.probePlan[args.targetHost]
      if (plan?.hold) return new Promise((resolve, reject) => pendingProbes.set(args.taskId, { resolve, reject }))
      if (plan?.error) throw new Error(plan.error)
      return { available: true, path: '/home/deploy', message: 'Synthetic SFTP ready' }
    }
    if (cmd === 'connect_local_terminal') {
      sessions.set(args.sessionId, { profileId: 'local' })
      return args.sessionId
    }
    if (cmd === 'connect_profile') {
      const id = `fixture-${args.profileId}-${++sessionSequence}`
      sessions.set(id, { profileId: args.profileId })
      return id
    }
    if (cmd === 'terminal_session_active') return sessions.has(args.sessionId)
    if (cmd === 'terminal_resize' || cmd === 'save_command_history_record') return null
    if (cmd === 'disconnect_terminal') { sessions.delete(args.sessionId); return true }
    if (cmd === 'terminal_write') {
      const session = sessions.get(args.sessionId)
      const identity = identities[session?.profileId]
      const begin = args.data.match(/AI_TERM_IDENT_BEGIN_[A-Za-z0-9_]+/)?.[0]
      const end = args.data.match(/AI_TERM_IDENT_END_[A-Za-z0-9_]+/)?.[0]
      if (begin && end && identity) {
        const mode = f.identityMode[session.profileId]
        if (mode === 'send-error') throw new Error('fixture write failed')
        if (mode === 'hold') return null
        nativeSetTimeout(() => {
          const output = `\x1b]133;C\x07\r\n${begin}\r\nuser=${identity.username}\r\nhostname=${identity.hostname}\r\nips=${identity.ips.join(' ')}\r\npwd=${identity.pwd}\r\nmachine=${identity.machine}\r\n${end}\r\n\x1b]133;D;0\x07\x1b]133;A\x07${identity.username}@${identity.hostname}:${identity.pwd}$ \x1b]133;B\x07`
          emit(`terminal:data:${args.sessionId}`, { sessionId: args.sessionId, data: output })
        }, 50)
      }
      return null
    }
    if (cmd === 'sftp_upload_path' || cmd === 'sftp_download_path') {
      const targetPath = cmd === 'sftp_upload_path' ? `${args.remoteDir}/${args.localPath.split(/[\\/]/).at(-1)}` : `${args.localDir}/${args.remotePath.split('/').at(-1)}`
      f.uploads.push({ cmd, ...args, targetPath })
      return new Promise((resolve, reject) => {
        pendingTransfers.set(args.taskId, { resolve, reject, targetPath })
        nativeSetTimeout(() => emit(`sftp:transfer:${args.taskId}`, { taskId: args.taskId, percent: 45, transferredBytes: 1843, totalBytes: 4096, bytesPerSecond: 512, remainingSeconds: 5 }), 80)
      })
    }
    if (cmd === 'cancel_task') {
      const transfer = pendingTransfers.get(args.taskId)
      if (transfer) { pendingTransfers.delete(args.taskId); transfer.reject(new Error('task cancelled')) }
      // Keep held probes resolvable to test application rejection of late native results.
      return true
    }
    if (cmd === 'sftp_read_text_file') return { path: args.remotePath, content: 'name=atlas\nenabled=true\n', revision: 'fixture-revision-1', size: 24 }
    if (cmd === 'sftp_save_text_file') {
      f.savedFiles.push(args)
      return { path: args.remotePath, content: args.content, revision: 'fixture-revision-2', size: args.content.length }
    }
    if (cmd.startsWith('save_')) return null
    throw new Error(`Unmocked native command: ${cmd}`)
  }
  window.__TAURI_METADATA__ = { __currentWindow: { label: 'main' }, __windows: [{ label: 'main' }] }
  window.__TAURI_IPC__ = payload => {
    Promise.resolve().then(() => invoke(payload)).then(
      value => window[`_${payload.callback}`]?.(value),
      reason => window[`_${payload.error}`]?.(reason instanceof Error ? reason.message : String(reason)),
    )
  }
}
