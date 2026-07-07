export type MessagePart =
  | { type: 'text'; content: string }
  | { type: 'code'; content: string; language: string }

export function parseMessageParts(text: string): MessagePart[] {
  const parts: MessagePart[] = []
  const pattern = /(^|\n)[ \t]*(```+|~~~+)[ \t]*([^\r\n]*)\r?\n([\s\S]*?)(?:\r?\n[ \t]*\2[ \t]*(?=\r?\n|$))/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    const fenceStart = match.index + match[1].length
    if (fenceStart > lastIndex) {
      parts.push({ type: 'text', content: text.slice(lastIndex, fenceStart) })
    }
    parts.push({
      type: 'code',
      language: normalizeCodeFenceInfo(match[3]),
      content: match[4].trim()
    })
    lastIndex = pattern.lastIndex
  }

  if (lastIndex < text.length) {
    parts.push({ type: 'text', content: text.slice(lastIndex) })
  }

  return parts.length ? parts : [{ type: 'text', content: text }]
}

function normalizeCodeFenceInfo(info: string) {
  return info
    .trim()
    .replace(/^language-/i, '')
    .replace(/^\{?\.?/, '')
    .split(/[\s,{[]+/)[0]
    .replace(/[}:]+$/g, '')
}
export function renderMarkdown(content: string) {
  const normalized = content.replace(/\r\n/g, '\n').trim()
  if (!normalized) return ''
  const html: string[] = []
  let paragraph: string[] = []
  let listType: 'ul' | 'ol' | '' = ''
  let listItems: string[] = []

  const flushParagraph = () => {
    if (!paragraph.length) return
    html.push(`<p>${renderInlineMarkdown(paragraph.join(' '))}</p>`)
    paragraph = []
  }
  const flushList = () => {
    if (!listType) return
    html.push(`<${listType}>${listItems.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</${listType}>`)
    listType = ''
    listItems = []
  }
  const pushListItem = (type: 'ul' | 'ol', item: string) => {
    flushParagraph()
    if (listType && listType !== type) flushList()
    listType = type
    listItems.push(item)
  }

  const lines = normalized.split('\n')
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const fence = parseMarkdownCodeFence(lines, lineIndex)
    if (fence) {
      flushParagraph()
      flushList()
      html.push(fence.html)
      lineIndex = fence.nextIndex - 1
      continue
    }

    const table = parseMarkdownTable(lines, lineIndex)
    if (table) {
      flushParagraph()
      flushList()
      html.push(table.html)
      lineIndex = table.nextIndex - 1
      continue
    }
    const line = lines[lineIndex]
    const trimmed = line.trim()
    if (!trimmed) {
      flushParagraph()
      flushList()
      continue
    }
    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/)
    if (heading) {
      flushParagraph()
      flushList()
      const level = heading[1].length
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`)
      continue
    }
    const unordered = trimmed.match(/^[-*+]\s+(.+)$/)
    if (unordered) {
      pushListItem('ul', unordered[1])
      continue
    }
    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/)
    if (ordered) {
      pushListItem('ol', ordered[1])
      continue
    }
    const quote = trimmed.match(/^>\s?(.*)$/)
    if (quote) {
      flushParagraph()
      flushList()
      html.push(`<blockquote>${renderInlineMarkdown(quote[1])}</blockquote>`)
      continue
    }
    if (/^---+$/.test(trimmed)) {
      flushParagraph()
      flushList()
      html.push('<hr>')
      continue
    }
    flushList()
    paragraph.push(trimmed)
  }

  flushParagraph()
  flushList()
  return html.join('')
}

function parseMarkdownCodeFence(lines: string[], startIndex: number) {
  const line = lines[startIndex]?.trim()
  if (!line) return null

  const inlineFence = parseInlineCodeFence(line)
  if (inlineFence) {
    return {
      html: renderMarkdownCodeBlock(inlineFence.language, inlineFence.code),
      nextIndex: startIndex + 1
    }
  }

  const opener = line.match(/^(```+|~~~+)\s*([^`~]*)$/)
  if (!opener) return null

  const fence = opener[1]
  const language = normalizeCodeFenceInfo(opener[2] ?? '')
  const codeLines: string[] = []
  let lineIndex = startIndex + 1
  while (lineIndex < lines.length) {
    const current = lines[lineIndex]
    if (new RegExp(`^\\s*${escapeRegExp(fence)}\\s*$`).test(current)) {
      return {
        html: renderMarkdownCodeBlock(language, codeLines.join('\n')),
        nextIndex: lineIndex + 1
      }
    }
    codeLines.push(current)
    lineIndex += 1
  }

  return {
    html: renderMarkdownCodeBlock(language, codeLines.join('\n')),
    nextIndex: lines.length
  }
}

function parseInlineCodeFence(line: string) {
  const match = line.match(/^(```+|~~~+)\s*([\s\S]*?)\s*\1$/)
  if (!match) return null
  const info = match[2].trim()
  if (!info) return { language: '', code: '' }
  const tokenMatch = info.match(/^([^\s]+)\s+([\s\S]+)$/)
  if (!tokenMatch) return { language: '', code: info }
  const language = normalizeCodeFenceInfo(tokenMatch[1])
  if (!isKnownFenceLanguage(language)) return { language: '', code: info }
  return { language, code: tokenMatch[2].trim() }
}

function renderMarkdownCodeBlock(language: string, code: string) {
  const label = normalizeCodeFenceInfo(language) || 'text'
  return `<div class="code-block markdown-code-block"><div class="code-head"><span>${escapeHtml(label)}</span></div><pre><code>${escapeHtml(code.trim())}</code></pre></div>`
}

function isKnownFenceLanguage(language: string) {
  return knownFenceLanguages.has(language)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const knownFenceLanguages = new Set([
  'bash',
  'sh',
  'shell',
  'zsh',
  'fish',
  'bat',
  'batch',
  'cmd',
  'powershell',
  'pwsh',
  'ps1',
  'console',
  'terminal',
  'text',
  'plain',
  'plaintext',
  'json',
  'yaml',
  'yml',
  'toml',
  'ini',
  'sql',
  'js',
  'ts',
  'javascript',
  'typescript',
  'html',
  'css',
  'xml',
  'rust',
  'go',
  'python',
  'py'
])
function parseMarkdownTable(lines: string[], startIndex: number) {
  const headerLine = lines[startIndex]?.trim()
  const separatorLine = lines[startIndex + 1]?.trim()
  if (!headerLine || !separatorLine) return null

  const headerCells = splitMarkdownTableRow(headerLine)
  const separatorCells = splitMarkdownTableRow(separatorLine)
  if (headerCells.length < 2 || separatorCells.length !== headerCells.length) return null
  if (!separatorCells.every(isMarkdownTableSeparatorCell)) return null

  const alignments = separatorCells.map(markdownTableAlignment)
  const bodyRows: string[][] = []
  let lineIndex = startIndex + 2
  while (lineIndex < lines.length) {
    const rowLine = lines[lineIndex].trim()
    if (!rowLine || !rowLine.includes('|')) break
    const cells = splitMarkdownTableRow(rowLine)
    if (cells.length < 2) break
    bodyRows.push(headerCells.map((_cell, index) => cells[index] ?? ''))
    lineIndex += 1
  }

  const headerHtml = headerCells
    .map((cell, index) => `<th${markdownTableCellAttrs(alignments[index])}>${renderInlineMarkdown(cell)}</th>`)
    .join('')
  const bodyHtml = bodyRows
    .map((row) => `<tr>${row.map((cell, index) => `<td${markdownTableCellAttrs(alignments[index])}>${renderInlineMarkdown(cell)}</td>`).join('')}</tr>`)
    .join('')

  return {
    html: `<div class="markdown-table-wrap"><table class="markdown-table"><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`,
    nextIndex: lineIndex
  }
}

function splitMarkdownTableRow(line: string) {
  const trimmed = line.trim()
  const content = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed
  const withoutTrailingPipe = content.endsWith('|') ? content.slice(0, -1) : content
  const cells: string[] = []
  let current = ''
  let escaped = false
  for (const char of withoutTrailingPipe) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\') {
      current += char
      escaped = true
      continue
    }
    if (char === '|') {
      cells.push(current.trim().replace(/\\\|/g, '|'))
      current = ''
      continue
    }
    current += char
  }
  cells.push(current.trim().replace(/\\\|/g, '|'))
  return cells
}

function isMarkdownTableSeparatorCell(cell: string) {
  return /^:?-{3,}:?$/.test(cell.trim())
}

function markdownTableAlignment(cell: string) {
  const trimmed = cell.trim()
  if (trimmed.startsWith(':') && trimmed.endsWith(':')) return 'center'
  if (trimmed.endsWith(':')) return 'right'
  return ''
}

function markdownTableCellAttrs(alignment: string) {
  return alignment ? ` class="align-${alignment}"` : ''
}

function renderInlineMarkdown(value: string) {
  let html = escapeHtml(value)
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_match, label: string, url: string) => {
    const safeUrl = safeMarkdownUrl(url)
    if (!safeUrl) return label
    return `<a href="${escapeAttribute(safeUrl)}" target="_blank" rel="noreferrer">${label}</a>`
  })
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  return html
}

function safeMarkdownUrl(url: string) {
  const trimmed = url.trim()
  if (/^(https?:|mailto:|#|\/)/i.test(trimmed)) return trimmed
  return ''
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }
    return entities[char] ?? char
  })
}

function escapeAttribute(value: string) {
  return escapeHtml(value)
}