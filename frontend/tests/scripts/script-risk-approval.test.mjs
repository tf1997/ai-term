import assert from 'node:assert/strict'
import test from 'node:test'
import { createRenderer, reactive, ref } from 'vue'
import { useScriptExecution } from '../../src/domains/scripts/application/useScriptExecution'
import { prepareScriptForExecution } from '../../src/domains/scripts/domain/scriptExecution'
import { commandRiskCases } from '../shared/command-risk-cases.mjs'

const renderer = createRenderer({
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
  parentNode: () => null, nextSibling: () => null
})

function mountExecution(t) {
  let execution
  const writes = []
  const panelError = ref('')
  const props = reactive({
    connectionId: 'local', executionTargetConnectionIds: ['local'],
    executionTargetLabel: 'fixture', config: {}, apiKey: ''
  })
  const app = renderer.createApp({ setup() {
    execution = useScriptExecution({
      props, emit: (event, data) => writes.push({ event, data }), panelError,
      sourceCommands: () => [], recordedOutput: () => '', hasUsableConfig: () => false,
      connectionLabel: id => id
    }, {})
    return () => null
  } })
  app.mount({})
  t.after(() => app.unmount())
  return { execution, writes, panelError, props }
}

for (const { name, command } of commandRiskCases) {
  test(`脚本实际执行入口先审查原文：${name}`, t => {
    const { execution, writes, panelError } = mountExecution(t)
    execution.executeScriptContent(command, { connectionId: 'local', name: 'check.sh' })
    assert.equal(panelError.value, '')
    assert.equal(execution.scriptRiskConfirmOpen.value, true)
    assert.ok(execution.pendingScriptRisks.value.length)
    assert.deepEqual(writes, [], '未确认时不得派发 Base64 包装命令')
    execution.confirmPendingScriptExecution()
    assert.equal(writes.length, 1)
    assert.equal(writes[0].event, 'writeTerminalInput')
    const payload = /printf '%s' '([^']+)'/.exec(writes[0].data)?.[1]
    assert.equal(Buffer.from(payload, 'base64').toString('utf8'), prepareScriptForExecution(command, 'bash'))
    assert.equal(execution.scriptRiskConfirmOpen.value, false)
  })
}

test('安全脚本仍可直接派发，取消风险审查不派发', t => {
  const { execution, writes } = mountExecution(t)
  execution.executeScriptContent('printf ready; ls')
  assert.equal(writes.length, 1)
  execution.executeScriptContent('bash -lc "rm -rf /tmp/example"')
  assert.equal(execution.scriptRiskConfirmOpen.value, true)
  execution.closeScriptRiskConfirm()
  assert.equal(writes.length, 1)
})


test('task parameters are rendered before risk analysis and every changed value is reviewed again', async t => {
  const { execution, writes, panelError, props } = mountExecution(t)
  const metadata = { version: 1, parameters: [{ name: 'DIR', label: '目录', type: 'directory', defaultValue: '/srv/app', required: true }] }
  execution.executeScriptContent('rm -rf __AI_TERM_PARAM_DIR__', { connectionId: 'local', taskMetadata: metadata, parameterValues: { DIR: '/etc' } })
  assert.equal(panelError.value, ''); assert.equal(execution.pendingScriptExecution.value, "rm -rf '/etc'")
  assert.ok(execution.pendingScriptRisks.value.length); assert.equal(writes.length, 0)
  execution.closeScriptRiskConfirm()
  const calls = []; props.applicationCommandExecutor = async (content, kind) => { calls.push({ content, kind }); return false }
  execution.executeScriptContent('ls __AI_TERM_PARAM_DIR__', { connectionId: 'local', taskMetadata: metadata, parameterValues: { DIR: '/first path' } })
  execution.executeScriptContent('ls __AI_TERM_PARAM_DIR__', { connectionId: 'local', taskMetadata: metadata, parameterValues: { DIR: '/second path' } })
  await Promise.resolve()
  assert.deepEqual(calls.map(call => call.content), ["ls '/first path'", "ls '/second path'"])
  assert.ok(calls.every(call => call.kind === 'bash-script')); assert.equal(writes.length, 0)
  execution.executeScriptContent('ls __AI_TERM_PARAM_DIR__')
  assert.match(panelError.value, /缺少参数定义/); assert.equal(calls.length, 2)
})
