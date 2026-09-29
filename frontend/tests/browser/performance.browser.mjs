import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { installSftpFixture } from './sftp-tauri-fixture.mjs'
import { installTerminalDebugFixture } from './terminal-debug-fixture.mjs'

const debuggerUrl = process.env.AI_TERM_PERF_CDP_URL ?? 'http://127.0.0.1:9234'
const appUrl = process.env.AI_TERM_PERF_APP_URL ?? 'http://127.0.0.1:5174'
const phase = process.env.AI_TERM_PERF_PHASE ?? 'after'
const output = resolve('../outputs/performance-2026-09-28')
mkdirSync(output, { recursive: true })
const target = await fetch(`${debuggerUrl}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json())
const socket = new WebSocket(target.webSocketDebuggerUrl)
let sequence = 0
const requests = new Map()
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { requests.delete(id); reject(Error(`Timeout: ${method}`)) }, 15000)
    requests.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data), request = requests.get(message.id)
  if (!request) return
  clearTimeout(request.timer); requests.delete(message.id)
  message.error ? request.reject(Error(JSON.stringify(message.error))) : request.resolve(message.result)
})
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
async function waitFor(expression) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (await evaluate(`Boolean(${expression})`)) return
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw Error(`State not reached: ${expression}`)
}
try {
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }))
  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.clear(); (${installSftpFixture.toString()})(); (${installTerminalDebugFixture.toString()})();` })
  await send('Page.navigate', { url: appUrl })
  await waitFor(`document.querySelector('.terminal-pane')?.__vueParentComponent?.setupState?.terminal`)
  await evaluate(`window.perfApp = document.querySelector('.app-shell').__vueParentComponent.setupState;
    window.perfPane = document.querySelector('.terminal-pane').__vueParentComponent;
    window.perfTerminal = perfPane.setupState.terminal; true;`)
  await waitFor(`perfPane.exposed.commandExecutionReadiness() === 'ready'`)
  await evaluate(`document.fonts.ready.then(() => new Promise(resolve => setTimeout(resolve, 300)))`)
  const result = await evaluate(`(async () => {
    const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const counts = { resize: 0, measure: 0, refresh: 0, writeCallbacks: 0 };
    const fit = perfPane.setupState.fitAddon;
    for (const [object, name, counter] of [[perfTerminal, 'resize', 'resize'], [perfTerminal, 'refresh', 'refresh'], [fit, 'proposeDimensions', 'measure']]) {
      const original = object[name].bind(object);
      object[name] = (...args) => { counts[counter]++; return original(...args); };
    }
    const themeTimes = [];
    const beforeCalls = __sftpFixture.calls.length;
    for (let i = 0; i < 10; i++) {
      const start = performance.now(); perfApp.toggleAppTheme(); await frames();
      themeTimes.push(performance.now() - start);
    }
    await frames();
    const theme = { ...counts, ptyResizes: __sftpFixture.calls.slice(beforeCalls).filter(call => call.cmd === 'terminal_resize').length, twoFrameMs: themeTimes };
    const originalWrite = perfTerminal.write.bind(perfTerminal);
    perfTerminal.write = (data, callback) => originalWrite(data, callback ? () => { counts.writeCallbacks++; callback(); } : undefined);
    const start = performance.now();
    for (let i = 0; i < 1000; i++) perfPane.setupState.ingestTerminalOutput('line-' + i + '\\r\\n');
    await new Promise(resolve => originalWrite('PERF-END\\r\\n', resolve));
    await frames();
    const output = { chunks: 1000, writeCallbacks: counts.writeCallbacks, parseAndTwoFrameMs: performance.now() - start };
    perfTerminal.scrollToTop(); await frames();
    const viewportBeforeTheme = perfTerminal.buffer.active.viewportY;
    if (perfApp.appTheme !== 'light') { perfApp.toggleAppTheme(); await frames(); }
    const viewportAfterTheme = perfTerminal.buffer.active.viewportY;
    const light = { ...perfTerminal.options.theme };
    const buffer = perfTerminal.buffer.active;
    const text = Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? '').join('\\n');
    perfTerminal.scrollToBottom();
    const session = perfPane.setupState.sessionId;
    const inputBefore = __sftpFixture.calls.length;
    perfTerminal.input('x', true);
    const immediateInputWrites = __sftpFixture.calls.slice(inputBefore).filter(call => call.cmd === 'terminal_write' && call.sessionId === session).length;
    await new Promise(resolve => setTimeout(resolve, 100));
    const originalSettings = { ...perfApp.appSettings };
    const beforeNonVisual = counts.measure;
    perfApp.updateUserSettings({ ...originalSettings, debugMode: !originalSettings.debugMode }); await frames();
    const nonVisualSettingsMeasure = counts.measure - beforeNonVisual;
    const beforeFont = counts.measure;
    perfApp.updateUserSettings({ ...originalSettings, terminalFontSize: originalSettings.terminalFontSize + 1 }); await frames();
    const fontChangeMeasure = counts.measure - beforeFont;
    const fontSizeApplied = perfTerminal.options.fontSize === originalSettings.terminalFontSize + 1;
    perfApp.updateUserSettings(originalSettings); await frames();
    let attributeResets = 0;
    const write = perfTerminal.write.bind(perfTerminal);
    perfTerminal.write = (data, callback) => { if (data.includes(String.fromCharCode(27) + ']8;;')) attributeResets++; write(data, callback); };
    perfPane.setupState.ingestTerminalOutput('\\r\\n' + String.fromCharCode(27) + '[4mstyled-cell' + String.fromCharCode(27) + '[0m');
    await frames();
    perfPane.setupState.clearLeakedTextAttributes();
    perfPane.setupState.clearLeakedTextAttributes();
    await new Promise(resolve => setTimeout(resolve, 150));
    return { theme, output, light, viewportBeforeTheme, viewportAfterTheme, nonVisualSettingsMeasure, fontChangeMeasure, fontSizeApplied, attributeResets, hasFirst: text.includes('line-0'), hasLast: text.includes('line-999'), hasEnd: text.includes('PERF-END'), immediateInputWrites };
  })()`)
  assert.ok(result.hasFirst && result.hasLast && result.hasEnd, 'Output must remain complete')
  assert.equal(result.immediateInputWrites, 1, 'First input must enter IPC without a timer')
  if (phase === 'after') {
    assert.equal(result.theme.ptyResizes, 0)
    assert.equal(result.theme.measure, 0)
    assert.equal(result.theme.resize, 0)
    assert.equal(result.output.writeCallbacks, 0)
    assert.equal(result.light.background, '#ffffff')
    assert.equal(result.light.cursor, '#087f5b')
    assert.equal(result.viewportAfterTheme, result.viewportBeforeTheme)
    assert.equal(result.nonVisualSettingsMeasure, 0)
    assert.ok(result.fontChangeMeasure > 0 && result.fontSizeApplied)
    assert.equal(result.attributeResets, 1, 'Attribute recovery must not create a write/parse feedback loop')
  }
  const report = { phase, backend: 'synthetic IPC; real Vue and xterm', ...result }
  writeFileSync(resolve(output, `${phase}.json`), JSON.stringify(report, null, 2))
  const screenshot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(resolve(output, `${phase}.png`), Buffer.from(screenshot.data, 'base64'))
  console.log(JSON.stringify(report, null, 2))
} finally {
  for (const request of requests.values()) clearTimeout(request.timer)
  socket.close()
  await fetch(`${debuggerUrl}/json/close/${target.id}`).catch(() => {})
}
