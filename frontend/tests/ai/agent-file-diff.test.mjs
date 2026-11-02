import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, mkdir, symlink, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyPatch } from 'diff'
import { AGENT_FILE_MAX_BYTES, buildFileSnapshotCommand, parseFileSnapshots, createAgentFileTracker, normalizeAgentFileChanges, snapshotPathProblem } from '../../src/domains/ai/domain/agentFileSnapshots'
import { agentFileDiff, agentDiffText } from '../../src/domains/ai/domain/agentFileDiff'
import { createAgentFileSnapshotReader } from '../../src/domains/ai/application/agent/readAgentFileSnapshots'
import { runAgentTask } from '../../src/domains/ai/application/agent/agentLoop'
import { hydrateAiMessagePayload } from '../../src/domains/ai/domain/workspaceSessions'
import { isSuffixSafeForSentinel } from '../../src/domains/ai/domain/agentAutoApprove'

const exec = promisify(execFile)
const text = content => ({ state: 'text', content })
const missing = { state: 'missing' }
const snap = (version, values = {}) => ({ requestedPath: '/srv/file', path: '/srv/file', scope: 'host:uid:mount', version, ...values })
const change = (before, after) => ({ path: '/srv/file', requestedPaths: ['/srv/file'], scope: 'host', before, after, stepIds: ['write'] })
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ai-term-snapshot-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
async function read(paths, shell = '/bin/sh', env) {
  const command = buildFileSnapshotCommand(paths, 'fixture')
  assert.equal(isSuffixSafeForSentinel(command).ok, true, 'Internal reader must pass the real dispatch safety check')
  const { stdout } = await exec(shell, ['-c', command], { maxBuffer: 1024 * 1024, env })
  return parseFileSnapshots(stdout, paths, 'fixture')
}

test('POSIX snapshots preserve exact UTF-8 bytes, BOM, CRLF, whitespace and empty/missing files', async t => {
  const dir = await fixture(t)
  const cases = ['\ufeff中文\r\n\tlast ', '', 'ends\n\n', 'no newline']
  const paths = cases.map((_, i) => join(dir, `file ${i}'$(printf injected).txt`))
  await Promise.all(paths.map((path, i) => writeFile(path, cases[i])))
  paths.push(join(dir, 'new/deep/file'))
  for (const shell of ['/bin/sh', '/bin/bash', '/bin/zsh']) {
    const snapshots = await read(paths, shell)
    assert.deepEqual(snapshots.map(item => item.version), [...cases.map(text), missing])
    assert.ok(snapshots.every(item => item.scope && item.path.endsWith(item.requestedPath.slice(dir.length))))
  }
  await assert.rejects(access(join(dir, 'injected')))
})

test('binary, large files, symlinks and read errors are unknown, never an empty-file diff', async t => {
  const dir = await fixture(t)
  const paths = ['binary', 'bad-utf8', 'large', 'link', 'folder'].map(name => join(dir, name))
  await writeFile(paths[0], Buffer.from([65, 0, 66]))
  await writeFile(paths[1], Buffer.from([0xff, 0xfe]))
  await writeFile(paths[2], 'x'.repeat(AGENT_FILE_MAX_BYTES + 1))
  await symlink(paths[0], paths[3]); await mkdir(paths[4])
  assert.ok((await read(paths)).every(item => item.version.state === 'unavailable'))
  const bin = join(dir, 'bin'); await mkdir(bin)
  await writeFile(join(bin, 'head'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const failed = await read([paths[0]], '/bin/sh', { ...process.env, PATH: `${bin}:${process.env.PATH}` })
  assert.equal(failed[0].version.state, 'unavailable')
  assert.match(failed[0].version.reason, /读取失败/)
  assert.ok(snapshotPathProblem('/srv/.env'))
  assert.ok(snapshotPathProblem('../file'))
  assert.ok(snapshotPathProblem('/srv/../file'))
  assert.equal(parseFileSnapshots('', ['/a'], 'fixture')[0].version.state, 'unavailable')
})

test('exact line counts and unified patches round-trip whitespace, EOF, creation and deletion', () => {
  for (const [before, after, additions, deletions, status] of [
    [text('old\nkeep\n'), text('new\nkeep\nplus\n'), 2, 1, 'modified'],
    [text('x'), text('x\n'), 1, 1, 'modified'],
    [text('a\r\n'), text('a\n'), 1, 1, 'modified'],
    [text('  x\n'), text('\tx\n'), 1, 1, 'modified'],
    [missing, text('new\n'), 1, 0, 'added'],
    [text('old\n'), missing, 0, 1, 'deleted'],
    [missing, text(''), 0, 0, 'added'],
    [text(''), missing, 0, 0, 'deleted'],
    [text('same'), text('same'), 0, 0, 'unchanged'],
    [missing, missing, 0, 0, 'unchanged']
  ]) {
    const diff = agentFileDiff(change(before, after))
    assert.equal(diff.status, status)
    assert.equal(diff.additions, additions); assert.equal(diff.deletions, deletions)
    if (diff.patch) assert.equal(applyPatch(before.content ?? '', agentDiffText(diff), { autoConvertLineEndings: false }), after.content ?? '')
  }
})

test('repeated edits preserve task baseline, exclude preexisting edits, and support retries/reverts', () => {
  const tracker = createAgentFileTracker()
  tracker.begin('one', [snap(text('already dirty\n'))]).finish([snap(text('intermediate\n'))])
  const restored = createAgentFileTracker(tracker.values())
  restored.begin('two', [snap(text('intermediate\n'))]).finish([snap(text('final\nextra\n'))])
  const diff = agentFileDiff(restored.values()[0])
  assert.equal(diff.change.before.content, 'already dirty\n')
  assert.deepEqual(diff.change.stepIds, ['one', 'two'])
  assert.equal(diff.additions, 2); assert.equal(diff.deletions, 1)
  restored.begin('three', [snap(text('final\nextra\n'))]).finish([snap(text('already dirty\n'))])
  assert.equal(agentFileDiff(restored.values()[0]).status, 'unchanged')
  const hydrate = hydrateAiMessagePayload({ text: '', payloadJson: JSON.stringify({ mode: 'agent', agentFileChanges: restored.values() }) })
  assert.deepEqual(hydrate.agentFileChanges, restored.values())
})

test('scope changes, missing post reads, external edits and malformed persisted records suppress counts', () => {
  const tracker = createAgentFileTracker()
  tracker.begin('one', [snap(text('a'))]).finish([snap(text('b'))])
  const pending = tracker.begin('never-dispatched', [snap(text('b'))])
  assert.equal(agentFileDiff(tracker.values()[0]).status, 'unavailable')
  pending.rollback()
  assert.equal(agentFileDiff(tracker.values()[0]).status, 'modified')
  tracker.begin('two', [snap(text('outside edit'))]).finish([snap(text('c'))])
  assert.equal(agentFileDiff(tracker.values()[0]).additions, undefined)
  const other = createAgentFileTracker()
  other.begin('move', [snap(text('a'))]).finish([snap(text('b'), { scope: 'other-host' })])
  assert.equal(agentFileDiff(other.values()[0]).status, 'unavailable')
  assert.equal(normalizeAgentFileChanges([null, {}, { path: 12 }]), undefined)
  const privateChange = { ...change(text('secret'), text('new secret')), path: '/srv/.env' }
  assert.ok(!JSON.stringify(normalizeAgentFileChanges([privateChange])).includes('secret'))
})

test('aliases captured in the same batch merge without falsely reporting an external edit', () => {
  const tracker = createAgentFileTracker()
  const aliases = ['/srv/file', '/srv/link-parent/file']
  tracker.begin('one', aliases.map(requestedPath => snap(text('before'), { requestedPath })))
    .finish(aliases.map(requestedPath => snap(text('after'), { requestedPath })))
  assert.equal(tracker.values().length, 1)
  assert.deepEqual(tracker.values()[0].requestedPaths, aliases)
  assert.equal(agentFileDiff(tracker.values()[0]).status, 'modified')
})

test('snapshot reader runs bounded hidden reads and refuses truncated output', async () => {
  const options = []
  const reader = createAgentFileSnapshotReader((command, opts) => {
    options.push(opts)
    return { result: Promise.resolve({ status: 'completed', exitCode: 0, truncated: true, output: command }), cancel() {}, peekOutput: () => '' }
  })
  const result = await reader(['/srv/file', '/srv/.env'], { cancelled: false })
  assert.ok(result.every(item => item.version.state === 'unavailable'))
  assert.equal(options.length, 1); assert.equal(options[0].internal, true); assert.equal(options[0].waitForReady, true)
  assert.ok(options[0].maxOutputChars > AGENT_FILE_MAX_BYTES)
})

const command = { id: 'write', name: 'run_command', arguments: JSON.stringify({ command: 'edit', files: ['/srv/file'] }) }
function loop(overrides = {}, options = {}) {
  const order = [], states = [], turns = []
  let reads = 0
  const responses = [{ text: '', toolCalls: [command] }, { text: 'done', toolCalls: [] }]
  const task = runAgentTask('edit', {
    callModel: async history => { turns.push(structuredClone(history)); return responses.shift() },
    classifyStep: () => ({ risks: [], sensitive: false, autoExec: { eligible: false } }),
    requestApproval: async () => { order.push('approve'); return 'execute' },
    readFiles: async () => { order.push('read'); return [snap(text(++reads === 1 ? 'before\n' : 'after\n'))] },
    startCommand: () => { order.push('write'); return { result: Promise.resolve({ status: 'completed', exitCode: 1, output: 'partial write', durationMs: 3, truncated: false }), cancel() {}, peekOutput: () => '' } },
    requestTimeoutDecision: async () => 'stop', onAllowPattern() {}, onStateChange: state => states.push(state),
    ...overrides
  }, options)
  return { ...task, order, states, turns }
}
test('approval precedes snapshots; nonzero writes retain diffs without placing contents in model turns', async () => {
  const task = loop()
  const result = await task.done
  assert.deepEqual(task.order, ['approve', 'read', 'write', 'read'])
  assert.equal(result.steps[0].exitCode, 1)
  assert.equal(agentFileDiff(result.fileChanges[0]).additions, 1)
  assert.ok(!JSON.stringify(task.turns).includes('before\\n'))
  assert.ok(!JSON.stringify(task.turns).includes('after\\n'))
})
test('skip, dispatch failure and stopping before snapshot completion never claim a write', async () => {
  const skipped = loop({ requestApproval: async () => 'skip' })
  assert.equal((await skipped.done).fileChanges, undefined); assert.deepEqual(skipped.order, [])
  const failed = loop({ startCommand: () => ({ result: Promise.resolve({ status: 'dispatch-failed', failureReason: 'not ready' }), cancel() {}, peekOutput: () => '' }) })
  assert.equal((await failed.done).fileChanges, undefined)
  let readStarted
  const started = new Promise(resolve => { readStarted = resolve })
  const stopped = loop({ readFiles: async () => { readStarted(); return new Promise(() => {}) } })
  await started; stopped.stop()
  const result = await stopped.done
  assert.equal(result.status, 'stopped'); assert.equal(result.fileChanges, undefined)
  assert.equal(result.steps[0].executionPhase, 'not-started')
  assert.ok(!stopped.order.includes('write'))
})
test('stopping during post-read keeps completed command but unknown file result', async () => {
  let count = 0, postStarted
  const started = new Promise(resolve => { postStarted = resolve })
  const task = loop({ readFiles: async () => {
    if (++count === 1) return [snap(text('before'))]
    postStarted(); return new Promise(() => {})
  } })
  await started; task.stop()
  const result = await task.done
  assert.equal(result.steps[0].status, 'completed')
  assert.equal(agentFileDiff(result.fileChanges[0]).status, 'unavailable')
})
