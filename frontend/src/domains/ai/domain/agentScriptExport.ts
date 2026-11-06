import type { AgentCheckpoint } from './agentCheckpoints'
import type { TaskScriptSource } from '../../scripts/types'
import type { FileChangeRecord } from '../../transfer/index'
import { isSensitiveCommand } from '../../../shared/security/commandPrivacy'
import { isSensitivePath } from '../../../shared/security/pathPrivacy'

function privateContent(value: string | null) {
  return value !== null && (isSensitiveCommand(value) || /["']?[\w.-]*(?:password|passwd|secret|token|private[_-]?key|api[_-]?key)["']?\s*[:=]\s*\S/i.test(value) || value.includes('__AI_TERM_PARAM_'))
}

export function taskScriptSourceFromCheckpoint(record: AgentCheckpoint, changes: FileChangeRecord[] = []): TaskScriptSource {
  return {
    runId: record.runId, messageId: record.messageId, workspaceSessionId: record.workspaceSessionId,
    steps: record.state.steps.map(step => {
      const target = step.executionTarget, context = target?.context
      const fileChanges: NonNullable<TaskScriptSource['steps'][number]['fileChanges']> = []
      for (const item of step.fileEdits) {
        const change = changes.find(change => change.id === item.changeId)
        if (!change || !target || item.status !== 'applied' || change.outcome.status !== 'applied' || change.path !== item.path || change.environmentScope !== item.environmentScope || change.outcome.revision !== item.revision) continue
        const actual = change.target
        if (actual.sessionId !== target.sessionId || actual.sessionInstance !== target.sessionInstance || actual.profileId !== target.profileId || actual.routeVersion !== target.routeVersion || actual.contextVersion !== target.contextVersion || actual.context.shell !== target.context.shell || actual.context.workingDirectory !== target.context.workingDirectory || actual.context.user !== target.context.user || actual.context.environmentScope !== target.context.environmentScope) continue
        if (!['create-exclusive', 'delete', 'in-place', 'atomic-replace'].includes(change.writeStrategy)) continue
        const before = change.outcome.beforeAttributes, after = change.outcome.afterAttributes
        // Content conversion cannot silently omit an ownership/mode/ACL restore.
        if (before && after && (before.mode !== after.mode || before.uid !== after.uid || before.gid !== after.gid || JSON.stringify(before.metadataBackup ?? null) !== JSON.stringify(after.metadataBackup ?? null))) continue
        const action = change.writeStrategy === 'create-exclusive' ? 'create' : change.writeStrategy === 'delete' ? 'delete' : 'replace'
        const externalContent = change.sensitive || step.sensitive || isSensitivePath(change.path) || isSensitivePath(change.resolvedPath) || privateContent(change.before) || privateContent(change.after)
        const mode = (after ?? before)?.mode
        if (mode === undefined || !externalContent && (action !== 'create' && change.before === null || action !== 'delete' && change.after === null)) continue
        fileChanges.push({ id: change.id, path: change.resolvedPath, action, before: externalContent ? null : change.before, after: externalContent ? null : change.after, externalContent, mode })
      }
      const read = step.fileRead
      if (step.toolName === 'read_file' && target && read?.complete && !read.changedDuringRead && !read.absent && read.resolvedPath && read.environmentScope && (typeof read.content === 'string' || step.sensitive)) {
        const externalContent = step.sensitive || isSensitivePath(read.path) || isSensitivePath(read.resolvedPath) || privateContent(read.content)
        fileChanges.push({ id: step.id, path: read.resolvedPath, action: 'verify', before: externalContent ? null : read.content, after: null, externalContent, mode: 0 })
      }
      return { id: step.id, tool: step.toolName, command: step.command, status: step.status, executionPhase: step.executionPhase, exitCode: step.exitCode, sensitive: step.sensitive,
        commandSource: step.scriptSource ? JSON.parse(JSON.stringify(step.scriptSource)) : undefined,
        fileChanges, fileChangeCount: step.toolName === 'read_file' ? 1 : step.fileEdits.length,
        directory: context?.workingDirectory ?? null,
        environment: target && context && record.routeKey && context.user && context.environmentScope
          ? { profileId: target.profileId, routeKey: record.routeKey, user: context.user, environmentScope: context.environmentScope, shell: context.shell } : null }
    }),
    checks: record.state.verifications.map(check => ({ id: check.id, purpose: check.purpose, kind: check.check.kind, expected: check.check.expected, stepId: check.check.stepId ?? null, required: check.required, status: check.status }))
  }
}
