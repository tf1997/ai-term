import assert from 'node:assert/strict'
import { installSftpFixture } from './sftp-tauri-fixture.mjs'
import { installTerminalDebugFixture } from './terminal-debug-fixture.mjs'

// Exercise the real xterm renderer and mouse selection against synthetic IPC.
const debuggerUrl = process.env.AI_TERM_DEBUG_CDP_URL ?? 'http://127.0.0.1:9234'
const appUrl = process.env.AI_TERM_DEBUG_APP_URL ?? 'http://127.0.0.1:4184'
const target = await fetch(`${debuggerUrl}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(5000) }).then(response => response.json())
const socket = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
const exceptions = []
let sequence = 0
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 10000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  const request = pending.get(message.id)
  if (request) {
    clearTimeout(request.timer)
    pending.delete(message.id)
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
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(expression) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return
    await delay(40)
  }
  throw new Error(`UI timeout: ${expression}`)
}
function installBrowserInspection() {
  const copied = []
  const ipc = window.__TAURI_IPC__
  window.__TAURI_IPC__ = call => {
    if (call.__tauriModule === 'Clipboard' && call.message?.cmd === 'writeText') copied.push(call.message.data)
    return ipc(call)
  }
  function app() { return document.querySelector('.app-shell')?.__vueParentComponent?.setupState }
  function pane() {
    return [...document.querySelectorAll('.terminal-pane')].map(element => element.__vueParentComponent)
      .find(component => component?.props.terminalId === app()?.activeTerminalId)
  }
  window.__selectionBrowser = {
    app, pane, copied,
    terminal: () => pane()?.setupState.terminal,
    read() {
      const terminal = this.terminal()
      if (!terminal) return null
      const screen = terminal.element.querySelector('.xterm-screen').getBoundingClientRect()
      return {
        viewport: terminal.buffer.active.viewportY,
        rows: terminal.rows,
        cols: terminal.cols,
        selection: terminal.getSelectionPosition(),
        text: terminal.getSelection(),
        screen: { x: screen.x, y: screen.y, width: screen.width, height: screen.height, bottom: screen.bottom },
        highlights: [...terminal.element.querySelectorAll('.xterm-selection div')].map(element => {
          const rect = element.getBoundingClientRect()
          return { x: rect.x - screen.x, y: rect.y - screen.y, width: rect.width, height: rect.height }
        }).filter(rect => rect.width > 0 && rect.height > 0),
        context: pane().setupState.selectedLineRange(terminal.getSelection()),
      }
    },
  }
}
const state = () => evaluate('window.__selectionBrowser.read()')
const frame = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
async function scrollTo(line) {
  await evaluate(`window.__selectionBrowser.terminal().scrollToLine(${line})`)
  await frame()
}
function cell(metrics, x, y) {
  return { x: metrics.screen.x + (x + 0.2) * metrics.screen.width / metrics.cols, y: metrics.screen.y + (y + 0.5) * metrics.screen.height / metrics.rows }
}
const mouse = (type, point, buttons = 1) => send('Input.dispatchMouseEvent', { type, ...point, button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: 1 })
async function check(name, run) {
  process.stdout.write(`${name} ... `)
  await run()
  console.log('passed')
}

try {
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false })
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.clear(); (${installSftpFixture.toString()})(); (${installTerminalDebugFixture.toString()})(); (${installBrowserInspection.toString()})();`,
  })
  await send('Page.navigate', { url: appUrl })
  await waitFor('window.__selectionBrowser.read() && window.__selectionBrowser.app().activeTerminal.status === "local"')
  await evaluate('document.querySelector("#session-view-terminal").click()')
  await evaluate('document.fonts.ready.then(() => true)')
  await delay(300)
  await evaluate(`new Promise(resolve => {
    const terminal = window.__selectionBrowser.terminal();
    terminal.reset();
    terminal.write(Array.from({ length: 240 }, (_, i) => 'row-' + String(i).padStart(3, '0') + ' selection content').join('\\r\\n'), resolve);
  })`)
  await frame()

  await check('Selection scrolled out of view leaves no ghost at the top and returns with its text', async () => {
    await scrollTo(50)
    let metrics = await state()
    const start = cell(metrics, 0, 5)
    const end = cell(metrics, 7, 5)
    await mouse('mousePressed', start)
    await mouse('mouseMoved', end)
    await mouse('mouseReleased', end, 0)
    await delay(200)
    metrics = await state()
    assert.equal(metrics.text, 'row-055')
    assert.equal(await evaluate('window.__selectionBrowser.copied.at(-1)'), metrics.text)
    assert.ok(metrics.highlights.length > 0)
    const selection = metrics.selection
    for (const viewport of [100, 0]) {
      await scrollTo(viewport)
      const outside = await state()
      assert.deepEqual(outside.selection, selection, 'Scrolling must preserve selected buffer cells')
      assert.deepEqual(outside.highlights, [], `Offscreen selection must not appear at row zero (viewport ${viewport})`)
    }
    await scrollTo(50)
    const restored = await state()
    assert.deepEqual(restored.highlights, metrics.highlights, 'Returning to selected text must restore the highlight')
    // xterm normalizes each wheel event, so a large pixel delta may only move
    // a few rows. Keep scrolling until the selected row leaves the viewport.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const before = (await state()).viewport
      if (before > selection.end.y) break
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...cell(restored, 10, 10), deltaX: 0, deltaY: 800 })
      await waitFor(`window.__selectionBrowser.terminal().buffer.active.viewportY > ${before}`)
    }
    await frame()
    const scrolled = await state()
    assert.ok(scrolled.viewport > selection.end.y, 'Wheel events must scroll past the selected row')
    assert.deepEqual(scrolled.selection, selection, 'Wheel scrolling must preserve selected buffer cells')
    assert.deepEqual(scrolled.highlights, [], 'Wheel scrolling must also hide an offscreen selection')
  })

  await check('Dragging past both viewport edges scrolls and keeps the original anchor', async () => {
    for (const direction of [-1, 1]) {
      await scrollTo(100)
      const initial = await state()
      const anchorRow = Math.floor(initial.rows / 2)
      const anchor = cell(initial, direction < 0 ? 7 : 0, anchorRow)
      const edge = { x: anchor.x, y: direction < 0 ? initial.screen.y - 35 : initial.screen.bottom + 35 }
      await mouse('mousePressed', anchor)
      await mouse('mouseMoved', edge)
      await delay(400)
      const dragging = await state()
      assert.ok(direction * (dragging.viewport - initial.viewport) > 0, 'Dragging outside must scroll in the pointer direction')
      const endpoint = direction < 0 ? dragging.selection.end : dragging.selection.start
      assert.equal(endpoint.y, 100 + anchorRow, 'Autoscroll must retain the row where dragging began')
      const returned = cell(dragging, 7, direction < 0 ? 2 : dragging.rows - 3)
      await mouse('mouseMoved', returned)
      await mouse('mouseReleased', returned, 0)
      await delay(200)
      const released = await state()
      assert.ok(released.text.includes(`row-${String(100 + anchorRow).padStart(3, '0')}`), 'Final text includes the anchor row')
      assert.ok(released.highlights.length > 0)
      assert.equal(await evaluate('window.__selectionBrowser.copied.at(-1)'), released.text)
      await delay(150)
      assert.equal((await state()).viewport, released.viewport, 'Autoscroll stops after release')
    }
  })

  await check('A second drag keeps scrolling after the previous auto-copy debounce', async () => {
    await scrollTo(100)
    const initial = await state()
    await evaluate('window.__selectionBrowser.terminal().select(0, 105, 7)')
    const anchor = cell(initial, 0, 10)
    await mouse('mousePressed', anchor)
    await mouse('mouseMoved', cell(initial, initial.cols - 1, 12))
    await delay(220)
    const edge = { x: anchor.x, y: initial.screen.bottom + 35 }
    await mouse('mouseMoved', edge)
    await delay(300)
    const dragging = await state()
    await mouse('mouseReleased', edge, 0)
    await delay(200)
    assert.ok(dragging.viewport > initial.viewport, 'A pending copy must not stop the next drag')
    assert.deepEqual(dragging.selection.start, { x: 0, y: 110 })
  })

  await check('Selection context uses buffer lines independently of scroll position', async () => {
    await scrollTo(10)
    await evaluate('window.__selectionBrowser.terminal().select(0, 15, 7)')
    await delay(200)
    assert.deepEqual((await state()).context, { startLine: 16, endLine: 16 })
    await scrollTo(100)
    assert.deepEqual((await state()).context, { startLine: 16, endLine: 16 })
    const fullRowContext = await evaluate(`(() => {
      const terminal = window.__selectionBrowser.terminal();
      terminal.select(0, 15, terminal.cols);
      return window.__selectionBrowser.read().context;
    })()`)
    assert.deepEqual(fullRowContext, { startLine: 16, endLine: 16 }, 'An exclusive end at column zero excludes the following line')
    await delay(200)
  })

  await check('Selecting empty cells clears the highlight without overwriting copied text', async () => {
    await scrollTo(100)
    const before = await evaluate('window.__selectionBrowser.copied.length')
    await evaluate('window.__selectionBrowser.terminal().select(30, 105, 5)')
    await delay(200)
    assert.equal((await state()).text, '')
    assert.deepEqual((await state()).highlights, [])
    assert.equal(await evaluate('window.__selectionBrowser.copied.length'), before)
  })

  await check('Changing display scale refits the last row and column without a host resize', async () => {
    for (const deviceScaleFactor of [1.25, 1.5, 2, 1]) {
      await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor, mobile: false })
      await frame()
      await waitFor(`(() => {
        const terminal = window.__selectionBrowser.terminal();
        const screen = terminal.element.querySelector('.xterm-screen').getBoundingClientRect();
        const host = terminal.element.parentElement.getBoundingClientRect();
        return devicePixelRatio === ${deviceScaleFactor} && screen.bottom <= host.bottom && screen.right <= host.right;
      })()`)
      await evaluate(`new Promise(resolve => {
        const t = window.__selectionBrowser.terminal();
        t.scrollToBottom();
        t.write('\\x1b[' + t.rows + ';1Hlast visible row', resolve);
      })`)
      await frame()
      const metrics = await state()
      const lastRow = await evaluate(`(() => {
        const t = window.__selectionBrowser.terminal();
        return t.buffer.active.getLine(t.buffer.active.baseY + t.rows - 1).translateToString(true);
      })()`)
      assert.ok(lastRow.startsWith('last visible row'), 'The prompt must remain on the fitted last row')
      assert.ok(metrics.rows > 1 && metrics.cols > 1)
    }
  })

  assert.deepEqual(exceptions, [], 'No uncaught browser exceptions')
} finally {
  await fetch(`${debuggerUrl}/json/close/${target.id}`).catch(() => {})
  socket.close()
}
