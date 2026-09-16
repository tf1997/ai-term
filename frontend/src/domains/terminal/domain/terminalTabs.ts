import type { TerminalRuntimeStatus } from './terminal'

export function terminalTitleOrdinals(tabs: readonly { id: string; title: string }[]) {
  const counts = new Map<string, number>()
  const ordinals = new Map<string, number>()
  const seen = new Map<string, number>()
  for (const tab of tabs) counts.set(tab.title, (counts.get(tab.title) ?? 0) + 1)
  for (const tab of tabs) {
    if ((counts.get(tab.title) ?? 0) < 2) continue
    const ordinal = (seen.get(tab.title) ?? 0) + 1
    seen.set(tab.title, ordinal)
    ordinals.set(tab.id, ordinal)
  }
  return ordinals
}

export function terminalDisplayTitle(tab: { id: string; title: string }, tabs: readonly { id: string; title: string }[]) {
  const ordinal = terminalTitleOrdinals(tabs).get(tab.id)
  return ordinal ? `${tab.title} · ${ordinal}` : tab.title
}

export function normalizedTerminalTargetIds(tabs: readonly { id: string }[], ids: readonly string[], requiredId: string) {
  const validIds = new Set(tabs.map((tab) => tab.id))
  const selectedIds = new Set(ids)
  const next = tabs.map((tab) => tab.id).filter((id) => selectedIds.has(id))
  if (requiredId && validIds.has(requiredId) && !next.includes(requiredId)) next.push(requiredId)
  return next
}

export function terminalStatusClass(status: TerminalRuntimeStatus) {
  return {
    live: status === 'local' || status === 'remote' || status === 'sftp',
    connecting: status === 'connecting',
    error: status === 'error',
    preview: status === 'preview'
  }
}
