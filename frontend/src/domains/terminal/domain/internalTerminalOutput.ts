export interface InternalTerminalOutputOptions {
  /** Initial setting; a live debug getter can override it for subsequent output. */
  debug: boolean
  /** Actual PTY input when a legacy operation is wrapped after registration. */
  echo?: string
  timeoutMs?: number
  /** Replace the old idle prompt when the hidden command's next prompt arrives. */
  restorePrefix?: string
}

export interface InternalTerminalOutputFilter {
  begin(command: string, options: InternalTerminalOutputOptions): string | undefined
  push(chunk: string): string
  finish(commandOrToken: string): void
  resume(): void
  reset(): void
  active(): boolean
}

type Markers = { token: string; end: string; kind: 'IDENT' | 'FILE' | 'PROBE' }
type Operation = Markers & {
  echo: string
  deadline: number
  restorePrefix: string
  began: boolean
  hidden: boolean
  late: boolean
}
type RetiredOperation = Markers & { echo: string; deadline: number; hideBody: boolean; restorePrefix: string }

const RESTORE_PROMPT = '\r\x1b[2K'
const LATE_OUTPUT_GRACE_MS = 2_000
// A timed-out capability probe may still be queued/running on a remote shell.
// Keep its unique echo/frame recognizable longer than ordinary completed captures.
const PROBE_LATE_OUTPUT_GRACE_MS = 60_000
const MAX_TIMEOUT_MS = 65_000
const MAX_RETIRED_OPERATIONS = 8
const MAX_MARKER_LINE_CHARS = 512
const MAX_LOOKAHEAD_CHARS = 2_048
const MAX_ECHO_CHARS = 16_384

function markersFor(commandOrToken: string): Markers | undefined {
  const match = /AI_TERM_(IDENT|FILE|PROBE)_BEGIN_([A-Za-z0-9_]{1,160})(?![A-Za-z0-9_])/.exec(commandOrToken)
  if (!match) return undefined
  return {
    token: match[0],
    end: `AI_TERM_${match[1]}_END_${match[2]}`,
    kind: match[1] as Markers['kind'],
  }
}

/** Only marker comparison is normalized. Bytes returned to the terminal stay untouched. */
function createControlSequenceReader() {
  let state: 'text' | 'escape' | 'intermediate' | 'csi' | 'osc' | 'string' | 'osc-escape' | 'string-escape' = 'text'
  return {
    reset() { state = 'text' },
    read(character: string): string {
      if (state === 'text') {
        if (character === '\x1b') state = 'escape'
        else if (character === '\x9b') state = 'csi'
        else if (character === '\x9d') state = 'osc'
        else if (character === '\x90' || character === '\x9e' || character === '\x9f') state = 'string'
        else return character === '\r' ? '' : character
      } else if (state === 'escape' || state === 'intermediate') {
        if (state === 'escape' && character === '[') state = 'csi'
        else if (state === 'escape' && character === ']') state = 'osc'
        else if (state === 'escape' && /[P^_]/.test(character)) state = 'string'
        else if (character >= ' ' && character <= '/') state = 'intermediate'
        else state = 'text'
      } else if (state === 'csi') {
        if (character >= '@' && character <= '~') state = 'text'
      } else if (state === 'osc' || state === 'string') {
        if (character === '\x9c' || (state === 'osc' && character === '\x07')) state = 'text'
        else if (character === '\x1b') state = state === 'osc' ? 'osc-escape' : 'string-escape'
      } else if (character === '\\' || character === '\x9c' || (state === 'osc-escape' && character === '\x07')) {
        state = 'text'
      } else if (character !== '\x1b') {
        state = state === 'osc-escape' ? 'osc' : 'string'
      }
      return ''
    },
  }
}

/**
 * Hides only commands registered through the application's reserved internal input path.
 * Feed protocol consumers the original chunk before using push() for terminal presentation.
 *
 * While a command owns the idle shell, its echo and framed response share one hidden span.
 * Unrelated asynchronous output interleaved in that span cannot be distinguished by a PTY.
 * Call finish() when the operation settles, resume() for user input, and reset() on reconnect.
 * Deadlines and fixed lookahead bounds guarantee a missing marker cannot hide output forever.
 */
export function createInternalTerminalOutputFilter(
  { now = Date.now, debug }: { now?: () => number; debug?: () => boolean } = {},
): InternalTerminalOutputFilter {
  let initialDebug = false
  const debugEnabled = () => debug?.() ?? initialDebug
  let operation: Operation | undefined
  let retired: RetiredOperation[] = []
  let line = ''
  let echoCarriageReturn = false
  let longLine = false
  let lookahead = ''
  let ordinaryLine = false
  let restore = ''
  let restoreAfterEnd = false
  let deferredVisible = ''
  let closingLineDeadline = 0
  let closingLookahead = ''
  const controls = createControlSequenceReader()

  function resetLine() {
    line = ''
    echoCarriageReturn = false
    longLine = false
    lookahead = ''
    ordinaryLine = false
  }

  function retire(current: Operation, at: number, { complete = false, preserveControls = false } = {}) {
    // The original idle prompt can be replaced only once. A late response may arrive
    // after visible output has moved the cursor, so it must never replay that movement.
    if (current.hidden && !current.late && !debugEnabled()) {
      restore = current.restorePrefix
      restoreAfterEnd = complete
    }
    // A replay of a late frame never extends the original grace period.
    const lateOutputGrace = current.kind === 'PROBE' ? PROBE_LATE_OUTPUT_GRACE_MS : LATE_OUTPUT_GRACE_MS
    const deadline = current.late ? current.deadline : Math.min(at, current.deadline) + lateOutputGrace
    retired = retired.filter(item => item.token !== current.token && item.deadline > at)
    if (deadline > at) {
      retired.push({ token: current.token, end: current.end, kind: current.kind, echo: current.echo, deadline, hideBody: true,
        restorePrefix: !current.hidden && !current.late && !debugEnabled() ? current.restorePrefix : '' })
      retired = retired.slice(-MAX_RETIRED_OPERATIONS)
    }
    operation = undefined
    resetLine()
    if (!preserveControls) controls.reset()
  }

  function expire(at: number) {
    if (operation && operation.deadline <= at) retire(operation, at)
    retired = retired.filter(item => item.deadline > at)
    if (closingLineDeadline && closingLineDeadline <= at) {
      deferredVisible += closingLookahead
      closingLookahead = ''
      closingLineDeadline = 0
      resetLine()
      controls.reset()
    }
    if (!operation && !retired.length && lookahead) {
      deferredVisible += lookahead
      resetLine()
      controls.reset()
    }
  }

  function reset() {
    initialDebug = false
    operation = undefined
    retired = []
    restore = ''
    restoreAfterEnd = false
    deferredVisible = ''
    closingLineDeadline = 0
    closingLookahead = ''
    resetLine()
    controls.reset()
  }

  return {
    begin(command, options) {
      const markers = markersFor(command)
      if (!markers || !new RegExp(`${markers.end}(?![A-Za-z0-9_])`).test(command)) return undefined
      if (options.debug) {
        reset()
      }
      initialDebug = options.debug
      const at = now()
      expire(at)
      if (operation) retire(operation, at)
      // A potential late marker might prove to be ordinary text. Do not lose it on begin().
      deferredVisible += lookahead
      closingLineDeadline = 0
      closingLookahead = ''
      resetLine()
      controls.reset()
      const defaultTimeout = markers.kind === 'PROBE' ? 8_000 : markers.kind === 'IDENT' ? 12_000 : 60_000
      const timeout = options.timeoutMs === undefined || !Number.isFinite(options.timeoutMs)
        ? defaultTimeout
        : Math.max(1, Math.min(options.timeoutMs, MAX_TIMEOUT_MS))
      const echoControls = createControlSequenceReader()
      let echo = ''
      for (const character of options.echo ?? command) {
        echo += echoControls.read(character)
        if (echo.length > MAX_ECHO_CHARS) { echo = ''; break }
      }
      operation = {
        ...markers,
        echo: echo.trim(),
        deadline: at + timeout,
        restorePrefix: options.restorePrefix ?? RESTORE_PROMPT,
        began: false,
        hidden: false,
        late: false,
      }
      return markers.token
    },
    push(chunk) {
      const showDebug = debugEnabled()
      if (showDebug) {
        restore = ''; restoreAfterEnd = false
        retired.forEach(item => { item.restorePrefix = '' })
      }
      const at = now()
      expire(at)
      const visible: string[] = []
      function emit(value: string) {
        if (!value) return
        // Any visible output invalidates a retired operation's old cursor position.
        retired.forEach(item => { item.restorePrefix = '' })
        if (restore) { visible.push(restore); restore = ''; restoreAfterEnd = false }
        visible.push(value)
      }
      emit(deferredVisible)
      deferredVisible = ''
      if (!operation && !retired.length && !closingLineDeadline) {
        emit(chunk)
        return showDebug ? chunk : visible.join('')
      }

      for (const character of chunk) {
        const text = controls.read(character)
        if (closingLineDeadline) {
          // A protocol consumer may resolve on END at a chunk boundary, before its CRLF.
          // finish() still owns that delimiter, but must pass through any new printable text.
          closingLookahead += character
          if (text === '\n') {
            closingLineDeadline = 0
            closingLookahead = ''
            resetLine()
          } else if ((text && !/^[\t ]$/.test(text)) || closingLookahead.length > MAX_LOOKAHEAD_CHARS) {
            emit(closingLookahead)
            closingLookahead = ''
            closingLineDeadline = 0
            resetLine()
            ordinaryLine = true
          }
          continue
        }
        if (operation) {
          if (showDebug) {
            // Once any diagnostic text was visible, never move back to the old
            // prompt and erase it if the setting changes before the next chunk.
            operation.restorePrefix = '\r\n'
          } else operation.hidden = true
          if (text === '\n') {
            const marker = longLine ? '' : line.trimEnd()
            if (marker === operation.token) operation.began = true
            else if (operation.began && marker === operation.end) retire(operation, at, { complete: true })
            resetLine()
          } else if (text && !longLine) {
            line += text
            if (line.length > MAX_MARKER_LINE_CHARS) { line = ''; longLine = true }
          }
          continue
        }

        // Cancellation may precede the PTY echo. Match the registered input too;
        // otherwise its wrapper leaks even though the subsequent frame is hidden.
        if (ordinaryLine) {
          emit(character)
          if (text === '\n') resetLine()
          continue
        }
        lookahead += character
        // Readline pads the last cell before wrapping with " \r". Wait for the
        // following printable character so actual spaces before CRLF survive.
        if (echoCarriageReturn && text) {
          if (text !== '\n' && line.endsWith(' ')) line = line.slice(0, -1)
          echoCarriageReturn = false
        }
        if (character === '\r' && line.endsWith(' ')) echoCarriageReturn = true
        if (text === '\n') {
          const marker = line.trimEnd()
          const match = retired.find(item => item.token === marker || item.end === marker)
          const echoMatch = retired.find(item => item.echo && item.echo === line.trim())
          if (match) {
            if (match.token === marker && match.hideBody) {
              operation = { ...match, restorePrefix: '', began: true, hidden: true, late: true }
            }
          } else if (echoMatch) {
            // Suppress only a complete known echo, never a similar user command.
            if (echoMatch.restorePrefix) { restore = echoMatch.restorePrefix; echoMatch.restorePrefix = '' }
          } else if (line.trim() && retired.some(item => item.echo.startsWith(line.trimStart() + '\n'))) {
            line += '\n'
            continue
          } else emit(lookahead)
          resetLine()
          continue
        }
        if (text) line += text
        const possible = retired.some(item => [item.token, item.end].some(marker =>
          marker.startsWith(line) || (line.startsWith(marker) && /^[\t ]*$/.test(line.slice(marker.length))),
        ))
        const echoCandidate = line.trimStart()
        const possibleEcho = retired.some(item => item.echo && (item.echo.startsWith(echoCandidate)
          || (echoCandidate.endsWith(' ') && item.echo.startsWith(echoCandidate.slice(0, -1)))
          || (echoCandidate.startsWith(item.echo) && !echoCandidate.slice(item.echo.length).trim())))
        if ((!possible && !possibleEcho) || lookahead.length > (possibleEcho ? MAX_ECHO_CHARS : MAX_LOOKAHEAD_CHARS)) {
          emit(lookahead)
          resetLine()
          ordinaryLine = true
        }
      }
      if (showDebug) {
        // These bytes have already been shown. Keep comparison state, but never
        // replay a buffered prefix if debug is disabled between two chunks.
        lookahead = ''; closingLookahead = ''
        return chunk
      }
      return visible.join('')
    },
    finish(commandOrToken) {
      const at = now()
      expire(at)
      const markers = markersFor(commandOrToken)
      if (operation && markers?.token === operation.token) {
        const awaitingLineBreak = operation.began && !longLine && line.trimEnd() === operation.end
        retire(operation, at, { complete: awaitingLineBreak, preserveControls: awaitingLineBreak })
        if (awaitingLineBreak) closingLineDeadline = at + LATE_OUTPUT_GRACE_MS
      }
    },
    resume() {
      const at = now()
      expire(at)
      if (operation) {
        const awaitingLineBreak = operation.began && !longLine && line.trimEnd() === operation.end
        retire(operation, at, { complete: awaitingLineBreak, preserveControls: awaitingLineBreak })
        if (awaitingLineBreak) closingLineDeadline = at + LATE_OUTPUT_GRACE_MS
      }
      // User input owns the PTY now. Known late marker lines can still be omitted,
      // but their bodies may contain user output and must not start a hidden span.
      retired.forEach(item => { item.hideBody = false; item.echo = ''; item.restorePrefix = '' })
      // A completed response still owes its next prompt one replacement. Cancellation
      // leaves the old prompt on screen, so user echo must continue there without erasing it.
      if (!restoreAfterEnd) restore = ''
      deferredVisible += lookahead
      resetLine()
      ordinaryLine = true
      // Keep a control sequence belonging to the flushed visible prefix intact.
    },
    reset,
    active() {
      expire(now())
      return Boolean(operation) && !debugEnabled()
    },
  }
}
