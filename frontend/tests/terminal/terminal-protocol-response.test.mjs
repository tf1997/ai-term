import assert from 'node:assert/strict'
import test from 'node:test'
import xterm from '@xterm/xterm'
import { isTerminalProtocolResponse } from '../../src/domains/terminal/domain/terminalProtocolResponse'

test('xterm-generated device, status, cursor and mode reports are protocol responses', async () => {
  const terminal = new xterm.Terminal({ cols: 80, rows: 24 })
  const reports = []
  terminal.onData(data => reports.push(data))
  try {
    for (const query of ['\x1b[c', '\x1b[>c', '\x1b[5n', '\x1b[6n', '\x1b[?6n', '\x1b[?2004$p', '\x1b[4$p',
      '\x1bP$qm\x1b\\', '\x1bP$qr\x1b\\', '\x1bP$q q\x1b\\', '\x1bP$q"q\x1b\\', '\x1bP$q"p\x1b\\', '\x1bP$qinvalid\x1b\\']) {
      const count = reports.length
      await new Promise(resolve => terminal.write(query, resolve))
      assert.equal(reports.length, count + 1, `Expected reply to ${JSON.stringify(query)}`)
      assert.equal(isTerminalProtocolResponse(reports.at(-1)), true, JSON.stringify(reports.at(-1)))
    }
  } finally { terminal.dispose() }
})

test('focus, color and window reports bypass keyboard processing as complete messages only', () => {
  for (const report of ['\x1b[I', '\x1b[O', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\', '\x1b]11;rgb:12/ab/00\x07',
    '\x1b]12;rgb:1234/abcd/5678\x1b\\', '\x1b]4;255;rgb:ff/ff/ff\x1b\\', '\x1b[4;600;800t', '\x1b[6;16;8t', '\x1b[8;24;80t']) {
    assert.equal(isTerminalProtocolResponse(report), true, JSON.stringify(report))
    for (const mixed of [report + 'echo keep\r', 'echo keep' + report, report + '\x03', report.slice(0, -1)]) {
      assert.equal(isTerminalProtocolResponse(mixed), false, JSON.stringify(mixed))
    }
  }
})

test('typing, paste, interrupts and navigation remain user input', () => {
  for (const input of ['echo AI_TERM_CAPTURE_OK\r', '\x03', '\r', '\x7f', '\x1b', '\x1b[A', '\x1b[Ohello', '\x1bOA',
    '\x1b[1;5C', '\x1b[15~', '\x1b[200~echo keep\x1b[201~', '\x1b]0;user title\x07']) {
    assert.equal(isTerminalProtocolResponse(input), false, JSON.stringify(input))
  }
})
