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

/** armCommandCapture 布防后,命令结束(133;D)时产出的输出捕获结果。 */
export interface CommandCaptureResult {
  command: string
  exitCode?: number
  /** [133;C 行, 结束行) 区间的缓冲文本,已按 maxOutputChars 截断。 */
  output: string
  truncated: boolean
  /** 输出超过 scrollback 导致起始 marker 被回收,仅保留末尾。 */
  markerLost: boolean
  startedAt: number
  finishedAt: number
}

export interface ArmedCommandCapture {
  /** 当前已捕获的输出(截断规则同最终结果),用于超时时上报部分输出。 */
  peekOutput(): string
  /** 解除布防;不影响命令本身,也不触发 onFinished。 */
  dispose(): void
}

/** 输出截断:保留头部与尾部(报错通常在尾部),中间插入省略说明。 */
const CAPTURE_HEAD_CHARS = 500

export function truncateCaptureOutput(output: string, maxChars: number): { output: string; truncated: boolean } {
  if (output.length <= maxChars) return { output, truncated: false }
  const head = Math.min(CAPTURE_HEAD_CHARS, Math.floor(maxChars / 2))
  const tail = maxChars - head
  const omitted = output.length - head - tail
  return {
    output: `${output.slice(0, head)}\n[AI Term 已截断命令输出:中间省略 ${omitted} 个字符]\n${output.slice(output.length - tail)}`,
    truncated: true
  }
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
  private capture:
    | {
        maxOutputChars: number
        onFinished: (result: CommandCaptureResult) => void
        marker: ShellIntegrationMarker | undefined
        sawCommandStart: boolean
      }
    | undefined

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
        if (this.capture && !this.capture.sawCommandStart) {
          // C 时刻光标行即输出起始行(preexec 在回车换行之后触发)
          this.capture.sawCommandStart = true
          this.capture.marker = this.host.registerMarker()
        }
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
          const startedAt = this.commandStartedAt
          const finishedAt = this.host.now()
          this.executingCommand = ''
          this.finishCapture(command, exitCode, startedAt, finishedAt)
          if (command) {
            this.events.onCommandFinished?.({
              command,
              exitCode,
              startedAt,
              finishedAt
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

  /**
   * 一次性布防:捕获下一条命令(133;C → 133;D)的输出区间。
   * 仅 agent 派发的命令使用;重复布防会替换上一次。命令实际文本随结果返回,
   * 与派发命令是否一致由调用方判断(用户手动输入串扰防护)。
   */
  armCommandCapture(
    maxOutputChars: number,
    onFinished: (result: CommandCaptureResult) => void
  ): ArmedCommandCapture {
    this.disposeCapture()
    const capture = {
      maxOutputChars,
      onFinished,
      marker: undefined as ShellIntegrationMarker | undefined,
      sawCommandStart: false
    }
    this.capture = capture
    return {
      peekOutput: () => {
        if (this.capture !== capture || !capture.sawCommandStart) return ''
        return this.collectCaptureOutput(this.host.cursorRow() + 1, capture).output
      },
      dispose: () => {
        if (this.capture === capture) this.disposeCapture()
      }
    }
  }

  private finishCapture(
    command: string,
    exitCode: number | undefined,
    startedAt: number,
    finishedAt: number
  ) {
    const capture = this.capture
    if (!capture || !capture.sawCommandStart) return
    // 无尾随换行的输出会让光标停在最后一行中间,此时该行也属于输出
    const endRow = this.host.cursorColumn() > 0 ? this.host.cursorRow() + 1 : this.host.cursorRow()
    const collected = this.collectCaptureOutput(endRow, capture)
    this.disposeCapture()
    capture.onFinished({
      command,
      exitCode,
      output: collected.output,
      truncated: collected.truncated,
      markerLost: collected.markerLost,
      startedAt,
      finishedAt
    })
  }

  private collectCaptureOutput(
    endRowExclusive: number,
    capture: { maxOutputChars: number; marker: ShellIntegrationMarker | undefined }
  ): { output: string; truncated: boolean; markerLost: boolean } {
    const maxChars = capture.maxOutputChars
    const marker = capture.marker
    if (!marker || marker.isDisposed || marker.line < 0) {
      // 起始 marker 已被 scrollback 回收:从结束行向上回收尾部
      const lines: string[] = []
      let chars = 0
      for (let row = endRowExclusive - 1; row >= 0 && chars <= maxChars; row -= 1) {
        const text = this.host.rowText(row)
        lines.unshift(text)
        chars += text.length + 1
      }
      const joined = lines.join('\n').trimEnd()
      const tail = joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined
      return {
        output: tail ? `[输出过长,起始位置已超出缓冲,仅保留末尾]\n${tail}` : '',
        truncated: true,
        markerLost: true
      }
    }
    const lines: string[] = []
    for (let row = marker.line; row < endRowExclusive; row += 1) {
      const text = this.host.rowText(row)
      if (row > marker.line && this.host.rowIsWrapped(row) && lines.length > 0) {
        lines[lines.length - 1] += text
      } else {
        lines.push(text)
      }
    }
    const collected = truncateCaptureOutput(lines.join('\n').trimEnd(), maxChars)
    return { output: collected.output, truncated: collected.truncated, markerLost: false }
  }

  private disposeCapture() {
    this.capture?.marker?.dispose()
    this.capture = undefined
  }

  reset() {
    this.clearInputAnchor()
    this.disposeCapture()
    this.state = 'idle'
    this.sawMarkers = false
    this.cwd = ''
    this.pendingCommandText = ''
    this.executingCommand = ''
    this.commandSeen = false
  }

  dispose() {
    this.clearInputAnchor()
    this.disposeCapture()
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
