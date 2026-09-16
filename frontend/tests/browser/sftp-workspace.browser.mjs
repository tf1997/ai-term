import assert from 'node:assert/strict'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installSftpFixture } from './sftp-tauri-fixture.mjs'

// Start Vite on 4183 and a disposable headless Edge/Chrome on 9233 first.
// Never run this against the native application: synthetic IPC is installed on a new browser tab.
const debuggerUrl = process.env.AI_TERM_SFTP_CDP_URL ?? 'http://127.0.0.1:9233'
const appUrl = process.env.AI_TERM_SFTP_APP_URL ?? 'http://127.0.0.1:4183'
const outputDirectory = resolve(process.env.AI_TERM_SFTP_OUTPUT ?? join(dirname(fileURLToPath(import.meta.url)), '../../../outputs/sftp-remediation-2026-09-15'))
mkdirSync(outputDirectory, { recursive: true })
const target = await fetch(`${debuggerUrl}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(5000) }).then(response => response.json())
const socket = new WebSocket(target.webSocketDebuggerUrl)
const requests = new Map()
const exceptions = []
const checks = []
const screenshots = []
const measurements = []
const editorMeasurements = []
let sequence = 0
let dialogAccept = false

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { requests.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 15000)
    requests.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  const pending = requests.get(message.id)
  if (pending) {
    clearTimeout(pending.timer)
    requests.delete(message.id)
    if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
    else pending.resolve(message.result)
  }
  if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails)
  if (message.method === 'Page.javascriptDialogOpening') void send('Page.handleJavaScriptDialog', { accept: dialogAccept })
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
async function point(selector, reveal = true) {
  return evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('Missing element: ' + ${JSON.stringify(selector)});
    if (${reveal}) element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    const r = element.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height };
  })()`)
}
async function click(selector, options = {}) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const p = await point(selector)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
    await new Promise(resolve => setTimeout(resolve, 35))
    if (!p.width || !p.height) continue
    if (!await evaluate(`document.querySelector(${JSON.stringify(selector)})?.contains(document.elementFromPoint(${p.x}, ${p.y}))`)) continue
    const params = { x: p.x, y: p.y, button: options.button ?? 'left', modifiers: options.modifiers ?? 0, clickCount: options.double ? 2 : 1 }
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...params })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...params })
    return
  }
  throw new Error(`Cannot click visible element: ${selector}`)
}
async function press(key, modifiers = 0) {
  const codes = { Escape: 27, Tab: 9, Enter: 13, Home: 36, End: 35, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46, a: 65, l: 76, s: 83, ' ': 32 }
  const params = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: codes[key], modifiers }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...params, ...(key === 'Enter' ? { text: '\r' } : {}) })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
}
async function replaceText(selector, value) {
  await click(selector)
  await press('a', 2)
  if (value) await send('Input.insertText', { text: value })
  else await press('Delete')
  await waitFor(`document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`)
}
async function textButton(scope, label) {
  const selector = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll(${JSON.stringify(scope + ' button')})];
    const element = buttons.find(button => button.textContent.trim().replace(/\\s+/g, ' ') === ${JSON.stringify(label)} && button.getBoundingClientRect().width > 0);
    if (!element) throw new Error('Missing button ' + ${JSON.stringify(label)});
    element.dataset.sftpTestAction = 'current';
    return '[data-sftp-test-action="current"]';
  })()`)
  await click(selector)
  await evaluate(`document.querySelector(${JSON.stringify(selector)})?.removeAttribute('data-sftp-test-action')`)
}
const panel = '.files-panel:not([style*="display: none"])'
const local = `${panel} .local-pane`
const remote = `${panel} .remote-pane`
const row = (side, path) => `${side} [data-file-path=${JSON.stringify(path)}]`
const tab = id => `.session-tab-strip .tab[data-terminal-id=${JSON.stringify(id)}] .tab-select`
const nativeCalls = cmd => evaluate(`window.__sftpFixture.calls.filter(call => call.cmd === ${JSON.stringify(cmd)})`)
async function pathOf(side) {
  return evaluate(`(() => { const buttons = [...document.querySelectorAll(${JSON.stringify(side + ' .file-location-crumbs button')})]; return (buttons.at(-1)?.title ?? document.querySelector(${JSON.stringify(side + ' .file-location-control input')})?.value)?.replaceAll(String.fromCharCode(92), '/'); })()`)
}
async function navigate(side, path) {
  await click(`${side} .file-list`)
  await press('l', 2)
  const input = `${side} .file-location-control input`
  await waitFor(`document.activeElement === document.querySelector(${JSON.stringify(input)})`)
  await replaceText(input, path)
  await press('Enter')
  await waitFor(`document.querySelector(${JSON.stringify(side + ' .file-location-crumbs button:last-child')})?.title.replaceAll(String.fromCharCode(92), '/') === ${JSON.stringify(path)}`)
  await waitFor(`document.querySelector(${JSON.stringify(side + ' [data-file-path]')}) && document.querySelector(${JSON.stringify(side + ' .file-list')})?.getAttribute('aria-busy') === 'false'`)
}
async function connectProfile(name) {
  const before = await evaluate('document.querySelector(".session-tab-strip .tab.active")?.dataset.terminalId')
  const trigger = '.app-rail button[aria-controls="left-sidebar-panel"]:first-child'
  if (await evaluate(`document.querySelector(${JSON.stringify(trigger)}).getAttribute('aria-expanded') !== 'true'`)) await click(trigger)
  const selector = await evaluate(`(() => { const cards = [...document.querySelectorAll('.server-card')]; const index = cards.findIndex(card => card.textContent.includes(${JSON.stringify(name)})); if (index < 0) throw new Error('Missing profile'); return '.server-card:nth-of-type(' + (index + 1) + ')'; })()`)
  await click(selector, { double: true })
  await waitFor(`document.querySelector('.session-tab-strip .tab.active .status-dot.live') && document.querySelector('.session-tab-strip .tab.active')?.dataset.terminalId !== ${JSON.stringify(before)}`)
  return evaluate(`document.querySelector('.session-tab-strip .tab.active').dataset.terminalId`)
}
async function showFiles() {
  await click('#session-view-files')
  await waitFor(`document.querySelector(${JSON.stringify(panel + ' .remote-pane [data-file-path]')})`)
}
async function screenshot(name) {
  await evaluate('document.fonts.ready.then(() => true)')
  const capture = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const path = join(outputDirectory, name)
  writeFileSync(path, Buffer.from(capture.data, 'base64'))
  return path
}
async function selected(side) {
  return evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(side + ' [data-file-path][aria-selected="true"]')}), element => element.dataset.filePath)`)
}
async function browserSnapshot(side) {
  return evaluate(`(() => {
    const pane = document.querySelector(${JSON.stringify(side)});
    return {
      draft: pane.querySelector('.file-location-control input')?.value,
      selected: [...pane.querySelectorAll('[data-file-path][aria-selected="true"]')].map(row => row.dataset.filePath),
      scroll: pane.querySelector('.file-list').scrollTop,
      backDisabled: pane.querySelector('.file-pane-location > button:nth-child(1)').disabled,
      forwardDisabled: pane.querySelector('.file-pane-location > button:nth-child(2)').disabled,
      search: pane.querySelector('.file-search input').value,
      firstPath: pane.querySelector('[data-file-path]')?.dataset.filePath,
    };
  })()`)
}
async function ready() {
  await waitFor(`document.querySelector(${JSON.stringify(remote + ' [data-file-path]')}) && !document.querySelector(${JSON.stringify(panel + ' .file-connection-status')})`)
}
async function dismissNotices() {
  while (await evaluate('Boolean(document.querySelector(".toast-stack button"))')) await click('.toast-stack button')
  if (await evaluate(`Boolean(document.querySelector(${JSON.stringify(panel + ' button[aria-label="关闭提示"]')}))`)) await click(`${panel} button[aria-label="关闭提示"]`)
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
  await send('Browser.grantPermissions', { origin: new URL(appUrl).origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] })
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(${installSftpFixture.toString()})()` })
  await send('Page.navigate', { url: appUrl })
  await waitFor('document.querySelectorAll(".server-card").length === 2 && document.querySelector(".terminal-stack .xterm")')
  await evaluate('localStorage.removeItem("ai-term:file-locations:v1")')
  await check('an unconnected file view offers connection selection and disables upload until a target is ready', async () => {
    await click('#session-view-files')
    await waitFor(`document.querySelector(${JSON.stringify(local + ' [data-file-path]')})`)
    assert.ok(await evaluate(`Boolean(document.querySelector(${JSON.stringify(remote + ' select[aria-label="选择远程连接"]')}))`))
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(local + ' .file-pane-actions > button:last-child')}).disabled`), true)
    assert.equal((await nativeCalls('sftp_probe')).length, 0)
    await click('#session-view-terminal')
  })
  const alphaId = await connectProfile('Atlas')
  await showFiles()
  await check('file menus take keyboard focus and Escape returns to the source row', async () => {
    const row = `${remote} [data-file-path]`
    await click(row, { button: 'right' })
    await waitFor('document.querySelector(".context-menu")?.contains(document.activeElement)')
    const originalPath = await evaluate('document.querySelector(".context-menu").__vueParentComponent.props.sourceElement.dataset.filePath')
    await press('End')
    assert.equal(await evaluate('document.activeElement === document.querySelector(".context-menu button:last-child")'), true)
    await press('ArrowUp')
    await press('Escape')
    await waitFor('!document.querySelector(".context-menu")')
    assert.equal(await evaluate('document.activeElement?.dataset.filePath'), originalPath)
  })
  await check('multi-address discovery skips loopback, deduplicates and falls back to reachable interface', async () => {
    const probes = await nativeCalls('sftp_probe')
    assert.deepEqual(probes.map(call => call.targetHost), ['10.20.0.17', '172.20.0.17'])
    assert.equal(await pathOf(remote), '/srv/atlas', 'Initial directory must prefer the real terminal cwd over login home')
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(remote + ' .file-pane-identity')})?.textContent.trim()`), 'deploy@172.20.0.17')
  })
  await check('failed candidates retain separate network, authentication and host-key reasons; retry prefers last success', async () => {
    await evaluate(`Object.assign(window.__sftpFixture.probePlan, {
      '172.20.0.17': { error: 'authentication failed: fixture credential rejected' },
      '2001:db8::17': { error: 'host key verification failed: fixture changed key' }
    })`)
    const before = (await nativeCalls('sftp_probe')).length
    await textButton(panel + ' .panel-actions', '重新检测')
    await waitFor(`document.querySelector(${JSON.stringify(panel + ' .file-connection-status.error')})`)
    assert.deepEqual((await nativeCalls('sftp_probe')).slice(before).map(call => call.targetHost), ['172.20.0.17', '10.20.0.17', '2001:db8::17'])
    await click(`${panel} .file-connection-failures summary`)
    const reasons = await evaluate(`document.querySelector(${JSON.stringify(panel + ' .file-connection-failures')}).textContent`)
    for (const reason of ['认证失败', '网络连接失败', '主机密钥校验失败']) assert.ok(reasons.includes(reason), reason)
    screenshots.push(await screenshot('sftp-candidate-errors.png'))
    await evaluate(`delete window.__sftpFixture.probePlan['172.20.0.17']; delete window.__sftpFixture.probePlan['2001:db8::17']`)
    await textButton(panel + ' .file-connection-status', '重试')
    await ready()
    assert.equal(await pathOf(remote), '/srv/atlas')
    assert.equal((await nativeCalls('sftp_probe')).at(-1).targetHost, '172.20.0.17')
  })
  await check('connection cancellation reaches native task and ignores a late successful response', async () => {
    await evaluate(`window.__sftpFixture.probePlan['172.20.0.17'] = { hold: true }`)
    await textButton(panel + ' .panel-actions', '重新检测')
    await waitFor('window.__sftpFixture.pendingProbeIds().length === 1')
    const held = await evaluate('window.__sftpFixture.pendingProbeIds()[0]')
    await textButton(panel + ' .panel-actions', '取消连接')
    await waitFor(`document.querySelector(${JSON.stringify(panel + ' .file-connection-status.error')})?.textContent.includes('已取消')`)
    assert.ok((await nativeCalls('cancel_task')).some(call => call.taskId === held))
    await evaluate(`window.__sftpFixture.finishProbe(${JSON.stringify(held)})`)
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.equal(await evaluate(`Boolean(document.querySelector(${JSON.stringify(remote + ' [data-file-path]')}))`), false)
    await evaluate(`delete window.__sftpFixture.probePlan['172.20.0.17']`)
    await textButton(panel + ' .file-connection-status', '重试')
    await ready()
  })
  await check('identity cancellation returns to a retryable state without blocking view navigation', async () => {
    await evaluate(`window.__sftpFixture.identityMode.alpha = 'hold'`)
    await textButton(panel + ' .panel-actions', '重新检测')
    await waitFor(`document.querySelector(${JSON.stringify(panel + ' .file-connection-status')})?.textContent.includes('正在识别')`)
    await textButton(panel + ' .panel-actions', '取消连接')
    await evaluate(`delete window.__sftpFixture.identityMode.alpha; window.__sftpFixture.prompt('alpha')`)
    await new Promise(resolve => setTimeout(resolve, 250))
    await textButton(panel + ' .file-connection-status', '重试')
    await ready()
  })
  await check('missing identity output times out while terminal/files navigation stays available, then retries', async () => {
    await evaluate(`window.__sftpFixture.identityMode.alpha = 'hold'`)
    await textButton(panel + ' .panel-actions', '重新检测')
    await waitFor(`document.querySelector(${JSON.stringify(panel + ' .file-connection-status')})?.textContent.includes('正在识别')`)
    await click('#session-view-terminal')
    assert.equal(await evaluate('document.querySelector("#session-view-terminal").getAttribute("aria-selected")'), 'true')
    await click('#session-view-files')
    await waitFor(`document.querySelector(${JSON.stringify(panel + ' .file-connection-status.error')})?.textContent.includes('超时')`, 14500)
    screenshots.push(await screenshot('sftp-identity-timeout.png'))
    await evaluate(`delete window.__sftpFixture.identityMode.alpha; window.__sftpFixture.prompt('alpha')`)
    await new Promise(resolve => setTimeout(resolve, 250))
    await textButton(panel + ' .file-connection-status', '重试')
    await ready()
  })
  await check('keyboard navigation selects rows, enters directories, goes up and opens a labelled path input', async () => {
    await click(row(remote, '/srv/atlas/archive'))
    await press('ArrowDown')
    await waitFor(`document.activeElement?.dataset.filePath === '/srv/atlas/config'`)
    assert.deepEqual(await selected(remote), ['/srv/atlas/config'])
    await press('Enter')
    await waitFor(`document.querySelector(${JSON.stringify(remote + ' .file-location-crumbs button:last-child')})?.title === '/srv/atlas/config'`)
    await press('ArrowUp', 1)
    await waitFor(`document.querySelector(${JSON.stringify(remote + ' .file-location-crumbs button:last-child')})?.title === '/srv/atlas'`)
    await press('l', 2)
    assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), '远端目录路径')
    await press('Escape')
    await navigate(local, 'C:/fixture/release-a')
    await navigate(remote, '/srv/atlas/config')
  })
  await check('re-detecting the same server preserves the chosen path and both browser histories', async () => {
    const before = (await nativeCalls('sftp_probe')).length
    await textButton(panel + ' .panel-actions', '重新检测')
    await ready()
    assert.equal(await pathOf(local), 'C:/fixture/release-a')
    assert.equal(await pathOf(remote), '/srv/atlas/config')
    assert.equal((await nativeCalls('sftp_probe')).length, before + 1)
    await click(`${remote} button[aria-label="远端后退"]`)
    await waitFor(`document.querySelector(${JSON.stringify(remote + ' .file-location-crumbs button:last-child')})?.title === '/srv/atlas'`)
    await click(`${remote} button[aria-label="远端前进"]`)
    await waitFor(`document.querySelector(${JSON.stringify(remote + ' .file-location-crumbs button:last-child')})?.title === '/srv/atlas/config'`)
    await click(`${local} button[aria-label="本地后退"]`)
    await waitFor(`document.querySelector(${JSON.stringify(local + ' .file-location-crumbs button:last-child')})?.title.replaceAll(String.fromCharCode(92), '/') === 'C:/fixture'`)
    await click(`${local} button[aria-label="本地前进"]`)
    await waitFor(`document.querySelector(${JSON.stringify(local + ' .file-location-crumbs button:last-child')})?.title.replaceAll(String.fromCharCode(92), '/') === 'C:/fixture/release-a'`)
  })
  await check('locate terminal directory is an explicit action and preserves browser back history', async () => {
    await evaluate(`window.__sftpFixture.identities.alpha.pwd = '/srv/atlas/live'`)
    await textButton(panel + ' .file-workspace-tools', '终端目录')
    await waitFor(`document.querySelector(${JSON.stringify(remote + ' .file-location-crumbs button:last-child')})?.title === '/srv/atlas/live'`)
    await click(`${remote} button[aria-label="远端后退"]`)
    await waitFor(`document.querySelector(${JSON.stringify(remote + ' .file-location-crumbs button:last-child')})?.title === '/srv/atlas/config'`)
    await evaluate(`window.__sftpFixture.identities.alpha.pwd = '/srv/atlas'`)
  })
  await check('hidden-file toggle and search retain readable file names and offer an actionable empty state', async () => {
    const hidden = row(local, 'C:/fixture/release-a/.env')
    assert.equal(await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(hidden)})).opacity`), '1')
    await click(`${panel} button[aria-label="隐藏隐藏文件"]`)
    assert.equal(await evaluate(`Boolean(document.querySelector(${JSON.stringify(hidden)}))`), false)
    await click(`${panel} button[aria-label="显示隐藏文件"]`)
    await replaceText(`${local} .file-search input`, 'not-in-this-directory')
    await waitFor(`document.querySelectorAll(${JSON.stringify(local + ' [data-file-path]')}).length === 0`)
    await textButton(local, '清除筛选')
    await waitFor(`document.querySelectorAll(${JSON.stringify(local + ' [data-file-path]')}).length > 60`)
    await replaceText(`${local} .file-search input`, 'service-')
    await waitFor(`document.querySelectorAll(${JSON.stringify(local + ' [data-file-path]')}).length === 70`)
    await replaceText(`${local} .file-search input`, '')
  })
  let transferId
  await check('batch upload fixes source, destination and target ownership while exposing cancellable queue progress', async () => {
    await click(row(local, 'C:/fixture/release-a/bundle.tar'))
    await click(row(local, 'C:/fixture/release-a/notes.txt'), { modifiers: 2 })
    assert.deepEqual(await selected(local), ['C:/fixture/release-a/bundle.tar', 'C:/fixture/release-a/notes.txt'])
    await click(`${local} .file-pane-actions > button:last-child`)
    await waitFor('window.__sftpFixture.pendingTransferIds().length === 1')
    transferId = await evaluate('window.__sftpFixture.pendingTransferIds()[0]')
    await waitFor(`document.querySelector(${JSON.stringify(panel + ' .file-active-transfer')})?.textContent.includes('45%')`)
    const upload = (await nativeCalls('sftp_upload_path')).at(-1)
    assert.equal(upload.localPath, 'C:/fixture/release-a/bundle.tar')
    assert.equal(upload.remoteDir, '/srv/atlas/config')
    assert.equal(upload.connectionId, 'alpha')
    assert.equal(upload.targetHost, '172.20.0.17')
    await click('.session-task-toggle')
    await waitFor('document.querySelectorAll(".file-task-list li").length === 2')
    assert.equal(await evaluate('document.querySelectorAll(".file-task-list li.queued").length'), 1)
    assert.ok(await evaluate('document.querySelector(".file-task-list li.running .file-task-metrics").textContent.includes("512 B/s")'))
    assert.ok(await evaluate('document.querySelector(".file-task-list li.running .file-task-metrics").textContent.includes("5秒")'))
    for (let index = 0; index < 7; index++) {
      await press('Tab')
      assert.ok(await evaluate('document.querySelector(".file-task-center").contains(document.activeElement)'), 'Task popup traps forward keyboard focus')
    }
    await textButton('.file-task-list li.queued', '取消')
    await waitFor('document.querySelectorAll(".file-task-list li.cancelled").length === 1')
    await press('Escape')
    await waitFor('!document.querySelector(".file-task-center")')
  })
  let alphaLocal, alphaRemote, betaId, betaLocal, betaRemote
  await check('A upload continues during A → B → A; both sessions retain path pair, drafts, selection, scroll and mode', async () => {
    await click(row(remote, '/srv/atlas/config/service-30.log'))
    await click(row(local, 'C:/fixture/release-a/service-25.log'))
    for (const side of [local, remote]) {
      const p = await point(`${side} .file-list`)
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY: 320 })
    }
    await click(`${local} button[aria-label="编辑本地目录路径"]`)
    await replaceText(`${local} .file-location-control input`, 'C:/fixture/draft-alpha')
    await click(`${remote} button[aria-label="编辑远端目录路径"]`)
    await replaceText(`${remote} .file-location-control input`, '/srv/atlas/draft-not-submitted')
    alphaLocal = await browserSnapshot(local)
    alphaRemote = await browserSnapshot(remote)
    assert.ok(alphaLocal.scroll > 0 && alphaRemote.scroll > 0)
    await evaluate(`window.__alphaPanel = document.querySelector(${JSON.stringify(panel)})`)
    await textButton(panel + ' .transfer-mode-tabs', '终端传输')
    await replaceText(`${panel} input[aria-label="终端传输远端路径"]`, '/srv/atlas/terminal-draft')
    betaId = await connectProfile('Borealis')
    assert.equal(await evaluate('document.querySelector("#session-view-terminal").getAttribute("aria-selected")'), 'true', 'A new terminal starts in its own terminal view')
    await showFiles()
    assert.equal(await pathOf(remote), '/srv/borealis')
    await navigate(local, 'C:/fixture/release-b')
    await navigate(remote, '/srv/borealis/logs')
    await click(row(local, 'C:/fixture/release-b/service-10.log'))
    await click(row(remote, '/srv/borealis/logs/service-15.log'))
    betaLocal = await browserSnapshot(local)
    betaRemote = await browserSnapshot(remote)
    await click('.session-task-toggle')
    await waitFor('document.querySelector(".file-task-list li.running")')
    assert.equal(await evaluate('document.querySelector(".file-task-list li.running .file-task-owner").textContent.trim()'), 'deploy@172.20.0.17 · SFTP')
    assert.equal(await evaluate('document.querySelector(".file-task-list li.running progress").value'), 45)
    assert.equal((await nativeCalls('cancel_task')).filter(call => call.taskId === transferId).length, 0)
    screenshots.push(await screenshot('sftp-background-transfer-owner.png'))
    await press('Escape')
    await click(tab(alphaId))
    await waitFor(`document.querySelector(${JSON.stringify(panel)}) === window.__alphaPanel`)
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(panel + ' .transfer-mode-tabs button[aria-pressed="true"]')}).textContent.trim()`), '终端传输')
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(panel + ' input[aria-label="终端传输远端路径"]')}).value`), '/srv/atlas/terminal-draft')
    await textButton(panel + ' .transfer-mode-tabs', 'SFTP')
    assert.deepEqual(await browserSnapshot(local), alphaLocal)
    assert.deepEqual(await browserSnapshot(remote), alphaRemote)
    await click(tab(betaId))
    assert.deepEqual(await browserSnapshot(local), betaLocal)
    assert.deepEqual(await browserSnapshot(remote), betaRemote)
    assert.equal((await nativeCalls('cancel_task')).filter(call => call.taskId === transferId).length, 0)
  })
  await check('global completed result returns to its original session and original target directory', async () => {
    await evaluate(`window.__sftpFixture.finishTransfer(${JSON.stringify(transferId)})`)
    await click('.session-task-toggle')
    await waitFor('document.querySelector(".file-task-list li.done")')
    await textButton('.file-task-list li.done', '复制路径')
    await waitFor('document.querySelector(".file-task-feedback")?.textContent.includes("已复制")')
    assert.equal(await evaluate('navigator.clipboard.readText()'), '/srv/atlas/config/bundle.tar')
    assert.ok(await evaluate('Boolean(document.querySelector(".file-task-list li.done time")?.getAttribute("datetime"))'))
    await textButton('.file-task-list li.done', '打开位置')
    await waitFor(`document.querySelector('.session-tab-strip .tab.active')?.dataset.terminalId === ${JSON.stringify(alphaId)}`)
    await ready()
    await waitFor(`document.querySelector(${JSON.stringify(remote + ' [data-file-path="/srv/atlas/config/bundle.tar"]')})?.getAttribute('aria-selected') === 'true'`)
    assert.equal(await pathOf(remote), '/srv/atlas/config')
    const last = (await nativeCalls('sftp_list_directory')).findLast(call => call.path === '/srv/atlas/config')
    assert.equal(last.connectionId, 'alpha')
    assert.equal(last.targetHost, '172.20.0.17')
    assert.equal(last.path, '/srv/atlas/config')
    assert.deepEqual(await selected(remote), ['/srv/atlas/config/bundle.tar'])
  })
  await check('same SSH identity change blocks editor save, keeps draft, and leaves the original target visible', async () => {
    // Result navigation uses a manual binding; re-detect restores terminal identity verification.
    await textButton(panel + ' .panel-actions', '重新检测')
    await ready()
    await navigate(remote, '/srv/atlas/config')
    await click(row(remote, '/srv/atlas/config/config.txt'), { double: true })
    await waitFor('document.querySelector(".remote-file-editor-textarea")')
    await replaceText('.remote-file-editor-textarea', 'name=atlas\nunsaved=keep-me\n')
    await evaluate(`window.__sftpFixture.identities.alpha = { username: 'root', hostname: 'other-server', ips: ['10.40.0.99'], pwd: '/root', machine: 'cccccccccccccccccccccccccccccccc' }`)
    await textButton('.remote-file-editor-modal', '保存到原服务器')
    await waitFor('document.querySelector(".file-editor-target-warning")')
    assert.equal(await evaluate('document.querySelector(".remote-file-editor-textarea").value'), 'name=atlas\nunsaved=keep-me\n')
    assert.equal((await nativeCalls('sftp_save_text_file')).length, 0, 'A changed server must receive no write at all')
    assert.equal(await evaluate('Array.from(document.querySelectorAll(".remote-file-editor-modal button")).find(b => b.textContent.trim() === "保存到原服务器")?.disabled'), true)
    assert.ok(await evaluate('document.querySelector(".remote-file-editor-modal .modal-head").textContent.includes("deploy@172.20.0.17")'))
    editorMeasurements.push(await evaluate(`(() => {
      const modal = document.querySelector('.remote-file-editor-modal');
      const area = modal.querySelector('textarea');
      const warning = modal.querySelector('.file-editor-target-warning');
      return { modalHeight: modal.getBoundingClientRect().height, textareaHeight: area.getBoundingClientRect().height, warningHeight: warning.getBoundingClientRect().height, gridRows: getComputedStyle(modal).gridTemplateRows };
    })()`))
    screenshots.push(await screenshot('sftp-editor-stale-draft.png'))
    await press('Escape')
    await waitFor('document.querySelector(".remote-file-editor-textarea")')
    assert.equal(await evaluate('document.querySelector(".remote-file-editor-textarea").value'), 'name=atlas\nunsaved=keep-me\n', 'Rejecting discard keeps the draft modal')
    dialogAccept = true
    await click('button[aria-label="关闭编辑器"]')
    await waitFor('!document.querySelector(".remote-file-editor-textarea")')
    dialogAccept = false
    await evaluate(`window.__sftpFixture.identities.alpha = { username: 'deploy', hostname: 'atlas', ips: ['10.20.0.17','172.20.0.17','2001:db8::17'], pwd: '/srv/atlas', machine: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }; window.__sftpFixture.prompt('alpha')`)
    await new Promise(resolve => setTimeout(resolve, 100))
    await textButton(panel + ' .panel-actions', '连接')
    await ready()
  })
  await check('refresh only lists the directory; returning to expired cached data refreshes without losing position', async () => {
    await navigate(remote, '/srv/atlas/config')
    await click(row(remote, '/srv/atlas/config/service-25.log'))
    const before = await browserSnapshot(remote)
    const probes = (await nativeCalls('sftp_probe')).length
    const identities = (await nativeCalls('terminal_write')).length
    const listing = (await nativeCalls('sftp_list_directory')).length
    await click(`${remote} button[aria-label="刷新远端目录"]`)
    await waitFor(`window.__sftpFixture.calls.filter(call => call.cmd === 'sftp_list_directory').length > ${listing}`)
    assert.equal((await nativeCalls('sftp_probe')).length, probes)
    assert.equal((await nativeCalls('terminal_write')).length, identities)
    const afterManual = (await nativeCalls('sftp_list_directory')).length
    await click('#session-view-terminal')
    await evaluate('window.__sftpFixture.advanceWallClock(31000)')
    await showFiles()
    await waitFor(`window.__sftpFixture.calls.filter(call => call.cmd === 'sftp_list_directory').length > ${afterManual}`)
    assert.deepEqual(await browserSnapshot(remote), before)
    assert.ok(await evaluate(`document.querySelector(${JSON.stringify(remote + ' .file-pane-footer')}).textContent.includes('更新于')`))
  })
  await check('directory failure keeps the cached selection and retries listing without reconnecting', async () => {
    const selection = await selected(remote)
    const probes = (await nativeCalls('sftp_probe')).length
    await evaluate(`window.__sftpFixture.directoryErrors['/srv/atlas/config'] = 'permission denied: synthetic directory'`)
    await click(`${remote} button[aria-label="刷新远端目录"]`)
    await waitFor(`document.querySelector(${JSON.stringify(remote + ' .file-directory-error')})?.textContent.includes('permission denied')`)
    assert.deepEqual(await selected(remote), selection)
    await evaluate(`delete window.__sftpFixture.directoryErrors['/srv/atlas/config']`)
    await textButton(remote + ' .file-directory-error', '重试')
    await waitFor(`!document.querySelector(${JSON.stringify(remote + ' .file-directory-error')})`)
    assert.equal((await nativeCalls('sftp_probe')).length, probes)
    assert.deepEqual(await selected(remote), selection)
  })
  await check('bookmarks, recent paths, completion and a named local/remote path pair remain usable', async () => {
    await navigate(local, 'C:/fixture/release-a')
    await navigate(remote, '/srv/atlas/config')
    for (const [side, label] of [[local, '本地'], [remote, '远端']]) {
      await click(`${side} button[aria-label="${label}收藏与最近目录"]`)
      await textButton('.file-location-menu', '收藏当前目录')
      assert.ok(await evaluate('document.querySelector(".file-location-menu").textContent.includes("最近访问")'))
      await press('Escape')
    }
    await textButton(panel + ' .file-workspace-tools', '路径组合')
    await replaceText(`${panel} .file-path-pairs input`, 'Atlas 发布')
    await click(`${panel} .file-path-pairs button[type="submit"]`)
    await waitFor(`document.querySelector(${JSON.stringify(panel + ' .file-path-pairs')})?.textContent.includes('Atlas 发布')`)
    await textButton(panel + ' .file-path-pairs', '收起')
    await navigate(local, 'C:/fixture/output')
    await navigate(remote, '/srv/atlas/logs')
    await textButton(panel + ' .file-workspace-tools', '路径组合')
    await click(`${panel} .file-path-pairs li button:first-child`)
    await waitFor(`document.querySelector(${JSON.stringify(remote + ' .file-location-crumbs button:last-child')})?.title === '/srv/atlas/config'`)
    assert.equal(await pathOf(local), 'C:/fixture/release-a')
    await click(`${remote} button[aria-label="编辑远端目录路径"]`)
    await replaceText(`${remote} .file-location-control input`, '/srv/atlas/co')
    await waitFor(`Array.from(document.querySelectorAll(${JSON.stringify(remote + ' datalist option')})).some(option => option.value === '/srv/atlas/config')`)
    await press('Escape')
  })
  await check('splitter clamps mouse and keyboard resizing and both themes fit 1280×820 and 980×640', async () => {
    await dismissNotices()
    const splitter = `${panel} .file-pane-resizer`
    await evaluate(`document.querySelector(${JSON.stringify(splitter)}).focus()`)
    for (const [key, expected] of [['Home', '35'], ['ArrowLeft', '35'], ['End', '65'], ['ArrowRight', '65']]) {
      await press(key)
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(splitter)}).getAttribute('aria-valuenow')`), expected)
    }
    for (const [x, expected] of [[0, '35'], [1279, '65']]) {
      const p = await point(splitter)
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: p.y, button: 'left', buttons: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: p.y, button: 'left', clickCount: 1 })
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(splitter)}).getAttribute('aria-valuenow')`), expected)
    }
    await evaluate(`document.querySelector(${JSON.stringify(splitter)}).focus()`)
    await press('Home')
    for (let index = 0; index < 8; index++) await press('ArrowRight')
    for (const theme of ['dark', 'light']) {
      if (!await evaluate(`Boolean(document.querySelector('.app-shell.theme-${theme}'))`)) await click(`button[title="${theme === 'light' ? '切换白色主题' : '切换深色主题'}"]`)
      await dismissNotices()
      for (const [width, height] of [[1280, 820], [980, 640]]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
        await new Promise(resolve => setTimeout(resolve, 150))
        const measure = await evaluate(`(() => {
          const names = { local: ${JSON.stringify(local)}, remote: ${JSON.stringify(remote)} };
          const bounds = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
          const alignment = selector => {
            const head = document.querySelector(selector + ' .file-grid-head');
            const row = document.querySelector(selector + ' [data-file-path]');
            const cells = element => [...element.children].map(cell => { const r = cell.getBoundingClientRect(); return { x: r.x, width: r.width }; });
            const textBounds = element => { const range = document.createRange(); range.selectNodeContents(element); const r = range.getBoundingClientRect(); return { x: r.x, right: r.right, width: r.width }; };
            return { headerColumns: getComputedStyle(head).gridTemplateColumns, rowColumns: getComputedStyle(row).gridTemplateColumns, headers: cells(head), row: cells(row), sizeText: { header: textBounds(head.querySelector('[role="columnheader"]:nth-child(2) button')), row: textBounds(row.querySelector('.file-cell-size')), display: getComputedStyle(row.querySelector('.file-cell-size')).display } };
          };
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          const rgba = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); const [r,g,b,a] = ctx.getImageData(0,0,1,1).data; return [r,g,b,a/255]; };
          const over = (fg, bg) => { const alpha = fg[3] + bg[3] * (1 - fg[3]); return [...[0,1,2].map(index => alpha ? (fg[index] * fg[3] + bg[index] * bg[3] * (1 - fg[3])) / alpha : 0), alpha]; };
          const light = color => color.slice(0,3).map(channel => { const v = channel / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
          const contrast = (selector, pseudo) => {
            const element = document.querySelector(selector), chain = []; let parent = element;
            while (parent) { chain.unshift(parent); parent = parent.parentElement; }
            const background = chain.reduce((color, node) => over(rgba(getComputedStyle(node).backgroundColor), color), [255,255,255,1]);
            const style = getComputedStyle(element, pseudo), fg = rgba(style.color); fg[3] *= Number(style.opacity);
            const foreground = over(fg, background), a = light(foreground), b = light(background);
            return { color: style.color, background: background.slice(0,3).map(Math.round), ratio: Math.round(((Math.max(a,b) + 0.05) / (Math.min(a,b) + 0.05)) * 100) / 100 };
          };
          return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
            panes: Object.fromEntries(Object.entries(names).map(([name, selector]) => [name, { ...bounds(selector + ' .file-list'), rowHeight: bounds(selector + ' [data-file-path]').height, alignment: alignment(selector) }])),
            contrast: { metadata: contrast(names.local + ' .file-cell-time'), footer: contrast(names.local + ' .file-pane-footer span'), placeholder: contrast(names.local + ' .file-search input', '::placeholder') },
            locationInputsLabelled: [...document.querySelectorAll(${JSON.stringify(panel + ' .file-location-control input')})].every(input => Boolean(input.getAttribute('aria-label'))),
          };
        })()`)
        measurements.push({ theme, ...measure })
        screenshots.push(await screenshot(`sftp-${theme}-${width}x${height}.png`))
        assert.ok(measure.documentWidth <= width, `${theme}/${width}: document horizontal overflow`)
        for (const [side, list] of Object.entries(measure.panes)) {
          assert.ok(list.height >= 220, `${theme}/${width}: ${side} file list must have useful height, got ${list.height}`)
          assert.ok(list.bottom <= height + 1 && list.right <= width + 1 && list.x >= -1 && list.y >= -1, `${theme}/${width}: ${side} list fits viewport`)
          assert.ok(list.rowHeight <= 38, `${theme}/${width}: compact rows`)
        }
      }
    }
    for (const measure of measurements) {
      for (const [side, pane] of Object.entries(measure.panes)) {
        for (let index = 0; index < 3; index++) {
          assert.ok(Math.abs(pane.alignment.headers[index].x - pane.alignment.row[index].x) <= 2, `${measure.theme}/${measure.width}: ${side} header column ${index + 1} must align with data`)
          assert.ok(Math.abs(pane.alignment.headers[index].width - pane.alignment.row[index].width) <= 2, `${measure.theme}/${measure.width}: ${side} header column ${index + 1} width`)
        }
        assert.ok(Math.abs(pane.alignment.sizeText.header.right - pane.alignment.sizeText.row.right) <= 2, `${measure.theme}/${measure.width}: ${side} size header and cell text must share a right edge`)
      }
      for (const [name, colors] of Object.entries(measure.contrast)) assert.ok(colors.ratio >= 4.5, `${measure.theme}/${measure.width}: ${name} contrast ${colors.ratio} must reach 4.5:1`)
    }
    for (const measure of editorMeasurements) assert.ok(measure.textareaHeight >= measure.modalHeight * 0.45, 'Editor warning must leave most of the modal available for the preserved draft')
  })
  await check('a result whose terminal was closed creates a file-only session with its original host, directory and route', async () => {
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false })
    const upload = (await nativeCalls('sftp_upload_path')).find(call => call.taskId === transferId)
    assert.ok(upload?.profileRoute, 'The original background upload must carry a frozen native profile route')
    await click(tab(betaId))
    await click(`.session-tab-strip .tab[data-terminal-id=${JSON.stringify(alphaId)}] .tab-close`)
    await waitFor(`!document.querySelector(${JSON.stringify(tab(alphaId))})`)
    const originalNativeConnections = (await nativeCalls('connect_profile')).length
    const beforeProbes = (await nativeCalls('sftp_probe')).length
    const beforeLists = (await nativeCalls('sftp_list_directory')).length
    await click('.session-task-toggle')
    await textButton('.file-task-list li.done', '打开位置')
    await waitFor(`document.querySelector('.session-tab-strip .tab.active')?.dataset.terminalId !== ${JSON.stringify(betaId)} && document.querySelector('#session-view-files').getAttribute('aria-selected') === 'true'`)
    await ready()
    await waitFor(`document.querySelector(${JSON.stringify(remote + ' [data-file-path="/srv/atlas/config/bundle.tar"]')})?.getAttribute('aria-selected') === 'true'`)
    assert.equal(await pathOf(remote), '/srv/atlas/config')
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(remote + ' .file-pane-identity')}).textContent.trim()`), 'deploy@172.20.0.17')
    assert.equal((await nativeCalls('connect_profile')).length, originalNativeConnections, 'Opening an old SFTP result must not launch a new SSH shell')
    const probes = (await nativeCalls('sftp_probe')).slice(beforeProbes)
    assert.ok(probes.length > 0)
    assert.equal(probes.at(-1).targetHost, '172.20.0.17')
    assert.equal(probes.at(-1).targetUsername, 'deploy')
    assert.equal(probes.at(-1).profileRoute, upload.profileRoute)
    const listing = (await nativeCalls('sftp_list_directory')).slice(beforeLists).findLast(call => call.path === '/srv/atlas/config')
    assert.ok(listing)
    assert.equal(listing.targetHost, '172.20.0.17')
    assert.equal(listing.profileRoute, upload.profileRoute)
    screenshots.push(await screenshot('sftp-closed-session-result.png'))
  })
  await check('restart restores server/account preferences, bookmarks, path pairs, density, hidden toggle and split', async () => {
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false })
    await click(`${panel} button[aria-label="文件显示设置"]`)
    await click(`${panel} button[aria-label="隐藏隐藏文件"]`)
    const storage = await evaluate('JSON.parse(localStorage.getItem("ai-term:file-locations:v1"))')
    assert.equal(storage.density, 'comfortable')
    assert.equal(storage.showHidden, false)
    const key = JSON.stringify(['alpha', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'deploy'])
    assert.equal(storage.servers[key].local, 'C:/fixture/release-a')
    assert.equal(storage.servers[key].remote, '/srv/atlas/config')
    assert.deepEqual(storage.servers[key].remoteBookmarks, ['/srv/atlas/config'])
    assert.equal(storage.servers[key].pairs[0].name, 'Atlas 发布')
    const betaKey = JSON.stringify(['beta', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'ops'])
    assert.equal(storage.servers[betaKey].local, 'C:/fixture/release-b')
    assert.equal(storage.servers[betaKey].remote, '/srv/borealis/logs')
    await send('Page.reload')
    await waitFor('document.querySelectorAll(".server-card").length === 2 && document.querySelector(".terminal-stack .xterm")')
    await connectProfile('Atlas')
    await showFiles()
    assert.equal(await pathOf(local), 'C:/fixture/release-a')
    assert.equal(await pathOf(remote), '/srv/atlas/config')
    assert.ok(await evaluate(`document.querySelector(${JSON.stringify(panel)}).classList.contains('density-comfortable')`))
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(panel + ' .file-pane-resizer')}).getAttribute('aria-valuenow')`), String(storage.split))
    assert.equal(await evaluate(`Boolean(document.querySelector(${JSON.stringify(remote + ' .hidden-entry')}))`), false)
    await click(`${remote} button[aria-label="远端收藏与最近目录"]`)
    assert.ok(await evaluate('document.querySelector(".file-location-menu").textContent.includes("/srv/atlas/config")'))
    await press('Escape')
    await textButton(panel + ' .file-workspace-tools', '路径组合')
    assert.ok(await evaluate(`document.querySelector(${JSON.stringify(panel + ' .file-path-pairs')}).textContent.includes('Atlas 发布')`))
    await textButton(panel + ' .file-path-pairs', '收起')
    await click(`${panel} button[aria-label="文件显示设置"]`)
  })
  await check('terminal send failure has explicit feedback and manual-target recovery remains usable', async () => {
    await evaluate(`window.__sftpFixture.identityMode.alpha = 'send-error'`)
    await textButton(panel + ' .panel-actions', '重新检测')
    await waitFor(`document.querySelector(${JSON.stringify(panel + ' .file-connection-status')})?.textContent.includes('发送失败')`)
    assert.equal(await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(panel + ' .file-connection-status button')})).find(button => button.textContent.trim() === '重试').disabled`), false)
    await textButton(panel + ' .file-connection-status', '手动指定')
    await replaceText(`${panel} .file-manual-target label:nth-child(1) input`, '172.20.0.17')
    await replaceText(`${panel} .file-manual-target label:nth-child(2) input`, 'deploy')
    await click(`${panel} .file-manual-target button[type="submit"]`)
    await ready()
    assert.equal((await nativeCalls('sftp_probe')).at(-1).targetHost, '172.20.0.17')
  })
  assert.deepEqual(exceptions, [], 'No uncaught browser exceptions')
  const report = { result: 'passed', checks, screenshots, measurements, editorMeasurements, nativeBackendTested: false, fixture: 'actual Vue AppShell and components with synthetic Tauri IPC; clock offset ages caches without changing timers', outputDirectory }
  writeFileSync(join(outputDirectory, 'browser-report.json'), JSON.stringify(report, null, 2))
  for (const filename of ['failure.json', 'failure.png']) if (existsSync(join(outputDirectory, filename))) unlinkSync(join(outputDirectory, filename))
  console.log(JSON.stringify({ result: report.result, checkCount: checks.length, report: join(outputDirectory, 'browser-report.json'), screenshots, layouts: measurements.map(item => ({ theme: item.theme, viewport: `${item.width}x${item.height}`, listHeight: item.panes.local.height, minimumContrast: Math.min(...Object.values(item.contrast).map(colors => colors.ratio)) })), editorMeasurements, nativeBackendTested: false }, null, 2))
} catch (error) {
  const failure = await screenshot('failure.png').catch(() => null)
  const dom = await evaluate('document.body.innerText + (document.querySelector("vite-error-overlay")?.shadowRoot?.textContent ?? "")').catch(() => '')
  const calls = await evaluate('window.__sftpFixture?.calls').catch(() => [])
  const report = { result: 'failed', error: String(error), checks, failure, screenshots, measurements, editorMeasurements, dom, calls, exceptions, nativeBackendTested: false }
  writeFileSync(join(outputDirectory, 'failure.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(outputDirectory, 'browser-report.json'), JSON.stringify(report, null, 2))
  console.error('Failure artifact:', failure)
  throw error
} finally {
  for (const request of requests.values()) clearTimeout(request.timer)
  requests.clear()
  await new Promise(resolve => {
    if (socket.readyState === WebSocket.CLOSED) return resolve()
    const timer = setTimeout(resolve, 3000)
    socket.addEventListener('close', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.close()
  })
  await fetch(`${debuggerUrl}/json/close/${target.id}`, { signal: AbortSignal.timeout(5000) }).catch(() => undefined)
}
