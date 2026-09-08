import type { AgentCommandHandle, AgentCommandResult } from '../types/agent'

function cancelledResult(startedAt: number): AgentCommandResult {
  return {
    status: 'cancelled',
    output: '',
    durationMs: Math.max(0, Date.now() - startedAt),
    truncated: false
  }
}

function failedResult(error: unknown): AgentCommandResult {
  return {
    status: 'dispatch-failed',
    output: '',
    durationMs: 0,
    truncated: false,
    failureReason: error instanceof Error ? error.message : String(error)
  }
}

export function createDeferredAgentCommand(
  preflight: () => Promise<string>,
  start: () => AgentCommandHandle
): AgentCommandHandle {
  const startedAt = Date.now()
  let cancelled = false
  let active: AgentCommandHandle | undefined

  const result = (async (): Promise<AgentCommandResult> => {
    try {
      const failureReason = await preflight()
      if (failureReason) return failedResult(failureReason)
      if (cancelled) return cancelledResult(startedAt)
      active = start()
      if (cancelled) active.cancel()
      return await active.result
    } catch (error) {
      return failedResult(error)
    }
  })()

  return {
    result,
    peekOutput: () => active?.peekOutput() ?? '',
    cancel: () => {
      cancelled = true
      active?.cancel()
    }
  }
}
