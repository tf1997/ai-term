import type { AgentStep } from './agent'

export interface AgentFileReference {
  path: string
  stepIds: string[]
  uncertain: boolean
}

/** Display metadata is optional; malformed paths must not stop a valid command. */
export function normalizeAgentFiles(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const paths = [...new Set(value.filter((path): path is string => typeof path === 'string')
    .map(path => path.trim()).filter(path => path && path.length <= 4096 && !/[\u0000-\u001f*?]/.test(path)))].slice(0, 100)
  return paths.length ? paths : undefined
}

/** These are write targets of executed commands, not before/after file snapshots. */
export function agentFileReferences(steps: AgentStep[] = []): AgentFileReference[] {
  const files = new Map<string, AgentFileReference>()
  for (const step of steps) {
    if (step.sensitive || step.executionPhase === 'not-started' || step.status === 'pending' || step.status === 'skipped') continue
    if (!['completed', 'failed', 'running', 'timeout'].includes(step.status)) continue
    const paths = normalizeAgentFiles(step.affectedFiles) ?? []
    for (const path of paths) {
      // Relative paths from separate commands may refer to different working directories.
      const key = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path) ? path : `${step.id}\0${path}`
      const file = files.get(key) ?? { path, stepIds: [], uncertain: false }
      if (!file.stepIds.includes(step.id)) file.stepIds.push(step.id)
      file.uncertain ||= step.status !== 'completed' || step.exitCode !== 0
      files.set(key, file)
    }
  }
  return [...files.values()]
}
