import type { EditorCursor } from './scriptPanel'
import type { ScriptReadinessIssue } from './scriptReadiness'
import { detectShellScriptLanguage } from '../../../shared/shell/shellCommand'
import type { ShellScriptLanguage } from '../../../shared/shell/shellCommand'

export function cursorPositionForTextarea(target: HTMLTextAreaElement): EditorCursor {
  const beforeCursor = target.value.slice(0, target.selectionStart ?? 0)
  const lines = beforeCursor.split('\n')
  return {
    line: lines.length,
    column: (lines[lines.length - 1]?.length ?? 0) + 1
  }
}

export function lineNumbersForScript(content: string) {
  const lineCount = Math.max(1, normalizeScriptEditorContent(content).split('\n').length)
  return Array.from({ length: lineCount }, (_, index) => String(index + 1)).join('\n')
}

export function highlightShellScript(content: string, fileName = '') {
  const normalized = normalizeScriptEditorContent(content)
  const language = detectShellScriptLanguage(normalized, fileName)
  return normalized.split('\n').map((line) => highlightShellLine(line, language) || ' ').join('\n')
}

export function normalizeScriptEditorContent(content: string) {
  return content.replace(/\r\n?/g, '\n')
}

export function readinessLinesText(issues: ScriptReadinessIssue[]) {
  return issues.map((issue) => issue.line).join('、')
}

export const bashTokenPattern = /(\x22(?:\\.|[^\x22\\])*\x22|'(?:\\.|[^'\\])*'|#[^\n]*|\$(?:\{[^}\n]+\}|[A-Za-z_][\w]*|[0-9@*#?$!-])|\b[A-Za-z_][\w]*(?=\s*\(\s*\)\s*\{)|\b(?:sudo|apt|apt-get|yum|dnf|pacman|brew|systemctl|service|docker|podman|kubectl|helm|rm|cp|mv|sed|awk|grep|find|chmod|chown|curl|wget|echo|printf|read|set|test|cat|mkdir|touch|tar|ssh|scp|rsync|if|then|elif|else|fi|for|in|do|done|while|until|case|esac|select|function|export|source|local|readonly|declare|unset|shift|trap|exit|return|break|continue)\b|&&|\|\||<<|>>|[|;&<>])/g

export const powershellTokenPattern = /(\x22(?:\\.|[^\x22\\])*\x22|'(?:''|[^'])*'|#[^\n]*|\$(?:\{[^}\n]+\}|(?:env|global|script|local|private):[A-Za-z_][\w]*|[A-Za-z_?][\w?]*|[_^$])|\b(?:Add|Clear|Connect|ConvertFrom|ConvertTo|Copy|Disable|Disconnect|Enable|Enter|Exit|Export|Find|Format|ForEach|Get|Import|Install|Invoke|Join|Measure|Move|New|Out|Read|Receive|Register|Remove|Rename|Restart|Select|Send|Set|Sort|Split|Start|Stop|Test|Uninstall|Unregister|Update|Wait|Where|Write)-[A-Z][A-Za-z0-9-]*\b|\b(?:function|filter|param|begin|process|end|if|elseif|else|foreach|for|while|do|switch|try|catch|finally|throw|return|break|continue|class|enum|using)\b|-(?:eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin|replace|split|join|is|isnot|as|and|or|xor|not)\b|&&|\|\||[|;&<>])/gi

export const cmdTokenPattern = /(\x22(?:[^\x22]|\x22\x22)*\x22|(?:^|\s)(?:rem\b.*|::.*)$|%(?:[A-Za-z_][\w]*|[0-9*])%|![A-Za-z_][\w]*!|\b(?:echo|set|setlocal|endlocal|if|else|for|in|do|call|goto|shift|exit|start|title|color|copy|move|del|erase|type|dir|mkdir|md|rmdir|rd|pushd|popd|tasklist|taskkill|where|find|findstr)\b|&&|\|\||>>|[|&<>])/gi

export function highlightShellLine(line: string, language: ShellScriptLanguage) {
  const tokenPattern = language === 'powershell'
    ? powershellTokenPattern
    : language === 'cmd'
      ? cmdTokenPattern
      : bashTokenPattern
  tokenPattern.lastIndex = 0
  let cursor = 0
  let html = ''
  let match: RegExpExecArray | null
  while ((match = tokenPattern.exec(line)) !== null) {
    html += escapeHtml(line.slice(cursor, match.index))
    html += wrapShellToken(match[0])
    cursor = tokenPattern.lastIndex
  }
  html += escapeHtml(line.slice(cursor))
  return html
}

export function wrapShellToken(token: string) {
  const escaped = escapeHtml(token)
  if (/^\s*(?:rem\b|::)/i.test(token)) return "<span class='shell-token comment'>" + escaped + '</span>'
  if (/^%[^%]+%$/.test(token) || /^![^!]+!$/.test(token)) return "<span class='shell-token variable'>" + escaped + '</span>'
  if (/^-(?:eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin|replace|split|join|is|isnot|as|and|or|xor|not)$/i.test(token)) return "<span class='shell-token operator'>" + escaped + '</span>'
  if (token.startsWith('#')) return `<span class="shell-token comment">${escaped}</span>`
  if (token.startsWith('"') || token.startsWith("'")) return `<span class="shell-token string">${escaped}</span>`
  if (token.startsWith('$')) return `<span class="shell-token variable">${escaped}</span>`
  if (/^(?:&&|\|\||[|;&<>])$/.test(token)) return `<span class="shell-token operator">${escaped}</span>`
  return `<span class="shell-token command">${escaped}</span>`
}

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
