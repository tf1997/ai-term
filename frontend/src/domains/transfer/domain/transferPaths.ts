export function buildRemoteBreadcrumbs(path: string) {
  if (!path || path === '.') return [{ label: '~', path: '.' }]
  const parts = path.split('/').filter(Boolean)
  const breadcrumbs = [{ label: '/', path: '/' }]
  parts.forEach((part, index) => {
    breadcrumbs.push({ label: part, path: `/${parts.slice(0, index + 1).join('/')}` })
  })
  return breadcrumbs
}

export function buildLocalBreadcrumbs(path: string) {
  if (!path) return []
  const normalized = path.replace(/\\/g, '/')
  const driveMatch = normalized.match(/^([A-Za-z]:)(?:\/|$)/)
  const root = driveMatch ? `${driveMatch[1]}\\` : '/'
  const remainder = driveMatch ? normalized.slice(driveMatch[0].length) : normalized.replace(/^\/+/, '')
  const parts = remainder.split('/').filter(Boolean)
  const breadcrumbs = [{ label: root, path: root }]
  parts.forEach((part, index) => {
    const joined = parts.slice(0, index + 1).join(driveMatch ? '\\' : '/')
    breadcrumbs.push({ label: part, path: driveMatch ? `${root}${joined}` : `/${joined}` })
  })
  return breadcrumbs
}

export function normalizeRemoteDirectoryPath(path: string) {
  return path.trim() || '.'
}

export function rootLabel(root: string) {
  return root.replace(/[\\/]+$/, '') || '/'
}

export function isHiddenEntry(name: string) {
  const lowered = name.toLowerCase()
  return name.startsWith('.') || name.startsWith('$') || lowered === 'system volume information'
}

export function localParentPath(path: string) {
  const normalized = path.replace(/[\\/]+$/, '')
  if (!normalized || normalized === '/') return '/'
  if (/^[A-Za-z]:$/.test(normalized)) return `${normalized}\\`
  if (/^[A-Za-z]:\\?$/.test(normalized)) return normalized.endsWith('\\') ? normalized : `${normalized}\\`
  const slash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  if (slash <= 0) return '/'
  if (slash === 2 && /^[A-Za-z]:/.test(normalized)) return `${normalized.slice(0, 2)}\\`
  return normalized.slice(0, slash)
}

export function joinRemotePath(base: string, name: string) {
  if (base === '/') return `/${name}`
  if (base.endsWith('/')) return `${base}${name}`
  return `${base}/${name}`
}

export function joinLocalPath(base: string, name: string) {
  const trimmed = base.replace(/[\\/]+$/, '')
  if (!trimmed) return name
  if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}\\${name}`
  if (trimmed === '/') return `/${name}`
  const separator = base.includes('\\') ? '\\' : '/'
  return `${trimmed}${separator}${name}`
}

export function localFileName(path: string) {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).filter(Boolean).pop() || ''
}

export function remoteParentPath(path: string) {
  const normalized = path.replace(/\/+$/, '')
  if (!normalized || normalized === '/') return '/'
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '/' : normalized.slice(0, index)
}

export function normalizeRemoteComparePath(path: string) {
  return path.replace(/\/+$/, '') || '/'
}

export function normalizeLocalComparePath(path: string) {
  const normalized = path.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized
}

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`
}
