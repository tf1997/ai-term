import { formatPatch, structuredPatch } from 'diff'
import type { StructuredPatch } from 'diff'
import type { AgentFileChange } from './agentFileSnapshots'

export interface AgentFileDiff {
  change: AgentFileChange
  status: 'added' | 'deleted' | 'modified' | 'unchanged' | 'unavailable'
  additions?: number
  deletions?: number
  patch?: StructuredPatch
  reason?: string
}

export function agentFileDiff(change: AgentFileChange): AgentFileDiff {
  const { before, after } = change
  const unavailable = (reason: string): AgentFileDiff => ({ change, status: 'unavailable', reason })
  if (change.uncertainReason) return unavailable(change.uncertainReason)
  if (before.state === 'unavailable') return unavailable(before.reason)
  if (after.state === 'unavailable') return unavailable(after.reason)
  if (!change.scope) return unavailable('未记录可核对的终端环境')
  const oldText = before.state === 'text' ? before.content : ''
  const newText = after.state === 'text' ? after.content : ''
  if (before.state === after.state && oldText === newText) return { change, status: 'unchanged', additions: 0, deletions: 0 }
  const patch = structuredPatch(before.state === 'missing' ? '/dev/null' : change.path, after.state === 'missing' ? '/dev/null' : change.path, oldText, newText, '', '', { context: 3, timeout: 100 })
  if (!patch) return unavailable('差异过于复杂，无法在限时内完成逐行比较')
  let additions = 0, deletions = 0
  for (const hunk of patch.hunks) for (const line of hunk.lines) {
    if (line.startsWith('+')) additions++
    else if (line.startsWith('-')) deletions++
  }
  return { change, status: before.state === 'missing' ? 'added' : after.state === 'missing' ? 'deleted' : 'modified', additions, deletions, patch }
}

export function agentDiffText(diff: AgentFileDiff): string { return diff.patch ? formatPatch(diff.patch) : '' }
