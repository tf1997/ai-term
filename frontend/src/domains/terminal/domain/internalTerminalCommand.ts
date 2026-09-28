/** Internal scripts use one quoted eval so multiline transfers form one history entry. */
function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

export function wrapInternalTerminalCommand(command: string, nonce = `${Date.now()}_${Math.random().toString(36).slice(2)}`): string {
  if (!/^[A-Za-z0-9_]+$/.test(nonce)) throw new Error('Invalid internal command nonce')
  const token = `AI_TERM_INTERNAL_${nonce}`
  // Bash adds input to history before executing it. Only delete the latest entry
  // if it contains this unique token: ignorespace/disabled history must not cause
  // the preceding user command to be removed. No shell preferences are changed.
  const guard = `if [ -n "\${BASH_VERSION-}" ]; then case "$(HISTTIMEFORMAT= builtin history 1 2>/dev/null)" in *'${token}'*) builtin history -d -1 2>/dev/null || : ;; esac; fi`
  // Leading space also honors shells configured to ignore space-prefixed input.
  return ` ${guard}; eval ${shellQuote(command.trimEnd())}`
}

export function frameInternalProbe(command: string, nonce: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(nonce)) throw new Error('Invalid probe nonce')
  return `printf '\\nAI_TERM_PROBE_BEGIN_${nonce}\\n'; ${command}; printf '\\nAI_TERM_PROBE_END_${nonce}\\n'`
}

export function isInternalTerminalCommand(command: string): boolean {
  const value = command.trimStart()
  if (value.startsWith('if [ -n "${BASH_VERSION-}" ]; then case ') && /AI_TERM_INTERNAL_[A-Za-z0-9_]+/.test(value)) return true
  // Older internal commands can already be present in the app's stored history.
  const marker = /^printf ['"]\\nAI_TERM_(IDENT|FILE|PROBE)_BEGIN_([A-Za-z0-9_]+)/.exec(value)
  return Boolean(marker && value.includes(`AI_TERM_${marker[1]}_END_${marker[2]}`))
}
