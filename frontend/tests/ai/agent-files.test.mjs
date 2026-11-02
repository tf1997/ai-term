import assert from 'node:assert/strict'
import test from 'node:test'
import { agentFileReferences, normalizeAgentFiles } from '../../src/domains/ai/domain/agentFiles'
import { hydrateAiMessagePayload } from '../../src/domains/ai/domain/workspaceSessions'
import { runAgentTask } from '../../src/domains/ai/application/agent/agentLoop'

const step = (id, files, values = {}) => ({ id, command: 'edit', reason: '编辑', status: 'completed', executionPhase: 'finished', exitCode: 0, affectedFiles: files, sensitive: false, risks: [], ...values })

test('写入路径规范化保留完整名称、去重并排除无效元数据', () => {
  assert.deepEqual(normalizeAgentFiles([' /srv/应用/file name.ts ', '/srv/应用/file name.ts', 1, null, '', '\u0000oops', '/srv/*', '/srv/a?']), ['/srv/应用/file name.ts'])
  assert.equal(normalizeAgentFiles({ path: '/tmp/a' }), undefined)
  assert.equal(normalizeAgentFiles(['x'.repeat(4097)]), undefined)
  assert.equal(normalizeAgentFiles(Array.from({ length: 101 }, (_, i) => `/tmp/${i}`)).length, 100)
})

test('文件列表只关联已派发命令，保留不确定结果和相同路径的多次记录', () => {
  const steps = [step('one', ['/srv/a.ts']), step('two', ['/srv/a.ts', '/srv/b.ts']), step('error', ['/srv/b.ts'], { exitCode: 1 }), step('skip', ['/srv/skipped'], { status: 'skipped' }), step('pending', ['/srv/pending'], { status: 'pending' }), step('dispatch', ['/srv/never-started'], { status: 'failed', executionPhase: 'not-started' }), step('private', ['/srv/secret'], { sensitive: true })]
  const original = structuredClone(steps)
  assert.deepEqual(agentFileReferences(steps), [
    { path: '/srv/a.ts', stepIds: ['one', 'two'], uncertain: false },
    { path: '/srv/b.ts', stepIds: ['two', 'error'], uncertain: true }
  ])
  assert.deepEqual(steps, original)
  assert.deepEqual(agentFileReferences([step('old', undefined)]), [])
  assert.equal(agentFileReferences([step('unknown', ['/tmp/a'], { exitCode: undefined })])[0].uncertain, true)
})

test('不同执行步骤的相对路径不能假定为同一文件', () => {
  const files = agentFileReferences([step('a', ['src/index.ts', 'C:\\project\\app.ts']), step('b', ['src/index.ts', 'C:\\project\\app.ts'])])
  assert.equal(files.length, 3)
  assert.deepEqual(files[1].stepIds, ['a', 'b'])
})

test('模型写入目标经过真实循环审批和执行后持久化，不额外执行文件操作', async () => {
  const responses = [
    { text: '', toolCalls: [{ id: 'write', name: 'run_command', arguments: JSON.stringify({ command: 'edit /srv/app.ts', reason: '更新配置', files: ['/srv/app.ts', '/srv/app.ts'] }) }] },
    { text: '已更新', toolCalls: [] }
  ]
  const dispatched = [], approvals = []
  const result = await runAgentTask('更新配置', {
    callModel: async () => ({ ...responses.shift(), contextChars: 0, contextCompressed: false }),
    classifyStep: () => ({ risks: [], sensitive: false, autoExec: { eligible: false, suggestedPatterns: [] } }),
    requestApproval: async proposal => { approvals.push(proposal.command); return 'execute' },
    startCommand: command => {
      dispatched.push(command)
      return { result: Promise.resolve({ status: 'completed', output: 'ok', exitCode: 0, durationMs: 1, truncated: false }), peekOutput: () => '', cancel() {} }
    },
    requestTimeoutDecision: async () => 'stop', onAllowPattern() {}, onStateChange() {}
  }).done
  assert.equal(result.status, 'done')
  assert.deepEqual(dispatched, ['edit /srv/app.ts'])
  assert.deepEqual(approvals, dispatched)
  const message = hydrateAiMessagePayload({ text: result.finalText, payloadJson: JSON.stringify({ mode: 'agent', agentStatus: 'done', agentSteps: result.steps }) })
  assert.deepEqual(agentFileReferences(message.agentSteps), [{ path: '/srv/app.ts', stepIds: ['write'], uncertain: false }])
  const invalid = hydrateAiMessagePayload({ text: '', payloadJson: JSON.stringify({ mode: 'agent', agentSteps: [step('old', { invalid: true })] }) })
  assert.equal(invalid.agentSteps[0].affectedFiles, undefined)
})
