import type { ConnectionProfile } from '../../connections/types'

export interface SftpTargetOverride {
  targetHost?: string
  targetUsername?: string
  profileRoute?: string
}

/** Keep this secret-free route format in sync with backend sftp_profile_route. */
export function sftpProfileRoute(profile: ConnectionProfile) {
  return JSON.stringify([
    'sftp-profile-route-v1',
    profile.id,
    profile.connectionRole ?? 'direct',
    profile.jumpMode ?? 'direct',
    profile.fileTransferMode ?? 'auto',
    profile.menuProfileId ?? '',
    [profile.target.host.trim(), profile.target.port ?? 22, profile.target.username.trim()],
    [profile.gateway.host.trim(), profile.gateway.port ?? 22, (profile.gateway.username ?? '').trim()],
  ])
}

export interface TerminalFileBridge {
  readiness: () => 'ready' | 'line-busy' | 'shell-busy' | 'unavailable'
  write: (data: string) => boolean | Promise<boolean>
  finish?: (command: string) => void
  interrupt?: () => boolean | Promise<boolean>
}

export interface ServerIdentity {
  username: string
  hostname: string
  ips: string[]
  pwd: string
  machine: string
}

export interface FileTargetBinding {
  terminalId: string
  connectionId: string
  generation: number
  revision: number
  serverKey: string
  host: string
  username: string
  label: string
  source: 'configured' | 'terminal' | 'manual'
  identity?: ServerIdentity
  override: SftpTargetOverride
}

export interface FileSessionContext {
  terminalId: string
  connectionId: string
  generation: number
  contextVersion: number
  status: string
  profile?: ConnectionProfile
}

export function serverIdentityKey(profileId: string, identity: ServerIdentity) {
  return JSON.stringify([
    profileId,
    identity.machine || `${identity.hostname}|${[...identity.ips].sort().join(',')}`,
    identity.username,
  ])
}

export function sameFileTarget(a: FileTargetBinding | null, b: FileTargetBinding | null) {
  return Boolean(
    a &&
    b &&
    a.terminalId === b.terminalId &&
    a.connectionId === b.connectionId &&
    a.generation === b.generation &&
    a.revision === b.revision &&
    a.serverKey === b.serverKey &&
    a.host === b.host &&
    a.username === b.username,
  )
}

export function captureFileTarget(binding: FileTargetBinding): FileTargetBinding {
  const captured = {
    ...binding,
    override: { ...binding.override },
    identity: binding.identity ? { ...binding.identity, ips: [...binding.identity.ips] } : undefined,
  }
  Object.freeze(captured.override)
  if (captured.identity) {
    Object.freeze(captured.identity.ips)
    Object.freeze(captured.identity)
  }
  return Object.freeze(captured)
}

export type ConnectionFailureKind =
  'network' | 'timeout' | 'authentication' | 'host-key' | 'unavailable' | 'cancelled' | 'target-changed'

export function connectionFailureKind(message: string): ConnectionFailureKind {
  if (message.includes('SFTP_TARGET_CHANGED')) return 'target-changed'
  if (/cancelled|canceled|取消/i.test(message)) return 'cancelled'
  if (/host.?key|known_hosts|主机密钥/i.test(message)) return 'host-key'
  if (/authenticat|permission denied|password|认证|密码/i.test(message)) return 'authentication'
  if (/timeout|timed out|超时/i.test(message)) return 'timeout'
  if (/refused|unreachable|no route|resolve|network|connection reset|连接失败|无法连接/i.test(message))
    return 'network'
  return 'unavailable'
}

export const CONNECTION_FAILURE_LABELS: Record<ConnectionFailureKind, string> = {
  'target-changed': '连接配置已变化',
  network: '网络连接失败',
  timeout: '连接超时',
  authentication: '认证失败',
  'host-key': '主机密钥校验失败',
  unavailable: 'SFTP 不可用',
  cancelled: '已取消',
}
