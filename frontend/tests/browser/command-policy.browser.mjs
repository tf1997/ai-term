import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const cdp = process.env.AI_TERM_CDP_URL ?? 'http://127.0.0.1:9231'
const url = process.env.AI_TERM_POLICY_FIXTURE_URL ?? 'http://127.0.0.1:5173/tests/browser/command-policy.fixture.html'
const target = await fetch(`${cdp}/json/new?about:blank`, { method: 'PUT' }).then(result => result.json())
const socket = new WebSocket(target.webSocketDebuggerUrl)
let sequence = 0
const pending = new Map(), exceptions = []
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data)
  if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params)
  const request = pending.get(message.id)
  if (!request) return
  clearTimeout(request.timer); pending.delete(message.id)
  if (message.error) request.reject(Error(JSON.stringify(message.error)))
  else request.resolve(message.result)
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence
  pending.set(id, { resolve, reject, timer: setTimeout(() => reject(Error(`CDP timeout: ${method}`)), 10000) })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
async function until(expression) {
  const end = Date.now() + 8000
  while (Date.now() < end) {
    if (await evaluate(expression)) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw Error(`UI timeout: ${expression}`)
}
const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
const screenshots = []
try {
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }))
  await send('Runtime.enable'); await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url })
  await until('Boolean(window.commandPolicyFixture?.start)')
  await evaluate('commandPolicyFixture.start()')
  await until('Boolean(document.querySelector("[role=dialog]"))')
  assert.equal(await evaluate('document.querySelector(".primary-button").disabled'), true)
  assert.equal(await evaluate('document.querySelectorAll(".policy-source span").length'), 71)
  assert.ok(await evaluate('document.querySelector("[role=dialog]").textContent.includes("operator@fixture")'))
  assert.ok(await evaluate('document.querySelector(".policy-summary").textContent.includes("最高风险：高风险")'))
  assert.ok(await evaluate('document.querySelector("[role=dialog]").textContent.includes("container:fixture-app")'))
  assert.equal(await evaluate('document.querySelector("details").open'), false)
  const artifactDirectory = await mkdtemp(join(tmpdir(), 'ai-term-policy-review-'))
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false })
  for (const theme of ['dark', 'light']) {
    await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; document.documentElement.classList.toggle('theme-light', ${theme === 'light'})`)
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const bounds = await evaluate('(() => { const el = document.querySelector("[role=dialog]"), rect = el.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: innerWidth, scroll: el.scrollWidth, client: el.clientWidth } })()')
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.scroll <= bounds.client + 1, `${theme} narrow review must fit: ${JSON.stringify(bounds)}`)
    const screenshot = join(artifactDirectory, `command-policy-${theme}-360.png`)
    await writeFile(screenshot, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
    screenshots.push(screenshot)
  }
  await click('.policy-review-body a')
  await until('document.querySelector(".policy-source span:target")?.textContent.includes("final_review_line")')
  assert.equal(await evaluate('document.querySelector("details").open'), true)
  await click('.modal-footer input')
  await click('.primary-button')
  await until('commandPolicyFixture.outcome === true')
  assert.deepEqual(await evaluate('commandPolicyFixture.writes'), await evaluate('commandPolicyFixture.approvals.map(item => item.source)'))
  await evaluate('commandPolicyFixture.start()')
  await until('Boolean(document.querySelector("[role=dialog]"))')
  assert.equal(await evaluate('document.querySelector(".primary-button").disabled'), true)
  assert.equal(await evaluate('document.querySelector("details").open'), false)
  await click('.modal-header button')
  await until('commandPolicyFixture.outcome === false')
  assert.equal(await evaluate('commandPolicyFixture.writes.length'), 1)
  await evaluate('commandPolicyFixture.start()')
  await until('Boolean(document.querySelector("[role=dialog]"))')
  await evaluate('commandPolicyFixture.reconnect()')
  await click('.modal-footer input'); await click('.primary-button')
  await until('commandPolicyFixture.error.includes("目标已经变化")')
  assert.equal(await evaluate('commandPolicyFixture.writes.length'), 1)
  await evaluate('commandPolicyFixture.nextDecision = "deny"; commandPolicyFixture.start()')
  await until('Boolean(document.querySelector("[role=dialog]"))')
  assert.equal(await evaluate('Boolean(document.querySelector(".primary-button"))'), false)
  await click('.modal-header button')
  assert.deepEqual(exceptions, [])
  console.log(JSON.stringify({ result: 'passed', nativeBackendTested: false, checks: ['highest risk and environment summary', 'narrow dark and light themes', 'complete source expands on risk jump', 'one-use confirmation', 'cancel', 'reconnect', 'deny'], screenshots }, null, 2))
} finally {
  socket.close()
  await fetch(`${cdp}/json/close/${target.id}`).catch(() => {})
}
