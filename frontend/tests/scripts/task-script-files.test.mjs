import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, chmodSync, symlinkSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createTaskScriptDraft, renderTaskScript, taskScriptCandidates } from '../../src/domains/scripts/domain/taskScript'
import { taskScriptSourceFromCheckpoint } from '../../src/domains/ai/domain/agentScriptExport'
import { loadTaskScriptSource } from '../../src/domains/ai/application/loadTaskScriptSource'

const environment = { profileId: 'host', routeKey: 'route', user: 'operator', environmentScope: 'container', shell: 'bash' }
const target = { sessionId: 'terminal', sessionInstance: 'instance', profileId: 'host', routeVersion: 2, contextVersion: 3, context: { shell: 'bash', workingDirectory: '/srv/app', user: 'operator', environmentScope: 'container' } }
const attrs = { mode: 0o640, uid: 1000, gid: 1000, metadataBackup: null }
const file = (id, path, before, after, action = 'replace') => ({ id, path, before, after, action, externalContent: false, mode: 0o640 })
const step = (files, overrides = {}) => ({ id: 'edit', tool: 'apply_patch', command: '', status: 'completed', executionPhase: 'finished', exitCode: null, sensitive: false, directory: '/srv/app', environment, fileChanges: files, fileChangeCount: files.length, ...overrides })
const source = steps => ({ runId: 'run', messageId: 'answer', workspaceSessionId: 'workspace', steps, checks: [] })
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ai-term-task-files-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}
function run(draft, values = {}, env = {}) {
  const rendered = renderTaskScript(draft.content, draft.metadata, values)
  const syntax = spawnSync('/bin/bash', ['-n'], { input: rendered, encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)
  return spawnSync('/bin/bash', ['-c', rendered], { encoding: 'utf8', timeout: 10000, env: { ...process.env, ...env } })
}
function checkpointAndChange(path, overrides = {}) {
  const change = { id: 'change', target, path, resolvedPath: path, environmentScope: 'file-scope', before: 'before\n', after: 'after\n', sensitive: false, provider: 'sftp', writeStrategy: 'in-place', restoreOf: null, createdAt: 1, outcome: { status: 'applied', revision: 'revision-after', contentHash: 'hash', beforeAttributes: attrs, afterAttributes: attrs, error: null }, ...overrides }
  const saved = { id: 'edit', toolName: 'apply_patch', command: '', status: 'completed', executionPhase: 'finished', exitCode: null, sensitive: change.sensitive, executionTarget: target, fileRead: null, fileEdits: [{ changeId: change.id, path, environmentScope: 'file-scope', revision: change.outcome.revision, status: 'applied' }] }
  const checkpoint = { runId: 'run', messageId: 'answer', workspaceSessionId: 'workspace', routeKey: 'route', state: { steps: [saved], verifications: [] } }
  return { checkpoint, change }
}

test('generated file replacement preserves exact UTF-8 bytes and mode and skips an already applied change', t => {
  const directory = setup(t), path = join(directory, "literal ' $(never) 中文.txt")
  const before = '\ufefffirst\r\nsecond  \r\nlast', after = '\ufefffirst\r\n第二行\t \r\nlast'
  writeFileSync(path, before); chmodSync(path, 0o640)
  const draft = createTaskScriptDraft(source([step([file('change', path, before, after)])]), ['edit'])
  const first = run(draft)
  assert.equal(first.status, 0, first.stderr)
  assert.equal(readFileSync(path, 'utf8'), after); assert.equal(statSync(path).mode & 0o777, 0o640)
  const second = run(draft)
  assert.equal(second.status, 0, second.stderr); assert.match(second.stdout, /Already matches/)
  assert.ok(draft.content.includes('文件变更 change')); assert.deepEqual(draft.metadata.source.stepIds, ['edit'])
})

test('create and delete are explicit, cannot overwrite an existing file, and can be repeated', t => {
  const directory = setup(t), path = join(directory, 'created')
  const create = createTaskScriptDraft(source([step([file('create', path, null, 'new\n', 'create')], { tool: 'write_file' })]), ['edit'])
  assert.equal(run(create).status, 0); assert.equal(readFileSync(path, 'utf8'), 'new\n'); assert.equal(statSync(path).mode & 0o777, 0o640)
  assert.equal(run(create).status, 0)
  writeFileSync(path, 'other\n'); assert.notEqual(run(create).status, 0); assert.equal(readFileSync(path, 'utf8'), 'other\n')
  const remove = createTaskScriptDraft(source([step([file('delete', path, 'other\n', null, 'delete')], { tool: 'delete_file' })]), ['edit'])
  assert.equal(run(remove).status, 0); assert.equal(existsSync(path), false); assert.equal(run(remove).status, 0)
})

test('a changed later file stops the script and retains earlier applied changes', t => {
  const directory = setup(t), first = join(directory, 'first'), second = join(directory, 'second'), marker = join(directory, 'MUST_NOT_RUN')
  writeFileSync(first, 'before'); writeFileSync(second, 'external')
  const task = source([step([file('one', first, 'before', 'after'), file('two', second, 'before', 'after')]), { id: 'later', tool: 'run_command', command: `touch '${marker}'`, status: 'completed', executionPhase: 'finished', exitCode: 0, sensitive: false, environment, directory }])
  const result = run(createTaskScriptDraft(task, ['edit', 'later']))
  assert.notEqual(result.status, 0); assert.match(result.stderr, /baseline/)
  assert.equal(readFileSync(first, 'utf8'), 'after'); assert.equal(readFileSync(second, 'utf8'), 'external'); assert.equal(existsSync(marker), false)
})

test('symlinks and hard links are refused before a content write', t => {
  const directory = setup(t), original = join(directory, 'original'), symbolic = join(directory, 'symbolic'), hard = join(directory, 'hard')
  writeFileSync(original, 'before'); symlinkSync(original, symbolic); linkSync(original, hard)
  for (const path of [symbolic, hard]) {
    const result = run(createTaskScriptDraft(source([step([file('change', path, 'before', 'after')])]), ['edit']))
    assert.notEqual(result.status, 0); assert.equal(readFileSync(original, 'utf8'), 'before')
  }
})

test('external file contents are required and never enter the draft, provenance, checks or output', t => {
  const directory = setup(t), path = join(directory, 'config'), oldInput = join(directory, 'baseline'), newInput = join(directory, 'replacement')
  const secret = "token=secret-value-'$(touch /should-not-run)'\r\n"
  writeFileSync(path, 'before\n'); writeFileSync(oldInput, 'before\n'); writeFileSync(newInput, secret)
  const { checkpoint, change } = checkpointAndChange(path, { after: secret })
  checkpoint.state.verifications = [{ id: 'v', purpose: secret, required: true, status: 'passed', check: { kind: 'file-contains', expected: secret, stepId: 'edit' } }]
  const mapped = taskScriptSourceFromCheckpoint(checkpoint, [change])
  assert.equal(mapped.steps[0].fileChanges[0].externalContent, true)
  assert.equal(mapped.steps[0].fileChanges[0].after, null)
  const draft = createTaskScriptDraft(mapped, ['edit'])
  assert.ok(!JSON.stringify(draft).includes('secret-value'))
  assert.ok(draft.metadata.parameters.filter(p => p.type === 'secret').every(p => p.defaultValue === null))
  assert.notEqual(run(draft).status, 0)
  const result = run(draft, {}, { AI_TERM_SECRET_FILE_BEFORE_1: oldInput, AI_TERM_SECRET_FILE_AFTER_1: newInput })
  assert.equal(result.status, 0, result.stderr); assert.equal(readFileSync(path, 'utf8'), secret)
  assert.ok(!result.stdout.includes('secret-value')); assert.ok(!result.stderr.includes('secret-value'))
})

test('a redacted sensitive receipt can be exported only with explicit external content inputs', t => {
  const directory = setup(t), path = join(directory, '.env')
  const { checkpoint, change } = checkpointAndChange(path, { sensitive: true, before: null, after: null })
  const mapped = taskScriptSourceFromCheckpoint(checkpoint, [change])
  assert.equal(taskScriptCandidates(mapped)[0].eligible, true)
  const draft = createTaskScriptDraft(mapped, ['edit'])
  assert.equal(draft.metadata.parameters.filter(p => p.type === 'secret').length, 2)
})

test('missing, unrelated, failed and metadata-changing receipts cannot authorize script content conversion', () => {
  const { checkpoint, change } = checkpointAndChange('/srv/config')
  const variants = [null, { ...change, id: 'other' }, { ...change, path: '/other' }, { ...change, environmentScope: 'other' }, { ...change, target: { ...target, sessionInstance: 'other' } }, { ...change, target: { ...target, context: { ...target.context, user: 'other' } } }, { ...change, outcome: { ...change.outcome, status: 'unknown' } }, { ...change, outcome: { ...change.outcome, revision: 'other' } }, { ...change, outcome: { ...change.outcome, afterAttributes: { ...attrs, mode: 0o600 } } }]
  for (const value of variants) {
    const mapped = taskScriptSourceFromCheckpoint(checkpoint, value ? [value] : [])
    assert.equal(taskScriptCandidates(mapped)[0].eligible, false)
    assert.throws(() => createTaskScriptDraft(mapped, ['edit']), /不可转换/)
  }
})

test('evidence loading is read-only and a missing receipt leaves the original file step unavailable', async () => {
  const { checkpoint, change } = checkpointAndChange('/srv/config')
  const called = []
  const loaded = await loadTaskScriptSource(checkpoint, async id => { called.push(id); return change })
  assert.deepEqual(called, ['change']); assert.equal(taskScriptCandidates(loaded)[0].eligible, true)
  const missing = await loadTaskScriptSource(checkpoint, async () => { throw Error('missing') })
  assert.equal(taskScriptCandidates(missing)[0].eligible, false)
})

test('complete file reads become executable verification steps in the original read-edit-read order', t => {
  const directory = setup(t), path = join(directory, 'config')
  writeFileSync(path, 'before\n')
  const { checkpoint, change } = checkpointAndChange(path)
  const read = (id, content) => ({ ...checkpoint.state.steps[0], id, toolName: 'read_file', fileEdits: [], fileRead: { path, resolvedPath: path, revision: 'read-revision', environmentScope: 'file-scope', complete: true, changedDuringRead: false, content } })
  checkpoint.state.steps = [read('before-read', 'before\n'), checkpoint.state.steps[0], read('after-read', 'after\n')]
  checkpoint.state.verifications = [{ id: 'content-check', purpose: '确认新内容', required: true, status: 'passed', check: { kind: 'file-contains', expected: 'after', stepId: 'after-read' } }]
  const mapped = taskScriptSourceFromCheckpoint(checkpoint, [change])
  assert.ok(taskScriptCandidates(mapped).every(item => item.eligible))
  const draft = createTaskScriptDraft(mapped, ['after-read', 'edit', 'before-read'])
  assert.deepEqual(draft.metadata.source.stepIds, ['before-read', 'edit', 'after-read'])
  assert.equal(draft.metadata.checks[0].id, 'content-check')
  const result = run(draft)
  assert.equal(result.status, 0, result.stderr); assert.equal(readFileSync(path, 'utf8'), 'after\n')
  assert.equal(result.stdout.match(/Recorded file content verified/g)?.length, 2)
  const verificationOnly = createTaskScriptDraft(mapped, ['after-read'])
  writeFileSync(path, 'wrong\n')
  assert.notEqual(run(verificationOnly).status, 0); assert.equal(readFileSync(path, 'utf8'), 'wrong\n')
  for (const override of [{ complete: false }, { changedDuringRead: true }, { content: null }, { resolvedPath: null }]) {
    const copy = structuredClone(checkpoint)
    Object.assign(copy.state.steps[0].fileRead, override)
    assert.equal(taskScriptCandidates(taskScriptSourceFromCheckpoint(copy, [change]))[0].eligible, false)
  }
})
