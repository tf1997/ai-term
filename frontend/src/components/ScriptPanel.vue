<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { AiProviderConfig } from '../types/profile'
import type { CommandHistoryEntry, ScriptRecording, UpdateScript } from '../types/workspace'
import {
  analyzeScriptRisks,
  buildScriptRiskPreviewLines,
  riskLabelsForLine,
  scriptRiskStatusForContent,
  summarizeScriptRisks
} from '../lib/scriptRisk'
import type { ScriptRiskMatch } from '../lib/scriptRisk'
import {
  cancelTask,
  chatWithAiProviderStream,
  deleteUpdateScript,
  generateAiScriptTitle,
  listUpdateScripts,
  onAiChatStream,
  saveUpdateScript
} from '../lib/tauri'

interface ScriptChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  scriptContent?: string
  savedScriptId?: string
  streaming?: boolean
  error?: boolean
}

const props = defineProps<{
  terminalId: string
  connectionId: string
  workspaceSessionId: string
  selectedConfigId: string
  config: AiProviderConfig
  apiKey: string
  terminalSnapshot: string
  commandHistory: CommandHistoryEntry[]
  recording: ScriptRecording
}>()

const emit = defineEmits<{
  startRecording: []
  stopRecording: []
  clearRecording: []
  writeTerminalInput: [data: string]
}>()

type SaveState = 'idle' | 'saving' | 'saved' | 'error'
type ScriptPanelMode = 'library' | 'generate'
type ScriptLibraryView = 'list' | 'detail'
type ScriptPreviewSource = 'draft' | 'selected' | ''
const MAX_SCRIPT_SOURCE_COMMANDS = 80
const MAX_RECORDED_OUTPUT_CHARS = 80_000
const LONG_MESSAGE_CHARS = 900
const LONG_MESSAGE_LINES = 12

const scripts = ref<UpdateScript[]>([])
const selectedScriptId = ref('')
const saveState = ref<SaveState>('idle')
const panelError = ref('')
const scriptExecutionNotice = ref('')
const isGenerating = ref(false)
const scriptStoreMode = ref<'sqlite' | 'preview'>('sqlite')
const scriptPanelMode = ref<ScriptPanelMode>('generate')
const scriptLibraryView = ref<ScriptLibraryView>('list')
const askText = ref('')
const messages = ref<ScriptChatMessage[]>([])
const collapsedMessages = ref<Record<string, boolean>>({})
const scriptRepliesExpanded = ref(false)
const messageList = ref<HTMLElement | null>(null)
const draftEditorLineRail = ref<HTMLElement | null>(null)
const selectedScriptLineRail = ref<HTMLElement | null>(null)
const expandedScriptLineRail = ref<HTMLElement | null>(null)
const draftScriptHighlight = ref<HTMLElement | null>(null)
const selectedScriptHighlight = ref<HTMLElement | null>(null)
const expandedScriptHighlight = ref<HTMLElement | null>(null)
const librarySearchInput = ref<HTMLInputElement | null>(null)
const scriptSearch = ref('')
const editingMessageId = ref('')
const scriptDrafts = ref<Record<string, string>>({})
const currentRequestId = ref('')
const currentAssistantMessageId = ref('')
const stopRequested = ref(false)
const renamingScript = ref<UpdateScript | null>(null)
const scriptNameDraft = ref('')
const selectedScriptDraft = ref('')
const selectedScriptEditing = ref(false)
const draftScriptId = ref('')
const draftScriptContent = ref('')
const scriptPreviewSource = ref<ScriptPreviewSource>('')
const pendingScriptExecution = ref('')

const selectedScript = computed(() => scripts.value.find((script) => script.id === selectedScriptId.value))
const selectedScriptContent = computed(() => selectedScriptDraft.value)
const recordedCommands = computed(() => compactCommands(props.recording.commands, MAX_SCRIPT_SOURCE_COMMANDS))
const fallbackCommands = computed(() => compactHistoryCommands(props.commandHistory, MAX_SCRIPT_SOURCE_COMMANDS))
const sourceCommands = computed(() => recordedCommands.value.length ? recordedCommands.value : fallbackCommands.value)
const recordedOutput = computed(() => {
  const output = props.recording.terminalOutput || ''
  return output.length > MAX_RECORDED_OUTPUT_CHARS ? output.slice(-MAX_RECORDED_OUTPUT_CHARS) : output
})
const recordingHasData = computed(() => recordedCommands.value.length > 0 || recordedOutput.value.trim().length > 0)
const hasDraftScript = computed(() => draftScriptContent.value.trim().length > 0)
const showScriptComposer = computed(() => scriptPanelMode.value === 'generate')
const hasScriptReplies = computed(() => messages.value.length > 0)
const scriptReplyCountText = computed(() => `${messages.value.length} 条消息`)
const draftLineNumbers = computed(() => lineNumbersForScript(draftScriptContent.value))
const selectedScriptLineNumbers = computed(() => lineNumbersForScript(selectedScriptContent.value))
const scriptPreviewOpen = computed(() => scriptPreviewSource.value !== '')
const expandedScriptTitle = computed(() => scriptPreviewSource.value === 'selected' ? selectedScript.value?.name || '脚本预览' : '脚本预览')
const expandedScriptContent = computed(() => scriptPreviewSource.value === 'selected' ? selectedScriptContent.value : draftScriptContent.value)
const expandedScriptLineNumbers = computed(() => lineNumbersForScript(expandedScriptContent.value))
const draftScriptHighlightedHtml = computed(() => highlightShellScript(draftScriptContent.value))
const selectedScriptHighlightedHtml = computed(() => highlightShellScript(selectedScriptContent.value))
const expandedScriptHighlightedHtml = computed(() => highlightShellScript(expandedScriptContent.value))
const draftScriptRiskStatus = computed(() => scriptRiskStatusForContent(draftScriptContent.value))
const selectedScriptRiskStatus = computed(() => scriptRiskStatusForContent(selectedScriptContent.value))
const expandedScriptRiskStatus = computed(() => scriptRiskStatusForContent(expandedScriptContent.value))
const pendingScriptRisks = computed(() => analyzeScriptRisks(pendingScriptExecution.value))
const scriptRiskConfirmOpen = computed(() => pendingScriptExecution.value.trim().length > 0)
const pendingScriptRiskSummary = computed(() => summarizeScriptRisks(pendingScriptRisks.value))
const pendingScriptRiskLines = computed(() => buildScriptRiskPreviewLines(pendingScriptExecution.value, pendingScriptRisks.value))
const hasUsableConfig = computed(() => {
  return Boolean(props.config.baseUrl.trim() && props.config.model.trim() && (props.config.apiKey?.trim() || props.apiKey.trim()))
})
const filteredScripts = computed(() => {
  const keyword = scriptSearch.value.trim().toLowerCase()
  if (!keyword) return scripts.value
  return scripts.value.filter((script) => {
    return `${script.name} ${script.description}`.toLowerCase().includes(keyword)
  })
})
const scriptLibraryEmptyHint = computed(() => {
  return scriptSearch.value.trim() ? '没有匹配的脚本，清空搜索后再试。' : '点击新增生成脚本，或直接粘贴并保存你的脚本。'
})

watch(
  () => props.connectionId,
  () => {
    void loadScripts()
  },
  { immediate: true }
)

watch(
  () => selectedScript.value?.id ?? '',
  () => {
    selectedScriptDraft.value = selectedScript.value?.content ?? ''
    selectedScriptEditing.value = false
  },
  { immediate: true }
)

watch(
  () => messages.value.map((message) => `${message.id}:${message.text.length}:${message.streaming ? '1' : '0'}`).join('|'),
  scrollMessagesToLatest,
  { flush: 'post' }
)

async function loadScripts() {
  try {
    panelError.value = ''
    scripts.value = await listUpdateScripts(props.connectionId)
    scriptStoreMode.value = 'sqlite'
    if (!scripts.value.some((script) => script.id === selectedScriptId.value)) {
      selectedScriptId.value = scripts.value[0]?.id ?? ''
    }
  } catch (error) {
    if (!isTauriUnavailableError(error)) {
      panelError.value = formatError(error)
    }
    scriptStoreMode.value = 'preview'
    scripts.value = loadPreviewScripts(props.connectionId)
    selectedScriptId.value = scripts.value[0]?.id ?? ''
  }
}

function loadSelectedScript(scriptId: string) {
  selectedScriptId.value = scriptId
  selectedScriptDraft.value = scripts.value.find((item) => item.id === scriptId)?.content ?? ''
  selectedScriptEditing.value = false
  scriptPanelMode.value = 'library'
  scriptLibraryView.value = 'detail'
  panelError.value = ''
}

function openLibraryMode() {
  scriptPanelMode.value = 'library'
  scriptLibraryView.value = 'list'
  selectedScriptEditing.value = false
  panelError.value = ''
  focusLibrarySearch()
}

function returnToScriptList() {
  scriptLibraryView.value = 'list'
  selectedScriptEditing.value = false
  focusLibrarySearch()
}

function openGenerateMode() {
  scriptPanelMode.value = 'generate'
  panelError.value = ''
}

function focusLibrarySearch() {
  void nextTick(() => {
    librarySearchInput.value?.focus()
  })
}

function startRecording() {
  openGenerateMode()
  emit('startRecording')
  panelError.value = ''
  messages.value = []
}

function stopRecording() {
  emit('stopRecording')
}

function clearRecording() {
  emit('clearRecording')
  clearConversation()
}

function clearConversation() {
  messages.value = []
  scriptDrafts.value = {}
  editingMessageId.value = ''
  collapsedMessages.value = {}
  scriptRepliesExpanded.value = false
  panelError.value = ''
  saveState.value = 'idle'
}

function lineNumbersForScript(content: string) {
  const lineCount = Math.max(1, content.split('\n').length)
  return Array.from({ length: lineCount }, (_, index) => String(index + 1)).join('\n')
}

function highlightShellScript(content: string) {
  return content.split('\n').map((line) => highlightShellLine(line) || ' ').join('\n')
}

function highlightShellLine(line: string) {
  const tokenPattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#[^\n]*|\$\{?[A-Za-z_][\w]*\}?|\b(?:sudo|apt|apt-get|yum|dnf|pacman|brew|systemctl|service|docker|kubectl|rm|cp|mv|sed|awk|grep|find|chmod|chown|curl|wget|echo|cat|mkdir|touch|tar|ssh|scp|rsync|if|then|else|fi|for|do|done|while|case|esac|function|export|exit|return)\b|&&|\|\||[|;&<>])/g
  let cursor = 0
  let html = ''
  let match: RegExpExecArray | null
  while ((match = tokenPattern.exec(line)) !== null) {
    html += escapeHtml(line.slice(cursor, match.index))
    html += wrapShellToken(match[0])
    cursor = tokenPattern.lastIndex
  }
  html += escapeHtml(line.slice(cursor))
  return html
}

function wrapShellToken(token: string) {
  const escaped = escapeHtml(token)
  if (token.startsWith('#')) return `<span class="shell-token comment">${escaped}</span>`
  if (token.startsWith('"') || token.startsWith("'")) return `<span class="shell-token string">${escaped}</span>`
  if (token.startsWith('$')) return `<span class="shell-token variable">${escaped}</span>`
  if (/^(?:&&|\|\||[|;&<>])$/.test(token)) return `<span class="shell-token operator">${escaped}</span>`
  return `<span class="shell-token command">${escaped}</span>`
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

async function sendScriptRequest(mode: 'generate' | 'revise' | 'regenerate' = hasDraftScript.value ? 'revise' : 'generate') {
  if (scriptPanelMode.value !== 'generate') openGenerateMode()
  if (isGenerating.value) return
  const explicitText = askText.value.trim()
  const hasScriptContext = hasDraftScript.value || recordingHasData.value || sourceCommands.value.length > 0
  if (!hasScriptContext && !explicitText) {
    panelError.value = '请先录制操作、粘贴脚本，或描述你要生成的脚本。'
    return
  }
  const text = explicitText || defaultScriptRequest(mode)
  if (!hasUsableConfig.value) {
    panelError.value = '暂无可用 AI 配置，请先在左侧配置菜单中新建或完善配置。'
    return
  }

  const userMessage = createMessage('user', text)
  const assistantMessage = createMessage('assistant', '', '', true)
  messages.value = [...messages.value, userMessage, assistantMessage]
  scriptRepliesExpanded.value = true
  askText.value = ''
  panelError.value = ''
  isGenerating.value = true
  stopRequested.value = false
  collapsedMessages.value = {
    ...collapsedMessages.value,
    [assistantMessage.id]: false
  }

  const apiKey = props.config.apiKey?.trim() || props.apiKey.trim()
  const requestId = `${props.connectionId}-${props.workspaceSessionId}-script-${Date.now()}`
  currentRequestId.value = requestId
  currentAssistantMessageId.value = assistantMessage.id
  const prompt = buildScriptPrompt(text, mode)
  let answer = ''
  let unlisten: (() => void) | undefined
  try {
    unlisten = await onAiChatStream(requestId, (event) => {
      if (stopRequested.value || currentRequestId.value !== requestId) return
      if (event.kind === 'chunk') {
        answer += event.delta
        updateAssistantMessage(assistantMessage.id, answer, true)
      }
      if (event.kind === 'error' && event.error) {
        if (stopRequested.value) return
        updateAssistantMessage(assistantMessage.id, `模型调用失败。\n\n错误详情：${event.error}`, false, true)
      }
    })
    const response = await chatWithAiProviderStream(requestId, {
      config: props.config,
      apiKey,
      question: prompt,
      terminalSnapshot: recordedOutput.value || props.terminalSnapshot,
      commandHistory: sourceCommands.value
    })
    if (stopRequested.value || currentRequestId.value !== requestId) return
    const finalAnswer = answer || response.answer
    const script = extractBashScript(finalAnswer)
    updateAssistantMessage(assistantMessage.id, displayAnswerWithoutScript(finalAnswer), false, false, script)
    if (script) {
      applyDraftScript(script, assistantMessage.id)
      saveState.value = 'idle'
    }
  } catch (error) {
    if (stopRequested.value || currentRequestId.value !== requestId) return
    updateAssistantMessage(assistantMessage.id, `模型调用失败。\n\n错误详情：${formatError(error)}`, false, true)
  } finally {
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
    const stoppedText = message.text.trim()
      ? `${message.text.trimEnd()}\n\n[已停止回答]`
      : '[已停止回答]'
    updateAssistantMessage(message.id, stoppedText, false, false, message.scriptContent ?? '')
  }
  currentRequestId.value = ''
  currentAssistantMessageId.value = ''
  isGenerating.value = false
}

function createMessage(role: ScriptChatMessage['role'], text: string, scriptContent = '', streaming = false): ScriptChatMessage {
  return {
    id: `script-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    text,
    scriptContent,
    streaming
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

async function saveMessageScript(message: ScriptChatMessage) {
  const content = scriptContentForMessage(message).trimEnd()
  if (!content.trim()) {
    panelError.value = '当前没有可保存的脚本内容。'
    return
  }
  const now = nowText()
  const id = message.savedScriptId || `script-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const existing = scripts.value.find((script) => script.id === id)
  const fallbackName = inferScriptName(content, existing?.name || '服务更新脚本')
  const shouldGenerateName = !existing || isAutoScriptName(existing.name)
  const name = shouldGenerateName
    ? await generateScriptTitle(content, fallbackName, userRequestForAssistantMessage(message.id))
    : existing.name
  const script: UpdateScript = {
    id,
    connectionId: props.connectionId,
    workspaceSessionId: props.workspaceSessionId,
    name,
    description: inferDescription(message.text),
    content,
    sourceCommands: sourceCommands.value,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
  try {
    saveState.value = 'saving'
    panelError.value = ''
    if (scriptStoreMode.value === 'sqlite') {
      await saveUpdateScript(script)
    } else {
      savePreviewScript(script)
    }
    scripts.value = [script, ...scripts.value.filter((item) => item.id !== script.id)]
    selectedScriptId.value = script.id
    markMessageSaved(message.id, script.id, content)
    saveState.value = 'saved'
  } catch (error) {
    if (isTauriUnavailableError(error)) {
      scriptStoreMode.value = 'preview'
      savePreviewScript(script)
      scripts.value = [script, ...scripts.value.filter((item) => item.id !== script.id)]
      selectedScriptId.value = script.id
      markMessageSaved(message.id, script.id, content)
      saveState.value = 'saved'
      return
    }
    saveState.value = 'error'
    panelError.value = formatError(error)
  }
}

function openRenameScriptDialog(script: UpdateScript) {
  renamingScript.value = script
  scriptNameDraft.value = script.name
}

function closeRenameScriptDialog() {
  renamingScript.value = null
  scriptNameDraft.value = ''
}

async function renameScript() {
  const script = renamingScript.value
  const nextName = scriptNameDraft.value.trim()
  if (!script || !nextName || nextName === script.name) {
    closeRenameScriptDialog()
    return
  }
  const updated: UpdateScript = {
    ...script,
    name: nextName,
    updatedAt: nowText()
  }
  try {
    panelError.value = ''
    if (scriptStoreMode.value === 'sqlite') {
      await saveUpdateScript(updated)
    } else {
      savePreviewScript(updated)
    }
    scripts.value = scripts.value.map((item) => (item.id === script.id ? updated : item))
    messages.value = messages.value.map((message) => {
      if (message.savedScriptId !== script.id) return message
      return {
        ...message,
        text: message.text || `已打开脚本：${updated.name}`
      }
    })
  } catch (error) {
    panelError.value = formatError(error)
  } finally {
    closeRenameScriptDialog()
  }
}

async function removeScript(script: UpdateScript) {
  if (!script) return
  if (!window.confirm(`删除脚本 ${script.name}？`)) return
  try {
    if (scriptStoreMode.value === 'sqlite') {
      await deleteUpdateScript(script.id)
    } else {
      deletePreviewScript(props.connectionId, script.id)
    }
    scripts.value = scripts.value.filter((item) => item.id !== script.id)
    selectedScriptId.value = scripts.value[0]?.id ?? ''
    messages.value = messages.value.map((message) => message.savedScriptId === script.id ? { ...message, savedScriptId: undefined } : message)
  } catch (error) {
    panelError.value = formatError(error)
  }
}

function executeMessageScript(message: ScriptChatMessage) {
  const content = scriptContentForMessage(message).trim()
  if (!content) return
  executeScriptContent(content)
}

function executeSelectedScript() {
  const content = selectedScriptContent.value.trim()
  if (!content) return
  executeScriptContent(content)
}

function executeScriptContent(content: string) {
  const risks = analyzeScriptRisks(content)
  if (risks.length > 0) {
    pendingScriptExecution.value = content
    panelError.value = ''
    scriptExecutionNotice.value = ''
    return
  }
  writeScriptToTerminal(content)
  panelError.value = ''
  scriptExecutionNotice.value = '未检测到风险命令，已发送到当前终端。'
}

function writeScriptToTerminal(content: string) {
  emit('writeTerminalInput', `bash -s <<'AI_TERM_SCRIPT'\n${content}\nAI_TERM_SCRIPT\n`)
}

function confirmPendingScriptExecution() {
  const content = pendingScriptExecution.value.trim()
  if (!content) return
  writeScriptToTerminal(content)
  scriptExecutionNotice.value = '已确认风险命令，脚本已发送到当前终端。'
  closeScriptRiskConfirm()
}

function closeScriptRiskConfirm() {
  pendingScriptExecution.value = ''
}
function toggleSelectedScriptEditor() {
  if (!selectedScript.value) return
  selectedScriptEditing.value = !selectedScriptEditing.value
}

function updateSelectedScriptDraft(value: string) {
  selectedScriptDraft.value = value
}

async function saveSelectedScript() {
  const script = selectedScript.value
  if (!script) return
  const content = selectedScriptContent.value.trimEnd()
  if (!content.trim()) {
    panelError.value = '当前没有可保存的脚本内容。'
    return
  }
  const updated: UpdateScript = {
    ...script,
    content,
    updatedAt: nowText()
  }
  try {
    saveState.value = 'saving'
    panelError.value = ''
    if (scriptStoreMode.value === 'sqlite') {
      await saveUpdateScript(updated)
    } else {
      savePreviewScript(updated)
    }
    scripts.value = scripts.value.map((item) => (item.id === updated.id ? updated : item))
    selectedScriptDraft.value = content
    selectedScriptEditing.value = false
    saveState.value = 'saved'
  } catch (error) {
    saveState.value = 'error'
    panelError.value = formatError(error)
  }
}

function markMessageSaved(messageId: string, scriptId: string, content: string) {
  messages.value = messages.value.map((message) => {
    if (message.id !== messageId) return message
    return {
      ...message,
      savedScriptId: scriptId,
      scriptContent: content
    }
  })
  scriptDrafts.value = {
    ...scriptDrafts.value,
    [messageId]: content
  }
}

function toggleScriptEditor(message: ScriptChatMessage) {
  if (editingMessageId.value === message.id) {
    editingMessageId.value = ''
    return
  }
  scriptDrafts.value = {
    ...scriptDrafts.value,
    [message.id]: scriptContentForMessage(message)
  }
  editingMessageId.value = message.id
}

function updateScriptDraft(messageId: string, value: string) {
  scriptDrafts.value = {
    ...scriptDrafts.value,
    [messageId]: value
  }
}

function scriptContentForMessage(message: ScriptChatMessage) {
  return scriptDrafts.value[message.id] ?? message.scriptContent ?? ''
}

function messageContentForCollapse(message: ScriptChatMessage) {
  return [message.text, scriptContentForMessage(message)].filter(Boolean).join('\n')
}

function shouldCollapseMessage(message: ScriptChatMessage) {
  const content = messageContentForCollapse(message)
  return content.length > LONG_MESSAGE_CHARS || content.split('\n').length > LONG_MESSAGE_LINES
}

function isMessageCollapsed(message: ScriptChatMessage) {
  return shouldCollapseMessage(message) && Boolean(collapsedMessages.value[message.id])
}

function isMessageExpanded(message: ScriptChatMessage) {
  return !isMessageCollapsed(message)
}

function toggleMessage(messageId: string) {
  collapsedMessages.value = {
    ...collapsedMessages.value,
    [messageId]: !collapsedMessages.value[messageId]
  }
}

function applyDraftScript(content: string, messageId = '') {
  draftScriptContent.value = content
  if (messageId) {
    scriptDrafts.value = {
      ...scriptDrafts.value,
      [messageId]: content
    }
  }
}

function updateDraftScriptContent(value: string) {
  draftScriptContent.value = value
  saveState.value = 'idle'
}

function syncDraftLineRail(event: Event) {
  syncScriptEditorScroll(event, draftEditorLineRail.value, draftScriptHighlight.value)
}

function syncSelectedScriptLineRail(event: Event) {
  syncScriptEditorScroll(event, selectedScriptLineRail.value, selectedScriptHighlight.value)
}

function syncExpandedScriptLineRail(event: Event) {
  syncScriptEditorScroll(event, expandedScriptLineRail.value, expandedScriptHighlight.value)
}

function syncScriptEditorScroll(event: Event, lineRail: HTMLElement | null, highlightLayer: HTMLElement | null) {
  const target = event.target as HTMLTextAreaElement
  if (lineRail) lineRail.scrollTop = target.scrollTop
  if (highlightLayer) {
    highlightLayer.scrollTop = target.scrollTop
    highlightLayer.scrollLeft = target.scrollLeft
  }
}

async function saveDraftScript() {
  const content = draftScriptContent.value.trimEnd()
  if (!content.trim()) {
    panelError.value = '当前没有可保存的脚本内容。'
    return
  }
  const now = nowText()
  const existing = draftScriptId.value ? scripts.value.find((script) => script.id === draftScriptId.value) : undefined
  const fallbackName = inferScriptName(content, existing?.name || '脚本')
  const shouldGenerateName = !existing || isAutoScriptName(existing.name)
  const name = shouldGenerateName
    ? await generateScriptTitle(content, fallbackName, latestUserScriptRequest())
    : existing.name
  const script: UpdateScript = {
    id: existing?.id || `script-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    connectionId: props.connectionId,
    workspaceSessionId: props.workspaceSessionId,
    name,
    description: inferDescription(latestAssistantText()) || inferDescription(latestUserScriptRequest()) || '手动保存脚本',
    content,
    sourceCommands: sourceCommands.value,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
  try {
    saveState.value = 'saving'
    panelError.value = ''
    if (scriptStoreMode.value === 'sqlite') {
      await saveUpdateScript(script)
    } else {
      savePreviewScript(script)
    }
    scripts.value = [script, ...scripts.value.filter((item) => item.id !== script.id)]
    draftScriptId.value = script.id
    selectedScriptId.value = script.id
    selectedScriptDraft.value = content
    saveState.value = 'saved'
  } catch (error) {
    if (isTauriUnavailableError(error)) {
      scriptStoreMode.value = 'preview'
      savePreviewScript(script)
      scripts.value = [script, ...scripts.value.filter((item) => item.id !== script.id)]
      draftScriptId.value = script.id
      selectedScriptId.value = script.id
      selectedScriptDraft.value = content
      saveState.value = 'saved'
      return
    }
    saveState.value = 'error'
    panelError.value = formatError(error)
  }
}

function optimizeSelectedScript() {
  const script = selectedScript.value
  const content = selectedScriptContent.value.trimEnd()
  if (!script || !content.trim()) return
  draftScriptId.value = script.id
  draftScriptContent.value = content
  selectedScriptEditing.value = false
  openGenerateMode()
  if (!askText.value.trim()) {
    askText.value = '优化当前脚本，保留原意，并提升安全性、可读性和可复用性。'
  }
}

function executeDraftScript() {
  const content = draftScriptContent.value.trim()
  if (!content) {
    panelError.value = '当前脚本草稿为空，无法执行。'
    return
  }
  panelError.value = ''
  executeScriptContent(content)
}

async function copyDraftScript() {
  const content = draftScriptContent.value
  if (!content.trim()) {
    panelError.value = '当前脚本草稿为空，无法复制。'
    return
  }
  try {
    await navigator.clipboard.writeText(content)
    panelError.value = ''
  } catch (error) {
    panelError.value = `复制脚本失败：${formatError(error)}`
  }
}

async function copySelectedScript() {
  const content = selectedScriptContent.value
  if (!content.trim()) {
    panelError.value = '当前脚本为空，无法复制。'
    return
  }
  try {
    await navigator.clipboard.writeText(content)
    panelError.value = ''
  } catch (error) {
    panelError.value = `复制脚本失败：${formatError(error)}`
  }
}

function openScriptPreview(source: Exclude<ScriptPreviewSource, ''>) {
  scriptPreviewSource.value = source
  panelError.value = ''
}

function closeScriptPreview() {
  scriptPreviewSource.value = ''
}

async function copyExpandedScript() {
  const content = expandedScriptContent.value
  if (!content.trim()) {
    panelError.value = '当前脚本为空，无法复制。'
    return
  }
  try {
    await navigator.clipboard.writeText(content)
    panelError.value = ''
  } catch (error) {
    panelError.value = `复制脚本失败：${formatError(error)}`
  }
}

function executeExpandedScript() {
  const content = expandedScriptContent.value.trim()
  if (!content) {
    panelError.value = '当前脚本为空，无法执行。'
    return
  }
  panelError.value = ''
  executeScriptContent(content)
}

async function regenerateSelectedScript() {
  const script = selectedScript.value
  const content = selectedScriptContent.value.trimEnd()
  if (!script || !content.trim()) {
    panelError.value = '当前脚本为空，无法重新生成。'
    return
  }
  draftScriptId.value = script.id
  draftScriptContent.value = content
  selectedScriptDraft.value = content
  panelError.value = ''
  await sendScriptRequest('regenerate')
}

function latestUserScriptRequest() {
  return [...messages.value].reverse().find((message) => message.role === 'user')?.text ?? askText.value.trim()
}

function latestAssistantText() {
  return [...messages.value].reverse().find((message) => message.role === 'assistant')?.text ?? ''
}

function defaultScriptRequest(mode: 'generate' | 'revise' | 'regenerate') {
  if (mode === 'regenerate') return '基于当前上下文重新生成一版脚本。'
  if (mode === 'revise') return '优化当前脚本，保留原意，并提升安全性、可读性和可复用性。'
  return '生成一个可复用脚本，保留变量、检查和安全确认。'
}

function createScriptConversation() {
  openGenerateMode()
  messages.value = []
  scriptDrafts.value = {}
  editingMessageId.value = ''
  selectedScriptId.value = ''
  draftScriptId.value = ''
  draftScriptContent.value = ''
  collapsedMessages.value = {}
  scriptRepliesExpanded.value = false
  saveState.value = 'idle'
  panelError.value = ''
}

function handleComposerKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter') return
  if (event.isComposing) return
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault()
    void sendScriptRequest()
  }
}

function scrollMessagesToLatest() {
  void nextTick(() => {
    requestAnimationFrame(() => {
      const list = messageList.value
      if (!list) return
      list.scrollTop = list.scrollHeight
    })
  })
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
    `录制命令数：${recordedCommands.value.length}；用于生成的命令数：${sourceCommands.value.length}；录制输出字符数：${recordedOutput.value.length}`,
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
    sourceCommands.value.length ? sourceCommands.value.map((command) => `- ${command}`).join('\n') : '- 无',
    '',
    '录制期间终端输出摘要原文：',
    recordedOutput.value || '(无录制输出，将只能参考当前历史命令或当前脚本草稿)'
  ].join('\n')
}

function compactHistoryCommands(history: CommandHistoryEntry[], limit: number) {
  return compactCommands(history.map((entry) => entry.command), limit)
}

function compactCommands(commands: string[], limit: number) {
  const selected: string[] = []
  const seen = new Set<string>()
  for (const raw of [...commands].reverse()) {
    const command = raw.trim().replace(/\s+/g, ' ')
    if (!command || isLowSignalCommand(command)) continue
    const key = command.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    selected.push(raw.trim())
    if (selected.length >= limit) break
  }
  return selected.reverse()
}

function isLowSignalCommand(command: string) {
  return /^(clear|history|pwd|date|whoami|exit|logout)$/.test(command.trim().toLowerCase())
}

function extractBashScript(answer: string) {
  const match = answer.match(/```(?:bash|sh|shell|zsh)?[ \t]*\n?([\s\S]*?)```/i)
  return match?.[1]?.trim() ?? ''
}

function displayAnswerWithoutScript(answer: string) {
  return answer.replace(/```(?:bash|sh|shell|zsh)?[ \t]*\n?[\s\S]*?```/i, '').trim() || '已生成脚本，可在卡片中编辑、保存或执行。'
}

function inferScriptName(content: string, fallback: string) {
  const nameMatch = content.match(/\b(?:SCRIPT_NAME|TASK_NAME|JOB_NAME)=['"]?([a-zA-Z0-9_.-]+)/)
  if (nameMatch?.[1]) return `${nameMatch[1]} 脚本`
  const serviceMatch = content.match(/\b(?:SERVICE_NAME|APP_NAME|SERVICE)=['"]?([a-zA-Z0-9_.-]+)/)
  if (serviceMatch?.[1]) return `${serviceMatch[1]} 脚本`
  const systemctlMatch = content.match(/\bsystemctl\s+(?:restart|reload|status)\s+([a-zA-Z0-9_.@-]+)/)
  if (systemctlMatch?.[1]) return `${systemctlMatch[1]} 脚本`
  return fallback.trim() || '脚本'
}

function inferDescription(answer: string) {
  const lines = answer
    .replace(/```[\s\S]*?```/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.slice(0, 2).join(' ').slice(0, 180)
}

function isAutoScriptName(name: string) {
  return ['服务更新脚本', '更新脚本', '脚本', 'untitled', 'untitled script'].includes(name.trim().toLowerCase())
}

function userRequestForAssistantMessage(messageId: string) {
  const index = messages.value.findIndex((message) => message.id === messageId)
  if (index < 0) return ''
  return [...messages.value.slice(0, index)].reverse().find((message) => message.role === 'user')?.text ?? ''
}

async function generateScriptTitle(content: string, fallback: string, userRequest: string) {
  const apiKey = props.config.apiKey?.trim() || props.apiKey.trim()
  if (!props.config.baseUrl.trim() || !props.config.model.trim() || !apiKey) return fallback
  try {
    const response = await generateAiScriptTitle({
      config: props.config,
      apiKey,
      userRequest: userRequest || '生成可复用脚本',
      scriptContent: content,
      sourceCommands: sourceCommands.value
    })
    return response.title.trim() || fallback
  } catch (error) {
    console.error('failed to generate AI script title', error)
    return fallback
  }
}

function isDangerousScript(content: string) {
  return analyzeScriptRisks(content).length > 0
}
function previewStorageKey(connectionId: string) {
  return `ai-term:update-scripts:${connectionId}`
}

function loadPreviewScripts(connectionId: string) {
  try {
    const raw = window.localStorage.getItem(previewStorageKey(connectionId))
    if (!raw) return []
    const value = JSON.parse(raw)
    return Array.isArray(value) ? (value as UpdateScript[]) : []
  } catch {
    return []
  }
}

function savePreviewScript(script: UpdateScript) {
  const nextScripts = [script, ...loadPreviewScripts(script.connectionId).filter((item) => item.id !== script.id)]
  window.localStorage.setItem(previewStorageKey(script.connectionId), JSON.stringify(nextScripts))
}

function deletePreviewScript(connectionId: string, scriptId: string) {
  const nextScripts = loadPreviewScripts(connectionId).filter((item) => item.id !== scriptId)
  window.localStorage.setItem(previewStorageKey(connectionId), JSON.stringify(nextScripts))
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function isTauriUnavailableError(error: unknown) {
  const message = formatError(error)
  return message.includes('__TAURI_IPC__') || message.includes('window.__TAURI_IPC__') || message.includes('invoke')
}

function nowText() {
  return new Date().toISOString()
}
</script>

<template>
  <section class="script-panel">
    <div class="workspace-section-head script-head">

      <div class="panel-actions">
        <button class="icon-button" type="button" title="脚本库" aria-label="脚本库" @click="openLibraryMode">&#9719;</button>
        <button class="text-button" type="button" title="新增脚本" @click="createScriptConversation">+ 新建脚本</button>
        <button v-if="!props.recording.isRecording" class="text-button primary-action" type="button" @click="startRecording">&#9655; 开始录制</button>
        <button v-else class="text-button danger" type="button" @click="stopRecording">结束录制</button>
        <button class="icon-button" type="button" title="清空录制" aria-label="清空录制" @click="clearRecording">&#9003;</button>
      </div>
    </div>

    <div v-if="renamingScript" class="modal-backdrop" role="presentation" @click.self="closeRenameScriptDialog">
      <form class="modal rename-modal" role="dialog" aria-modal="true" aria-label="编辑脚本名称" @submit.prevent="renameScript">
        <div class="modal-head">
          <div>
            <strong>编辑脚本名称</strong>
            <span>{{ renamingScript.name }}</span>
          </div>
          <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="closeRenameScriptDialog">&times;</button>
        </div>
        <label class="rename-field">
          <span>脚本名称</span>
          <input v-model="scriptNameDraft" autofocus maxlength="100" placeholder="输入脚本名称" />
        </label>
        <div class="modal-actions">
          <button class="text-button" type="button" @click="closeRenameScriptDialog">取消</button>
          <button class="text-button" type="submit" :disabled="!scriptNameDraft.trim()">保存</button>
        </div>
      </form>
    </div>

    <div v-if="scriptPreviewOpen" class="modal-backdrop script-preview-backdrop" role="presentation" @click.self="closeScriptPreview">
      <section class="modal script-preview-modal" role="dialog" aria-modal="true" aria-label="脚本放大预览">
        <div class="modal-head">
          <div>
            <strong>{{ expandedScriptTitle }}</strong>
            <span>脚本预览</span>
          </div>
          <div class="script-editor-tools">
            <button class="icon-button" type="button" title="复制脚本" aria-label="复制脚本" @click="copyExpandedScript">&#9634;</button>
            <button class="icon-button" type="button" title="执行脚本" aria-label="执行脚本" @click="executeExpandedScript">&#9655;</button>
            <button class="icon-button" type="button" title="关闭预览" aria-label="关闭预览" @click="closeScriptPreview">&times;</button>
          </div>
        </div>
        <div class="script-expanded-editor">
          <div class="script-editor-shell">
            <pre ref="expandedScriptLineRail" class="script-line-rail" aria-hidden="true">{{ expandedScriptLineNumbers }}</pre>
            <pre ref="expandedScriptHighlight" class="script-code-overlay" aria-hidden="true"><code v-html="expandedScriptHighlightedHtml" /></pre>
            <textarea
              :value="expandedScriptContent"
              readonly
              spellcheck="false"
              aria-label="脚本放大预览"
              @scroll="syncExpandedScriptLineRail"
            />
          </div>
          <div class="script-editor-statusbar">
            <span>预览模式</span>
            <span>UTF-8</span>
            <span>LF</span>
            <span>总字符数: {{ expandedScriptContent.length }}</span>
          </div>
        </div>
      </section>
    </div>

    <div v-if="scriptRiskConfirmOpen" class="modal-backdrop script-risk-backdrop" role="presentation" @click.self="closeScriptRiskConfirm">
      <section class="modal script-risk-modal" role="dialog" aria-modal="true" aria-label="危险脚本执行确认">
        <div class="modal-head">
          <div>
            <strong>检测到风险命令</strong>
            <span>执行前请确认命中的命令行</span>
          </div>
          <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="closeScriptRiskConfirm">&times;</button>
        </div>
        <div class="script-risk-body">
          <div class="script-risk-summary" aria-label="风险类型">
            <span
              v-for="risk in pendingScriptRiskSummary"
              :key="risk.kind"
              class="script-risk-chip"
              :class="[`risk-${risk.kind}`, risk.severity]"
            >
              <strong>{{ risk.label }}</strong>
              <small>{{ risk.message }}</small>
            </span>
          </div>
          <div class="script-risk-preview" role="region" aria-label="脚本风险预览">
            <div
              v-for="line in pendingScriptRiskLines"
              :key="line.number"
              class="script-risk-line"
              :class="[line.riskClass, { flagged: line.risks.length }]"
            >
              <span class="script-risk-line-no">{{ line.number }}</span>
              <code>{{ line.text || ' ' }}</code>
              <span v-if="line.risks.length" class="script-risk-line-label">{{ riskLabelsForLine(line.risks) }}</span>
            </div>
          </div>
        </div>
        <div class="modal-actions script-risk-actions">
          <button class="text-button" type="button" @click="closeScriptRiskConfirm">取消</button>
          <button class="text-button danger" type="button" @click="confirmPendingScriptExecution">确认执行</button>
        </div>
      </section>
    </div>
    <p v-if="panelError" class="script-feedback error">{{ panelError }}</p>
    <p v-else-if="scriptExecutionNotice" class="script-feedback">{{ scriptExecutionNotice }}</p>
    <p v-else-if="saveState === 'saved'" class="script-feedback">脚本已保存到 {{ scriptStoreMode === 'sqlite' ? 'SQLite' : 'localStorage' }}.</p>

    <div v-if="scriptPanelMode === 'library'" class="script-library">
      <template v-if="scriptLibraryView === 'list'">
        <div class="session-search script-library-search">
          <span>&#8981;</span>
          <input ref="librarySearchInput" v-model="scriptSearch" placeholder="搜索脚本..." aria-label="搜索脚本" />
        </div>

        <div v-if="filteredScripts.length === 0" class="script-library-empty">
          <strong>No scripts</strong>
          <span>{{ scriptLibraryEmptyHint }}</span>
        </div>

        <div v-else class="script-library-body">
          <div class="script-library-list">
            <article
              v-for="script in filteredScripts"
              :key="script.id"
              class="script-library-row"
              :class="{ active: script.id === selectedScriptId }"
              role="button"
              tabindex="0"
              @click="loadSelectedScript(script.id)"
              @keydown.enter.prevent="loadSelectedScript(script.id)"
            >
              <span>
                <strong>{{ script.name }}</strong>
                <small>{{ script.description || script.updatedAt }}</small>
              </span>
              <button class="icon-button" type="button" title="编辑脚本名" aria-label="编辑脚本名" @click.stop="openRenameScriptDialog(script)">&#9998;</button>
              <button class="icon-button danger" type="button" title="删除脚本" aria-label="删除脚本" @click.stop="removeScript(script)">&#9003;</button>
            </article>
          </div>
        </div>
      </template>

      <section v-else-if="scriptLibraryView === 'detail' && selectedScript" class="script-preview">
        <div class="script-library-editor">
          <div class="script-editor-toolbar">
            <div class="script-file-tab">
              <span class="script-file-icon">sh</span>
              <strong>{{ selectedScript.name }}</strong>
              <span class="record-dot active" aria-hidden="true" />
              <span class="script-editor-risk" :class="`risk-${selectedScriptRiskStatus.level}`">{{ selectedScriptRiskStatus.label }}</span>
            </div>
            <div class="script-editor-tools">

              <button class="icon-button" type="button" title="返回列表" aria-label="返回列表" @click="returnToScriptList">&#8592;</button>
              <button class="icon-button" type="button" title="保存脚本" aria-label="保存脚本" @click="saveSelectedScript">&#10515;</button>
              <button class="icon-button" type="button" title="重新生成脚本" aria-label="重新生成脚本" :disabled="isGenerating" @click="regenerateSelectedScript">&#8635;</button>
              <button class="icon-button" type="button" title="执行脚本" aria-label="执行脚本" @click="executeSelectedScript">&#9655;</button>
              <button class="icon-button" type="button" title="复制脚本" aria-label="复制脚本" @click="copySelectedScript">&#9634;</button>
              <button class="icon-button" type="button" title="放大预览" aria-label="放大预览" @click="openScriptPreview('selected')">&#9974;</button>
            </div>
          </div>
          <div class="script-editor-shell">
            <pre ref="selectedScriptLineRail" class="script-line-rail" aria-hidden="true">{{ selectedScriptLineNumbers }}</pre>
            <pre ref="selectedScriptHighlight" class="script-code-overlay" aria-hidden="true"><code v-html="selectedScriptHighlightedHtml" /></pre>
            <textarea
              :value="selectedScriptContent"
              spellcheck="false"
              aria-label="编辑脚本"
              @input="updateSelectedScriptDraft(($event.target as HTMLTextAreaElement).value)"
              @scroll="syncSelectedScriptLineRail"
            />
          </div>
          <div class="script-editor-statusbar">
            <span>行 1, 列 1</span>
            <span>UTF-8</span>
            <span>LF</span>
            <span>总字符数: {{ selectedScriptContent.length }}</span>
          </div>
        </div>
      </section>
      <p v-else class="empty-state script-preview-empty">选择脚本查看内容</p>
    </div>

    <div v-else class="script-generate">
      <div class="script-recorder">
        <span class="record-dot" :class="{ active: props.recording.isRecording }" />
        <div>
          <strong>{{ props.recording.isRecording ? '正在录制操作上下文' : recordingHasData ? '录制上下文已就绪' : '可录制操作，也可直接粘贴脚本' }}</strong>
          <small>{{ recordedCommands.length }} recorded commands &middot; {{ recordedOutput.length }} output chars</small>
        </div>
      </div>

      <div class="script-workbench">
        <section class="script-draft-card">

          <div class="script-editor-toolbar">
            <div class="script-file-tab">
              <span class="script-file-icon">sh</span>
              <span class="record-dot active" aria-hidden="true" />
              <span class="script-editor-risk" :class="`risk-${draftScriptRiskStatus.level}`">{{ draftScriptRiskStatus.label }}</span>
            </div>
            <div class="script-editor-tools">

              <button class="icon-button" type="button" title="保存脚本草稿" aria-label="保存脚本草稿" @click="saveDraftScript">&#10515;</button>
              <button class="icon-button" type="button" title="重新生成脚本" aria-label="重新生成脚本" :disabled="isGenerating" @click="sendScriptRequest('regenerate')">&#8635;</button>
              <button class="icon-button" type="button" title="执行脚本" aria-label="执行脚本" @click="executeDraftScript">&#9655;</button>
              <button class="icon-button" type="button" title="复制脚本" aria-label="复制脚本" @click="copyDraftScript">&#9634;</button>
              <button class="icon-button" type="button" title="放大预览" aria-label="放大预览" @click="openScriptPreview('draft')">&#9974;</button>
            </div>
          </div>
          <div class="script-editor-shell">
            <pre ref="draftEditorLineRail" class="script-line-rail" aria-hidden="true">{{ draftLineNumbers }}</pre>
            <pre ref="draftScriptHighlight" class="script-code-overlay" aria-hidden="true"><code v-html="draftScriptHighlightedHtml" /></pre>
            <textarea
              :value="draftScriptContent"
              spellcheck="false"
              aria-label="脚本草稿"
              @input="updateDraftScriptContent(($event.target as HTMLTextAreaElement).value)"
              @scroll="syncDraftLineRail"
            />
          </div>
          <div class="script-editor-statusbar">
            <span>行 1, 列 1</span>
            <span>UTF-8</span>
            <span>LF</span>
            <span>总字符数: {{ draftScriptContent.length }}</span>
          </div>
        </section>
      </div>

      <section v-if="hasScriptReplies" class="script-replies-panel" :class="{ expanded: scriptRepliesExpanded }">
        <button class="script-replies-toggle" type="button" :aria-expanded="scriptRepliesExpanded" @click="scriptRepliesExpanded = !scriptRepliesExpanded">
          <span>AI 回复</span>
          <small>{{ isGenerating ? '生成中' : scriptReplyCountText }}</small>
          <span>{{ scriptRepliesExpanded ? '收起' : '展开' }}</span>
        </button>
        <div v-if="scriptRepliesExpanded" ref="messageList" class="script-replies-list">
          <article
            v-for="message in messages"
            :key="message.id"
            class="message script-reply-message"
            :class="{ error: message.error, ai: message.role === 'assistant', collapsed: isMessageCollapsed(message) }"
          >
            <div class="message-title">
              <span class="message-identity">
                <span class="message-avatar">{{ message.role === 'assistant' ? 'AI' : 'U' }}</span>
                <strong>{{ message.role === 'assistant' ? 'AI' : 'You' }}<span v-if="message.streaming" class="streaming-dot">输出中</span></strong>
              </span>
              <div class="script-reply-actions">
                <button v-if="shouldCollapseMessage(message)" class="text-button" type="button" @click="toggleMessage(message.id)">
                  {{ isMessageExpanded(message) ? '收起' : '展开' }}
                </button>
              </div>
            </div>
            <div class="message-body">
              <div v-if="message.streaming && !message.text" class="thinking-row"><span /><span /><span />正在处理脚本...</div>
              <p v-if="message.text">{{ message.text }}</p>
              <div v-if="message.scriptContent" class="code-block script-code-card">
                <div class="code-head">
                  <span>{{ message.savedScriptId ? '已保存' : '草稿' }}</span>
                  <span class="command-risk-status" :class="`risk-${scriptRiskStatusForContent(scriptContentForMessage(message)).level}`">{{ scriptRiskStatusForContent(scriptContentForMessage(message)).label }}</span>
                  <div class="script-reply-code-actions">
                    <button class="text-button" type="button" @click="toggleScriptEditor(message)">
                      {{ editingMessageId === message.id ? '完成' : '编辑' }}
                    </button>
                    <button class="text-button" type="button" @click="applyDraftScript(scriptContentForMessage(message), message.id)">设为草稿</button>
                    <button class="text-button" type="button" @click="saveMessageScript(message)">保存</button>
                    <button class="text-button primary-action" type="button" @click="executeMessageScript(message)">执行</button>
                  </div>
                </div>
                <textarea
                  v-if="editingMessageId === message.id"
                  :value="scriptContentForMessage(message)"
                  spellcheck="false"
                  aria-label="编辑脚本"
                  @input="updateScriptDraft(message.id, ($event.target as HTMLTextAreaElement).value)"
                />
                <pre v-else><code>{{ scriptContentForMessage(message) }}</code></pre>
              </div>
            </div>
          </article>
          <button class="text-button" type="button" @click="clearConversation">清空回复</button>
        </div>
      </section>
      <div v-if="showScriptComposer" class="assistant-compose script-compose">
        <textarea
          v-model="askText"
          rows="3"
          placeholder="描述你想修改或优化的脚本功能..."
          aria-label="Ask AI to generate script"
          @keydown="handleComposerKeydown"
        />
        <button
          class="icon-button"
          type="button"
          :title="isGenerating ? '停止回答' : '生成脚本'"
          :aria-label="isGenerating ? '停止回答' : '生成脚本'"
          @click="isGenerating ? stopScriptGeneration() : sendScriptRequest()"
        >
          {{ isGenerating ? '\u25a0' : '\u2192' }}
        </button>
      </div>
    </div>
  </section>
</template>
