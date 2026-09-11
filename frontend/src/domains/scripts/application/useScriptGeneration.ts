import { ref, onBeforeUnmount } from 'vue'
import type { Ref } from 'vue'
import type { ScriptPanelProps, ScriptChatMessage, ScriptPanelMode } from '../domain/scriptPanel'
import type { SaveState } from '../../../shared/forms/configuration'
import { extractBashScript, displayAnswerWithoutScript, formatError } from '../domain/scriptPresentation'
import * as tauri from '../../ai/infrastructure/api'

interface ScriptGenerationOptions {
  props: Readonly<ScriptPanelProps>
  saveState: Ref<SaveState>
  panelError: Ref<string>
  scriptPanelMode: Ref<ScriptPanelMode>
  askText: Ref<string>
  messages: Ref<ScriptChatMessage[]>
  collapsedMessages: Ref<Record<string, boolean>>
  draftScriptContent: Ref<string>
  recordedCommands: () => string[]
  sourceCommands: () => string[]
  recordedOutput: () => string
  recordingHasData: () => boolean
  scriptSourceConnectionId: () => string
  scriptSourceWorkspaceSessionId: () => string
  hasDraftScript: () => boolean
  hasUsableConfig: () => boolean
  openGenerateMode: () => void
  updateSelectedScriptDraft: (content: string) => void
  applyDraftScript: (content: string, messageId: string) => void
}
type ScriptGenerationSource = Pick<typeof tauri, 'onAiChatStream' | 'chatWithAiProviderStream' | 'cancelTask'>

export function useScriptGeneration(options: ScriptGenerationOptions, source: ScriptGenerationSource = tauri) {
  const { props, saveState, panelError, scriptPanelMode, askText, messages, collapsedMessages, draftScriptContent, recordedCommands, sourceCommands, recordedOutput, recordingHasData, scriptSourceConnectionId, scriptSourceWorkspaceSessionId, hasDraftScript, hasUsableConfig, openGenerateMode, updateSelectedScriptDraft, applyDraftScript } = options
  const { onAiChatStream, chatWithAiProviderStream, cancelTask } = source
  let disposed = false
  const STREAM_TIMER_INTERVAL_MS = 1000

  const isGenerating = ref(false)

  const currentRequestId = ref('')

  const currentAssistantMessageId = ref('')

  const answerElapsedSeconds = ref(0)

  const answerDurations = ref<Record<string, number>>({})

  const stopRequested = ref(false)

  let answerTimer: number | undefined

  async function sendScriptRequest(
    mode: 'generate' | 'revise' | 'regenerate' = hasDraftScript() ? 'revise' : 'generate',
    target: 'draft' | 'selected' = 'draft'
  ) {
    if (target === 'draft' && scriptPanelMode.value !== 'generate') openGenerateMode()
    if (disposed || isGenerating.value) return
    const explicitText = askText.value.trim()
    const hasScriptContext = hasDraftScript() || recordingHasData() || sourceCommands().length > 0
    if (!hasScriptContext && !explicitText) {
      panelError.value = '请先录制操作、粘贴脚本，或描述你要生成的脚本。'
      return
    }
    const text = explicitText || defaultScriptRequest(mode)
    if (!hasUsableConfig()) {
      panelError.value = '暂无可用 AI 配置，请先在左侧配置菜单中新建或完善配置。'
      return
    }

    const userMessage = createMessage('user', text)
    const assistantMessage = createMessage('assistant', '', '', true)
    messages.value = [...messages.value, userMessage, assistantMessage]
    askText.value = ''
    panelError.value = ''
    isGenerating.value = true
    stopRequested.value = false
    collapsedMessages.value = {
      ...collapsedMessages.value,
      [assistantMessage.id]: false
    }

    const apiKey = props.config.apiKey?.trim() || props.apiKey.trim()
    const requestId = `${userMessage.sourceConnectionId}-${userMessage.sourceWorkspaceSessionId}-script-${Date.now()}`
    currentRequestId.value = requestId
    currentAssistantMessageId.value = assistantMessage.id
    startAnswerTimer()
    const prompt = buildScriptPrompt(text, mode)
    let answer = ''
    let unlisten: (() => void) | undefined
    // Writing every streamed token into `messages` re-renders (and re-parses)
    // the whole conversation per token; coalesce chunk updates on a short
    // trailing timer and let the final update below flush the complete answer.
    let streamFlushTimer: number | undefined
    const cancelStreamFlush = () => {
      if (streamFlushTimer !== undefined) {
        window.clearTimeout(streamFlushTimer)
        streamFlushTimer = undefined
      }
    }
    const flushStreamedAnswer = () => {
      streamFlushTimer = undefined
      if (disposed || stopRequested.value || currentRequestId.value !== requestId) return
      updateAssistantMessage(assistantMessage.id, answer, true)
    }
    try {
      unlisten = await onAiChatStream(requestId, (event) => {
        if (disposed || stopRequested.value || currentRequestId.value !== requestId) return
        if (event.kind === 'chunk') {
          answer += event.delta
          if (streamFlushTimer === undefined) {
            streamFlushTimer = window.setTimeout(flushStreamedAnswer, 80)
          }
        }
        if (event.kind === 'error' && event.error) {
          if (stopRequested.value) return
          cancelStreamFlush()
          finishAnswerTimer(assistantMessage.id)
          updateAssistantMessage(assistantMessage.id, `模型调用失败。\n\n错误详情：${event.error}`, false, true)
        }
      })
      if (disposed || currentRequestId.value !== requestId) return
      const response = await chatWithAiProviderStream(requestId, {
        config: props.config,
        apiKey,
        question: prompt,
        terminalSnapshot: recordedOutput(),
        commandHistory: userMessage.sourceCommands ?? []
      })
      if (disposed || stopRequested.value || currentRequestId.value !== requestId) return
      cancelStreamFlush()
      const finalAnswer = answer || response.answer
      const script = extractBashScript(finalAnswer)
      finishAnswerTimer(assistantMessage.id)
      updateAssistantMessage(assistantMessage.id, displayAnswerWithoutScript(finalAnswer), false, false, script)
      if (script) {
        if (target === 'selected') {
          updateSelectedScriptDraft(script)
        } else {
          applyDraftScript(script, assistantMessage.id)
        }
        saveState.value = 'idle'
      }
    } catch (error) {
      if (disposed || stopRequested.value || currentRequestId.value !== requestId) return
      cancelStreamFlush()
      finishAnswerTimer(assistantMessage.id)
      updateAssistantMessage(assistantMessage.id, `模型调用失败。\n\n错误详情：${formatError(error)}`, false, true)
    } finally {
      cancelStreamFlush()
      unlisten?.()
      if (currentRequestId.value === requestId) {
        currentRequestId.value = ''
        currentAssistantMessageId.value = ''
        stopRequested.value = false
        isGenerating.value = false
      }
    }
  }

  function stopScriptGeneration() {
    const requestId = currentRequestId.value
    if (!requestId || !isGenerating.value) return
    stopRequested.value = true
    void cancelTask(requestId).catch((error) => {
      console.error('failed to cancel script AI request', error)
    })
    const message = messages.value.find((item) => item.id === currentAssistantMessageId.value)
    if (message) {
      finishAnswerTimer(message.id)
      const stoppedText = message.text.trim()
        ? `${message.text.trimEnd()}\n\n[已停止回答]`
        : '[已停止回答]'
      updateAssistantMessage(message.id, stoppedText, false, false, message.scriptContent ?? '')
    } else {
      finishAnswerTimer()
    }
    currentRequestId.value = ''
    currentAssistantMessageId.value = ''
    isGenerating.value = false
  }

  function createMessage(
    role: ScriptChatMessage['role'],
    text: string,
    scriptContent = '',
    streaming = false,
    sourceConnectionId = scriptSourceConnectionId(),
    sourceWorkspaceSessionId = scriptSourceWorkspaceSessionId(),
    sourceCommandSnapshot = [...sourceCommands()]
  ): ScriptChatMessage {
    return {
      id: `script-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role,
      text,
      scriptContent,
      streaming,
      createdAt: new Date().toISOString(),
      sourceConnectionId,
      sourceWorkspaceSessionId,
      sourceCommands: sourceCommandSnapshot
    }
  }

  function updateAssistantMessage(messageId: string, text: string, streaming: boolean, error = false, scriptContent = '') {
    messages.value = messages.value.map((message) => {
      if (message.id !== messageId) return message
      return {
        ...message,
        text,
        scriptContent,
        streaming,
        error
      }
    })
  }

  function defaultScriptRequest(mode: 'generate' | 'revise' | 'regenerate') {
    if (mode === 'regenerate') return '基于当前上下文重新生成一版脚本。'
    if (mode === 'revise') return '优化当前脚本，保留原意，并提升安全性、可读性和可复用性。'
    return '生成一个可复用脚本，保留变量、检查和安全确认。'
  }

  function startAnswerTimer() {
    stopAnswerTimer()
    const startedAt = Date.now()
    answerElapsedSeconds.value = 0
    answerTimer = window.setInterval(() => {
      answerElapsedSeconds.value = Math.floor((Date.now() - startedAt) / 1000)
    }, STREAM_TIMER_INTERVAL_MS)
  }

  function stopAnswerTimer() {
    if (answerTimer !== undefined) window.clearInterval(answerTimer)
    answerTimer = undefined
  }

  function finishAnswerTimer(messageId?: string) {
    const seconds = answerTimer !== undefined ? Math.max(1, answerElapsedSeconds.value) : answerElapsedSeconds.value
    if (messageId) {
      answerDurations.value = {
        ...answerDurations.value,
        [messageId]: seconds
      }
      messages.value = messages.value.map((message) => (
        message.id === messageId ? { ...message, durationSeconds: seconds } : message
      ))
    }
    stopAnswerTimer()
    answerElapsedSeconds.value = 0
  }

  function messageAnswerDuration(message: ScriptChatMessage) {
    if (message.streaming && message.id === currentAssistantMessageId.value) return answerElapsedSeconds.value
    return message.durationSeconds ?? answerDurations.value[message.id] ?? 0
  }

  function formatAnswerDuration(seconds: number) {
    const safeSeconds = Math.max(0, Math.floor(seconds))
    if (safeSeconds < 60) return `${safeSeconds} 秒`
    const minutes = Math.floor(safeSeconds / 60)
    const remainder = safeSeconds % 60
    return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分钟`
  }

  function buildScriptPrompt(userRequest: string, mode: 'generate' | 'revise' | 'regenerate') {
    const draft = draftScriptContent.value.trim()
    const modeText = mode === 'regenerate' ? '重新生成' : mode === 'revise' ? '继续修改当前草稿' : '生成新脚本'
    return [
      '你是 AI Term 的脚本工坊助手。',
      '你的任务是根据用户要求、当前脚本草稿、录制命令和终端输出，生成或修改一个可复用、允许用户继续编辑的脚本。',
      '不要把任务限定为某一类场景；脚本可以用于巡检、备份、部署、排障、批处理等终端自动化场景。',
      '',
      `模式：${modeText}`,
      `用户要求：${userRequest}`,
      `录制状态：${props.recording.isRecording ? '仍在录制' : props.recording.stoppedAt ? '已结束录制' : '未主动结束录制'}`,
      `录制命令数：${recordedCommands().length}；用于生成的命令数：${sourceCommands().length}；录制输出字符数：${recordedOutput().length}`,
      '',
      '生成要求：',
      '1. 优先输出一个完整 bash 代码块，代码块语言标记为 bash。',
      '2. 脚本应包含 set -euo pipefail、可修改变量、必要检查、日志输出和失败处理。',
      '3. 如果是继续修改，必须以当前脚本草稿为基础，不要无故丢失已有逻辑。',
      '4. 从上下文提炼真实操作，不要编造没有出现的服务名、路径、端口或仓库地址；未知值用变量和 TODO 注释。',
      '5. 去掉纯查看类和试错类命令，只保留脚本真正需要的步骤。',
      '6. 对 rm、覆盖配置、重启、删除、数据库迁移等风险操作加注释和确认变量。',
      '7. 代码块后用简短文字列出用户执行前需要确认的变量或风险点。',
      '',
      '当前脚本草稿：',
      draft || '(无草稿)',
      '',
      '录制期间命令：',
      sourceCommands().length ? sourceCommands().map((command) => `- ${command}`).join('\n') : '- 无',
      '',
      '录制期间终端输出摘要原文：',
      recordedOutput() || '(无录制输出)'
    ].join('\n')
  }

  onBeforeUnmount(() => {
    disposed = true
    stopAnswerTimer()
    const requestId = currentRequestId.value
    currentRequestId.value = ''
    if (requestId) void cancelTask(requestId).catch(() => {})
  })

  return { isGenerating, currentRequestId, currentAssistantMessageId, stopRequested, answerElapsedSeconds, answerDurations, sendScriptRequest, stopScriptGeneration, createMessage, updateAssistantMessage, startAnswerTimer, stopAnswerTimer, finishAnswerTimer, messageAnswerDuration, formatAnswerDuration, buildScriptPrompt, defaultScriptRequest }
}
