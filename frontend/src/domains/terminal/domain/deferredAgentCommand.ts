import type { AgentCommandHandle, AgentCommandResult } from '../../ai/types'

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

/** A sentinel may finish just before its prompt. Wait briefly without bypassing input/binding guards. */
export function createReadyAgentCommand(
  readiness: () => 'ready' | 'line-busy' | 'shell-busy' | 'unavailable',
  guard: () => string,
  start: () => AgentCommandHandle,
  timeoutMs = 2_500
): AgentCommandHandle {
  return createDeferredAgentCommand(async () => {
    const deadline = Date.now() + timeoutMs
    while (true) {
      const failure = guard()
      if (failure) return failure
      const status = readiness()
      if (status === 'ready') return ''
      if (status === 'line-busy') return '当前终端命令行已有输入，请先提交或清空'
      if (status === 'unavailable') return '任务绑定的终端不可用'
      if (Date.now() >= deadline) return 'Shell 尚未返回可执行提示符'
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }, start)
}
