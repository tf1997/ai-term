import assert from 'node:assert/strict'
import test from 'node:test'
import xterm from '@xterm/xterm'
import { createInternalTerminalOutputFilter } from '../../src/domains/terminal/domain/internalTerminalOutput'

const CLEAR_PROMPT = '\r\x1b[2K'
const prompt = 'root@server:~# '
const identity = (id = '1789443510475_1m3nzxpct') => {
  const begin = `AI_TERM_IDENT_BEGIN_${id}`, end = `AI_TERM_IDENT_END_${id}`
  const command = `printf '\\n${begin}\\n'; printf 'user='; id -un; printf '\\n${end}\\n'\n`
  const frame = `\r\n${begin}\r\nuser=root\r\nhostname=server\r\n\r\n${end}\r\n`
  return { begin, end, command, frame }
}
const feedCharacters = (filter, value) => [...value].map(character => filter.push(character)).join('')

test('unregistered output and user commands containing internal marker words remain byte-for-byte visible', () => {
  const filter = createInternalTerminalOutputFilter()
  const probe = identity()
  const normal = `cat debug.log\r\n${probe.command}${probe.frame}\x1b[32m${prompt}\x1b[0m`
  assert.equal(feedCharacters(filter, normal), normal)
  assert.equal(filter.begin('echo AI_TERM_IDENT_BEGIN_unpaired\n', { debug: false }), undefined)
  assert.equal(filter.push(normal), normal)
  assert.equal(filter.active(), false)
})

test('hides the registered command echo and response, then resumes at the next prompt in the same chunk', () => {
  const filter = createInternalTerminalOutputFilter(), probe = identity()
  assert.equal(filter.push(prompt), prompt)
  assert.equal(filter.begin(probe.command, { debug: false }), probe.begin)
  assert.equal(filter.push(probe.command.replaceAll('\n', '\r\n')), '')
  assert.equal(filter.active(), true, 'escaped END in the command echo must not finish the operation')
  assert.equal(filter.push(`${probe.frame}${prompt}ls\r\nvisible.txt\r\n${prompt}`), `${CLEAR_PROMPT}${prompt}ls\r\nvisible.txt\r\n${prompt}`)
  assert.equal(filter.active(), false)
})

test('identity output remains hidden at every possible two-chunk boundary and character by character', () => {
  const probe = identity()
  const stream = `${probe.command.replaceAll('\n', '\r\n')}${probe.frame}${prompt}`
  for (let split = 0; split <= stream.length; split++) {
    const filter = createInternalTerminalOutputFilter()
    filter.begin(probe.command, { debug: false })
    assert.equal(filter.push(stream.slice(0, split)) + filter.push(stream.slice(split)), CLEAR_PROMPT + prompt, `split ${split}`)
  }
  const filter = createInternalTerminalOutputFilter()
  filter.begin(probe.command, { debug: false })
  assert.equal(feedCharacters(filter, stream), CLEAR_PROMPT + prompt)
})

test('recognizes standalone marker lines through split ANSI, OSC, and CRLF while preserving the following prompt bytes', () => {
  const filter = createInternalTerminalOutputFilter(), probe = identity()
  filter.begin(probe.command, { debug: false })
  const frame = `\x1b[?2004l\r\n\x1b]0;title\x1b\\\x1b[32m${probe.begin}\x1b[0m\r\nuser=root\r\n\x1b[0m${probe.end}\t \x1b[0m\r\n`
  const coloredPrompt = `\x1b]133;A\x07\x1b[36m${prompt}\x1b[0m\x1b[?2004h`
  assert.equal(feedCharacters(filter, frame + coloredPrompt), CLEAR_PROMPT + coloredPrompt)
})

test('requires the current BEGIN before END and rejects embedded or other-operation end markers', () => {
  const filter = createInternalTerminalOutputFilter(), probe = identity(), other = identity('1789443510475_other')
  filter.begin(probe.command, { debug: false })
  assert.equal(filter.push(`${probe.end}\r\n`), '')
  assert.equal(filter.active(), true)
  assert.equal(filter.push(`${probe.begin}\r\n${other.end}\r\ncommand says ${probe.end}\r\n`), '')
  assert.equal(filter.active(), true)
  assert.equal(filter.push(`${probe.end}\r\n${prompt}`), CLEAR_PROMPT + prompt)
})

test('multiline upload echo and a heredoc END_DATA delimiter cannot prematurely end filtering', () => {
  const filter = createInternalTerminalOutputFilter()
  const begin = 'AI_TERM_FILE_BEGIN_1789443510475_2_upload', end = 'AI_TERM_FILE_END_1789443510475_2_upload'
  const command = `printf '\\n${begin}\\n'; (\nbase64 -d <<'${end}_DATA'\naGVsbG8=\n${end}_DATA\n); printf '\\nstatus=0\\n${end}\\n'\n`
  assert.equal(filter.begin(command, { debug: false }), begin)
  assert.equal(feedCharacters(filter, command.replaceAll('\n', '\r\n')), '')
  assert.equal(filter.active(), true)
  assert.equal(filter.push(`${begin}\r\n${end}_DATA\r\nstatus=0\r\n`), '')
  assert.equal(filter.active(), true)
  assert.equal(filter.push(`${end}\r\n${prompt}`), CLEAR_PROMPT + prompt)
})

test('consecutive probes each replace the existing idle prompt without printing blank lines or diagnostics', () => {
  const filter = createInternalTerminalOutputFilter()
  assert.equal(filter.push(prompt), prompt)
  for (let index = 0; index < 4; index++) {
    const probe = identity(`1789443510475_${index}`)
    filter.begin(probe.command, { debug: false })
    assert.equal(filter.push(probe.command + probe.frame), '')
    filter.finish(probe.command)
    assert.equal(filter.push(prompt), CLEAR_PROMPT + prompt)
  }
})

test('debug mode is byte-for-byte pass-through and can replace a prior hidden operation', () => {
  const filter = createInternalTerminalOutputFilter(), probe = identity()
  filter.begin(probe.command, { debug: false })
  filter.push(`${probe.begin}\nuser=root\n`)
  assert.equal(filter.begin(probe.command, { debug: true }), probe.begin)
  assert.equal(feedCharacters(filter, probe.command + probe.frame + prompt), probe.command + probe.frame + prompt)
  assert.equal(filter.active(), false)
  filter.finish(probe.command)
  assert.equal(filter.push('user command\n'), 'user command\n')
})

test('failed dispatch releases immediately without clearing a prompt when no output was hidden', () => {
  const filter = createInternalTerminalOutputFilter(), probe = identity()
  const token = filter.begin(probe.command, { debug: false })
  filter.finish(token)
  assert.equal(filter.active(), false)
  assert.equal(filter.push('ls\r\nfile.txt\r\n'), 'ls\r\nfile.txt\r\n')
})

test('protocol completion before the END line delimiter still hides its split CRLF and ANSI suffix', () => {
  const probe = identity()
  for (const suffix of ['\r\n', '\n', '\x1b[0m\r\n', '\x1b]0;diagnostic title\x1b\\\r\n', '\x1b]0;title\x07\r\n']) {
    for (let split = 0; split <= suffix.length; split++) {
      const filter = createInternalTerminalOutputFilter()
      filter.begin(probe.command, { debug: false })
      assert.equal(filter.push(`${probe.begin}\r\nuser=root\r\n${probe.end}${suffix.slice(0, split)}`), '')
      filter.finish(probe.command)
      assert.equal(filter.active(), false)
      assert.equal(feedCharacters(filter, suffix.slice(split) + prompt), CLEAR_PROMPT + prompt, `${JSON.stringify(suffix)} split ${split}`)
    }
  }
})

test('a missing END line delimiter after protocol completion cannot eat subsequent normal output', () => {
  const filter = createInternalTerminalOutputFilter(), probe = identity()
  filter.begin(probe.command, { debug: false })
  filter.push(`${probe.begin}\nuser=root\n${probe.end}`)
  filter.finish(probe.command)
  assert.equal(filter.push('visible log\r\n'), CLEAR_PROMPT + 'visible log\r\n')
})

test('cancellation releases user output immediately and hides only exact known late frames', () => {
  const filter = createInternalTerminalOutputFilter(), probe = identity(), other = identity('1789443510475_public')
  filter.begin(probe.command, { debug: false })
  filter.push(`${probe.begin}\nuser=root\n`)
  filter.finish(probe.command)
  assert.equal(filter.active(), false)
  assert.equal(filter.push('^C\r\n' + prompt + 'cat public.log\r\n'), CLEAR_PROMPT + '^C\r\n' + prompt + 'cat public.log\r\n')
  assert.equal(feedCharacters(filter, other.frame), other.frame)
  assert.equal(feedCharacters(filter, probe.frame + prompt), '\r\n' + prompt)
  assert.equal(filter.active(), false)
})

test('resuming user input releases a late response and prevents another late BEGIN from hiding user output', () => {
  const filter = createInternalTerminalOutputFilter(), probe = identity()
  filter.begin(probe.command, { debug: false })
  filter.push(probe.command)
  filter.finish(probe.command)
  filter.push(`${probe.begin}\r\nlate body\r\n`)
  assert.equal(filter.active(), true)
  filter.resume()
  assert.equal(filter.active(), false)
  assert.equal(filter.push('echo user\r\nuser\r\n'), 'echo user\r\nuser\r\n')
  assert.equal(filter.push(`${probe.begin}\r\nmore user output\r\n${probe.end}\r\n${prompt}`), `more user output\r\n${prompt}`)
  assert.equal(filter.active(), false)
})

test('resuming flushes an undecided visible prefix and preserves its split ANSI sequence', () => {
  const filter = createInternalTerminalOutputFilter(), probe = identity()
  filter.begin(probe.command, { debug: false })
  filter.finish(probe.command)
  assert.equal(filter.push('\x1b[31'), '')
  filter.resume()
  assert.equal(filter.push(''), '\x1b[31')
  assert.equal(feedCharacters(filter, 'mAI_TERM_ordinary text\x1b[0m\r\n'), 'mAI_TERM_ordinary text\x1b[0m\r\n')
})

test('a cancelled response can replace a wrapped prompt only once, including late standalone END markers', () => {
  const filter = createInternalTerminalOutputFilter(), probe = identity()
  const restorePrefix = '\r\x1b[3A\x1b[J'
  filter.begin(probe.command, { debug: false, restorePrefix })
  filter.push(probe.command)
  filter.finish(probe.command)
  assert.equal(filter.push(probe.frame + prompt), restorePrefix + '\r\n' + prompt)
  assert.equal(filter.push(`\r\nkeep this output\r\n${probe.end}\r\n${prompt}`), `\r\nkeep this output\r\n${prompt}`)
})

test('a late response preserves preceding output in the real xterm buffer after cancelling a wrapped prompt', async () => {
  const terminal = new xterm.Terminal({ cols: 20, rows: 15, allowProposedApi: true })
  const write = data => new Promise(resolve => terminal.write(data, resolve))
  const readLines = () => {
    const buffer = terminal.buffer.active
    return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index).translateToString(true))
      .filter(line => line.trim())
  }
  try {
    const longPrompt = 'root@server:/this/is/an/extremely/long/directory/for/prompt# '
    await write(`KEEP THIS OUTPUT\r\n${longPrompt}`)
    const wrappedRows = terminal.buffer.active.cursorY - 1
    assert.ok(wrappedRows >= 2)
    const filter = createInternalTerminalOutputFilter({ now: () => 0 }), probe = identity()
    filter.begin(probe.command, { debug: false, restorePrefix: `\r\x1b[${wrappedRows}A\x1b[J` })
    assert.equal(filter.push(probe.command), '')
    filter.finish(probe.command)
    await write(filter.push(probe.frame + longPrompt))
    const after = readLines()
    assert.equal(after[0], 'KEEP THIS OUTPUT')
    assert.ok(after.slice(1).join('').includes(longPrompt.trim()))
    assert.equal(after.join('').includes(probe.begin), false)
    assert.equal(after.join('').includes(probe.end), false)
  } finally {
    terminal.dispose()
  }
})

test('typing between a completed END and its next prompt keeps exactly one prompt in xterm', async () => {
  for (const endDelimiter of ['', '\r\n']) {
    const terminal = new xterm.Terminal({ cols: 80, rows: 10, allowProposedApi: true })
    const write = data => new Promise(resolve => terminal.write(data, resolve))
    try {
      const filter = createInternalTerminalOutputFilter(), probe = identity()
      await write(prompt)
      filter.begin(probe.command, { debug: false })
      assert.equal(filter.push(`${probe.begin}\r\nuser=root\r\n${probe.end}${endDelimiter}`), '')
      filter.finish(probe.command)
      filter.resume()
      await write(filter.push((endDelimiter ? '' : '\r\n') + prompt + 'ls'))
      assert.equal(terminal.buffer.active.getLine(0).translateToString(true), prompt + 'ls')
    } finally {
      terminal.dispose()
    }
  }
})

test('late prefix lookahead preserves mismatches, marker suffixes, and their exact control bytes', () => {
  const filter = createInternalTerminalOutputFilter(), probe = identity()
  filter.begin(probe.command, { debug: false })
  filter.finish(probe.command)
  const normal = `\x1b[31mAI_TERM_IDENT_BEGIN_unregistered\x1b[0m\r\n${probe.end}_DATA\r\n${probe.begin} is a documented token\r\n${prompt}`
  assert.equal(feedCharacters(filter, normal), normal)
})

test('an absent end marker stops hiding at its deadline and late matching cannot extend the grace window', () => {
  let time = 0
  const filter = createInternalTerminalOutputFilter({ now: () => time }), probe = identity()
  filter.begin(probe.command, { debug: false, timeoutMs: 20 })
  assert.equal(filter.push(probe.command + `\n${probe.begin}\nbody\n`), '')
  time = 20
  assert.equal(filter.push('normal output after timeout\r\n'), CLEAR_PROMPT + 'normal output after timeout\r\n')
  assert.equal(filter.active(), false)
  time = 30
  assert.equal(filter.push(`${probe.begin}\r\nlate body\r\n`), '')
  assert.equal(filter.active(), true)
  time = 2_020
  assert.equal(filter.push('output after bounded late frame\r\n'), 'output after bounded late frame\r\n')
  assert.equal(filter.active(), false)
  assert.equal(filter.push(probe.frame), probe.frame)
})

test('identity and transfer default deadlines recover even if BEGIN never arrives', () => {
  for (const [kind, timeout] of [['IDENT', 12_000], ['FILE', 60_000]]) {
    let time = 0
    const filter = createInternalTerminalOutputFilter({ now: () => time })
    const command = identity().command.replaceAll('IDENT', kind)
    filter.begin(command, { debug: false })
    assert.equal(filter.push('partial internal command echo'), '')
    time = timeout - 1
    assert.equal(filter.active(), true)
    time = timeout
    assert.equal(filter.active(), false)
    assert.equal(filter.push('recovered prompt$ '), CLEAR_PROMPT + 'recovered prompt$ ')
  }
})

test('large internal lines and malformed ANSI lookahead stay bounded and ordinary output recovers', () => {
  const filter = createInternalTerminalOutputFilter(), probe = identity()
  filter.begin(probe.command, { debug: false })
  const largeBody = 'x'.repeat(1_000_000)
  assert.equal(filter.push(`${probe.begin}\n${largeBody}\n${probe.end}\n${prompt}`), CLEAR_PROMPT + prompt)
  const ordinary = `\n\x1b]${largeBody}`
  assert.equal(filter.push(ordinary), ordinary)
  filter.reset()
  assert.equal(filter.push('new session\n'), 'new session\n')
})

test('reset clears active and late operations plus stale prompt restoration for a new terminal generation', () => {
  const filter = createInternalTerminalOutputFilter(), probe = identity()
  filter.begin(probe.command, { debug: false })
  filter.push(probe.command)
  filter.finish(probe.command)
  filter.reset()
  assert.equal(filter.active(), false)
  assert.equal(filter.push(probe.frame + prompt), probe.frame + prompt)
  filter.begin(probe.command, { debug: false })
  filter.reset()
  assert.equal(filter.push('normal$ '), 'normal$ ')
})

test('caller can restore a wrapped prompt or leave terminal positioning to its own renderer', () => {
  const probe = identity()
  for (const restorePrefix of ['\r\x1b[2K\x1b[1A\x1b[2K', '']) {
    const filter = createInternalTerminalOutputFilter()
    filter.begin(probe.command, { debug: false, restorePrefix })
    assert.equal(filter.push(probe.frame + prompt), restorePrefix + prompt)
  }
})
