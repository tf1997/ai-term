import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const debuggerUrl = process.env.AI_TERM_CDP_URL ?? 'http://127.0.0.1:9231'
const appUrl = process.env.AI_TERM_PREVIEW_URL ?? 'http://127.0.0.1:4182'
const outputDirectory = mkdtempSync(join(tmpdir(), 'ai-term-script-check-'))
const screenshots = []
const target = await fetch(`${debuggerUrl}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json())
const socket = new WebSocket(target.webSocketDebuggerUrl)
let sequence = 0
const requests = new Map()
const errors = []
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  if (message.id && requests.has(message.id)) {
    const request = requests.get(message.id)
    clearTimeout(request.timer)
    requests.delete(message.id)
    message.error ? request.reject(message.error) : request.resolve(message.result)
  }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
})
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    requests.set(id, { resolve, reject, timer: setTimeout(() => reject(new Error(method)), 10000) })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
async function until(expression) {
  const started = Date.now()
  while (Date.now() - started < 10000) {
    if (await evaluate(expression)) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Timeout: ${expression}`)
}
async function click(selector) {
  const point = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await new Promise(resolve => setTimeout(resolve, 50))
}
async function edit(selector, value) {
  await evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await new Promise(resolve => setTimeout(resolve, 50))
}
async function key(key, code, keyCode) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, ...(key === 'Enter' ? { text: '\r' } : {}) })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode })
}

async function screenshot(name) {
  await evaluate(`document.querySelectorAll('.toast-stack button').forEach(button => button.click())`)
  await evaluate('document.fonts.ready.then(() => true)')
  const capture = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const path = join(outputDirectory, name)
  writeFileSync(path, Buffer.from(capture.data, 'base64'))
  screenshots.push(path)
}

await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }))
try {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: appUrl })
  await until(`document.querySelector('.app-shell')`)
  await evaluate(`(() => { const button = Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes('辅助工具')); if (button?.getAttribute('aria-expanded') === 'false') button.click(); })()`)
  await evaluate(`(() => {
    const scripts = ['A', 'B'].map(id => ({ id, name: id + '-很长的脚本名称用于校验在窄栏中始终保留名称.sh', description: '检查和整理服务日志，输出摘要', content: 'LOG_DIR=""\\nrm -rf "$LOG_DIR"\\necho ready', connectionId: 'remote', workspaceSessionId: 'workspace', sourceCommands: [], createdAt: '2026-09-15', updatedAt: '2026-09-15' }));
    localStorage.setItem('ai-term:update-scripts:v2:global', JSON.stringify(scripts));
  })()`)
  await evaluate(`Array.from(document.querySelectorAll('.workspace-tabs button')).find(button => button.textContent.includes('脚本')).click()`)
  await until(`document.querySelector('.script-panel')`)
  await click('.script-head button[aria-label="返回脚本库"]')
  await until(`document.querySelectorAll('.script-library-open').length === 2`)
  // Native buttons provide the same activation for pointer, Enter, and Space.
  await evaluate(`document.querySelector('.script-library-row button[aria-label="编辑脚本名"]').focus()`)
  assert.equal(await evaluate(`document.activeElement?.getAttribute('aria-label')`), '编辑脚本名', await evaluate(`document.querySelector('.workspace-panel').outerHTML.slice(0, 400)`))
  await key('Enter', 'Enter', 13)
  await until(`document.querySelector('.rename-modal')`)
  assert.equal(await evaluate(`!!document.querySelector('.script-library-editor')`), false)
  await until(`document.activeElement === document.querySelector('.rename-modal input')`)
  await evaluate(`document.querySelector('.rename-modal button[type="submit"]').focus()`)
  await key('Tab', 'Tab', 9)
  assert.equal(await evaluate(`document.activeElement === document.querySelector('.rename-modal button[aria-label="关闭"]')`), true)
  await key('Escape', 'Escape', 27)
  await until(`!document.querySelector('.rename-modal')`)
  assert.equal(await evaluate(`document.activeElement?.getAttribute('aria-label')`), '编辑脚本名')
  await key(' ', 'Space', 32)
  await until(`document.querySelector('.rename-modal input') === document.activeElement`)
  await click('.rename-modal button[aria-label="关闭"]')
  await evaluate(`document.querySelector('.script-library-open').focus()`)
  await key(' ', 'Space', 32)
  await until(`document.querySelector('.script-library-editor textarea') === document.activeElement`)
  await edit('.script-library-editor textarea', 'echo retained A')
  await click('.script-back-to-library')
  await click('.script-library-open')
  assert.equal(await evaluate(`document.querySelector('.script-library-editor textarea').value`), 'echo retained A')
  await edit('.script-library-editor textarea', '')
  assert.equal(await evaluate(`!!document.querySelector('.script-library-editor .script-dirty-dot')`), true)
  await click('.script-back-to-library')
  await click('.script-library-open')
  assert.equal(await evaluate(`document.querySelector('.script-library-editor textarea').value`), '')
  await edit('.script-library-editor textarea', 'LOG_DIR=""\nrm -rf "$LOG_DIR"')
  const measurements = []
  for (const width of [360, 560]) {
    await evaluate(`document.querySelector('.workspace-resizer').focus()`)
    await key('Home', 'Home', 36)
    for (let value = 320; value < width; value += 20) await key('ArrowLeft', 'ArrowLeft', 37)
    await until(`document.querySelector('.right-panel').getBoundingClientRect().width === ${width}`)
    await new Promise(resolve => setTimeout(resolve, 80))
    const measurement = await evaluate(`(() => {
      const panel = document.querySelector('.script-panel');
      const name = panel.querySelector('.script-file-tab strong');
      const editor = panel.querySelector('.script-library-editor textarea');
      const expand = panel.querySelector('.script-expand-button');
      return { width: panel.getBoundingClientRect().width, nameWidth: name.getBoundingClientRect().width, editorHeight: editor.getBoundingClientRect().height, expandWidth: expand.getBoundingClientRect().width, overflow: panel.scrollWidth - panel.clientWidth, risk: panel.querySelector('.script-risk-details').textContent, target: panel.querySelector('.script-execution-target').textContent };
    })()`)
    assert.ok(measurement.nameWidth > 100, JSON.stringify(measurement))
    assert.ok(measurement.editorHeight > 140, JSON.stringify(measurement))
    assert.ok(measurement.expandWidth > 50, JSON.stringify(measurement))
    assert.ok(measurement.overflow < 2, JSON.stringify(measurement))
    assert.match(measurement.target, /Bash/)
    assert.match(measurement.risk, /运行前需确认/)
    measurements.push(measurement)
    for (const theme of ['light', 'dark']) {
      await new Promise(resolve => setTimeout(resolve, 200))
      if (!await evaluate(`document.querySelector('.app-shell').classList.contains('theme-${theme}')`)) await click('.theme-toggle-button')
      await until(`document.querySelector('.app-shell.theme-${theme}')`)
      await screenshot(`script-${theme}-${width}.png`)
    }
  }
  await click('.script-library-editor .script-expand-button')
  await until(`document.querySelector('.script-preview-modal textarea')`)
  assert.ok(await evaluate(`document.querySelector('.script-preview-modal textarea').getBoundingClientRect().height > 250`))
  await edit('.script-preview-modal textarea', 'rm -rf /tmp/ai-term-review')
  await click('.script-preview-modal button[aria-label="执行脚本"]')
  await until(`document.activeElement === document.querySelector('.script-risk-actions button:not(.danger)')`)
  await key('Escape', 'Escape', 27)
  await until(`!document.querySelector('.script-risk-modal')`)
  assert.equal(await evaluate(`document.activeElement === document.querySelector('.script-preview-modal button[aria-label="执行脚本"]')`), true)
  await key('Escape', 'Escape', 27)
  await until(`!document.querySelector('.script-preview-modal')`)
  assert.equal(await evaluate(`document.activeElement === document.querySelector('.script-library-editor .script-expand-button')`), true)
  await evaluate(`(() => {
    const state = document.querySelector('.script-panel').__vueParentComponent.setupState;
    const doc = state.documents.A;
    doc.pending = { content: 'echo accepted A', messageId: 'fixture-result', baseContent: doc.content, baseRevision: doc.revision, baseContext: '' };
    state.messages = [{ id: 'fixture-result', role: 'assistant', text: '修改完成', targetDocumentId: 'A', targetTitle: doc.title, applicationState: 'pending', scriptContent: 'echo accepted A', createdAt: '' }];
  })()`)
  await until(`document.querySelector('.script-generation-review')`)
  await screenshot('script-pending-version.png')
  await click('.script-generation-review > button:last-child')
  assert.match(await evaluate(`document.querySelector('.script-code-card .code-head').textContent`), /未采纳/)
  await evaluate(`document.querySelector('.script-panel').__vueParentComponent.setupState.reviewMessageVersion(document.querySelector('.script-panel').__vueParentComponent.setupState.messages[0])`)
  await click('.script-generation-review > button:first-of-type')
  assert.equal(await evaluate(`document.querySelector('.script-library-editor textarea').value`), 'echo accepted A')
  assert.match(await evaluate(`document.querySelector('.script-code-card .code-head').textContent`), /已应用，尚未保存/)
  await click('.script-library-editor button[aria-label="保存修改"]')
  await until(`document.querySelector('.script-code-card .code-head').textContent.includes('已应用并保存')`)
  await edit('.script-library-editor textarea', 'echo newer A')
  assert.match(await evaluate(`document.querySelector('.script-code-card .code-head').textContent`), /草稿已有后续修改/)
  await click('.script-head button[title="新增脚本"]')
  await edit('.script-draft-card textarea', 'echo first draft')
  await click('.script-head button[title="新增脚本"]')
  await edit('.script-draft-card textarea', 'echo second draft')
  await click('.script-head button[aria-label="返回脚本库"]')
  await evaluate(`Array.from(document.querySelectorAll('.script-retained-drafts button')).find(button => button.textContent.includes('未命名脚本 2')).click()`)
  await until(`document.querySelector('.script-draft-card textarea')?.value === 'echo first draft'`)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ success: true, measurements, screenshots }, null, 2))
} catch (error) {
  await screenshot('failure.png').catch(() => {})
  console.error('Browser screenshots:', screenshots)
  throw error
} finally {
  for (const request of requests.values()) clearTimeout(request.timer)
  socket.close()
  await fetch(`${debuggerUrl}/json/close/${target.id}`).catch(() => {})
}
