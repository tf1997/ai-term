export const IDENT_MARKER_ID_PATTERN = '\\d+_[A-Za-z0-9]+'

export function parseTerminalIdentitySnapshot(snapshot: string, pending: { begin: string; end: string }) {
  const cleaned = cleanTerminalText(snapshot)
  let searchStart = 0
  let sawCompletePair = false
  let fallbackValues = emptyIdentityValues()
  let fallbackIp = ''
  let fallbackHost = ''

  while (searchStart < cleaned.length) {
    const beginMatch = findIdentityMarker(cleaned, pending.begin, 'BEGIN', searchStart)
    if (!beginMatch) break
    const endMatch = findIdentityMarker(cleaned, pending.end, 'END', beginMatch.index + beginMatch.marker.length)
    if (!endMatch) return { complete: false, values: fallbackValues, ip: fallbackIp, host: fallbackHost }
    sawCompletePair = true
    const raw = cleaned.slice(beginMatch.index + beginMatch.marker.length, endMatch.index)
    const values = parseIdentityOutput(raw)
    const ip = firstUsableIp(values.ips) || firstUsableIp(raw)
    const hostname = sanitizeHostCandidate(values.hostname)
    const host = ip || hostname
    fallbackValues = values
    fallbackIp = ip
    fallbackHost = host
    if (host) return { complete: true, values: { ...values, hostname }, ip, host }
    searchStart = beginMatch.index + beginMatch.marker.length
  }

  return { complete: sawCompletePair, values: fallbackValues, ip: fallbackIp, host: fallbackHost }
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
    pwd: ''
  }
}

export function parseIdentityOutput(raw: string) {
  const values = emptyIdentityValues()
  const matches = [...raw.matchAll(/(user|hostname|ips|pwd)=/g)]
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
  if (!trimmed || /printf\s|;|'|"/.test(trimmed)) return ''
  if (key === 'hostname') return sanitizeHostCandidate(trimmed)
  if (key === 'ips') return extractIpv4Candidates(trimmed).join(' ')
  if (key === 'pwd') return trimmed.startsWith('/') || trimmed === '.' || trimmed.startsWith('~') ? trimmed : ''
  const username = trimmed.split(/\s+/)[0] ?? ''
  return username === 'unknown' ? '' : username
}

export function sanitizeHostCandidate(value: string) {
  const host = value.trim().split(/\s+/)[0] ?? ''
  if (!/^[A-Za-z0-9._-]+$/.test(host) || host === 'unknown') return ''
  return host
}

export function firstUsableIp(value: string) {
  return extractIpv4Candidates(value).find((item) => item !== '127.0.0.1') ?? ''
}

export function extractIpv4Candidates(value: string) {
  const matches = value.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []
  return matches.filter((item) => item.split('.').every((part) => Number(part) <= 255))
}

export function cleanTerminalText(value: string) {
  return value.replace(/\r/g, '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
}
