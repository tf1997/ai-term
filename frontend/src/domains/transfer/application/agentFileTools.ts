import type { ExecutionTarget } from '../../../shared/security/commandPolicy'
import type { AgentCommandHandle } from '../../ai/types'
import type { AgentFileToolService, FileCancellation, FileCapturePlan, FileOperationReference } from '../domain/fileTools'
import { fileToolApi } from '../infrastructure/fileTools'
import { createAgentFileEditService } from './agentFileEdits'

interface Dependencies {
  target(terminalId: string, generation: number): Promise<ExecutionTarget>
  capture(terminalId: string, generation: number, plan: FileCapturePlan): AgentCommandHandle
}
const cancelled = () => ({ kind: 'cancelled', message: '文件操作已取消' })

export function createAgentFileToolService(deps: Dependencies, api = fileToolApi): AgentFileToolService {
  async function capture(terminalId: string, generation: number, plan: FileCapturePlan, signal: FileCancellation) {
    if (signal.cancelled) throw cancelled()
    const handle = deps.capture(terminalId, generation, plan)
    const timer = setTimeout(() => handle.cancel(), 15_000)
    const watch = setInterval(() => { if (signal.cancelled) handle.cancel() }, 25)
    try {
      const result = await handle.result
      if (signal.cancelled) throw cancelled()
      if (result.status !== 'completed' || result.exitCode !== 0 || result.truncated || result.commandMismatch) {
        throw { kind: 'unavailable', message: result.failureReason || '当前终端文件读取未完成、超时或输出不完整' }
      }
      return result.output
    } finally { clearTimeout(timer); clearInterval(watch) }
  }
  async function observing<T>(signal: FileCancellation, reference: () => FileOperationReference | undefined, action: () => Promise<T>) {
    if (signal.cancelled) throw cancelled()
    let cancellationSent = false
    const watch = setInterval(() => {
      if (!signal.cancelled || cancellationSent || !reference()) return
      cancellationSent = true
      void api.cancel(reference()!).catch(() => {})
    }, 25)
    try {
      const result = await action()
      if (signal.cancelled) throw cancelled()
      return result
    } finally { clearInterval(watch) }
  }
  return {
    edits: createAgentFileEditService({ target: deps.target, capture }),
    async prepare(terminalId, generation, request, signal) {
      let reference: FileOperationReference | undefined
      let completed = false
      try {
        return await observing(signal, () => reference, async () => {
          const target = await deps.target(terminalId, generation)
          if (signal.cancelled) throw cancelled()
          const plan = await api.inspect(target, request)
          reference = plan.reference
          const output = await capture(terminalId, generation, plan, signal)
          const operation = await api.finishInspection(reference, output)
          reference = operation.reference
          if (signal.cancelled) throw cancelled()
          completed = true
          return operation
        })
      } finally { if ((!completed || signal.cancelled) && reference) void api.cancel(reference).catch(() => {}) }
    },
    approve: operation => api.approve(operation),
    async execute(terminalId, generation, operation, signal) {
      const reference = operation.reference
      try {
        return await observing(signal, () => reference, async () => {
          const outcome = await api.dispatch(reference)
          if (signal.cancelled) throw cancelled()
          if (outcome.kind === 'complete') return outcome.response
          const output = await capture(terminalId, generation, outcome.capture, signal)
          return api.finishTerminal(reference, output)
        })
      } finally { void api.cancel(reference).catch(() => {}) }
    },
    cancel: operation => api.cancel(operation.reference)
  }
}
