import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const debuggerUrl = process.env.AI_TERM_CDP_URL ?? 'http://127.0.0.1:9231'
const fixtureUrl = 'http://127.0.0.1:5173/tests/browser/host-knowledge.fixture.html'
const outputDirectory = mkdtempSync(join(tmpdir(), 'ai-term-host-knowledge-check-'))
const target = await fetch(`${debuggerUrl}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(5000) }).then(response => response.json())
const socket = new WebSocket(target.webSocketDebuggerUrl)
const requests = new Map()
const exceptions = []
const checks = []
const reasoningScreenshots = []
let sequence = 0

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { requests.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 10000)
    requests.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

socket.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  const request = requests.get(message.id)
  if (request) {
    clearTimeout(request.timer)
    requests.delete(message.id)
    if (message.error) request.reject(new Error(JSON.stringify(message.error)))
    else request.resolve(message.result)
  }
  if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails)
})

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}

async function waitFor(expression) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error(`UI timeout: ${expression}`)
}

async function click(selector) {
  let position
  for (let attempt = 0; attempt < 4; attempt++) {
    await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error('Missing element: ' + ${JSON.stringify(selector)});
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    })()`)
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    position = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      const rectangle = element.getBoundingClientRect();
      return { x: rectangle.x + rectangle.width / 2, y: rectangle.y + rectangle.height / 2 };
    })()`)
    if (await evaluate(`document.querySelector(${JSON.stringify(selector)}).contains(document.elementFromPoint(${position.x}, ${position.y}))`)) break
    if (attempt === 3) {
      const debug = await evaluate(`({ position: ${JSON.stringify(position)}, target: document.querySelector(${JSON.stringify(selector)}).outerHTML, hit: document.elementFromPoint(${position.x}, ${position.y})?.outerHTML.slice(0, 400), scroll: document.querySelector('.chat-message-list').scrollTop })`)
      throw new Error(`Click target is obscured: ${selector}: ${JSON.stringify(debug)}`)
    }
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position, button: 'left', clickCount: 1 })
}

async function screenshot(name) {
  await evaluate('document.fonts.ready.then(() => true)')
  await evaluate('Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))).then(() => true)')
  const capture = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const path = join(outputDirectory, name)
  writeFileSync(path, Buffer.from(capture.data, 'base64'))
  return path
}

async function button(text) {
  await evaluate(`(() => { document.querySelector('[data-knowledge-test]')?.removeAttribute('data-knowledge-test'); const el = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!el) throw Error('Missing button'); el.setAttribute('data-knowledge-test', 'true'); })()`)
  await click('[data-knowledge-test]')
}
async function input(selector, value, event = 'input') { await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); })()`) }
async function ask() {
  await input('.chat-input-shell textarea', '检查 nginx 配置')
  await click('[aria-label=发送]')
  await waitFor('!document.querySelector("[aria-label=停止]")')
}
try {
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  await send('Page.enable'); await send('Runtime.enable'); await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1000, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: fixtureUrl }); await waitFor('window.knowledgeReady && document.querySelector(".knowledge-toggle")')
  await click('.knowledge-toggle'); await waitFor('document.querySelector(".knowledge-scope")')
  await input('.knowledge-import select', 'done', 'change'); await button('查看候选')
  await waitFor('document.querySelector(".knowledge-candidate")'); await click('.knowledge-candidate')
  await waitFor('document.querySelector(".knowledge-form")')
  assert.equal(await evaluate('knowledgeFixture.state.records.length'), 0)
  assert.equal(await evaluate('document.querySelector(".knowledge-form button[type=submit]").disabled'), true)
  await input('.knowledge-form input[maxlength="80"]', 'nginx 配置')
  await input('.knowledge-form input[type=number]', '7')
  await click('.knowledge-confirm input'); await button('保存知识'); await waitFor('knowledgeFixture.state.records.length === 1 && !document.querySelector(".knowledge-form")')
  assert.equal(await evaluate('JSON.stringify(knowledgeFixture.state.records).includes("NEVER_SAVE_FILE_BODY")'), false)
  assert.equal(await evaluate('knowledgeFixture.state.records[0].source.evidence.stepId'), 'config-read')
  assert.equal(await evaluate('knowledgeFixture.state.records[0].expiresAt - knowledgeFixture.state.records[0].confirmedAt'), 7 * 86400000)
  await ask(); assert.equal(await evaluate('knowledgeFixture.state.requests.at(-1).hostKnowledgeContext.includes("/etc/nginx/nginx.conf")'), true)
  await button('编辑'); await input('.knowledge-form input[maxlength="600"]', '/opt/nginx/nginx.conf'); await click('.knowledge-confirm input'); await button('保存知识')
  await waitFor('knowledgeFixture.state.records[0].value === "/opt/nginx/nginx.conf" && !document.querySelector(".knowledge-form")')
  await ask(); assert.equal(await evaluate('knowledgeFixture.state.requests.at(-1).hostKnowledgeContext.includes("/etc/nginx/nginx.conf")'), false)
  await evaluate('knowledgeFixture.state.width = 360'); await evaluate('document.querySelector(".knowledge-toggle").scrollIntoView({ block: "start" })')
  const screen = await screenshot('host-knowledge-dark-360.png')
  assert.equal(await evaluate('document.querySelector(".knowledge-panel").scrollWidth <= document.querySelector(".knowledge-panel").clientWidth + 1'), true)
  await evaluate('knowledgeFixture.props.config.contextPolicy = "manual-attachments"'); await ask()
  assert.equal(await evaluate('knowledgeFixture.state.requests.at(-1).hostKnowledgeContext'), '')
  await evaluate('knowledgeFixture.props.config.contextPolicy = "active-command-output"; knowledgeFixture.target.context.environmentScope = "different-container"')
  await button('刷新记录'); await waitFor('document.querySelector(".knowledge-scope")?.textContent.includes("different-container")')
  assert.equal(await evaluate('[...document.querySelectorAll(".knowledge-record button")].find(b => b.textContent === "编辑").disabled'), true)
  await ask(); assert.equal(await evaluate('JSON.parse(knowledgeFixture.state.requests.at(-1).hostKnowledgeContext).entries.length'), 0)
  await button('删除'); await waitFor('knowledgeFixture.state.records.length === 0'); await ask()
  assert.equal(await evaluate('JSON.parse(knowledgeFixture.state.requests.at(-1).hostKnowledgeContext).entries.length'), 0)
  assert.deepEqual(exceptions, [])
  console.log(JSON.stringify({ result: 'passed', screenshot: screen, nativeBackendTested: false, checks: ['Task facts require explicit user save', 'Source metadata survives while body is excluded', 'Actual chat request uses edited and deleted state', 'Provider privacy policy disables automatic knowledge', 'Other containers cannot reuse or edit old facts', '360 px panel has no horizontal overflow'] }, null, 2))
} catch (error) { console.error('Browser failure screenshot:', await screenshot('failure.png').catch(() => 'unavailable')); throw error }
finally { for (const request of requests.values()) clearTimeout(request.timer); socket.close(); await fetch(`${debuggerUrl}/json/close/${target.id}`).catch(() => {}) }
