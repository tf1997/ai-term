import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createTaskScriptDraft, renderTaskScript, taskScriptCandidates } from '../../src/domains/scripts/domain/taskScript'
import { taskScriptSourceFromCheckpoint } from '../../src/domains/ai/domain/agentScriptExport'

const environment = { profileId: 'host', routeKey: 'route', user: 'fixture', environmentScope: 'host', shell: 'bash' }
const step = (id, command, overrides = {}) => ({ id, command, tool: 'run_command', status: 'completed', executionPhase: 'finished', exitCode: 0, sensitive: false, directory: '/tmp', environment, commandSource: { version: 1, shell: 'bash', source: command, secrets: [] }, ...overrides })
const task = steps => ({ runId: 'run', messageId: 'message', workspaceSessionId: 'workspace', steps, checks: [] })

test('native Bash source retains heredocs, functions, assignments and dependencies in one process', () => {
  const steps = [
    step('setup', 'export FIXTURE_NAME=fixture; fixture() { printf "%s\\n" "$FIXTURE_NAME"; }'),
    step('use', 'fixture; for value in one two; do printf "%s\\n" "$value"; done'),
    step('heredoc', "cat <<'EOF'\n'quoted' $NOT_EXPANDED\nEOF"),
    step('substitution', 'value=$(printf last); printf "%s\\n" "$value"')
  ]
  const draft = createTaskScriptDraft(task(steps), steps.map(step => step.id))
  const rendered = renderTaskScript(draft.content, draft.metadata)
  const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', rendered], { encoding: 'utf8', timeout: 5000 })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, "fixture\none\ntwo\n'quoted' $NOT_EXPANDED\nlast\n")
  assert.equal(draft.metadata.parameters.filter(item => item.type === 'directory').length, 1)
  assert.deepEqual(draft.sourceCommands, steps.map(step => step.command))
  assert.ok(draft.metadata.prerequisites.some(text => text.includes('共享')))
})

test('sensitive command templates use external inputs without retaining old values or interpolation', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-term-command-draft-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const sentinel = join(dir, 'must-not-exist'), privateValue = `literal ' \"\n$(touch '${sentinel}'); end`
  const source = task([step('credential', '[敏感命令未存储]', { sensitive: true, commandSource: { version: 1, shell: 'bash', source: 'export APP_PASSWORD="${AI_TERM_EXPORT_SECRET_1:?请提供外部凭据}"; printf "%s" "$APP_PASSWORD"', secrets: [{ variable: 'AI_TERM_EXPORT_SECRET_1', label: '环境变量 APP_PASSWORD' }] } })])
  source.checks = [{ id: 'check', stepId: 'credential', required: true, status: 'passed', purpose: privateValue, expected: privateValue, kind: 'output-contains' }]
  const draft = createTaskScriptDraft(source, ['credential'])
  const incompleteFlag = structuredClone(source)
  incompleteFlag.steps[0].sensitive = false
  incompleteFlag.steps[0].command = 'curl --user OLD_PRIVATE_FIXTURE'
  assert.ok(!JSON.stringify(createTaskScriptDraft(incompleteFlag, ['credential'])).includes('OLD_PRIVATE_FIXTURE'))
  assert.equal(draft.metadata.parameters.find(item => item.type === 'secret').name, 'COMMAND_1_1')
  assert.ok(!JSON.stringify(draft).includes(privateValue))
  assert.equal(draft.metadata.checks[0].status, 'unavailable')
  assert.throws(() => renderTaskScript(draft.content, draft.metadata, { COMMAND_1_1: privateValue }), /凭据/)
  const rendered = renderTaskScript(draft.content, draft.metadata)
  assert.ok(!rendered.includes(privateValue))
  const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', rendered], { encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH, AI_TERM_SECRET_COMMAND_1_1: privateValue } })
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, privateValue); assert.equal(existsSync(sentinel), false)
  assert.notEqual(spawnSync('/bin/bash', ['-c', rendered], { env: { PATH: process.env.PATH }, timeout: 5000 }).status, 0)
})

test('native source cannot override missing outcome, scope, tool or secret evidence', () => {
  for (const overrides of [ { exitCode: null }, { status: 'failed' }, { tool: 'run_ssh_task' }, { environment: null }, { environment: { ...environment, shell: 'zsh' } }, { sensitive: true }, { commandSource: { version: 2, shell: 'bash', source: 'echo fixture', secrets: [] } } ]) {
    const item = step('state', 'export X=fixture', overrides)
    assert.equal(taskScriptCandidates(task([item]))[0].eligible, false)
  }
  const old = step('old', 'export X=fixture', { commandSource: undefined })
  assert.equal(taskScriptCandidates(task([old]))[0].eligible, false)
  const simple = createTaskScriptDraft(task([step('service', 'systemctl restart fixture')]), ['service'])
  assert.equal(simple.metadata.parameters.filter(item => item.type === 'service').length, 1)
})

test('a failed complex step stops following source without losing its original exit status', () => {
  const source = task([step('first', 'printf before; (exit 7)'), step('later', 'printf MUST_NOT_RUN')])
  const draft = createTaskScriptDraft(source, ['later', 'first'])
  const result = spawnSync('/bin/bash', ['-c', renderTaskScript(draft.content, draft.metadata)], { encoding: 'utf8', timeout: 5000 })
  assert.equal(result.status, 7); assert.equal(result.stdout, 'before')
})

test('checkpoint adapter copies only persisted native template and does not restore any approval', () => {
  const source = { version: 1, shell: 'bash', source: 'export X=fixture', secrets: [] }
  const record = { runId: 'run', messageId: 'message', workspaceSessionId: 'workspace', routeKey: 'route', state: { verifications: [], steps: [{ id: 'step', toolName: 'run_command', command: source.source, status: 'completed', executionPhase: 'finished', exitCode: 0, sensitive: false, fileEdits: [], scriptSource: source, executionTarget: { profileId: 'host', context: { user: 'fixture', environmentScope: 'host', shell: 'bash', workingDirectory: '/tmp' } }, intent: { approved: true } }] } }
  const converted = taskScriptSourceFromCheckpoint(record)
  assert.deepEqual(converted.steps[0].commandSource, source)
  source.source = 'changed later'
  assert.equal(converted.steps[0].commandSource.source, 'export X=fixture')
  assert.ok(!JSON.stringify(converted).includes('approved'))
})
