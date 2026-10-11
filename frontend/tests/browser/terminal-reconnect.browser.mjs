import assert from 'node:assert/strict'
import { installSftpFixture } from './sftp-tauri-fixture.mjs'
import { installTerminalDebugFixture } from './terminal-debug-fixture.mjs'

// Run Vite on 4184 and a disposable headless Chrome/Edge with CDP on 9234.
// The real AppShell and xterm receive keyboard events against synthetic Tauri IPC.
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
async function waitFor(expression) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error(`UI timeout: ${expression}`)
}
async function click(selector) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
}
async function press(key, modifiers = 0) {
  const params = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: key === 'Enter' ? 13 : key.toUpperCase().charCodeAt(0), modifiers }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...params, ...(key === 'Enter' ? { text: '\r' } : {}) })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
}
function installBrowserInspection() {
  function app() { return document.querySelector('.app-shell')?.__vueParentComponent?.setupState }
  function pane() {
    return [...document.querySelectorAll('.terminal-pane')].map(element => element.__vueParentComponent)
      .find(component => component?.props.terminalId === app()?.activeTerminalId)
  }
  window.__debugBrowser = {
    app, pane,
    read() {
      const terminal = pane()?.setupState.terminal
      if (!terminal) return null
      const buffer = terminal.buffer.active
      return {
        text: Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? '').join('\n'),
        snapshot: app().activeTerminalSnapshot,
      }
    },
  }
}
const state = () => evaluate('window.__debugBrowser.read()')
async function showTerminal() {
  await click('#session-view-terminal')
  await waitFor('document.querySelector("#session-view-terminal")?.getAttribute("aria-selected") === "true"')
}
async function userCommand(command) {
  await showTerminal()
  await evaluate('window.__debugBrowser.pane().exposed.focusTerminal()')
  await send('Input.insertText', { text: command })
  await waitFor(`window.__sftpFixture.calls.some(call => call.cmd === 'terminal_write' && call.data.includes(${JSON.stringify(command)}))`)
  await press('Enter')
  await waitFor(`window.__terminalDebugFixture.ordinaryCommands.includes(${JSON.stringify(command)})`)
  await waitFor(`window.__debugBrowser.read().snapshot.includes(${JSON.stringify(`${command.slice(5)}\r\n`)})`)
}
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
  await waitFor('window.__debugBrowser.read() && window.__debugBrowser.app().activeTerminal.status === "local"')
  if (!await evaluate('Boolean(document.querySelector(".server-card"))')) await click('[aria-label="打开连接管理"]')
  await waitFor('document.querySelectorAll(".server-card").length === 2')
  await evaluate(`[...document.querySelectorAll('.server-card')].find(card => card.textContent.includes('Atlas')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await waitFor('window.__debugBrowser.app().activeTerminal.status === "remote"')
  await check('Ctrl+R reaches connected shells and reconnects only the exited terminal in its existing tab', async () => {
    await showTerminal()
    await evaluate('window.__debugBrowser.pane().exposed.focusTerminal()')
    const before = await evaluate(`({
      id: window.__debugBrowser.app().activeTerminalId,
      sessionId: window.__debugBrowser.pane().setupState.sessionId,
      generation: window.__debugBrowser.app().activeTerminal.connectionGeneration,
      tabs: document.querySelectorAll('.session-tab-strip > .tab').length,
      connects: window.__sftpFixture.calls.filter(call => call.cmd === 'connect_profile').length,
      writes: window.__sftpFixture.calls.filter(call => call.cmd === 'terminal_write').length,
    })`)
    await press('r', 2)
    await waitFor(`window.__sftpFixture.calls.filter(call => call.cmd === 'terminal_write').slice(${before.writes}).some(call => call.data === '\\x12')`)
    assert.equal(await evaluate(`window.__sftpFixture.calls.filter(call => call.cmd === 'connect_profile').length`), before.connects)
    await waitFor('window.__terminalDebugFixture.pendingChunks === 0')
    await evaluate(`window.__sftpFixture.emit('terminal:closed:' + ${JSON.stringify(before.sessionId)}, { sessionId: ${JSON.stringify(before.sessionId)}, reason: 'eof' })`)
    await waitFor('window.__debugBrowser.app().activeTerminal.status === "idle" && window.__debugBrowser.read().text.includes("Shell exited: eof")')
    assert.ok((await state()).text.includes('Ctrl+R'))
    // A delayed backend keeps the connecting window deterministic for repeated keypresses.
    await evaluate('window.__sftpFixture.connectionDelayMs = 500')
    await press('r', 2)
    await waitFor('window.__debugBrowser.app().activeTerminal.status === "connecting"')
    await press('r', 2)
    await press('r', 2)
    await waitFor('window.__debugBrowser.app().activeTerminal.status === "remote"')
    await evaluate('window.__sftpFixture.connectionDelayMs = 0')
    const after = await evaluate(`({
      id: window.__debugBrowser.app().activeTerminalId,
      sessionId: window.__debugBrowser.pane().setupState.sessionId,
      generation: window.__debugBrowser.app().activeTerminal.connectionGeneration,
      tabs: document.querySelectorAll('.session-tab-strip > .tab').length,
      calls: window.__sftpFixture.calls,
      focused: document.activeElement === window.__debugBrowser.pane().setupState.terminal.textarea,
    })`)
    assert.equal(after.id, before.id)
    assert.equal(after.tabs, before.tabs)
    assert.notEqual(after.sessionId, before.sessionId)
    assert.equal(after.generation, before.generation + 1)
    const connects = after.calls.filter(call => call.cmd === 'connect_profile')
    assert.equal(connects.length, before.connects + 1)
    assert.equal(connects.at(-1).profileId, 'alpha')
    assert.equal(after.calls.some(call => call.cmd === 'terminal_write' && call.sessionId === after.sessionId && call.data.includes('\x12')), false)
    assert.equal(after.focused, true)
    // Late events from the old session cannot close or contaminate the replacement.
    await evaluate(`window.__sftpFixture.emit('terminal:closed:' + ${JSON.stringify(before.sessionId)}, { sessionId: ${JSON.stringify(before.sessionId)}, reason: 'stale close' })`)
    await userCommand('echo reconnected-remote')
    assert.ok((await state()).snapshot.includes('reconnected-remote\r\n'))
  })
  await check('Ctrl+R can retry a failed SSH reconnection', async () => {
    const before = await evaluate('window.__sftpFixture.calls.filter(call => call.cmd === "connect_profile").length')
    await evaluate('window.__sftpFixture.disconnect("alpha"); window.__sftpFixture.connectionErrors.alpha = "fixture connection refused"')
    await waitFor('window.__debugBrowser.app().activeTerminal.status === "idle"')
    await press('r', 2)
    await waitFor('window.__debugBrowser.app().activeTerminal.status === "error" && window.__debugBrowser.read().text.includes("fixture connection refused")')
    assert.ok((await state()).text.includes('Ctrl+R'))
    await evaluate('delete window.__sftpFixture.connectionErrors.alpha')
    await press('r', 2)
    await waitFor('window.__debugBrowser.app().activeTerminal.status === "remote"')
    assert.equal(await evaluate('window.__sftpFixture.calls.filter(call => call.cmd === "connect_profile").length'), before + 2)
    await userCommand('echo recovered-from-connect-error')
    assert.ok((await state()).snapshot.includes('recovered-from-connect-error\r\n'))
  })
  await check('Ctrl+R restarts an exited local shell with a fresh session in the same tab', async () => {
    await click('.session-tab-strip > .tab[data-terminal-id="local-1"] .tab-select')
    await showTerminal()
    await evaluate('window.__debugBrowser.pane().exposed.focusTerminal()')
    const before = await evaluate(`({
      sessionId: window.__debugBrowser.pane().setupState.sessionId,
      generation: window.__debugBrowser.app().activeTerminal.connectionGeneration,
      connects: window.__sftpFixture.calls.filter(call => call.cmd === 'connect_local_terminal').length,
    })`)
    await evaluate('window.__sftpFixture.disconnect("local")')
    await waitFor('window.__debugBrowser.app().activeTerminal.status === "idle"')
    await press('r', 2)
    await waitFor('window.__debugBrowser.app().activeTerminal.status === "local"')
    assert.equal(await evaluate('window.__debugBrowser.app().activeTerminalId'), 'local-1')
    assert.notEqual(await evaluate('window.__debugBrowser.pane().setupState.sessionId'), before.sessionId)
    assert.equal(await evaluate('window.__debugBrowser.app().activeTerminal.connectionGeneration'), before.generation + 1)
    assert.equal(await evaluate('window.__sftpFixture.calls.filter(call => call.cmd === "connect_local_terminal").length'), before.connects + 1)
    await userCommand('echo reconnected-local')
    assert.ok((await state()).snapshot.includes('reconnected-local\r\n'))
  })
  assert.deepEqual(exceptions, [], 'No uncaught browser exceptions')
  console.log('Terminal reconnection browser checks passed (synthetic IPC).')
} finally {
  for (const request of pending.values()) clearTimeout(request.timer)
  pending.clear()
  socket.close()
  await fetch(`${debuggerUrl}/json/close/${target.id}`, { signal: AbortSignal.timeout(5000) }).catch(() => undefined)
}
