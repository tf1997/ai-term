/** A fresh, nonce-bound probe must cross the complete raw OSC lifecycle.
 * This runs before display filtering: hidden probes never reach xterm's tracker.
 * It proves protocol support for this probe, not the identity of a remote host.
 */
export function createShellCaptureVerification(nonce: string, multiline = false) {
  let buffer = ''
  let verified = false
  let overflow = false
  let sawStart = false
  const begin = `__AI_TERM_${nonce}B__`
  const end = `__AI_TERM_${nonce}E__:7`
  const osc = /\x1b\](?:133|633);([ABCD])(?:;([^\x07\x1b]*))?(?:\x07|\x1b\\)/g
  return {
    push(chunk: string) {
      if (verified || overflow) return
      buffer += chunk
      if (buffer.length > 65_536) { buffer = ''; overflow = true; return }
      let start = -1
      let ended = false
      let prompt = false
      osc.lastIndex = 0
      for (const match of buffer.matchAll(osc)) {
        if (match[1] === 'C') {
          sawStart = true
          // Bash emits PS0 for each parsed line of one bracketed input, with a
          // single final D. Never join separate executions across a D or footer.
          if (!multiline || start < 0 || ended || buffer.slice(start, match.index).includes(end)) start = match.index! + match[0].length
          ended = false; prompt = false
        }
        if (match[1] === 'D') {
          if (start < 0 || match[2] !== '7') { start = -1; continue }
          const body = buffer.slice(start, match.index)
          const b = body.indexOf(begin)
          const output = body.indexOf('\nAI_TERM_CAPTURE_OK\r\n', b + begin.length)
          const unixOutput = body.indexOf('\nAI_TERM_CAPTURE_OK\n', b + begin.length)
          const e = body.indexOf(end, b + begin.length)
          const first = body.indexOf('\nAI_TERM_MULTILINE_FIRST', b + begin.length)
          ended = b >= 0 && e > b && ((output >= 0 && output < e) || (unixOutput >= 0 && unixOutput < e)) && (!multiline || first >= 0 && first < e)
        }
        if (ended && match[1] === 'A') prompt = true
        if (ended && prompt && match[1] === 'B') { verified = true; buffer = ''; return }
      }
    },
    verified: () => verified,
    started: () => sawStart,
  }
}
