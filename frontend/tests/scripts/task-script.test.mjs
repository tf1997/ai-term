import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createTaskScriptDraft, renderTaskScript, taskScriptCandidates, persistTaskScriptMetadata, taskScriptOmissionDescription } from '../../src/domains/scripts/domain/taskScript'
const environment = { profileId: 'host', routeKey: 'route', user: 'operator', environmentScope: 'container', shell: 'bash' }
const step = (id, command, overrides = {}) => ({ id, command, tool: 'run_command', status: 'completed', executionPhase: 'finished', exitCode: 0, sensitive: false, directory: '/srv/app', environment, ...overrides })
const source = steps => ({ runId: 'run', messageId: 'answer', workspaceSessionId: 'workspace', steps, checks: [] })

test('task draft preserves source order, directory dependencies and selected verification evidence', () => {
  const task = source([step('one', 'cd /srv/other && systemctl restart demo.service'), step('two', 'systemctl is-active demo.service', { directory: '/srv/other' }), step('failed', 'rm /tmp/fixture', { status: 'failed', exitCode: 1 })])
  task.checks = [{ id: 'health', purpose: '检查服务', kind: 'output-contains', expected: 'active', status: 'passed', stepId: 'two', required: true }]
  const draft = createTaskScriptDraft(task, ['two', 'one'])
  assert.deepEqual(draft.metadata.source.stepIds, ['one', 'two'])
  assert.equal(draft.metadata.parameters.filter(item => item.type === 'directory').length, 2)
  assert.equal(draft.metadata.parameters.filter(item => item.type === 'service').length, 1)
  assert.equal(draft.metadata.checks[0].id, 'health')
  assert.match(draft.content, /历史 passed 不是本次结果/)
  assert.doesNotMatch(draft.content, /rm \/tmp/)
  assert.ok(draft.metadata.prerequisites.some(item => item.includes('未选择')))
  const rendered = renderTaskScript(draft.content, draft.metadata)
  assert.match(rendered, /cd -- '\/srv\/app'/); assert.match(rendered, /systemctl restart 'demo.service'/)
  assert.equal(rendered.includes('__AI_TERM_PARAM_'), false)
})

test('failed, unknown, sensitive, stateful and unsupported environment steps cannot be converted', () => {
  const cases = [step('unknown', 'touch /tmp/x', { exitCode: null }), step('secret', 'curl --token SECRET'), step('quoted-secret', 'curl --to\"ken\" SECRET'), step('env-secret', 'env MY_SECRET=secret tool'), step('sensitive', 'cat /private', { sensitive: true }), step('export', 'export DIR=/srv'), step('dynamic', 'cp "$SOURCE" /tmp/x'), step('file', '', { tool: 'write_file' }), step('scope', 'whoami', { environment: null }), step('reserved-function', '_ai_term_file_change /tmp/example')]
  const candidates = taskScriptCandidates(source(cases))
  assert.equal(candidates.find(item => item.step.id === 'unknown').eligible, false)
  for (const item of cases) assert.throws(() => createTaskScriptDraft(source(cases), [item.id]), /不可转换/)
  assert.ok(!JSON.stringify(candidates.map(item => item.reason)).includes('SECRET'))
})

test('cross-host, route, account and container selections require separate drafts', () => {
  for (const field of ['profileId', 'routeKey', 'user', 'environmentScope']) {
    const task = source([step('a', 'whoami'), step('b', 'id', { environment: { ...environment, [field]: 'different' } })])
    assert.throws(() => createTaskScriptDraft(task, ['a', 'b']), /跨主机/)
    assert.equal(createTaskScriptDraft(task, ['a']).metadata.source.stepIds.length, 1)
  }
})

test('omitted sources retain order and exact reasons without copying their commands, file contents or capabilities', () => {
  const task = source([
    step('selected', 'printf ready'), step('manual', 'printf OPTIONAL_OMITTED_COMMAND'),
    step('ssh', 'export PASSWORD=PRIVATE_OMITTED_SECRET', { tool: 'run_ssh_task', sensitive: true }),
    step('restore', 'PRIVATE_OMITTED_FILE', { tool: 'restore_file', fileChanges: [], fileChangeCount: 1 }),
    step('other-host', 'printf OTHER_HOST_COMMAND', { environment: { ...environment, profileId: 'other-host' } }),
    step('failed', 'printf FAILED_COMMAND', { status: 'failed', exitCode: 1 }),
    step('unknown', 'printf UNKNOWN_COMMAND', { exitCode: null })
  ])
  task.checks = [
    { id: 'omitted-health', stepId: 'manual', required: true, status: 'passed', kind: 'output-contains', purpose: 'PRIVATE_OMITTED_PURPOSE', expected: 'PRIVATE_OMITTED_EXPECTED' },
    { id: 'missing-evidence', stepId: null, required: false, status: 'pending', kind: 'output-contains', purpose: 'PRIVATE_OMITTED_PURPOSE', expected: 'PRIVATE_OMITTED_EXPECTED' }
  ]
  const draft = createTaskScriptDraft(task, ['selected'])
  assert.deepEqual(draft.metadata.omittedSteps.map(item => [item.stepId, item.reason]), [
    ['manual', 'not-selected'], ['ssh', 'unsupported-tool'], ['restore', 'missing-file-evidence'],
    ['other-host', 'different-environment'], ['failed', 'not-completed'], ['unknown', 'unknown-exit']
  ])
  assert.match(taskScriptOmissionDescription(draft.metadata.omittedSteps[1]), /独立 SSH/)
  assert.match(draft.content, /另有 6 项未选择或需单独整理/)
  assert.match(draft.content, /2 项验证未纳入（必要项 1 项）/)
  assert.deepEqual(draft.metadata.omittedChecks, [
    { id: 'omitted-health', stepId: 'manual', required: true, status: 'passed' },
    { id: 'missing-evidence', stepId: null, required: false, status: 'pending' }
  ])
  assert.deepEqual(draft.metadata.source.stepIds, ['selected'])
  assert.deepEqual(draft.sourceCommands, ['printf ready'])
  assert.doesNotMatch(JSON.stringify(draft), /PRIVATE_OMITTED|OPTIONAL_OMITTED_COMMAND|OTHER_HOST_COMMAND|FAILED_COMMAND|UNKNOWN_COMMAND/)
  const persisted = persistTaskScriptMetadata({ ...draft.metadata, omittedSteps: draft.metadata.omittedSteps.map(item => ({ ...item, command: 'PRIVATE_FORGED_SOURCE', approved: true })), omittedChecks: draft.metadata.omittedChecks.map(item => ({ ...item, expected: 'PRIVATE_FORGED_EXPECTED' })) })
  assert.deepEqual(persisted.omittedSteps, draft.metadata.omittedSteps)
  assert.deepEqual(persisted.omittedChecks, draft.metadata.omittedChecks)
  assert.doesNotMatch(JSON.stringify(persisted), /PRIVATE_FORGED|approved/)
  assert.equal(renderTaskScript(draft.content, persisted).includes('printf ready'), true)
})

test('a thousand-step source retains every omitted reference and old metadata needs no omission field', () => {
  const task = source(Array.from({ length: 1000 }, (_, n) => step(String(n).padEnd(256, 'x'), 'printf ready')))
  const draft = createTaskScriptDraft(task, [task.steps[0].id])
  assert.equal(draft.metadata.omittedSteps.length, 999)
  assert.equal(draft.metadata.omittedSteps[998].stepId, task.steps[999].id)
  const bytes = new TextEncoder().encode(JSON.stringify(draft.metadata)).length
  assert.ok(bytes > 65536 && bytes <= 512 * 1024)
  const old = { ...draft.metadata }; delete old.omittedSteps
  assert.equal(persistTaskScriptMetadata(old).omittedSteps, undefined)
  assert.equal(renderTaskScript(draft.content, old), renderTaskScript(draft.content, draft.metadata))
  assert.throws(() => createTaskScriptDraft(source([...task.steps, step('extra', 'printf ready')]), [task.steps[0].id]), /1000 步/)
})

test('rendered text parameters remain a single literal shell argument and secrets have no stored default', t => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-term-script-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const sentinel = join(directory, 'MUST_NOT_EXIST')
  const value = `$(touch '${sentinel}'); spaces ' and \" | & *`
  const metadata = { version: 1, parameters: [{ name: 'INPUT', label: '输入', type: 'secret', required: true, defaultValue: 'IGNORED_SECRET_DEFAULT' }] }
  const template = "printf '%s' __AI_TERM_PARAM_INPUT__\n"
  assert.throws(() => renderTaskScript(template, metadata, { INPUT: value }), /凭据/)
  const rendered = renderTaskScript(template, metadata)
  assert.ok(!rendered.includes('IGNORED_SECRET_DEFAULT')); assert.ok(!rendered.includes(value))
  const run = spawnSync('/bin/bash', ['-c', rendered], { encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH, AI_TERM_SECRET_INPUT: value } })
  const literal = renderTaskScript(template, { ...metadata, parameters: [{ ...metadata.parameters[0], type: 'text' }] }, { INPUT: value })
  assert.equal(spawnSync('/bin/bash', ['-c', literal], { encoding: 'utf8', timeout: 5000 }).stdout, value)
  assert.equal(run.status, 0); assert.equal(run.stdout, value); assert.equal(existsSync(sentinel), false)
})

test('static Zsh steps retain their interpreter and receive literal parameters, while session setup remains explicit', { skip: !existsSync('/bin/zsh') }, t => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-term-zsh-script-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const originalDirectory = join(directory, 'original')
  const literalDirectory = join(directory, `a b'$(touch INJECTION_MUST_NOT_EXIST)`)
  mkdirSync(originalDirectory); mkdirSync(literalDirectory)
  const task = source([
    step('zsh-directory', `cd '${originalDirectory}' && print -r -- ready`, { directory, environment: { ...environment, shell: 'zsh' } }),
    step('zsh-where', 'print -r -- next; pwd', { directory: originalDirectory, environment: { ...environment, shell: 'zsh' } })
  ])
  assert.equal(spawnSync('/bin/zsh', ['-f', '-c', task.steps[0].command], { encoding: 'utf8' }).status, 0)
  const draft = createTaskScriptDraft(task, task.steps.map(step => step.id))
  const parameter = draft.metadata.parameters.find(parameter => parameter.defaultValue === originalDirectory)
  const rendered = renderTaskScript(draft.content, draft.metadata, { [parameter.name]: literalDirectory })
  const run = spawnSync('/bin/bash', ['-c', rendered], { cwd: directory, encoding: 'utf8', timeout: 5000 })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout, `ready\nnext\n${literalDirectory}\n`)
  assert.equal(existsSync(join(directory, 'INJECTION_MUST_NOT_EXIST')), false)
  assert.match(draft.content, /zsh -f -c/)
  assert.ok(draft.metadata.prerequisites.some(text => text.includes('Zsh 子进程')))
  for (const command of ['autoload example', 'emulate sh', 'zmodload zsh/net/tcp', 'bindkey -e', 'pushd /tmp', 'umask 077', 'builtin -- umask 077', 'noglob builtin eval true']) {
    const candidate = taskScriptCandidates(source([step('setup', command, { environment: { ...environment, shell: 'zsh' } })]))[0]
    assert.equal(candidate.reasonCode, 'session-state')
  }
  const marker = join(directory, 'runtime-marker'), before = join(directory, 'before')
  writeFileSync(before, '')
  const failing = source([
    step('zsh-check', `test -f '${before}' && print -r -- present`, { directory, environment: { ...environment, shell: 'zsh' } }),
    step('zsh-later', `touch '${marker}'`, { directory, environment: { ...environment, shell: 'zsh' } })
  ])
  assert.equal(spawnSync('/bin/zsh', ['-f', '-c', failing.steps[0].command]).status, 0)
  const retryDraft = createTaskScriptDraft(failing, failing.steps.map(step => step.id))
  rmSync(before)
  assert.equal(spawnSync('/bin/bash', ['-c', renderTaskScript(retryDraft.content, retryDraft.metadata)], { timeout: 5000 }).status, 1)
  assert.equal(existsSync(marker), false)
})

test('quoted, embedded, executable, heredoc and unknown parameter positions are rejected', () => {
  const metadata = { version: 1, parameters: [{ name: 'INPUT', label: '输入', type: 'text', required: true, defaultValue: 'x' }] }
  for (const template of ["echo '__AI_TERM_PARAM_INPUT__'", 'echo x__AI_TERM_PARAM_INPUT__', '__AI_TERM_PARAM_INPUT__ --help', 'cat <<EOF\n__AI_TERM_PARAM_INPUT__\nEOF', 'echo $(printf __AI_TERM_PARAM_INPUT__)', 'echo __AI_TERM_PARAM_UNKNOWN__']) assert.throws(() => renderTaskScript(template, metadata))
  const generated = createTaskScriptDraft(source([step('a', 'systemctl restart demo')]), ['a'])
  const service = generated.metadata.parameters.find(item => item.type === 'service')
  assert.throws(() => renderTaskScript(generated.content, generated.metadata, { [service.name]: '--now demo; echo bad' }), /服务参数/)
})
