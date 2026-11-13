import { scanCommand } from '../../../shared/security/shellCommandScan'
import type { AgentCommandInterruption } from './agent'

export function commandInterruptionSummary(info: AgentCommandInterruption): string {
  const waited = Math.floor(info.waitedMs / 1000)
  const activity = info.outputGrowing ? '中断前仍观察到新输出'
    : info.hadOutput ? `最近 ${Math.floor(info.silentMs / 1000)} 秒未观察到新输出`
      : '等待期间未观察到命令输出'
  return `用户中断命令：已等待 ${waited} 秒，${activity}。`
}

export function commandInterruptionFeedback(info: AgentCommandInterruption | undefined) {
  if (!info) return {}
  return {
    status: 'interrupted_by_user', interrupted: true, interruption: info,
    note: `${commandInterruptionSummary(info)}用户希望结束本次等待并继续原任务，未取消任务。利用已有输出调整下一步，优先采用有限行数或明确时限的检查；不要原样重跑刚被中断的命令，也不要把中断当作检查成功。无新输出不证明进程无响应或操作未生效。`
  }
}

/** A display hint only; never authorizes, rewrites or terminates a command. */
export function commandWaitHint(command: string): string {
  for (const segment of scanCommand(command).segments) {
    const tokens = [...segment]
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? '')) tokens.shift()
    const head = tokens[0]?.split('/').pop()
    const optionsEnd = tokens.indexOf('--')
    const args = tokens.slice(1, optionsEnd < 0 ? undefined : optionsEnd)
    const follows = args.some(arg => /^--follow(?:=|$)/.test(arg) || /^-[^-]*[fF]/.test(arg))
    if ((head === 'tail' || head === 'journalctl' || ((head === 'docker' || head === 'kubectl') && args[0] === 'logs')) && follows) {
      return '此命令会持续监听新输出，通常不会自行结束。取得所需信息后可中断命令；下次可用 tail -n 100 等有界查询。'
    }
    if (head === 'watch' || (head === 'kubectl' && args.some(arg => arg === '-w' || arg === '--watch'))) {
      return '此命令会持续监视变化，通常不会自行结束，可随时中断命令。'
    }
  }
  return ''
}
