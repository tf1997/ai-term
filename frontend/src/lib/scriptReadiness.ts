export type ScriptReadinessKind = 'empty-value' | 'todo' | 'placeholder'

export interface ScriptReadinessIssue {
  kind: ScriptReadinessKind
  line: number
  text: string
  label: string
  message: string
}

const EMPTY_ASSIGNMENT_PATTERN = /^(?:export\s+)?(?:\$?[A-Za-z_][\w.-]*)\s*=\s*(?:""|'')\s*(?:#.*)?$/
const EMPTY_BATCH_ASSIGNMENT_PATTERN = /^set\s+"?[A-Za-z_][\w.-]*=\s*"?$/i
const TODO_PATTERN = /(?:\bTODO\b|\bFIXME\b|待填写|待补充|请填写|请替换|修改这里)/i
const PLACEHOLDER_PATTERN = /(?:\bCHANGE_ME\b|\bREPLACE_ME\b|\bYOUR_[A-Z0-9_]+\b|<(?:server|host|user|username|password|token|path|port|ip|域名|地址|用户名|密码|路径)[^>]*>)/i

export function analyzeScriptReadiness(content: string): ScriptReadinessIssue[] {
  return content.split(/\r?\n/).flatMap<ScriptReadinessIssue>((line, index) => {
    const text = line.trim()
    if (!text) return []

    if (EMPTY_ASSIGNMENT_PATTERN.test(text) || EMPTY_BATCH_ASSIGNMENT_PATTERN.test(text)) {
      return [{
        kind: 'empty-value',
        line: index + 1,
        text: line,
        label: '变量未填写',
        message: '变量仍为空值，请填写后再运行。'
      }]
    }

    const comment = readinessCommentForLine(text)
    if (comment && TODO_PATTERN.test(comment)) {
      return [{
        kind: 'todo',
        line: index + 1,
        text: line,
        label: '存在待办',
        message: '脚本中仍有 TODO、FIXME 或待填写说明。'
      }]
    }

    if (PLACEHOLDER_PATTERN.test(text)) {
      return [{
        kind: 'placeholder',
        line: index + 1,
        text: line,
        label: '占位符未替换',
        message: '脚本中仍有示例占位符，请替换为真实值。'
      }]
    }

    return []
  })
}

function readinessCommentForLine(text: string) {
  if (/^(?:rem\b|::)/i.test(text)) return text
  const commentStart = text.indexOf('#')
  return commentStart >= 0 ? text.slice(commentStart) : ''
}

export function scriptReadinessStatusForContent(content: string) {
  const issues = analyzeScriptReadiness(content)
  if (!content.trim()) {
    return {
      level: 'muted' as const,
      label: '等待输入',
      message: '输入脚本后将检查待填写项。',
      issues
    }
  }
  if (issues.length > 0) {
    return {
      level: 'pending' as const,
      label: `${issues.length} 项待填写`,
      message: issues.map((issue) => `第 ${issue.line} 行：${issue.label}`).join('；'),
      issues
    }
  }
  return {
    level: 'ready' as const,
    label: '填写完整',
    message: '未发现待填写项。',
    issues
  }
}
