/** Presentation only. Raw capture must receive the original stream first. */
export function createSentinelDisplayFilter({ now = Date.now }: { now?: () => number } = {}) {
  let operation: { begin: string; end: string; input: string; source: string; deadline: number; started: boolean } | undefined
  let pending = ''
  let prelude = ''
  let ordinary = false
  const plain = (value: string) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')

  function flush() {
    const value = prelude + pending
    operation = undefined; prelude = ''; pending = ''; ordinary = false
    return value
  }
  return {
    begin(nonce: string, input: string, source: string, debug: boolean) {
      const remaining = flush()
      if (!debug && /^[a-zA-Z0-9_]{1,80}$/.test(nonce)) {
        operation = { begin: `__AI_TERM_${nonce}B__`, end: `__AI_TERM_${nonce}E__:`, input, source, deadline: now() + 65_000, started: false }
      }
      return remaining
    },
    push(chunk: string): string {
      if (!operation) return chunk
      if (now() > operation.deadline) return flush() + chunk
      let visible = ''
      for (const char of chunk) {
        if (!operation) { visible += char; continue }
        if (ordinary) {
          visible += char
          if (char === '\n') ordinary = false
          continue
        }
        pending += char
        if (char === '\n') {
          const line = pending.replace(/\r?\n$/, '')
          if (!operation.started && line === operation.begin) {
            // Replace only an exact echo. Unknown redraws/background output
            // remain visible; owning a capture is not permission to erase it.
            visible += plain(prelude).trim() === plain(operation.input).trim()
              ? operation.source.replace(/\r?\n/g, '\r\n') + '\r\n'
              : prelude
            prelude = ''; pending = ''; operation.started = true
          } else if (operation.started && line.startsWith(operation.end) && /^-?\d+$/.test(line.slice(operation.end.length))) {
            pending = ''; operation = undefined
          } else if (!operation.started) {
            prelude += pending; pending = ''
            if (prelude.length > 262_144) { visible += prelude; prelude = '' }
          } else { visible += pending; pending = '' }
        } else if (operation.started) {
          const candidate = pending.replace(/\r$/, '')
          if (!operation.end.startsWith(candidate) && !(candidate.startsWith(operation.end) && /^-?\d*$/.test(candidate.slice(operation.end.length)))) {
            visible += pending; pending = ''; ordinary = true
          }
        } else {
          const candidate = plain(prelude + pending).trimStart()
          const expected = plain(operation.input).trim()
          const possibleEcho = expected.startsWith(candidate) || (candidate.startsWith(expected) && !candidate.slice(expected.length).trim())
          if ((!possibleEcho && !operation.begin.startsWith(pending.replace(/\r$/, ''))) || pending.length > 262_144) {
            visible += prelude + pending; prelude = ''; pending = ''; ordinary = true
          }
        }
      }
      return visible
    },
    // Cancellation restores unclassified text; it never hides subsequent output.
    resume: flush,
    reset() { flush() },
  }
}
