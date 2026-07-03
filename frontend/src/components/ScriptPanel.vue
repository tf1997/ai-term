<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { AiProviderConfig } from '../types/profile'
import type { CommandHistoryEntry, ScriptRecording, UpdateScript } from '../types/workspace'
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
const MAX_SCRIPT_SOURCE_COMMANDS = 80
const MAX_RECORDED_OUTPUT_CHARS = 80_000

const scripts = ref<UpdateScript[]>([])
const selectedScriptId = ref('')
const saveState = ref<SaveState>('idle')
const panelError = ref('')
const isGenerating = ref(false)
const scriptStoreMode = ref<'sqlite' | 'preview'>('sqlite')
const scriptPanelMode = ref<ScriptPanelMode>('library')
const askText = ref('把这次录制整理成下次可复用的更新脚本，保留变量和健康检查。')
const messages = ref<ScriptChatMessage[]>([])
const messageList = ref<HTMLElement | null>(null)
const historyPopover = ref<HTMLElement | null>(null)
const historyButton = ref<HTMLButtonElement | null>(null)
const historyOpen = ref(false)
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
const showScriptComposer = computed(() => scriptPanelMode.value === 'generate' && recordingHasData.value)
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
  openLibraryMode()
}

function openLibraryMode() {
  scriptPanelMode.value = 'library'
  historyOpen.value = false
  panelError.value = ''
}

function openGenerateMode() {
  scriptPanelMode.value = 'generate'
  historyOpen.value = false
  panelError.value = ''
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
  messages.value = []
  panelError.value = ''
}

async function sendScriptRequest() {
  if (scriptPanelMode.value !== 'generate') openGenerateMode()
  const text = askText.value.trim()
  if (!text || isGenerating.value) return
  if (!recordingHasData.value) {
    panelError.value = '请先开启录制并完成一次更新操作，或至少保留当前会话中的历史命令。'
    return
  }
  if (!hasUsableConfig.value) {
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

  const apiKey = props.config.apiKey?.trim() || props.apiKey.trim()
  const requestId = `${props.connectionId}-${props.workspaceSessionId}-script-${Date.now()}`
  currentRequestId.value = requestId
  currentAssistantMessageId.value = assistantMessage.id
  const prompt = buildScriptPrompt(text)
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
      scriptDrafts.value = {
        ...scriptDrafts.value,
        [assistantMessage.id]: script
      }
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
  historyOpen.value = false
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
  if (isDangerousScript(content)) {
    const confirmed = window.confirm(`检测到高风险脚本，确认要在当前终端执行吗？\n\n${content.slice(0, 1200)}`)
    if (!confirmed) return
  }
  emit('writeTerminalInput', `bash -s <<'AI_TERM_SCRIPT'\n${content}\nAI_TERM_SCRIPT\n`)
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

function toggleHistory() {
  historyOpen.value = !historyOpen.value
}

function handleDocumentPointerDown(event: PointerEvent) {
  if (!historyOpen.value) return
  const target = event.target
  if (!(target instanceof Node)) return
  if (historyPopover.value?.contains(target)) return
  if (historyButton.value?.contains(target)) return
  historyOpen.value = false
}

function createScriptConversation() {
  openGenerateMode()
  messages.value = []
  scriptDrafts.value = {}
  editingMessageId.value = ''
  selectedScriptId.value = ''
  historyOpen.value = false
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

function buildScriptPrompt(userRequest: string) {
  return [
    '你是 AI Term 的服务器更新脚本整理助手。',
    '用户会先录制一次真实的服务器更新过程，你需要根据录制期间的命令和终端输出，生成下次可复用、允许用户继续编辑的 bash 脚本。',
    '',
    `用户要求：${userRequest}`,
    `录制状态：${props.recording.isRecording ? '仍在录制' : props.recording.stoppedAt ? '已结束录制' : '未主动结束录制'}`,
    `录制命令数：${recordedCommands.value.length}；用于生成的命令数：${sourceCommands.value.length}；录制输出字符数：${recordedOutput.value.length}`,
    '',
    '生成要求：',
    '1. 优先输出一个完整 bash 代码块，代码块语言标记为 bash。',
    '2. 脚本必须包含 set -euo pipefail、可修改变量、关键路径、构建/发布/重启/健康检查步骤。',
    '3. 从录制内容提炼真实操作，不要编造上下文里没有出现的服务名、路径、端口或仓库地址；未知值用变量和 TODO 注释。',
    '4. 去掉纯查看类和试错类命令，只保留更新脚本真正需要的步骤。',
    '5. 对 rm、覆盖配置、重启、删除、数据库迁移等风险操作加注释和确认变量。',
    '6. 代码块后用简短文字列出用户下次执行前需要确认的变量。',
    '',
    '录制期间命令：',
    sourceCommands.value.length ? sourceCommands.value.map((command) => `- ${command}`).join('\n') : '- 无',
    '',
    '录制期间终端输出摘要原文：',
    recordedOutput.value || '(无录制输出，将只能参考当前历史命令)'
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
  const serviceMatch = content.match(/\b(?:SERVICE_NAME|APP_NAME|SERVICE)=["']?([a-zA-Z0-9_.-]+)/)
  if (serviceMatch?.[1]) return `${serviceMatch[1]} 更新脚本`
  const systemctlMatch = content.match(/\bsystemctl\s+(?:restart|reload)\s+([a-zA-Z0-9_.@-]+)/)
  if (systemctlMatch?.[1]) return `${systemctlMatch[1]} 更新脚本`
  return fallback.trim() || '服务更新脚本'
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
  return ['服务更新脚本', '更新脚本', 'untitled', 'untitled script'].includes(name.trim().toLowerCase())
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
      userRequest: userRequest || '生成服务器更新脚本',
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
  const normalized = content.toLowerCase().replace(/\s+/g, ' ')
  const dangerousPatterns = [
    /\brm\s+(-[a-z]*[rf][a-z]*|-r|-f)\b/,
    /\bsudo\s+rm\b/,
    /\bdd\s+.*\bof=\/dev\//,
    /\bmkfs(\.| |$)/,
    /\bshutdown\b/,
    /\breboot\b/,
    /\bpoweroff\b/,
    /\bkillall\b/,
    /\bpkill\b/,
    /\bchmod\s+(-r\s+)?777\b/,
    /\bfind\b.*\s-delete\b/,
    /\bdocker\s+system\s+prune\b.*\s-a\b/,
    /\bkubectl\s+delete\b/,
    /\biptables\s+-f\b/,
    /\bnft\s+flush\b/
  ]
  return dangerousPatterns.some((pattern) => pattern.test(normalized))
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

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointerDown, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown, true)
})
</script>

<template>
  <section class="script-panel">
    <div class="workspace-section-head script-head">
      <div>
        <strong>更新脚本助手</strong>
        <span>{{ props.recording.isRecording ? 'recording' : 'idle' }} &middot; {{ sourceCommands.length }} commands &middot; {{ recordedOutput.length }} chars</span>
      </div>
      <div class="panel-actions">
        <button ref="historyButton" class="icon-button" type="button" title="脚本库" aria-label="脚本库" @click="toggleHistory">&#9719;</button>
        <button class="icon-button" type="button" title="新建脚本会话" aria-label="新建脚本会话" @click="createScriptConversation">+</button>
        <button v-if="!props.recording.isRecording" class="text-button" type="button" @click="startRecording">开始录制</button>
        <button v-else class="text-button danger" type="button" @click="stopRecording">结束录制</button>
        <button class="icon-button" type="button" title="清空录制" aria-label="清空录制" @click="clearRecording">&#9003;</button>
      </div>
      <div v-if="historyOpen" ref="historyPopover" class="session-history-popover script-history-popover">
        <div class="session-search">
          <span>&#8981;</span>
          <input v-model="scriptSearch" placeholder="Search scripts..." aria-label="Search scripts" />
        </div>
        <div class="session-history-list">
          <article
            v-for="script in filteredScripts"
            :key="script.id"
            class="session-history-row"
            :class="{ active: script.id === selectedScriptId }"
            role="button"
            tabindex="0"
            @click="loadSelectedScript(script.id)"
            @keydown.enter.prevent="loadSelectedScript(script.id)"
          >
            <span class="session-history-main">
              <strong>{{ script.name }}</strong>
              <small>{{ script.description || script.updatedAt }}</small>
            </span>
            <span class="session-history-actions">
              <button class="icon-button" type="button" title="编辑脚本名" aria-label="编辑脚本名" @click.stop="openRenameScriptDialog(script)">&#9998;</button>
              <button class="icon-button danger" type="button" title="删除脚本" aria-label="删除脚本" @click.stop="removeScript(script)">&#9003;</button>
            </span>
          </article>
          <p v-if="filteredScripts.length === 0" class="empty-state">No scripts</p>
        </div>
      </div>
    </div>

    <div class="script-mode-tabs" role="tablist" aria-label="Script assistant mode">
      <button type="button" :class="{ active: scriptPanelMode === 'library' }" @click="openLibraryMode">脚本库</button>
      <button type="button" :class="{ active: scriptPanelMode === 'generate' }" @click="openGenerateMode">新增</button>
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

    <p v-if="panelError" class="script-feedback error">{{ panelError }}</p>
    <p v-else-if="saveState === 'saved'" class="script-feedback">脚本已保存到 {{ scriptStoreMode === 'sqlite' ? 'SQLite' : 'localStorage' }}.</p>

    <div v-if="scriptPanelMode === 'library'" class="script-library">
      <div class="session-search script-library-search">
        <span>&#8981;</span>
        <input v-model="scriptSearch" placeholder="Search scripts..." aria-label="Search scripts" />
      </div>
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
        </article>
        <p v-if="filteredScripts.length === 0" class="empty-state">No scripts</p>
      </div>

      <section v-if="selectedScript" class="script-preview">
        <div class="script-preview-head">
          <div>
            <strong>{{ selectedScript.name }}</strong>
            <span>{{ selectedScript.description || selectedScript.updatedAt }}</span>
          </div>
          <div class="script-card-actions">
            <button class="text-button" type="button" @click="toggleSelectedScriptEditor">
              {{ selectedScriptEditing ? '完成' : '编辑' }}
            </button>
            <button class="text-button" type="button" @click="saveSelectedScript">保存</button>
            <button class="text-button" type="button" @click="executeSelectedScript">执行</button>
            <button class="text-button danger" type="button" @click="removeScript(selectedScript)">删除</button>
          </div>
        </div>
        <textarea
          v-if="selectedScriptEditing"
          :value="selectedScriptContent"
          spellcheck="false"
          aria-label="编辑脚本"
          @input="updateSelectedScriptDraft(($event.target as HTMLTextAreaElement).value)"
        />
        <pre v-else class="script-preview-code"><code>{{ selectedScriptContent }}</code></pre>
      </section>
      <p v-else class="empty-state script-preview-empty">No scripts</p>
    </div>

    <div v-else class="script-generate">
      <div class="script-recorder">
        <span class="record-dot" :class="{ active: props.recording.isRecording }" />
        <div>
          <strong>{{ props.recording.isRecording ? '正在录制本次操作' : recordingHasData ? '录制片段已就绪' : '先录制一次真实更新操作' }}</strong>
          <small>{{ recordedCommands.length }} recorded commands &middot; {{ recordedOutput.length }} output chars</small>
        </div>
      </div>

      <div ref="messageList" class="script-chat-list">
        <p v-if="messages.length === 0" class="empty-state">录制完成后，再输入你希望 AI 生成的脚本目标。</p>
        <article v-for="message in messages" :key="message.id" class="message" :class="{ ai: message.role === 'assistant', error: message.error }">
          <div class="message-title">
            <strong>{{ message.role === 'assistant' ? 'AI' : 'You' }}<span v-if="message.streaming" class="streaming-dot">输出中</span></strong>
          </div>
          <div class="message-body">
            <div v-if="message.streaming && !message.text" class="thinking-row"><span /><span /><span />正在生成脚本...</div>
            <p v-if="message.text">{{ message.text }}</p>
            <div v-if="message.scriptContent" class="code-block script-code-card">
              <div class="code-head">
                <span>{{ message.savedScriptId ? 'bash saved' : 'bash' }}</span>
                <div class="script-card-actions">
                  <button class="text-button" type="button" @click="toggleScriptEditor(message)">
                    {{ editingMessageId === message.id ? '完成' : '编辑' }}
                  </button>
                  <button class="text-button" type="button" @click="saveMessageScript(message)">保存</button>
                  <button class="text-button" type="button" @click="executeMessageScript(message)">执行</button>
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
      </div>

      <div v-if="showScriptComposer" class="assistant-compose script-compose">
        <textarea
          v-model="askText"
          rows="3"
          placeholder="例如：根据刚才录制，生成灰度发布脚本，包含备份、构建、重启和健康检查。Ctrl+Enter / ⌘+Enter 发送"
          aria-label="Ask AI to generate script"
          @keydown="handleComposerKeydown"
        />
        <button
          class="icon-button"
          :disabled="!isGenerating && !hasUsableConfig"
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
