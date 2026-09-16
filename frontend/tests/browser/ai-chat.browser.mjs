import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const debuggerUrl = process.env.AI_TERM_CDP_URL ?? 'http://127.0.0.1:9231'
const fixtureUrl = process.env.AI_TERM_AI_FIXTURE_URL ?? 'http://127.0.0.1:5173/tests/browser/ai-chat.fixture.html'
const outputDirectory = mkdtempSync(join(tmpdir(), 'ai-term-chat-check-'))
const target = await fetch(`${debuggerUrl}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(5000) }).then(response => response.json())
const socket = new WebSocket(target.webSocketDebuggerUrl)
const requests = new Map()
const exceptions = []
const checks = []
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

function closeEnough(actual, expected, message, tolerance = 1.1) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, received ${actual}`)
}

try {
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Network.enable')
  await send('Network.setBlockedURLs', { urls: ['https://fixture.invalid/*'] })
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1120, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: fixtureUrl })
  await waitFor('window.aiFixtureReady === true && document.querySelectorAll(".assistant-panel .chat-turn-assistant").length >= 8')
  await click('[data-message-id="long-output"] .tool-step-toggle')
  await waitFor('Boolean(document.querySelector("[data-message-id=long-output] .tool-code-output"))')

  const geometry = []
  for (const theme of ['light', 'dark']) {
    for (const zoom of [1, 1.25]) {
      for (const width of [360, 420, 430, 554, 560]) {
        await evaluate(`aiFixture.configure(${JSON.stringify({ theme, zoom, width })})`)
        const metrics = await evaluate(`(() => {
          const panel = document.querySelector('.assistant-panel');
          const list = panel.querySelector('.chat-message-list');
          const rect = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, top: r.top, bottom: r.bottom }; };
          const turns = [...list.querySelectorAll('.chat-turn-assistant')].map(element => ({ ...rect(element), body: rect(element.querySelector('.chat-turn-body')), tools: [...element.querySelectorAll('.tool-step, .chat-error')].map(rect) }));
          const composer = panel.querySelector('.chat-composer');
          const input = composer.querySelector('textarea');
          const steps = [...list.querySelectorAll('.tool-step')].map(element => {
            const title = element.querySelector('.tool-step-title');
            const meta = element.querySelector('.tool-step-meta');
            const status = element.querySelector('.tool-step-status');
            return { header: rect(element.querySelector('.tool-step-header')), title: rect(title), titleOverflow: title.scrollHeight > title.clientHeight + 1 || title.scrollWidth > title.clientWidth + 1, meta: meta ? rect(meta) : null, status: rect(status), collapsed: element.classList.contains('is-collapsed'), targetVisible: [...element.querySelectorAll('.tool-step-target')].some(target => target.getBoundingClientRect().height > 0) };
          });
          const command = panel.querySelector('[data-message-id="long-output"] .tool-code-command .tool-code-content');
          const output = panel.querySelector('[data-message-id="long-output"] .tool-code-output .tool-code-content');
          const longTitle = panel.querySelector('[data-message-id="long-output"] .tool-step-title');
          return { panel: { ...rect(panel), clientWidth: panel.clientWidth, scrollWidth: panel.scrollWidth }, list: { ...rect(list), clientWidth: list.clientWidth, scrollWidth: list.scrollWidth }, turns, steps, command: { overflowY: getComputedStyle(command).overflowY, clientHeight: command.clientHeight, scrollHeight: command.scrollHeight }, output: { whiteSpace: getComputedStyle(output).whiteSpace, clientHeight: output.clientHeight, scrollHeight: output.scrollHeight, lines: output.textContent.split('\\n').length }, longTitle: { height: longTitle.offsetHeight, lineHeight: parseFloat(getComputedStyle(longTitle).lineHeight) }, composer: rect(composer), input: rect(input), clippedButtons: [...composer.querySelectorAll('button')].filter(b => { const r = b.getBoundingClientRect(), c = composer.getBoundingClientRect(); return r.width && (r.left < c.left - 1 || r.right > c.right + 1 || r.bottom > c.bottom + 1); }).map(b => b.title || b.textContent.trim()) };
        })()`)
        const label = `${theme}, ${width}px, ${zoom * 100}%`
        assert.ok(metrics.panel.scrollWidth <= metrics.panel.clientWidth + 1, `Panel horizontal overflow (${label})`)
        assert.ok(metrics.list.scrollWidth <= metrics.list.clientWidth + 1, `Conversation horizontal overflow (${label})`)
        for (const turn of metrics.turns) {
          closeEnough(turn.left, metrics.turns[0].left, `Turn left edge (${label})`)
          closeEnough(turn.right, metrics.turns[0].right, `Turn right edge (${label})`)
          closeEnough(turn.body.left, metrics.turns[0].body.left, `Body left edge (${label})`)
          closeEnough(turn.body.right, metrics.turns[0].body.right, `Body right edge (${label})`)
          for (const tool of turn.tools) {
            closeEnough(tool.left, turn.body.left, `Tool left edge (${label})`)
            closeEnough(tool.right, turn.body.right, `Tool right edge (${label})`)
          }
        }
        assert.deepEqual(metrics.clippedButtons, [], `Composer controls clipped (${label})`)
        assert.ok(metrics.list.bottom <= metrics.composer.top + 1.1, `Conversation overlaps composer (${label})`)
        assert.ok(metrics.input.width >= 180 * zoom, `Input too narrow (${label})`)
        for (const step of metrics.steps) {
          assert.ok(!step.titleOverflow, `Agent step title clips (${label})`)
          if (step.meta) assert.ok(step.meta.top >= step.title.bottom - 1 && step.meta.bottom <= step.header.bottom + 1, `Agent step header/meta overlap (${label})`)
          assert.ok(step.status.top >= step.title.bottom - 1 && step.status.right <= step.header.right + 1, `Step status overlaps the title or clips (${label})`)
          assert.equal(step.targetVisible, !step.collapsed, `Collapsed step repeats target metadata (${label})`)
        }
        assert.ok(metrics.longTitle.height > metrics.longTitle.lineHeight * 1.5, `Long title must wrap (${label})`)
        assert.ok(metrics.command.scrollHeight > metrics.command.clientHeight + 1, `Long command fixture must exceed preview height (${label})`)
        assert.equal(metrics.command.overflowY, 'auto', `Command preview uses the shared scroll container (${label})`)
        assert.equal(metrics.output.whiteSpace, 'pre', `Output preserves terminal columns (${label})`)
        assert.ok(metrics.output.scrollHeight > metrics.output.clientHeight + 1 && metrics.output.lines >= 48, `Output fixture keeps a bounded scroll region (${label})`)
        geometry.push({ theme, zoom, width, turnWidth: metrics.turns[0].width, bodyWidth: metrics.turns[0].body.width })
      }
    }
  }
  checks.push('20 panel width/theme/125% CSS zoom combinations keep message and body edges aligned', 'No panel horizontal overflow or composer overlap')
  checks.push('Long Chinese step titles wrap without metadata overlap', 'Collapsed steps omit repeated targets', 'Command previews avoid nested scrolling while multiline output preserves columns')

  await evaluate('aiFixture.configure({ theme: "light", zoom: 1, width: 554 })')
  const firstScreenshot = await screenshot('ai-chat-light-554.png')
  await evaluate('document.querySelector(".chat-message-list").scrollTop = 0')
  const topScreenshot = await screenshot('ai-chat-light-554-top.png')
  await evaluate('aiFixture.configure({ theme: "dark", zoom: 1.25, width: 360 })')
  const narrowScreenshot = await screenshot('ai-chat-dark-360-125.png')

  await evaluate('aiFixture.configure({ theme: "light", zoom: 1, width: 420 })')
  await evaluate(`(() => { const input = document.querySelector('.chat-composer textarea'); input.value = 'Draft retained while changing mode'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await click('.chat-mode-switch button:last-child')
  await waitFor('aiFixture.state.props.workspaceSessions[0].aiMode === "agent"')
  assert.equal(await evaluate('document.querySelector(".chat-composer textarea").value'), 'Draft retained while changing mode')
  await click('.chat-mode-switch button:first-child')
  await waitFor('aiFixture.state.props.workspaceSessions[0].aiMode === "chat"')
  checks.push('Draft persists across chat/Agent mode switches')

  const completedTurn = '[data-message-id="completed"]'
  const longTurn = '[data-message-id="long-output"]'
  const dispatchTurn = '[data-message-id="dispatch-failed"]'
  assert.equal(await evaluate(`Boolean(document.querySelector('${dispatchTurn} .tool-code-output'))`), false, 'A command that never started must not show an output block')
  assert.ok(await evaluate(`document.querySelector('${dispatchTurn}').textContent.includes('命令未执行')`), 'Dispatch failure explains that the command never ran')
  await click(`${dispatchTurn} .tool-step-actions button[aria-expanded]`)
  await waitFor(`document.querySelector('${dispatchTurn} .tool-step-error-detail')?.textContent.includes('Shell')`)
  assert.equal(await evaluate(`Boolean(document.querySelector('${dispatchTurn} .chat-error'))`), false, 'A tool error should not repeat a model-error notice')

  const initialExpanded = await evaluate(`document.querySelector('${completedTurn} .tool-step-toggle').getAttribute('aria-expanded')`)
  await click(`${completedTurn} .tool-step-toggle`)
  await waitFor(`document.querySelector('${completedTurn} .tool-step-toggle').getAttribute('aria-expanded') !== '${initialExpanded}'`)
  await click(`${completedTurn} .tool-step-toggle`)
  await waitFor(`document.querySelector('${completedTurn} .tool-step-toggle').getAttribute('aria-expanded') === '${initialExpanded}'`)
  if (await evaluate(`document.querySelector('${longTurn} .tool-step-toggle').getAttribute('aria-expanded') === 'false'`)) await click(`${longTurn} .tool-step-toggle`)
  await waitFor(`Boolean(document.querySelector('${longTurn} button[aria-label="复制命令"]'))`)
  await click(`${longTurn} button[aria-label="复制命令"]`)
  assert.equal(await evaluate('aiFixture.copied.at(-1)'), await evaluate('aiFixture.state.props.messages.find(m => m.id === "long-output").agentSteps[0].command'), 'Copy command preserves complete text')
  await click(`${longTurn} .tool-code-command .tool-code-more`)
  await waitFor('Boolean(document.querySelector(".tool-preview-dialog[role=dialog]"))')
  assert.equal(await evaluate('document.querySelector(".tool-preview-content code").textContent'), await evaluate('aiFixture.state.props.messages.find(m => m.id === "long-output").agentSteps[0].command'), 'Command preview opens the complete original command')
  await click('.tool-preview-dialog button[aria-label="关闭"]')
  await waitFor('!document.querySelector(".tool-preview-dialog")')
  await click(`${longTurn} button[aria-label="复制输出"]`)
  assert.equal(await evaluate('aiFixture.copied.at(-1)'), await evaluate('aiFixture.state.props.messages.find(m => m.id === "long-output").agentSteps[0].output'), 'Copy output preserves content beyond preview')
  await click(`${longTurn} button[aria-label="展开输出"]`)
  await waitFor('Boolean(document.querySelector(".tool-preview-dialog[role=dialog]"))')
  assert.ok(await evaluate('document.querySelector(".tool-preview-dialog").textContent.includes("Long diagnostic output")'), 'Expanded output contains exact diagnostic content')
  await click('.tool-preview-dialog button[aria-label="关闭"]')
  await waitFor('!document.querySelector(".tool-preview-dialog")')
  await click('[data-message-id="hello"] button[aria-label="复制回复"]')
  assert.equal(await evaluate('aiFixture.copied.at(-1)'), 'Hello.')
  checks.push('Tool details collapse and reopen', 'Command, output and response copying preserves exact text', 'Full output dialog opens and closes', 'Dispatch failures show one cause and no fabricated output')

  await evaluate('document.querySelector(".chat-message-list").scrollTop = 80; document.querySelector(".chat-message-list").dispatchEvent(new Event("scroll"))')
  const beforeUpdate = await evaluate('document.querySelector(".chat-message-list").scrollTop')
  await evaluate('aiFixture.update("streaming", { text: "Streaming fixture response updated with more content.\\n".repeat(12) })')
  await new Promise(resolve => setTimeout(resolve, 150))
  closeEnough(await evaluate('document.querySelector(".chat-message-list").scrollTop'), beforeUpdate, 'Reading scroll position retained during stream update')
  await waitFor(`Boolean(document.querySelector('button[aria-label="回到最新"]'))`)
  await click('button[aria-label="回到最新"]')
  await waitFor('(() => { const list = document.querySelector(".chat-message-list"); return list.scrollHeight - list.scrollTop - list.clientHeight < 4; })()')
  checks.push('Streaming updates retain scroll position while reading earlier turns')

  await evaluate('aiFixture.configure({ approvalPreview: true, theme: "light", zoom: 1.25, width: 360 })')
  const approval = await evaluate(`(() => {
    const step = document.querySelector('[data-status="pending"]');
    const content = step.querySelector('.tool-code-full .tool-code-content');
    return { content: content.textContent, clipped: content.scrollHeight > content.clientHeight + 1, maxHeight: getComputedStyle(content).maxHeight, expandButton: Boolean(step.querySelector('.tool-code-more')), approvalAction: [...step.querySelectorAll('button')].some(button => button.textContent.includes('仅执行本次')) };
  })()`)
  assert.ok(approval.content.includes('最后输出行') && !approval.clipped, 'Approval renders the entire long command before execution')
  assert.equal(approval.maxHeight, 'none', 'Approval command has no preview height limit')
  assert.equal(approval.expandButton, false, 'Complete approval commands do not show a redundant expand button')
  assert.ok(approval.approvalAction, 'Approval command retains its execution action')
  assert.equal(await evaluate('document.querySelector(".tool-step-decision .is-allow").disabled'), true)
  assert.ok(await evaluate('document.querySelector(".tool-step-allow-reason").textContent.includes("仅支持本次确认")'), 'Unsupported always-allow has a visible explanation')
  await click('.tool-step-decision .is-primary')
  checks.push('Pending approval renders the full command at 360px and 125% zoom')

  await evaluate('aiFixture.beginRuntime("agent")')
  await evaluate(`(() => { const input = document.querySelector('.chat-composer textarea'); input.value = '检查运行状态'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await click('.chat-send')
  await waitFor('aiFixture.runtime.requests.length === 1 && document.querySelector(".chat-activity-stage").textContent.includes("正在规划任务")')
  await waitFor('document.querySelector(".chat-activity-time").textContent !== "0 秒"')
  await evaluate('aiFixture.runtime.reply("先检查状态", [{ id: "runtime-first", command: "printf status" }])')
  await waitFor('Boolean(document.querySelector("[data-step-id=runtime-first] .tool-step-decision"))')
  assert.ok(await evaluate('document.querySelector(".chat-message-content > :last-child .chat-progress").textContent.includes("等待确认命令")'), 'Agent progress remains visible after tool steps appear')
  assert.equal(await evaluate('document.querySelector("[data-step-id=runtime-first] .is-allow").disabled'), false, 'Always allow is an enabled button for an eligible command')
  assert.ok(await evaluate('document.querySelector("[data-step-id=runtime-first] .tool-step-allow").textContent.includes("所有会话")'), 'Approval explains the scope of saved permission')
  await evaluate('document.querySelector(".chat-message-list").scrollTop = 0')
  const sticky = await evaluate(`(() => {
    const panel = document.querySelector('.ai-chat-panel').getBoundingClientRect();
    const bar = document.querySelector('.chat-activity').getBoundingClientRect();
    return bar.top >= panel.top && bar.bottom <= panel.bottom;
  })()`)
  assert.ok(sticky, 'Live task status stays visible while reading earlier messages')
  await click('.chat-activity-jump')
  assert.ok(await evaluate('document.activeElement.closest("[data-step-id=runtime-first]") !== null'), 'Pending-decision shortcut transfers keyboard focus to the right step')
  const approvalScreenshot = await screenshot('ai-approval-light-360-125.png')
  await evaluate('aiFixture.configure({ theme: "dark" })')
  const darkApprovalScreenshot = await screenshot('ai-approval-dark-360-125.png')
  await click('[data-step-id="runtime-first"] .is-allow')
  await waitFor('aiFixture.runtime.pendingSaves.length === 1')
  assert.equal(await evaluate('aiFixture.runtime.commands.length'), 0, 'Saving permission must complete before dispatch')
  assert.ok(await evaluate('document.querySelector("[data-step-id=runtime-first] .is-allow").disabled'), 'Saving cannot be submitted twice')
  assert.ok(await evaluate('document.querySelector(".chat-activity-stage").textContent.includes("正在保存授权")'))
  await evaluate('aiFixture.runtime.finishSave()')
  await waitFor('aiFixture.runtime.commands.length === 1 && document.querySelector(".chat-activity-stage").textContent.includes("正在执行命令")')
  await waitFor('!document.querySelector("[data-step-id=runtime-first] .tool-step-duration").textContent.includes("0 秒")')
  await evaluate('aiFixture.runtime.finishCommand()')
  await waitFor('aiFixture.runtime.requests.length === 1 && document.querySelector(".chat-activity-stage").textContent.includes("正在分析执行结果")')
  await evaluate('aiFixture.runtime.reply("继续检查", [{ id: "runtime-second", command: "printf finished" }])')
  await waitFor('aiFixture.runtime.commands.length === 2')
  assert.equal(await evaluate('Boolean(document.querySelector("[data-step-id=runtime-second] .tool-step-decision"))'), false, 'A later command with the saved prefix runs without another approval')
  assert.ok(await evaluate('document.querySelector("[data-step-id=runtime-second] .tool-step-auto").textContent.includes("自动执行")'))
  await evaluate('aiFixture.runtime.finishCommand()')
  await waitFor('aiFixture.runtime.requests.length === 1')
  await evaluate('aiFixture.runtime.reply("检查完成")')
  await waitFor('!document.querySelector(".chat-activity")')
  const duration = await evaluate('aiFixture.state.props.messages.at(-1).durationSeconds')
  assert.ok(duration >= 2, 'Task records real elapsed time')
  await evaluate('aiFixture.reopen()')
  assert.equal(await evaluate('aiFixture.state.props.messages.at(-1).durationSeconds'), duration)
  assert.ok(await evaluate('document.querySelector(".chat-message-content > :last-child .chat-duration").textContent.includes("耗时")'), 'Duration is visible after the panel is remounted from stored payloads')
  checks.push('Agent timer persists through planning, approval, saving, execution and analysis', 'Approval saves before dispatch and applies within the same run', 'A fixed status bar links to the pending command', 'Completed duration survives reopening the conversation')

  await evaluate('aiFixture.beginRuntime("agent", { agentCommandTimeoutMs: 150 })')
  await evaluate(`(() => { const input = document.querySelector('.chat-composer textarea'); input.value = '等待长命令'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await click('.chat-send')
  await waitFor('aiFixture.runtime.requests.length === 1')
  await evaluate('aiFixture.runtime.reply("运行长命令", [{ id: "runtime-timeout", command: "printf waiting" }])')
  await waitFor('Boolean(document.querySelector("[data-step-id=runtime-timeout] .tool-step-decision"))')
  await click('[data-step-id="runtime-timeout"] .is-primary')
  await waitFor('document.querySelector(".chat-activity-stage").textContent.includes("等待超时处理")')
  assert.equal(await evaluate('document.querySelector(".chat-activity-time").getAttribute("aria-live")'), 'off')
  await click('.chat-send')
  await waitFor('!document.querySelector(".chat-activity")')
  assert.ok(await evaluate('aiFixture.state.props.messages.at(-1).agentStatus === "stopped"'))
  assert.equal(await evaluate('aiFixture.state.props.messages.at(-1).agentSteps[0].startedAt'), undefined, 'Stopped command clocks are cleared')
  checks.push('Timeout decisions keep elapsed time visible and stopping clears active clocks')

  assert.deepEqual(exceptions, [], 'Uncaught browser exceptions')
  console.log(JSON.stringify({ result: 'passed', fixtureUrl, checks, geometry, screenshots: [firstScreenshot, topScreenshot, narrowScreenshot, approvalScreenshot, darkApprovalScreenshot], nativeBackendTested: false }, null, 2))
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
