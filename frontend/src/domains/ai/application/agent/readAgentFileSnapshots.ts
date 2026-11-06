import { fileToolError } from '../../../transfer/index'
import type { AgentCommandHandle, AgentCommandRunOptions } from '../../domain/agent'
import { AGENT_FILE_MAX_BYTES, AGENT_SNAPSHOT_MAX_BYTES, AGENT_SNAPSHOT_MAX_OUTPUT, buildFileSnapshotCommand, parseFileSnapshots, snapshotPathProblem, unavailableFile } from '../../domain/agentFileSnapshots'
import type { AgentFileSnapshot } from '../../domain/agentFileSnapshots'

export function createAgentFileSnapshotReader(run: (command: string, options: AgentCommandRunOptions) => AgentCommandHandle) {
  return async (paths: string[], signal: { readonly cancelled: boolean }): Promise<AgentFileSnapshot[]> => {
    const readable = paths.filter(path => !snapshotPathProblem(path))
    let captured: AgentFileSnapshot[] = []
    if (readable.length && !signal.cancelled) {
      const nonce = `${Date.now()}_${Math.random().toString(36).slice(2)}`
      const handle = run(buildFileSnapshotCommand(readable, nonce), { probe: { kind: 'file-snapshot', paths: readable, nonce }, internal: true, waitForReady: true, maxOutputChars: AGENT_SNAPSHOT_MAX_OUTPUT })
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

/** Shared file service, with complete-byte semantics for diff snapshots. */
export function createBoundAgentFileSnapshotReader(
  files: import('../../../transfer/index').AgentFileToolService,
  terminalId: string,
  generation: number,
  legacy: ReturnType<typeof createAgentFileSnapshotReader>
) {
  return async (paths: string[], signal: { readonly cancelled: boolean }): Promise<AgentFileSnapshot[]> => {
    const snapshots: AgentFileSnapshot[] = []
    let remaining = AGENT_SNAPSHOT_MAX_BYTES
    for (const path of paths.slice(0, 100)) {
      const snapshot: AgentFileSnapshot = { requestedPath: path, path, scope: '', version: unavailableFile('未取得完整文件快照') }
      snapshots.push(snapshot)
      const problem = snapshotPathProblem(path)
      if (problem || signal.cancelled || remaining < 4) { snapshot.version = unavailableFile(problem || (signal.cancelled ? '任务已停止，快照未完成' : '文件快照达到批次容量上限')); continue }
      let operation: import('../../../transfer/index').FileOperation | undefined
      try {
        operation = await files.prepare(terminalId, generation, { tool: 'read_file', path, options: { startLine: 1, maxLines: AGENT_FILE_MAX_BYTES, maxBytes: Math.min(AGENT_FILE_MAX_BYTES, remaining) } }, signal)
        if (operation.sensitive) { snapshot.version = unavailableFile('敏感文件不保存内容快照'); continue }
        const result = await files.execute(terminalId, generation, operation, signal)
        const size = result.tool === 'read_file' ? new TextEncoder().encode(result.content).length : 0
        const budgetExceeded = size > AGENT_FILE_MAX_BYTES || size > remaining
        remaining = Math.max(0, remaining - size)
        if (!/^[a-f0-9]{64}$/i.test(result.environmentScope)) { snapshot.version = unavailableFile('文件快照缺少环境绑定'); continue }
        snapshot.path = result.resolvedPath
        snapshot.scope = `${terminalId}:${generation}:${result.environmentScope}`
        if (result.tool !== 'read_file' || result.redacted || !result.complete || !result.eof || result.changedDuringRead || result.start.byte !== 0) { snapshot.version = unavailableFile(result.changedDuringRead ? '文件在读取期间变化，无法取得完整快照' : '文件超过快照范围或大小限制'); continue }
        if (budgetExceeded) { snapshot.version = unavailableFile('文件超过快照容量限制'); remaining = 0; continue }
        snapshot.version = { state: 'text', content: result.content }
      } catch (error) {
        const detail = fileToolError(error)
        if (detail.kind === 'unavailable' && !signal.cancelled && remaining === AGENT_SNAPSHOT_MAX_BYTES) return legacy(paths, signal)
        if (detail.kind === 'missing' && detail.absence && !snapshotPathProblem(detail.absence.resolvedPath)) {
          snapshot.path = detail.absence.resolvedPath
          snapshot.scope = `${terminalId}:${generation}:${detail.absence.environmentScope}`
          snapshot.version = { state: 'missing' }
        } else { snapshot.version = unavailableFile(detail.message) }
      } finally { if (operation) void files.cancel(operation).catch(() => {}) }
    }
    return snapshots
  }
}
