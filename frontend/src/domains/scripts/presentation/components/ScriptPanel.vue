<script setup lang="ts">
import { shellCommandForPart } from '../../domain/scriptPresentation'
import { useScriptExecution } from '../../application/useScriptExecution'
import { useScriptGeneration } from '../../application/useScriptGeneration'
import { useScriptLibrary } from '../../application/useScriptLibrary'
import { useScriptDrafts } from '../../application/useScriptDrafts'
import type { ScriptGenerationTarget } from '../../application/useScriptDrafts'
import { MAX_SCRIPT_SOURCE_COMMANDS, compactCommands, inferScriptName, inferDescription, isAutoScriptName, formatError, isTauriUnavailableError, nowText } from '../../domain/scriptPresentation'
import { cursorPositionForTextarea, lineNumbersForScript, highlightShellScript, readinessLinesText } from '../../domain/scriptEditor'
import type { ScriptPanelProps, ScriptPanelEvents, ScriptChatMessage, ScriptPanelMode, ScriptPreviewSource, ScriptEditorSource, EditorCursor } from '../../domain/scriptPanel'
import type { SaveState } from '../../../../shared/forms/configuration'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { trapTabFocus } from '../../../../shared/ui/overlays'

import type { UpdateScript } from '../../domain/recording'
import { riskLabelsForLine, scriptRiskStatusForContent } from '../../../../shared/security/scriptRisk'

import { scriptReadinessStatusForContent } from '../../domain/scriptReadiness'



import { generateAiScriptTitle, saveUpdateScript } from '../../infrastructure/api'
import { parseMessageParts, renderMarkdown } from '../../../../shared/content/aiMarkdown'
import type { MessagePart } from '../../../../shared/content/aiMarkdown'
import { codeBlockLabel } from '../../../../shared/shell/shellCommand'


import ContextMenu from '../../../../shared/ui/ContextMenu.vue'
import UiIcon from '../../../../shared/ui/UiIcon.vue'
import ScriptEditorContext from './ScriptEditorContext.vue'
import { detectShellScriptLanguage } from '../../../../shared/shell/shellCommand'

const props = defineProps<ScriptPanelProps>()

const emit = defineEmits<ScriptPanelEvents>()
const MAX_RECORDED_OUTPUT_CHARS = 80_000
const LONG_MESSAGE_CHARS = 900
const LONG_MESSAGE_LINES = 12
const saveState = ref<SaveState>('idle')
const lastSavedScriptId = ref('')
const panelError = ref('')
const { scriptExecutionNotice, pendingScriptExecution, pendingScriptSource, scriptRiskExplanation, scriptRiskExplanationError, scriptRiskExplanationLoading, scriptRiskExplanationRequestId, preparedScriptContent, pendingScriptRisks, scriptRiskConfirmOpen, pendingScriptRiskSummary, pendingScriptRiskLines, pendingScriptConnectionMismatch, pendingExecutionTitle, pendingExecutionSubtitle, buildScriptRiskExplanationPrompt, explainPendingScriptRisk, clearScriptRiskExplanation, executeScriptContent, writeScriptToTerminal, confirmPendingScriptExecution, closeScriptRiskConfirm, executionTargetsDifferFromSource } = useScriptExecution({
  props, emit, panelError, sourceCommands: () => sourceCommands.value,
  recordedOutput: () => recordedOutput.value, hasUsableConfig: () => hasUsableConfig.value,
  connectionLabel
})
const scriptPanelMode = ref<ScriptPanelMode>('generate')
const libraryOpen = ref(false)
const libraryButton = ref<HTMLButtonElement | null>(null)
const libraryPopover = ref<HTMLElement | null>(null)
const scriptHead = ref<HTMLElement | null>(null)
const libraryPosition = ref({ left: '0px', top: '0px', width: '300px', maxHeight: '400px' })
const askText = ref('')
const messages = ref<ScriptChatMessage[]>([])
const { scripts, selectedScriptId, scriptStoreMode, selectedScript, scriptSearch, filteredScripts, loadScripts, renamingScript, scriptNameDraft, openRenameScriptDialog, closeRenameScriptDialog, renameScript, removeScript, savePreviewScript, loadPreviewScripts, migratePreviewScripts } = useScriptLibrary({ panelError, messages, scriptSourceLabel })
const collapsedMessages = ref<Record<string, boolean>>({})
const messageList = ref<HTMLElement | null>(null)
const scriptComposerInput = ref<HTMLTextAreaElement | null>(null)
const draftEditorLineRail = ref<HTMLElement | null>(null)
const draftEditorTextarea = ref<HTMLTextAreaElement | null>(null)
const selectedScriptLineRail = ref<HTMLElement | null>(null)
const selectedScriptTextarea = ref<HTMLTextAreaElement | null>(null)
const expandedScriptLineRail = ref<HTMLElement | null>(null)
const expandedScriptTextarea = ref<HTMLTextAreaElement | null>(null)
const draftScriptHighlight = ref<HTMLElement | null>(null)
const selectedScriptHighlight = ref<HTMLElement | null>(null)
const expandedScriptHighlight = ref<HTMLElement | null>(null)
const librarySearchInput = ref<HTMLInputElement | null>(null)
const editingMessageId = ref('')
const scriptDrafts = ref<Record<string, string>>({})
const { documents, createDraft, ensureSaved, updateContent, snapshot, receiveGeneration, acceptPending, markSaved } = useScriptDrafts()
const draftScriptId = ref(createDraft({ connectionId: props.connectionId, workspaceSessionId: props.workspaceSessionId }).id)
const activeDraft = computed(() => documents.value[draftScriptId.value])
const selectedScriptDraft = computed({
  get: () => selectedScript.value ? ensureSaved(selectedScript.value).content : '',
  set: (content: string) => { if (selectedScript.value) updateContent(ensureSaved(selectedScript.value).id, content) }
})
const selectedScriptEditing = ref(false)
const draftScriptContent = computed({ get: () => activeDraft.value.content, set: (content: string) => updateContent(draftScriptId.value, content) })
const { isGenerating, currentTargetTitle, currentRequestId, currentAssistantMessageId, stopRequested, answerElapsedSeconds, answerDurations, sendScriptRequest, stopScriptGeneration, createMessage, updateAssistantMessage, startAnswerTimer, stopAnswerTimer, finishAnswerTimer, messageAnswerDuration, formatAnswerDuration, buildScriptPrompt, defaultScriptRequest } = useScriptGeneration({
  props, saveState, panelError, scriptPanelMode, askText, messages, collapsedMessages, draftScriptContent,
  recordedCommands: () => recordedCommands.value,
  sourceCommands: () => sourceCommands.value,
  recordedOutput: () => recordedOutput.value,
  recordingHasData: () => recordingHasData.value,
  scriptSourceConnectionId: () => scriptSourceConnectionId.value,
  scriptSourceWorkspaceSessionId: () => scriptSourceWorkspaceSessionId.value,
  hasDraftScript: () => hasDraftScript.value,
  hasUsableConfig: () => hasUsableConfig.value,
  openGenerateMode, captureTarget, applyGeneratedScript
})
const draftSourceConnectionId = computed({ get: () => activeDraft.value.connectionId, set: (value: string) => { activeDraft.value.connectionId = value } })
const draftSourceWorkspaceSessionId = computed({ get: () => activeDraft.value.workspaceSessionId, set: (value: string) => { activeDraft.value.workspaceSessionId = value } })
const draftSourceCommands = computed({ get: () => activeDraft.value.sourceCommands, set: (value: string[]) => { activeDraft.value.sourceCommands = value } })
const scriptPreviewSource = ref<ScriptPreviewSource>('')
const scriptEditorMenu = ref<{ source: ScriptEditorSource; x: number; y: number; sourceElement: HTMLElement } | null>(null)
const renameDialog = ref<HTMLElement | null>(null)
const previewDialog = ref<HTMLElement | null>(null)
const riskDialog = ref<HTMLElement | null>(null)
const draftEditorCursor = ref<EditorCursor>({ line: 1, column: 1 })
const selectedEditorCursor = ref<EditorCursor>({ line: 1, column: 1 })
const expandedEditorCursor = ref<EditorCursor>({ line: 1, column: 1 })
const draftReadinessIndex = ref(0)
const selectedReadinessIndex = ref(0)
const expandedReadinessIndex = ref(0)
const selectedScriptContent = computed(() => selectedScriptDraft.value)
const recordedCommands = computed(() => compactCommands(props.recording.commands, MAX_SCRIPT_SOURCE_COMMANDS))
const sourceCommands = computed(() => recordedCommands.value)
const recordedOutput = computed(() => {
  const output = props.recording.terminalOutput || ''
  return output.length > MAX_RECORDED_OUTPUT_CHARS ? output.slice(-MAX_RECORDED_OUTPUT_CHARS) : output
})
const recordingHasData = computed(() => recordedCommands.value.length > 0 || recordedOutput.value.trim().length > 0)
const scriptSourceConnectionId = computed(() => recordingHasData.value ? props.recording.connectionId : props.connectionId)
const scriptSourceWorkspaceSessionId = computed(() => {
  const sourceSessionId = recordingHasData.value ? props.recording.workspaceSessionId : props.workspaceSessionId
  return sourceSessionId || 'ai:default'
})
const hasDraftScript = computed(() => draftScriptContent.value.trim().length > 0)
const hasSelectedScriptContent = computed(() => selectedScriptContent.value.trim().length > 0)
const editingSelectedScript = computed(() => scriptPanelMode.value === 'library' && Boolean(selectedScript.value))
const showScriptComposer = computed(() => scriptPanelMode.value === 'generate' || editingSelectedScript.value)
const activeScriptHasContent = computed(() => editingSelectedScript.value ? hasSelectedScriptContent.value : hasDraftScript.value)
const scriptComposerPlaceholder = computed(() => {
  return activeScriptHasContent.value ? '让 AI 修改这个脚本...' : '描述要生成的脚本...'
})
const hasScriptReplies = computed(() => messages.value.length > 0)
const scriptReplyCountText = computed(() => `${messages.value.length} 条消息`)
const draftLineNumbers = computed(() => lineNumbersForScript(draftScriptContent.value))
const selectedScriptLineNumbers = computed(() => lineNumbersForScript(selectedScriptContent.value))
const scriptPreviewOpen = computed(() => scriptPreviewSource.value !== '')
const expandedScriptTitle = computed(() => scriptPreviewSource.value === 'selected' ? selectedScript.value?.name || '脚本' : draftScriptTitle.value)
const expandedScriptContent = computed(() => scriptPreviewSource.value === 'selected' ? selectedScriptContent.value : draftScriptContent.value)
const expandedScriptLineNumbers = computed(() => lineNumbersForScript(expandedScriptContent.value))
const draftSavedScript = computed(() => scripts.value.find((script) => script.id === draftScriptId.value))
const draftScriptHighlightedHtml = computed(() => highlightShellScript(draftScriptContent.value, draftSavedScript.value?.name))
const selectedScriptHighlightedHtml = computed(() => highlightShellScript(selectedScriptContent.value, selectedScript.value?.name))
const expandedScriptHighlightedHtml = computed(() => highlightShellScript(expandedScriptContent.value, expandedScriptTitle.value))
const draftScriptTitle = computed(() => draftSavedScript.value?.name || activeDraft.value.title)
const draftScriptDirty = computed(() => {
  return draftSavedScript.value ? draftScriptContent.value !== draftSavedScript.value.content : activeDraft.value.revision > 0
})
const selectedScriptDirty = computed(() => {
  if (!selectedScript.value) return false
  return selectedScriptContent.value !== selectedScript.value.content
})
const activeDocumentId = computed(() => editingSelectedScript.value ? selectedScriptId.value : scriptPanelMode.value === 'generate' ? draftScriptId.value : '')
const activeDocument = computed(() => documents.value[activeDocumentId.value])
const activeScriptTitle = computed(() => editingSelectedScript.value ? selectedScript.value?.name || '脚本' : draftScriptTitle.value)
const retainedDrafts = computed(() => Object.values(documents.value).filter((document) => !document.savedScriptId))
const filteredDrafts = computed(() => {
  const keyword = scriptSearch.value.trim().toLowerCase()
  return retainedDrafts.value.filter((document) => document.title.toLowerCase().includes(keyword))
})
const pendingDocuments = computed(() => Object.values(documents.value).filter((document) => document.pending))
const lastSavedScript = computed(() => scripts.value.find((script) => script.id === lastSavedScriptId.value))
const executionContextTitle = computed(() => `运行到：${props.executionTargetLabel || '当前终端'} · 需要 Bash`)
const runReadinessHint = (content: string, name = '') => {
  if (!content.trim()) return '输入脚本后可运行'
  if (!isBashCompatible(content, name)) return '请先转换为 Bash 脚本后运行'
  const issues = scriptReadinessStatusForContent(content).issues
  return issues.length ? `补全 ${issues.length} 项后可运行` : executionContextTitle.value
}

function generationContext() {
  return `${props.connectionId}:${props.workspaceSessionId}:${props.terminalId}:${props.selectedConfigId}`
}

function captureTarget(target: 'draft' | 'selected') {
  if (target === 'selected' && selectedScript.value) ensureSaved(selectedScript.value)
  const id = target === 'selected' ? selectedScriptId.value : draftScriptId.value
  const document = documents.value[id]
  if (!document.sourceCommands.length && recordingHasData.value) {
    document.connectionId = scriptSourceConnectionId.value
    document.workspaceSessionId = scriptSourceWorkspaceSessionId.value
    document.sourceCommands = [...sourceCommands.value]
  }
  return snapshot(id, generationContext())
}

function applyGeneratedScript(target: ScriptGenerationTarget, content: string, messageId: string) {
  return receiveGeneration(target, content, messageId, activeDocumentId.value, generationContext())
}

function openDocument(id: string) {
  closeLibrary()
  const document = documents.value[id]
  if (!document) return
  if (document.savedScriptId && scripts.value.some((script) => script.id === id)) loadSelectedScript(id)
  else { draftScriptId.value = id; openGenerateMode(); void nextTick(() => draftEditorTextarea.value?.focus()) }
}

function acceptGeneratedVersion() {
  const document = activeDocument.value
  if (!document?.pending) return
  const messageId = document.pending.messageId
  acceptPending(document.id)
  messages.value = messages.value.map((message) => message.id === messageId ? { ...message, applicationState: 'applied' } : message)
  if (saveState.value !== 'saving') saveState.value = 'idle'
}

function dismissGeneratedVersion() {
  const document = activeDocument.value
  if (!document?.pending) return
  const messageId = document.pending.messageId
  document.pending = undefined
  messages.value = messages.value.map((message) => message.id === messageId ? { ...message, applicationState: 'dismissed' } : message)
}

function messageScriptStatus(message: ScriptChatMessage) {
  if (message.savedScriptId) return '已保存副本'
  const document = documents.value[message.targetDocumentId || '']
  if (document?.pending?.messageId === message.id) return '待采纳'
  if (message.applicationState === 'dismissed') return '未采纳'
  if (message.applicationState === 'applied') {
    const content = scriptContentForMessage(message)
    if (document?.content !== content) return '草稿已有后续修改'
    return scripts.value.some(script => script.id === document.savedScriptId && script.content === content)
      ? '已应用并保存' : '已应用，尚未保存'
  }
  return 'AI 生成版本'
}

function reviewMessageVersion(message: ScriptChatMessage) {
  const document = documents.value[message.targetDocumentId || '']
  if (!document) return
  document.pending = {
    content: scriptContentForMessage(message), messageId: message.id,
    baseContent: document.content, baseRevision: document.revision, baseContext: generationContext()
  }
  messages.value = messages.value.map(item => item.id === message.id ? { ...item, applicationState: 'pending' } : item)
  openDocument(document.id)
}
const draftScriptReadiness = computed(() => scriptReadinessStatusForContent(draftScriptContent.value))
const selectedScriptReadiness = computed(() => scriptReadinessStatusForContent(selectedScriptContent.value))
const expandedScriptReadiness = computed(() => scriptReadinessStatusForContent(expandedScriptContent.value))
function isBashCompatible(content: string, name = '') {
  const language = detectShellScriptLanguage(content, name)
  return language !== 'powershell' && language !== 'cmd'
}
const canExecuteDraft = computed(() => hasDraftScript.value && draftScriptReadiness.value.issues.length === 0 && isBashCompatible(draftScriptContent.value, draftScriptTitle.value))
const canExecuteSelectedScript = computed(() => hasSelectedScriptContent.value && selectedScriptReadiness.value.issues.length === 0 && isBashCompatible(selectedScriptContent.value, selectedScript.value?.name))
const canExecuteExpandedScript = computed(() => expandedScriptContent.value.trim().length > 0 && expandedScriptReadiness.value.issues.length === 0 && isBashCompatible(expandedScriptContent.value, expandedScriptTitle.value))
const recordingActionLabel = computed(() => recordingHasData.value ? '重新录制' : '开始录制')
const draftSaveStatus = computed(() => editorSaveStatus(hasDraftScript.value, draftScriptDirty.value))
const selectedSaveStatus = computed(() => editorSaveStatus(hasSelectedScriptContent.value, selectedScriptDirty.value))
const scriptEditorMenuItems = computed(() => {
  const source = scriptEditorMenu.value?.source
  if (source === 'selected') {
    return [
      { id: 'copy', label: '复制脚本', disabled: !hasSelectedScriptContent.value, action: () => void copySelectedScript() },
      { id: 'preview', label: '放大编辑', action: () => openScriptPreview('selected') }
    ]
  }
  return [
    { id: 'copy', label: '复制脚本', disabled: !hasDraftScript.value, action: () => void copyDraftScript() },
    { id: 'preview', label: '放大编辑', action: () => openScriptPreview('draft') },
    { id: 'clear', label: '清空编辑器', danger: true, disabled: !hasDraftScript.value, action: clearDraftScript }
  ]
})
function scriptEditorRiskStatus(content: string, fileName = '') {
  if (!content.trim()) {
    return {
      level: 'muted',
      label: '\u672a\u626b\u63cf',
      message: '\u8f93\u5165\u811a\u672c\u540e\u5c06\u81ea\u52a8\u626b\u63cf\u98ce\u9669',
      risks: []
    }
  }
  return scriptRiskStatusForScript(content, fileName)
}

function scriptRiskStatusForScript(content: string, fileName = '') {
  return scriptRiskStatusForContent(preparedScriptContent(content, fileName))
}

function scriptRiskDisplayLabel(status: ReturnType<typeof scriptEditorRiskStatus>) {
  if (status.level === 'safe') return '未发现高风险'
  if (status.level === 'medium') return '发现中风险'
  if (status.level === 'high') return '发现高风险'
  return status.label
}

function editorSaveStatus(hasContent: boolean, dirty: boolean) {
  if (saveState.value === 'saving') return '保存中'
  if (!hasContent && !dirty) return ''
  return dirty ? '未保存' : '已保存'
}

const draftScriptRiskStatus = computed(() => scriptEditorRiskStatus(draftScriptContent.value, draftSavedScript.value?.name))
const selectedScriptRiskStatus = computed(() => scriptEditorRiskStatus(selectedScriptContent.value, selectedScript.value?.name))
const expandedScriptRiskStatus = computed(() => scriptEditorRiskStatus(expandedScriptContent.value, expandedScriptTitle.value))
const hasUsableConfig = computed(() => {
  return Boolean(props.config.baseUrl.trim() && props.config.model.trim() && (props.config.apiKey?.trim() || props.apiKey.trim()))
})

onMounted(() => {
  migratePreviewScripts()
  void loadScripts()
  document.addEventListener('pointerdown', dismissLibraryOutside)
  window.addEventListener('resize', closeLibraryOnResize)
})

watch(
  () => selectedScript.value?.id ?? '',
  () => {
    if (selectedScript.value) ensureSaved(selectedScript.value)
    else if (scriptPanelMode.value === 'library') openGenerateMode()
    selectedScriptEditing.value = false
  },
  { immediate: true }
)

watch(
  () => messages.value.map((message) => `${message.id}:${message.text.length}:${message.streaming ? '1' : '0'}`).join('|'),
  scrollMessagesToLatest,
  { flush: 'post' }
)

function watchDialogFocus(isOpen: () => boolean, dialog: Ref<HTMLElement | null>, initialFocus: string) {
  let trigger: HTMLElement | null = null
  watch(isOpen, async (open) => {
    if (open) trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    await nextTick()
    if (open && isOpen()) dialog.value?.querySelector<HTMLElement>(initialFocus)?.focus()
    else if (!isOpen() && trigger?.isConnected && trigger.getClientRects().length) trigger.focus({ preventScroll: true })
  })
}

watchDialogFocus(() => Boolean(renamingScript.value), renameDialog, 'input')
watchDialogFocus(() => scriptPreviewOpen.value, previewDialog, 'textarea')
watchDialogFocus(() => scriptRiskConfirmOpen.value, riskDialog, '.modal-actions button:not(.danger)')

function handleDialogKeydown(event: KeyboardEvent, close: () => void) {
  if (event.defaultPrevented || event.isComposing) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close()
  } else if (event.currentTarget instanceof HTMLElement) trapTabFocus(event, event.currentTarget)
}

onBeforeUnmount(() => {
  stopAnswerTimer()
  document.removeEventListener('pointerdown', dismissLibraryOutside)
  window.removeEventListener('resize', closeLibraryOnResize)
})

function loadSelectedScript(scriptId: string) {
  const script = scripts.value.find((item) => item.id === scriptId)
  if (!script) return
  closeLibrary()
  ensureSaved(script)
  selectedScriptId.value = scriptId
  selectedScriptEditing.value = false
  scriptPanelMode.value = 'library'
  panelError.value = ''
  void nextTick(() => selectedScriptTextarea.value?.focus())
}

function openLibraryMode() {
  if (libraryOpen.value) { closeLibrary(true); return }
  const bounds = scriptHead.value?.getBoundingClientRect()
  if (!bounds) return
  const width = Math.min(340, Math.max(260, bounds.width - 32), window.innerWidth - 16)
  const top = bounds.bottom + 4
  libraryPosition.value = {
    left: `${Math.max(8, Math.min(bounds.right - width - 8, window.innerWidth - width - 8))}px`,
    top: `${top}px`, width: `${width}px`,
    maxHeight: `${Math.min(440, window.innerHeight - top - 12)}px`
  }
  scriptSearch.value = ''
  libraryOpen.value = true
  focusLibrarySearch()
}

function closeLibrary(restoreFocus = false) {
  libraryOpen.value = false
  if (restoreFocus) libraryButton.value?.focus()
}

function dismissLibraryOutside(event: PointerEvent) {
  const target = event.target as Node
  if (libraryOpen.value && !libraryPopover.value?.contains(target) && !libraryButton.value?.contains(target)) closeLibrary()
}

function closeLibraryOnResize() { closeLibrary() }

function renameLibraryScript(script: UpdateScript) {
  closeLibrary(true)
  openRenameScriptDialog(script)
}

async function deleteLibraryScript(script: UpdateScript) {
  await removeScript(script)
  if (libraryOpen.value) focusLibrarySearch()
}

function openGenerateMode() {
  closeLibrary()
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
}

function stopRecording() {
  emit('stopRecording')
}

function clearRecording() {
  emit('clearRecording')
  clearConversation()
}

function clearConversation() {
  if (isGenerating.value || saveState.value === 'saving') return
  stopAnswerTimer()
  answerElapsedSeconds.value = 0
  answerDurations.value = {}
  messages.value = []
  scriptDrafts.value = {}
  editingMessageId.value = ''
  collapsedMessages.value = {}
  panelError.value = ''
  saveState.value = 'idle'
}

function openScriptEditorMenu(event: MouseEvent, source: ScriptEditorSource) {
  const target = event.currentTarget as HTMLElement
  const rect = target.getBoundingClientRect()
  scriptEditorMenu.value = {
    source,
    sourceElement: target,
    x: rect.left,
    y: rect.bottom + 4
  }
}

function closeScriptEditorMenu() {
  scriptEditorMenu.value = null
}

function updateDraftEditorCursor(event: Event) {
  draftEditorCursor.value = cursorPositionForTextarea(event.target as HTMLTextAreaElement)
}

function focusDraftReadinessIssue(line: number) {
  const editor = draftEditorTextarea.value
  if (!editor) return
  const lines = editor.value.split('\n')
  const targetLine = Math.max(1, Math.min(line, lines.length))
  const selectionStart = lines.slice(0, targetLine - 1).reduce((length, value) => length + value.length + 1, 0)
  const selectionEnd = selectionStart + (lines[targetLine - 1]?.length ?? 0)
  editor.focus()
  editor.setSelectionRange(selectionStart, selectionEnd)
  draftEditorCursor.value = { line: targetLine, column: 1 }
  const lineHeight = Number.parseFloat(window.getComputedStyle(editor).lineHeight) || 22
  editor.scrollTop = Math.max(0, (targetLine - 3) * lineHeight)
  syncScriptEditorScroll({ target: editor } as unknown as Event, draftEditorLineRail.value, draftScriptHighlight.value)
}

function updateSelectedEditorCursor(event: Event) {
  selectedEditorCursor.value = cursorPositionForTextarea(event.target as HTMLTextAreaElement)
}

function updateExpandedEditorCursor(event: Event) {
  expandedEditorCursor.value = cursorPositionForTextarea(event.target as HTMLTextAreaElement)
}

function updateExpandedScriptContent(value: string) {
  if (scriptPreviewSource.value === 'selected') {
    updateSelectedScriptDraft(value)
  } else {
    updateDraftScriptContent(value)
  }
}

function handleDraftEditorInput(event: Event) {
  const target = event.target as HTMLTextAreaElement
  updateDraftScriptContent(target.value)
  draftEditorCursor.value = cursorPositionForTextarea(target)
}

function handleSelectedEditorInput(event: Event) {
  const target = event.target as HTMLTextAreaElement
  updateSelectedScriptDraft(target.value)
  selectedEditorCursor.value = cursorPositionForTextarea(target)
}

function focusExpandedReadinessIssue(line: number) {
  const editor = expandedScriptTextarea.value
  if (!editor) return
  const lines = editor.value.split('\n')
  const targetLine = Math.max(1, Math.min(line, lines.length))
  const selectionStart = lines.slice(0, targetLine - 1).reduce((length, value) => length + value.length + 1, 0)
  const selectionEnd = selectionStart + (lines[targetLine - 1]?.length ?? 0)
  editor.focus()
  editor.setSelectionRange(selectionStart, selectionEnd)
  expandedEditorCursor.value = { line: targetLine, column: 1 }
  const lineHeight = Number.parseFloat(window.getComputedStyle(editor).lineHeight) || 24
  editor.scrollTop = Math.max(0, (targetLine - 3) * lineHeight)
  syncScriptEditorScroll({ target: editor } as unknown as Event, expandedScriptLineRail.value, expandedScriptHighlight.value)
}

function focusNextDraftReadinessIssue() {
  const issues = draftScriptReadiness.value.issues
  if (!issues.length) return
  const index = draftReadinessIndex.value % issues.length
  focusDraftReadinessIssue(issues[index].line)
  draftReadinessIndex.value = (index + 1) % issues.length
}

function focusNextSelectedReadinessIssue() {
  const issues = selectedScriptReadiness.value.issues
  if (!issues.length) return
  const index = selectedReadinessIndex.value % issues.length
  focusSelectedReadinessIssue(issues[index].line)
  selectedReadinessIndex.value = (index + 1) % issues.length
}

function focusNextExpandedReadinessIssue() {
  const issues = expandedScriptReadiness.value.issues
  if (!issues.length) return
  const index = expandedReadinessIndex.value % issues.length
  focusExpandedReadinessIssue(issues[index].line)
  expandedReadinessIndex.value = (index + 1) % issues.length
}

function focusSelectedReadinessIssue(line: number) {
  const editor = selectedScriptTextarea.value
  if (!editor) return
  const lines = editor.value.split('\n')
  const targetLine = Math.max(1, Math.min(line, lines.length))
  const selectionStart = lines.slice(0, targetLine - 1).reduce((length, value) => length + value.length + 1, 0)
  const selectionEnd = selectionStart + (lines[targetLine - 1]?.length ?? 0)
  editor.focus()
  editor.setSelectionRange(selectionStart, selectionEnd)
  selectedEditorCursor.value = { line: targetLine, column: 1 }
  const lineHeight = Number.parseFloat(window.getComputedStyle(editor).lineHeight) || 22
  editor.scrollTop = Math.max(0, (targetLine - 3) * lineHeight)
  syncScriptEditorScroll({ target: editor } as unknown as Event, selectedScriptLineRail.value, selectedScriptHighlight.value)
}

async function saveMessageScript(message: ScriptChatMessage) {
  if (saveState.value === 'saving') return
  const content = scriptContentForMessage(message).trimEnd()
  if (!content.trim()) {
    panelError.value = '当前没有可保存的脚本内容。'
    return
  }
  saveState.value = 'saving'
  panelError.value = ''
  const now = nowText()
  const id = message.savedScriptId || `script-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const existing = scripts.value.find((script) => script.id === id)
  const fallbackName = inferScriptName(content, existing?.name || '服务更新脚本')
  const shouldGenerateName = !existing || isAutoScriptName(existing.name)
  const name = shouldGenerateName
    ? await generateScriptTitle(content, fallbackName, userRequestForAssistantMessage(message.id), message.sourceCommands)
    : existing.name
  const script: UpdateScript = {
    id,
    connectionId: existing?.connectionId ?? message.sourceConnectionId ?? scriptSourceConnectionId.value,
    workspaceSessionId: existing?.workspaceSessionId ?? message.sourceWorkspaceSessionId ?? scriptSourceWorkspaceSessionId.value,
    name,
    description: inferDescription(message.text),
    content,
    sourceCommands: message.sourceCommands ?? sourceCommands.value,
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
    lastSavedScriptId.value = script.id
    markMessageSaved(message.id, script.id, content)
    saveState.value = 'saved'
  } catch (error) {
    if (isTauriUnavailableError(error)) {
      scriptStoreMode.value = 'preview'
      savePreviewScript(script)
      scripts.value = [script, ...scripts.value.filter((item) => item.id !== script.id)]
      lastSavedScriptId.value = script.id
      markMessageSaved(message.id, script.id, content)
      saveState.value = 'saved'
      return
    }
    saveState.value = 'error'
    panelError.value = formatError(error)
  }
}

async function sendSelectedScriptRequest() {
  const content = selectedScriptContent.value.trimEnd()
  if (!selectedScript.value || !content.trim()) {
    panelError.value = '当前脚本为空，无法请求 AI 修改。'
    return
  }
  await sendScriptRequest('revise', 'selected')
}

function executeMessageScript(message: ScriptChatMessage) {
  const content = scriptContentForMessage(message).trim()
  if (!content) return
  const savedScript = message.savedScriptId
    ? scripts.value.find((script) => script.id === message.savedScriptId)
    : undefined
  const source = savedScript ?? (message.sourceConnectionId ? { connectionId: message.sourceConnectionId } : undefined)
  executeScriptContent(content, source)
}

function executeSelectedScript() {
  const content = selectedScriptContent.value.trim()
  if (!content) return
  executeScriptContent(content, selectedScript.value)
}
function toggleSelectedScriptEditor() {
  if (!selectedScript.value) return
  selectedScriptEditing.value = !selectedScriptEditing.value
}

function updateSelectedScriptDraft(value: string) {
  selectedScriptDraft.value = value
  if (saveState.value !== 'saving') saveState.value = 'idle'
  scriptExecutionNotice.value = ''
}

async function saveSelectedScript() {
  if (saveState.value === 'saving') return
  const script = selectedScript.value
  if (!script) return
  const content = selectedScriptContent.value
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
    markSaved(updated)
    lastSavedScriptId.value = updated.id
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
  createScriptConversation()
  draftScriptContent.value = content
  if (messageId) {
    const sourceMessage = messages.value.find((message) => message.id === messageId)
    draftSourceConnectionId.value = sourceMessage?.sourceConnectionId ?? ''
    draftSourceWorkspaceSessionId.value = sourceMessage?.sourceWorkspaceSessionId ?? ''
    draftSourceCommands.value = [...(sourceMessage?.sourceCommands ?? [])]
    scriptDrafts.value = {
      ...scriptDrafts.value,
      [messageId]: content
    }
  }
  void nextTick(() => draftEditorTextarea.value?.focus())
}

function updateDraftScriptContent(value: string) {
  draftScriptContent.value = value
  if (saveState.value !== 'saving') saveState.value = 'idle'
  scriptExecutionNotice.value = ''
}

function clearDraftScript() {
  if (hasDraftScript.value && !window.confirm('清空当前脚本草稿？未保存的内容将丢失。')) return
  draftScriptContent.value = ''
  draftEditorCursor.value = { line: 1, column: 1 }
  if (saveState.value !== 'saving') saveState.value = 'idle'
  panelError.value = ''
  scriptExecutionNotice.value = ''
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

function saveExpandedScript() {
  if (scriptPreviewSource.value === 'selected') {
    void saveSelectedScript()
  } else {
    void saveDraftScript()
  }
}

function syncScriptEditorScroll(event: Event, lineRail: HTMLElement | null, highlightLayer: HTMLElement | null) {
  const target = event.target as HTMLTextAreaElement
  target.parentElement?.style.setProperty('--script-editor-scroll-top', `${target.scrollTop}px`)
  if (lineRail) lineRail.scrollTop = target.scrollTop
  if (highlightLayer) {
    highlightLayer.scrollTop = target.scrollTop
    highlightLayer.scrollLeft = target.scrollLeft
  }
}

async function saveDraftScript() {
  if (saveState.value === 'saving') return
  const document = activeDraft.value
  const content = document.content
  if (!content.trim()) {
    panelError.value = '当前没有可保存的脚本内容。'
    return
  }
  saveState.value = 'saving'
  panelError.value = ''
  const now = nowText()
  const existing = scripts.value.find((script) => script.id === document.id)
  const savedConnectionId = existing?.connectionId ?? (document.connectionId || scriptSourceConnectionId.value)
  const savedSessionId = existing?.workspaceSessionId ?? (document.workspaceSessionId || scriptSourceWorkspaceSessionId.value)
  const savedCommands = [...(document.sourceCommands.length ? document.sourceCommands : sourceCommands.value)]
  const savedDescription = inferDescription(latestAssistantText()) || inferDescription(latestUserScriptRequest()) || '手动保存脚本'
  const fallbackName = inferScriptName(content, existing?.name || '脚本')
  const shouldGenerateName = !existing || isAutoScriptName(existing.name)
  const name = shouldGenerateName
    ? await generateScriptTitle(
        content,
        fallbackName,
        latestUserScriptRequest(),
        savedCommands
      )
    : existing.name
  const script: UpdateScript = {
    id: document.id,
    connectionId: savedConnectionId,
    workspaceSessionId: savedSessionId,
    name,
    description: savedDescription,
    content,
    sourceCommands: savedCommands,
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
    markSaved(script)
    lastSavedScriptId.value = script.id
    saveState.value = 'saved'
  } catch (error) {
    if (isTauriUnavailableError(error)) {
      scriptStoreMode.value = 'preview'
      savePreviewScript(script)
      scripts.value = [script, ...scripts.value.filter((item) => item.id !== script.id)]
      markSaved(script)
      lastSavedScriptId.value = script.id
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
  selectedScriptEditing.value = false
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
  const source = draftSavedScript.value ?? (draftSourceConnectionId.value ? { connectionId: draftSourceConnectionId.value } : undefined)
  executeScriptContent(content, source)
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
  void nextTick(() => expandedScriptTextarea.value?.focus())
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
  const sourceScript = scriptPreviewSource.value === 'selected'
    ? selectedScript.value
    : draftSavedScript.value ?? (draftSourceConnectionId.value ? { connectionId: draftSourceConnectionId.value } : undefined)
  executeScriptContent(content, sourceScript)
}

async function regenerateSelectedScript() {
  const script = selectedScript.value
  const content = selectedScriptContent.value.trimEnd()
  if (!script || !content.trim()) {
    panelError.value = '当前脚本为空，无法重新生成。'
    return
  }
  panelError.value = ''
  await sendScriptRequest('regenerate', 'selected')
}

function latestUserScriptRequest() {
  return [...messages.value].reverse().find((message) => message.role === 'user')?.text ?? askText.value.trim()
}

function latestAssistantText() {
  return [...messages.value].reverse().find((message) => message.role === 'assistant')?.text ?? ''
}

function createScriptConversation() {
  openGenerateMode()
  editingMessageId.value = ''
  draftScriptId.value = createDraft({ connectionId: props.connectionId, workspaceSessionId: props.workspaceSessionId }).id
  askText.value = ''
  if (saveState.value !== 'saving') saveState.value = 'idle'
  panelError.value = ''
  void nextTick(() => draftEditorTextarea.value?.focus())
}

function resizeScriptComposer() {
  const input = scriptComposerInput.value
  if (!input) return
  input.style.height = 'auto'
  input.style.height = `${Math.min(144, Math.max(56, input.scrollHeight))}px`
}

watch(askText, () => { void nextTick(resizeScriptComposer) })

async function sendActiveScriptRequest() {
  if (editingSelectedScript.value) {
    await sendSelectedScriptRequest()
    return
  }
  await sendScriptRequest()
}

function handleComposerKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter') return
  if (event.isComposing) return
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault()
    void sendActiveScriptRequest()
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

function userRequestForAssistantMessage(messageId: string) {
  const index = messages.value.findIndex((message) => message.id === messageId)
  if (index < 0) return ''
  return [...messages.value.slice(0, index)].reverse().find((message) => message.role === 'user')?.text ?? ''
}

async function generateScriptTitle(content: string, fallback: string, userRequest: string, commandSnapshot?: string[]) {
  const apiKey = props.config.apiKey?.trim() || props.apiKey.trim()
  if (!props.config.baseUrl.trim() || !props.config.model.trim() || !apiKey) return fallback
  try {
    const response = await generateAiScriptTitle({
      config: props.config,
      apiKey,
      userRequest: userRequest || '生成可复用脚本',
      scriptContent: content,
      sourceCommands: commandSnapshot ?? sourceCommands.value
    })
    return response.title.trim() || fallback
  } catch (error) {
    console.error('failed to generate AI script title', error)
    return fallback
  }
}

function connectionLabel(connectionId?: string) {
  if (!connectionId) return '未知连接'
  return props.connectionLabels[connectionId] || connectionId
}

function scriptSourceLabel(script: UpdateScript) {
  return connectionLabel(script.connectionId?.trim())
}

function focusScriptComposer() {
  if (!hasUsableConfig.value) return
  void nextTick(() => {
    scriptComposerInput.value?.focus()
  })
}
</script>

<template>
  <section class="script-panel script-workspace">
    <div ref="scriptHead" class="workspace-section-head script-head">
      <div class="script-current-title">
        <UiIcon name="script" size="14" />
        <strong :title="activeScriptTitle">{{ activeScriptTitle }}</strong>
        <span v-if="editingSelectedScript ? selectedScriptDirty : draftScriptDirty" class="script-dirty-dot" title="有未保存的修改" aria-label="有未保存的修改" />
      </div>
      <button ref="libraryButton" class="icon-button" type="button" title="脚本列表" aria-label="脚本列表" aria-haspopup="dialog" :aria-expanded="libraryOpen" @click="openLibraryMode"><UiIcon name="history" /></button>
      <button class="icon-button" type="button" title="新增脚本" aria-label="新增脚本" @click="createScriptConversation"><UiIcon name="plus" /></button>
    </div>

    <Teleport to="body">
      <section v-if="libraryOpen" ref="libraryPopover" class="script-library-popover" :style="libraryPosition" role="dialog" aria-label="脚本列表" @keydown="handleDialogKeydown($event, () => closeLibrary(true))">
        <div class="script-library-search">
          <UiIcon name="search" size="14" />
          <input ref="librarySearchInput" v-model="scriptSearch" placeholder="搜索脚本..." aria-label="搜索脚本" />
        </div>
        <div class="script-library-body">
          <div v-if="filteredDrafts.length" class="script-retained-drafts">
            <div class="script-library-group-label">未保存草稿</div>
            <article v-for="document in filteredDrafts" :key="document.id" class="script-library-row" :class="{ active: document.id === activeDocumentId }">
              <button class="script-library-open" type="button" :aria-current="document.id === activeDocumentId ? 'true' : undefined" @click="openDocument(document.id)">
                <strong :title="document.title">{{ document.title }}</strong>
                <small>{{ document.revision ? '未保存' : '空白草稿' }}</small>
              </button>
            </article>
          </div>
          <div v-if="filteredScripts.length" class="script-library-list">
            <div class="script-library-group-label">已保存</div>
            <article v-for="script in filteredScripts" :key="script.id" class="script-library-row" :class="{ active: script.id === activeDocumentId }">
              <button class="script-library-open" type="button" :aria-label="`编辑 ${script.name}`" :aria-current="script.id === activeDocumentId ? 'true' : undefined" @click="loadSelectedScript(script.id)">
                <strong :title="script.name">{{ script.name }}</strong>
                <small class="script-library-meta" :title="`来源 ${scriptSourceLabel(script)} · 更新 ${script.updatedAt}`">{{ scriptSourceLabel(script) }} · {{ script.updatedAt.slice(0, 10) }}<span v-if="documents[script.id] && documents[script.id].content !== script.content"> · 未保存</span></small>
              </button>
              <button class="icon-button" type="button" title="编辑脚本名" aria-label="编辑脚本名" @click="renameLibraryScript(script)"><UiIcon name="edit" /></button>
              <button class="icon-button danger" type="button" title="删除脚本" aria-label="删除脚本" @click="deleteLibraryScript(script)"><UiIcon name="trash" /></button>
            </article>
          </div>
          <p v-if="!filteredDrafts.length && !filteredScripts.length" class="script-library-empty">{{ scriptSearch.trim() ? '没有匹配的脚本' : '暂无脚本' }}</p>
        </div>
      </section>
    </Teleport>

    <div class="script-editor-toolbar">
      <button v-if="!props.recording.isRecording" class="text-button record-action" type="button" @click="startRecording"><UiIcon :name="recordingHasData ? 'refresh' : 'play'" />{{ recordingActionLabel }}</button>
      <button v-else class="text-button danger" type="button" @click="stopRecording"><UiIcon name="stop" />停止录制</button>
      <div v-if="editingSelectedScript" class="script-editor-tools">
        <button class="icon-button" type="button" title="保存修改" aria-label="保存修改" :disabled="!hasSelectedScriptContent || saveState === 'saving'" @click="saveSelectedScript"><UiIcon name="save" /></button>
        <button class="icon-button script-run-button" type="button" aria-label="运行脚本" :title="runReadinessHint(selectedScriptContent, selectedScript?.name)" :disabled="!canExecuteSelectedScript" @click="executeSelectedScript"><UiIcon name="play" /></button>
        <button class="icon-button script-expand-button" type="button" title="放大编辑" aria-label="放大编辑" @click="openScriptPreview('selected')"><UiIcon name="maximize" /></button>
        <button class="icon-button" type="button" title="更多操作" aria-label="更多操作" @click="openScriptEditorMenu($event, 'selected')"><UiIcon name="more" /></button>
      </div>
      <div v-else class="script-editor-tools">
        <button class="icon-button" type="button" :title="draftSavedScript ? '保存修改' : '首次保存脚本'" :aria-label="draftSavedScript ? '保存修改' : '首次保存脚本'" :disabled="!hasDraftScript || saveState === 'saving'" @click="saveDraftScript"><UiIcon name="save" /></button>
        <button class="icon-button script-run-button" type="button" aria-label="运行脚本" :title="runReadinessHint(draftScriptContent, draftScriptTitle)" :disabled="!canExecuteDraft" @click="executeDraftScript"><UiIcon name="play" /></button>
        <button class="icon-button script-expand-button" type="button" title="放大编辑" aria-label="放大编辑" @click="openScriptPreview('draft')"><UiIcon name="maximize" /></button>
        <button class="icon-button" type="button" title="更多操作" aria-label="更多操作" @click="openScriptEditorMenu($event, 'draft')"><UiIcon name="more" /></button>
      </div>
    </div>

    <div v-if="pendingDocuments.length" class="script-pending-notice" role="status">
      <span>AI 结果待采纳：</span>
      <button v-for="document in pendingDocuments" :key="document.id" class="text-button" type="button" @click="openDocument(document.id)">{{ document.title }}</button>
    </div>
    <details v-if="activeDocument?.pending" class="script-generation-review" open>
      <summary>查看「{{ activeScriptTitle }}」的 AI 修改</summary>
      <p>请求后编辑对象或内容发生变化。核对当前内容和 AI 版本后，可采纳到此草稿。</p>
      <div class="script-version-comparison">
        <section><strong>当前草稿</strong><pre>{{ activeDocument.content }}</pre></section>
        <section><strong>AI 版本</strong><pre>{{ activeDocument.pending.content }}</pre></section>
      </div>
      <button class="text-button" type="button" @click="acceptGeneratedVersion">采纳 AI 版本到「{{ activeScriptTitle }}」</button>
      <button class="text-button" type="button" @click="dismissGeneratedVersion">保留当前草稿</button>
    </details>

    <ContextMenu
      v-if="scriptEditorMenu"
      :x="scriptEditorMenu.x"
      :y="scriptEditorMenu.y"
      :source-element="scriptEditorMenu.sourceElement"
      :title="scriptEditorMenu.source === 'draft' ? '草稿操作' : '脚本操作'"
      :items="scriptEditorMenuItems"
      @close="closeScriptEditorMenu"
    />

    <div v-if="renamingScript" class="modal-backdrop" role="presentation" @click.self="closeRenameScriptDialog">
      <form ref="renameDialog" class="modal rename-modal" role="dialog" aria-modal="true" aria-label="编辑脚本名称" @submit.prevent="renameScript" @keydown="handleDialogKeydown($event, closeRenameScriptDialog)">
        <div class="modal-head">
          <div>
            <strong>编辑脚本名称</strong>
            <span>{{ renamingScript.name }}</span>
          </div>
          <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="closeRenameScriptDialog"><UiIcon name="close" /></button>
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
      <section ref="previewDialog" class="modal script-preview-modal" role="dialog" aria-modal="true" aria-label="放大编辑脚本" @keydown="handleDialogKeydown($event, closeScriptPreview)">
        <div class="modal-head">
          <div class="script-preview-title">
            <span class="script-file-icon"><UiIcon name="script" size="13" /></span>
            <strong :title="expandedScriptTitle">{{ expandedScriptTitle }}</strong>
          </div>
          <div class="script-editor-tools">
            <button class="icon-button" type="button" title="保存脚本" aria-label="保存脚本" :disabled="!expandedScriptContent.trim() || saveState === 'saving'" @click="saveExpandedScript"><UiIcon name="save" /></button>
            <button class="icon-button" type="button" title="复制脚本" aria-label="复制脚本" @click="copyExpandedScript"><UiIcon name="copy" /></button>
            <button class="icon-button" type="button" title="执行脚本" aria-label="执行脚本" :disabled="!canExecuteExpandedScript" @click="executeExpandedScript"><UiIcon name="play" /></button>
            <button class="icon-button" type="button" title="关闭放大编辑" aria-label="关闭放大编辑" @click="closeScriptPreview"><UiIcon name="close" /></button>
          </div>
        </div>
        <ScriptEditorContext :content="expandedScriptContent" :name="expandedScriptTitle" :target="executionTargetLabel" :target-title="executionTargetTitle" :risk="expandedScriptRiskStatus" @focus-readiness="focusNextExpandedReadinessIssue" />
        <div class="script-expanded-editor">
          <div class="script-editor-shell" :style="{ '--script-editor-cursor-line': expandedEditorCursor.line }">
            <pre ref="expandedScriptLineRail" class="script-line-rail" aria-hidden="true">{{ expandedScriptLineNumbers }}</pre>
            <pre ref="expandedScriptHighlight" class="script-code-overlay" aria-hidden="true"><code v-html="expandedScriptHighlightedHtml" /></pre>
            <textarea
              ref="expandedScriptTextarea"
              :value="expandedScriptContent"
              wrap="off"
              spellcheck="false"
              aria-label="编辑放大脚本"
              @focus="updateExpandedEditorCursor"
              @input="updateExpandedScriptContent(($event.target as HTMLTextAreaElement).value); updateExpandedEditorCursor($event)"
              @click="updateExpandedEditorCursor"
              @keyup="updateExpandedEditorCursor"
              @select="updateExpandedEditorCursor"
              @scroll="syncExpandedScriptLineRail"
            />
          </div>
          <div class="script-editor-statusbar">
            <span>Shell &middot; UTF-8 &middot; LF</span>
            <span>行 {{ expandedEditorCursor.line }}，列 {{ expandedEditorCursor.column }}</span>
            <span>{{ expandedScriptContent.length }} 字符</span>
            <span>{{ scriptPreviewSource === 'selected' ? selectedSaveStatus : draftSaveStatus }}</span>
          </div>
        </div>
      </section>
    </div>

    <div v-if="scriptRiskConfirmOpen" class="modal-backdrop script-risk-backdrop" role="presentation">
      <section ref="riskDialog" class="modal script-risk-modal" role="dialog" aria-modal="true" :aria-label="pendingExecutionTitle" @keydown="handleDialogKeydown($event, closeScriptRiskConfirm)">
        <div class="modal-head">
          <div>
            <strong>{{ pendingExecutionTitle }}</strong>
            <span>{{ pendingExecutionSubtitle }}</span>
          </div>
          <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="closeScriptRiskConfirm"><UiIcon name="close" /></button>
        </div>
        <div class="script-risk-body">
          <div class="script-risk-summary" aria-label="风险类型">
            <span v-if="pendingScriptConnectionMismatch" class="script-risk-chip medium">
              <strong>跨连接执行</strong>
              <small :title="executionTargetTitle">来源 {{ connectionLabel(pendingScriptSource?.connectionId) }} → {{ executionTargetLabel }}</small>
            </span>
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
          <div class="script-risk-ai">
            <div>
              <strong>{{ pendingScriptRisks.length ? '不确定原因？' : '请核对执行目标' }}</strong>
              <span :title="executionTargetTitle">{{ pendingScriptRisks.length ? '让 AI 根据命中的风险行解释影响和执行前检查项。' : `此脚本来自 ${connectionLabel(pendingScriptSource?.connectionId)}，将发送到${executionTargetLabel}。` }}</span>
            </div>
            <button v-if="pendingScriptRisks.length" class="text-button" type="button" :disabled="scriptRiskExplanationLoading || !hasUsableConfig" @click="explainPendingScriptRisk">
              {{ scriptRiskExplanationLoading ? '正在分析...' : '借助 AI 分析风险' }}
            </button>
            <div
              v-if="scriptRiskExplanationLoading || scriptRiskExplanationError || scriptRiskExplanation"
              class="script-risk-ai-output"
              :class="{ error: scriptRiskExplanationError }"
              aria-live="polite"
            >
              <div v-if="scriptRiskExplanationLoading" class="script-risk-thinking">
                <span /><span /><span />AI 正在分析风险...
              </div>
              <p v-if="scriptRiskExplanationError">{{ scriptRiskExplanationError }}</p>
              <div v-else-if="scriptRiskExplanation" class="markdown-content" v-html="renderMarkdown(scriptRiskExplanation)" />
              <p v-else class="script-risk-ai-placeholder">正在等待模型首段回复...</p>
            </div>
          </div>
          <div class="script-risk-preview" role="region" aria-label="脚本风险预览">
            <div class="script-risk-preview-head">
              <div>
                <strong>脚本预览</strong>
                <span>{{ pendingScriptRisks.length ? '命中的风险行已标红，执行前请逐行核对。' : '未检测到风险命令；请确认脚本适用于当前连接。' }}</span>
              </div>
              <span class="script-risk-preview-count">{{ pendingScriptRiskLines.length }} 行</span>
            </div>
            <div class="script-risk-lines">
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
        </div>
        <div class="modal-actions script-risk-actions">
          <span class="script-risk-action-hint" :title="executionTargetTitle">确认后发送到：{{ executionTargetLabel }}</span>
          <button class="text-button" type="button" @click="closeScriptRiskConfirm">取消</button>
          <button class="text-button danger" type="button" @click="confirmPendingScriptExecution">确认执行</button>
        </div>
      </section>
    </div>
    <p v-if="panelError" class="script-feedback error">{{ panelError }}</p>
    <p v-else-if="scriptExecutionNotice" class="script-feedback">{{ scriptExecutionNotice }}</p>
    <p v-else-if="saveState === 'saved' && lastSavedScript" class="script-feedback">已保存「{{ lastSavedScript.name }}」<button class="text-button" type="button" @click="loadSelectedScript(lastSavedScript.id)">查看脚本</button></p>

    <div v-if="editingSelectedScript && selectedScript" class="script-library detail-view">
      <section class="script-preview">
        <div class="script-library-editor">
          <ScriptEditorContext :content="selectedScriptContent" :name="selectedScript.name" :target="executionTargetLabel" :target-title="executionTargetTitle" :risk="selectedScriptRiskStatus" @focus-readiness="focusNextSelectedReadinessIssue" />
          <div class="script-editor-shell" :style="{ '--script-editor-cursor-line': selectedEditorCursor.line }">
            <pre ref="selectedScriptLineRail" class="script-line-rail" aria-hidden="true">{{ selectedScriptLineNumbers }}</pre>
            <pre ref="selectedScriptHighlight" class="script-code-overlay" aria-hidden="true"><code v-html="selectedScriptHighlightedHtml" /></pre>
            <textarea
              ref="selectedScriptTextarea"
              :value="selectedScriptContent"
              wrap="off"
              spellcheck="false"
              aria-label="编辑脚本"
              @focus="updateSelectedEditorCursor"
              placeholder="在这里编辑保存的脚本..."
              @input="handleSelectedEditorInput"
              @click="updateSelectedEditorCursor"
              @keyup="updateSelectedEditorCursor"
              @select="updateSelectedEditorCursor"
              @scroll="syncSelectedScriptLineRail"
            />
          </div>
          <div class="script-editor-statusbar">
            <span>Shell &middot; UTF-8 &middot; LF</span>
            <span>行 {{ selectedEditorCursor.line }}，列 {{ selectedEditorCursor.column }}</span>
            <span>{{ selectedScriptContent.length }} 字符</span>
            <span v-if="selectedSaveStatus" :class="{ dirty: selectedScriptDirty }">{{ selectedSaveStatus }}</span>
          </div>
        </div>
      </section>
    </div>

    <div v-else class="script-generate">
      <div v-if="props.recording.isRecording || recordingHasData" class="script-recorder">
        <span class="record-dot" :class="{ active: props.recording.isRecording }" />
        <div>
          <strong>{{ props.recording.isRecording ? '正在录制操作上下文' : recordingHasData ? '录制上下文已就绪' : '可录制操作，也可直接粘贴脚本' }}</strong>
          <small v-if="props.recording.isRecording || recordingHasData">{{ recordedCommands.length }} 条命令 &middot; {{ recordedOutput.length }} 字符输出{{ props.recording.isRecording ? ' · 录制中' : '' }}</small>
        </div>
      </div>

      <div class="script-workbench">
        <section class="script-draft-card">

          <ScriptEditorContext :content="draftScriptContent" :name="draftScriptTitle" :target="executionTargetLabel" :target-title="executionTargetTitle" :risk="draftScriptRiskStatus" @focus-readiness="focusNextDraftReadinessIssue" />
          <div class="script-editor-shell" :style="{ '--script-editor-cursor-line': draftEditorCursor.line }">
            <pre ref="draftEditorLineRail" class="script-line-rail" aria-hidden="true">{{ draftLineNumbers }}</pre>
            <pre ref="draftScriptHighlight" class="script-code-overlay" aria-hidden="true"><code v-html="draftScriptHighlightedHtml" /></pre>
            <textarea
              ref="draftEditorTextarea"
              :value="draftScriptContent"
              wrap="off"
              spellcheck="false"
              aria-label="脚本草稿"
              @focus="updateDraftEditorCursor"
              placeholder="在这里粘贴、生成或编写 Shell 脚本..."
              @input="handleDraftEditorInput"
              @click="updateDraftEditorCursor"
              @keyup="updateDraftEditorCursor"
              @select="updateDraftEditorCursor"
              @scroll="syncDraftLineRail"
            />
          </div>
          <div class="script-editor-statusbar">
            <span>Shell &middot; UTF-8 &middot; LF</span>
            <span>行 {{ draftEditorCursor.line }}，列 {{ draftEditorCursor.column }}</span>
            <span>{{ draftScriptContent.length }} 字符</span>
            <span v-if="draftSaveStatus" :class="{ dirty: draftScriptDirty }">{{ draftSaveStatus }}</span>
          </div>
        </section>
      </div>
    </div>

    <section v-if="hasScriptReplies && showScriptComposer" class="script-replies-panel script-conversation" aria-label="脚本 AI 对话">
        <div class="script-conversation-head">
          <span class="script-replies-title">
            <UiIcon name="ai" size="13" />
            <strong>AI 对话</strong>
            <small>{{ isGenerating ? `正在修改「${currentTargetTitle}」` : scriptReplyCountText }}</small>
          </span>
          <button class="icon-button danger" type="button" title="清空对话" aria-label="清空对话" :disabled="isGenerating" @click="clearConversation"><UiIcon name="trash" size="13" /></button>
        </div>
        <div ref="messageList" class="script-replies-list" role="log" aria-live="polite" aria-relevant="additions text">
          <article
            v-for="message in messages"
            :key="message.id"
            class="message script-reply-message"
            :class="{ error: message.error, ai: message.role === 'assistant', collapsed: isMessageCollapsed(message) }"
          >
            <div class="message-title">
              <span class="message-identity">
                <span class="message-avatar">{{ message.role === 'assistant' ? 'AI' : 'U' }}</span>
                <strong>
                  {{ message.role === 'assistant' ? 'AI' : 'You' }}
                  <span v-if="message.streaming" class="streaming-dot">等待 {{ formatAnswerDuration(messageAnswerDuration(message)) }}</span>
                  <span v-else-if="message.role === 'assistant' && messageAnswerDuration(message)" class="message-duration">耗时 {{ formatAnswerDuration(messageAnswerDuration(message)) }}</span>
                </strong>
              </span>
              <span v-if="message.sourceConnectionId" class="chip script-message-source" :title="`生成上下文：${connectionLabel(message.sourceConnectionId)}`">来源 · {{ connectionLabel(message.sourceConnectionId) }}</span>
              <div class="script-reply-actions">
                <button v-if="message.role === 'assistant' && message.streaming" class="text-button danger" type="button" @click="stopScriptGeneration">
                  停止
                </button>
                <button v-if="shouldCollapseMessage(message)" class="text-button" type="button" @click="toggleMessage(message.id)">
                  {{ isMessageExpanded(message) ? '收起' : '展开' }}
                </button>
              </div>
            </div>
            <div class="message-body">
              <div v-if="message.streaming && !message.text" class="thinking-row"><span /><span /><span />正在修改「{{ message.targetTitle }}」，已等待 {{ formatAnswerDuration(messageAnswerDuration(message)) }}</div>
              <template v-for="(part, index) in parseMessageParts(message.text)" :key="`${message.id}-${index}`">
                <div
                  v-if="part.type === 'text' && part.content.trim()"
                  class="markdown-content"
                  v-html="renderMarkdown(part.content)"
                />
                <div v-else-if="part.type === 'code'" class="code-block">
                  <div class="code-head">
                    <span>{{ codeBlockLabel(part.language, part.content) }}</span>
                    <span
                      v-if="shellCommandForPart(part)"
                      class="command-risk-status"
                      :class="`risk-${scriptRiskStatusForScript(shellCommandForPart(part)).level}`"
                      :title="scriptRiskStatusForScript(shellCommandForPart(part)).message"
                    >
                      {{ scriptRiskStatusForScript(shellCommandForPart(part)).label }}
                    </span>
                    <div v-if="shellCommandForPart(part)" class="script-reply-code-actions">
                      <button class="text-button" type="button" @click="applyDraftScript(shellCommandForPart(part), message.id)">创建独立草稿并打开</button>
                      <button class="text-button primary-action" type="button" @click="executeScriptContent(shellCommandForPart(part), message.sourceConnectionId ? { connectionId: message.sourceConnectionId } : undefined)">执行</button>
                    </div>
                  </div>
                  <pre><code>{{ part.content }}</code></pre>
                </div>
              </template>
              <div v-if="message.scriptContent" class="code-block script-code-card">
                <div class="code-head">
                  <span>{{ messageScriptStatus(message) }}<span v-if="message.targetTitle"> · {{ message.targetTitle }}</span></span>
                  <span class="command-risk-status" :class="`risk-${scriptRiskStatusForScript(scriptContentForMessage(message)).level}`">{{ scriptRiskStatusForScript(scriptContentForMessage(message)).label }}</span>
                  <div class="script-reply-code-actions">
                    <button class="text-button" type="button" @click="toggleScriptEditor(message)">
                      {{ editingMessageId === message.id ? '完成' : '编辑' }}
                    </button>
                    <button v-if="message.targetDocumentId && documents[message.targetDocumentId]" class="text-button" type="button" @click="reviewMessageVersion(message)">核对并应用到「{{ message.targetTitle }}」</button>
                    <button class="text-button" type="button" @click="applyDraftScript(scriptContentForMessage(message), message.id)">创建独立草稿并打开</button>
                    <button class="text-button" type="button" :disabled="saveState === 'saving'" @click="saveMessageScript(message)">{{ message.savedScriptId ? '保存到「' + (scripts.find(script => script.id === message.savedScriptId)?.name || '脚本') + '」' : '保存为新脚本' }}</button>
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
        </div>
    </section>
    <div v-if="showScriptComposer" class="script-ai-compose">
      <div class="script-composer-shell" @click.self="focusScriptComposer">
        <textarea
          ref="scriptComposerInput"
          id="script-ai-prompt"
          v-model="askText"
          :disabled="!hasUsableConfig"
          rows="1"
          :placeholder="scriptComposerPlaceholder"
          :title="scriptComposerPlaceholder"
          aria-label="询问 AI 修改脚本"
          @keydown="handleComposerKeydown"
        />
        <div class="script-composer-footer">
          <span class="script-composer-label" :title="isGenerating ? `正在修改「${currentTargetTitle}」` : `AI 修改：${activeScriptTitle}`"><UiIcon name="ai" size="13" />{{ isGenerating ? '生成中' : 'AI' }}</span>
          <span class="script-composer-model" :title="hasUsableConfig ? config.model : '请在设置中心配置 AI'">{{ hasUsableConfig ? config.model : '请先配置 AI' }}</span>
          <button
          class="icon-button"
          type="button"
          :title="isGenerating ? '停止回答' : 'Ctrl+Enter / ⌘+Enter 发送'"
          :aria-label="isGenerating ? '停止回答' : '发送'"
          :disabled="!isGenerating && !hasUsableConfig"
          @click="isGenerating ? stopScriptGeneration() : sendActiveScriptRequest()"
        >
          <UiIcon v-if="isGenerating" name="stop" />
          <UiIcon v-else name="arrow-up" />
        </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style src="../styles/script-panel.css" scoped></style>
