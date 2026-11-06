import type { ExecutionContext } from '../../../shared/security/commandPolicy'

/** This is reported context, never proof of host identity or SFTP equivalence. */
export function parseCommandContext(output: string): ExecutionContext | undefined {
  const match = /^(bash|zsh|unknown)\r?\n([\s\S]*?)\nAI_TERM_CONTEXT_USER\r?\n([\s\S]*?)\nAI_TERM_CONTEXT_SCOPE\r?\n([\s\S]*?)\nAI_TERM_CONTEXT_END\s*$/.exec(output.trim())
  if (!match) return
  try {
    const decode = (value: string) => new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(value.replace(/\s/g, '')), char => char.charCodeAt(0))).replace(/\r?\n$/, '')
    const directory = decode(match[2])
    const user = decode(match[3])
    const scope = decode(match[4])
    if (!directory.startsWith('/') || !/^\d+$/.test(user) || !scope || scope.length > 2048 || /[\u0000-\u001f]/.test(directory)) return
    return { shell: match[1] as ExecutionContext['shell'], workingDirectory: directory, user, environmentScope: JSON.stringify(scope.split('\n')) }
  } catch { return }
}
