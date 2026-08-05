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
