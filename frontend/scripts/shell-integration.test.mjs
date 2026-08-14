import assert from 'node:assert/strict'
import test from 'node:test'

import { ShellIntegrationTracker, decodeCommandLinePayload } from '../src/lib/shellIntegration.ts'

function makeHost() {
  const state = {
    rows: [''],
    wrapped: [],
    cursorRow: 0,
    cursorCol: 0,
    now: 1000
  }
  const host = {
    registerMarker: () => ({ line: state.cursorRow, isDisposed: false, dispose() {} }),
    cursorRow: () => state.cursorRow,
    cursorColumn: () => state.cursorCol,
    rowText: (row, endColumn) => {
      const text = state.rows[row] ?? ''
      const sliced = endColumn === undefined ? text : text.slice(0, endColumn)
      return sliced.replace(/\s+$/, '')
    },
    rowIsWrapped: (row) => Boolean(state.wrapped[row]),
    rowCount: () => state.rows.length,
    now: () => state.now
  }
  return { host, state }
}

function base64(text) {
  return Buffer.from(text, 'utf-8').toString('base64')
}

test('happy path: A/B/E/C/D produces command with exit code', () => {
  const { host, state } = makeHost()
  const finished = []
  const started = []
  const tracker = new ShellIntegrationTracker(host, {
    onCommandStart: (command) => started.push(command),
    onCommandFinished: (result) => finished.push(result)
  })

  state.rows[0] = '❯ '
  tracker.handleOsc133('A')
  assert.equal(tracker.state, 'prompt')
  state.cursorCol = 2
  tracker.handleOsc133('B')
  assert.equal(tracker.state, 'input')
  assert.equal(tracker.sawMarkers, true)

  state.rows[0] = '❯ git status'
  state.cursorCol = 12
  assert.equal(tracker.commandLine(), 'git status')

  tracker.handleOsc633(`E;${base64('git status')};base64`)
  tracker.handleOsc133('C')
  assert.equal(tracker.state, 'executing')
  assert.deepEqual(started, ['git status'])

  state.now = 2000
  tracker.handleOsc133('D;0')
  assert.equal(finished.length, 1)
  assert.equal(finished[0].command, 'git status')
  assert.equal(finished[0].exitCode, 0)
  assert.equal(finished[0].startedAt, 1000)
  assert.equal(finished[0].finishedAt, 2000)
})

test('empty enter (D without C) does not record a command', () => {
  const { host, state } = makeHost()
  const finished = []
  const tracker = new ShellIntegrationTracker(host, {
    onCommandFinished: (result) => finished.push(result)
  })
  state.rows[0] = '$ '
  tracker.handleOsc133('A')
  state.cursorCol = 2
  tracker.handleOsc133('B')
  tracker.handleOsc133('D;0')
  assert.equal(finished.length, 0)
  assert.equal(tracker.state, 'prompt')
})

test('C captures rendered input line when 633;E is absent', () => {
  const { host, state } = makeHost()
  const finished = []
  const tracker = new ShellIntegrationTracker(host, {
    onCommandFinished: (result) => finished.push(result)
  })
  state.rows[0] = '$ '
  tracker.handleOsc133('A')
  state.cursorCol = 2
  tracker.handleOsc133('B')
  state.rows[0] = '$ npm run dev'
  state.cursorCol = 13
  tracker.handleOsc133('C')
  tracker.handleOsc133('D;1')
  assert.equal(finished.length, 1)
  assert.equal(finished[0].command, 'npm run dev')
  assert.equal(finished[0].exitCode, 1)
})

test('non-numeric exit code becomes undefined', () => {
  const { host, state } = makeHost()
  const finished = []
  const tracker = new ShellIntegrationTracker(host, {
    onCommandFinished: (result) => finished.push(result)
  })
  tracker.handleOsc133('A')
  state.cursorCol = 0
  tracker.handleOsc133('B')
  state.rows[0] = 'ls'
  state.cursorCol = 2
  tracker.handleOsc133('C')
  tracker.handleOsc133('D;abc')
  assert.equal(finished.length, 1)
  assert.equal(finished[0].exitCode, undefined)
})

test('cursorAtInputEnd tolerates right-side prompt separated by spaces', () => {
  const { host, state } = makeHost()
  const tracker = new ShellIntegrationTracker(host, {})
  state.rows[0] = '❯ '
  tracker.handleOsc133('A')
  state.cursorCol = 2
  tracker.handleOsc133('B')

  state.rows[0] = '❯ git st'
  state.cursorCol = 8
  assert.equal(tracker.cursorAtInputEnd(), true)

  state.rows[0] = '❯ git st                    14:22'
  assert.equal(tracker.cursorAtInputEnd(), true, 'RPROMPT after 2+ spaces still counts as end')

  state.rows[0] = '❯ git st!x'
  assert.equal(tracker.cursorAtInputEnd(), false, 'real text right after cursor means mid-line')
})

test('commandLine reads only between marker and cursor (RPROMPT excluded)', () => {
  const { host, state } = makeHost()
  const tracker = new ShellIntegrationTracker(host, {})
  state.rows[0] = '❯ '
  tracker.handleOsc133('A')
  state.cursorCol = 2
  tracker.handleOsc133('B')
  state.rows[0] = '❯ git st                    14:22'
  state.cursorCol = 8
  assert.equal(tracker.commandLine(), 'git st')
})

test('wrapped command lines are concatenated for capture', () => {
  const { host, state } = makeHost()
  const finished = []
  const tracker = new ShellIntegrationTracker(host, {
    onCommandFinished: (result) => finished.push(result)
  })
  state.rows[0] = '$ '
  tracker.handleOsc133('A')
  state.cursorCol = 2
  tracker.handleOsc133('B')
  state.rows = ['$ echo aaaaaaaa', 'bbbb']
  state.wrapped = [false, true]
  state.cursorRow = 1
  state.cursorCol = 4
  assert.equal(tracker.commandLine(), 'echo aaaaaaaabbbb')
  tracker.handleOsc133('C')
  tracker.handleOsc133('D;0')
  assert.equal(finished[0].command, 'echo aaaaaaaabbbb')
})

test('reset clears markers-seen and state', () => {
  const { host, state } = makeHost()
  const tracker = new ShellIntegrationTracker(host, {})
  state.rows[0] = '$ '
  tracker.handleOsc133('A')
  tracker.handleOsc133('B')
  tracker.reset()
  assert.equal(tracker.sawMarkers, false)
  assert.equal(tracker.state, 'idle')
  assert.equal(tracker.commandLine(), '')
})

test('decodeCommandLinePayload handles base64 flag and VS Code escaping', () => {
  assert.equal(decodeCommandLinePayload([base64('git status'), 'base64']), 'git status')
  assert.equal(decodeCommandLinePayload(['echo \\x3bhi']), 'echo ;hi')
  assert.equal(decodeCommandLinePayload(['a\\\\b']), 'a\\b')
  assert.equal(decodeCommandLinePayload(['not base64!!', 'base64']), '', 'invalid base64 degrades to empty')
})

test('osc7 records cwd without consuming the sequence', () => {
  const { host } = makeHost()
  const tracker = new ShellIntegrationTracker(host, {})
  assert.equal(tracker.handleOsc7('file://my-host/Users/dev/project'), false)
  assert.equal(tracker.cwd, '/Users/dev/project')
})

// ---- armCommandCapture:命令输出捕获(agent 模式地基) ----

function makeCaptureHost() {
  const state = { rows: [''], wrapped: [], cursorRow: 0, cursorCol: 0, now: 1000 }
  const host = {
    registerMarker: () => ({
      line: state.cursorRow,
      isDisposed: false,
      dispose() {
        this.isDisposed = true
      }
    }),
    cursorRow: () => state.cursorRow,
    cursorColumn: () => state.cursorCol,
    rowText: (row, endColumn) => {
      const text = state.rows[row] ?? ''
      const sliced = endColumn === undefined ? text : text.slice(0, endColumn)
      return sliced.replace(/\s+$/, '')
    },
    rowIsWrapped: (row) => Boolean(state.wrapped[row]),
    rowCount: () => state.rows.length,
    now: () => state.now
  }
  return { host, state }
}

/** A/B/633;E 后把光标移到输出起始行再触发 C(真实 shell 的回车回显已换行)。 */
function beginCapturedCommand(tracker, state, command) {
  state.rows[0] = `$ ${command}`
  state.cursorRow = 0
  tracker.handleOsc133('A')
  state.cursorCol = 2
  tracker.handleOsc133('B')
  state.cursorCol = 2 + command.length
  tracker.handleOsc633(`E;${base64(command)};base64`)
  state.cursorRow = 1
  state.cursorCol = 0
  tracker.handleOsc133('C')
}

test('capture collects output rows between C and D', () => {
  const { host, state } = makeCaptureHost()
  const tracker = new ShellIntegrationTracker(host, {})
  const results = []
  tracker.armCommandCapture(4000, (result) => results.push(result))

  beginCapturedCommand(tracker, state, 'df -h')
  state.rows.push('Filesystem  Size  Used', '/dev/disk1  500G  200G')
  state.cursorRow = 3
  state.cursorCol = 0
  state.now = 2500
  tracker.handleOsc133('D;0')

  assert.equal(results.length, 1)
  assert.equal(results[0].command, 'df -h')
  assert.equal(results[0].exitCode, 0)
  assert.equal(results[0].output, 'Filesystem  Size  Used\n/dev/disk1  500G  200G')
  assert.equal(results[0].truncated, false)
  assert.equal(results[0].markerLost, false)
})

test('capture includes cursor row when output lacks trailing newline', () => {
  const { host, state } = makeCaptureHost()
  const tracker = new ShellIntegrationTracker(host, {})
  const results = []
  tracker.armCommandCapture(4000, (result) => results.push(result))

  beginCapturedCommand(tracker, state, 'printf no-newline')
  state.rows.push('no-newline')
  state.cursorRow = 1
  state.cursorCol = 10
  tracker.handleOsc133('D;0')

  assert.equal(results[0].output, 'no-newline')
})

test('capture yields empty output for silent command', () => {
  const { host, state } = makeCaptureHost()
  const tracker = new ShellIntegrationTracker(host, {})
  const results = []
  tracker.armCommandCapture(4000, (result) => results.push(result))

  beginCapturedCommand(tracker, state, 'true')
  tracker.handleOsc133('D;0')

  assert.equal(results[0].output, '')
  assert.equal(results[0].exitCode, 0)
})

test('capture joins wrapped output rows without newline', () => {
  const { host, state } = makeCaptureHost()
  const tracker = new ShellIntegrationTracker(host, {})
  const results = []
  tracker.armCommandCapture(4000, (result) => results.push(result))

  beginCapturedCommand(tracker, state, 'echo long')
  state.rows.push('aaaa', 'bbbb', 'next-line')
  state.wrapped = [false, false, true, false]
  state.cursorRow = 4
  state.cursorCol = 0
  tracker.handleOsc133('D;0')

  assert.equal(results[0].output, 'aaaabbbb\nnext-line')
})

test('capture truncates long output keeping head and tail', () => {
  const { host, state } = makeCaptureHost()
  const tracker = new ShellIntegrationTracker(host, {})
  const results = []
  tracker.armCommandCapture(120, (result) => results.push(result))

  beginCapturedCommand(tracker, state, 'cat big')
  state.rows.push('A'.repeat(90), 'B'.repeat(90))
  state.cursorRow = 3
  state.cursorCol = 0
  tracker.handleOsc133('D;0')

  assert.equal(results[0].truncated, true)
  assert.ok(results[0].output.includes('已截断命令输出'))
  assert.ok(results[0].output.startsWith('A'))
  assert.ok(results[0].output.endsWith('B'))
})

test('capture falls back to tail when start marker is lost', () => {
  const { host, state } = makeCaptureHost()
  const tracker = new ShellIntegrationTracker(host, {})
  const results = []
  let issuedMarker
  const originalRegister = host.registerMarker
  host.registerMarker = () => {
    issuedMarker = originalRegister()
    return issuedMarker
  }
  tracker.armCommandCapture(4000, (result) => results.push(result))

  beginCapturedCommand(tracker, state, 'cat huge')
  state.rows.push('tail-line-1', 'tail-line-2')
  state.cursorRow = 3
  state.cursorCol = 0
  issuedMarker.dispose()
  tracker.handleOsc133('D;0')

  assert.equal(results[0].markerLost, true)
  assert.equal(results[0].truncated, true)
  assert.ok(results[0].output.includes('tail-line-2'))
  assert.ok(results[0].output.includes('仅保留末尾'))
})

test('peekOutput reads partial output during execution and empty before C', () => {
  const { host, state } = makeCaptureHost()
  const tracker = new ShellIntegrationTracker(host, {})
  const armed = tracker.armCommandCapture(4000, () => {})

  assert.equal(armed.peekOutput(), '')
  beginCapturedCommand(tracker, state, 'ping host')
  state.rows.push('reply 1', 'reply 2')
  state.cursorRow = 2
  state.cursorCol = 7
  assert.equal(armed.peekOutput(), 'reply 1\nreply 2')
})

test('disposed capture does not fire and re-arm replaces previous', () => {
  const { host, state } = makeCaptureHost()
  const tracker = new ShellIntegrationTracker(host, {})
  const first = []
  const second = []
  const armed = tracker.armCommandCapture(4000, (result) => first.push(result))
  armed.dispose()
  tracker.armCommandCapture(4000, (result) => second.push(result))

  beginCapturedCommand(tracker, state, 'ls')
  state.rows.push('file-a')
  state.cursorRow = 2
  state.cursorCol = 0
  tracker.handleOsc133('D;0')

  assert.equal(first.length, 0)
  assert.equal(second.length, 1)
  assert.equal(second[0].output, 'file-a')
})

test('bare enter does not consume an armed capture', () => {
  const { host, state } = makeCaptureHost()
  const tracker = new ShellIntegrationTracker(host, {})
  const results = []
  tracker.armCommandCapture(4000, (result) => results.push(result))

  state.rows[0] = '$ '
  tracker.handleOsc133('A')
  state.cursorCol = 2
  tracker.handleOsc133('B')
  tracker.handleOsc133('D;0')
  assert.equal(results.length, 0)

  beginCapturedCommand(tracker, state, 'uptime')
  state.rows.push('up 3 days')
  state.cursorRow = 2
  state.cursorCol = 0
  tracker.handleOsc133('D;0')
  assert.equal(results.length, 1)
  assert.equal(results[0].command, 'uptime')
})
