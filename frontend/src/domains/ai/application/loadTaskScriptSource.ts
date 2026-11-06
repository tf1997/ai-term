import type { AgentCheckpoint } from '../domain/agentCheckpoints'
import { taskScriptSourceFromCheckpoint } from '../domain/agentScriptExport'
import type { FileChangeRecord } from '../../transfer/index'

/** Read-only lookup of durable evidence. Missing receipts leave that step
 * unavailable; a checkpoint's path or claimed status cannot supply its body. */
export async function loadTaskScriptSource(record: AgentCheckpoint, getChange?: (id: string) => Promise<FileChangeRecord | null>) {
  const ids = [...new Set(record.state.steps.filter(step => step.status === 'completed' && step.executionPhase === 'finished')
    .flatMap(step => step.fileEdits.filter(item => item.status === 'applied' && item.changeId).map(item => item.changeId!)))].slice(0, 64)
  const changes: FileChangeRecord[] = []
  if (getChange) for (let offset = 0; offset < ids.length; offset += 4) {
    const results = await Promise.allSettled(ids.slice(offset, offset + 4).map(getChange))
    for (const result of results) if (result.status === 'fulfilled' && result.value) changes.push(result.value)
  }
  return taskScriptSourceFromCheckpoint(record, changes)
}
