import assert from 'node:assert/strict'
import test from 'node:test'
import { createRenderer } from 'vue'
import { useTerminalCapture } from '../../src/domains/terminal/application/useTerminalCapture'

globalThis.window ??= globalThis
const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null })
const osc = value => `\x1b]133;${value}\x07`
function fixture({ markers = true, load = false, prepare, paste = false } = {}) {
  let capture, session = 'session', loaded = false, sequence = 0
  const writes = []
  const app = renderer.createApp({ setup() {
    capture = useTerminalCapture({
      getSessionId: () => session,
      bracketedPasteEnabled: () => paste,
      getShellIntegration: () => ({ tracker: { sawMarkers: true } }),
      commandExecutionReadiness: () => 'ready',
      executeCommand: () => { throw Error('native bypass') },
      enableShellIntegration: () => load,
      prepareProbe: async probe => {
        await prepare?.(probe)
        return { source: probe.kind, capture: { kind: 'sentinel', nonce: `probe${++sequence}`, internal: true } }
      },
      cancelIntent: async () => {},
      dispatchIntent: intent => {
        writes.push(intent)
        if (intent.source === 'shell-integration') loaded = true
        const value = intent.source === 'capture' || intent.source === 'bracketed-capture' ? 7 : 0
        const output = intent.source === 'bracketed-capture' ? 'AI_TERM_MULTILINE_FIRST\r\n' + osc('C') + '\nAI_TERM_CAPTURE_OK\r\n' : intent.source === 'capture' ? 'AI_TERM_CAPTURE_OK\r\n' : ''
        const framed = `\r\n__AI_TERM_${intent.capture.nonce}B__\r\n${output}\r\n__AI_TERM_${intent.capture.nonce}E__:${value}\r\n`
        queueMicrotask(() => capture.ingestCaptureOutput(markers || loaded ? osc('C') + framed + osc(`D;${value}`) + osc('A') + osc('B') : framed))
        return true
      },
    })
    return () => null
  } })
  app.mount({})
  return { capture, writes, disablePaste: () => { paste = false }, close: () => app.unmount(), reconnect: () => { session = 'new'; capture.abortActiveCapture('reconnected') } }
}

test('历史 sawMarkers 不启用捕获，原始探针验证后才缓存能力', async () => {
  const f = fixture()
  try {
    assert.equal(f.capture.agentCaptureMode(), 'sentinel')
    assert.equal(await f.capture.ensureAgentCapture(), 'markers')
    assert.equal(await f.capture.ensureAgentCapture(), 'markers')
    assert.equal(f.writes.length, 1)
    f.capture.invalidateCaptureCapability()
    assert.equal(f.capture.agentCaptureMode(), 'sentinel')
    assert.equal(await f.capture.ensureAgentCapture(), 'markers')
    assert.equal(f.writes.length, 2)
    f.reconnect()
    assert.equal(f.capture.agentCaptureMode(), 'sentinel')
  } finally { f.close() }
})

test('关闭自动加载时仅使用哨兵，开启后先加载再重新验证', async () => {
  for (const load of [false, true]) {
    const f = fixture({ markers: false, load })
    try {
      assert.equal(await f.capture.ensureAgentCapture(), load ? 'markers' : 'sentinel')
      assert.deepEqual(f.writes.map(i => i.source), load ? ['capture', 'shell-integration', 'capture'] : ['capture'])
    } finally { f.close() }
  }
})

test('探针准备期间重连不派发迟到操作，也不保留旧能力', async () => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const f = fixture({ prepare: () => pending })
  const probing = f.capture.ensureAgentCapture()
  f.reconnect(); release()
  assert.equal(await probing, 'sentinel')
  assert.equal(f.writes.length, 0)
  assert.equal(f.capture.agentCaptureMode(), 'sentinel')
  f.close()
})

test('raw multiline transport needs live bracketed paste plus a fresh complete probe', async () => {
  for (const paste of [false, true]) {
    const f = fixture({ paste })
    try {
      assert.equal(await f.capture.ensureBracketedCapture(), false)
      assert.equal(await f.capture.ensureAgentCapture(), 'markers')
      assert.equal(await f.capture.ensureBracketedCapture(), paste)
      assert.equal(await f.capture.ensureBracketedCapture(), paste)
      assert.deepEqual(f.writes.map(i => i.source), paste ? ['capture', 'bracketed-capture'] : ['capture'])
      f.disablePaste(); assert.equal(await f.capture.ensureBracketedCapture(), false)
      f.reconnect(); assert.equal(await f.capture.ensureBracketedCapture(), false)
    } finally { f.close() }
  }
})

test('disabling paste while the native probe is prepared prevents its dispatch', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const f = fixture({ paste: true, prepare: probe => probe.kind === 'bracketed-capture' ? gate : undefined })
  try {
    await f.capture.ensureAgentCapture(); const pending = f.capture.ensureBracketedCapture()
    f.disablePaste(); release(); assert.equal(await pending, false)
    assert.deepEqual(f.writes.map(i => i.source), ['capture'])
  } finally { f.close() }
})
