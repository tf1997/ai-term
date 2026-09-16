import { ref, computed, onBeforeUnmount } from 'vue'
import type { Ref } from 'vue'
import { preparedScriptContent } from '../domain/scriptPresentation'
import type { ScriptPanelProps, ScriptPanelEmit, ScriptExecutionSource } from '../domain/scriptPanel'
import { analyzeScriptRisks, buildScriptRiskPreviewLines, summarizeScriptRisks } from '../../../shared/security/scriptRisk'
import { analyzeScriptReadiness } from '../domain/scriptReadiness'
import { detectShellScriptLanguage } from '../../../shared/shell/shellCommand'
import { buildBashScriptTerminalInput, prepareScriptForExecution } from '../domain/scriptExecution'
import { formatError } from '../domain/scriptPresentation'
import * as tauri from '../../ai/infrastructure/api'

interface ScriptExecutionOptions {
  props: Readonly<ScriptPanelProps>
  emit: ScriptPanelEmit
  panelError: Ref<string>
  sourceCommands: () => string[]
  recordedOutput: () => string
  hasUsableConfig: () => boolean
  connectionLabel: (connectionId?: string) => string
}
type ScriptExecutionSourceAdapter = Pick<typeof tauri, 'onAiChatStream' | 'chatWithAiProviderStream' | 'cancelTask'>

export function useScriptExecution(options: ScriptExecutionOptions, source: ScriptExecutionSourceAdapter = tauri) {
  const { props, emit, panelError, sourceCommands, recordedOutput, hasUsableConfig, connectionLabel } = options
  const { onAiChatStream, chatWithAiProviderStream, cancelTask } = source
  const scriptExecutionNotice = ref('')

  const pendingScriptExecution = ref('')

  const pendingScriptSource = ref<ScriptExecutionSource | null>(null)

  const scriptRiskExplanation = ref('')

  const scriptRiskExplanationError = ref('')

  const scriptRiskExplanationLoading = ref(false)

  const scriptRiskExplanationRequestId = ref('')



  const pendingScriptRisks = computed(() => analyzeScriptRisks(preparedScriptContent(pendingScriptExecution.value, pendingScriptSource.value?.name)))

  const scriptRiskConfirmOpen = computed(() => pendingScriptExecution.value.trim().length > 0)

  const pendingScriptRiskSummary = computed(() => summarizeScriptRisks(pendingScriptRisks.value))

  const pendingScriptRiskLines = computed(() => buildScriptRiskPreviewLines(pendingScriptExecution.value, pendingScriptRisks.value))

  const pendingScriptConnectionMismatch = computed(() => {
    const sourceConnectionId = pendingScriptSource.value?.connectionId?.trim()
    return executionTargetsDifferFromSource(sourceConnectionId)
  })

  const pendingExecutionTitle = computed(() => {
    if (pendingScriptConnectionMismatch.value && pendingScriptRisks.value.length > 0) return '确认跨连接风险脚本'
    if (pendingScriptConnectionMismatch.value) return '确认跨连接执行'
    return '检测到风险命令'
  })

  const pendingExecutionSubtitle = computed(() => {
    if (pendingScriptConnectionMismatch.value) {
      return `来源 ${connectionLabel(pendingScriptSource.value?.connectionId)}，当前目标 ${props.executionTargetLabel}`
    }
    return '执行前请确认命中的命令行'
  })

  function buildScriptRiskExplanationPrompt(content: string) {
    const riskLines = pendingScriptRisks.value
      .map((risk) => `- 第 ${risk.line} 行：${risk.label}（${risk.severity === 'high' ? '高风险' : '中风险'}）${risk.message}；命令：${risk.text.trim()}`)
      .join('\n')
    return [
      '你是 AI Term 的脚本安全助手。请用中文解释下面脚本为什么存在风险。',
      '要求：',
      '1. 按风险类型说明可能造成的影响。',
      '2. 标出执行前必须确认的路径、服务、主机、权限、备份或回滚方案。',
      '3. 如可行，给出更安全的替代写法、dry-run 或只读检查命令。',
      '4. 不要替用户确认执行，不要输出夸张恐吓文案。',
      '',
      '风险命中：',
      riskLines || '- 未提供风险摘要',
      '',
      '待执行脚本：',
      '```shell',
      content,
      '```'
    ].join('\n')
  }

  async function explainPendingScriptRisk() {
    const content = pendingScriptExecution.value.trim()
    if (!content || scriptRiskExplanationLoading.value) return
    if (!hasUsableConfig()) {
      scriptRiskExplanationError.value = '暂无可用 AI 配置，请先在左侧设置中心完善配置。'
      return
    }
    const apiKey = props.config.apiKey?.trim() || props.apiKey.trim()
    if (!apiKey) {
      scriptRiskExplanationError.value = '请先保存 API Key 后再使用 AI 分析。'
      return
    }
    scriptRiskExplanationLoading.value = true
    scriptRiskExplanation.value = ''
    scriptRiskExplanationError.value = ''
    let streamedAnswer = ''
    let unlisten: (() => void) | undefined
    const requestId = `${props.connectionId}-${props.workspaceSessionId}-script-risk-${Date.now()}`
    scriptRiskExplanationRequestId.value = requestId
    try {
      unlisten = await onAiChatStream(requestId, (event) => {
        if (scriptRiskExplanationRequestId.value !== requestId) return
        if (event.kind === 'chunk') {
          streamedAnswer += event.delta
          scriptRiskExplanation.value = streamedAnswer
        }
        if (event.kind === 'error' && event.error) {
          scriptRiskExplanationError.value = `模型流式调用失败：${event.error}`
        }
      })
      const response = await chatWithAiProviderStream(requestId, {
        config: props.config,
        apiKey,
        question: buildScriptRiskExplanationPrompt(content),
        terminalSnapshot: recordedOutput(),
        commandHistory: sourceCommands()
      })
      if (scriptRiskExplanationRequestId.value !== requestId) return
      scriptRiskExplanation.value = (streamedAnswer || response.answer).trim() || 'AI 未返回风险说明。'
    } catch (error) {
      if (scriptRiskExplanationRequestId.value !== requestId) return
      scriptRiskExplanationError.value = formatError(error)
    } finally {
      unlisten?.()
      if (scriptRiskExplanationRequestId.value === requestId) {
        scriptRiskExplanationLoading.value = false
        scriptRiskExplanationRequestId.value = ''
      }
    }
  }

  function clearScriptRiskExplanation() {
    scriptRiskExplanation.value = ''
    scriptRiskExplanationError.value = ''
    scriptRiskExplanationLoading.value = false
    scriptRiskExplanationRequestId.value = ''
  }

  function executeScriptContent(content: string, sourceScript?: ScriptExecutionSource) {
    const language = detectShellScriptLanguage(content, sourceScript?.name)
    if (language === 'powershell' || language === 'cmd') {
      panelError.value = '运行脚本需要 Bash。请先将 PowerShell / CMD 内容转换为 Bash 脚本。'
      return
    }
    const executableContent = preparedScriptContent(content, sourceScript?.name)
    const readinessIssues = analyzeScriptReadiness(executableContent)
    if (readinessIssues.length > 0) {
      const issueLines = readinessIssues.slice(0, 3).map((issue) => `第 ${issue.line} 行 ${issue.label}`).join('、')
      const remaining = readinessIssues.length > 3 ? `等 ${readinessIssues.length} 项` : ''
      panelError.value = `脚本尚未填写完整：${issueLines}${remaining}。完成后再运行。`
      scriptExecutionNotice.value = ''
      return
    }
    const risks = analyzeScriptRisks(executableContent)
    const sourceConnectionId = sourceScript?.connectionId?.trim()
    const connectionMismatch = executionTargetsDifferFromSource(sourceConnectionId)
    if (risks.length > 0 || connectionMismatch) {
      pendingScriptExecution.value = content
      pendingScriptSource.value = sourceScript ?? null
      clearScriptRiskExplanation()
      panelError.value = ''
      scriptExecutionNotice.value = ''
      return
    }
    if (!writeScriptToTerminal(content, sourceScript)) return
    panelError.value = ''
    scriptExecutionNotice.value = '未检测到风险命令，已发送到目标终端。'
  }

  function writeScriptToTerminal(content: string, sourceScript?: ScriptExecutionSource | null) {
    const language = detectShellScriptLanguage(content, sourceScript?.name)
    const prepared = prepareScriptForExecution(content, language)
    const hasExecutableCommand = prepared.split('\n').some((line) => {
      const trimmed = line.trim()
      if (!trimmed) return false
      return !((language === 'bash' || language === 'shell') && trimmed.startsWith('#!'))
    })
    if (!hasExecutableCommand) {
      panelError.value = '脚本过滤注释后没有可执行命令。'
      scriptExecutionNotice.value = ''
      return false
    }
    emit('writeTerminalInput', buildBashScriptTerminalInput(prepared))
    return true
  }

  function confirmPendingScriptExecution() {
    const content = pendingScriptExecution.value.trim()
    if (!content) return
    const hadRisks = pendingScriptRisks.value.length > 0
    const hadConnectionMismatch = pendingScriptConnectionMismatch.value
    if (!writeScriptToTerminal(content, pendingScriptSource.value)) {
      closeScriptRiskConfirm()
      return
    }
    if (hadRisks && hadConnectionMismatch) {
      scriptExecutionNotice.value = '已确认跨连接目标和风险命令，脚本已发送到当前终端。'
    } else if (hadConnectionMismatch) {
      scriptExecutionNotice.value = '已确认跨连接目标，脚本已发送到当前终端。'
    } else {
      scriptExecutionNotice.value = '已确认风险命令，脚本已发送到目标终端。'
    }
    closeScriptRiskConfirm()
  }

  function closeScriptRiskConfirm() {
    pendingScriptExecution.value = ''
    pendingScriptSource.value = null
    clearScriptRiskExplanation()
  }

  function executionTargetsDifferFromSource(sourceConnectionId?: string) {
    if (!sourceConnectionId) return false
    const targetConnectionIds = props.executionTargetConnectionIds.length
      ? props.executionTargetConnectionIds
      : [props.connectionId]
    return targetConnectionIds.some((connectionId) => connectionId !== sourceConnectionId)
  }

  onBeforeUnmount(() => {
    const requestId = scriptRiskExplanationRequestId.value
    scriptRiskExplanationRequestId.value = ''
    if (requestId) void cancelTask(requestId).catch(() => {})
  })

  return { scriptExecutionNotice, pendingScriptExecution, pendingScriptSource, scriptRiskExplanation, scriptRiskExplanationError, scriptRiskExplanationLoading, scriptRiskExplanationRequestId, preparedScriptContent, pendingScriptRisks, scriptRiskConfirmOpen, pendingScriptRiskSummary, pendingScriptRiskLines, pendingScriptConnectionMismatch, pendingExecutionTitle, pendingExecutionSubtitle, buildScriptRiskExplanationPrompt, explainPendingScriptRisk, clearScriptRiskExplanation, executeScriptContent, writeScriptToTerminal, confirmPendingScriptExecution, closeScriptRiskConfirm, executionTargetsDifferFromSource }
}
