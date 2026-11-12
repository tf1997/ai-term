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
  assert.equal(await evaluate('document.querySelector(".policy-command").open'), false)
  assert.equal(await evaluate('document.querySelector(".policy-environment").open'), false)
  await click('.policy-environment summary')
  assert.equal(await evaluate('document.querySelector(".policy-environment").open'), true)
  await click('.policy-environment summary')
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
  assert.equal(await evaluate('document.querySelector(".policy-command").open'), true)
  await click('.modal-footer input')
  await click('.primary-button')
  await until('commandPolicyFixture.outcome === true')
  assert.deepEqual(await evaluate('commandPolicyFixture.writes'), await evaluate('commandPolicyFixture.approvals.map(item => item.source)'))
  await evaluate('commandPolicyFixture.start()')
  await until('Boolean(document.querySelector("[role=dialog]"))')
  assert.equal(await evaluate('document.querySelector(".primary-button").disabled'), true)
  assert.equal(await evaluate('document.querySelector(".policy-command").open'), false)
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
  await until('!document.querySelector("[role=dialog]")')

  // The screenshot's short interactive command opens in full and retains one-use approval.
  await evaluate(`commandPolicyFixture.nextDecision = 'ask'; document.querySelector('.policy-fixture-trigger').focus(); commandPolicyFixture.start({
    source: 'vim docker-compose-hermes-v2.yml', operation: 'command',
    context: { user: '0', workingDirectory: '/home/tf/open-hermes', environmentScope: '["10-0-16-250","0","128/","mnt:[4026531841]"]' },
    analysis: { highestSeverity: 'medium', risks: [{ kind: 'execution', severity: 'medium', message: '将启动交互式编辑器。', range: { startLine: 1 } }] }
  })`)
  await until('Boolean(document.querySelector("[role=dialog]"))')
  assert.equal(await evaluate('document.querySelector(".policy-command").open'), true)
  assert.equal(await evaluate('document.activeElement.className'), 'policy-review-dialog')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', modifiers: 8 })
  assert.equal(await evaluate('document.activeElement.className'), 'policy-cancel')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab' })
  assert.equal(await evaluate('document.activeElement.className'), 'policy-close')
  assert.equal(await evaluate('document.querySelector(".primary-button").disabled'), true)
  await evaluate('document.querySelector("[role=dialog]").focus()')
  for (const [theme, width] of [['light', 1000], ['dark', 1000], ['light', 360], ['dark', 360]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false })
    await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; document.documentElement.classList.toggle('theme-light', ${theme === 'light'})`)
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const bounds = await evaluate('(() => { const el = document.querySelector("[role=dialog]"), rect = el.getBoundingClientRect(); return { left: rect.left, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight, scroll: el.scrollWidth, client: el.clientWidth, background: getComputedStyle(el).backgroundColor } })()')
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.bottom <= bounds.height && bounds.scroll <= bounds.client + 1, `${theme} ${width}px short review must fit: ${JSON.stringify(bounds)}`)
    assert.equal(bounds.background, theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(21, 25, 31)')
    const screenshot = join(artifactDirectory, `command-policy-short-${theme}-${width}.png`)
    await writeFile(screenshot, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
    screenshots.push(screenshot)
  }
  await click('.modal-footer input')
  assert.equal(await evaluate('document.querySelector(".primary-button").disabled'), false)
  await send('Emulation.setDeviceMetricsOverride', { width: 1380, height: 590, deviceScaleFactor: 1, mobile: false })
  const actionBounds = await evaluate('(() => { const rect = document.querySelector(".primary-button").getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, height: innerHeight } })()')
  assert.ok(actionBounds.top >= 0 && actionBounds.bottom <= actionBounds.height, 'Confirmation stays visible in a short desktop window')
  await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false })
  for (const theme of ['light', 'dark']) {
    await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; document.documentElement.classList.toggle('theme-light', ${theme === 'light'})`)
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const clip = await evaluate('(() => { const rect = document.querySelector("[role=dialog]").getBoundingClientRect(); return { x: rect.x - 24, y: rect.y - 24, width: rect.width + 48, height: rect.height + 48, scale: 1 } })()')
    const screenshot = join(artifactDirectory, `command-policy-ready-${theme}.png`)
    await writeFile(screenshot, Buffer.from((await send('Page.captureScreenshot', { format: 'png', clip })).data, 'base64'))
    screenshots.push(screenshot)
  }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  await until('commandPolicyFixture.outcome === false')
  assert.equal(await evaluate('document.activeElement === document.querySelector(".policy-fixture-trigger")'), true)
  assert.equal(await evaluate('commandPolicyFixture.writes.length'), 1)

  await evaluate(`commandPolicyFixture.start({ source: 'unrecognized-command', operation: 'command', analysis: {
    highestSeverity: null, analysisStatus: 'unknown', risks: [], unknownReasons: [{ message: '无法确认命令行为', range: { startLine: 1 } }]
  } })`)
  await until('Boolean(document.querySelector("[role=dialog]"))')
  assert.equal(await evaluate('document.querySelector(".primary-button").disabled'), true)
  assert.equal(await evaluate('document.querySelector(".policy-summary").textContent'), '风险尚未确认')
  assert.ok(await evaluate('document.querySelector(".policy-risk").textContent.includes("无法确认命令行为")'))
  await click('.modal-header button')
  assert.deepEqual(exceptions, [])
  console.log(JSON.stringify({ result: 'passed', nativeBackendTested: false, checks: ['highest risk and expandable environment', 'desktop and narrow dark and light themes', 'short command preview', 'complete source expands on risk jump', 'keyboard focus and Escape', 'one-use confirmation', 'unknown analysis', 'cancel', 'reconnect', 'deny'], screenshots }, null, 2))
} finally {
  socket.close()
  await fetch(`${cdp}/json/close/${target.id}`).catch(() => {})
}
