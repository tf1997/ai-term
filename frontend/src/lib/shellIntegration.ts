import type { Terminal } from '@xterm/xterm'

// Shell integration 语义标记(OSC 133 / 633)解析与状态机。
// 设计与分层策略见 docs/shell-integration-development.md。
// 解析核心不直接依赖 xterm,通过 ShellIntegrationHost 读取屏幕缓冲,便于单测。

export type ShellIntegrationState = 'idle' | 'prompt' | 'input' | 'executing'

export interface ShellCommandResult {
  command: string
  exitCode?: number
  startedAt: number
  finishedAt: number
}

export interface ShellIntegrationEvents {
  onInputStart?: () => void
  onCommandStart?: (command: string) => void
  onCommandFinished?: (result: ShellCommandResult) => void
}

export interface ShellIntegrationMarker {
  readonly line: number
  readonly isDisposed: boolean
  dispose(): void
}

export interface ShellIntegrationHost {
  /** 在光标所在行注册一个随滚动/reflow 跟踪的标记;缓冲不可用时返回 undefined。 */
  registerMarker(): ShellIntegrationMarker | undefined
  /** 光标所在的缓冲绝对行号。 */
  cursorRow(): number
  /** 光标列号。 */
  cursorColumn(): number
  /** 指定行的右侧去空白文本;endColumn 限定只读取到该列。 */
  rowText(row: number, endColumn?: number): string
  /** 指定行是否是上一行的折行延续。 */
  rowIsWrapped(row: number): boolean
  rowCount(): number
  now(): number
}

function decodeBase64Utf8(payload: string): string | undefined {
  try {
    const binary = atob(payload)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

// VS Code 633;E 的转义规则:\\ 与 \xAB 十六进制。
function unescapeVsCodePayload(payload: string) {
  return payload.replace(/\\(\\|x([0-9a-fA-F]{2}))/g, (_match, kind: string, hex?: string) => {
    if (kind === '\\') return '\\'
    return String.fromCharCode(parseInt(hex ?? '', 16))
  })
}

export function decodeCommandLinePayload(fields: string[]): string {
  const [payload = '', flag = ''] = fields
  if (flag === 'base64') return decodeBase64Utf8(payload) ?? ''
  return unescapeVsCodePayload(payload)
}

export class ShellIntegrationTracker {
  state: ShellIntegrationState = 'idle'
  sawMarkers = false
  cwd = ''

  private host: ShellIntegrationHost
  private events: ShellIntegrationEvents
  private inputMarker: ShellIntegrationMarker | undefined
  private inputStartColumn = 0
  private pendingCommandText = ''
  private executingCommand = ''
  private commandStartedAt = 0
  private commandSeen = false

  constructor(host: ShellIntegrationHost, events: ShellIntegrationEvents = {}) {
    this.host = host
    this.events = events
  }

  /** OSC 133;<payload>。返回 true 表示已消费。 */
  handleOsc133(data: string): boolean {
    const [kind, ...rest] = data.split(';')
    this.sawMarkers = true
    switch (kind) {
      case 'A':
        this.clearInputAnchor()
        this.pendingCommandText = ''
        this.state = 'prompt'
        return true
      case 'B':
        this.anchorInput()
        this.state = 'input'
        this.events.onInputStart?.()
        return true
      case 'C': {
        this.executingCommand = this.pendingCommandText || this.capturedInputLine()
        this.pendingCommandText = ''
        this.commandStartedAt = this.host.now()
        this.commandSeen = true
        this.state = 'executing'
        this.clearInputAnchor()
        this.events.onCommandStart?.(this.executingCommand)
        return true
      }
      case 'D': {
        // 空回车(zsh 不触发 preexec)只有 D 没有 C,不产出命令
        if (this.commandSeen) {
          this.commandSeen = false
          const exitCodeRaw = rest[0]
          const exitCode = exitCodeRaw !== undefined && exitCodeRaw !== '' && /^-?\d+$/.test(exitCodeRaw)
            ? Number.parseInt(exitCodeRaw, 10)
            : undefined
          const command = this.executingCommand.trim()
          this.executingCommand = ''
          if (command) {
            this.events.onCommandFinished?.({
              command,
              exitCode,
              startedAt: this.commandStartedAt,
              finishedAt: this.host.now()
            })
          }
        }
        this.state = 'prompt'
        return true
      }
      default:
        return true
    }
  }

  /** OSC 633;<payload>。仅消费 E(命令文本),其余留给默认处理。 */
  handleOsc633(data: string): boolean {
    const [kind, ...fields] = data.split(';')
    if (kind !== 'E') return false
    this.sawMarkers = true
    this.pendingCommandText = decodeCommandLinePayload(fields).trim()
    return true
  }

  /** OSC 7;file://host/path — cwd 上报。始终不消费,避免影响其他消费者。 */
  handleOsc7(data: string): boolean {
    const match = /^file:\/\/[^/]*(\/.*)$/.exec(data)
    if (match?.[1]) {
      try {
        this.cwd = decodeURI(match[1])
      } catch {
        this.cwd = match[1]
      }
    }
    return false
  }

  /** OSC 1337;CurrentDir=path。不消费。 */
  handleOsc1337(data: string): boolean {
    if (data.startsWith('CurrentDir=')) this.cwd = data.slice('CurrentDir='.length)
    return false
  }

  /** input 态下,B 标记到光标之间的文本(不含右侧提示符)。 */
  commandLine(): string {
    const anchor = this.inputAnchor()
    if (!anchor) return ''
    const cursorRow = this.host.cursorRow()
    if (cursorRow < anchor.line) return ''
    let text = ''
    for (let row = anchor.line; row < cursorRow; row += 1) {
      text += this.host.rowText(row)
    }
    text += this.host.rowText(cursorRow, this.host.cursorColumn())
    return text.slice(this.inputStartColumn)
  }

  /**
   * 光标是否位于输入末尾。允许光标后出现两个以上空格再接文本(zsh RPROMPT),
   * 只有紧跟光标的真实文本才视为"光标在行中"。
   */
  cursorAtInputEnd(): boolean {
    const anchor = this.inputAnchor()
    if (!anchor) return false
    const cursorRow = this.host.cursorRow()
    let lastRow = cursorRow
    while (lastRow + 1 < this.host.rowCount() && this.host.rowIsWrapped(lastRow + 1)) lastRow += 1
    if (cursorRow !== lastRow) return false
    const after = this.host.rowText(cursorRow).slice(this.host.cursorColumn())
    return after === '' || /^\s{2,}/.test(after)
  }

  /** C 时刻的整行输入捕获(无 633;E 时的兜底)。 */
  private capturedInputLine(): string {
    const anchor = this.inputAnchor()
    if (!anchor) return ''
    let text = this.host.rowText(anchor.line)
    for (let row = anchor.line + 1; row < this.host.rowCount() && this.host.rowIsWrapped(row); row += 1) {
      text += this.host.rowText(row)
    }
    return text.slice(this.inputStartColumn).trim()
  }

  reset() {
    this.clearInputAnchor()
    this.state = 'idle'
    this.sawMarkers = false
    this.cwd = ''
    this.pendingCommandText = ''
    this.executingCommand = ''
    this.commandSeen = false
  }

  dispose() {
    this.clearInputAnchor()
  }

  private anchorInput() {
    this.clearInputAnchor()
    this.inputMarker = this.host.registerMarker()
    this.inputStartColumn = this.host.cursorColumn()
  }

  private inputAnchor(): ShellIntegrationMarker | undefined {
    if (this.state !== 'input' && this.state !== 'executing') return undefined
    if (!this.inputMarker || this.inputMarker.isDisposed || this.inputMarker.line < 0) return undefined
    return this.inputMarker
  }

  private clearInputAnchor() {
    this.inputMarker?.dispose()
    this.inputMarker = undefined
    this.inputStartColumn = 0
  }
}

function xtermHost(terminal: Terminal): ShellIntegrationHost {
  return {
    registerMarker: () => terminal.registerMarker(0) ?? undefined,
    cursorRow: () => terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
    cursorColumn: () => terminal.buffer.active.cursorX,
    rowText: (row, endColumn) => {
      const line = terminal.buffer.active.getLine(row)
      if (!line) return ''
      return endColumn === undefined
        ? line.translateToString(true)
        : line.translateToString(true, 0, endColumn)
    },
    rowIsWrapped: (row) => terminal.buffer.active.getLine(row)?.isWrapped ?? false,
    rowCount: () => terminal.buffer.active.length,
    now: () => Date.now()
  }
}

export interface AttachedShellIntegration {
  tracker: ShellIntegrationTracker
  dispose(): void
}

export function attachShellIntegration(
  terminal: Terminal,
  events: ShellIntegrationEvents = {}
): AttachedShellIntegration {
  const tracker = new ShellIntegrationTracker(xtermHost(terminal), events)
  const disposables = [
    terminal.parser.registerOscHandler(133, (data) => tracker.handleOsc133(data)),
    terminal.parser.registerOscHandler(633, (data) => tracker.handleOsc633(data)),
    terminal.parser.registerOscHandler(7, (data) => tracker.handleOsc7(data)),
    terminal.parser.registerOscHandler(1337, (data) => tracker.handleOsc1337(data))
  ]
  return {
    tracker,
    dispose() {
      disposables.forEach((disposable) => disposable.dispose())
      tracker.dispose()
    }
  }
}
