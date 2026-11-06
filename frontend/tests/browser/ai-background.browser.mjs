import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installSftpFixture } from './sftp-tauri-fixture.mjs'
import { installTerminalDebugFixture } from './terminal-debug-fixture.mjs'
import { installAiRuntimeFixture } from './ai-runtime.fixture.mjs'
import { installAiBackgroundFixture } from './ai-background.fixture.mjs'

const debuggerUrl = process.env.AI_TERM_CDP_URL ?? 'http://127.0.0.1:9231'
const appUrl = process.env.AI_TERM_APP_URL ?? 'http://127.0.0.1:5173'
const outputDirectory = mkdtempSync(join(tmpdir(), 'ai-term-background-'))
const target = await fetch(`${debuggerUrl}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json())
const socket = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map(), exceptions = []
let sequence = 0
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)) }, 15000)
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
}
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data), request = pending.get(message.id)
  if (request) { clearTimeout(request.timer); pending.delete(message.id); message.error ? request.reject(Error(JSON.stringify(message.error))) : request.resolve(message.result) }
  if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails)
})
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
async function waitFor(expression) {
  const end = Date.now() + 15000
  while (Date.now() < end) {
    if (await evaluate(expression)) return
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw Error(`UI timeout: ${expression}`)
}
async function click(selector, double = false) {
  await waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect().width)`)
  const point = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    element.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = element.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: double ? 2 : 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: double ? 2 : 1 })
}
const panel = '.ai-chat-panel:not([style*="display: none"])'
const app = '__aiBackground.app()'
const runtime = '__aiBackground.runtime'
async function start(goal) {
  await evaluate(`(() => { const input = document.querySelector('${panel} .chat-composer textarea'); input.value = ${JSON.stringify(goal)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await click(`${panel} .chat-send`)
  await waitFor(`${runtime}.requests.some(call => call.request.goal === ${JSON.stringify(goal)})`)
}
async function selectSession(id) {
  await click(`${panel} [aria-label="会话列表"]`)
  await click(`${panel} [data-session-id="${id}"]`)
  await waitFor(`${app}.activeAiSessionId === ${JSON.stringify(id)}`)
}
async function screenshot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png' })
  const path = join(outputDirectory, name); writeFileSync(path, Buffer.from(result.data, 'base64')); return path
}
try {
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await send('Emulation.setDeviceMetricsOverride', { width: 1550, height: 960, deviceScaleFactor: 1, mobile: false })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.clear(); (${installSftpFixture})(); (${installTerminalDebugFixture})(); (${installAiBackgroundFixture})(${installAiRuntimeFixture});` })
  await send('Page.navigate', { url: appUrl })
  await waitFor(`${app}?.profiles?.length === 2`)
  await evaluate(`${app}.createTerminalTab(${app}.profiles[0])`)
  await waitFor(`${app}.activeTerminal?.status === 'remote'`)
  await evaluate(`${app}.rightCollapsed = false; ${app}.appSettings.agentAutoExecReadonly = false`)
  await click('.workspace-tabs [aria-label="AI 助手"]')
  await click(`${panel} .chat-mode-switch button:last-child`)
  await waitFor(`${app}.workspaceSessions.find(session => session.id === ${app}.activeAiSessionId)?.aiMode === 'agent'`)
  await waitFor('__terminalDebugFixture.pendingChunks === 0')
  const a = await evaluate(`({ session: ${app}.activeAiSessionId, terminal: ${app}.activeTerminalId })`)
  await start('后台任务 A')
  assert.deepEqual(await evaluate(`[...${app}.agentTakeoverTerminalIds]`), [a.terminal])
  await click(`${panel} [aria-label="新建会话"]`)
  await waitFor(`${app}.activeAiSessionId !== ${JSON.stringify(a.session)} && ${app}.activeTerminal?.status === 'remote'`)
  const b = await evaluate(`({ session: ${app}.activeAiSessionId, terminal: ${app}.activeTerminalId, connection: ${app}.activeConnectionId })`)
  assert.notEqual(b.terminal, a.terminal)
  assert.equal(b.connection, 'alpha', 'New session opens another terminal on the same host')
  assert.equal(await evaluate(`${app}.workspaceSessions.find(session => session.id === ${JSON.stringify(b.session)}).aiMode`), 'agent')
  assert.equal(await evaluate(`${runtime}.requests.length`), 1, 'New session does not cancel the original model request')
  await waitFor('__terminalDebugFixture.pendingChunks === 0')
  await start('后台任务 B')
  assert.equal(await evaluate(`${app}.agentTakeoverTerminalIds.size`), 2)
  for (const terminalId of [a.terminal, b.terminal]) {
    assert.equal(await evaluate(`document.querySelector('.tab[data-terminal-id="${terminalId}"] .tab-close').disabled`), true, 'Both foreground and background terminals remain protected')
  }
  await evaluate(`${app}.rightCollapsed = true`)
  await waitFor(`!document.querySelector('${panel}')`)
  assert.equal(await evaluate(`${runtime}.requests.length`), 2, 'Collapsing the sidebar keeps both model requests running')
  await evaluate(`${app}.rightCollapsed = false`)
  await waitFor(`Boolean(document.querySelector('${panel}'))`)
  await evaluate(`__aiBackground.reply('后台任务 A', '执行 A', [{ id: 'command-a', command: 'echo BACKGROUND_A' }])`)
  await waitFor(`${app}.aiSessionActivities[${JSON.stringify(a.session)}]?.status === 'waiting-approval'`)
  await click(`${panel} [aria-label="会话列表"]`)
  assert.equal(await evaluate(`document.querySelector('${panel} [data-session-id="${a.session}"] .session-activity').textContent.trim()`), '● 待确认')
  assert.equal(await evaluate(`document.querySelector('${panel} [data-session-id="${b.session}"] .session-activity').textContent.trim()`), '● 运行中')
  assert.equal(await evaluate(`document.querySelector('${panel} [data-session-id="${a.session}"] [aria-label="删除会话"]').disabled`), true)
  assert.match(await evaluate(`document.querySelector('${panel} [data-session-id="${a.session}"] .session-history-main small').textContent`), /终端.*atlas/)
  const listScreenshot = await screenshot('background-session-list.png')
  await click(`${panel} [data-session-id="${a.session}"]`)
  assert.equal(await evaluate(`${app}.activeTerminalId`), a.terminal)
  await click(`${panel} [data-step-id="command-a"] .tool-step-decision .is-primary`)
  await waitFor('__aiBackground.heldWrites.length === 1')
  await selectSession(b.session)
  assert.equal(await evaluate(`${app}.activeTerminalId`), b.terminal)
  assert.deepEqual(await evaluate('__aiBackground.cancellations'), [])
  await evaluate(`__aiBackground.reply('后台任务 B', '执行 B', [{ id: 'command-b', command: 'echo BACKGROUND_B' }])`)
  await waitFor(`Boolean(document.querySelector('${panel} [data-step-id="command-b"] .tool-step-decision .is-primary'))`)
  await click(`${panel} [data-step-id="command-b"] .tool-step-decision .is-primary`)
  await waitFor(`${runtime}.requests.some(call => call.request.goal === '后台任务 B')`)
  await evaluate(`__aiBackground.reply('后台任务 B', 'B 已完成')`)
  await waitFor(`${app}.aiSessionActivities[${JSON.stringify(b.session)}].status === 'idle'`)
  assert.deepEqual(await evaluate(`[...${app}.agentTakeoverTerminalIds]`), [a.terminal], 'Completing B releases only B’s terminal')
  assert.equal(await evaluate(`${app}.aiMessagesBySession[${JSON.stringify(b.session)}].at(-1).agentStatus`), 'done')
  assert.ok(await evaluate(`${app}.aiMessagesBySession[${JSON.stringify(b.session)}].at(-1).agentSteps[0].output.includes('BACKGROUND_B')`))
  await evaluate('__aiBackground.releaseWrite()')
  await waitFor(`${runtime}.requests.some(call => call.request.goal === '后台任务 A')`)
  const requestA = await evaluate(`${runtime}.requests.find(call => call.request.goal === '后台任务 A').request`)
  assert.ok(JSON.stringify(requestA.turns).includes('BACKGROUND_A'))
  assert.ok(!JSON.stringify(requestA.turns).includes('BACKGROUND_B'))
  await start('停止任务 B')
  await click(`${panel} .chat-send`)
  await waitFor(`${app}.aiSessionActivities[${JSON.stringify(b.session)}].status === 'idle'`)
  await waitFor(`${runtime}.requests.length === 1`)
  assert.equal(await evaluate(`${runtime}.requests.length`), 1, 'Stopping current task leaves the background model request running')
  assert.equal(await evaluate(`${runtime}.requests[0].request.goal`), '后台任务 A')
  await evaluate(`__aiBackground.reply('后台任务 A', 'A 在后台完成')`)
  await waitFor(`${app}.aiSessionActivities[${JSON.stringify(a.session)}].status === 'idle'`)
  assert.equal(await evaluate(`${app}.agentTakeoverTerminalIds.size`), 0)
  assert.equal(await evaluate(`${app}.activeAiSessionId`), b.session, 'Background completion does not steal the selected conversation')
  await click(`${panel} [aria-label="会话列表"]`)
  assert.equal(await evaluate(`document.querySelectorAll('${panel} .session-activity').length`), 0, 'Finished and stopped tasks no longer appear as running')
  await click(`${panel} [aria-label="会话列表"]`)
  await selectSession(a.session)
  assert.equal(await evaluate(`${app}.activeTerminalId`), a.terminal)
  assert.match(await evaluate(`document.querySelector('${panel} .chat-message-content').textContent`), /A 在后台完成/)
  assert.doesNotMatch(await evaluate(`document.querySelector('${panel} .chat-message-content').textContent`), /B 已完成/)
  const resultScreenshot = await screenshot('background-task-completed.png')
  assert.deepEqual(exceptions, [])
  console.log(JSON.stringify({ result: 'passed', checks: ['new conversation opens same-host terminal without cancelling Agent', 'concurrent terminal ownership and per-session approvals', 'session list running/waiting badges and deletion protection', 'switching restores bound terminal during command execution', 'background command results and messages remain isolated', 'completion and stop release only the owning terminal'], screenshots: [listScreenshot, resultScreenshot], nativeBackendTested: false }, null, 2))
} catch (error) {
  console.error('Failure screenshot:', await screenshot('failure.png').catch(() => 'unavailable'))
  console.error(await evaluate(`({ activities: ${app}?.aiSessionActivities, requests: ${runtime}?.requests.map(call => ({ goal: call.request.goal })), text: document.querySelector('${panel}')?.textContent?.slice(-2000) })`).catch(() => null))
  throw error
} finally {
  for (const request of pending.values()) clearTimeout(request.timer)
  socket.close()
  await fetch(`${debuggerUrl}/json/close/${target.id}`).catch(() => {})
}
