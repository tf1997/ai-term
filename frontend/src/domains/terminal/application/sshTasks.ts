import type { ExecutionTarget } from '../../../shared/security/commandPolicy'
import type { SshTaskService, SshTaskSnapshot } from '../domain/sshTasks'
import { sshTaskApi } from '../infrastructure/sshTasks'

interface Dependencies { target(terminalId: string, generation: number): Promise<ExecutionTarget> }
const finished = (snapshot: SshTaskSnapshot) => !['connecting', 'running'].includes(snapshot.status)
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('任务状态读取超时')), 5000) })])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}

/** Events wake the reader; snapshots recover lost events without replaying exec. */
export function createSshTaskService(deps: Dependencies, api = sshTaskApi): SshTaskService {
  return {
    async prepare(terminalId, generation, request) {
      const target = await deps.target(terminalId, generation)
      return api.prepare(target, request)
    },
    approve: intent => api.approve(intent),
    cancel: intent => api.cancel(intent.reference),
    async start(terminalId, generation, intent, update) {
      const target = await deps.target(terminalId, generation)
      if (JSON.stringify(target) !== JSON.stringify(intent.reference.origin)) throw new Error('独立任务的来源连接已变化，请重新审查')
      let cancelled = false
      let settled = false
      let wake: (() => void) | undefined
      let latest: SshTaskSnapshot = {
        reference: intent.reference, target: intent.target, sequence: -1, status: 'connecting',
        stdout: '', stderr: '', outputBytes: 0, truncated: false, exitCode: null, exitSignal: null,
        exitEvidence: null, reason: null, startedAt: Date.now(), finishedAt: null
      }
      const accept = (snapshot: SshTaskSnapshot) => {
        if (JSON.stringify(snapshot.reference) !== JSON.stringify(intent.reference)) throw new Error('独立任务结果目标不一致')
        if (snapshot.sequence >= latest.sequence) { latest = snapshot; update(snapshot) }
      }
      const cancel = () => {
        if (settled || cancelled) return
        cancelled = true
        void api.cancel(intent.reference).catch(() => {})
        wake?.()
      }
      const result = (async () => {
        let unlisten: (() => void) | undefined
        const deadline = Date.now() + intent.request.timeoutMs + 5_000
        try {
          unlisten = await bounded(api.listen(intent.reference, () => wake?.()).then(dispose => {
            if (settled) dispose()
            return dispose
          })).catch(() => undefined)
          if (cancelled) return { ...latest, status: 'not-started' as const, reason: '派发前已取消', finishedAt: Date.now() }
          // An IPC failure after start can mean the acknowledgement was lost.
          // Reconcile via read; never retry start or fall back to the PTY.
          try { accept(await bounded(api.start(intent.reference))) } catch { accept(await bounded(api.read(intent.reference))) }
          while (!finished(latest)) {
            if (cancelled || Date.now() >= deadline) {
              void api.cancel(intent.reference).catch(() => {})
              return { ...latest, status: 'unknown' as const, exitCode: null, exitEvidence: null, reason: '已停止观察；远端命令可能仍在运行，请先核验实际状态。', finishedAt: Date.now() }
            }
            await new Promise<void>(resolve => {
              const timer = setTimeout(() => { wake = undefined; resolve() }, 200)
              wake = () => { clearTimeout(timer); wake = undefined; resolve() }
            })
            accept(await bounded(api.read(intent.reference)))
          }
          return latest
        } catch (error) {
          void api.cancel(intent.reference).catch(() => {})
          return { ...latest, status: 'unknown' as const, exitCode: null, exitEvidence: null, reason: `独立任务结果无法确认：${String(error)}。请先核验实际状态。`, finishedAt: Date.now() }
        } finally { settled = true; unlisten?.(); wake?.() }
      })()
      return { result, cancel }
    }
  }
}
