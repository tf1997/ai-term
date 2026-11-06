import type { ExecutionTarget } from '../../../shared/security/commandPolicy'
import type { FileCancellation, FileCapturePlan } from '../domain/fileTools'
import { fileToolError } from '../domain/fileTools'
import type { AgentFileEditService, FileChangeRecord, FileEditProposal } from '../domain/fileEdits'
import { unknownFileChange } from '../domain/fileEdits'
import { fileEditApi } from '../infrastructure/fileEdits'

interface Dependencies {
  target(terminalId: string, generation: number): Promise<ExecutionTarget>
  capture(terminalId: string, generation: number, plan: FileCapturePlan, signal: FileCancellation): Promise<string>
}
const cancelled = () => ({ kind: 'cancelled' as const, message: '已停止观察文件写入，请核对变更记录和当前文件' })
async function bounded<T>(promise: Promise<T>, milliseconds = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject({ kind: 'unavailable', message: '文件编辑请求超时，结果待核对' }), milliseconds) })]) }
  finally { clearTimeout(timer) }
}

export function createAgentFileEditService(deps: Dependencies, api = fileEditApi): AgentFileEditService {
  function sameTarget(left: ExecutionTarget, right: ExecutionTarget) {
    return left.sessionId === right.sessionId && left.sessionInstance === right.sessionInstance && left.profileId === right.profileId && left.routeVersion === right.routeVersion && left.contextVersion === right.contextVersion
  }
  function boundRecord(proposal: FileEditProposal, record: FileChangeRecord) {
    return record.id === proposal.reference.id && sameTarget(record.target, proposal.reference.target) && record.provider === proposal.provider && record.path === proposal.path && record.resolvedPath === proposal.resolvedPath && record.environmentScope === proposal.environmentScope && record.sensitive === proposal.sensitive && (record.sensitive || record.before === proposal.before && record.after === proposal.after)
  }
  async function prepared(signal: FileCancellation, promise: Promise<FileEditProposal>) {
    // A timed-out prepare may return later. Cancel its ticket; never turn it
    // into an approval or dispatch while the caller has moved on.
    let abandoned = false
    promise.then(value => { if (abandoned || signal.cancelled) void api.cancel(value.reference).catch(() => {}) }, () => {})
    try {
      const proposal = await bounded(promise)
      if (signal.cancelled) throw cancelled()
      return proposal
    } catch (error) { abandoned = true; throw error }
  }
  async function reconcile(proposal: FileEditProposal, error: unknown): Promise<FileChangeRecord> {
    try {
      const record = await bounded(api.getChange(proposal.reference.id))
      if (record && boundRecord(proposal, record)) return record
    } catch { /* Missing receipt is not proof that the write did not happen. */ }
    return unknownFileChange(proposal, fileToolError(error))
  }
  return {
    async prepare(terminalId, generation, request, signal) {
      if (signal.cancelled) throw cancelled()
      const target = await bounded(deps.target(terminalId, generation))
      if (signal.cancelled) throw cancelled()
      return prepared(signal, api.prepare(target, request))
    },
    async prepareRestore(terminalId, generation, request, signal) {
      if (signal.cancelled) throw cancelled()
      const target = await bounded(deps.target(terminalId, generation))
      if (signal.cancelled) throw cancelled()
      return prepared(signal, api.prepareRestore(target, request))
    },
    approve: proposal => bounded(api.approve(proposal)),
    async execute(terminalId, generation, proposal, signal) {
      if (signal.cancelled) throw cancelled()
      try {
        const current = await bounded(deps.target(terminalId, generation))
        if (!sameTarget(current, proposal.reference.target)) throw { kind: 'target-changed', message: '文件编辑绑定的终端或环境已变化，请重新完整读取' }
        if (signal.cancelled) throw cancelled()
      } catch (error) {
        const record = unknownFileChange(proposal, fileToolError(error))
        record.outcome.status = 'conflict'
        return record
      }
      let stopped = false
      const watch = setInterval(() => {
        if (!signal.cancelled || stopped) return
        stopped = true
        void api.cancel(proposal.reference).catch(() => {})
      }, 25)
      try {
        // Exactly one dispatch. A lost acknowledgement is reconciled by the
        // durable change ID, never by sending this mutation again.
        // Native writes have a 60s observation budget for WAN SFTP validation.
        // Leave time for the final persisted receipt to cross the IPC boundary.
        const outcome = await bounded(api.dispatch(proposal.reference), 65000)
        if (outcome.kind === 'complete') {
          if (!boundRecord(proposal, outcome.record)) throw { kind: 'target-changed', message: '文件修改结果不属于本次目标或差异' }
          return outcome.record
        }
        if (signal.cancelled) return reconcile(proposal, cancelled())
        const output = await deps.capture(terminalId, generation, outcome.capture, signal)
        const record = await bounded(api.finishTerminal(proposal.reference, output))
        if (!boundRecord(proposal, record)) throw { kind: 'target-changed', message: '文件修改回执不属于本次目标或差异' }
        return record
      } catch (error) { return reconcile(proposal, error) }
      finally { clearInterval(watch); void api.cancel(proposal.reference).catch(() => {}) }
    },
    cancel: proposal => api.cancel(proposal.reference),
    getChange: id => bounded(api.getChange(id)),
    listChanges: (profileId, limit) => bounded(api.listChanges(profileId, limit))
  }
}
