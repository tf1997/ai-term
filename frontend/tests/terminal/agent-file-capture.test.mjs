import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRenderer } from 'vue'
import { useTerminalCapture } from '../../src/domains/terminal/application/useTerminalCapture'
import { useTerminalEvents } from '../../src/domains/terminal/application/useTerminalEvents'
import { createInternalTerminalOutputFilter } from '../../src/domains/terminal/domain/internalTerminalOutput'
import { frameInternalProbe, wrapInternalTerminalCommand } from '../../src/domains/terminal/domain/internalTerminalCommand'
import { createAgentFileSnapshotReader } from '../../src/domains/ai/application/agent/readAgentFileSnapshots'

const renderer = createRenderer({
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {},
  setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null
})

for (const markers of [true, false]) {
  test(`actual shell snapshots use raw capture while remaining hidden: markers=${markers}`, async t => {
    const previousWindow = globalThis.window
    globalThis.window = globalThis
    const dir = await mkdtemp(join(tmpdir(), 'ai-term-file-capture-'))
    const path = join(dir, "file '中文.txt")
    const before = '\ufeffbefore\r\nlast line without newline'
    await writeFile(path, before)
    let capture, events, receive, visible = '', nonce = 0
    const writes = [], pending = []
    const filter = createInternalTerminalOutputFilter()
    const app = renderer.createApp({ setup() {
      capture = useTerminalCapture({
        getSessionId: () => 'bound-session',
        getShellIntegration: () => markers ? { tracker: { sawMarkers: true } } : undefined,
        commandExecutionReadiness: () => 'ready',
        executeCommand(command, options) {
          writes.push({ command, options })
          assert.equal(options.internal, true); assert.equal(options.historyCommand, '')
          const wrapped = wrapInternalTerminalCommand(frameInternalProbe(command, `test_${++nonce}`))
          filter.begin(wrapped, { debug: false })
          pending.push(new Promise((resolve, reject) => execFile('/bin/sh', ['-c', wrapped], { maxBuffer: 1024 * 1024 }, (error, stdout) => {
            if (error) { reject(error); return }
            const stream = wrapped.replaceAll('\n', '\r\n') + '\r\n' + stdout.replaceAll('\n', '\r\n') + 'fixture$ '
            for (let offset = 0; offset < stream.length; offset += 31) {
              const chunk = stream.slice(offset, offset + 31)
              receive({ sessionId: 'bound-session', data: chunk })
            }
            resolve()
          })))
          return true
        }
      })
      events = useTerminalEvents({
        sessionId: () => 'bound-session',
        captureOutput: data => capture.ingestCaptureOutput(data),
        ingestTerminalOutput: data => { visible += filter.push(data) },
        handleTerminalSessionClosed: reason => capture.abortActiveCapture(reason)
      }, {
        onTerminalData: async (_session, callback) => { receive = callback; return () => {} },
        onTerminalClosed: async () => () => {}
      })
      return () => null
    } })
    app.mount({})
    await events.attachTerminalEvents()
    t.after(async () => { app.unmount(); globalThis.window = previousWindow; await rm(dir, { recursive: true, force: true }) })
    const reader = createAgentFileSnapshotReader((command, options) => capture.runCommandAndCapture(command, options))
    const first = await reader([path], { cancelled: false })
    assert.equal(first[0].version.content, before)
    await writeFile(path, 'after\n')
    const second = await reader([path], { cancelled: false })
    assert.equal(second[0].version.content, 'after\n')
    await Promise.all(pending)
    assert.equal(writes.length, 3, 'Historical markers still require one complete capability probe')
    assert.ok(!visible.includes('AI_TERM_')); assert.ok(!visible.includes('before')); assert.ok(!visible.includes('after'))
    assert.ok(visible.includes('fixture$ '))
  })
}
