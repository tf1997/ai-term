import type { SshTaskRequest, SshTaskResult, SshTaskTarget } from '../../terminal/types'
import { isSensitiveAgentCommand } from './aiConversation'

export function parseSshTaskArguments(raw: string): { request: SshTaskRequest; reason: string } {
  const args: unknown = JSON.parse(raw)
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('独立任务参数必须是对象')
  const value = args as Record<string, unknown>
  if (Object.keys(value).some(key => !['command', 'workingDirectory', 'environment', 'timeoutMs', 'reason'].includes(key))) throw new Error('独立任务包含不支持的参数')
  if (typeof value.command !== 'string' || !value.command.trim()) throw new Error('独立任务需要 command')
  if (typeof value.workingDirectory !== 'string' || !value.workingDirectory.startsWith('/')) throw new Error('独立任务需要绝对工作目录')
  const environment = value.environment ?? {}
  if (!environment || typeof environment !== 'object' || Array.isArray(environment) || Object.values(environment).some(v => typeof v !== 'string')) throw new Error('environment 必须是字符串键值对象')
  const timeoutMs = value.timeoutMs ?? 120_000
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) throw new Error('观察时限为 1—600 秒')
  return { request: { command: value.command, workingDirectory: value.workingDirectory, environment: environment as Record<string, string>, timeoutMs }, reason: typeof value.reason === 'string' ? value.reason : '' }
}

export function sensitiveSshTask(request: SshTaskRequest) {
  return isSensitiveAgentCommand(request.command) || Object.keys(request.environment).some(key => !['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'].includes(key))
}

/** Full output remains in the card; each model result has its own context cap. */
export function sshTaskModelResult(result: SshTaskResult, target?: SshTaskTarget) {
  const stdout = result.stdout.slice(0, 4000), stderr = result.stderr.slice(0, 4000)
  return JSON.stringify({ tool: 'run_ssh_task', target, ...result, stdout, stderr, contextTruncated: stdout.length < result.stdout.length || stderr.length < result.stderr.length })
}
