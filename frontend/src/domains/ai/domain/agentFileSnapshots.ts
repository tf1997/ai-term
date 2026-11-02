import { isSensitivePath } from '../../../shared/security/pathPrivacy'

export const AGENT_FILE_MAX_BYTES = 64 * 1024
export const AGENT_SNAPSHOT_MAX_BYTES = 256 * 1024
export const AGENT_SNAPSHOT_MAX_OUTPUT = 512 * 1024

export type AgentFileVersion =
  | { state: 'text'; content: string }
  | { state: 'missing' }
  | { state: 'unavailable'; reason: string }

export interface AgentFileSnapshot {
  requestedPath: string
  path: string
  scope: string
  version: AgentFileVersion
}

export interface AgentFileChange {
  path: string
  requestedPaths: string[]
  scope: string
  before: AgentFileVersion
  after: AgentFileVersion
  stepIds: string[]
  uncertainReason?: string
}

export function unavailableFile(reason: string): AgentFileVersion { return { state: 'unavailable', reason } }

export function snapshotPathProblem(path: string): string {
  if (isSensitivePath(path)) return '敏感文件不保存内容快照'
  if (!path.startsWith('/') || /[\u0000-\u001f]/.test(path) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(path)) return '需要明确的绝对文件路径'
  return ''
}

function quote(value: string) { return `'${value.replace(/'/g, `'"'"'`)}'` }

/** Read through the task's own POSIX terminal, including SSH/container/sudo contexts.
 * No temp files, git operations, Python dependency or writes to the target files.
 * The head exit status is encoded with its bytes, so a failed read is never an empty file.
 */
export function buildFileSnapshotCommand(paths: string[], nonce: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(nonce)) throw new Error('Invalid snapshot nonce')
  const tag = `AI_TERM_SNAPSHOT_${nonce}`
  return `( export LC_ALL=C
command -v base64 >/dev/null 2>&1 || exit 1
ai_snap_host=$(hostname 2>/dev/null) && ai_snap_uid=$(id -u) && ai_snap_root=$(ls -id /) || exit 1
printf '${tag}_SCOPE\\n'
printf '%s\\n%s\\n%s\\n%s' "$ai_snap_host" "$ai_snap_uid" "$ai_snap_root" "$(readlink /proc/self/ns/mnt 2>/dev/null)" | base64
printf '\\n${tag}_SCOPE_END\\n'
ai_snap_i=0
ai_snap_budget=${AGENT_SNAPSHOT_MAX_BYTES}
for ai_snap_path in ${paths.map(quote).join(' ')}; do
  printf '${tag}_FILE_%s\\n' "$ai_snap_i"
  ai_snap_parent=$(dirname "$ai_snap_path")
  ai_snap_name=$(basename "$ai_snap_path")
  ai_snap_dir=$(CDPATH= cd -P "$ai_snap_parent" 2>/dev/null && pwd -P)
  ai_snap_resolved=$ai_snap_path
  if [ -n "$ai_snap_dir" ]; then ai_snap_resolved="\${ai_snap_dir%/}/$ai_snap_name"; fi
  printf '%s' "$ai_snap_resolved" | base64
  printf '\\n${tag}_PATH_END\\n'
  if [ -L "$ai_snap_path" ]; then
    printf 'unsupported\\n'
  elif [ -f "$ai_snap_path" ]; then
    if [ "$ai_snap_budget" -le 0 ]; then
      printf 'budget\\n'
    else
      ai_snap_limit=${AGENT_FILE_MAX_BYTES}
      if [ "$ai_snap_budget" -lt "$ai_snap_limit" ]; then ai_snap_limit=$ai_snap_budget; fi
      printf 'text\\n'
      { head -c "$((ai_snap_limit + 1))" "$ai_snap_path" 2>/dev/null; ai_snap_read_status=$?; printf '\\n${tag}_READ_STATUS_%s\\n' "$ai_snap_read_status"; } | base64
      ai_snap_size=$(wc -c < "$ai_snap_path" 2>/dev/null) || ai_snap_size=$((ai_snap_limit + 1))
      case "$ai_snap_size" in *[!0-9[:space:]]*|'') ai_snap_size=$((ai_snap_limit + 1));; esac
      ai_snap_budget=$((ai_snap_budget - ai_snap_size))
    fi
  elif [ -e "$ai_snap_path" ]; then
    printf 'unsupported\\n'
  else
    ai_snap_ancestor=$ai_snap_parent
    while [ ! -e "$ai_snap_ancestor" ] && [ ! -L "$ai_snap_ancestor" ] && [ "$ai_snap_ancestor" != / ]; do
      ai_snap_ancestor=$(dirname "$ai_snap_ancestor")
    done
    if [ -d "$ai_snap_ancestor" ] && [ -x "$ai_snap_ancestor" ]; then printf 'missing\\n'; else printf 'unreadable\\n'; fi
  fi
  printf '\\n${tag}_FILE_END\\n'
  ai_snap_i=$((ai_snap_i + 1))
done
)`
}

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ''))
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}
function decodeText(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new Error('binary')
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
}

export function parseFileSnapshots(output: string, paths: string[], nonce: string): AgentFileSnapshot[] {
  if (!/^[a-zA-Z0-9_]+$/.test(nonce)) throw new Error('Invalid snapshot nonce')
  const tag = `AI_TERM_SNAPSHOT_${nonce}`
  const source = output.replace(/\r\n/g, '\n')
  let scope = ''
  try {
    const match = source.match(new RegExp(`(?:^|\\n)${tag}_SCOPE\\n([\\s\\S]*?)\\n${tag}_SCOPE_END(?:\\n|$)`))
    if (match) scope = decodeText(bytesFromBase64(match[1]))
  } catch { /* Missing/invalid scope prevents comparisons across terminal environments. */ }
  let remaining = AGENT_SNAPSHOT_MAX_BYTES
  return paths.map((requestedPath, index) => {
    const snapshot: AgentFileSnapshot = { requestedPath, path: requestedPath, scope, version: unavailableFile('未取得完整文件快照') }
    if (!scope || scope.length > 2048) return snapshot
    const match = source.match(new RegExp(`(?:^|\\n)${tag}_FILE_${index}\\n([\\s\\S]*?)\\n${tag}_PATH_END\\n([a-z]+)\\n([\\s\\S]*?)${tag}_FILE_END(?:\\n|$)`))
    if (!match) return snapshot
    try {
      const path = decodeText(bytesFromBase64(match[1]))
      if (!path.startsWith('/') || /[\u0000-\u001f]/.test(path)) return snapshot
      snapshot.path = path
      if (isSensitivePath(path)) { snapshot.version = unavailableFile('敏感文件不保存内容快照'); return snapshot }
      const state = match[2]
      if (state === 'missing') snapshot.version = { state: 'missing' }
      else if (state === 'text') {
        const bytes = bytesFromBase64(match[3])
        const suffix = new TextEncoder().encode(`\n${tag}_READ_STATUS_0\n`)
        const complete = bytes.length >= suffix.length && suffix.every((value, i) => bytes[bytes.length - suffix.length + i] === value)
        if (!complete) { snapshot.version = unavailableFile('文件读取失败'); return snapshot }
        const contentBytes = bytes.subarray(0, bytes.length - suffix.length)
        if (contentBytes.length > AGENT_FILE_MAX_BYTES || contentBytes.length > remaining) {
          snapshot.version = unavailableFile('文件超过快照大小限制')
          remaining = 0
        } else {
          remaining -= contentBytes.length
          try { snapshot.version = { state: 'text', content: decodeText(contentBytes) } }
          catch { snapshot.version = unavailableFile('二进制或非 UTF-8 文件不支持逐行比较') }
        }
      } else snapshot.version = unavailableFile(state === 'budget' ? '本轮快照总大小超过限制' : state === 'unsupported' ? '目录、符号链接等文件类型不支持逐行比较' : '文件无法读取')
    } catch { /* Invalid base64 cannot be interpreted as a complete file. */ }
    return snapshot
  })
}

export function normalizeAgentFileChanges(value: unknown): AgentFileChange[] | undefined {
  if (!Array.isArray(value)) return undefined
  let budget = 2 * 1024 * 1024
  function version(raw: unknown): AgentFileVersion {
    if (!raw || typeof raw !== 'object') return unavailableFile('缺少文件快照')
    const record = raw as Record<string, unknown>
    if (record.state === 'missing') return { state: 'missing' }
    if (record.state === 'text' && typeof record.content === 'string') {
      const size = record.content.length <= AGENT_FILE_MAX_BYTES ? new TextEncoder().encode(record.content).length : Infinity
      if (size > AGENT_FILE_MAX_BYTES || size > budget) return unavailableFile('文件快照超过保存大小限制')
      budget -= size
      return { state: 'text', content: record.content }
    }
    return unavailableFile(typeof record.reason === 'string' ? record.reason.slice(0, 200) : '未记录文件快照')
  }
  const result: AgentFileChange[] = []
  for (const raw of value.slice(0, 100)) {
    if (!raw || typeof raw !== 'object' || typeof raw.path !== 'string' || !raw.path || raw.path.length > 4096 || /[\u0000-\u001f]/.test(raw.path)) continue
    const paths = Array.isArray(raw.requestedPaths) ? raw.requestedPaths.filter((p: unknown): p is string => typeof p === 'string' && p.length <= 4096).slice(0, 100) : [raw.path]
    const sensitive = isSensitivePath(raw.path) || paths.some(isSensitivePath)
    result.push({
      path: raw.path, requestedPaths: paths, scope: typeof raw.scope === 'string' ? raw.scope.slice(0, 2048) : '',
      before: sensitive ? unavailableFile('敏感文件不保存内容快照') : version(raw.before),
      after: sensitive ? unavailableFile('敏感文件不保存内容快照') : version(raw.after),
      stepIds: Array.isArray(raw.stepIds) ? [...new Set<string>(raw.stepIds.filter((id: unknown): id is string => typeof id === 'string' && id.length <= 512))].slice(0, 500) : [],
      ...(typeof raw.uncertainReason === 'string' && raw.uncertainReason ? { uncertainReason: raw.uncertainReason.slice(0, 200) } : {})
    })
  }
  return result.length ? result : undefined
}

function sameVersion(left: AgentFileVersion, right: AgentFileVersion): boolean {
  return left.state === 'missing' && right.state === 'missing' || left.state === 'text' && right.state === 'text' && left.content === right.content
}

/** Preserve the first pre-write content; repeated edits are compared as one net task change. */
export function createAgentFileTracker(initial?: AgentFileChange[]) {
  let changes = normalizeAgentFileChanges(initial) ?? []
  const values = () => normalizeAgentFileChanges(changes)
  return {
    values,
    begin(stepId: string, before: AgentFileSnapshot[]) {
      const saved = changes
      const keys: { snapshot: AgentFileSnapshot; index: number }[] = []
      changes = [...changes]
      for (const snapshot of before) {
        let index = changes.findIndex(change => change.path === snapshot.path && change.scope === snapshot.scope)
        if (index < 0) index = changes.findIndex(change => change.requestedPaths.includes(snapshot.requestedPath) && (!change.scope || !snapshot.scope))
        const previous = index >= 0 ? changes[index] : undefined
        if (!previous && changes.length >= 100) continue
        const sameRead = keys.some(key => key.index === index)
        const uncertainReason = previous?.uncertainReason || (previous && !sameRead && !sameVersion(previous.after, snapshot.version)
          ? '两次执行之间文件发生变化或缺少快照，无法准确归因' : undefined)
        const change: AgentFileChange = {
          path: snapshot.path, scope: snapshot.scope,
          requestedPaths: [...new Set([...(previous?.requestedPaths ?? []), snapshot.requestedPath])],
          before: previous?.before ?? snapshot.version,
          after: unavailableFile('未取得执行后的文件快照'),
          stepIds: [...new Set([...(previous?.stepIds ?? []), stepId])],
          ...(uncertainReason ? { uncertainReason } : {})
        }
        if (index < 0) { index = changes.length; changes.push(change) } else changes[index] = change
        keys.push({ snapshot, index })
      }
      changes = values() ?? []
      return {
        rollback() { changes = saved },
        finish(after: AgentFileSnapshot[]) {
          changes = [...changes]
          for (const { snapshot, index } of keys) {
            const current = changes[index]
            if (!current) continue
            const result = after.find(item => item.requestedPath === snapshot.requestedPath)
            const matches = result && result.scope && result.scope === snapshot.scope && result.path === snapshot.path
            changes[index] = { ...current, after: matches ? result.version : unavailableFile(result?.version.state === 'unavailable' ? result.version.reason : '终端环境或文件路径发生变化，无法比较') }
          }
          changes = values() ?? []
        }
      }
    }
  }
}
