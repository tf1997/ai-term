import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  parseTerminalIdentitySnapshot,
  sanitizeHostCandidate,
  normalizeUsableIp,
} from '../domain/terminalIdentity'
import { captureFileTarget, connectionFailureKind, serverIdentityKey, sftpProfileRoute } from '../domain/fileSession'
import type {
  FileSessionContext,
  FileTargetBinding,
  ServerIdentity,
  TerminalFileBridge,
  ConnectionFailureKind,
} from '../domain/fileSession'
import type { TerminalOutputDeltaEvent } from '../../terminal/types'
import { sftpProbe, cancelTask } from '../infrastructure/api'

export const IDENTITY_TIMEOUT_MS = 12_000
export const CANDIDATE_TIMEOUT_MS = 20_000
export const CONNECTION_TIMEOUT_MS = 60_000

export interface CandidateFailure {
  host: string
  kind: ConnectionFailureKind
  message: string
}
type Phase = 'idle' | 'identifying' | 'connecting' | 'ready' | 'error' | 'cancelled' | 'stale'
interface PendingIdentity {
  begin: string
  end: string
  output: string
  terminalId: string
  stamp: string
  resolve: (identity: ServerIdentity) => void
  reject: (reason: Error) => void
}

export function boundedOperation<T>(
  action: () => Promise<T>,
  timeout: number,
  signal: AbortSignal,
  onStop: () => void = () => {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      callback()
    }
    const abort = () =>
      finish(() => {
        try { onStop() } catch { /* Cleanup must not prevent cancellation. */ }
        reject(new Error('操作已取消'))
      })
    const timer = setTimeout(
      () =>
        finish(() => {
          try { onStop() } catch { /* The timeout still ends the operation. */ }
          reject(new Error('连接超时，请重试或手动指定目标。'))
        }),
      Math.max(1, timeout),
    )
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
      return
    }
    Promise.resolve()
      .then(() => {
        if (settled) throw new Error('操作已取消')
        return action()
      })
      .then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      )
  })
}

export function useSftpConnection(options: {
  context: () => FileSessionContext
  bridge: () => TerminalFileBridge | undefined
  profileRoute?: () => string | undefined
  preferredHost?: (key: string) => string | undefined
  rememberHost?: (key: string, host: string) => void
  source?: { probe: typeof sftpProbe; cancel: typeof cancelTask }
  timeouts?: { identity: number; candidate: number; total: number }
}) {
  const source = options.source ?? { probe: sftpProbe, cancel: cancelTask }
  const timeouts = options.timeouts ?? {
    identity: IDENTITY_TIMEOUT_MS,
    candidate: CANDIDATE_TIMEOUT_MS,
    total: CONNECTION_TIMEOUT_MS,
  }
  const phase = ref<Phase>('idle')
  const binding = ref<FileTargetBinding | null>(null)
  const identity = ref<ServerIdentity | null>(null)
  const error = ref('')
  const failures = ref<CandidateFailure[]>([])
  const attempt = ref<{ host: string; index: number; total: number } | null>(null)
  const home = ref('.')
  const busy = computed(() => phase.value === 'identifying' || phase.value === 'connecting')
  let sequence = 0
  let revision = 0
  let controller: AbortController | null = null
  let disposed = false
  let pending: PendingIdentity | null = null

  const stamp = () => {
    const c = options.context()
    return JSON.stringify([
      c.terminalId,
      c.connectionId,
      c.generation,
      c.contextVersion,
      c.status,
      c.profile?.target,
      c.profile?.gateway,
      c.profile?.connectionRole,
      c.profile?.fileTransferMode,
      c.profile?.jumpMode,
      c.profile?.menuProfileId,
      options.profileRoute?.(),
    ])
  }
  const isTerminalTarget = () => {
    const c = options.context()
    return c.status !== 'sftp' && !c.profile?.fileTransferMode?.startsWith('sftp-')
  }
  const identityOperations = new Set<AbortController>()

  function feedOutput(event: TerminalOutputDeltaEvent | undefined) {
    const probe = pending
    if (!probe || !event || event.terminalId !== probe.terminalId || probe.stamp !== stamp()) return
    probe.output = `${probe.output}${event.delta}`.slice(-160_000)
    const parsed = parseTerminalIdentitySnapshot(`${probe.output}\n${event.snapshot}`, probe)
    if (!parsed.complete) return
    if (!parsed.ips.length || !parsed.values.user) {
      probe.reject(
        new Error(
          `没有识别到${!parsed.ips.length ? '可用服务器 IP' : '服务器账号'}。请在服务器命令提示符重试，或手动指定目标。`,
        ),
      )
    } else
      probe.resolve({
        username: parsed.values.user,
        hostname: parsed.values.hostname || parsed.ip,
        ips: parsed.ips,
        pwd: parsed.values.pwd || '.',
        machine: parsed.values.machine,
      })
  }

  async function readIdentity(signal: AbortSignal, timeout = timeouts.identity): Promise<ServerIdentity> {
    if (disposed || signal.aborted) throw new Error('操作已取消')
    // Reserve the terminal before the first microtask, including while write() is pending.
    if ([...identityOperations].some((operation) => !operation.signal.aborted))
      throw new Error('正在核对终端身份，请稍后重试。')
    const bridge = options.bridge()
    const context = options.context(), initialStamp = stamp()
    if (context.status !== 'remote' || !bridge) throw new Error('终端尚未连接，请先连接服务器。')
    const readiness = bridge.readiness()
    if (readiness !== 'ready')
      throw new Error(
        readiness === 'unavailable'
          ? '终端连接当前不可写，请重新连接服务器后重试。'
          : readiness === 'line-busy'
          ? '终端命令行有未执行的内容，请清空或执行后重试。'
          : '终端当前不在可执行命令的提示符，请退出交互程序或等待命令结束后重试。',
      )
    const id = `${Date.now()}_${(++sequence).toString(36)}${Math.random().toString(36).slice(2, 10)}`
    const begin = `AI_TERM_IDENT_BEGIN_${id}`,
      end = `AI_TERM_IDENT_END_${id}`
    const command =
      [
        `printf '\\n${begin}\\n'`,
        `printf 'user='; (id -un 2>/dev/null || whoami 2>/dev/null)`,
        `printf '\\nhostname='; hostname 2>/dev/null`,
        `printf '\\nips='; ((hostname -I 2>/dev/null || ip -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1) | tr '\\n' ' ')`,
        `printf '\\npwd='; pwd`,
        `printf '\\nmachine='; cat /etc/machine-id 2>/dev/null`,
        `printf '\\n${end}\\n'`,
      ].join('; ') + '\n'
    let own: PendingIdentity | null = null
    const operation = new AbortController()
    const abort = () => operation.abort()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) operation.abort()
    identityOperations.add(operation)
    try {
      return await boundedOperation(
        () => {
          const result = new Promise<ServerIdentity>((resolve, reject) => {
            own = {
              begin,
              end,
              output: '',
              terminalId: context.terminalId,
              stamp: initialStamp,
              resolve,
              reject,
            }
            pending = own
          })
          const sent = Promise.resolve().then(async () => {
            if (operation.signal.aborted || disposed || initialStamp !== stamp() || pending !== own)
              throw new Error('操作已取消')
            try {
              if (!(await bridge.write(command)))
                throw new Error('识别命令发送失败，请检查终端连接后重试。')
            } catch (reason) {
              throw new Error(`识别命令发送失败：${reason instanceof Error ? reason.message : String(reason)}`)
            }
          })
          return Promise.all([result, sent]).then(([actual]) => actual)
        },
        timeout,
        operation.signal,
      )
    } finally {
      if (pending === own) pending = null
      bridge.finish?.(command)
      identityOperations.delete(operation)
      signal.removeEventListener('abort', abort)
    }
  }

  function cancel() {
    controller?.abort()
    identityOperations.forEach(operation => operation.abort())
    pending = null
    controller = null
    if (busy.value) {
      phase.value = 'cancelled'
      error.value = '已取消，可以重新连接。'
    }
  }

  function invalidate(message = '终端目标或连接已变化，请重新确认服务器。') {
    cancel()
    revision += 1
    binding.value = null
    if (phase.value !== 'idle') {
      phase.value = 'stale'
      error.value = message
    }
  }

  async function connect(manual?: { host: string; username: string; profileRoute?: string }): Promise<FileTargetBinding | null> {
    if (disposed) return null
    cancel()
    const operation = new AbortController()
    controller = operation
    const initialStamp = stamp(),
      deadline = Date.now() + timeouts.total
    const context = options.context(),
      profile = context.profile
    const current = () =>
      !disposed && controller === operation && !operation.signal.aborted && initialStamp === stamp()
    const sourceKind = manual ? 'manual' : isTerminalTarget() ? 'terminal' : 'configured'
    failures.value = []
    error.value = ''
    attempt.value = null
    // Retain the browser's preferences while making the old route unavailable for writes.
    binding.value = null
    phase.value = sourceKind === 'terminal' ? 'identifying' : 'connecting'
    try {
      if (!profile || context.connectionId === 'local') throw new Error('请选择一个远程连接。')
      const profileRoute = manual?.profileRoute ?? options.profileRoute?.() ?? sftpProfileRoute(profile)
      let discovered: ServerIdentity | undefined
      if (sourceKind === 'terminal') {
        discovered = await readIdentity(operation.signal, Math.min(timeouts.identity, deadline - Date.now()))
        if (!current()) return null
        identity.value = discovered
      }
      const username = manual ? manual.username.trim() : discovered?.username || profile.target.username
      const specifiedHost = manual ? manual.host.trim() : profile.target.host
      if (!username || !/^[A-Za-z0-9_.@-]+\$?$/.test(username)) throw new Error('请输入有效的服务器账号。')
      if (!discovered && !normalizeUsableIp(specifiedHost) && !sanitizeHostCandidate(specifiedHost))
        throw new Error('请输入有效的服务器 IP 或主机名。')
      const hosts = discovered
        ? [...discovered.ips]
        : [normalizeUsableIp(specifiedHost) || sanitizeHostCandidate(specifiedHost)]
      const key = discovered
        ? serverIdentityKey(context.connectionId, discovered)
        : JSON.stringify([context.connectionId, profileRoute, hosts[0], username])
      const preferred = options.preferredHost?.(key)
      if (preferred && hosts.includes(preferred))
        hosts.splice(0, hosts.length, preferred, ...hosts.filter((host) => host !== preferred))
      phase.value = 'connecting'
      for (let index = 0; index < hosts.length; index++) {
        if (!current()) return null
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new Error('连接流程已超时；可重新尝试或手动指定可达地址。')
        const host = hosts[index]
        attempt.value = { host, index: index + 1, total: hosts.length }
        const taskId = `sftp_probe_${Date.now()}_${Math.random().toString(36).slice(2)}`
        try {
          const timeoutMs = Math.min(timeouts.candidate, remaining)
          const response = await boundedOperation(
            () =>
              source.probe(
                context.connectionId,
                { targetHost: host, targetUsername: username, profileRoute },
                { taskId, timeoutMs },
              ),
            timeoutMs,
            operation.signal,
            () => {
              void source.cancel(taskId).catch(() => {})
            },
          )
          if (!current()) return null
          if (response.profileRoute && response.profileRoute !== profileRoute)
            throw new Error('SFTP_TARGET_CHANGED: 连接配置已变化，请重新检测文件目标。')
          if (!response.available) throw new Error(response.message)
          const previousIdentity = identity.value
          const result: FileTargetBinding = {
            terminalId: context.terminalId,
            connectionId: context.connectionId,
            generation: context.generation,
            revision: ++revision,
            serverKey: key,
            host,
            username,
            label: `${username}@${host}`,
            source: sourceKind,
            identity: discovered,
            override: {
              targetHost: host,
              targetUsername: username,
              profileRoute: response.profileRoute || profileRoute,
            },
          }
          binding.value = result
          identity.value = discovered ?? (sourceKind === 'manual' ? null : previousIdentity)
          home.value = response.path || '.'
          options.rememberHost?.(key, host)
          phase.value = 'ready'
          return captureFileTarget(result)
        } catch (reason) {
          if (!current()) return null
          const message = reason instanceof Error ? reason.message : String(reason)
          failures.value = [...failures.value, { host, kind: connectionFailureKind(message), message }]
          if (message.includes('SFTP_TARGET_CHANGED'))
            throw new Error('原连接配置的地址、端口或跳转方式已变化，已停止连接。请重新检测文件目标。')
        }
      }
      throw new Error('所有候选地址均未连接成功，请查看各地址原因后重试，或手动指定目标。')
    } catch (reason) {
      if (current()) {
        phase.value = 'error'
        error.value = reason instanceof Error ? reason.message : String(reason)
      }
      return null
    } finally {
      if (controller === operation) controller = null
    }
  }

  async function verifyBeforeWrite(signal?: AbortSignal): Promise<FileTargetBinding> {
    if (disposed || signal?.aborted) throw new Error('操作已取消')
    const target = binding.value ? captureFileTarget(binding.value) : null
    if (!target || phase.value !== 'ready') throw new Error('目标尚未确认，请先连接或重新检测。')
    const before = stamp()
    const stillCurrent = () =>
      !disposed && !signal?.aborted && before === stamp() &&
      phase.value === 'ready' && target.revision === binding.value?.revision
    if (target.source === 'terminal') {
      const verification = new AbortController()
      const actual = await readIdentity(signal ?? verification.signal)
      // A superseded verification must not invalidate a newer successful connection.
      if (!stillCurrent()) throw new Error('目标已变化或操作已取消，请重新确认。')
      if (
        serverIdentityKey(target.connectionId, actual) !== target.serverKey ||
        !actual.ips.includes(target.host)
      ) {
        invalidate('当前终端已切换服务器或账号，已阻止向旧目标写入。请重新检测；编辑草稿已保留。')
        throw new Error(error.value)
      }
      identity.value = actual
    }
    if (!stillCurrent())
      throw new Error('目标已变化，请重新确认操作。')
    return target
  }

  watch(stamp, (next, previous) => {
    if (next !== previous) invalidate()
  }, { flush: 'sync' })
  onBeforeUnmount(() => {
    disposed = true
    cancel()
    pending?.reject(new Error('会话已关闭'))
    pending = null
  })
  return {
    phase,
    binding,
    identity,
    error,
    failures,
    attempt,
    home,
    busy,
    connect,
    cancel,
    invalidate,
    feedOutput,
    readIdentity,
    verifyBeforeWrite,
  }
}
