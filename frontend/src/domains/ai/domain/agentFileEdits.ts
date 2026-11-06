import type { FileEditRequest, FileRestoreRequest, FileEditView, FileEditOutcome, FileEditStatus } from '../../transfer/index'

export type FileEditToolName = 'apply_patch' | 'write_file' | 'delete_file' | 'restore_file'
export interface AgentFileEditItem {
  historyPath?: string
  historyScope?: string
  view?: FileEditView
  status: FileEditStatus | 'not-started' | 'review' | 'skipped'
  changeId?: string
  outcome?: FileEditOutcome
  error?: string
}
export function isFileEditTool(name: string): name is FileEditToolName { return ['apply_patch', 'write_file', 'delete_file', 'restore_file'].includes(name) }
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('参数必须是对象')
  const result = value as Record<string, unknown>
  if (Object.keys(result).some(key => !allowed.includes(key))) throw new Error('包含不支持的编辑参数')
  return result
}
function reference(value: unknown, name: string) {
  if (typeof value !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)) throw new Error(`${name} 必须使用工具实际返回的引用`)
  return value
}
const bytes = (value: string) => new TextEncoder().encode(value).length
function content(value: unknown, name: string) {
  if (typeof value !== 'string' || value.includes('\0') || bytes(value) > 65536) throw new Error(`${name} 必须是不含 NUL、最多 64 KiB 的 UTF-8 文本`)
  return value
}
export function parseFileEditArguments(tool: FileEditToolName, json: string): { files: Array<FileEditRequest | FileRestoreRequest>; reason: string } {
  if (json.length > 1_000_000) throw new Error('文件修改参数超过预算')
  const args = object(JSON.parse(json), ['files', 'reason'])
  if (!Array.isArray(args.files) || args.files.length < 1 || args.files.length > 8) throw new Error('每次修改需要 1—8 个文件')
  if (args.reason !== undefined && (typeof args.reason !== 'string' || args.reason.length > 1000)) throw new Error('reason 必须是简短文本')
  let total = 0
  const files = args.files.map(raw => {
    const item = object(raw, ['baselineId', ...(tool === 'apply_patch' ? ['replacements'] : tool === 'write_file' ? ['content'] : tool === 'restore_file' ? ['changeId'] : [])])
    const baselineId = reference(item.baselineId, 'baselineId')
    if (tool === 'restore_file') return { baselineId, changeId: reference(item.changeId, 'changeId') }
    if (tool === 'delete_file') return { baselineId, change: { action: 'delete' as const } }
    if (tool === 'write_file') {
      const text = content(item.content, 'content'); total += bytes(text)
      return { baselineId, change: { action: 'replace' as const, content: text } }
    }
    if (!Array.isArray(item.replacements) || item.replacements.length < 1 || item.replacements.length > 64) throw new Error('每个补丁需要 1—64 项精确替换')
    const replacements = item.replacements.map(rawReplacement => {
      const edit = object(rawReplacement, ['oldText', 'newText'])
      const oldText = content(edit.oldText, 'oldText'), newText = content(edit.newText, 'newText')
      if (!oldText) throw new Error('oldText 不能为空；创建文件请使用 write_file')
      total += bytes(oldText) + bytes(newText)
      return { oldText, newText }
    })
    return { baselineId, change: { action: 'patch' as const, replacements } }
  })
  if (new Set(files.map(file => file.baselineId)).size !== files.length) throw new Error('同一文件基线不能在一批中重复修改')
  if (total > 262144) throw new Error('整批拟议修改超过 256 KiB')
  return { files, reason: typeof args.reason === 'string' ? args.reason.trim() : '' }
}
export function fileEditModelResult(tool: FileEditToolName, items: AgentFileEditItem[]) {
  const value = { tool, status: items.some(item => item.status === 'unknown' || item.status === 'dispatching') ? 'unknown' : items.every(item => item.status === 'applied') ? 'applied' : items.some(item => item.status === 'applied') ? 'partial' : 'not-applied',
    files: items.map(item => ({ path: item.view?.path ?? item.historyPath, resolvedPath: item.view?.resolvedPath, provider: item.view?.provider, writeStrategy: item.view?.writeStrategy, status: item.status, changeId: item.changeId, revision: item.outcome?.revision, error: item.error ?? item.outcome?.error?.message })),
    note: '只报告文件写入核对；服务或业务结果需要另行验证。未知写入不得重试，后续修改或恢复必须重新完整读取。' }
  const result = JSON.stringify(value)
  if (result.length <= 16000) return result
  return JSON.stringify({ ...value, contextTruncated: true, files: value.files.map(file => ({ status: file.status, changeId: file.changeId, pathExcerpt: file.path?.slice(-200), errorExcerpt: file.error?.slice(0, 300) })) })
}
export function persistableFileEdits(items: AgentFileEditItem[] | undefined): AgentFileEditItem[] | undefined {
  return items?.map(item => {
    if (!item.view?.sensitive) return item
    const attributes = (value: NonNullable<AgentFileEditItem['outcome']>['beforeAttributes']) => value ? { ...value, metadataBackup: null } : value
    return { ...item, view: { ...item.view, before: null, after: null, redacted: true, restoreAttributes: attributes(item.view.restoreAttributes) }, outcome: item.outcome ? { ...item.outcome, beforeAttributes: attributes(item.outcome.beforeAttributes), afterAttributes: attributes(item.outcome.afterAttributes) } : undefined }
  })
}
