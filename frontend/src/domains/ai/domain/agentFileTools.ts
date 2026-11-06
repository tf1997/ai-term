import type { FileToolRequest, FileToolResponse } from '../../transfer/index'

export type FileToolName = FileToolRequest['tool']
export function isFileTool(name: string): name is FileToolName { return name === 'read_file' || name === 'list_directory' }
export function parseFileToolArguments(tool: FileToolName, json: string): { ok: true; request: FileToolRequest; reason: string } | { ok: false; error: string } {
  try {
    const args: unknown = JSON.parse(json)
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('参数必须是 JSON 对象')
    const record = args as Record<string, unknown>
    const allowed = tool === 'read_file' ? ['path', 'reason', 'startLine', 'maxLines', 'maxBytes', 'tail', 'cursor'] : ['path', 'reason', 'limit', 'cursor']
    if (Object.keys(record).some(key => !allowed.includes(key))) throw new Error('包含不支持的文件工具参数')
    if (typeof record.path !== 'string' || !record.path.startsWith('/') || record.path.length > 4096 || /[\x00-\x1f\x7f-\x9f]/.test(record.path) || record.path.split('/').some(part => part === '.' || part === '..')) throw new Error('path 必须是当前环境中的明确绝对路径')
    if (record.reason !== undefined && typeof record.reason !== 'string') throw new Error('reason 必须是字符串')
    if (record.cursor !== undefined && (typeof record.cursor !== 'string' || !/^[\da-f-]{36}$/i.test(record.cursor))) throw new Error('cursor 必须来自上一页结果')
    const number = (key: string, minimum: number, maximum: number, fallback: number) => {
      const value = record[key] ?? fallback
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${key} 超出允许范围`)
      return value
    }
    const cursor = record.cursor as string | undefined
    const reason = typeof record.reason === 'string' ? record.reason.trim().slice(0, 1000) : ''
    if (tool === 'list_directory') return { ok: true, request: { tool, path: record.path, limit: number('limit', 1, 500, 100), cursor }, reason }
    if (record.tail !== undefined && typeof record.tail !== 'boolean') throw new Error('tail 必须是布尔值')
    const options = { startLine: number('startLine', 1, Number.MAX_SAFE_INTEGER, 1), maxLines: number('maxLines', 1, 65536, 200), maxBytes: number('maxBytes', 4, 65536, 16384), tail: record.tail === true }
    if ((cursor && (options.startLine !== 1 || options.tail)) || (options.tail && options.startLine !== 1)) throw new Error('cursor、开始行和末尾读取不能混用')
    return { ok: true, request: { tool, path: record.path, options, cursor }, reason }
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : '无法解析文件工具参数' } }
}
export function fileToolArguments(request: FileToolRequest, reason: string) {
  return { path: request.path, reason, cursor: request.cursor ?? undefined, ...(request.tool === 'read_file' ? request.options : { limit: request.limit }) }
}
export function fileToolOutput(result: FileToolResponse): string {
  return result.tool === 'read_file' ? result.content : result.entries.map(entry => `${entry.kind === 'directory' ? '目录' : entry.kind === 'symlink' ? '链接' : '文件'}\t${entry.name}${entry.size === null ? '' : `\t${entry.size} B`}`).join('\n')
}
export function fileToolModelResult(result: FileToolResponse): string {
  if (result.redacted) return JSON.stringify({ status: 'content_not_persisted', tool: result.tool, path: result.path, note: '敏感内容未保存，需重新申请读取。' })
  // Session IDs and approvals are application state, not model arguments.
  const { target: _target, sensitive: _sensitive, environmentScope: _scope, ...data } = result
  const json = JSON.stringify({ status: 'completed', ...data })
  // A complete 64 KiB text baseline must remain visible to the model before it
  // can propose a patch. Leave room below the backend's 80k turn hard limit.
  if (json.length <= 70_000) return json
  // Never silently drop bytes and leave a cursor that skips the omitted text.
  return JSON.stringify({ status: 'model_context_limit', tool: result.tool, path: result.path, revision: result.revision, error: '已读取的结果超过本轮模型上下文预算，内容未回传。请重新读取并减小 maxBytes（建议 4000）或 limit；不要使用本次分页位置跳过尚未看到的内容。' })
}
/** Persist the parameters and observed ranges, but never reusable cursors or sensitive content. */
export function persistableFileResult(result: FileToolResponse): FileToolResponse {
  const { baselineId: _baselineId, ...persisted } = result
  if (persisted.tool === 'read_file') return { ...persisted, nextCursor: null, redacted: result.sensitive || result.redacted, content: result.sensitive ? '[敏感文件内容未存储]' : persisted.content }
  return { ...persisted, nextCursor: null, redacted: result.sensitive || result.redacted, entries: result.sensitive ? [] : persisted.entries }
}
