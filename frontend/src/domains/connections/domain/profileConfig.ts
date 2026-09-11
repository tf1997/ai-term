
import type { ConnectionProfile } from './profile'


export function cloneConnectionProfile(profile: ConnectionProfile): ConnectionProfile {
  return JSON.parse(JSON.stringify(profile)) as ConnectionProfile
}

export function normalizeConnectionProfileForSave(profile: ConnectionProfile): ConnectionProfile {
  const normalized = cloneConnectionProfile(profile)
  normalized.id = normalized.id.trim() || normalized.name.trim() || `connection-${Date.now()}`
  normalized.name = normalized.name.trim() || normalized.id
  normalized.target.host = normalized.target.host.trim()
  normalized.target.username = normalized.target.username.trim()
  normalized.target.port = normalizePort(normalized.target.port, 'SSH port', 22)
  normalized.connectionRole = normalized.connectionRole === 'bastion' ? 'bastion' : 'direct'
  normalized.jumpMode = 'direct'
  normalized.menuProfileId = ''
  normalized.fileTransferMode = 'auto'
  normalized.gateway = {
    host: '',
    port: 22,
    username: '',
    authMode: 'auto',
    password: undefined,
    credentialRef: undefined
  }

  if (!normalized.target.password?.trim()) normalized.target.password = undefined

  return normalized
}

export function normalizePort(value: unknown, label: string, fallback?: number): number | undefined {
  if (value === undefined || value === null || value === '') return fallback
  const port = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535`)
  }
  return port
}
