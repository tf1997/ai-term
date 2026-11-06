import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const debuggerUrl = process.env.AI_TERM_CDP_URL ?? 'http://127.0.0.1:9231'
const fixtureUrl = 'http://127.0.0.1:5173/tests/browser/task-script.fixture.html'
const outputDirectory = mkdtempSync(join(tmpdir(), 'ai-term-task-script-check-'))
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
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1000, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: fixtureUrl })
  await waitFor('window.taskScriptReady && document.querySelector(".agent-script-export button")')
  await click('.agent-script-export button')
  await waitFor('document.querySelector(".agent-task-script")')
  assert.equal(await evaluate('document.querySelectorAll(".task-script-choice input:checked").length'), 4)
  await click('.task-script-choice input[value="manual-inspect"]')
  assert.equal(await evaluate('document.querySelectorAll(".task-script-choice input:checked").length'), 3)
  assert.equal(await evaluate('document.querySelector(".task-script-choice input[value=other-environment]").disabled'), true)
  assert.ok(await evaluate('document.querySelector(".agent-task-script").textContent.includes("独立 SSH")'))
  assert.equal(await evaluate('document.querySelector(".agent-task-script").textContent.includes("/srv/app/demo.conf")'), true)
  await click('.task-script-actions .chat-button')
  await waitFor('taskScriptFixture.state.tab === "scripts" && document.querySelector("textarea[aria-label=脚本草稿]")?.value.includes("__AI_TERM_PARAM_")')
  assert.equal(await evaluate('taskScriptFixture.state.executions.length'), 0)
  assert.equal(await evaluate('taskScriptFixture.state.scripts.length'), 0)
  const path = "/tmp/a b'$(echo fixture)"
  await evaluate(`(() => { const input = document.querySelector('[aria-label=WORKDIR_1]'); input.value = ${JSON.stringify(path)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await click('[aria-label=首次保存脚本]')
  await waitFor('taskScriptFixture.state.scripts.length === 1')
  const saved = await evaluate('JSON.parse(JSON.stringify(taskScriptFixture.state.scripts[0]))')
  assert.equal(saved.taskMetadata.source.runId, '00000000-0000-4000-8000-000000000001')
  assert.deepEqual(saved.taskMetadata.source.stepIds, ['config-edit', 'restart', 'verify-file'])
  assert.deepEqual(saved.taskMetadata.omittedSteps.map(item => [item.stepId, item.reason]), [
    ['manual-inspect', 'not-selected'], ['independent-ssh', 'unsupported-tool'],
    ['metadata-restore', 'missing-file-evidence'], ['other-environment', 'different-environment']
  ])
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_OMITTED|OPTIONAL_OMITTED_COMMAND|OTHER_ENVIRONMENT_COMMAND/)
  assert.deepEqual(saved.taskMetadata.omittedChecks, [{ id: 'omitted-health', stepId: 'manual-inspect', required: true, status: 'passed' }])
  assert.ok(saved.content.includes('_ai_term_file_change replace'))
  assert.ok(saved.content.includes('_ai_term_file_change verify'))
  assert.equal(saved.taskMetadata.checks[0].id, 'config-value')
  assert.equal(saved.taskMetadata.parameters.filter(item => item.label === '文件路径').length, 1)
  assert.equal(saved.taskMetadata.parameters.find(item => item.name === 'FILE_1').defaultValue, '/srv/app/demo.conf')
  assert.equal(saved.taskMetadata.parameters.find(item => item.type === 'directory').defaultValue, '/srv/app')
  assert.ok(saved.content.includes('__AI_TERM_PARAM_')); assert.ok(!JSON.stringify(saved).includes(path))
  await click('[aria-label=运行脚本]')
  await waitFor('taskScriptFixture.state.executions.length === 1')
  const execution = await evaluate('JSON.parse(JSON.stringify(taskScriptFixture.state.executions[0]))')
  assert.equal(execution.kind, 'bash-script'); assert.ok(!execution.content.includes('__AI_TERM_PARAM_'))
  assert.ok(execution.content.includes("systemctl restart 'demo.service'")); assert.ok(execution.content.includes("'\"'\"'"))
  assert.ok(execution.content.includes("_ai_term_file_change replace '/srv/app/demo.conf'"))
  await evaluate(`(() => { const input = document.querySelector('[aria-label=SERVICE_1]'); input.value = 'another.service'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await click('[aria-label=运行脚本]')
  await waitFor('taskScriptFixture.state.executions.length === 2')
  assert.equal(await evaluate('taskScriptFixture.state.executions[1].content.includes("another.service")'), true)
  await evaluate('taskScriptFixture.state.panelVersion++')
  await waitFor('Boolean(document.querySelector(".script-head button[aria-label=脚本列表]"))')
  await click('.script-head button[aria-label=脚本列表]')
  await waitFor('Boolean(document.querySelector(".script-library-open[aria-label]"))')
  await click('.script-library-open[aria-label]')
  await waitFor('Boolean(document.querySelector(".script-library-editor textarea"))')
  assert.equal(await evaluate('document.querySelector("[aria-label=WORKDIR_1]").value'), '/srv/app')
  assert.equal(await evaluate('document.querySelector("[aria-label=FILE_1]").value'), '/srv/app/demo.conf')
  assert.equal(await evaluate('document.querySelector(".script-task-context").textContent.includes("00000000-0000-4000-8000-000000000001")'), true)
  await click('.script-task-omissions > summary')
  assert.equal(await evaluate('document.querySelectorAll("[data-omitted-step]").length'), 4)
  assert.ok(await evaluate('document.querySelector("[data-omitted-step=independent-ssh]").textContent.includes("单独整理")'))
  assert.ok(await evaluate('document.querySelector("[data-omitted-step=metadata-restore]").textContent.includes("元数据恢复")'))
  assert.ok(await evaluate('document.querySelector("[data-omitted-step=other-environment]").textContent.includes("其他目标范围")'))
  assert.ok(await evaluate('document.querySelector("[data-omitted-check=omitted-health]").textContent.includes("必要验证未纳入")'))
  await evaluate('taskScriptFixture.state.width = 360')
  await evaluate('(() => { const context = document.querySelector(".script-task-context"), omissions = document.querySelector(".script-task-omissions"); context.scrollTop += omissions.getBoundingClientRect().top - context.getBoundingClientRect().top - 8 })()')
  const screen = await screenshot('task-script-dark-360.png')
  await evaluate(`(() => {
    const fixture = taskScriptFixture;
    fixture.fileChange.sensitive = true; fixture.fileChange.before = null; fixture.fileChange.after = null;
    fixture.fileStep.sensitive = true; fixture.record.state.steps = [fixture.fileStep];
    fixture.state.tab = 'ai'; fixture.state.panelVersion++;
  })()`)
  await waitFor('Boolean(document.querySelector(".agent-script-export button"))')
  await click('.agent-script-export button')
  await waitFor('Boolean(document.querySelector(".agent-task-script"))')
  assert.equal(await evaluate('document.querySelector(".agent-task-script").textContent.includes("外部输入文件")'), true)
  await click('.task-script-actions .chat-button')
  await waitFor('Boolean(document.querySelector("[aria-label=FILE_1]"))')
  assert.equal(await evaluate('document.querySelector(".script-task-context").textContent.includes("AI_TERM_SECRET_FILE_BEFORE_1")'), true)
  assert.equal(await evaluate('document.querySelector(".script-task-context").textContent.includes("AI_TERM_SECRET_FILE_AFTER_1")'), true)
  assert.equal(await evaluate('document.querySelector("textarea[aria-label=脚本草稿]").value.includes("listen 8080")'), false)
  await evaluate(`(() => {
    const fixture = taskScriptFixture;
    const base = { ...fixture.fileStep, toolName: 'run_command', sensitive: false, exitCode: 0, fileEdits: [] };
    const source = 'export FIXTURE_NAME=fixture; fixture() { printf "%s" "$FIXTURE_NAME"; }';
    const secretSource = 'fixture; export APP_PASSWORD="' + '$' + '{AI_TERM_EXPORT_SECRET_1:?请提供外部凭据}"';
    fixture.record.state.steps = [
      { ...base, id: 'setup', command: source, scriptSource: { version: 1, shell: 'bash', source, secrets: [] } },
      { ...base, id: 'credential', command: '[敏感命令未存储]', sensitive: true, scriptSource: { version: 1, shell: 'bash', source: secretSource, secrets: [{ variable: 'AI_TERM_EXPORT_SECRET_1', label: '环境变量 APP_PASSWORD' }] } }
    ];
    fixture.record.state.verifications = [];
    fixture.state.tab = 'ai'; fixture.state.panelVersion++;
  })()`)
  await waitFor('Boolean(document.querySelector(".agent-script-export button"))')
  await click('.agent-script-export button')
  await waitFor('Boolean(document.querySelector(".agent-task-script"))')
  assert.equal(await evaluate('document.querySelectorAll(".task-script-choice input:checked").length'), 2)
  assert.equal(await evaluate('document.querySelector(".agent-task-script").textContent.includes("不复制历史值")'), true)
  await click('.task-script-actions .chat-button')
  await waitFor('Boolean(document.querySelector("textarea[aria-label=脚本草稿]"))')
  assert.equal(await evaluate('document.querySelector("textarea[aria-label=脚本草稿]").value.includes("builtin eval")'), true)
  assert.equal(await evaluate('document.querySelector(".script-task-context").textContent.includes("AI_TERM_SECRET_COMMAND_2_1")'), true)
  assert.equal(await evaluate('taskScriptFixture.state.executions.length'), 2)
  await click('[aria-label=首次保存脚本]')
  await waitFor('taskScriptFixture.state.scripts[0]?.taskMetadata.source.stepIds[0] === "setup"')
  assert.equal(await evaluate('taskScriptFixture.state.scripts[0].taskMetadata.parameters.find(p => p.type === "secret").defaultValue'), null)
  await click('[aria-label=运行脚本]')
  await waitFor('taskScriptFixture.state.executions.length === 3')
  assert.equal(await evaluate('taskScriptFixture.state.executions[2].content.includes("AI_TERM_SECRET_COMMAND_2_1")'), true)
  assert.equal(await evaluate('taskScriptFixture.state.executions[2].content.includes("__AI_TERM_PARAM_")'), false)
  await evaluate('taskScriptFixture.state.panelVersion++')
  await waitFor('Boolean(document.querySelector(".script-head button[aria-label=脚本列表]"))')
  await click('.script-head button[aria-label=脚本列表]')
  await waitFor('Boolean(document.querySelector(".script-library-open[aria-label]"))')
  await click('.script-library-open[aria-label]')
  await waitFor('Boolean(document.querySelector(".script-library-editor textarea"))')
  assert.equal(await evaluate('document.querySelector(".script-task-context").textContent.includes("AI_TERM_SECRET_COMMAND_2_1")'), true)
  const commandScreen = await screenshot('task-script-command-secret-360.png')
  await evaluate(`(() => {
    const fixture = taskScriptFixture;
    fixture.record.state.steps = [{ ...fixture.fileStep, id: 'zsh-static', toolName: 'run_command', command: 'print -r -- ready', sensitive: false, exitCode: 0, fileEdits: [], executionTarget: { ...fixture.fileStep.executionTarget, context: { ...fixture.fileStep.executionTarget.context, shell: 'zsh' } } }];
    fixture.record.state.verifications = [];
    fixture.state.tab = 'ai'; fixture.state.panelVersion++;
  })()`)
  await waitFor('Boolean(document.querySelector(".agent-script-export button"))')
  await click('.agent-script-export button')
  await waitFor('Boolean(document.querySelector(".agent-task-script"))')
  await click('.task-script-actions .chat-button')
  await waitFor('Boolean(document.querySelector("textarea[aria-label=脚本草稿]"))')
  assert.equal(await evaluate('document.querySelector("textarea[aria-label=脚本草稿]").value.includes("zsh -f -c")'), true)
  assert.equal(await evaluate('taskScriptFixture.state.executions.length'), 3)
  await click('[aria-label=运行脚本]')
  await waitFor('taskScriptFixture.state.executions.length === 4')
  assert.equal(await evaluate('taskScriptFixture.state.executions[3].content.includes("zsh -f -c")'), true)
  assert.equal(await evaluate('taskScriptFixture.state.executions[3].kind'), 'bash-script')
  assert.deepEqual(exceptions, [])
  console.log(JSON.stringify({ result: 'passed', screenshot: screen, commandScreenshot: commandScreen, nativeBackendTested: false, checks: ['WorkspacePanel joins durable file evidence with command steps before drafting', 'Generating and saving never runs the script', 'Runtime parameters are quoted before application policy review and are not saved into the template', 'Changed parameters create a new reviewed script', 'Reopening preserves file parameters, source, environment and script version', 'Omitted manual, SSH, metadata restore and other-environment sources retain their reasons after saving and reopening without copying excluded contents', 'Redacted file content uses explicit external file inputs', 'Complex Bash and credential templates survive save and reopen; execution uses fresh rendered source with external inputs'] }, null, 2))
} catch (error) {
  console.error('Browser failure screenshot:', await screenshot('failure.png').catch(() => 'unavailable'))
  throw error
} finally {
  for (const request of requests.values()) clearTimeout(request.timer)
  socket.close()
  await fetch(`${debuggerUrl}/json/close/${target.id}`).catch(() => {})
}
