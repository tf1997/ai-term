import assert from 'node:assert/strict'
import test from 'node:test'
import { shallowRef, createRenderer } from 'vue'
import { createApplicationCommandExecutor } from '../../src/domains/terminal/application/useApplicationCommandExecutor'
import { useCommandPolicyReview } from '../../src/domains/terminal/application/useCommandPolicyReview'
import { parseCommandContext } from '../../src/domains/terminal/domain/commandContext'

function fixture({ decision = 'ask', review = async () => true, failDispatch = false } = {}) {
  const tabs = [{ id: 'one', title: 'Host one', connectionId: 'profile-one', connectionGeneration: 1 }, { id: 'two', title: 'Host two', connectionId: 'profile-two', connectionGeneration: 1 }]
  const approved = [], dispatched = [], cancelled = [], reviewed = []
  let selected = ['one', 'two']
  let sequence = 0
  const panes = shallowRef(Object.fromEntries(tabs.map(tab => [tab.id, {
    async prepareCommandIntent(source, operation, capture) {
      return { source, operation, capture: { kind: capture ? 'sentinel' : 'none', nonce: 'fixture', internal: false },
        reference: { id: `${tab.id}-${++sequence}`, operation, target: { sessionId: tab.id, context: { workingDirectory: '/srv', user: '1000' } } },
        analysis: { decision, risks: [], unknownReasons: [] }, terminalInput: 'stored transport\r' }
    },
    dispatchPreparedCommand(intent, failed, written) {
      assert.equal(intent.reference.target.sessionId, tab.id)
      dispatched.push(intent)
      if (failDispatch) failed(Error('partial write; effect unknown'))
      else written()
      return true
    }
  }])))
  const api = {
    async approveCommandIntent(reference, source) { approved.push({ reference, source }) },
    async cancelCommandIntent(reference) { cancelled.push(reference.id) }
  }
  const executor = createApplicationCommandExecutor({ panes, tabs: () => tabs, targets: () => selected,
    isAgentControlled: () => false, review: async (...args) => { reviewed.push(args); return review(...args) }
  }, api)
  return { ...executor, panes, tabs, approved, dispatched, cancelled, reviewed, select: value => { selected = value } }
}

test('多目标审批和派发绑定完整脚本文本及原目标，选择变化不转移审批', async () => {
  const script = "printf 'one\ntwo'\n# preserved source"
  const run = fixture({ review: async () => { run.select(['two']); return true } })
  assert.equal(await run.execute(script, 'bash-script'), true)
  assert.equal(run.reviewed.length, 1)
  assert.deepEqual(run.reviewed[0][0].map(item => item.label), ['Host one', 'Host two'])
  assert.deepEqual(run.approved.map(item => item.source), [script, script])
  assert.deepEqual(run.dispatched.map(intent => intent.reference.target.sessionId), ['one', 'two'])
  assert.equal(run.cancelled.length, 2)
})

test('取消不保存批准也不派发；来源变化即使分析允许也需要复核', async () => {
  const run = fixture({ decision: 'allow', review: async () => false })
  assert.equal(await run.execute('pwd', 'command', 'another-profile'), false)
  assert.match(run.reviewed[0][1], /来源连接/)
  assert.equal(run.approved.length, 0)
  assert.equal(run.dispatched.length, 0)
  assert.equal(run.cancelled.length, 2)
})

test('审批等待期间重连或组件替换后不能派发任何目标', async () => {
  for (const mutate of [run => { run.tabs[0].connectionGeneration++ }, run => { run.panes.value.one = { ...run.panes.value.one } }]) {
    const run = fixture({ review: async () => { mutate(run); return true } })
    await assert.rejects(run.execute('pwd', 'command'), /目标已经变化/)
    assert.equal(run.dispatched.length, 0)
    assert.equal(run.cancelled.length, 2)
  }
})

test('部分写入失败不会重放或继续发送剩余目标', async () => {
  const run = fixture({ failDispatch: true })
  await assert.rejects(run.execute('printf changed', 'command'), /effect unknown/)
  assert.equal(run.dispatched.length, 1)
  assert.equal(run.cancelled.length, 2)
})

test('Agent 分析期间重连会取消迟到的执行记录', async () => {
  const run = fixture()
  const prepare = run.panes.value.one.prepareCommandIntent
  run.panes.value.one.prepareCommandIntent = async (...args) => {
    const intent = await prepare(...args)
    run.tabs[0].connectionGeneration++
    return intent
  }
  await assert.rejects(run.agentPolicy.prepare('one', 1, 'pwd'), /目标已经变化/)
  assert.equal(run.cancelled.length, 1)
  assert.equal(run.dispatched.length, 0)
})

test('审查窗口不能被第二次点击替换，卸载会取消等待', async () => {
  const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null })
  let review
  const app = renderer.createApp({ setup() { review = useCommandPolicyReview(); return () => null } })
  app.mount({})
  const first = review.review([{ label: 'original', intent: {} }])
  await assert.rejects(review.review([{ label: 'replacement', intent: {} }]), /当前命令审查/)
  assert.equal(review.pending.value.items[0].label, 'original')
  app.unmount()
  assert.equal(await first, false)
})

test('环境报告保留目录空格，拒绝控制字符和不完整输出', () => {
  const b64 = value => Buffer.from(value).toString('base64')
  const output = `bash\n${b64('/srv/a b\n')}\nAI_TERM_CONTEXT_USER\n${b64('1000\n')}\nAI_TERM_CONTEXT_SCOPE\n${b64('host\n1000\n1 /\n')}\nAI_TERM_CONTEXT_END`
  assert.deepEqual(parseCommandContext(output), { shell: 'bash', workingDirectory: '/srv/a b', user: '1000', environmentScope: '["host","1000","1 /"]' })
  assert.equal(parseCommandContext(output.replace('AI_TERM_CONTEXT_END', 'truncated')), undefined)
  assert.equal(parseCommandContext(output.replace(b64('/srv/a b\n'), b64('/srv/with trailing space \n'))).workingDirectory, '/srv/with trailing space ')
  assert.equal(parseCommandContext(output.replace(b64('/srv/a b\n'), b64('/srv/a\nb\n'))), undefined)
})
