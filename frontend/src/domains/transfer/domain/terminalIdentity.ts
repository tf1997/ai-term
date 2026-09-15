export const IDENT_MARKER_ID_PATTERN = '\\d+_[A-Za-z0-9]+'

export function parseTerminalIdentitySnapshot(snapshot: string, pending: { begin: string; end: string }) {
  const cleaned = cleanTerminalText(snapshot)
  let searchStart = 0
  let sawCompletePair = false
  let fallbackValues = emptyIdentityValues()
  let fallbackIp = ''
  let fallbackHost = ''
  let fallbackIps: string[] = []

  while (searchStart < cleaned.length) {
    const beginMatch = findIdentityMarker(cleaned, pending.begin, 'BEGIN', searchStart)
    if (!beginMatch) break
    const endMatch = findIdentityMarker(cleaned, pending.end, 'END', beginMatch.index + beginMatch.marker.length)
    if (!endMatch) return { complete: false, values: fallbackValues, ip: fallbackIp, ips: fallbackIps, host: fallbackHost }
    sawCompletePair = true
    const raw = cleaned.slice(beginMatch.index + beginMatch.marker.length, endMatch.index)
    const values = parseIdentityOutput(raw)
    const ips = usableIpCandidates(values.ips)
    const ip = ips[0] ?? ''
    const hostname = sanitizeHostCandidate(values.hostname)
    const host = ip || hostname
    fallbackValues = values
    fallbackIp = ip
    fallbackHost = host
    fallbackIps = ips
    if (host) return { complete: true, values: { ...values, hostname }, ip, ips, host }
    searchStart = beginMatch.index + beginMatch.marker.length
  }

  return { complete: sawCompletePair, values: fallbackValues, ip: fallbackIp, ips: fallbackIps, host: fallbackHost }
}

export function findIdentityMarker(text: string, marker: string, kind: 'BEGIN' | 'END', start: number) {
  const candidates = markerCandidates(marker)
  let best: { index: number; marker: string } | null = null
  for (const candidate of candidates) {
    const match = findStandaloneIdentityMarker(text, candidate, start)
    if (match && (!best || match.index < best.index)) best = match
  }
  const markerId = identityMarkerId(marker)
  if (markerId) {
    const pattern = new RegExp(`^_*AI_TERM_IDENT_${kind}_${escapeRegExp(markerId)}_*[\\t ]*$`, 'gm')
    pattern.lastIndex = start
    const match = pattern.exec(text)
    if (match && (!best || match.index < best.index)) {
      best = { index: match.index, marker: match[0] }
    }
  }
  return best
}

export function findStandaloneIdentityMarker(text: string, marker: string, start: number) {
  const pattern = new RegExp(`^${escapeRegExp(marker)}[\\t ]*$`, 'gm')
  pattern.lastIndex = start
  const match = pattern.exec(text)
  return match ? { index: match.index, marker: match[0] } : null
}

export function markerCandidates(marker: string) {
  const bare = marker.replace(/^_+|_+$/g, '')
  return [...new Set([marker, bare])]
}

export function identityMarkerId(marker: string) {
  return marker.match(new RegExp(`AI_TERM_IDENT_(?:BEGIN|END)_(${IDENT_MARKER_ID_PATTERN})`))?.[1] ?? ''
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function emptyIdentityValues() {
  return {
    user: '',
    hostname: '',
    ips: '',
    pwd: '',
    machine: ''
  }
}

export function parseIdentityOutput(raw: string) {
  const values = emptyIdentityValues()
  const matches = [...raw.matchAll(/^(user|hostname|ips|pwd|machine)=/gm)]
  matches.forEach((match, index) => {
    const key = match[1] as keyof ReturnType<typeof emptyIdentityValues>
    const valueStart = (match.index ?? 0) + match[0].length
    const nextStart = matches[index + 1]?.index ?? raw.length
    const value = sanitizeIdentityValue(raw.slice(valueStart, nextStart), key)
    if (value) values[key] = value
  })
  return values
}

export function sanitizeIdentityValue(value: string, key: keyof ReturnType<typeof emptyIdentityValues>) {
  const trimmed = value.trim()
  if (!trimmed || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(trimmed)) return ''
  if (key === 'hostname') return sanitizeHostCandidate(trimmed)
  if (key === 'ips') return usableIpCandidates(trimmed).join(' ')
  if (key === 'machine') return /^[a-f0-9-]{16,64}$/i.test(trimmed) ? trimmed.toLowerCase() : ''
  if (key === 'pwd') return trimmed.startsWith('/') || trimmed === '.' || trimmed.startsWith('~') ? trimmed : ''
  const username = trimmed.split(/\s+/)[0] ?? ''
  return username !== 'unknown' && /^[A-Za-z0-9_.@-]+\$?$/.test(username) ? username : ''
}

export function sanitizeHostCandidate(value: string) {
  const host = value.trim()
  if (!/^[A-Za-z0-9._-]+$/.test(host) || host === 'unknown') return ''
  return host
}

export function firstUsableIp(value: string) {
  return usableIpCandidates(value)[0] ?? ''
}

/** Canonical unicast addresses only: no loopback, unspecified, multicast or link-local targets. */
export function normalizeUsableIp(value: string): string | null {
  const input = value.trim().replace(/^\[|\]$/g, '').split('/')[0]
  if (/^\d+(?:\.\d+){3}$/.test(input)) {
    const parts = input.split('.')
    if (parts.some(part => !/^(?:0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return null
    const [a, b] = parts.map(Number)
    if (a === 0 || a === 127 || a >= 224 || (a === 169 && b === 254)) return null
    return parts.map(Number).join('.')
  }
  if (!input.includes(':') || !/^[a-f\d:.]+$/i.test(input)) return null
  try {
    const address = new URL(`http://[${input}]/`).hostname.slice(1, -1).toLowerCase()
    if (address === '::' || address === '::1' || /^ff|^fe[89ab]/i.test(address)) return null
    const mapped = address.match(/^::ffff:([a-f\d]+):([a-f\d]+)$/)
    if (mapped) {
      const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16)
      return normalizeUsableIp(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
    }
    return address
  } catch { return null }
}

export function usableIpCandidates(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map(normalizeUsableIp).filter((ip): ip is string => Boolean(ip)))].slice(0, 32)
}

export function extractIpv4Candidates(value: string) {
  const matches = value.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []
  return matches.filter((item) => item.split('.').every((part) => Number(part) <= 255))
}

export function cleanTerminalText(value: string) {
  return value.replace(/\r/g, '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
}
