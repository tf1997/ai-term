import type { AiProviderConfig } from '../domain/provider'
import type { ScriptRiskMatch } from '../../../shared/security/scriptRisk'
import { chatWithAiProviderStream, onAiChatStream } from '../infrastructure/api'

export function buildAiRiskExplanationPrompt(command: string, risks: ScriptRiskMatch[]) {
  const riskLines = risks
    .map((risk) => `- 第 ${risk.line} 行：${risk.label}（${risk.severity === 'high' ? '高风险' : '中风险'}）${risk.message}；命令：${risk.text.trim()}`)
    .join('\n')
  return [
    '你是 AI Term 的命令安全助手。请用中文解释下面命令为什么存在风险。',
    '要求：',
    '1. 先用 2-4 条说明风险原因。',
    '2. 给出执行前必须确认的目标、路径、服务、权限或备份。',
    '3. 如果可以，给出更安全的替代命令或 dry-run/只读检查方式。',
    '4. 不要替用户确认执行，不要输出夸张恐吓文案。',
    '',
    '风险命中：',
    riskLines || '- 未提供风险摘要',
    '',
    '待执行命令：',
    '```shell',
    command,
    '```'
  ].join('\n')
}

/** Streams one risk explanation. The caller decides whether a late answer is still wanted. */
export async function explainCommandRisk(options: {
  config: AiProviderConfig
  apiKey: string
  requestId: string
  command: string
  risks: ScriptRiskMatch[]
  terminalSnapshot?: string
  commandHistory?: string[]
}, onText: (text: string) => void) {
  const apiKey = options.config.apiKey?.trim() || options.apiKey.trim()
  if (!options.config.baseUrl.trim() || !options.config.model.trim() || !apiKey) throw new Error('暂无可用 AI 配置，请先在设置中心完善配置并保存 API Key。')
  let streamedAnswer = ''
  let streamError = ''
  const unlisten = await onAiChatStream(options.requestId, (event) => {
    if (event.kind === 'chunk') {
      streamedAnswer += event.delta
      onText(streamedAnswer)
    }
    if (event.kind === 'error' && event.error) streamError = `模型流式调用失败：${event.error}`
  })
  try {
    const response = await chatWithAiProviderStream(options.requestId, {
      config: options.config,
      apiKey,
      question: buildAiRiskExplanationPrompt(options.command, options.risks),
      terminalSnapshot: options.terminalSnapshot ?? '',
      commandHistory: options.commandHistory ?? [],
      conversationMessages: []
    })
    const answer = (streamedAnswer || response.answer).trim()
    if (!answer && streamError) throw new Error(streamError)
    return answer
  } finally { unlisten() }
}
