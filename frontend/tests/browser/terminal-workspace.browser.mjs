import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const debuggerUrl = process.env.AI_TERM_CDP_URL ?? 'http://127.0.0.1:9231'
const appUrl = process.env.AI_TERM_PREVIEW_URL ?? 'http://127.0.0.1:4179'
const outputDirectory = mkdtempSync(join(tmpdir(), 'ai-term-workspace-check-'))
const target = await fetch(`${debuggerUrl}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(5000) }).then(response => response.json())
const socket = new WebSocket(target.webSocketDebuggerUrl)
const requests = new Map()
const exceptions = []
const dialogs = []
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
  if (message.method === 'Page.javascriptDialogOpening') {
    dialogs.push(message.params.message)
    void send('Page.handleJavaScriptDialog', { accept: true }).catch(error => exceptions.push(String(error)))
  }
})

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}

async function waitFor(expression) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error(`UI timeout: ${expression}`)
}

async function point(selector, visibleAncestor = false) {
  return evaluate(`(() => {
    let element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('Missing element: ' + ${JSON.stringify(selector)});
    if (${visibleAncestor}) {
      while (element.parentElement && !element.getBoundingClientRect().width) element = element.parentElement;
    }
    element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    const rectangle = element.getBoundingClientRect();
    return { x: rectangle.x + rectangle.width / 2, y: rectangle.y + rectangle.height / 2 };
  })()`)
}

async function click(selector, button = 'left') {
  const hoverPosition = await point(selector, true)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...hoverPosition })
  await waitFor(`document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect().width > 0`)
  const position = await point(selector)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position })
  await waitFor(`document.querySelector(${JSON.stringify(selector)})?.contains(document.elementFromPoint(${position.x}, ${position.y}))`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position, button, clickCount: 1 })
}

async function menuAction(label) {
  await click('.session-tab-strip .tab.active', 'right')
  await waitFor('Boolean(document.querySelector(".context-menu"))')
  const index = await evaluate(`Array.from(document.querySelectorAll('.context-menu button')).findIndex(button => button.textContent.trim() === ${JSON.stringify(label)})`)
  assert.ok(index >= 0, `Missing menu item: ${label}`)
  await click(`.context-menu button:nth-of-type(${index + 1})`)
  await waitFor('!document.querySelector(".context-menu")')
}

async function openHistory() {
  if (!await evaluate('Boolean(document.querySelector(".session-history-popover"))')) await click('[title="会话列表"]')
  await waitFor('Boolean(document.querySelector(".session-history-row"))')
}

async function dismissToasts() {
  while (await evaluate('Boolean(document.querySelector(".toast-stack button"))')) await click('.toast-stack button')
}

async function screenshot(name) {
  await evaluate('document.fonts.ready.then(() => true)')
  const capture = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const path = join(outputDirectory, name)
  writeFileSync(path, Buffer.from(capture.data, 'base64'))
  return path
}

try {
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: appUrl })
  await waitFor('document.querySelectorAll(".session-tab-strip .tab").length === 1 && Boolean(document.querySelector(".xterm"))')
  assert.equal(await evaluate('Boolean(window.__TAURI_IPC__)'), false, 'Run this smoke test against browser preview, not a native workspace.')
  await evaluate('window.__firstTerminalPane = document.querySelector(".terminal-stack").firstElementChild; window.__firstXterm = document.querySelector(".xterm")')
  await click('.session-tab-strip .tab', 'right')
  await waitFor('Boolean(document.querySelector(".context-menu"))')
  assert.equal(await evaluate('Array.from(document.querySelectorAll(".context-menu button")).find(button => button.textContent.includes("关闭终端标签"))?.disabled'), true)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await waitFor('!document.querySelector(".context-menu")')

  for (let count = 2; count <= 4; count++) {
    await menuAction('新建本地终端')
    await waitFor(`document.querySelectorAll('.session-tab-strip .tab').length === ${count}`)
  }
  await waitFor('document.querySelectorAll(".terminal-stack .xterm").length === 4')
  await menuAction('选择全部终端')
  assert.equal(await evaluate('document.querySelectorAll(".tab.target").length'), 4)
  await click('.session-tab-strip .tab:first-child')
  assert.equal(await evaluate('document.querySelectorAll(".tab.target").length'), 4)
  await click('.tab.active .terminal-target-toggle')
  await waitFor('document.querySelectorAll(".tab.target").length === 1')
  assert.equal(await evaluate('document.querySelector(".tab.active").classList.contains("target")'), true)
  assert.equal(await evaluate('document.querySelector(".terminal-stack").firstElementChild === window.__firstTerminalPane && document.querySelector(".xterm") === window.__firstXterm'), true)
  assert.equal(await evaluate('Array.from(document.querySelector(".terminal-stack").children).filter(element => getComputedStyle(element).display !== "none").length'), 1)

  for (let count = 5; count <= 16; count++) {
    await menuAction('新建本地终端')
    await waitFor(`document.querySelectorAll('.session-tab-strip .tab').length === ${count}`)
  }
  await waitFor('Boolean(document.querySelector(".session-tab-scrollbar-thumb"))')
  await click('.session-tab-strip .tab:first-child')
  await waitFor('document.querySelector(".session-tab-strip").scrollLeft < 1')
  const stripPoint = await point('.session-tab-strip')
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...stripPoint, deltaX: 0, deltaY: 240 })
  await waitFor('document.querySelector(".session-tab-strip").scrollLeft > 0')
  const beforeDrag = await evaluate('document.querySelector(".session-tab-strip").scrollLeft')
  const thumbPoint = await point('.session-tab-scrollbar-thumb')
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...thumbPoint, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: thumbPoint.x + 90, y: thumbPoint.y, button: 'left', buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: thumbPoint.x + 90, y: thumbPoint.y, button: 'left', clickCount: 1 })
  await waitFor(`document.querySelector('.session-tab-strip').scrollLeft > ${beforeDrag}`)
  if (await evaluate('Boolean(document.querySelector(".app-shell.theme-light"))')) await click('button[title="切换深色主题"]')
  await waitFor('Boolean(document.querySelector(".app-shell.theme-dark"))')
  await dismissToasts()
  const darkScreenshot = await screenshot('terminal-tabs-dark-wide.png')

  await new Promise(resolve => setTimeout(resolve, 500))
  await click('button[title="切换白色主题"]')
  await waitFor('Boolean(document.querySelector(".app-shell.theme-light"))')
  await dismissToasts()
  await send('Emulation.setDeviceMetricsOverride', { width: 1120, height: 760, deviceScaleFactor: 1, mobile: false })
  await waitFor('document.querySelector(".terminal-stack").getBoundingClientRect().width > 0')
  const lightScreenshot = await screenshot('terminal-tabs-light-narrow.png')

  await openHistory()
  assert.equal(await evaluate('document.querySelectorAll(".session-history-row").length'), 1)
  await click('[title="会话列表"]')
  await click('[title="新建会话"]')
  await openHistory()
  await waitFor('document.querySelectorAll(".session-history-row").length === 2')
  await click('.session-history-row.active button[title="编辑会话"]')
  await waitFor('Boolean(document.querySelector(".rename-modal input"))')
  await evaluate('(() => { const input = document.querySelector(".rename-modal input"); input.value = "重构回归会话"; input.dispatchEvent(new Event("input", { bubbles: true })); })()')
  await click('.rename-modal button[type="submit"]')
  await waitFor('!document.querySelector(".rename-modal")')
  await openHistory()
  await waitFor('document.querySelector(".session-history-row.active").textContent.includes("重构回归会话")')
  await click('.session-tab-strip .tab:last-child')
  await openHistory()
  assert.equal(await evaluate('document.querySelector(".session-history-row.active").textContent.includes("重构回归会话")'), true)
  const sessionScreenshot = await screenshot('workspace-session-light-narrow.png')
  await click('.session-history-row.active button[title="删除会话"]')
  await openHistory()
  await waitFor('document.querySelectorAll(".session-history-row").length === 1')
  assert.ok(dialogs.some(text => text.includes('命令历史不受影响')))
  await click('[title="会话列表"]')

  await evaluate('window.__activeTab = document.querySelector(".tab.active")')
  await click('.tab:not(.active) .tab-close')
  await waitFor('document.querySelectorAll(".session-tab-strip .tab").length === 15')
  assert.equal(await evaluate('document.querySelector(".tab.active") === window.__activeTab'), true)
  for (let count = 14; count >= 1; count--) {
    await click('.tab.active .tab-close')
    await waitFor(`document.querySelectorAll('.session-tab-strip .tab').length === ${count}`)
  }
  assert.equal(await evaluate('document.querySelector(".terminal-stack").children.length'), 1)
  assert.equal(await evaluate('document.querySelectorAll(".tab-close").length'), 0)
  assert.deepEqual(exceptions, [])
  console.log(JSON.stringify({
    result: 'passed', terminalTabsExercised: 16, themes: ['dark', 'light'],
    viewports: ['1440x1000', '1120x760'], nativeBackendTested: false,
    checks: ['stable terminal DOM', 'selected target anchoring', 'wheel and thumb drag', 'background tab close', 'last terminal guard', 'global draft session create/rename/delete', 'terminal switch preserves AI session', 'no uncaught exceptions'],
    screenshots: [darkScreenshot, lightScreenshot, sessionScreenshot]
  }, null, 2))
} catch (error) {
  console.error('Browser failure screenshot:', await screenshot('failure.png').catch(() => 'unavailable'))
  throw error
} finally {
  for (const request of requests.values()) clearTimeout(request.timer)
  requests.clear()
  if (socket.readyState !== WebSocket.CLOSED) {
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 5000)
      socket.addEventListener('close', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.close()
    })
  }
  await fetch(`${debuggerUrl}/json/close/${target.id}`, { signal: AbortSignal.timeout(5000) }).then(response => response.text()).catch(() => undefined)
}
