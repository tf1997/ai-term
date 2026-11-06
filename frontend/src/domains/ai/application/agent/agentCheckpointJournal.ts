import type { AgentRunState } from '../../domain/agent'
import type { AgentCheckpointApi, AgentCheckpointBoundary, AgentRunLease, RecoveryResolution } from '../../domain/agentCheckpoints'
import type { CommandIntentReference, ExecutionTarget } from '../../../../shared/security/commandPolicy'
import { checkpointState } from '../../domain/agentCheckpoints'

/** Serialize saves, including a stop racing with a pre-dispatch save. A failed
 * write poisons the queue: no dependent operation can treat it as acknowledged. */
export function createAgentCheckpointJournal(api: Pick<AgentCheckpointApi, 'saveAgentCheckpoint' | 'releaseAgentRun'> & Partial<Pick<AgentCheckpointApi, 'confirmAgentRecovery'>>, initial: AgentRunLease, timeoutMs = 10_000) {
  const lease = { ...initial }
  let queue: Promise<void> = Promise.resolve()
  const bounded = async <T>(request: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([request, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('检查点存储超时，请先核对任务记录')), timeoutMs) })]) }
    finally { clearTimeout(timer) }
  }
  return {
    confirm(expected: ExecutionTarget, resolutions: RecoveryResolution[]) {
      const snapshot: { expected: ExecutionTarget; resolutions: RecoveryResolution[] } = JSON.parse(JSON.stringify({ expected, resolutions }))
      const confirmation = queue.then(async () => {
        if (!api.confirmAgentRecovery) throw new Error('恢复确认通道不可用')
        const record = await bounded(api.confirmAgentRecovery({ ...lease }, snapshot.expected, lease.sequence, snapshot.resolutions))
        lease.sequence = record.sequence
        return record
      })
      // Stop may enqueue a final save while confirmation is still in flight.
      // It must use the confirmed sequence, or stop on a lost receipt.
      queue = confirmation.then(() => {})
      void queue.catch(() => {})
      return confirmation
    },
    save(state: AgentRunState, boundary: AgentCheckpointBoundary, stepId?: string, scriptIntent?: CommandIntentReference): Promise<void> {
      const snapshot = checkpointState(state)
      const reference: CommandIntentReference | undefined = scriptIntent && ['prepared', 'before-dispatch'].includes(boundary) ? JSON.parse(JSON.stringify(scriptIntent)) : undefined
      queue = queue.then(async () => {
        lease.sequence = await bounded(api.saveAgentCheckpoint({ ...lease }, { expectedSequence: lease.sequence, boundary, stepId: stepId ?? null, state: snapshot, ...(reference ? { scriptIntent: reference } : {}) }))
      })
      return queue
    },
    async release() {
      await queue.catch(() => {})
      await bounded(api.releaseAgentRun(lease))
    }
  }
}
