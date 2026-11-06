import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const debuggerUrl = process.env.AI_TERM_CDP_URL ?? 'http://127.0.0.1:9231'
const fixtureUrl = 'http://127.0.0.1:5173/tests/browser/bracketed-capture.fixture.html'
const outputDirectory = mkdtempSync(join(tmpdir(), 'ai-term-bracketed-capture-check-'))
const target = await fetch(`${debuggerUrl}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(5000) }).then(response => response.json())
const socket = new WebSocket(target.webSocketDebuggerUrl)
const requests = new Map()
const exceptions = []
const checks = []
const commandEchoChecks = []
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

try {
  const records = JSON.parse(readFileSync(process.env.AI_TERM_CAPTURE_REPLAY_FILE ?? '/tmp/ai-term-m2-capture-replay.json', 'utf8'))
  assert.ok(records.length > 0, 'First generate the real PTY capture replay with shell_capture_integration')
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  await send('Page.enable'); await send('Runtime.enable'); await send('Emulation.setDeviceMetricsOverride', { width: 1550, height: 1000, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: fixtureUrl }); await waitFor('window.bracketedCaptureReady')
  for (const record of records) {
    const result = await evaluate(`window.replayBracketedCapture(${JSON.stringify(record)})`)
    assert.equal(result.verified, true, record.shell + ': raw multiline probe')
    assert.equal(result.captured.length, 1, record.shell + ': one result')
    assert.equal(result.captured[0].exitCode, record.expectedExitCode ?? 9)
    for (const expected of record.expectedOutput ?? ['first', 'two\nlines', '中文 and spaces']) {
      assert.ok(result.captured[0].output.includes(expected), record.shell + ': ' + expected)
    }
    assert.equal(result.finished.length, 1)
    assert.equal(result.finished[0].command, record.source, record.shell + ': exact reviewed command history')
    checks.push({ shell: record.shell, output: result.captured[0].output, command: result.finished[0].command })
  }
  const screen = await screenshot('bracketed-capture-real-pty-replay.png')
  if (process.env.AI_TERM_BASH_REPLAY_FILE) {
    const records = JSON.parse(readFileSync(process.env.AI_TERM_BASH_REPLAY_FILE, 'utf8'))
    assert.ok(records.length > 0)
    for (const record of records) {
      const { result, finished } = await evaluate(`window.replayCommandCapture(${JSON.stringify(record)})`)
      assert.equal(finished.length, 1)
      assert.equal(finished[0].command, record.source, `${record.cols} columns: Ubuntu diagnostic command`)
      assert.equal(result.commandMismatch, undefined)
      assert.equal(result.completionUnconfirmed, undefined)
      assert.equal(result.exitCode, 0)
      assert.ok(result.output.includes(record.source.includes('更新 时间') ? '=== apt lists 更新 时间 ===' : '=== apt lists 更新时间 ==='))
      for (const heading of ['apt lists 更新', '内核相关可升级包(apt 缓存)', '当前内核版本', '最新可用内核镜像包', 'ubuntu-security-status']) assert.ok(result.output.includes(heading), heading)
      commandEchoChecks.push({ shell: record.shell, cols: record.cols, ubuntuCommand: true, matched: true, realPty: true })
    }
    // A typed space and readline's display padding can look identical. Only
    // the observed padding protocol may be removed, never arbitrary whitespace.
    const literalSpace = records.find(record => record.source.includes('更新 时间'))
    assert.ok(literalSpace)
    const changed = await evaluate(`window.replayCommandCapture(${JSON.stringify({ ...literalSpace, source: literalSpace.source.replace('更新 时间', '更新时间') })})`)
    assert.equal(changed.result.commandMismatch, true, 'a real extra space inside quotes remains a different command')
  }
  if (process.env.AI_TERM_DISPLAY_REPLAY_FILE) {
    const records = JSON.parse(readFileSync(process.env.AI_TERM_DISPLAY_REPLAY_FILE, 'utf8'))
    assert.ok(records.length > 0)
    for (const record of records) {
      const { result, finished } = await evaluate(`window.replayCommandCapture(${JSON.stringify(record)})`)
      assert.equal(finished.length, 1, record.startup + ': one complete command')
      assert.equal(finished[0].command, record.source, record.startup + ': quotes and command substitution survive')
      assert.equal(result.commandMismatch, undefined)
      assert.equal(result.completionUnconfirmed, undefined)
      assert.equal(result.exitCode, 0)
      for (const heading of ['cores: ', 'WindowServer 采样(5s)', '显示器']) assert.ok(result.output.includes(heading), heading)
      assert.doesNotMatch(result.output, /unmatched|parse error|AI_TERM_CONTEXT|AI_TERM_CAPTURE_OK/)
      commandEchoChecks.push({ shell: record.shell, startup: record.startup, quotedSubstitution: true, matched: true, realPty: true })
    }
  }
  if (process.env.AI_TERM_PARSE_ERROR_REPLAY_FILE) {
    const record = JSON.parse(readFileSync(process.env.AI_TERM_PARSE_ERROR_REPLAY_FILE, 'utf8'))
    const { result, finished } = await evaluate(`window.replayCommandCapture(${JSON.stringify(record)})`)
    assert.equal(result.status, 'completed', 'the capture must settle when the shell returns')
    assert.equal(result.completionUnconfirmed, true)
    assert.equal(result.exitCode, undefined, 'a missing completion status must not become success')
    assert.match(result.output, /parse error near/)
    assert.equal(finished.length, 0, 'no fabricated command history for a missing preexec')
    commandEchoChecks.push({ shell: record.shell, syntaxError: true, settledWithoutTimeout: true, realPty: true })
  }
  if (process.env.AI_TERM_COMMAND_REPLAY_FILE) {
    const commandRecords = JSON.parse(readFileSync(process.env.AI_TERM_COMMAND_REPLAY_FILE, 'utf8'))
    assert.ok(commandRecords.length > 0)
    for (const record of commandRecords) {
      const { result, finished } = await evaluate(`window.replayCommandCapture(${JSON.stringify(record)})`)
      assert.equal(finished.length, 1, record.shell + ': one complete command')
      assert.equal(finished[0].command, record.source, `${record.shell}, ${record.cols} columns: actual command text`)
      assert.equal(result.commandMismatch, undefined, `${record.shell}, ${record.cols} columns: matching command`)
      assert.equal(result.exitCode, record.expectedExitCode)
      for (const heading of ['负载 / 运行时长', 'CPU 占用前 12', '内存压力', '磁盘空间']) assert.ok(result.output.includes(heading), heading)
      commandEchoChecks.push({ shell: record.shell, cols: record.cols, matched: true, realPty: true })
    }
  }
  const statusCommand = readFileSync(new URL('../../../src-tauri/tests/fixtures/macos-system-status.sh', import.meta.url), 'utf8').trimEnd()
  for (const roundTrip of [
    { prompt: '中文 ❯ ', source: 'printf hello', cols: 40 },
    { prompt: 'e\u0301 ❯ ', source: 'printf hello', cols: 40 },
    { prompt: '$ ', source: 'printf ' + 'a'.repeat(30) + ' b', cols: 40 },
    ...[40, 80, 120, 160].map(cols => ({ prompt: '$ ', source: statusCommand, cols }))
  ]) {
    const { result, input } = await evaluate(`window.captureCommandRoundTrip(${JSON.stringify(roundTrip)})`)
    assert.equal(input, roundTrip.source, 'visible input must use terminal cell columns and retain wrapped spaces')
    assert.equal(result.commandMismatch, undefined, 'normal echo must not be classified as another command')
    assert.equal(result.output, 'observed output')
    assert.equal(result.exitCode, 0)
    commandEchoChecks.push({ prompt: roundTrip.prompt, source: roundTrip.source, matched: true })
  }
  const different = await evaluate(`window.captureCommandRoundTrip(${JSON.stringify({ prompt: '$ ', source: 'printf expected', observed: 'printf different' })})`)
  assert.equal(different.result.commandMismatch, true, 'a genuinely different observed command still stops the task')
  assert.deepEqual(exceptions, [])
  console.log(JSON.stringify({ result: 'passed', screenshot: screen, realPtyReplay: true, checks, commandEchoChecks, differentCommandRejected: different.result.commandMismatch }, null, 2))
} catch (error) { console.error('Browser failure screenshot:', await screenshot('failure.png').catch(() => 'unavailable')); throw error }
finally { for (const request of requests.values()) clearTimeout(request.timer); socket.close(); await fetch(`${debuggerUrl}/json/close/${target.id}`).catch(() => {}) }
