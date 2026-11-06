import assert from 'node:assert/strict'
import test from 'node:test'
import { applyPatch } from 'diff'
import { agentTaskFileChanges } from '../../src/domains/ai/domain/agentTaskFileChanges'
import { agentFileDiff, agentDiffText } from '../../src/domains/ai/domain/agentFileDiff'
import { persistableFileEdits } from '../../src/domains/ai/domain/agentFileEdits'
import { hydrateAiMessagePayload } from '../../src/domains/ai/domain/workspaceSessions'
import { fileEditView } from '../../src/domains/transfer/domain/fileEdits'
import { proposal, record } from '../transfer/file-edit-fixture.mjs'

const text = content => ({ state: 'text', content })
const item = (before = 'before\n', after = 'after\n', overrides = {}) => {
  const p = proposal(1, { before, after, ...overrides })
  return { view: fileEditView(p), status: 'applied', changeId: p.reference.id, outcome: record(p).outcome }
}
const step = (id, fileEdits, values = {}) => ({
  id, toolName: 'write_file', command: '', reason: '修改文件', risks: [], sensitive: false,
  status: 'completed', executionPhase: 'finished', fileEdits, ...values
})
const diffs = (steps, snapshots) => agentTaskFileChanges(steps, snapshots).map(agentFileDiff)

test('historical write_file receipts restore the missing report summary without command snapshots', () => {
  const content = Array.from({ length: 66 }, (_, i) => `报告第 ${i + 1} 行`).join('\n') + '\n'
  const message = hydrateAiMessagePayload({ text: '文档已写好', payloadJson: JSON.stringify({
    mode: 'agent', agentStatus: 'done', agentSteps: [step('write-report', [item(null, content, {
      path: '/root/kernel-vuln-report.md', resolvedPath: '/root/kernel-vuln-report.md', writeStrategy: 'create-exclusive'
    })])]
  }) })
  assert.equal(message.agentFileChanges, undefined)
  const [diff] = diffs(message.agentSteps, message.agentFileChanges)
  assert.equal(diff.change.path, '/root/kernel-vuln-report.md')
  assert.equal(diff.status, 'added')
  assert.deepEqual([diff.additions, diff.deletions], [66, 0])
  assert.equal(applyPatch('', agentDiffText(diff)), content)
})

test('patch, delete and restore aggregate first baseline to final content, including no net change', () => {
  const initial = '用户已有改动\r\n'
  const steps = [step('patch', [item(initial, '中间结果\r\n')], { toolName: 'apply_patch' }),
    step('write', [item('中间结果\r\n', '最终结果\r\n多一行\r\n')])]
  let [diff] = diffs(steps)
  assert.deepEqual(diff.change.stepIds, ['patch', 'write'])
  assert.deepEqual([diff.additions, diff.deletions], [2, 1])
  assert.equal(applyPatch(initial, agentDiffText(diff), { autoConvertLineEndings: false }), '最终结果\r\n多一行\r\n')
  steps.push(step('delete', [item('最终结果\r\n多一行\r\n', null)], { toolName: 'delete_file' }))
  ;[diff] = diffs(steps)
  assert.equal(diff.status, 'deleted'); assert.equal(diff.deletions, 1)
  steps.push(step('restore', [item(null, initial)], { toolName: 'restore_file' }))
  ;[diff] = diffs(steps)
  assert.equal(diff.status, 'unchanged')
  assert.deepEqual([diff.additions, diff.deletions], [0, 0])
})

test('partial and running batches include applied files but not proposed, skipped or rejected writes', () => {
  const applied = item()
  const unexecuted = ['review', 'not-started', 'skipped', 'conflict', 'failed'].map((status, i) => ({
    ...item('a', 'b', { path: `/tmp/no-write-${i}`, resolvedPath: `/tmp/no-write-${i}` }), status
  }))
  for (const status of ['running', 'failed', 'completed']) {
    const result = diffs([step('batch', [applied, ...unexecuted], { status })])
    assert.equal(result.length, 1)
    assert.equal(result[0].change.path, '/tmp/config-1')
    assert.equal(result[0].status, 'modified')
  }
  assert.deepEqual(diffs([step('review', unexecuted)]), [])
})

test('unknown writes, incomplete receipts and checkpoint-only history never count proposed content', () => {
  const cases = ['unknown', 'dispatching'].map(status => ({ ...item(), status }))
  cases.push({ ...item(), outcome: undefined }, { ...item(), outcome: { status: 'unknown' } },
    { status: 'applied', historyPath: '/tmp/checkpoint', historyScope: 'scope', changeId: 'change' },
    item(undefined, 'after', { before: undefined }))
  for (const value of cases) {
    const [diff] = diffs([step('write', [value])])
    assert.equal(diff.status, 'unavailable')
    assert.equal(diff.additions, undefined)
    assert.equal(diff.patch, undefined)
  }
})

test('sensitive or redacted null contents are never treated as empty or missing files', () => {
  const sensitive = item('PRIVATE_BEFORE', 'PRIVATE_AFTER', { sensitive: true })
  for (const value of [sensitive, ...persistableFileEdits([sensitive]),
    item(null, null, { redacted: true }), item('PRIVATE_BEFORE', 'PRIVATE_AFTER', { path: '/tmp/.env' })]) {
    const [diff] = diffs([step('private', [value])])
    assert.equal(diff.status, 'unavailable')
    assert.equal(diff.additions, undefined)
    assert.ok(!JSON.stringify(diff).includes('PRIVATE_'))
  }
  assert.equal(diffs([step('empty', [item(null, '')])])[0].status, 'added')
})

test('same resolved path merges aliases only in the same environment, and detects intervening edits', () => {
  const steps = [step('one', [item('a', 'b', { path: '/tmp/alias' })]),
    step('two', [item('b', 'c')])]
  assert.equal(diffs(steps).length, 1)
  assert.ok(diffs(steps)[0].change.requestedPaths.includes('/tmp/alias'))
  const original = structuredClone(steps)
  steps[1].fileEdits[0].view.environmentScope = 'b'.repeat(64)
  assert.equal(diffs(steps).length, 2)
  steps[1].fileEdits[0].view.environmentScope = ''
  assert.equal(diffs(steps).length, 2)
  original[1].fileEdits[0].view.before = 'changed externally'
  assert.equal(diffs(original)[0].status, 'unavailable')
})

test('legacy command snapshots retain counts and combine with subsequent file tool receipts', () => {
  const legacy = { path: '/tmp/config-1', requestedPaths: ['/tmp/config-1'], scope: `terminal:1:${'a'.repeat(64)}`,
    before: text('a'), after: text('b'), stepIds: ['shell'] }
  const steps = [step('shell', undefined, { toolName: 'run_command' }), step('edit', [item('b', 'c\nd')])]
  assert.deepEqual(agentTaskFileChanges([], [legacy]), [legacy])
  const [diff] = diffs(steps, [legacy])
  assert.deepEqual([diff.additions, diff.deletions], [2, 1])
  assert.equal(diff.change.before.content, 'a')
  assert.equal(diff.change.after.content, 'c\nd')
  assert.deepEqual(diff.change.stepIds, ['shell', 'edit'])
  assert.equal(diffs(steps.slice(1), [legacy])[0].status, 'unavailable', 'Missing chronology cannot yield exact net counts')
  const spanning = { ...legacy, stepIds: ['shell', 'last'], after: text('z') }
  const [overlap] = diffs([...steps, step('last', undefined)], [spanning])
  assert.equal(overlap.status, 'unavailable', 'Aggregated shell snapshots cannot be reordered around intervening file edits')
  assert.deepEqual(overlap.change.stepIds, ['shell', 'edit', 'last'])
})
