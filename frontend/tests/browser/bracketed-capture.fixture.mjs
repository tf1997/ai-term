import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { attachShellIntegration } from '../../src/domains/terminal/domain/shellIntegration'
import { createShellCaptureVerification } from '../../src/domains/terminal/domain/shellCaptureVerification'
import { createApp } from 'vue'
import { useTerminalCapture } from '../../src/domains/terminal/application/useTerminalCapture'
import { createInternalTerminalOutputFilter } from '../../src/domains/terminal/domain/internalTerminalOutput'
const terminal = new Terminal({ cols: 160, rows: 30, scrollback: 2000, fontSize: 13, theme: { background: '#16191f', foreground: '#ccd4df' } })
terminal.open(document.querySelector('#terminal'))
const write = text => new Promise(resolve => terminal.write(text, resolve))
window.replayBracketedCapture = async record => {
  terminal.reset()
  const finished = [], captured = [], attachment = attachShellIntegration(terminal, { onCommandFinished: result => finished.push(result) })
  await write(record.prompt)
  attachment.tracker.armCommandCapture(4000, result => captured.push(result))
  attachment.tracker.setSubmittedCommand(record.source)
  const verifier = createShellCaptureVerification(record.nonce, true)
  for (const character of record.probe) verifier.push(character)
  for (let index = 0; index < record.output.length; index += 37) await write(record.output.slice(index, index + 37))
  attachment.dispose()
  return { finished, captured, verified: verifier.verified(), pasteEnabled: terminal.modes.bracketedPasteMode }
}
window.bracketedCaptureReady = true

window.replayCommandCapture = async record => {
  terminal.reset()
  terminal.resize(record.cols, 30)
  const finished = []
  const attachment = attachShellIntegration(terminal, { onCommandFinished: result => finished.push(result) })
  await write(record.prompt)
  const filter = createInternalTerminalOutputFilter()
  const probes = record.probes ?? (record.probeInput ? [{ input: record.probeInput, output: record.probeOutput }] : [])
  for (const probe of probes) {
    filter.begin(probe.input.replace(/\r$/, ''), { debug: false, restorePrefix: '\r\x1b[J' })
    for (let index = 0; index < probe.output.length; index += 37) await write(filter.push(probe.output.slice(index, index + 37)))
  }
  finished.length = 0
  let capture, replay
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({ setup() {
    capture = useTerminalCapture({
      getSessionId: () => 'real-command-replay', getShellIntegration: () => attachment,
      commandExecutionReadiness: () => 'ready', executeCommand: () => { throw Error('unexpected dispatch') },
      dispatchIntent: intent => {
        if (intent.source !== record.source) throw Error('source changed')
        replay = (async () => {
          for (let index = 0; index < record.output.length; index += 37) await write(filter.push(record.output.slice(index, index + 37)))
        })()
        return true
      }
    })
    return () => null
  } })
  app.mount(host)
  try {
    const result = await capture.runCommandAndCapture(record.source, { maxOutputChars: 20000, intent: { source: record.source, capture: { kind: 'markers', internal: false } } }).result
    await replay
    return { result, finished }
  } finally { app.unmount(); host.remove(); attachment.dispose() }
}

window.captureCommandRoundTrip = async ({ prompt, source, cols = 40, observed = source }) => {
  terminal.reset()
  terminal.resize(cols, 30)
  const attachment = attachShellIntegration(terminal)
  const osc = value => `\x1b]133;${value}\x07`
  await write(osc('A') + prompt + osc('B'))
  let capture, input, replay
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({ setup() {
    capture = useTerminalCapture({
      getSessionId: () => 'round-trip', getShellIntegration: () => attachment,
      commandExecutionReadiness: () => 'ready', executeCommand: () => { throw Error('unexpected dispatch') },
      dispatchIntent: intent => {
        if (intent.source !== source) throw Error('source changed')
        replay = (async () => {
          await write(observed)
          input = attachment.tracker.commandLine()
          await write('\r\n' + osc('C') + 'observed output\r\n' + osc('D;0') + osc('A') + prompt + osc('B'))
        })()
        return true
      }
    })
    return () => null
  } })
  app.mount(host)
  try {
    const result = await capture.runCommandAndCapture(source, { intent: { source, capture: { kind: 'markers', internal: false } } }).result
    await replay
    return { result, input }
  } finally { app.unmount(); host.remove(); attachment.dispose() }
}
