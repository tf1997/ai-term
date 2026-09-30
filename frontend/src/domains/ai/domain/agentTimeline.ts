import type { AgentTimelineEntry, AiMessage } from './conversation'
import type { AgentStep } from './agent'

export function normalizeAgentTimeline(value: unknown): AgentTimelineEntry[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ids = new Set<string>()
  return value.flatMap((entry): AgentTimelineEntry[] => {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || ids.has(entry.id)) return []
    if (entry.kind === 'tool' && typeof entry.stepId === 'string') {
      ids.add(entry.id)
      return [{ kind: 'tool', id: entry.id, stepId: entry.stepId }]
    }
    if (entry.kind === 'thinking' && typeof entry.reasoning === 'string' && typeof entry.text === 'string') {
      ids.add(entry.id)
      return [{ kind: 'thinking', id: entry.id, reasoning: entry.reasoning, text: entry.text, ...(entry.legacy === true ? { legacy: true } : {}) }]
    }
    return []
  })
}

export function agentTimelineEntries(message: AiMessage): AgentTimelineEntry[] {
  const entries: AgentTimelineEntry[] = message.agentTimeline?.map(entry => ({ ...entry })) ?? (
    message.agentReasoning
      ? [{ kind: 'thinking', id: 'legacy-thinking', reasoning: message.agentReasoning, text: '', legacy: true }]
      : []
  )
  const recorded = new Set(entries.flatMap(entry => entry.kind === 'tool' ? [entry.stepId] : []))
  for (const step of message.agentSteps ?? []) {
    if (!recorded.has(step.id)) entries.push({ kind: 'tool', id: `tool:${step.id}`, stepId: step.id })
  }
  return entries
}

export function agentDisplayTimeline(message: AiMessage) {
  const steps = new Map((message.agentSteps ?? []).map(step => [step.id, step]))
  return agentTimelineEntries(message).flatMap((entry): Array<
    | { kind: 'thinking'; id: string; text: string; legacy: boolean }
    | { kind: 'text'; id: string; text: string }
    | { kind: 'tool'; id: string; step: AgentStep }
  > => {
    if (entry.kind === 'tool') {
      const step = steps.get(entry.stepId)
      return step ? [{ kind: 'tool', id: entry.id, step }] : []
    }
    const parts: Array<{ kind: 'thinking'; id: string; text: string; legacy: boolean } | { kind: 'text'; id: string; text: string }> = []
    if (entry.reasoning.trim()) parts.push({ kind: 'thinking', id: `${entry.id}:reasoning`, text: entry.reasoning, legacy: entry.legacy === true })
    if (entry.text.trim()) parts.push({ kind: 'text', id: `${entry.id}:text`, text: entry.text })
    return parts
  })
}
