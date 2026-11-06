import type { AgentStep } from './agent'
import type { AgentFileEditItem } from './agentFileEdits'
import { normalizeAgentFileChanges, unavailableFile } from './agentFileSnapshots'
import type { AgentFileChange, AgentFileVersion } from './agentFileSnapshots'

function editChange(stepId: string, item: AgentFileEditItem): AgentFileChange | undefined {
  if (!['applied', 'unknown', 'dispatching'].includes(item.status)) return
  const view = item.view
  const path = view?.resolvedPath || item.historyPath
  if (!path) return
  const version = (content: string | null | undefined): AgentFileVersion => {
    if (view?.sensitive || view?.redacted) return unavailableFile('敏感文件不保存内容快照')
    if (content === null) return { state: 'missing' }
    return typeof content === 'string' ? { state: 'text', content } : unavailableFile('未记录完整文件快照')
  }
  return {
    path, requestedPaths: [...new Set([path, view?.path].filter((value): value is string => Boolean(value)))],
    scope: view?.environmentScope || item.historyScope || '',
    before: version(view?.before),
    after: item.status === 'applied' && item.outcome?.status === 'applied'
      ? version(view?.after) : unavailableFile('未能核实文件写入结果'),
    stepIds: [stepId]
  }
}

function sameVersion(left: AgentFileVersion, right: AgentFileVersion): boolean {
  return left.state === 'missing' && right.state === 'missing'
    || left.state === 'text' && right.state === 'text' && left.content === right.content
}

function environmentScope(scope: string): string {
  // Shared command snapshots prepend terminal ID + generation to the file service's scope.
  return scope.match(/(?:^|:\d+:)([a-f0-9]{64})$/i)?.[1].toLowerCase() ?? scope
}

/** Derive the task summary from both stored command snapshots and verified file edits.
 * This also restores summaries for history written before file edits were connected to the UI.
 */
export function agentTaskFileChanges(steps: AgentStep[] = [], snapshots: AgentFileChange[] = []): AgentFileChange[] {
  const positions = new Map(steps.map((step, index) => [step.id, index]))
  const entries = (normalizeAgentFileChanges(snapshots) ?? []).map(change => {
    const indexes = change.stepIds.map(id => positions.get(id))
    const known = indexes.length > 0 && indexes.every((index): index is number => index !== undefined)
    return { change, first: known ? Math.min(...indexes) : -1, last: known ? Math.max(...indexes) : -1 }
  })
  steps.forEach((step, index) => {
    for (const item of step.fileEdits ?? []) {
      const change = editChange(step.id, item)
      if (change) entries.push({ change, first: index, last: index })
    }
  })
  entries.sort((left, right) => left.first - right.first)
  const merged = new Map<string, typeof entries[number]>()
  for (const entry of entries) {
    const { change } = entry
    const scope = environmentScope(change.scope)
    // Without an environment binding, equal path strings do not prove file identity.
    const key = JSON.stringify([scope || `unknown:${merged.size}`, change.path])
    const previous = merged.get(key)
    if (!previous) { merged.set(key, entry); continue }
    const duplicate = change.stepIds.every(id => previous.change.stepIds.includes(id))
      && sameVersion(previous.change.before, change.before) && sameVersion(previous.change.after, change.after)
    const uncertainReason = previous.change.uncertainReason || change.uncertainReason || (!duplicate && (
      previous.first < 0 || entry.first < 0 || previous.last > entry.first || !sameVersion(previous.change.after, change.before)
    ) ? '两次执行之间文件发生变化或缺少连续快照，无法准确归因' : undefined)
    merged.set(key, {
      first: previous.first, last: Math.max(previous.last, entry.last),
      change: {
        ...previous.change,
        requestedPaths: [...new Set([...previous.change.requestedPaths, ...change.requestedPaths])],
        after: change.after,
        stepIds: [...new Set([...previous.change.stepIds, ...change.stepIds])]
          .sort((left, right) => (positions.get(left) ?? -1) - (positions.get(right) ?? -1)),
        ...(uncertainReason ? { uncertainReason } : {})
      }
    })
  }
  return normalizeAgentFileChanges([...merged.values()].map(entry => entry.change)) ?? []
}
