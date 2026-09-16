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
const tabs = '.session-tab-strip > .tab'
const popover = '.terminal-tabs-popover'
const search = `${popover} .terminal-tab-search`
const terminalCount = 20
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

async function point(selector, visibleAncestor = false, reveal = true) {
  return evaluate(`(() => {
    let element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('Missing element: ' + ${JSON.stringify(selector)});
    if (${visibleAncestor}) {
      while (element.parentElement && !element.getBoundingClientRect().width) element = element.parentElement;
    }
    if (${reveal}) element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    const rectangle = element.getBoundingClientRect();
    return { x: rectangle.x + rectangle.width / 2, y: rectangle.y + rectangle.height / 2 };
  })()`)
}

async function click(selector, button = 'left') {
  const hoverPosition = await point(selector, true)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...hoverPosition })
  await waitFor(`document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect().width > 0`)
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const position = await point(selector)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position })
    await new Promise(resolve => setTimeout(resolve, 40))
    const settled = await point(selector, false, false)
    if (Math.abs(settled.x - position.x) > 0.5 || Math.abs(settled.y - position.y) > 0.5) continue
    if (!await evaluate(`document.querySelector(${JSON.stringify(selector)})?.contains(document.elementFromPoint(${position.x}, ${position.y}))`)) continue
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position, button, clickCount: 1 })
    return
  }
  throw new Error(`Cannot click a stable, visible element: ${selector}`)
}

async function press(key, modifiers = 0) {
  const keyCodes = { Escape: 27, Tab: 9, Enter: 13, Home: 36, End: 35, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46, a: 65 }
  const params = { key, code: key === 'a' ? 'KeyA' : key, windowsVirtualKeyCode: keyCodes[key], modifiers }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...params, ...(key === 'Enter' ? { text: '\r' } : {}) })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
}

async function replaceText(selector, value) {
  await click(selector)
  await press('a', await evaluate('/Mac/.test(navigator.platform)') ? 4 : 2)
  if (value) await send('Input.insertText', { text: value })
  else await press('Delete')
  await waitFor(`document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`)
}

function tab(id) { return `${tabs}[data-terminal-id=${JSON.stringify(id)}]` }
function row(id) { return `${popover} .terminal-switcher-row[data-terminal-id=${JSON.stringify(id)}]` }
async function tabIds() { return evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(tabs)}), tab => tab.dataset.terminalId)`) }
async function targetIds() { return evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(`${tabs}.target`)}), tab => tab.dataset.terminalId)`) }
async function activeId() { return evaluate(`document.querySelector(${JSON.stringify(`${tabs}.active`)})?.dataset.terminalId`) }

async function waitForTabCount(count) {
  await waitFor(`document.querySelectorAll(${JSON.stringify(tabs)}).length === ${count}
    && document.querySelector('.terminal-stack')?.children.length === ${count}
    && document.querySelectorAll('.terminal-stack .xterm').length === ${count}`)
}

async function waitForActive(id, keyboardFocus = false) {
  const selector = `${tab(id)} .tab-select`
  await waitFor(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-selected') === 'true'
    ${keyboardFocus ? `&& document.activeElement === document.querySelector(${JSON.stringify(selector)})` : ''}`)
}

async function assertActiveVisible() {
  // Do not click or scroll the active tab here: its reveal must come from the application.
  await waitFor(`(() => {
    const strip = document.querySelector('.session-tab-strip');
    const selected = strip?.querySelector('.tab.active');
    if (!strip || !selected) return false;
    const bounds = strip.getBoundingClientRect();
    const rectangle = selected.getBoundingClientRect();
    return rectangle.left >= bounds.left + strip.clientLeft - 1
      && rectangle.right <= bounds.left + strip.clientLeft + strip.clientWidth + 1;
  })()`)
}

async function assertTabSemantics(count) {
  assert.deepEqual(await evaluate(`(() => {
    const elements = Array.from(document.querySelectorAll(${JSON.stringify(tabs)}));
    const buttons = elements.map(tab => tab.querySelector('button.tab-select[role="tab"]'));
    return {
      tabs: elements.length,
      buttons: buttons.filter(Boolean).length,
      selected: buttons.filter(button => button?.getAttribute('aria-selected') === 'true').length,
      tabStops: buttons.filter(button => button?.tabIndex === 0).length,
      activeSelected: document.querySelector('.tab.active .tab-select')?.getAttribute('aria-selected'),
      nestedButtons: document.querySelectorAll('.session-tab-strip button button').length
    };
  })()`), { tabs: count, buttons: count, selected: 1, tabStops: 1, activeSelected: 'true', nestedButtons: 0 })
}

async function openPopover(mode) {
  if (!await evaluate(`Boolean(document.querySelector('${popover}[data-mode="${mode}"]'))`)) {
    await click(mode === 'sync' ? '.terminal-target-summary' : '.terminal-list-toggle')
  }
  await waitFor(`Boolean(document.querySelector('${popover}[data-mode="${mode}"]'))`)
}

async function dismissPopover() {
  await press('Escape')
  await waitFor(`!document.querySelector('${popover}')`)
}

async function focusActiveTab() {
  await openPopover('terminals')
  await dismissPopover()
  await waitFor('document.activeElement === document.querySelector(".terminal-list-toggle")')
  // Walk the actual focus order, including the separate close button and scroll controls.
  for (let attempt = 0; attempt < 12; attempt++) {
    if (await evaluate('document.activeElement === document.querySelector(".tab.active .tab-select")')) return
    await press('Tab', 8) // CDP Shift modifier; 1 means Alt.
  }
  throw new Error('The active terminal tab is not reachable with Shift+Tab')
}

async function openMenu(selector = `${tabs}.active`) {
  await click(selector, 'right')
  await waitFor('Boolean(document.querySelector(".context-menu"))')
}

async function menuAction(label, selector) {
  if (label === '同步全部终端') {
    await openPopover('sync')
    await replaceText(search, '')
    await click(`${popover} .terminal-sync-select-all`)
    await dismissPopover()
    return
  }
  if (label === '停止同步') {
    await click('.session-sync-control > .terminal-sync-stop')
    return
  }
  await openMenu(selector)
  const index = await evaluate(`Array.from(document.querySelectorAll('.context-menu button')).findIndex(button => button.querySelector('span').textContent.trim() === ${JSON.stringify(label)})`)
  assert.ok(index >= 0, `Missing menu item: ${label}`)
  assert.equal(await evaluate(`document.querySelector('.context-menu button:nth-of-type(${index + 1})').disabled`), false, `Disabled menu item: ${label}`)
  await click(`.context-menu button:nth-of-type(${index + 1})`)
  await waitFor('!document.querySelector(".context-menu")')
}

async function assertStableTerminal() {
  assert.equal(await evaluate(`document.querySelector('.terminal-stack').firstElementChild === window.__firstTerminalPane
    && document.querySelector('.terminal-stack .xterm') === window.__firstXterm`), true, 'Switching tabs must preserve the original terminal instance')
  assert.equal(await evaluate('Array.from(document.querySelector(".terminal-stack").children).filter(element => getComputedStyle(element).display !== "none").length'), 1)
}

async function assertLastTerminalGuard() {
  await waitForTabCount(1)
  const [id] = await tabIds()
  assert.equal(await evaluate('document.querySelectorAll(".session-tab-strip .tab-close").length'), 0)
  assert.deepEqual(await targetIds(), [], 'A single terminal must not look like a sync group')
  await openMenu()
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.context-menu button')).find(button => button.querySelector('span').textContent === '关闭此终端')?.disabled`), true)
  assert.equal(await evaluate(`document.querySelectorAll('.context-menu button').length`), 2, 'Single terminal menus explain the last-terminal guard without unrelated actions')
  await press('Escape')
  await waitFor('!document.querySelector(".context-menu")')
  await click(tab(id), 'middle')
  assert.deepEqual(await tabIds(), [id])
  await openPopover('terminals')
  assert.equal(await evaluate(`document.querySelector('${popover} .terminal-close-others')?.disabled`), true)
  await dismissPopover()
  await focusActiveTab()
  await press('Delete')
  assert.deepEqual(await tabIds(), [id])
  await assertTabSemantics(1)
}

async function scrollToBoundary(direction) {
  const selector = direction === -1 ? '.session-tab-scroll-prev' : '.session-tab-scroll-next'
  for (let attempt = 0; attempt < terminalCount; attempt++) {
    if (await evaluate(`document.querySelector('${selector}')?.disabled`)) return
    const before = await evaluate('document.querySelector(".session-tab-strip").scrollLeft')
    await click(selector)
    await waitFor(`document.querySelector('.session-tab-strip').scrollLeft ${direction === -1 ? '<' : '>'} ${before}`)
    await waitForScrollIdle()
  }
  throw new Error(`Tab scrolling never reached its ${direction === -1 ? 'left' : 'right'} boundary`)
}

async function waitForScrollIdle() {
  const deadline = Date.now() + 8000
  let previous = await evaluate('document.querySelector(".session-tab-strip").scrollLeft')
  let stableSince = Date.now()
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 40))
    const current = await evaluate('document.querySelector(".session-tab-strip").scrollLeft')
    if (Math.abs(current - previous) > 0.1) stableSince = Date.now()
    else if (Date.now() - stableSince >= 160) return
    previous = current
  }
  throw new Error('Tab scrolling did not settle')
}

async function assertNoActiveShadow(theme) {
  assert.deepEqual(await evaluate(`['.tab.active', '.tab.active .tab-select'].map(selector => getComputedStyle(document.querySelector(selector)).boxShadow)`), ['none', 'none'], `${theme}: the active terminal tab must have no shadow`)
}

async function assertSessionViews() {
  await click('.workspace-tabs button:nth-child(3)')
  const toolsBefore = await evaluate(`({
    tab: document.querySelector('.workspace-tabs button.active').textContent.trim(),
    width: document.querySelector('.right-panel').getBoundingClientRect().width
  })`)
  await click('#session-view-files')
  await waitFor('document.querySelector(".files-panel") && document.querySelector("#session-view-files").getAttribute("aria-selected") === "true"')
  await evaluate('window.__filePanel = document.querySelector(".files-panel")')
  assert.equal(await evaluate('document.querySelector(".right-panel").getBoundingClientRect().width'), 0)
  assert.equal(await evaluate('Boolean(document.querySelector(".workspace-resizer"))'), false)

  await evaluate('document.querySelector("#session-view-files").focus()')
  for (const [key, view] of [['ArrowLeft', 'terminal'], ['End', 'files'], ['Home', 'terminal'], ['ArrowRight', 'files']]) {
    await press(key)
    await waitFor(`document.querySelector('#session-view-${view}').getAttribute('aria-selected') === 'true'
      && document.activeElement === document.querySelector('#session-view-${view}')`)
  }
  await press('Enter')
  assert.equal(await evaluate('document.querySelector(".files-panel") === window.__filePanel'), true, 'Reselecting files must preserve the file panel')

  await click('#session-view-terminal')
  await waitFor('document.querySelector(".terminal-stack").contains(document.activeElement)')
  assert.deepEqual(await evaluate(`({
    tab: document.querySelector('.workspace-tabs button.active').textContent.trim(),
    width: document.querySelector('.right-panel').getBoundingClientRect().width
  })`), toolsBefore, 'Returning to the terminal must restore the auxiliary tool and its width')
  await assertStableTerminal()

  assert.equal(await evaluate('Boolean(document.querySelector(".workspace-close"))'), false)
  await click('.session-tools-toggle')
  await click('#session-view-files')
  await click('#session-view-terminal')
  assert.equal(await evaluate('document.querySelector(".right-panel").getBoundingClientRect().width'), 0, 'A previously closed auxiliary panel must stay closed')
  assert.equal(await evaluate('document.querySelector(".session-tools-toggle").getAttribute("aria-expanded")'), 'false')
  await click('.session-tools-toggle')
  await waitFor('document.querySelector(".right-panel").getBoundingClientRect().width > 0')
  assert.equal(await evaluate('document.querySelector(".workspace-tabs button.active").textContent.trim()'), toolsBefore.tab)
  assert.equal(await evaluate('document.querySelector(".files-panel") === window.__filePanel'), true)
  await click('.workspace-tabs button:nth-child(2)')
}

async function assertAuxiliaryState() {
  await click('.workspace-tabs button:nth-child(2)')
  await evaluate(`(() => {
    const ai = document.querySelector('.ai-chat-panel').__vueParentComponent;
    window.__reviewAi = ai;
    Object.assign(ai.props.config, { baseUrl: 'https://fixture.invalid', model: 'fixture', apiKey: 'memory-only-fixture' });
  })()`)
  const composer = '.chat-composer textarea'
  await waitFor(`document.querySelector('${composer}') && !document.querySelector('${composer}').disabled`)
  await replaceText(composer, '保留在当前终端的未发送草稿')
  await click('.workspace-tabs button:nth-child(1)')
  await waitFor('Boolean(document.querySelector(".history-panel"))')
  await evaluate(`(() => {
    const history = document.querySelector('.history-panel').__vueParentComponent;
    window.__reviewHistory = history;
    for (let i = 0; i < 40; i++) history.props.commands.push({ id: 'review-' + i, command: 'pwd # ' + i, createdAt: new Date().toISOString() });
  })()`)
  await click('#history-tab-frequent')
  await replaceText('.history-search-wrap input', 'pwd')
  await evaluate('document.querySelector(".history-list").scrollTop = 200')
  const scrollTop = await evaluate('document.querySelector(".history-list").scrollTop')
  await click('.workspace-tabs button:nth-child(3)')
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".history-panel")).display'), 'none')
  await click('.workspace-tabs button:nth-child(2)')
  assert.equal(await evaluate(`document.querySelector('${composer}').value`), '保留在当前终端的未发送草稿')
  assert.equal(await evaluate('document.querySelector(".ai-chat-panel").__vueParentComponent === window.__reviewAi'), true)
  await click('.session-tools-toggle')
  await click('.session-tools-toggle')
  assert.equal(await evaluate(`document.querySelector('${composer}').value`), '保留在当前终端的未发送草稿')
  await click('.workspace-tabs button:nth-child(1)')
  assert.equal(await evaluate('document.querySelector(".history-panel").__vueParentComponent === window.__reviewHistory'), true)
  assert.equal(await evaluate('document.querySelector(".history-search-wrap input").value'), 'pwd')
  assert.equal(await evaluate('document.querySelector("#history-tab-frequent").getAttribute("aria-selected")'), 'true')
  assert.equal(await evaluate('document.querySelector(".history-list").scrollTop'), scrollTop)
  assert.ok(await evaluate('document.querySelector(".history-list").getBoundingClientRect().top - document.querySelector(".right-panel").getBoundingClientRect().top') <= 145)
  await click('.workspace-tabs button:nth-child(2)')
  const originalTerminal = await activeId()
  await click('.terminal-new-tab')
  await waitForTabCount(2)
  assert.equal(await evaluate(`document.querySelector('${composer}').value`), '', 'A new terminal must not inherit another terminal draft')
  await replaceText(composer, '另一个终端的草稿')
  await click(`${tab(originalTerminal)} .tab-select`)
  await waitForActive(originalTerminal)
  assert.equal(await evaluate(`document.querySelector('${composer}').value`), '保留在当前终端的未发送草稿')
  await menuAction('关闭其他终端')
  await waitForTabCount(1)
}

async function assertNestedMenu() {
  const active = await activeId()
  await openPopover('terminals')
  await replaceText(search, '本地')
  await evaluate(`document.querySelector('${popover} ul').scrollTop = 120`)
  const id = await evaluate(`document.querySelector('${popover} .terminal-switcher-row').dataset.terminalId`)
  await openMenu(row(id))
  assert.equal(await evaluate(`Boolean(document.querySelector('${popover}'))`), true)
  assert.equal(await evaluate(`document.querySelector('${search}').value`), '本地')
  assert.equal(await evaluate('document.querySelector(".context-menu").contains(document.activeElement)'), true)
  assert.ok(await evaluate('document.querySelector(".context-menu > strong").textContent.includes("·")'))
  for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'End', 'Home', 'ArrowUp']) {
    await press(key)
    assert.equal(await activeId(), active, 'Menus consume navigation keys')
    assert.equal(await evaluate('document.querySelector(".context-menu").contains(document.activeElement)'), true)
  }
  await press('Escape')
  await waitFor('!document.querySelector(".context-menu")')
  assert.equal(await evaluate(`Boolean(document.querySelector('${popover}'))`), true)
  assert.equal(await evaluate(`document.activeElement.closest('.terminal-switcher-row')?.dataset.terminalId`), id)
  await dismissPopover()
  assert.equal(await evaluate('document.activeElement === document.querySelector(".terminal-list-toggle")'), true)
  await openMenu(tab(active))
  const other = await evaluate(`Array.from(document.querySelectorAll('${tabs}')).find(element => {
    const rect = element.getBoundingClientRect();
    return element.dataset.terminalId !== ${JSON.stringify(active)}
      && element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })?.dataset.terminalId`)
  assert.ok(other, 'A second unobscured tab is available for direct menu replacement')
  await openMenu(tab(other))
  assert.equal(await evaluate(`document.querySelector('.context-menu').__vueParentComponent.props.sourceElement.closest('.tab').dataset.terminalId`), other)
  await press('Escape')
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

async function assertResponsiveLayout() {
  const measurements = []
  for (const width of [1280, 1100, 1040, 980]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 760, deviceScaleFactor: 1, mobile: false })
    await waitFor(`innerWidth === ${width} && document.querySelector('.terminal-stack').getBoundingClientRect().width >= 559`)
    measurements.push(await evaluate(`({ viewport: innerWidth, terminal: document.querySelector('.terminal-stack').getBoundingClientRect().width, tools: document.querySelector('.right-panel').getBoundingClientRect().width })`))
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true)
    for (const index of [0, 1]) {
      const trigger = `.app-rail button[aria-controls="left-sidebar-panel"]:nth-child(${index + 1})`
      if (await evaluate(`document.querySelector(${JSON.stringify(trigger)}).getAttribute('aria-expanded') !== 'true'`)) await click(trigger)
      await waitFor(`document.querySelector('#left-sidebar-panel').getBoundingClientRect().width > 0`)
      if (await evaluate('document.querySelector(".app-shell").classList.contains("left-sidebar-overlay")')) {
        assert.equal(await evaluate('document.querySelector("#left-sidebar-panel").getAttribute("role")'), 'dialog')
        await evaluate(`(() => {
          const items = Array.from(document.querySelectorAll('#left-sidebar-panel button:not(:disabled), #left-sidebar-panel input:not(:disabled), #left-sidebar-panel select:not(:disabled), #left-sidebar-panel [tabindex="0"]')).filter(element => element.getClientRects().length > 0);
          items.at(-1).focus();
        })()`)
        await press('Tab')
        assert.equal(await evaluate('document.activeElement === document.querySelector(".sidebar-drawer-close")'), true)
        await press('Escape')
      } else {
        await click('.sidebar-drawer-close')
      }
      await waitFor('document.querySelector("#left-sidebar-panel").getBoundingClientRect().width === 0')
      assert.equal(await evaluate(`document.activeElement === document.querySelectorAll('.app-rail button[aria-controls="left-sidebar-panel"]')[${index}]`), true)
    }
  }
  await evaluate('document.querySelector(".workspace-resizer").focus()')
  await press('Home')
  await waitFor('document.querySelector(".right-panel").getBoundingClientRect().width === 320')
  await press('End')
  await waitFor('document.querySelector(".right-panel").getBoundingClientRect().width === 372')
  const narrowScreenshot = await screenshot('workspace-980.png')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await press('End')
  await waitFor('document.querySelector(".right-panel").getBoundingClientRect().width === 560')
  if (await evaluate('document.querySelector("#left-sidebar-panel").getBoundingClientRect().width > 0')) await click('.sidebar-drawer-close')
  await click('.workspace-tabs button:nth-child(1)')
  await click('.session-tools-toggle')
  await send('Page.reload')
  await waitForTabCount(1)
  assert.equal(await evaluate('document.querySelector(".app-shell").classList.contains("left-collapsed")'), true)
  assert.equal(await evaluate('document.querySelector(".session-tools-toggle").getAttribute("aria-expanded")'), 'false')
  await click('.session-tools-toggle')
  await waitFor('document.querySelector(".right-panel").getBoundingClientRect().width === 560')
  assert.equal(await evaluate('document.querySelector(".workspace-tabs button.active").textContent.trim()'), '历史')
  // Leave repeat runs with the usual open tools and connection sidebar.
  await click('.app-rail button[aria-controls="left-sidebar-panel"]:first-child')
  await click('.workspace-tabs button:nth-child(2)')
  return { measurements, narrowScreenshot }
}

try {
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: appUrl })
  await waitForTabCount(1)
  assert.equal(await evaluate('Boolean(window.__TAURI_IPC__)'), false, 'Run this smoke test against browser preview, not a native workspace.')
  if (await evaluate('document.querySelector(".session-tools-toggle").getAttribute("aria-expanded") === "false"')) await click('.session-tools-toggle')
  await evaluate('window.__firstTerminalPane = document.querySelector(".terminal-stack").firstElementChild; window.__firstXterm = document.querySelector(".terminal-stack .xterm")')
  await assertLastTerminalGuard()
  await assertAuxiliaryState()
  await assertSessionViews()
  assert.equal(await evaluate('Boolean(document.querySelector(".session-tab-scroll-prev, .session-tab-scroll-next"))'), false)

  await menuAction('新建本地终端')
  await waitForTabCount(2)
  for (let count = 3; count <= 4; count++) {
    await click('.terminal-new-tab')
    await waitForTabCount(count)
  }
  const firstTabs = await tabIds()
  await openPopover('sync')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(`${row(firstTabs[3])} input[type="checkbox"]`)})?.checked`), true)
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(`${row(firstTabs[3])} input[type="checkbox"]`)})?.disabled`), true)
  await click(`${row(firstTabs[0])} input[type="checkbox"]`)
  assert.deepEqual(await targetIds(), [firstTabs[0], firstTabs[3]])
  await dismissPopover()
  await click(`${tab(firstTabs[0])} .tab-select`)
  await waitForActive(firstTabs[0])
  assert.deepEqual(await targetIds(), [firstTabs[0], firstTabs[3]], 'Switching within a sync group must preserve its targets')
  await click(`${tab(firstTabs[1])} .tab-select`)
  await waitForActive(firstTabs[1])
  assert.deepEqual(await targetIds(), [], 'Switching outside a sync group must end sync without adding the new tab')
  await openPopover('sync')
  assert.equal(await evaluate(`${JSON.stringify(firstTabs[1])} === document.querySelector('${popover} input:disabled:checked')?.closest('.terminal-switcher-row').dataset.terminalId`), true)
  await click(`${popover} .terminal-sync-select-all`)
  assert.deepEqual(await targetIds(), firstTabs)
  await click(`${row(firstTabs[0])} input[type="checkbox"]`)
  assert.deepEqual(await targetIds(), firstTabs.slice(1))
  await click(`${popover} .terminal-sync-stop`)
  await waitFor(`!document.querySelector('${popover}')`)
  assert.deepEqual(await targetIds(), [])
  await menuAction('同步全部终端')
  assert.deepEqual(await targetIds(), firstTabs)
  await menuAction('停止同步')
  assert.deepEqual(await targetIds(), [])
  await click(`${tab(firstTabs[0])} .tab-select`)
  await assertStableTerminal()

  for (let count = 5; count <= terminalCount; count++) {
    await click('.terminal-new-tab')
    await waitForTabCount(count)
  }
  const allTabs = await tabIds()
  await assertTabSemantics(terminalCount)
  await assertActiveVisible()
  await waitFor('document.querySelector(".session-tab-scroll-next")?.disabled === true')
  assert.equal(await evaluate('document.querySelector(".session-tab-scroll-prev")?.disabled'), false)
  assert.equal(await evaluate('Boolean(document.querySelector(".session-tab-scrollbar, .session-tab-scrollbar-thumb, .terminal-target-toggle"))'), false)
  await focusActiveTab()
  await press('Home')
  await waitForActive(allTabs[0], true)
  await assertActiveVisible()
  await waitFor('document.querySelector(".session-tab-scroll-prev")?.disabled === true')
  await press('ArrowRight')
  await waitForActive(allTabs[1], true)
  await press('ArrowLeft')
  await waitForActive(allTabs[0], true)
  await press('ArrowLeft')
  await waitForActive(allTabs.at(-1), true)
  await assertActiveVisible()
  await press('ArrowRight')
  await waitForActive(allTabs[0], true)
  await press('End')
  await waitForActive(allTabs.at(-1), true)
  await assertActiveVisible()
  await press('Tab', 2)
  await waitForActive(allTabs[0])
  await press('Tab', 10) // Control + Shift.
  await waitForActive(allTabs.at(-1))
  await focusActiveTab()
  await press('Home')
  await waitForActive(allTabs[0], true)
  await waitFor('document.querySelector(".session-tab-strip").scrollLeft < 1')
  const stripPoint = await point('.session-tab-strip')
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...stripPoint, deltaX: 0, deltaY: 240 })
  await waitFor('document.querySelector(".session-tab-strip").scrollLeft > 0')
  await scrollToBoundary(1)
  assert.equal(await activeId(), allTabs[0], 'Scrolling tabs must not switch the active terminal')
  await scrollToBoundary(-1)
  assert.equal(await evaluate('document.querySelector(".session-tab-scroll-next").disabled'), false)
  await assertNestedMenu()

  await openPopover('terminals')
  await waitFor(`document.activeElement === document.querySelector('${search}')`)
  await replaceText(search, '本地终端')
  assert.equal(await evaluate(`document.querySelectorAll('${popover} .terminal-switcher-row').length`), terminalCount)
  await replaceText(search, '不存在的终端-回归')
  assert.equal(await evaluate(`document.querySelectorAll('${popover} .terminal-switcher-row').length`), 0)
  await press('Enter')
  assert.equal(await evaluate(`Boolean(document.querySelector('${popover}[data-mode="terminals"]'))`), true)
  await replaceText(search, '· 20')
  await waitFor(`document.querySelectorAll('${popover} .terminal-switcher-row').length === 1`)
  assert.equal(await evaluate(`document.querySelector('${popover} .terminal-switcher-row').dataset.terminalId`), allTabs[19])
  await press('Enter')
  await waitForActive(allTabs[19])
  await waitFor(`!document.querySelector('${popover}')`)
  await assertActiveVisible()
  await openPopover('terminals')
  await replaceText(search, '· 10')
  await press('ArrowDown')
  await waitFor(`document.activeElement === document.querySelector(${JSON.stringify(`${row(allTabs[9])} .terminal-switcher-select`)})`)
  await press('Enter')
  await waitForActive(allTabs[9])
  await assertActiveVisible()
  await assertStableTerminal()
  await openPopover('sync')
  await replaceText(search, '· 20')
  await click(`${popover} .terminal-sync-select-all`)
  assert.deepEqual(await targetIds(), [allTabs[9], allTabs[19]], 'Filtered selection must keep the current terminal and add only matching tabs')
  await dismissPopover()
  await click('.session-sync-control > .terminal-sync-stop')
  assert.deepEqual(await targetIds(), [])
  await menuAction('同步全部终端')
  assert.deepEqual(await targetIds(), allTabs)

  if (await evaluate('Boolean(document.querySelector(".app-shell.theme-light"))')) await click('button[title="切换深色主题"]')
  await waitFor('Boolean(document.querySelector(".app-shell.theme-dark"))')
  await assertNoActiveShadow('dark')
  await dismissToasts()
  const darkScreenshot = await screenshot('terminal-tabs-dark-wide.png')
  await openMenu()
  assert.equal(await evaluate(`(() => {
    const menu = document.querySelector('.context-menu');
    return menu.scrollHeight <= menu.clientHeight + 1 && getComputedStyle(menu.querySelector('button:last-child')).backgroundColor === 'rgba(0, 0, 0, 0)';
  })()`), true)
  const darkMenuScreenshot = await screenshot('terminal-menu-dark.png')
  await press('Escape')
  await waitFor('!document.querySelector(".context-menu")')
  await click('button[title="切换白色主题"]')
  await waitFor('Boolean(document.querySelector(".app-shell.theme-light"))')
  await send('Emulation.setDeviceMetricsOverride', { width: 1120, height: 760, deviceScaleFactor: 1, mobile: false })
  await assertActiveVisible()
  await assertNoActiveShadow('light')
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'Many terminal tabs must not widen the page')
  await dismissToasts()
  const lightScreenshot = await screenshot('terminal-tabs-light-narrow.png')
  await openMenu()
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.context-menu button')).every(button => getComputedStyle(button).borderTopColor === 'rgba(0, 0, 0, 0)')`), true)
  const lightMenuScreenshot = await screenshot('terminal-menu-light.png')
  await press('Escape')
  await waitFor('!document.querySelector(".context-menu")')
  await openPopover('sync')
  assert.equal(await evaluate(`(() => { const rectangle = document.querySelector('${popover}').getBoundingClientRect(); return rectangle.left >= 0 && rectangle.top >= 0 && rectangle.right <= innerWidth + 1 && rectangle.bottom <= innerHeight + 1; })()`), true, 'The terminal picker must fit the narrow viewport')
  const syncScreenshot = await screenshot('terminal-sync-light-narrow.png')
  await click(`${popover} .terminal-sync-stop`)
  assert.deepEqual(await targetIds(), [])

  await openHistory()
  assert.equal(await evaluate('document.querySelectorAll(".session-history-row").length'), 1)
  await click('[title="会话列表"]')
  await click('[title="新建会话"]')
  await openHistory()
  await waitFor('document.querySelectorAll(".session-history-row").length === 2')
  await click('.session-history-row.active button[title="编辑会话"]')
  await waitFor('Boolean(document.querySelector(".rename-modal input"))')
  await replaceText('.rename-modal input', '重构回归会话')
  await click('.rename-modal button[type="submit"]')
  await waitFor('!document.querySelector(".rename-modal")')
  await openHistory()
  await waitFor('document.querySelector(".session-history-row.active").textContent.includes("重构回归会话")')
  await click(`${tab(allTabs[19])} .tab-select`)
  await openHistory()
  assert.equal(await evaluate('document.querySelector(".session-history-row.active").textContent.includes("重构回归会话")'), true)
  const sessionScreenshot = await screenshot('workspace-session-light-narrow.png')
  await click('.session-history-row.active button[title="删除会话"]')
  await openHistory()
  await waitFor('document.querySelectorAll(".session-history-row").length === 1')
  assert.ok(dialogs.some(text => text.includes('命令历史不受影响')))
  await click('[title="会话列表"]')

  const activeBeforeBackgroundClose = await activeId()
  await evaluate('window.__activeTab = document.querySelector(".tab.active"); window.__activeXterm = Array.from(document.querySelector(".terminal-stack").children).find(element => getComputedStyle(element).display !== "none").querySelector(".xterm")')
  await click(`${tab(allTabs[1])} .tab-close`)
  await waitForTabCount(19)
  assert.equal(await activeId(), activeBeforeBackgroundClose)
  assert.equal(await evaluate('document.querySelector(".tab.active") === window.__activeTab && window.__activeXterm.isConnected'), true)
  await click(tab(allTabs[2]), 'middle')
  await waitForTabCount(18)
  assert.equal(await activeId(), activeBeforeBackgroundClose)
  await assertStableTerminal()
  await focusActiveTab()
  await press('Delete')
  await waitForTabCount(17)
  assert.equal((await tabIds()).includes(activeBeforeBackgroundClose), false)
  await waitFor('document.activeElement === document.querySelector(".tab.active .tab-select")')

  const beforeCloseRight = await tabIds()
  const rightBoundary = beforeCloseRight[7]
  await menuAction('关闭右侧终端', tab(rightBoundary))
  await waitForTabCount(8)
  assert.deepEqual(await tabIds(), beforeCloseRight.slice(0, 8))
  await waitForActive(rightBoundary)
  await openMenu(tab(rightBoundary))
  assert.equal(await evaluate('Array.from(document.querySelectorAll(".context-menu button")).some(button => button.textContent.trim() === "关闭右侧终端")'), false)
  await press('Escape')
  await waitFor('!document.querySelector(".context-menu")')
  await menuAction('关闭其他终端', tab(allTabs[0]))
  await waitForTabCount(1)
  assert.deepEqual(await tabIds(), [allTabs[0]], 'Closing other tabs from a background tab must keep that tab')
  await assertStableTerminal()

  for (let count = 2; count <= 4; count++) {
    await click('.terminal-new-tab')
    await waitForTabCount(count)
  }
  await click(`${tab(allTabs[0])} .tab-select`)
  await menuAction('同步全部终端')
  await openPopover('terminals')
  await click(`${popover} .terminal-close-others`)
  await waitFor(`!document.querySelector('${popover}')`)
  await assertLastTerminalGuard()
  await assertStableTerminal()
  await waitFor('!document.querySelector(".session-tab-scroll-prev, .session-tab-scroll-next")')
  const responsive = await assertResponsiveLayout()
  assert.deepEqual(exceptions, [])
  console.log(JSON.stringify({
    result: 'passed', terminalTabsExercised: terminalCount, themes: ['dark', 'light'],
    viewports: ['1440x1000', '1280x760', '1120x760', '1100x760', '1040x760', '980x760'], nativeBackendTested: false,
    responsiveMeasurements: responsive.measurements,
    checks: [
      'stable terminal DOM', 'current terminal required in sync group', 'sync group switch and exit', 'filtered sync selection and stop',
      '20 tabs with duplicate title ordinals', 'wheel and arrow scrolling with disabled boundaries', 'automatic active tab reveal',
      'search empty state and keyboard selection', 'tab keyboard navigation and focus', 'active tab has no shadow in both themes',
      'fixed terminal/files keyboard navigation', 'file panel survives view switches', 'auxiliary panel tab, width and visibility restoration',
      'background close preserves active instance', 'middle-click and Delete close', 'close other and right tabs', 'last terminal guard',
      'global draft session create/rename/delete', 'terminal switch preserves AI session', 'no uncaught exceptions'
    ],
    screenshots: [darkScreenshot, darkMenuScreenshot, lightScreenshot, lightMenuScreenshot, syncScreenshot, sessionScreenshot, responsive.narrowScreenshot]
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
