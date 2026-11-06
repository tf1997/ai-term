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
  await evaluate(`(async () => {
    document.documentElement.dataset.platform = 'windows';
    await Promise.all([import('/node_modules/@fontsource-variable/noto-sans-sc/index.css'), import('/node_modules/@fontsource/jetbrains-mono/400.css'), import('/node_modules/@fontsource/jetbrains-mono/600.css')]);
    await document.fonts.ready;
    aiFixture.state.props.messages.find(message => message.id === 'completed').agentSteps[0].autoApproved = true;
    aiFixture.state.props.messages.find(message => message.id === 'completed').agentSteps[0].affectedFiles = Array.from({ length: 7 }, (_, index) => '/workspace/very-long-project-name/frontend/src/domains/ai/presentation/components/messages/changed-file-' + index + '.vue');
  })()`)
  assert.equal(await evaluate('[...document.querySelectorAll(".agent-work-toggle")].every(button => button.getAttribute("aria-expanded") === "false")'), true, 'Completed tasks start with their entire execution history folded')
  assert.equal(await evaluate('Boolean(document.querySelector("[data-message-id=completed] .tool-step"))'), false, 'Folded history is rendered only when opened')
  for (const id of ['completed', 'long-output', 'nonzero']) await click(`[data-message-id="${id}"] .agent-work-toggle`)
  assert.equal(await evaluate('Boolean(document.querySelector("[data-step-id=completed-step] .tool-step-exit"))'), false, 'Completed summaries omit successful exit metadata')
  assert.equal(await evaluate('Boolean(document.querySelector("[data-step-id=completed-step] .tool-step-auto"))'), false)
  await click('[data-step-id="completed-step"] .tool-step-toggle')
  await click('[data-step-id="completed-step"] .tool-step-details')
  assert.ok(await evaluate('document.querySelector(".agent-detail-section[data-kind=output] header").textContent.includes("exit 0")'), 'Execution details retain the exact exit code')
  assert.ok(await evaluate('document.querySelector(".agent-detail-meta").textContent.includes("自动执行")'))
  await click('.agent-detail-dialog button[aria-label="关闭"]')
  await click('[data-step-id="completed-step"] .tool-step-toggle')
  assert.equal(await evaluate('document.querySelector("[data-step-id=nonzero-step] .tool-step-exit").textContent'), 'exit 1', 'Nonzero exits stay prominent')
  assert.equal(await evaluate('document.querySelector("[data-step-id=pending-step]").classList.contains("is-awaiting-decision")'), false, 'Historical pending steps are not live approval requests')
  assert.equal(await evaluate('document.querySelector("[data-step-id=pending-step] .tool-step-status").textContent'), '待执行')
  await evaluate(`aiFixture.update('pending', { agentSteps: [{ ...aiFixture.state.props.messages.find(message => message.id === 'pending').agentSteps[0], status: 'skipped' }] })`)
  assert.equal(await evaluate('document.querySelector("[data-step-id=pending-step] .tool-step-status").textContent'), '已跳过', 'Skipped steps retain a visible status instead of appearing completed')
  await evaluate(`aiFixture.update('pending', { agentSteps: [{ ...aiFixture.state.props.messages.find(message => message.id === 'pending').agentSteps[0], status: 'pending' }] })`)
  checks.push('Compact summaries retain execution metadata in the details dialog and distinguish historical pending steps from live approvals')
  await click('[data-message-id="long-output"] .tool-step-toggle')
  await waitFor('Boolean(document.querySelector("[data-message-id=long-output] .tool-step-details"))')

  const geometry = []
  for (const theme of ['light', 'dark']) {
    for (const zoom of [1, 1.25, 1.5]) {
      for (const width of [320, 360, 420, 430, 554, 560]) {
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
            return { header: rect(element.querySelector('.tool-step-header')), title: rect(title), titleOverflow: title.scrollHeight > title.clientHeight + 1 || title.scrollWidth > title.clientWidth + 1, meta: meta ? rect(meta) : null, status: status ? rect(status) : null, collapsed: element.classList.contains('is-collapsed'), targetVisible: [...element.querySelectorAll('.tool-step-target')].some(target => target.getBoundingClientRect().height > 0) };
          });
          const inlineCode = panel.querySelector('[data-message-id="long-output"] .tool-code-content');
          const longTitle = panel.querySelector('[data-message-id="long-output"] .tool-step-title');
          return { panel: { ...rect(panel), clientWidth: panel.clientWidth, scrollWidth: panel.scrollWidth }, list: { ...rect(list), clientWidth: list.clientWidth, scrollWidth: list.scrollWidth }, turns, steps, inlineCode: Boolean(inlineCode), longTitle: { height: longTitle.offsetHeight, lineHeight: parseFloat(getComputedStyle(longTitle).lineHeight) }, composer: rect(composer), input: rect(input), clippedButtons: [...composer.querySelectorAll('button')].filter(b => { const r = b.getBoundingClientRect(), c = composer.getBoundingClientRect(); return r.width && (r.left < c.left - 1 || r.right > c.right + 1 || r.bottom > c.bottom + 1); }).map(b => b.title || b.textContent.trim()) };
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
          if (step.status) assert.ok(step.status.top >= step.title.bottom - 1 && step.status.right <= step.header.right + 1, `Step status overlaps the title or clips (${label})`)
          assert.equal(step.targetVisible, false, `Historical source metadata belongs in the details (${label})`)
        }
        assert.ok(metrics.longTitle.height > metrics.longTitle.lineHeight * 1.5, `Long title must wrap (${label})`)
        assert.equal(metrics.inlineCode, false, `Completed execution details must not add nested scrolling to the conversation (${label})`)
        geometry.push({ theme, zoom, width, turnWidth: metrics.turns[0].width, bodyWidth: metrics.turns[0].body.width })
      }
    }
  }
  checks.push('36 panel width/theme/100–150% CSS zoom combinations keep message and body edges aligned', 'No panel horizontal overflow or composer overlap')
  checks.push('Long Chinese step titles wrap without metadata overlap', 'Historical sources stay in execution details', 'Completed commands and output stay out of the main scroll area')

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
  await click(`${dispatchTurn} .tool-step-details`)
  await waitFor(`document.querySelector('.agent-detail-section[data-kind="error"]')?.textContent.includes('Shell')`)
  assert.equal(await evaluate('Boolean(document.querySelector(".agent-detail-section[data-kind=output]"))'), false, 'A dispatch failure must not fabricate output in its dialog')
  await click('.agent-detail-dialog button[aria-label="关闭"]')
  await waitFor('!document.querySelector(".agent-detail-dialog")')
  assert.equal(await evaluate(`Boolean(document.querySelector('${dispatchTurn} .chat-error'))`), false, 'A tool error should not repeat a model-error notice')

  const initialExpanded = await evaluate(`document.querySelector('${completedTurn} .tool-step-toggle').getAttribute('aria-expanded')`)
  await click(`${completedTurn} .tool-step-toggle`)
  await waitFor(`document.querySelector('${completedTurn} .tool-step-toggle').getAttribute('aria-expanded') !== '${initialExpanded}'`)
  await click(`${completedTurn} .tool-step-toggle`)
  await waitFor(`document.querySelector('${completedTurn} .tool-step-toggle').getAttribute('aria-expanded') === '${initialExpanded}'`)
  if (await evaluate(`document.querySelector('${longTurn} .tool-step-toggle').getAttribute('aria-expanded') === 'false'`)) await click(`${longTurn} .tool-step-toggle`)
  await click(`${longTurn} .tool-step-details`)
  await waitFor('Boolean(document.querySelector(".agent-detail-dialog"))')
  await click('.agent-detail-dialog button[aria-label="复制命令"]')
  assert.equal(await evaluate('aiFixture.copied.at(-1)'), await evaluate('aiFixture.state.props.messages.find(m => m.id === "long-output").agentSteps[0].command'), 'Copy command preserves complete text')
  assert.equal(await evaluate('document.querySelector(".agent-detail-section[data-kind=command] code").textContent'), await evaluate('aiFixture.state.props.messages.find(m => m.id === "long-output").agentSteps[0].command'), 'Details contain the complete original command')
  await click('.agent-detail-dialog button[aria-label="复制输出"]')
  assert.equal(await evaluate('aiFixture.copied.at(-1)'), await evaluate('aiFixture.state.props.messages.find(m => m.id === "long-output").agentSteps[0].output'), 'Copy output preserves content beyond preview')
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".agent-detail-section[data-kind=output] pre")).whiteSpace'), 'pre', 'Output initially preserves terminal columns')
  assert.ok(await evaluate('(() => { const body = document.querySelector(".agent-detail-body"); return body.scrollHeight > body.clientHeight && body.scrollWidth > body.clientWidth; })()'), 'One dialog body owns scrolling of long output')
  await click('.agent-detail-options input')
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".agent-detail-section[data-kind=output] pre")).whiteSpace'), 'pre-wrap')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await waitFor('!document.querySelector(".agent-detail-dialog")')
  assert.equal(await evaluate(`document.activeElement === document.querySelector('${longTurn} .tool-step-details')`), true, 'Closing details restores the original trigger focus')
  await click('[data-message-id="hello"] button[aria-label="复制回复"]')
  assert.equal(await evaluate('aiFixture.copied.at(-1)'), 'Hello.')
  checks.push('Tool details collapse and reopen', 'Command, output and response copying preserves exact text', 'Full output dialog opens and closes', 'Dispatch failures show one cause and no fabricated output')

  assert.equal(await evaluate(`Boolean(document.querySelector('${longTurn} .agent-file-changes'))`), false, 'Tasks without recorded write targets do not fabricate changed files')
  assert.equal(await evaluate(`document.querySelectorAll('${completedTurn} .agent-file-row').length`), 5, 'Long file lists start compact')
  await click(`${completedTurn} .agent-files-more`)
  assert.equal(await evaluate(`document.querySelectorAll('${completedTurn} .agent-file-row').length`), 7)
  await click(`${completedTurn} .agent-work-toggle`)
  assert.equal(await evaluate(`document.querySelector('${completedTurn} .agent-work-toggle').getAttribute('aria-expanded')`), 'false')
  await click(`${completedTurn} .agent-file-row:last-child`)
  await waitFor('Boolean(document.querySelector(".agent-detail-dialog"))')
  assert.equal(await evaluate(`document.querySelector('${completedTurn} .agent-work-toggle').getAttribute('aria-expanded')`), 'true', 'File links reveal their associated work log')
  assert.equal(await evaluate('document.querySelector(".agent-detail-section[data-kind=command] code").textContent'), await evaluate('aiFixture.state.props.messages.find(m => m.id === "completed").agentSteps[0].command'))
  await click('.agent-detail-dialog button[aria-label="关闭"]')
  await click(`${completedTurn} .agent-files-more`)
  checks.push('Recorded write targets have a bounded list and open their original command without executing it')

  await evaluate(`(() => {
    const message = aiFixture.state.props.messages.find(m => m.id === 'completed');
    const path = message.agentSteps[0].affectedFiles[0];
    message.agentFileChanges = [{ path, requestedPaths: [path], scope: 'fixture', stepIds: ['completed-step'], before: { state: 'text', content: 'const size = 14;\\nconst keep = true;\\n' }, after: { state: 'text', content: 'const size = 12;\\nconst keep = true;\\nconst lineHeight = 18;' } }];
  })()`)
  assert.ok(await evaluate(`document.querySelector('${completedTurn} .agent-files-stats').textContent.includes('+2−1')`))
  assert.ok(await evaluate(`document.querySelector('${completedTurn} .agent-files-note').textContent.includes('6 个文件未计入统计')`))
  await click(`${completedTurn} .agent-file-row:first-child`)
  await waitFor('Boolean(document.querySelector(".agent-diff-dialog"))')
  assert.equal(await evaluate('document.querySelectorAll(".diff-add").length'), 2)
  assert.equal(await evaluate('document.querySelectorAll(".diff-remove").length'), 1)
  assert.equal(await evaluate('document.querySelector(".diff-add .diff-line-number:nth-child(2)").textContent'), '1')
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".diff-code")).fontSize'), '12px')
  assert.ok(await evaluate('document.querySelector(".diff-note").textContent.includes("文件末尾无换行")'))
  await click('.agent-diff-toolbar .agent-diff-action')
  assert.ok(await evaluate('aiFixture.copied.at(-1).includes("-const size = 14;\\n+const size = 12;")'))
  assert.ok(await evaluate('aiFixture.copied.at(-1).includes("No newline at end of file")'))
  reasoningScreenshots.push(await screenshot('ai-file-diff-light.png'))
  await evaluate('aiFixture.configure({ theme: "dark" })')
  await click('.agent-diff-dialog button[aria-label="关闭"]')
  await click(`${completedTurn} .agent-file-row:first-child`)
  reasoningScreenshots.push(await screenshot('ai-file-diff-dark.png'))
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  assert.equal(await evaluate(`document.activeElement === document.querySelector('${completedTurn} .agent-file-row:first-child')`), true)
  await evaluate(`aiFixture.state.props.messages.find(m => m.id === 'completed').agentFileChanges[0].after = { state: 'unavailable', reason: '文件超过快照大小限制' }`)
  assert.equal(await evaluate(`Boolean(document.querySelector('${completedTurn} .agent-files-stats'))`), false, 'Missing snapshots do not fabricate zero counts')
  await click(`${completedTurn} .agent-file-row:first-child`)
  assert.ok(await evaluate('document.querySelector(".agent-diff-empty").textContent.includes("超过快照大小限制")'))
  await click('.agent-diff-footer .agent-diff-action')
  await waitFor('Boolean(document.querySelector(".agent-detail-dialog"))')
  await click('.agent-detail-dialog button[aria-label="关闭"]')
  await evaluate(`aiFixture.state.props.messages.find(m => m.id === 'completed').agentFileChanges = undefined`)
  checks.push('Per-file diffs show exact line numbers and additions/deletions, copy unified patches, restore focus and explain unavailable snapshots')

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
  assert.ok(await evaluate('document.querySelector(".tool-step-allow-reason").textContent.includes("每次确认")'), 'Dynamic commands explain why reusable grants are unavailable')
  await click('.tool-step-decision .is-primary')
  checks.push('Pending approval renders the full command at 360px and 125% zoom')

  await evaluate('aiFixture.beginRuntime("agent")')
  await evaluate(`(() => { const input = document.querySelector('.chat-composer textarea'); input.value = '检查运行状态'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await click('.chat-send')
  await waitFor('aiFixture.runtime.requests.length === 1 && document.querySelector(".chat-activity-stage").textContent.includes("正在规划任务")')
  const activityAppearance = `(() => {
    const shell = document.querySelector('.chat-input-shell');
    const edge = getComputedStyle(shell.querySelector('.chat-input-aura-edge'), '::before');
    const dot = document.querySelector('.chat-activity .chat-progress-dot');
    const card = document.querySelector('[data-step-id=runtime-first]');
    return {
      borderImage: edge.backgroundImage,
      borderAnimation: edge.animationName,
      borderDuration: parseFloat(edge.animationDuration),
      borderTransform: edge.transform,
      borderMotion: edge.animationPlayState,
      washAnimation: getComputedStyle(shell.querySelector('.chat-input-aura-wash'), '::before').animationName,
      overflow: getComputedStyle(shell).overflow,
      animation: getComputedStyle(dot).animationName,
      waiting: shell.classList.contains('is-awaiting-decision'),
      cardWaiting: card?.classList.contains('is-awaiting-decision'),
      statusColor: getComputedStyle(document.querySelector('.chat-activity-stage')).color,
      cardColor: card && getComputedStyle(card.querySelector('.tool-step-status')).color
    };
  })()`
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
  const activeAppearance = await evaluate(activityAppearance)
  assert.match(activeAppearance.borderImage, /^conic-gradient/, 'Activity has a flowing color border')
  assert.notEqual(activeAppearance.borderAnimation, 'none', 'The input border animates while the task runs')
  assert.equal(activeAppearance.overflow, 'visible', 'Composer menus remain outside the input shell')
  assert.notEqual(activeAppearance.animation, 'none', 'An active task has a live status indicator')
  assert.equal(activeAppearance.waiting, false)
  await waitFor(`(${activityAppearance}).borderTransform !== ${JSON.stringify(activeAppearance.borderTransform)}`)
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  const reducedAppearance = await evaluate(activityAppearance)
  assert.equal(reducedAppearance.animation, 'none', 'Reduced motion stops the status pulse')
  assert.equal(reducedAppearance.washAnimation, 'none', 'Reduced motion stops the background drift')
  assert.notEqual(reducedAppearance.borderAnimation, 'none', 'Reduced motion retains localized task progress')
  assert.ok(reducedAppearance.borderDuration > activeAppearance.borderDuration, 'Reduced motion slows the border')
  await waitFor(`(${activityAppearance}).borderTransform !== ${JSON.stringify(reducedAppearance.borderTransform)}`)
  await waitFor('document.querySelector(".chat-activity-time").textContent !== "0 秒"')
  await evaluate('aiFixture.runtime.reply("先检查状态", [{ id: "runtime-first", command: "printf status" }])')
  await waitFor('Boolean(document.querySelector("[data-step-id=runtime-first] .tool-step-decision"))')
  const waitingAppearance = await evaluate(activityAppearance)
  assert.equal(waitingAppearance.waiting, true)
  assert.equal(waitingAppearance.cardWaiting, true)
  assert.equal(waitingAppearance.animation, 'none', 'The approval status dot remains still')
  assert.equal(waitingAppearance.borderMotion, 'running', 'Waiting colors keep a moving border while a decision is needed')
  await waitFor(`(${activityAppearance}).borderTransform !== ${JSON.stringify(waitingAppearance.borderTransform)}`)
  assert.equal(waitingAppearance.statusColor, waitingAppearance.cardColor, 'Card and sticky status use the same waiting color')
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".chat-progress.needs-decision")).color'), waitingAppearance.statusColor, 'Inline progress agrees with the approval state')
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".chat-progress.needs-decision .chat-progress-dot")).animationName'), 'none')
  assert.equal(await evaluate('document.querySelector("[data-step-id=runtime-first] .tool-step-status").textContent'), '等待确认')
  checks.push('Task activity stays visible, approval states agree across surfaces, and reduced motion retains a slower flowing border without background drift')
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
  const savingAppearance = await evaluate(activityAppearance)
  assert.equal(savingAppearance.waiting, false)
  assert.equal(savingAppearance.cardWaiting, false)
  assert.equal(savingAppearance.borderMotion, 'running', 'Saving authorization resumes the border with reduced motion')
  await waitFor(`(${activityAppearance}).borderTransform !== ${JSON.stringify(savingAppearance.borderTransform)}`)
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
  assert.notEqual((await evaluate(activityAppearance)).animation, 'none', 'Normal motion resumes the status pulse')
  assert.equal(await evaluate('document.querySelector("[data-step-id=runtime-first] .tool-step-status").textContent'), '正在保存授权')
  await evaluate('aiFixture.runtime.finishSave()')
  await waitFor('aiFixture.runtime.commands.length === 1 && document.querySelector(".chat-activity-stage").textContent.includes("正在执行命令")')
  await waitFor('!document.querySelector("[data-step-id=runtime-first] .tool-step-duration").textContent.includes("0 秒")')
  await evaluate('aiFixture.runtime.finishCommand()')
  await waitFor('aiFixture.runtime.requests.length === 1 && document.querySelector(".chat-activity-stage").textContent.includes("正在分析执行结果")')
  await evaluate('aiFixture.runtime.reply("继续检查", [{ id: "runtime-second", command: "printf finished", files: ["/workspace/fixture-file.txt"] }])')
  await waitFor('aiFixture.runtime.commands.length === 2')
  assert.equal(await evaluate('Boolean(document.querySelector("[data-step-id=runtime-second] .tool-step-decision"))'), false, 'A later command with the saved prefix runs without another approval')
  assert.ok(await evaluate('document.querySelector("[data-step-id=runtime-second] .tool-step-auto").textContent.includes("自动执行")'))
  await evaluate('aiFixture.runtime.finishCommand()')
  await waitFor('aiFixture.runtime.requests.length === 1')
  await evaluate('aiFixture.runtime.reply("检查完成")')
  await waitFor('!document.querySelector(".chat-activity")')
  const commentarySelector = '.chat-message-content > :last-child .agent-commentary'
  const workedSelector = '.chat-message-content > :last-child .agent-work-toggle'
  assert.equal(await evaluate(`document.querySelector('${workedSelector}').getAttribute('aria-expanded')`), 'false', 'Finishing a live task folds the whole work log')
  assert.equal(await evaluate(`Boolean(document.querySelector('${commentarySelector}'))`), false)
  assert.ok(await evaluate('document.querySelector(".chat-message-content > :last-child .chat-turn-body > .chat-markdown").textContent.includes("检查完成")'), 'Final answer remains visible outside the folded log')
  await click(workedSelector)
  assert.equal(await evaluate(`document.querySelector('${commentarySelector}').classList.contains('chat-markdown')`), true, 'Tool commentary uses the same Markdown renderer as the answer')
  const timelineExpression = `Array.from(document.querySelectorAll('.chat-message-content > :last-child .agent-timeline .agent-commentary, .chat-message-content > :last-child .agent-timeline .tool-step')).map(element => element.matches('.agent-commentary') ? element.textContent : element.dataset.stepId)`
  const timeline = await evaluate(timelineExpression)
  assert.deepEqual(timeline, ['先检查状态', 'runtime-first', '继续检查', 'runtime-second'], 'Thinking and tools follow actual turn order')
  assert.equal(await evaluate('Boolean(document.querySelector(".chat-message-content > :last-child .agent-completed-group"))'), false, 'Worked opens the chronological history without another completed group')
  assert.ok(await evaluate(`document.querySelector('${workedSelector}').textContent.includes('2 个步骤')`))
  await evaluate('document.querySelector(".chat-message-content > :last-child").scrollIntoView({ block: "end", behavior: "instant" })')
  const timelineScreenshot = await screenshot('ai-agent-ordered-timeline.png')
  const duration = await evaluate('aiFixture.state.props.messages.at(-1).durationSeconds')
  assert.ok(duration >= 2, 'Task records real elapsed time')
  await evaluate('aiFixture.reopen()')
  assert.equal(await evaluate(`document.querySelector('${workedSelector}').getAttribute('aria-expanded')`), 'false', 'Reload starts with the work log folded')
  assert.ok(await evaluate('document.querySelector(".chat-message-content > :last-child .agent-file-row").title.includes("/workspace/fixture-file.txt")'), 'File references survive persisted payload reload')
  assert.equal(await evaluate('aiFixture.runtime.snapshotReads'), 2, 'One hidden read before and one after the actual write')
  assert.ok(await evaluate('document.querySelector(".chat-message-content > :last-child .agent-files-stats").textContent.includes("+2−1")'), 'Exact diff counts survive persisted payload reload')
  await click('.chat-message-content > :last-child .agent-file-row')
  assert.equal(await evaluate('document.querySelectorAll(".agent-diff-dialog .diff-add").length'), 2)
  await click('.agent-diff-dialog button[aria-label="关闭"]')
  await click(workedSelector)
  assert.deepEqual(await evaluate(timelineExpression), timeline, 'Reload preserves interleaving')
  assert.equal(await evaluate(`document.querySelector('${commentarySelector}').classList.contains('chat-markdown')`), true)
  await evaluate(`(() => {
    const message = aiFixture.state.props.messages.at(-1);
    const fence = String.fromCharCode(96).repeat(3);
    message.agentTimeline[0].text = ['## 检查计划', '', '**先检查状态**', '', '- 查看内存', '- 查看磁盘', '', fence + 'bash', 'free -h', fence].join('\\n');
  })()`)
  await waitFor(`Boolean(document.querySelector('${commentarySelector} h2'))`)
  assert.equal(await evaluate(`document.querySelector('${commentarySelector} strong').textContent`), '先检查状态')
  assert.equal(await evaluate(`document.querySelectorAll('${commentarySelector} li').length`), 2)
  assert.ok(await evaluate(`document.querySelector('${commentarySelector}').textContent.includes('free -h')`))
  assert.equal(await evaluate(`Boolean(document.querySelector('${commentarySelector} .chat-code-run'))`), false)
  checks.push('Agent commentary renders headings, emphasis, lists and code using the answer renderer')
  checks.push('Agent thinking and tools remain in turn order after completion and payload reload')
  assert.equal(await evaluate('aiFixture.state.props.messages.at(-1).durationSeconds'), duration)
  assert.ok(await evaluate(`document.querySelector('${workedSelector}').textContent.includes('Worked for')`), 'Worked restores total duration from the saved payload')
  checks.push('Agent timer persists through planning, approval, saving, execution and analysis', 'Approval saves before dispatch and applies within the same run', 'A fixed status bar links to the pending command', 'Completed duration survives reopening the conversation')

  await evaluate('aiFixture.beginRuntime("agent")')
  await evaluate(`(() => { const input = document.querySelector('.chat-composer textarea'); input.value = '检查部署目标'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await click('.chat-send')
  await waitFor('aiFixture.runtime.requests.length === 1')
  await evaluate(`aiFixture.runtime.reply('先确认目标', [{ id: 'waiting-plan', name: 'update_plan', arguments: JSON.stringify({ expectedVersion: 0, reason: '等待用户选择环境', items: [{ id: 'choose', description: '确认部署目标', status: 'waiting', stepIds: [] }] }) }])`)
  await waitFor('aiFixture.runtime.requests.length === 1')
  await evaluate('aiFixture.runtime.askUser("需要检查 A 环境还是 B 环境？")')
  await waitFor('aiFixture.state.props.messages.at(-1).agentStatus === "waiting-input" && !document.querySelector(".chat-activity")')
  assert.ok(await evaluate('document.querySelector(".chat-message-content > :last-child .chat-task-summary").textContent.includes("等待你的回复")'))
  assert.equal(await evaluate('document.querySelector(".chat-send").getAttribute("aria-label")'), '发送')
  assert.equal(await evaluate('aiFixture.runtime.commands.length'), 0)
  await evaluate('aiFixture.reopen()')
  const waitingRunId = await evaluate('[...aiFixture.runtime.checkpoints.values()].find(record => record.messageId === aiFixture.state.props.messages.at(-1).id).runId')
  const waitingRunCount = await evaluate('aiFixture.runtime.checkpoints.size')
  assert.equal(await evaluate('document.querySelector(".chat-composer textarea").placeholder'), '回复上方问题，继续任务...')
  await evaluate(`(() => { const input = document.querySelector('.chat-composer textarea'); input.value = '检查 A 环境'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await click('.chat-send')
  await waitFor('aiFixture.runtime.requests.length === 1')
  const resumed = await evaluate('aiFixture.runtime.requests[0].request')
  assert.ok(resumed.goal.startsWith('检查部署目标'))
  assert.ok(resumed.goal.includes('检查 A 环境'))
  assert.ok(resumed.goal.includes('需要检查 A 环境还是 B 环境？'))
  assert.equal(JSON.parse(resumed.taskContext).plan.version, 1)
  assert.equal(await evaluate('aiFixture.runtime.checkpoints.size'), waitingRunCount)
  assert.equal(await evaluate(`aiFixture.runtime.checkpoints.get(${JSON.stringify(waitingRunId)}).messageId`), await evaluate('aiFixture.state.props.messages.at(-1).id'))
  assert.ok(resumed.conversationMessages.some(message => message.content.includes('需要检查 A 环境还是 B 环境？')))
  await evaluate('aiFixture.runtime.askUser("是否先只验证配置？")')
  await waitFor('aiFixture.state.props.messages.at(-1).agentStatus === "waiting-input" && Boolean(document.querySelector(".chat-message-content > :last-child .agent-task-reply textarea"))')
  await evaluate(`(() => { const input = document.querySelector('.chat-message-content > :last-child .agent-task-reply textarea'); input.value = '是，先只验证'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await click('.chat-message-content > :last-child .reply-plan-confirmations > summary')
  assert.equal(await evaluate('document.querySelector(".chat-message-content > :last-child .reply-plan-confirmations input").checked'), false)
  await click('.chat-message-content > :last-child .reply-plan-confirmations input')
  await evaluate(`document.querySelector('.chat-message-content > :last-child .agent-task-reply').scrollIntoView({ block: 'center', behavior: 'instant' })`)
  reasoningScreenshots.push(await screenshot('ai-task-reply-dark.png'))
  await click('.chat-message-content > :last-child .agent-task-reply button')
  await waitFor('aiFixture.runtime.requests.length === 1')
  assert.equal(await evaluate(`aiFixture.runtime.checkpoints.get(${JSON.stringify(waitingRunId)}).userInputs.length`), 2)
  assert.ok(await evaluate('aiFixture.runtime.requests[0].request.goal.includes("检查 A 环境") && aiFixture.runtime.requests[0].request.goal.includes("是，先只验证")'))
  assert.equal(await evaluate('JSON.parse(aiFixture.runtime.requests[0].request.taskContext).plan.version'), 2)
  assert.equal(await evaluate('JSON.parse(aiFixture.runtime.requests[0].request.taskContext).plan.items[0].status'), 'completed')
  assert.ok(await evaluate('JSON.parse(aiFixture.runtime.requests[0].request.taskContext).plan.items[0].userConfirmation.messageId'))
  assert.equal(await evaluate('aiFixture.runtime.commands.length'), 0)
  await evaluate('aiFixture.runtime.reply("检查完成")')
  await waitFor('!document.querySelector(".chat-activity")')
  await evaluate('aiFixture.reopen()')
  assert.equal(await evaluate('aiFixture.state.props.messages.at(-1).agentOutcome'), 'unverified')
  assert.equal(await evaluate('aiFixture.state.props.messages.at(-1).agentPlan.version'), 2)
  assert.ok(await evaluate('document.querySelector("[data-user-confirmation]").textContent.includes("用户确认")'))
  checks.push('Agent replies keep the same run and original goal; only explicitly checked plan items gain user confirmation and a new version, which survives reopening without becoming verified execution')

  await evaluate('aiFixture.beginRuntime("agent", { agentCommandTimeoutMs: 150 })')
  await evaluate(`(() => { const input = document.querySelector('.chat-composer textarea'); input.value = '等待长命令'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await click('.chat-send')
  await waitFor('aiFixture.runtime.requests.length === 1')
  await evaluate('aiFixture.runtime.reply("运行长命令", [{ id: "runtime-timeout", command: "printf waiting" }])')
  await waitFor('Boolean(document.querySelector("[data-step-id=runtime-timeout] .tool-step-decision"))')
  await click('[data-step-id="runtime-timeout"] .is-primary')
  await waitFor('document.querySelector(".chat-activity-stage").textContent.includes("等待超时处理")')
  assert.equal(await evaluate('document.querySelector("[data-step-id=runtime-timeout]").classList.contains("is-awaiting-decision")'), true)
  assert.equal(await evaluate('document.querySelector("[data-step-id=runtime-timeout] .tool-step-status").textContent'), '等待超时处理')
  assert.equal(await evaluate('getComputedStyle(document.querySelector("[data-step-id=runtime-timeout] .tool-step-state-icon")).animationName'), 'none', 'Waiting for a timeout decision stops the execution spinner')
  assert.equal(await evaluate('document.querySelector(".chat-activity-time").getAttribute("aria-live")'), 'off')
  await click('.chat-send')
  await waitFor('!document.querySelector(".chat-activity")')
  assert.ok(await evaluate('aiFixture.state.props.messages.at(-1).agentStatus === "stopped"'))
  assert.equal(await evaluate('aiFixture.state.props.messages.at(-1).agentSteps[0].startedAt'), undefined, 'Stopped command clocks are cleared')
  checks.push('Timeout decisions keep elapsed time visible and stopping clears active clocks')

  await evaluate('aiFixture.beginRuntime("agent")')
  await evaluate(`(() => { const input = document.querySelector('.chat-composer textarea'); input.value = '检查本地命令'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await click('.chat-send')
  await waitFor('aiFixture.runtime.requests.length === 1')
  await evaluate('aiFixture.runtime.reply("检查终端", [{ id: "returned-prompt", command: "printf ready" }])')
  await waitFor('Boolean(document.querySelector("[data-step-id=returned-prompt] .tool-step-decision"))')
  await click('[data-step-id="returned-prompt"] .is-primary')
  await waitFor('aiFixture.runtime.commands.length === 1')
  await evaluate(`aiFixture.runtime.finishCommand({ completionUnconfirmed: true, exitCode: undefined, output: "zsh: parse error near 'then'" })`)
  await waitFor('aiFixture.state.props.messages.at(-1).agentStatus === "stopped" && !document.querySelector(".chat-activity")')
  assert.match(await evaluate('aiFixture.state.props.messages.at(-1).stopReason'), /Shell 已返回提示符/)
  assert.equal(await evaluate('document.querySelector(".chat-send").getAttribute("aria-label")'), '发送')
  assert.equal(await evaluate('aiFixture.state.props.messages.at(-1).agentSteps[0].exitCode'), undefined)
  assert.equal(await evaluate('aiFixture.runtime.requests.length'), 0, 'No extra model turn or automatic command replay')
  assert.equal(await evaluate('aiFixture.runtime.commands.length'), 1)
  await evaluate('aiFixture.reopen()')
  assert.match(await evaluate('aiFixture.state.props.messages.at(-1).agentSteps[0].output'), /parse error near/)
  checks.push('A returned prompt with incomplete markers stops Agent activity immediately, preserves the parse error on reopen, and does not replay the command')

  await evaluate('aiFixture.beginRuntime("agent")')
  await evaluate(`(() => { const input = document.querySelector('.chat-composer textarea'); input.value = '检查复合命令'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await click('.chat-send')
  await waitFor('aiFixture.runtime.requests.length === 1')
  await evaluate('aiFixture.runtime.reply("查看日期", [{ id: "exact-first", command: "echo $(date)" }])')
  await waitFor('Boolean(document.querySelector("[data-step-id=exact-first] .tool-step-decision"))')
  assert.equal(await evaluate('Boolean(document.querySelector(".is-allow-exact"))'), false)
  await click('[data-step-id="exact-first"] .is-primary')
  await waitFor('Boolean(document.querySelector(".agent-risk-modal"))')
  await click('.agent-risk-modal .script-risk-actions button:last-child')
  await waitFor('aiFixture.runtime.commands.length === 1')
  await evaluate('aiFixture.runtime.finishCommand()')
  await waitFor('aiFixture.runtime.requests.length === 1')
  await evaluate('aiFixture.runtime.reply("再次查看", [{ id: "exact-second", command: "echo $(date)" }])')
  await waitFor('Boolean(document.querySelector("[data-step-id=exact-second] .tool-step-decision"))')
  assert.equal(await evaluate('aiFixture.runtime.commands.length'), 1, 'Same dynamic text still requires approval')
  assert.equal(await evaluate('Boolean(document.querySelector(".is-allow-exact"))'), false)
  await click('[data-step-id="exact-second"] .is-primary')
  await waitFor('Boolean(document.querySelector(".agent-risk-modal"))')
  await click('.agent-risk-modal .script-risk-actions button:last-child')
  await waitFor('aiFixture.runtime.commands.length === 2')
  await evaluate('aiFixture.runtime.finishCommand()')
  await waitFor('aiFixture.runtime.requests.length === 1')
  await evaluate('aiFixture.runtime.reply("检查完成")')
  await waitFor('!document.querySelector(".chat-activity")')
  assert.equal(await evaluate('Boolean(document.querySelector(".chat-session-grants"))'), false)
  checks.push('Dynamic commands require review each time and cannot create exact session grants')

  for (const mode of ['chat', 'agent']) {
    await evaluate(`aiFixture.beginRuntime('${mode}')`)
    await evaluate(`(() => { const input = document.querySelector('.chat-composer textarea'); input.value = '检查思考与正文分离'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    await click('.chat-send')
    await waitFor('aiFixture.runtime.requests.length === 1')
    await evaluate('aiFixture.runtime.stream("reasoning", "**独立推理内容**")')
    await evaluate('aiFixture.runtime.stream("chunk", "正常回复：**正文内容**")')
    const fold = '.chat-message-content > :last-child .chat-reasoning'
    await waitFor(`Boolean(document.querySelector('${fold}')) && document.querySelector('.chat-message-content > :last-child').innerText.includes('正文内容')`)
    assert.equal(await evaluate(`document.querySelector('${fold}').open`), false)
    assert.equal(await evaluate(`Boolean(document.querySelector('${fold} .chat-markdown'))`), false, 'Collapsed reasoning does not parse hidden Markdown')
    assert.ok(!await evaluate(`document.querySelector('.chat-message-content > :last-child').innerText.includes('独立推理内容')`))
    await click(`${fold} summary`)
    await waitFor(`document.querySelector('${fold} strong')?.textContent === '独立推理内容'`)
    await evaluate('aiFixture.runtime.reply("正常回复：**正文内容**")')
    await waitFor('!document.querySelector(".chat-activity")')
    assert.equal(await evaluate('aiFixture.state.props.messages.at(-1).text'), '正常回复：**正文内容**')
    if (mode === 'agent') {
      assert.equal(await evaluate('document.querySelector(".chat-message-content > :last-child .agent-work-toggle").getAttribute("aria-expanded")'), 'false')
      await click('.chat-message-content > :last-child .agent-work-toggle')
    } else {
      assert.equal(await evaluate(`document.querySelector('${fold}').open`), true, 'Completing a chat reply preserves a manual reasoning expansion')
    }
    await evaluate('aiFixture.reopen()')
    if (mode === 'agent') await click('.chat-message-content > :last-child .agent-work-toggle')
    assert.equal(await evaluate(`document.querySelector('${fold}').open`), false, 'Reload defaults to folded reasoning')
    await evaluate('document.querySelector(".chat-message-content > :last-child").scrollIntoView({ block: "end", behavior: "instant" })')
    reasoningScreenshots.push(await screenshot(`ai-${mode}-reasoning-folded.png`))
    await click(`${fold} summary`)
    await waitFor(`document.querySelector('${fold} strong')?.textContent === '独立推理内容'`)
  }
  checks.push('Chat and Agent keep reasoning folded separately from the visible answer, including after reload')

  for (const mode of ['auto', 'selection', 'none']) {
    for (const kind of ['chat', 'agent']) {
      await evaluate(`aiFixture.beginRuntime('${kind}', {
        terminalSnapshot: 'FULL_TERMINAL_OUTPUT',
        commandHistory: [{ command: 'uptime' }],
        terminalSelection: { terminalId: 'fixture-terminal', text: 'SELECTED_OUTPUT', startLine: 1, endLine: 2 }
      })`)
      await click('.chat-terminal-context .composer-select-trigger')
      await click(`.chat-terminal-context [data-value="${mode}"]`)
      await waitFor(`document.querySelector('.chat-context-toggle').textContent.includes('${mode === 'auto' ? 35 : mode === 'selection' ? 15 : 0} 字符')`)
      assert.equal(await evaluate('Boolean(document.querySelector(".chat-selection"))'), mode !== 'none')
      await evaluate(`(() => { const input = document.querySelector('.chat-composer textarea'); input.value = '检查运行状态'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
      await click('.chat-send')
      await waitFor('aiFixture.runtime.requests.length === 1')
      const request = await evaluate('aiFixture.runtime.requests[0].request')
      assert.equal(request.terminalSnapshot, mode === 'auto' ? 'FULL_TERMINAL_OUTPUT' : '')
      assert.deepEqual(request.commandHistory, mode === 'auto' ? ['uptime'] : [])
      assert.equal((request.question ?? request.goal).includes('SELECTED_OUTPUT'), mode !== 'none')
      assert.equal(await evaluate('document.querySelector(".chat-terminal-context .composer-select-trigger").disabled'), true)
      await evaluate('aiFixture.runtime.reply("检查完成")')
      await waitFor('!document.querySelector(".chat-activity")')
      await evaluate('aiFixture.reopen()')
      await click('.chat-terminal-context .composer-select-trigger')
      assert.equal(await evaluate('document.querySelector(".chat-terminal-context [aria-selected=true]").dataset.value'), mode)
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    }
  }
  await click('.chat-terminal-context .composer-select-trigger')
  await click('.chat-terminal-context [data-value="auto"]')
  checks.push('Terminal context choices filter chat and Agent requests, update counts and survive reopening')

  await evaluate('aiFixture.configure({ theme: "light", width: 360, zoom: 1.25 })')
  await click('.chat-terminal-context .composer-select-trigger')
  const contextMenuScreenshot = await screenshot('ai-context-menu.png')
  const menuBounds = await evaluate(`(() => {
    const menu = document.querySelector('.composer-select-menu').getBoundingClientRect();
    const panel = document.querySelector('.assistant-panel').getBoundingClientRect();
    return { left: menu.left >= panel.left, right: menu.right <= panel.right, top: menu.top >= panel.top };
  })()`)
  assert.deepEqual(menuBounds, { left: true, right: true, top: true })
  await evaluate(`(() => {
    const config = aiFixture.state.props.config;
    aiFixture.state.props.configs = [config, { ...config, id: 'backup-config', model: 'alternative-model' }];
  })()`)
  await click('.chat-config-select .composer-select-trigger')
  assert.equal(await evaluate('document.querySelectorAll(".composer-select-menu").length'), 1)
  const configMenuScreenshot = await screenshot('ai-config-menu.png')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  assert.equal(await evaluate('document.activeElement.matches(".chat-config-select .composer-select-trigger")'), true)
  assert.equal(await evaluate('document.querySelectorAll(".composer-select-menu").length'), 0)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 })
  await waitFor('document.activeElement.matches(".chat-config-select [role=option]")')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 })
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await waitFor('aiFixture.state.props.selectedConfigId === "backup-config"')
  assert.ok(await evaluate('document.querySelector(".chat-config-select .composer-select-trigger").textContent.includes("backup-config")'))
  checks.push('Composer menus share styling, fit a narrow panel and restore focus on Escape')

  assert.deepEqual(exceptions, [], 'Uncaught browser exceptions')
  await evaluate('aiFixture.beginRuntime("agent")')
  await evaluate('aiFixture.installFileTools(false)')
  await evaluate(`(() => { const input = document.querySelector('.chat-composer textarea'); input.value = '读取日志'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await click('.chat-send')
  await waitFor('aiFixture.runtime.requests.length === 1')
  await evaluate(`aiFixture.runtime.reply('读取日志', [{ id: 'file-read', name: 'read_file', arguments: JSON.stringify({ path: '/workspace/log with space.txt' }) }])`)
  await waitFor('aiFixture.fileRecords.reads === 1 && aiFixture.runtime.requests.length === 1')
  await evaluate('aiFixture.runtime.reply("已读取文件")')
  await waitFor('aiFixture.state.props.messages.at(-1).agentStatus === "done"')
  await click('.chat-message-content > :last-child .agent-work-toggle')
  await waitFor('document.querySelector("[data-step-id=file-read]")?.dataset.status === "completed"')
  assert.equal(await evaluate('aiFixture.runtime.commands.length'), 0, 'File tool never enters the shell-command runner')
  await click('[data-step-id=file-read] .file-tool-heading')
  await click('[data-step-id=file-read] .tool-step-details')
  assert.ok(await evaluate('document.querySelector(".agent-detail-dialog").textContent.includes("文件读取结果")'))
  assert.ok(await evaluate('document.querySelector(".agent-detail-section[data-kind=command]").textContent.includes("路径和范围")'))
  await click('.agent-detail-dialog button[aria-label="关闭"]')
  await evaluate('aiFixture.beginRuntime("agent")')
  await evaluate('aiFixture.installFileTools(true)')
  await evaluate('aiFixture.configure({ theme: "dark", zoom: 1.25, width: 360 })')
  await evaluate(`(() => { const input = document.querySelector('.chat-composer textarea'); input.value = '读取私有配置'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await click('.chat-send')
  await waitFor('aiFixture.runtime.requests.length === 1')
  await evaluate(`aiFixture.runtime.reply('读取私有配置', [{ id: 'file-secret', name: 'read_file', arguments: JSON.stringify({ path: '/workspace/long directory name/another long directory/.env' }) }])`)
  await waitFor('Boolean(document.querySelector("[data-step-id=file-secret] .file-tool-actions"))')
  assert.equal(await evaluate('aiFixture.fileRecords.reads'), 0, 'Sensitive file is not read before approval')
  assert.ok(await evaluate('document.querySelector("[data-step-id=file-secret]").textContent.includes("当前 AI 模型")'))
  assert.equal(await evaluate('Boolean(document.querySelector("[data-step-id=file-secret] .is-allow"))'), false)
  assert.ok(await evaluate('(() => { const card = document.querySelector("[data-step-id=file-secret]"); return card.scrollWidth <= card.clientWidth + 1 })()'), 'Long file paths fit the narrow card')
  const fileToolScreenshot = await screenshot('ai-file-sensitive-dark-360.png')
  await click('[data-step-id=file-secret] .file-tool-actions button:first-child')
  await waitFor('aiFixture.fileRecords.reads === 1 && aiFixture.runtime.requests.length === 1')
  await evaluate('aiFixture.runtime.reply("读取完成")')
  await waitFor('aiFixture.state.props.messages.at(-1).agentStatus === "done"')
  assert.equal(await evaluate('aiFixture.fileRecords.approvals'), 1)
  assert.equal(await evaluate('aiFixture.state.props.messages.at(-1).payloadJson.includes("FIXTURE_PRIVATE_FILE_VALUE")'), false)
  await evaluate('aiFixture.reopen()')
  assert.equal(await evaluate('aiFixture.state.props.messages.at(-1).agentSteps[0].fileResult.redacted'), true)
  checks.push('Typed file steps show paths and ranges, require individual sensitive approval, fit narrow dark panels, and redact persisted content')
  await evaluate('aiFixture.beginRuntime("agent")')
  await evaluate('aiFixture.installSshTasks()')
  await evaluate(`(() => { const input = document.querySelector('.chat-composer textarea'); input.value = '独立登录环境检查'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await click('.chat-send')
  await waitFor('aiFixture.runtime.requests.length === 1')
  assert.equal(await evaluate('aiFixture.runtime.requests[0].request.sshTasks'), true)
  await evaluate(`aiFixture.runtime.reply('独立登录环境检查', [{ id: 'ssh-read', name: 'run_ssh_task', arguments: JSON.stringify({ command: 'printf hello', workingDirectory: '/srv/app with spaces', environment: { TOKEN: 'FIXTURE_SECRET_ENV' } }) }])`)
  await waitFor('Boolean(document.querySelector("[data-step-id=ssh-read] .ssh-task-context"))')
  assert.equal(await evaluate('aiFixture.sshRecords.starts'), 0)
  assert.ok(await evaluate('document.querySelector("[data-step-id=ssh-read]").textContent.includes("deploy@ssh.fixture.invalid:22")'))
  assert.equal(await evaluate('Boolean(document.querySelector("[data-step-id=ssh-read] .is-allow, [data-step-id=ssh-read] .is-allow-exact"))'), false)
  await click('[data-step-id=ssh-read] .tool-step-decision .is-primary')
  await waitFor('Boolean(document.querySelector(".agent-risk-modal .ssh-task-context"))')
  assert.ok(await evaluate('document.querySelector(".agent-risk-modal").textContent.includes("/srv/app with spaces")'))
  assert.ok(await evaluate('document.querySelector(".agent-risk-modal .ssh-task-context").textContent.includes("FIXTURE_SECRET_ENV")'))
  const sshTaskScreenshot = await screenshot('ai-ssh-task-review-dark-360.png')
  await click('.agent-risk-modal .modal-actions > button:last-child')
  await waitFor('aiFixture.sshRecords.starts === 1')
  assert.equal(await evaluate('aiFixture.sshRecords.approvals'), 1)
  await click('[data-step-id=ssh-read] .tool-step-details')
  assert.ok(await evaluate('document.querySelector(".agent-detail-section[data-kind=stdout]").textContent.includes("streamed stdout")'))
  assert.ok(await evaluate('document.querySelector(".agent-detail-section[data-kind=stderr]").textContent.includes("streamed stderr")'))
  await click('.agent-detail-dialog button[aria-label="关闭"]')
  await evaluate('aiFixture.sshRecords.finish()')
  await waitFor('aiFixture.runtime.requests.length === 1')
  await evaluate('aiFixture.runtime.reply("检查已完成")')
  await waitFor('aiFixture.state.props.messages.at(-1).agentStatus === "done"')
  assert.equal(await evaluate('aiFixture.runtime.commands.length'), 0)
  assert.equal(await evaluate('aiFixture.state.props.messages.at(-1).payloadJson.includes("FIXTURE_SECRET_ENV")'), false)
  assert.equal(await evaluate('aiFixture.state.props.messages.at(-1).payloadJson.includes("streamed stdout")'), false)
  await evaluate('aiFixture.reopen()')
  assert.equal(await evaluate('aiFixture.state.props.messages.at(-1).agentSteps[0].sshTarget.user'), 'deploy')
  await evaluate('aiFixture.beginRuntime("agent")')
  await evaluate('aiFixture.installSshTasks()')
  await evaluate(`(() => { const input = document.querySelector('.chat-composer textarea'); input.value = '独立长任务'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await click('.chat-send')
  await waitFor('aiFixture.runtime.requests.length === 1')
  await evaluate(`aiFixture.runtime.reply('独立长任务', [{ id: 'ssh-stop', name: 'run_ssh_task', arguments: JSON.stringify({ command: 'sleep 10', workingDirectory: '/tmp' }) }])`)
  await waitFor('Boolean(document.querySelector("[data-step-id=ssh-stop] .tool-step-decision .is-primary"))')
  await click('[data-step-id=ssh-stop] .tool-step-decision .is-primary')
  await waitFor('aiFixture.sshRecords.starts === 1')
  await waitFor('Boolean(document.querySelector("[data-step-id=ssh-stop] button[aria-label=停止观察独立任务]"))')
  await evaluate('Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))')
  await click('[data-step-id=ssh-stop] button[aria-label="停止观察独立任务"]')
  await waitFor('aiFixture.state.props.messages.at(-1).agentStatus === "stopped"')
  assert.equal(await evaluate('aiFixture.sshRecords.stops'), 1)
  assert.ok(await evaluate('aiFixture.state.props.messages.at(-1).stopReason.includes("远端")'))
  assert.equal(await evaluate('aiFixture.runtime.commands.length'), 0)
  checks.push('Independent SSH review shows login scope, directory and environment; streams stay separate; sensitive history is redacted; stopping observation never claims process termination')
  await evaluate('aiFixture.beginRuntime("agent", { agentBuiltinReadonlyEnabled: true })')
  await evaluate(`(() => { const input = document.querySelector('.chat-composer textarea'); input.value = '检查服务并验证响应'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await click('.chat-send')
  await waitFor('aiFixture.runtime.requests.length === 1')
  assert.equal(await evaluate('aiFixture.runtime.requests[0].request.taskTools'), true)
  await evaluate(`aiFixture.runtime.reply('安排检查', [{ id: 'plan', name: 'update_plan', arguments: JSON.stringify({ expectedVersion: 0, reason: '先检查实际响应', items: [{ id: 'health', description: '检查服务健康状态', status: 'in-progress', stepIds: [] }] }) }])`)
  await waitFor('Boolean(document.querySelector("[data-plan-id=health]")) && aiFixture.runtime.requests.length === 1')
  assert.equal(await evaluate('JSON.parse(aiFixture.runtime.requests[0].request.taskContext).plan.version'), 1)
  await evaluate(`aiFixture.runtime.reply('检查响应', [{ id: 'health', command: 'printf health' }])`)
  await waitFor('Boolean(document.querySelector("[data-step-id=health] .tool-step-decision .is-primary"))')
  await click('[data-step-id=health] .tool-step-decision .is-primary')
  await waitFor('aiFixture.runtime.pendingCommands.length === 1')
  await evaluate('aiFixture.runtime.finishCommand({ output: "HTTP 503 unhealthy", exitCode: 0 })')
  await waitFor('aiFixture.runtime.requests.length === 1')
  await evaluate(`aiFixture.runtime.reply('核对预期响应', [{ id: 'verify', name: 'record_verification', arguments: JSON.stringify({ id: 'service-health', purpose: '服务应返回 HTTP 200', required: true, check: { kind: 'output-contains', expected: 'HTTP 200', stepId: 'health' } }) }])`)
  await waitFor('document.querySelector("[data-verification-id=service-health]")?.dataset.verificationStatus === "failed" && aiFixture.runtime.requests.length === 1')
  await evaluate('aiFixture.runtime.reply("服务尚未恢复，请继续检查配置。")')
  await waitFor('aiFixture.state.props.messages.at(-1).agentStatus === "done"')
  assert.equal(await evaluate('aiFixture.state.props.messages.at(-1).agentOutcome'), 'verification-failed')
  await click('[data-verification-id=service-health] > summary')
  assert.ok(await evaluate('document.querySelector("[data-verification-id=service-health]").textContent.includes("HTTP 503 unhealthy")'))
  await click('[data-verification-id=service-health] .tool-step-details')
  assert.ok(await evaluate('document.querySelector(".agent-detail-dialog").textContent.includes("验证依据")'))
  await click('.agent-detail-dialog button[aria-label="关闭"]')
  await waitFor('!document.querySelector(".agent-detail-dialog")')
  const taskProgressScreenshot = await screenshot('ai-task-verification-failed-dark-360.png')
  await evaluate('aiFixture.reopen()')
  assert.equal(await evaluate('aiFixture.state.props.messages.at(-1).agentOutcome'), 'verification-failed')
  assert.equal(await evaluate('aiFixture.state.props.messages.at(-1).agentPlan.version'), 1)
  checks.push('Task plans survive model rounds and reopening; an exit-zero health command with HTTP 503 shows verification failure linked to its actual output')
  await evaluate('aiFixture.beginRuntime("agent")')
  await evaluate(`(() => { const input = document.querySelector('.chat-composer textarea'); input.value = '检查当前配置，正常则无需修改和重载'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await click('.chat-send')
  await waitFor('aiFixture.runtime.requests.length === 1')
  await evaluate(`aiFixture.runtime.reply('先检查当前状态', [{ id: 'scope-plan', name: 'update_plan', arguments: JSON.stringify({ expectedVersion: 0, reason: '先检查，再决定是否修改', items: [
    { id: 'inspect', description: '检查响应', status: 'in-progress', stepIds: [] },
    { id: 'edit', description: '必要时修改配置', status: 'pending', stepIds: [] },
    { id: 'reload', description: '修改后重载', status: 'pending', stepIds: [] }
  ] }) }])`)
  await waitFor('aiFixture.runtime.requests.length === 1')
  await evaluate(`aiFixture.runtime.reply('检查当前响应', [{ id: 'scope-health', command: 'printf health' }])`)
  await waitFor('Boolean(document.querySelector("[data-step-id=scope-health] .tool-step-decision .is-primary"))')
  await click('[data-step-id=scope-health] .tool-step-decision .is-primary')
  await waitFor('aiFixture.runtime.pendingCommands.length === 1')
  await evaluate('aiFixture.runtime.finishCommand({ output: "HTTP 200 healthy", exitCode: 0 })')
  await waitFor('aiFixture.runtime.requests.length === 1')
  await evaluate(`aiFixture.runtime.reply('当前状态符合预期，无需修改', [
    { id: 'scope-check', name: 'record_verification', arguments: JSON.stringify({ id: 'current-health', purpose: '当前响应正常', required: true, check: { kind: 'output-contains', expected: 'HTTP 200', stepId: 'scope-health' } }) },
    { id: 'scope-close', name: 'update_plan', arguments: JSON.stringify({ expectedVersion: 1, reason: '当前响应正常，取消修改并跳过重载', items: [
      { id: 'inspect', description: '检查响应', status: 'completed', stepIds: ['scope-health'] },
      { id: 'edit', description: '必要时修改配置', status: 'cancelled', stepIds: [] },
      { id: 'reload', description: '修改后重载', status: 'skipped', stepIds: [] }
    ] }) }
  ])`)
  await waitFor('aiFixture.runtime.requests.length === 1 && aiFixture.state.props.messages.at(-1).agentPlan.version === 2')
  await evaluate('aiFixture.runtime.reply("已核对当前响应，无需修改或重载。")')
  await waitFor('aiFixture.state.props.messages.at(-1).agentStatus === "done"')
  await evaluate('aiFixture.reopen()')
  assert.equal(await evaluate('aiFixture.state.props.messages.at(-1).agentOutcome'), 'verified')
  assert.equal(await evaluate('aiFixture.runtime.commands.length'), 1)
  assert.match(await evaluate('document.querySelector(".task-plan > summary").textContent'), /已完成 1 · 剩余 0 · 跳过 1 · 取消 1/)
  await click('.task-plan > summary')
  assert.equal(await evaluate('document.querySelector("[data-plan-id=edit]").dataset.planStatus'), 'cancelled')
  assert.equal(await evaluate('document.querySelector("[data-plan-id=reload]").dataset.planStatus'), 'skipped')
  const adjustedPlanScreenshot = await screenshot('ai-task-adjusted-plan-dark-360.png')
  checks.push('Adjusted plans retain cancellation/skipping separately from completion, show zero remaining work and require actual verification evidence after reopening')
  await evaluate('aiFixture.beginRuntime("agent")')
  await evaluate('aiFixture.installFileEdits({ failure: 2 })')
  await evaluate(`(() => { const input = document.querySelector('.chat-composer textarea'); input.value = '修改三个配置文件'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await click('.chat-send')
  await waitFor('aiFixture.runtime.requests.length === 1')
  assert.equal(await evaluate('aiFixture.runtime.requests[0].request.fileEdits'), true)
  await evaluate(`aiFixture.runtime.reply('完整读取基线', ['/workspace/config-one.txt', '/workspace/config-two.txt', '/workspace/config-three.txt'].map((path, index) => ({ id: 'edit-read-' + index, name: 'read_file', arguments: JSON.stringify({ path }) })))`)
  await waitFor('aiFixture.editRecords.reads === 3 && aiFixture.runtime.requests.length === 1')
  await evaluate(`aiFixture.runtime.reply('拟议配置修改', [{ id: 'edit-batch', name: 'apply_patch', arguments: JSON.stringify({ reason: '修改三个配置文件', files: aiFixture.editRecords.latestBaselines.map(baselineId => ({ baselineId, replacements: [{ oldText: 'before', newText: 'after' }] })) }) }])`)
  await waitFor('Boolean(document.querySelector("[data-step-id=edit-batch] .file-edit-actions .is-primary"))')
  assert.equal(await evaluate('aiFixture.editRecords.writes'), 0)
  assert.equal(await evaluate('document.querySelectorAll("[data-step-id=edit-batch] .file-edit-patch").length'), 3)
  assert.equal(await evaluate('Boolean(document.querySelector(".chat-message-content > :last-child .agent-file-changes"))'), false, 'Unapproved proposals do not appear as task file changes')
  assert.ok(await evaluate('document.querySelector("[data-step-id=edit-batch] .file-edit-patch").textContent.includes("-before") && document.querySelector("[data-step-id=edit-batch] .file-edit-patch").textContent.includes("+after")'))
  assert.ok(await evaluate('(() => { const card = document.querySelector("[data-step-id=edit-batch]"); return card.scrollWidth <= card.clientWidth + 1 })()'))
  await evaluate('document.querySelector("[data-step-id=edit-batch]").scrollIntoView({ block: "start", behavior: "instant" })')
  const fileEditScreenshot = await screenshot('ai-file-edit-review-dark-360.png')
  await click('[data-step-id=edit-batch] .file-edit-actions .is-primary')
  await waitFor('aiFixture.editRecords.writes === 2 && aiFixture.runtime.requests.length === 1')
  assert.deepEqual(await evaluate('aiFixture.state.props.messages.at(-1).agentSteps.at(-1).fileEdits.map(item => item.status)'), ['applied', 'conflict', 'not-started'])
  assert.equal(await evaluate('aiFixture.state.props.messages.at(-1).streaming'), true)
  assert.equal(await evaluate('document.querySelectorAll(".chat-message-content > :last-child .agent-file-row").length'), 1, 'Applied files appear while the task is still running; conflicts and unstarted files are excluded')
  assert.equal(await evaluate('document.querySelector(".chat-message-content > :last-child .agent-files-stats").textContent'), '+1−1')
  await evaluate('aiFixture.runtime.reply("第一个文件已写入，第二个文件存在冲突，第三个未开始。")')
  await waitFor('aiFixture.state.props.messages.at(-1).agentStatus === "done"')
  await evaluate('aiFixture.reopen()')
  assert.equal(await evaluate('document.querySelectorAll(".chat-message-content > :last-child .agent-file-row").length'), 1)
  await click('.chat-message-content > :last-child .agent-file-row')
  assert.equal(await evaluate('document.querySelector(".agent-diff-dialog .diff-remove .diff-code").textContent.trim()'), 'before')
  assert.equal(await evaluate('document.querySelector(".agent-diff-dialog .diff-add .diff-code").textContent.trim()'), 'after')
  await click('.agent-diff-footer .agent-diff-action')
  await waitFor('Boolean(document.querySelector("[data-step-id=edit-batch] .file-edit-item .file-edit-action"))')
  await click('[data-step-id=edit-batch] .file-edit-item .file-edit-action')
  await waitFor('Boolean(document.querySelector("[data-tool=restore_file] .file-edit-actions .is-primary"))')
  assert.equal(await evaluate('aiFixture.runtime.requests.length'), 0, 'Restore button does not ask the model to choose an operation')
  assert.ok(await evaluate('document.querySelector("[data-tool=restore_file] .file-edit-patch").textContent.includes("+before")'))
  await click('[data-tool=restore_file] .file-edit-actions .is-primary')
  await waitFor('aiFixture.state.props.messages.at(-1).agentStatus === "done" && aiFixture.editRecords.writes === 3')
  assert.equal(await evaluate('aiFixture.editRecords.contents["/workspace/config-one.txt"]'), 'before\r\n')
  await evaluate('aiFixture.editRecords.contents["/workspace/config-one.txt"] = "external edit"')
  await click('[data-step-id=edit-batch] .file-edit-item .file-edit-action')
  await waitFor('aiFixture.state.props.messages.at(-1).agentStatus === "error"')
  assert.equal(await evaluate('aiFixture.editRecords.writes'), 3, 'Restore conflict does not overwrite an external edit')
  assert.ok(await evaluate('JSON.stringify(aiFixture.state.props.messages.at(-1)).includes("恢复存在冲突")'))
  checks.push('File edits show exact proposed differences at narrow width, preserve partial batch results through reopening, restore after a fresh read and approval, and refuse restoration over external edits')

  await evaluate('aiFixture.beginRuntime("agent")')
  await evaluate('aiFixture.installFileEdits({ sensitive: true })')
  await evaluate(`(() => { const input = document.querySelector('.chat-composer textarea'); input.value = '修改私有配置'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await click('.chat-send')
  await waitFor('aiFixture.runtime.requests.length === 1')
  await evaluate(`aiFixture.runtime.reply('读取私有配置', [{ id: 'private-edit-read', name: 'read_file', arguments: JSON.stringify({ path: '/workspace/config-one.txt' }) }])`)
  await waitFor('Boolean(document.querySelector("[data-step-id=private-edit-read] .file-tool-actions"))')
  await click('[data-step-id=private-edit-read] .file-tool-actions button:first-child')
  await waitFor('aiFixture.editRecords.reads === 1 && aiFixture.runtime.requests.length === 1')
  await evaluate(`aiFixture.runtime.reply('修改私有配置', [{ id: 'private-edit', name: 'write_file', arguments: JSON.stringify({ files: [{ baselineId: aiFixture.editRecords.latestBaselines[0], content: 'EDIT_PRIVATE_AFTER' }] }) }])`)
  await waitFor('Boolean(document.querySelector("[data-step-id=private-edit] .file-edit-actions .is-primary"))')
  assert.ok(await evaluate('document.querySelector("[data-step-id=private-edit] .file-edit-patch").textContent.includes("EDIT_PRIVATE_BEFORE")'))
  await click('[data-step-id=private-edit] .file-edit-actions .is-primary')
  await waitFor('aiFixture.editRecords.writes === 1 && aiFixture.runtime.requests.length === 1')
  await evaluate('aiFixture.runtime.reply("修改完成")')
  await waitFor('aiFixture.state.props.messages.at(-1).agentStatus === "done"')
  assert.equal(await evaluate('aiFixture.state.props.messages.at(-1).payloadJson.includes("EDIT_PRIVATE_")'), false)
  await evaluate('aiFixture.reopen()')
  assert.equal(await evaluate('JSON.stringify(aiFixture.state.props.messages.at(-1)).includes("EDIT_PRIVATE_")'), false)
  assert.equal(await evaluate('Boolean(document.querySelector(".chat-message-content > :last-child .agent-file-row"))'), true)
  assert.equal(await evaluate('Boolean(document.querySelector(".chat-message-content > :last-child .agent-files-stats"))'), false, 'Redacted file edits do not fabricate diff counts')
  checks.push('Sensitive file edit previews are available for the live approval and are removed from persisted history')
  assert.deepEqual(exceptions, [], 'Uncaught browser exceptions after file and SSH workflows')
  const checkpointEvidence = await evaluate(`(() => {
    const records = aiFixture.runtime.checkpointEvents;
    return { before: records.some(record => record.boundary === 'before-dispatch'), result: records.some(record => record.boundary === 'result'), sensitive: JSON.stringify([...aiFixture.runtime.checkpoints.values()]).includes('EDIT_PRIVATE_') };
  })()`)
  assert.equal(checkpointEvidence.before, true)
  assert.equal(checkpointEvidence.result, true)
  assert.equal(checkpointEvidence.sensitive, false)
  await evaluate(`(() => {
    const record = structuredClone([...aiFixture.runtime.checkpoints.values()][0]);
    record.runId = 'restart-fixture'; record.goal = '重启后核对服务状态'; record.state.status = 'executing'; record.boundary = 'before-dispatch';
    record.state.steps = [{ id: 'uncertain-write', toolName: 'run_command', command: 'fixture interrupted command', reason: '派发后未收到结果', sensitive: false, status: 'running', executionPhase: 'dispatching', output: null, exitCode: null, fileEdits: [] }];
    aiFixture.runtime.checkpoints.set(record.runId, record);
    aiFixture.state.panelVersion++;
  })()`)
  await waitFor("document.querySelector('[data-run-id=restart-fixture]')")
  await click('.agent-interrupted-runs > details > summary')
  await click('[data-run-id=restart-fixture] > summary')
  const interrupted = await evaluate("document.querySelector('[data-run-id=restart-fixture]').textContent")
  assert.match(interrupted, /效果未知，需核对/)
  assert.equal(await evaluate('aiFixture.runtime.requests.length'), 0)
  await evaluate("document.querySelector('[data-run-id=restart-fixture]').scrollIntoView({ block: 'start' })")
  const interruptedScreenshot = await screenshot('ai-interrupted-task-dark-360.png')
  checks.push('Durable checkpoint wiring stores dispatch/result boundaries without secrets; reopening discovers unfinished tasks and shows uncertain effects without model requests or replay')

  await evaluate("aiFixture.state.props.agentBuiltinReadonlyEnabled = true")
  const beforeRecoveryCommands = await evaluate('aiFixture.runtime.commands.length')
  await click('[data-run-id=restart-fixture] > button')
  await waitFor('aiFixture.runtime.requests.length === 1')
  assert.equal(await evaluate('aiFixture.runtime.requests[0].request.goal'), '重启后核对服务状态')
  await evaluate('aiFixture.runtime.reply("先核对当前账号", [{ id: "recovery-check", command: "whoami" }])')
  await waitFor('aiFixture.runtime.pendingCommands.length === 1')
  await evaluate('aiFixture.runtime.finishCommand({ output: "1000", exitCode: 0 })')
  await waitFor('aiFixture.runtime.requests.length === 1')
  await evaluate('aiFixture.runtime.reply("当前账号与原任务一致，需要确认后继续原始目标。")')
  await waitFor('Boolean(document.querySelector(".agent-recovery-review"))')
  assert.equal(await evaluate('aiFixture.runtime.commands.length'), beforeRecoveryCommands + 1)
  assert.equal(await evaluate('document.querySelector(".recovery-actions .chat-button").disabled'), true)
  await click('.chat-activity-jump')
  assert.equal(await evaluate('Boolean(document.activeElement.closest(".agent-recovery-review"))'), true)
  await evaluate(`(() => {
    const select = document.querySelector('.recovery-requirement select');
    [...select.options].forEach(option => option.selected = option.value === 'recovery-check'); select.dispatchEvent(new Event('change', { bubbles: true }));
    const observation = document.querySelector('.recovery-requirement textarea'); observation.value = '已核对账号和当前状态，继续未完成事项'; observation.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await click('.recovery-target input')
  await waitFor('!document.querySelector(".recovery-actions .chat-button").disabled')
  const recoveryScreenshot = await screenshot('ai-recovery-review-dark-360.png')
  await click('.recovery-actions .chat-button')
  await waitFor('aiFixture.runtime.requests.length === 1')
  assert.equal(await evaluate('JSON.parse(aiFixture.runtime.requests[0].request.taskContext).recovery.phase'), 'continuing')
  await evaluate('aiFixture.runtime.reply("继续核验", [{ id: "recovery-next", command: "whoami" }])')
  await waitFor('Boolean(document.querySelector("[data-step-id=recovery-next] .tool-step-decision .is-primary"))')
  assert.equal(await evaluate('aiFixture.runtime.commands.length'), beforeRecoveryCommands + 1)
  await click('[data-step-id=recovery-next] .tool-step-decision .is-primary')
  await waitFor('aiFixture.runtime.pendingCommands.length === 1')
  await evaluate('aiFixture.runtime.finishCommand({ output: "1000", exitCode: 0 })')
  await waitFor('aiFixture.runtime.requests.length === 1')
  await evaluate('aiFixture.runtime.reply("已根据当前现场继续检查。")')
  await waitFor('aiFixture.runtime.checkpoints.get("restart-fixture").state.status === "done"')
  assert.equal(await evaluate('aiFixture.runtime.checkpoints.get("restart-fixture").state.steps[0].exitCode'), null)
  assert.equal(await evaluate('aiFixture.runtime.checkpointEvents.some(record => record.boundary === "resumed")'), true)
  await evaluate('aiFixture.reopen()')
  assert.equal(await evaluate('document.querySelector(".agent-recovery-history").textContent.includes("已核对账号和当前状态")'), true)
  assert.deepEqual(exceptions, [], 'No browser errors in recovery and rehydration')
  checks.push('Recovery keeps the original goal and unknown result, waits for new evidence and target confirmation, then asks for fresh approval even for a built-in read-only command')

  await evaluate(`(() => {
    const report = Array.from({ length: 66 }, (_, i) => '报告第 ' + (i + 1) + ' 行').join('\\n') + '\\n';
    const path = '/root/kernel-vuln-report.md';
    const payload = { mode: 'agent', agentStatus: 'done', agentSteps: [{ id: 'historical-write', toolName: 'write_file', command: '', reason: '写入报告', risks: [], sensitive: false, status: 'completed', executionPhase: 'finished', fileEdits: [{ status: 'applied', changeId: 'historical-change', view: { provider: 'current-terminal', writeStrategy: 'create-exclusive', path, resolvedPath: path, environmentScope: 'a'.repeat(64), revision: null, before: null, after: report, sensitive: false, restoreOf: null, restoreAttributes: null }, outcome: { status: 'applied', revision: 'verified', contentHash: 'verified', beforeAttributes: null, afterAttributes: null, error: null } }] }] };
    aiFixture.state.props.messages = [{ ...aiFixture.messages.find(message => message.id === 'completed'), id: 'historical-report', text: '文档已写好，共 66 行。', payloadJson: JSON.stringify(payload) }];
  })()`)
  await evaluate('aiFixture.reopen()')
  assert.equal(await evaluate('aiFixture.state.props.messages[0].agentFileChanges'), undefined)
  assert.equal(await evaluate('document.querySelector(".agent-files-stats").textContent'), '+66−0')
  assert.match(await evaluate('document.querySelector(".agent-file-row").textContent'), /kernel-vuln-report\.md.*新建/s)
  reasoningScreenshots.push(await screenshot('ai-file-edit-history-summary-dark-360.png'))
  await click('.agent-file-row')
  assert.equal(await evaluate('document.querySelectorAll(".agent-diff-dialog .diff-add").length'), 66)
  await click('.agent-diff-footer .agent-diff-action')
  await waitFor('Boolean(document.querySelector("[data-step-id=historical-write] .file-edit-body"))')
  assert.equal(await evaluate('document.activeElement === document.querySelector("[data-step-id=historical-write] .file-edit-heading")'), true)
  assert.equal(await evaluate('document.querySelector("[data-step-id=historical-write] .file-edit-heading").getAttribute("aria-expanded")'), 'true')
  checks.push('Historical write_file receipts show the created report and +66/−0 without command snapshots, and diff links expand and focus the file edit record')
  assert.deepEqual(exceptions, [], 'No browser errors in historical file summaries')

  console.log(JSON.stringify({ result: 'passed', fixtureUrl, checks, geometry, screenshots: [firstScreenshot, topScreenshot, narrowScreenshot, approvalScreenshot, darkApprovalScreenshot, timelineScreenshot, contextMenuScreenshot, configMenuScreenshot, ...reasoningScreenshots, fileToolScreenshot, sshTaskScreenshot, taskProgressScreenshot, adjustedPlanScreenshot, fileEditScreenshot, interruptedScreenshot, recoveryScreenshot], nativeBackendTested: false }, null, 2))
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
