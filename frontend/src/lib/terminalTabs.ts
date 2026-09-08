import type { TerminalRuntimeStatus } from '../types/terminal'

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
