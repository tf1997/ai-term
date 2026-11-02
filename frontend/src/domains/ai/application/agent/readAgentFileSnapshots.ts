import type { AgentCommandHandle, AgentCommandRunOptions } from '../../domain/agent'
import { AGENT_SNAPSHOT_MAX_OUTPUT, buildFileSnapshotCommand, parseFileSnapshots, snapshotPathProblem, unavailableFile } from '../../domain/agentFileSnapshots'
import type { AgentFileSnapshot } from '../../domain/agentFileSnapshots'

export function createAgentFileSnapshotReader(run: (command: string, options: AgentCommandRunOptions) => AgentCommandHandle) {
  return async (paths: string[], signal: { readonly cancelled: boolean }): Promise<AgentFileSnapshot[]> => {
    const readable = paths.filter(path => !snapshotPathProblem(path))
    let captured: AgentFileSnapshot[] = []
    if (readable.length && !signal.cancelled) {
      const nonce = `${Date.now()}_${Math.random().toString(36).slice(2)}`
      const handle = run(buildFileSnapshotCommand(readable, nonce), { internal: true, waitForReady: true, maxOutputChars: AGENT_SNAPSHOT_MAX_OUTPUT })
      const timer = setTimeout(() => handle.cancel(), 8_000)
      const cancellation = setInterval(() => { if (signal.cancelled) handle.cancel() }, 25)
      try {
        const result = await handle.result
        if (!signal.cancelled && result.status === 'completed' && result.exitCode === 0 && !result.truncated && !result.commandMismatch) captured = parseFileSnapshots(result.output, readable, nonce)
      } finally { clearTimeout(timer); clearInterval(cancellation) }
    }
    const byPath = new Map(captured.map(snapshot => [snapshot.requestedPath, snapshot]))
    return paths.map(path => byPath.get(path) ?? {
      requestedPath: path, path, scope: '', version: unavailableFile(snapshotPathProblem(path) || (signal.cancelled ? '任务已停止，快照未完成' : '文件快照读取失败或超时'))
    })
  }
}
