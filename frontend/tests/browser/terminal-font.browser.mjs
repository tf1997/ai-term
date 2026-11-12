import assert from 'node:assert/strict'
const cdp = process.env.AI_TERM_CDP_URL ?? 'http://127.0.0.1:9231'
const url = process.env.AI_TERM_PREVIEW_URL ?? 'http://127.0.0.1:5173'
const target = await fetch(`${cdp}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json())
const socket = new WebSocket(target.webSocketDebuggerUrl)
let sequence = 0
const pending = new Map(), exceptions = []
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data)
  if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params)
  const entry = pending.get(message.id)
  if (!entry) return
  clearTimeout(entry.timer); pending.delete(message.id)
  if (message.error) entry.reject(Error(JSON.stringify(message.error)))
  else entry.resolve(message.result)
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence
  pending.set(id, { resolve, reject, timer: setTimeout(() => reject(Error(method)), 30000) })
  socket.send(JSON.stringify({ id, method, params }))
})
try {
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }))
  await send('Page.enable'); await send('Runtime.enable'); await send('Page.bringToFront')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36', platform: 'Linux x86_64' })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'localStorage.clear()' })
  await send('Page.navigate', { url })
  const result = await send('Runtime.evaluate', { expression: `import('/tests/browser/terminal-font.checks.mjs').then(module => module.runTerminalFontChecks())`, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
  assert.deepEqual(exceptions, [])
  console.log(JSON.stringify({ result: 'passed', linuxUserAgentOnly: true, ...result.result.value }, null, 2))
} finally {
  socket.close()
  await fetch(`${cdp}/json/close/${target.id}`).catch(() => {})
}
