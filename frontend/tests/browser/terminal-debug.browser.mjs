import assert from 'node:assert/strict'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installSftpFixture } from './sftp-tauri-fixture.mjs'
import { installTerminalDebugFixture } from './terminal-debug-fixture.mjs'

// Start an isolated Vite server on 4184 and disposable headless Edge/Chrome on 9234.
// The actual AppShell and xterm run against synthetic IPC on a newly created browser tab.
const debuggerUrl = process.env.AI_TERM_DEBUG_CDP_URL ?? 'http://127.0.0.1:9234'
const appUrl = process.env.AI_TERM_DEBUG_APP_URL ?? 'http://127.0.0.1:4184'
const outputDirectory = resolve(process.env.AI_TERM_DEBUG_OUTPUT ?? join(dirname(fileURLToPath(import.meta.url)), '../../../outputs/terminal-debug-2026-09-15'))
mkdirSync(outputDirectory, { recursive: true })
const target = await fetch(`${debuggerUrl}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(5000) }).then(response => response.json())
const socket = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
const exceptions = []
const checks = []
const screenshots = []
let sequence = 0

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 20000)
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
  if (message.method === 'Page.javascriptDialogOpening') void send('Page.handleJavaScriptDialog', { accept: false })
})
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
async function waitFor(expression, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error(`UI timeout: ${expression}`)
}
async function click(selector, double = false) {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    const point = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error('Missing element: ' + ${JSON.stringify(selector)});
      element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      const r = element.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height };
    })()`)
    if (!point.width || !point.height) { await new Promise(resolve => setTimeout(resolve, 40)); continue }
    if (!await evaluate(`document.querySelector(${JSON.stringify(selector)}).contains(document.elementFromPoint(${point.x}, ${point.y}))`)) {
      await new Promise(resolve => setTimeout(resolve, 40)); continue
    }
    const params = { x: point.x, y: point.y, button: 'left', clickCount: double ? 2 : 1 }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...params })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...params })
    return
  }
  throw new Error(`Cannot click: ${selector}`)
}
async function press(key, modifiers = 0) {
  const codes = { Enter: 13, Escape: 27, Tab: 9, a: 65, c: 67, ' ': 32 }
  const params = { key, code: key === ' ' ? 'Space' : key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: codes[key], modifiers }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...params, ...(key === 'Enter' ? { text: '\r' } : {}) })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
}
async function replaceText(selector, value) {
  await click(selector)
  await press('a', 2)
  await send('Input.insertText', { text: value })
  await waitFor(`document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`)
}
async function textButton(scope, label) {
  await evaluate(`(() => {
    document.querySelector('[data-debug-browser-action]')?.removeAttribute('data-debug-browser-action');
    const element = [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find(button => button.textContent.trim() === ${JSON.stringify(label)} && button.getBoundingClientRect().width);
    if (!element) throw new Error('Missing button: ' + ${JSON.stringify(label)});
    element.dataset.debugBrowserAction = 'current';
  })()`)
  await click('[data-debug-browser-action="current"]')
  await evaluate(`document.querySelector('[data-debug-browser-action]')?.removeAttribute('data-debug-browser-action')`)
}

// Read existing Vue development instances; no product testing hooks are introduced.
function installBrowserInspection() {
  function app() { return document.querySelector('.app-shell')?.__vueParentComponent?.setupState }
  function pane() {
    return [...document.querySelectorAll('.terminal-pane')].map(element => element.__vueParentComponent)
      .find(component => component?.props.terminalId === app()?.activeTerminalId)
  }
  window.__debugBrowser = {
    app, pane,
    read() {
      const component = pane()
      const terminal = component?.setupState.terminal
      if (!terminal) return null
      const buffer = terminal.buffer.active
      const lines = Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? '')
      return {
        terminalId: app().activeTerminalId,
        text: lines.join('\n'),
        visibleLines: lines.filter(line => line.trim()),
        viewport: lines.slice(buffer.viewportY, buffer.viewportY + terminal.rows).join('\n'),
        snapshot: app().activeTerminalSnapshot,
        readiness: component.exposed.commandExecutionReadiness(),
        internalOutputActive: component.setupState.internalOutputFilter.active(),
        cursorX: buffer.cursorX,
        cursorY: buffer.cursorY,
        cols: terminal.cols,
        rows: terminal.rows,
      }
    },
  }
}

const files = '.files-panel:not([style*="display: none"])'
const remote = `${files} .remote-pane`
const debugSwitch = '.application-settings-panel input[role="switch"]'
const diagnostics = () => evaluate('window.__terminalDebugFixture.diagnostics')
const state = () => evaluate('window.__debugBrowser.read()')
async function settleTerminal() {
  await waitFor('window.__terminalDebugFixture.pendingChunks === 0')
  await waitFor('window.__debugBrowser.read()?.readiness === "ready"')
  // AppShell receives the coalesced public snapshot every 200 ms.
  await new Promise(resolve => setTimeout(resolve, 240))
}
async function showTerminal() {
  await click('#session-view-terminal')
  await waitFor('document.querySelector("#session-view-terminal")?.getAttribute("aria-selected") === "true"')
}
async function showFiles() {
  await click('#session-view-files')
  await waitFor(`document.querySelector(${JSON.stringify(files)})`)
}
async function readyFiles() {
  await waitFor(`document.querySelector(${JSON.stringify(`${remote} [data-file-path]`)}) && !document.querySelector(${JSON.stringify(`${files} .file-connection-status`)})`)
  await settleTerminal()
}
async function redetect() {
  const count = (await diagnostics()).length
  const retry = await evaluate(`[...document.querySelectorAll(${JSON.stringify(`${files} .file-connection-status button`)})].some(button => button.textContent.trim() === '重试')`)
  if (retry) await textButton(`${files} .file-connection-status`, '重试')
  else await textButton(`${files} .panel-actions`, '重新检测')
  await waitFor(`window.__terminalDebugFixture.diagnostics.length > ${count}`)
  await readyFiles()
}
async function connectProfile(name) {
  if (!await evaluate('Boolean(document.querySelector(".server-card"))')) await click('[aria-label="打开连接管理"]')
  const selector = await evaluate(`(() => { const cards = [...document.querySelectorAll('.server-card')]; const index = cards.findIndex(card => card.textContent.includes(${JSON.stringify(name)})); if (index < 0) throw new Error('Missing synthetic connection profile'); return '.server-card:nth-of-type(' + (index + 1) + ')'; })()`)
  await click(selector, true)
  await waitFor('document.querySelector(".session-tab-strip .tab.active .status-dot.live")')
  await settleTerminal()
}
const connectAtlas = () => connectProfile('Atlas')
async function openApplicationSettings() {
  if (!await evaluate('Boolean(document.querySelector(".settings-sidebar"))')) await click('[aria-label="打开设置中心"]')
  await click('.settings-sidebar [role="tab"][aria-label="应用设置"]')
  await waitFor(`Boolean(document.querySelector(${JSON.stringify(debugSwitch)}))`)
}
async function setDebug(enabled, keyboard = false) {
  await openApplicationSettings()
  if (await evaluate(`document.querySelector(${JSON.stringify(debugSwitch)}).checked`) !== enabled) {
    if (keyboard) {
      await evaluate(`document.querySelector(${JSON.stringify(debugSwitch)}).focus()`)
      await press(' ')
    } else await click(debugSwitch)
  }
  await waitFor(`document.querySelector(${JSON.stringify(debugSwitch)}).checked === ${enabled} && window.__debugBrowser.app().appSettings.debugMode === ${enabled}`)
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('ai-term:user-settings:v1')).debugMode`), enabled)
}
async function userCommand(command) {
  await showTerminal()
  await evaluate('window.__debugBrowser.pane().exposed.focusTerminal()')
  await send('Input.insertText', { text: command })
  await waitFor(`window.__sftpFixture.calls.some(call => call.cmd === 'terminal_write' && call.data.includes(${JSON.stringify(command)}))`)
  await press('Enter')
  await waitFor(`window.__terminalDebugFixture.ordinaryCommands.includes(${JSON.stringify(command)})`)
  await settleTerminal()
}
async function interrupt() {
  await showTerminal()
  await evaluate('window.__debugBrowser.pane().exposed.focusTerminal()')
  await press('c', 2)
  await settleTerminal()
}
function assertHidden(records, current, bodies = false) {
  for (const record of records) {
    for (const text of [current.text.replace(/\n/g, ''), current.snapshot]) {
      assert.equal(text.includes(record.begin), false, `Hidden diagnostic begin leaked: ${record.begin}`)
      assert.equal(text.includes(record.end), false, `Hidden diagnostic end leaked: ${record.end}`)
    }
  }
  if (bodies) {
    for (const text of [current.text, current.snapshot]) {
      assert.doesNotMatch(text, /(?:^|[\r\n])(?:user|hostname|ips|pwd|machine)=/, 'Identity payload must not reach screen or public context')
    }
  }
}
function assertVisible(record, current) {
  for (const text of [current.text.replace(/\n/g, ''), current.snapshot]) {
    assert.ok(text.includes(record.begin), `Debug mode must show the begin marker: ${record.begin}`)
    assert.ok(text.includes(record.end), `Debug mode must show the complete end marker: ${record.end}`)
    assert.ok(text.includes('user=deploy'))
    assert.ok(text.includes('machine=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'))
    assert.ok(text.includes('printf'), 'The command echo is part of diagnostic output')
  }
}
async function screenshot(name) {
  while (await evaluate('Boolean(document.querySelector(".toast-stack button"))')) await click('.toast-stack button')
  await evaluate('document.fonts.ready.then(() => true)')
  const capture = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const path = join(outputDirectory, name)
  writeFileSync(path, Buffer.from(capture.data, 'base64'))
  screenshots.push(path)
  return path
}
async function check(name, run) {
  process.stdout.write(`${name} ... `)
  await run()
  checks.push(name)
  console.log('passed')
}

try {
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Network.enable')
  await send('Network.setCacheDisabled', { cacheDisabled: true })
  await send('Accessibility.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false })
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `if (!sessionStorage.getItem('terminal-debug-suite-initialized')) { localStorage.clear(); sessionStorage.setItem('terminal-debug-suite-initialized', '1'); }
      (${installSftpFixture.toString()})(); (${installTerminalDebugFixture.toString()})(); (${installBrowserInspection.toString()})();`,
  })
  await send('Page.navigate', { url: appUrl })
  await waitFor('document.querySelectorAll(".server-card").length === 2 && window.__debugBrowser.read()')
  assert.equal(await evaluate('window.__sftpFixture.nativeBoundaryMocked'), true)
  await check('debug mode defaults off and has a labelled, described accessible switch', async () => {
    assert.equal(await evaluate('window.__debugBrowser.app().appSettings.debugMode'), false)
    await openApplicationSettings()
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(debugSwitch)}).getAttribute('aria-checked')`), 'false')
    const tree = await send('Accessibility.getFullAXTree')
    const toggle = tree.nodes.find(node => node.role?.value === 'switch' && node.name?.value === '调试模式')
    assert.ok(toggle)
    assert.ok(toggle.description?.value.includes('默认关闭'))
    assert.equal(toggle.properties.find(property => property.name === 'checked').value.value, 'false')
  })
  await connectAtlas()
  const original = await state()
  await check('automatic SFTP identification consumes raw protocol while hiding echoed commands and identity fields', async () => {
    await showFiles()
    await readyFiles()
    const records = await diagnostics()
    assert.ok(records.length >= 1)
    const raw = await evaluate('window.__terminalDebugFixture.rawChunks.map(chunk => chunk.data).join("")')
    assert.ok(raw.includes(records[0].command.trim()))
    assert.ok(raw.includes('ips=127.0.1.1 10.20.0.17 172.20.0.17'))
    const probes = await evaluate('window.__sftpFixture.calls.filter(call => call.cmd === "sftp_probe")')
    assert.deepEqual(probes.map(probe => probe.targetHost), ['10.20.0.17', '172.20.0.17'])
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(`${remote} .file-pane-identity`)})?.textContent.trim()`), 'deploy@172.20.0.17')
    await showTerminal()
    await settleTerminal()
    const current = await state()
    assertHidden(records, current, true)
    assert.deepEqual(current.visibleLines, original.visibleLines, 'An internal identity probe must preserve the existing prompt and terminal output')
    await screenshot('terminal-clean-dark.png')
  })
  await check('repeated terminal/files switches preserve one prompt and the live xterm instance', async () => {
    await evaluate('window.__debugOriginalXterm = window.__debugBrowser.pane().setupState.terminal; true')
    for (let index = 0; index < 3; index++) {
      await showFiles()
      await readyFiles()
      await redetect()
      await showTerminal()
      await settleTerminal()
      const current = await state()
      assert.deepEqual(current.visibleLines, original.visibleLines)
      assert.equal(current.readiness, 'ready')
      assert.equal(await evaluate('window.__debugOriginalXterm === window.__debugBrowser.pane().setupState.terminal'), true)
    }
    assertHidden(await diagnostics(), await state(), true)
    await openApplicationSettings()
    await screenshot('debug-mode-settings-off-dark.png')
  })
  await check('switching remote terminal tabs preserves independent file targets and clean prompts', async () => {
    const alpha = await state()
    await connectProfile('Borealis')
    const beta = await state()
    assert.notEqual(beta.terminalId, alpha.terminalId)
    await showFiles()
    await readyFiles()
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(`${remote} .file-pane-identity`)})?.textContent.trim()`), 'ops@10.30.0.23')
    await showTerminal()
    assert.deepEqual((await state()).visibleLines, beta.visibleLines)
    for (const expected of [alpha, beta, alpha]) {
      await click(`.session-tab-strip .tab[data-terminal-id=${JSON.stringify(expected.terminalId)}] .tab-select`)
      await showFiles()
      await readyFiles()
      await showTerminal()
      const current = await state()
      assert.equal(current.terminalId, expected.terminalId)
      assert.deepEqual(current.visibleLines, expected.visibleLines)
      assertHidden(await diagnostics(), current, true)
      assert.equal(current.readiness, 'ready')
    }
  })
  await check('ordinary user commands, responses, errors and marker-like user text remain visible', async () => {
    await userCommand('echo ordinary-output-after-probe')
    await userCommand('fixture-missing-command')
    await userCommand('echo AI_TERM_IDENT_BEGIN_user_text')
    const current = await state()
    for (const text of [current.text.replace(/\n/g, ''), current.snapshot]) {
      assert.ok(text.includes('echo ordinary-output-after-probe'))
      assert.ok(text.includes('bash: fixture-missing-command: command not found'))
      assert.ok(text.includes('AI_TERM_IDENT_BEGIN_user_text'))
    }
    assertHidden(await diagnostics(), current, true)
    assert.equal(current.readiness, 'ready')
  })
  await check('terminal file download receives the complete hidden payload and writes the correct bytes', async () => {
    await showFiles()
    await readyFiles()
    const before = await state()
    const count = (await diagnostics()).length
    await textButton(`${files} .transfer-mode-tabs`, '终端传输')
    await replaceText(`${files} input[aria-label="终端传输远端路径"]`, '/srv/atlas/debug-fixture.txt')
    await textButton(`${files} .terminal-transfer-panel`, '下载远端文件')
    await waitFor('window.__terminalDebugFixture.localWrites.length === 1')
    await settleTerminal()
    const written = await evaluate('window.__terminalDebugFixture.localWrites[0]')
    assert.ok(written.path.replaceAll('\\', '/').endsWith('/debug-fixture.txt'))
    assert.equal(Buffer.from(written.data).toString(), 'fixture-file-payload')
    const records = (await diagnostics()).slice(count)
    assert.ok(records.some(record => record.begin.startsWith('AI_TERM_FILE_BEGIN_')))
    await showTerminal()
    const after = await state()
    assertHidden(records, after)
    assert.equal(after.snapshot.includes('Zml4dHVyZS1maWxlLXBheWxvYWQ='), false, 'Hidden transfer content must not enter public terminal context')
    assert.deepEqual(after.visibleLines, before.visibleLines)
    await showFiles()
    await textButton(`${files} .transfer-mode-tabs`, 'SFTP')
    await readyFiles()
  })
  await check('enabling debug mode immediately reveals the next complete command and result', async () => {
    await setDebug(true)
    await showFiles()
    await readyFiles()
    await redetect()
    await showTerminal()
    const record = (await diagnostics()).at(-1)
    assertVisible(record, await state())
    await screenshot('terminal-debug-enabled-dark.png')
    await openApplicationSettings()
    await screenshot('debug-mode-settings-on-dark.png')
  })
  await check('enabled debug mode survives reload and SFTP still discovers its server', async () => {
    await send('Page.reload')
    await waitFor('document.querySelectorAll(".server-card").length === 2 && window.__debugBrowser.read()')
    assert.equal(await evaluate('window.__debugBrowser.app().appSettings.debugMode'), true)
    await connectAtlas()
    await showFiles()
    await readyFiles()
    await showTerminal()
    assertVisible((await diagnostics()).at(-1), await state())
  })
  await check('keyboard disabling applies to future diagnostics without deleting existing terminal history', async () => {
    await setDebug(false, true)
    const count = (await diagnostics()).length
    const before = await state()
    await showFiles()
    await readyFiles()
    await redetect()
    await showTerminal()
    await settleTerminal()
    const after = await state()
    assertHidden((await diagnostics()).slice(count), after)
    assert.deepEqual(after.visibleLines, before.visibleLines)
    assertVisible((await diagnostics())[0], after)
  })
  await check('cancelled identification cannot leave subsequent user output suppressed', async () => {
    await showFiles()
    await readyFiles()
    await evaluate('window.__sftpFixture.identityMode.alpha = "echo-only"')
    const count = (await diagnostics()).length
    await textButton(`${files} .panel-actions`, '重新检测')
    await waitFor(`window.__terminalDebugFixture.diagnostics.length > ${count}`)
    await waitFor('window.__terminalDebugFixture.pendingChunks === 0')
    await textButton(`${files} .panel-actions`, '取消连接')
    await waitFor(`document.querySelector(${JSON.stringify(`${files} .file-connection-status`)})?.textContent.includes('已取消')`)
    await evaluate('delete window.__sftpFixture.identityMode.alpha')
    await interrupt()
    await userCommand('echo recovered-after-cancel')
    const current = await state()
    assert.ok(current.snapshot.includes('recovered-after-cancel'))
    assertHidden((await diagnostics()).slice(count), current)
    await showFiles()
    await redetect()
  })
  await check('a no-output identification timeout releases suppression and permits retry', async () => {
    await evaluate('window.__sftpFixture.identityMode.alpha = "hold"')
    const count = (await diagnostics()).length
    await textButton(`${files} .panel-actions`, '重新检测')
    await waitFor(`window.__terminalDebugFixture.diagnostics.length > ${count}`)
    await showTerminal()
    await showFiles()
    await waitFor(`document.querySelector(${JSON.stringify(`${files} .file-connection-status.error`)})?.textContent.includes('超时')`, 16000)
    await evaluate('delete window.__sftpFixture.identityMode.alpha')
    await interrupt()
    await userCommand('echo recovered-after-timeout')
    const current = await state()
    assert.ok(current.snapshot.includes('recovered-after-timeout'))
    assertHidden((await diagnostics()).slice(count), current)
    await showFiles()
    await redetect()
  })
  await check('disabled preference survives reload and plain shells without OSC integration stay usable', async () => {
    await evaluate('sessionStorage.setItem("terminal-debug-fixture-shell-integration", "off")')
    await send('Page.reload')
    await waitFor('document.querySelectorAll(".server-card").length === 2 && window.__debugBrowser.read()')
    assert.equal(await evaluate('window.__debugBrowser.app().appSettings.debugMode'), false)
    await connectAtlas()
    const before = await state()
    await showFiles()
    await readyFiles()
    await redetect()
    await showTerminal()
    await settleTerminal()
    const current = await state()
    assertHidden(await diagnostics(), current, true)
    assert.deepEqual(current.visibleLines, before.visibleLines)
    await userCommand('echo ordinary-output-on-plain-shell')
    assert.ok((await state()).snapshot.includes('ordinary-output-on-plain-shell'))
    await openApplicationSettings()
    await click('[aria-label="切换白色主题"]')
    await send('Emulation.setDeviceMetricsOverride', { width: 1120, height: 760, deviceScaleFactor: 1, mobile: false })
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true)
    await screenshot('debug-mode-settings-off-light.png')
  })
  await check('user typing immediately restores its echo after a cancelled diagnostic receives a late begin marker', async () => {
    await showFiles()
    await readyFiles()
    await evaluate('window.__sftpFixture.identityMode.alpha = "hold"')
    const count = (await diagnostics()).length
    await textButton(`${files} .panel-actions`, '重新检测')
    await waitFor(`window.__terminalDebugFixture.diagnostics.length > ${count}`)
    await textButton(`${files} .panel-actions`, '取消连接')
    await waitFor(`document.querySelector(${JSON.stringify(`${files} .file-connection-status`)})?.textContent.includes('已取消')`)
    assert.equal((await state()).internalOutputActive, false, 'Cancellation releases the original diagnostic')
    await evaluate('delete window.__sftpFixture.identityMode.alpha')
    await showTerminal()
    await evaluate('window.__debugBrowser.pane().exposed.focusTerminal()')
    await evaluate('window.__terminalDebugFixture.emitLateDiagnosticStart("alpha")')
    assert.equal((await state()).internalOutputActive, true, 'The late BEGIN must reactivate suppression before user input')
    const command = 'echo recovered-after-late-begin'
    await send('Input.insertText', { text: command })
    await waitFor(`window.__sftpFixture.calls.some(call => call.cmd === 'terminal_write' && call.data.includes(${JSON.stringify(command)}))`)
    await waitFor('window.__terminalDebugFixture.pendingChunks === 0')
    await new Promise(resolve => setTimeout(resolve, 240))
    const typed = await state()
    const raw = await evaluate('window.__terminalDebugFixture.rawChunks.map(chunk => chunk.data).join("")')
    assert.ok(raw.includes(command), 'The synthetic PTY sent the complete user echo')
    for (const text of [typed.text.replace(/\n/g, ''), typed.snapshot]) {
      assert.ok(text.includes(command), 'User echo must be visible immediately, before Enter or the late-output grace deadline')
    }
    assert.equal(typed.internalOutputActive, false, 'User input releases a reactivated late diagnostic')
    assertHidden((await diagnostics()).slice(count), typed, true)
    await press('Enter')
    await waitFor(`window.__terminalDebugFixture.ordinaryCommands.includes(${JSON.stringify(command)})`)
    await settleTerminal()
    const current = await state()
    assert.ok(current.snapshot.includes('\r\nrecovered-after-late-begin\r\n'), 'The subsequent command result remains visible')
    await screenshot('terminal-recovered-after-late-begin-light.png')
    await showFiles()
    await redetect()
  })
  await check('protocol completion preserves an ANSI reset split immediately after END without leaking suffixes', async () => {
    await showFiles()
    await readyFiles()
    const before = await state()
    const count = (await diagnostics()).length
    for (const split of [2, 3]) {
      await readyFiles()
      await evaluate(`window.__sftpFixture.identityMode.alpha = "split-end-control"; window.__terminalDebugFixture.endControlSplit = ${split}`)
      await redetect()
      const record = (await diagnostics()).at(-1)
      const chunks = await evaluate('window.__terminalDebugFixture.rawChunks.map(chunk => chunk.data)')
      assert.ok(chunks.includes(`${record.end}${'\x1b[0m'.slice(0, split)}`), 'END and the partial ANSI reset must share one transport chunk')
      await showTerminal()
      const current = await state()
      assert.deepEqual(current.visibleLines, before.visibleLines, 'No m or 0m suffix may appear before the restored prompt')
      assertHidden((await diagnostics()).slice(count), current, true)
      await showFiles()
    }
    await evaluate('delete window.__sftpFixture.identityMode.alpha')
    await showTerminal()
    await screenshot('terminal-split-end-control-light.png')
  })
  assert.deepEqual(exceptions, [], 'No uncaught browser exceptions')
  const report = {
    result: 'passed', checks, screenshots, nativeBackendTested: false,
    fixture: 'actual Vue AppShell and xterm; synthetic IPC echoes complete commands and splits ANSI, CRLF and markers; identity/file protocol reaches real SFTP consumers',
    viewports: ['1280x820', '1120x760'], themes: ['dark', 'light'],
  }
  writeFileSync(join(outputDirectory, 'browser-report.json'), JSON.stringify(report, null, 2))
  for (const filename of ['failure.json', 'failure.png']) if (existsSync(join(outputDirectory, filename))) unlinkSync(join(outputDirectory, filename))
  console.log(JSON.stringify({ result: 'passed', checkCount: checks.length, report: join(outputDirectory, 'browser-report.json'), screenshots, nativeBackendTested: false }, null, 2))
} catch (error) {
  const failureScreenshot = await screenshot('failure.png').catch(() => null)
  const terminal = await state().catch(() => null)
  const dom = await evaluate('document.body.innerText + (document.querySelector("vite-error-overlay")?.shadowRoot?.textContent ?? "")').catch(() => '')
  const calls = await evaluate('window.__sftpFixture?.calls').catch(() => [])
  const report = { result: 'failed', error: String(error), checks, screenshots, failureScreenshot, terminal, dom, calls, exceptions, nativeBackendTested: false }
  writeFileSync(join(outputDirectory, 'failure.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(outputDirectory, 'browser-report.json'), JSON.stringify(report, null, 2))
  console.error(error.stack ?? String(error))
  process.exitCode = 1
} finally {
  for (const request of pending.values()) clearTimeout(request.timer)
  pending.clear()
  await new Promise(resolve => {
    if (socket.readyState === WebSocket.CLOSED) return resolve()
    const timer = setTimeout(resolve, 3000)
    socket.addEventListener('close', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.close()
  })
  await fetch(`${debuggerUrl}/json/close/${target.id}`, { signal: AbortSignal.timeout(5000) }).catch(() => undefined)
}
