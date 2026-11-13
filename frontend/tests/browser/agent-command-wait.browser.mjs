import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const debuggerUrl = process.env.AI_TERM_CDP_URL ?? 'http://127.0.0.1:9231'
const fixtureUrl = process.env.AI_TERM_AI_FIXTURE_URL ?? 'http://127.0.0.1:5173/tests/browser/ai-chat.fixture.html'
const target = await fetch(`${debuggerUrl}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json())
const socket = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map(), errors = []
let sequence = 0
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data), request = pending.get(message.id)
  if (request) {
    clearTimeout(request.timer); pending.delete(message.id)
    message.error ? request.reject(Error(JSON.stringify(message.error))) : request.resolve(message.result)
  }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence
  const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)) }, 10000)
  pending.set(id, { resolve, reject, timer })
  socket.send(JSON.stringify({ id, method, params }))
})
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
async function waitFor(expression) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw Error(`UI timeout: ${expression}`)
}
const card = '[data-step-id="waiting-tail"]'
const button = text => `[...document.querySelectorAll('${card} button')].find(button => button.textContent.trim() === ${JSON.stringify(text)})`
async function start(timeout = 120000) {
  await evaluate(`aiFixture.beginRuntime('agent', { agentBuiltinReadonlyEnabled: true, agentAllowlistPatterns: ['tail'], agentCommandTimeoutMs: ${timeout} })`)
  await evaluate(`(() => { const input = document.querySelector('.chat-composer textarea'); input.value = '读取日志'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await evaluate(`document.querySelector('.chat-send').click()`)
  await waitFor('aiFixture.runtime.requests.length === 1')
  await evaluate(`aiFixture.runtime.reply('观察日志', [{ id: 'waiting-tail', command: 'tail -f app.log' }])`)
  await waitFor(`document.querySelector('${card}[data-status=running]') && ${button('中断并继续')}`)
}
const output = mkdtempSync(join(tmpdir(), 'ai-term-command-wait-ui-'))
try {
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  await send('Runtime.enable'); await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 950, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: fixtureUrl })
  await waitFor('Boolean(window.aiFixture)')
  await evaluate(`aiFixture.configure({ width: 390, theme: 'light', zoom: 1 })`)
  await start()
  assert.ok(await evaluate(`${button('停止等待')}` + ' !== undefined'), 'stop is available before timeout')
  assert.ok(await evaluate(`document.querySelector('${card}').textContent.includes('持续监听')`))
  await evaluate(`aiFixture.runtime.output = 'captured log output'`)
  await waitFor(`aiFixture.state.props.messages.some(message => message.agentSteps?.some(step => step.output === 'captured log output'))`)
  await evaluate(`document.querySelector('${card}').scrollIntoView({ block: 'center' })`)
  const metrics = await evaluate(`(() => { const el = document.querySelector('${card}'); return { width: el.clientWidth, contentWidth: el.scrollWidth } })()`)
  assert.ok(metrics.contentWidth <= metrics.width + 1, 'narrow card fits its width')
  writeFileSync(join(output, 'running.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  await evaluate(`${button('中断并继续')}.click()`)
  await waitFor('aiFixture.runtime.interrupts === 1')
  assert.equal(await evaluate(`${button('中断并继续')}.disabled`), true)
  assert.equal(await evaluate('aiFixture.runtime.requests.length'), 0, 'wait for actual command completion')
  await evaluate(`aiFixture.runtime.finishCommand({ output: 'captured log output', exitCode: 130 })`)
  await waitFor('aiFixture.runtime.requests.length === 1')
  assert.equal(await evaluate(`JSON.parse(aiFixture.runtime.requests[0].request.turns.find(turn => turn.kind === 'toolResult').content).interrupted`), true)
  const feedback = await evaluate(`JSON.parse(aiFixture.runtime.requests[0].request.turns.find(turn => turn.kind === 'toolResult').content)`)
  assert.equal(feedback.status, 'interrupted_by_user')
  assert.equal(feedback.interruption.requestedBy, 'user')
  assert.equal(feedback.interruption.hadOutput, true)
  assert.ok(feedback.interruption.waitedMs >= 1000)
  assert.match(feedback.note, /未取消任务.*不要原样重跑/)
  assert.ok(await evaluate(`document.querySelector('${card}').textContent.includes('已中断')`))
  await evaluate(`aiFixture.runtime.reply('已取得日志')`)
  await waitFor(`aiFixture.state.props.messages.some(message => message.agentStatus === 'done' && message.text === '已取得日志')`)

  await start(100)
  await waitFor(`${button('继续等待')} !== undefined`)
  await evaluate(`aiFixture.runtime.finishCommand({ output: 'finished while awaiting decision' })`)
  await waitFor('aiFixture.runtime.requests.length === 1')
  assert.equal(await evaluate(`${button('继续等待')} !== undefined`), false, 'stale timeout prompt is cleared')
  await evaluate(`aiFixture.runtime.reply('完成')`)
  await waitFor(`aiFixture.state.props.messages.some(message => message.agentStatus === 'done' && message.text === '完成')`)

  await start()
  await evaluate(`aiFixture.runtime.output = 'output retained on stop'; ${button('停止等待')}.click()`)
  await waitFor(`aiFixture.state.props.messages.some(message => message.agentStatus === 'stopped')`)
  assert.equal(await evaluate('aiFixture.runtime.interrupts'), 0)
  assert.ok(await evaluate(`aiFixture.state.props.messages.some(message => message.agentSteps?.some(step => step.output === 'output retained on stop'))`))
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'passed', screenshot: join(output, 'running.png'), checks: ['early stop', 'interrupt once', 'completion evidence', 'timeout completion', 'retained output', 'narrow layout'] }, null, 2))
} finally {
  await fetch(`${debuggerUrl}/json/close/${target.id}`).catch(() => {})
  socket.close()
}
