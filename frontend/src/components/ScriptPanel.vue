<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
import { analyzeScriptReadiness, scriptReadinessStatusForContent } from '../lib/scriptReadiness'
import type { ScriptReadinessIssue } from '../lib/scriptReadiness'
import {
  cancelTask,
  chatWithAiProviderStream,
  deleteUpdateScript,
  generateAiScriptTitle,
  listUpdateScripts,
  onAiChatStream,
  saveUpdateScript
} from '../lib/tauri'
import { parseMessageParts, renderMarkdown, type MessagePart } from '../lib/aiMarkdown'
import { codeBlockLabel, shellCommandFromCodeBlock } from '../lib/shellCommand'
import { detectShellScriptLanguage, type ShellScriptLanguage } from '../lib/shellCommand'
import { prepareScriptForExecution } from '../lib/scriptExecution'
import ContextMenu from './ContextMenu.vue'
import UiIcon from './UiIcon.vue'

interface ScriptChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  scriptContent?: string
  savedScriptId?: string
  streaming?: boolean
  error?: boolean
  createdAt: string
  durationSeconds?: number
  sourceConnectionId?: string
  sourceWorkspaceSessionId?: string
  sourceCommands?: string[]
}

interface ScriptExecutionSource {
  connectionId: string
  name?: string
}

const props = defineProps<{
  terminalId: string
  connectionId: string
  workspaceSessionId: string
  connectionLabels: Record<string, string>
  executionTargetLabel: string
  executionTargetTitle: string
  executionTargetConnectionIds: string[]
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
type ScriptEditorSource = 'draft' | 'selected'
interface EditorCursor {
  line: number
  column: number
}
const MAX_SCRIPT_SOURCE_COMMANDS = 80
const MAX_RECORDED_OUTPUT_CHARS = 80_000
const LONG_MESSAGE_CHARS = 900
const LONG_MESSAGE_LINES = 12
const STREAM_TIMER_INTERVAL_MS = 1000
const PREVIEW_SCRIPT_STORAGE_KEY = 'ai-term:update-scripts:v2:global'
const LEGACY_PREVIEW_SCRIPT_STORAGE_PREFIX = 'ai-term:update-scripts:'

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
const scriptSearch = ref('')
const editingMessageId = ref('')
const scriptDrafts = ref<Record<string, string>>({})
const currentRequestId = ref('')
const currentAssistantMessageId = ref('')
const answerElapsedSeconds = ref(0)
const answerDurations = ref<Record<string, number>>({})
const stopRequested = ref(false)
const renamingScript = ref<UpdateScript | null>(null)
const scriptNameDraft = ref('')
const selectedScriptDraft = ref('')
const selectedScriptEditing = ref(false)
const draftScriptId = ref('')
const draftScriptContent = ref('')
const draftSourceConnectionId = ref('')
const draftSourceWorkspaceSessionId = ref('')
const draftSourceCommands = ref<string[]>([])
const scriptPreviewSource = ref<ScriptPreviewSource>('')
const pendingScriptExecution = ref('')
const pendingScriptSource = ref<ScriptExecutionSource | null>(null)
const scriptRiskExplanation = ref('')
const scriptRiskExplanationError = ref('')
const scriptRiskExplanationLoading = ref(false)
const scriptRiskExplanationRequestId = ref('')
const scriptEditorMenu = ref<{ source: ScriptEditorSource; x: number; y: number } | null>(null)
const draftEditorCursor = ref<EditorCursor>({ line: 1, column: 1 })
const selectedEditorCursor = ref<EditorCursor>({ line: 1, column: 1 })
const expandedEditorCursor = ref<EditorCursor>({ line: 1, column: 1 })
const draftReadinessIndex = ref(0)
const selectedReadinessIndex = ref(0)
const expandedReadinessIndex = ref(0)
let answerTimer: number | undefined

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
const scriptSourceConnectionId = computed(() => recordingHasData.value ? props.recording.connectionId : props.connectionId)
const scriptSourceWorkspaceSessionId = computed(() => {
  const sourceSessionId = recordingHasData.value ? props.recording.workspaceSessionId : props.workspaceSessionId
  return sourceSessionId || 'ai:default'
})
const hasDraftScript = computed(() => draftScriptContent.value.trim().length > 0)
const hasSelectedScriptContent = computed(() => selectedScriptContent.value.trim().length > 0)
const editingSelectedScript = computed(() => scriptPanelMode.value === 'library' && scriptLibraryView.value === 'detail' && Boolean(selectedScript.value))
const showScriptComposer = computed(() => scriptPanelMode.value === 'generate' || editingSelectedScript.value)
const activeScriptHasContent = computed(() => editingSelectedScript.value ? hasSelectedScriptContent.value : hasDraftScript.value)
const scriptComposerPlaceholder = computed(() => {
  if (activeScriptHasContent.value) return '描述你想修改或优化的脚本功能...'
  return '描述你想生成的脚本，例如：备份 /var/log 并压缩...'
})
const hasScriptReplies = computed(() => messages.value.length > 0)
const scriptReplyCountText = computed(() => `${messages.value.length} 条消息`)
const draftLineNumbers = computed(() => lineNumbersForScript(draftScriptContent.value))
const selectedScriptLineNumbers = computed(() => lineNumbersForScript(selectedScriptContent.value))
const scriptPreviewOpen = computed(() => scriptPreviewSource.value !== '')
const expandedScriptTitle = computed(() => scriptPreviewSource.value === 'selected' ? selectedScript.value?.name || '脚本预览' : '脚本预览')
const expandedScriptContent = computed(() => scriptPreviewSource.value === 'selected' ? selectedScriptContent.value : draftScriptContent.value)
const expandedScriptLineNumbers = computed(() => lineNumbersForScript(expandedScriptContent.value))
const draftSavedScript = computed(() => scripts.value.find((script) => script.id === draftScriptId.value))
const draftScriptHighlightedHtml = computed(() => highlightShellScript(draftScriptContent.value, draftSavedScript.value?.name))
const selectedScriptHighlightedHtml = computed(() => highlightShellScript(selectedScriptContent.value, selectedScript.value?.name))
const expandedScriptHighlightedHtml = computed(() => highlightShellScript(expandedScriptContent.value, expandedScriptTitle.value))
const draftScriptTitle = computed(() => draftSavedScript.value?.name || '未命名脚本')
const draftScriptDirty = computed(() => {
  if (!hasDraftScript.value) return false
  return !draftSavedScript.value || draftScriptContent.value.trimEnd() !== draftSavedScript.value.content.trimEnd()
})
const selectedScriptDirty = computed(() => {
  if (!selectedScript.value || !hasSelectedScriptContent.value) return false
  return selectedScriptContent.value.trimEnd() !== selectedScript.value.content.trimEnd()
})
const draftScriptReadiness = computed(() => scriptReadinessStatusForContent(draftScriptContent.value))
const selectedScriptReadiness = computed(() => scriptReadinessStatusForContent(selectedScriptContent.value))
const expandedScriptReadiness = computed(() => scriptReadinessStatusForContent(expandedScriptContent.value))
const canExecuteDraft = computed(() => hasDraftScript.value && draftScriptReadiness.value.issues.length === 0)
const canExecuteSelectedScript = computed(() => hasSelectedScriptContent.value && selectedScriptReadiness.value.issues.length === 0)
const canExecuteExpandedScript = computed(() => expandedScriptContent.value.trim().length > 0 && expandedScriptReadiness.value.issues.length === 0)
const recordingActionLabel = computed(() => recordingHasData.value ? '重新录制' : '开始录制')
const draftSaveStatus = computed(() => editorSaveStatus(hasDraftScript.value, draftScriptDirty.value))
const selectedSaveStatus = computed(() => editorSaveStatus(hasSelectedScriptContent.value, selectedScriptDirty.value))
const scriptEditorMenuItems = computed(() => {
  const source = scriptEditorMenu.value?.source
  if (source === 'selected') {
    return [
      { id: 'copy', label: '复制脚本', disabled: !hasSelectedScriptContent.value, action: () => void copySelectedScript() },
      { id: 'preview', label: '放大预览', disabled: !hasSelectedScriptContent.value, action: () => openScriptPreview('selected') }
    ]
  }
  return [
    { id: 'copy', label: '复制脚本', disabled: !hasDraftScript.value, action: () => void copyDraftScript() },
    { id: 'preview', label: '放大预览', disabled: !hasDraftScript.value, action: () => openScriptPreview('draft') },
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

function preparedScriptContent(content: string, fileName = '') {
  return prepareScriptForExecution(content, detectShellScriptLanguage(content, fileName))
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
  if (!hasContent) return ''
  if (saveState.value === 'saving') return '保存中'
  return dirty ? '未保存' : '已保存'
}

const draftScriptRiskStatus = computed(() => scriptEditorRiskStatus(draftScriptContent.value, draftSavedScript.value?.name))
const selectedScriptRiskStatus = computed(() => scriptEditorRiskStatus(selectedScriptContent.value, selectedScript.value?.name))
const expandedScriptRiskStatus = computed(() => scriptEditorRiskStatus(expandedScriptContent.value, expandedScriptTitle.value))
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
const hasUsableConfig = computed(() => {
  return Boolean(props.config.baseUrl.trim() && props.config.model.trim() && (props.config.apiKey?.trim() || props.apiKey.trim()))
})
const filteredScripts = computed(() => {
  const keyword = scriptSearch.value.trim().toLowerCase()
  if (!keyword) return scripts.value
  return scripts.value.filter((script) => {
    return `${script.name} ${script.description} ${scriptSourceLabel(script)} ${script.connectionId} ${script.workspaceSessionId}`.toLowerCase().includes(keyword)
  })
})
const scriptLibraryEmptyHint = computed(() => {
  return scriptSearch.value.trim() ? '没有匹配的脚本，清空搜索后再试。' : '点击新增生成脚本，或直接粘贴并保存你的脚本。'
})

onMounted(() => {
  migratePreviewScripts()
  void loadScripts()
})

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

onBeforeUnmount(() => {
  stopAnswerTimer()
})

async function loadScripts() {
  try {
    panelError.value = ''
    scripts.value = await listUpdateScripts()
    scriptStoreMode.value = 'sqlite'
    if (!scripts.value.some((script) => script.id === selectedScriptId.value)) {
      selectedScriptId.value = scripts.value[0]?.id ?? ''
    }
  } catch (error) {
    if (!isTauriUnavailableError(error)) {
      panelError.value = formatError(error)
    }
    scriptStoreMode.value = 'preview'
    scripts.value = loadPreviewScripts()
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
  const menuWidth = 220
  const menuHeight = source === 'draft' ? 174 : 138
  scriptEditorMenu.value = {
    source,
    x: Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)),
    y: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - menuHeight - 8))
  }
}

function closeScriptEditorMenu() {
  scriptEditorMenu.value = null
}

function cursorPositionForTextarea(target: HTMLTextAreaElement): EditorCursor {
  const beforeCursor = target.value.slice(0, target.selectionStart ?? 0)
  const lines = beforeCursor.split('\n')
  return {
    line: lines.length,
    column: (lines[lines.length - 1]?.length ?? 0) + 1
  }
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

function lineNumbersForScript(content: string) {
  const lineCount = Math.max(1, content.split('\n').length)
  return Array.from({ length: lineCount }, (_, index) => String(index + 1)).join('\n')
}

function highlightShellScript(content: string, fileName = '') {
  const language = detectShellScriptLanguage(content, fileName)
  return content.split('\n').map((line) => highlightShellLine(line, language) || ' ').join('\n')
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

function readinessLinesText(issues: ScriptReadinessIssue[]) {
  return issues.map((issue) => issue.line).join('、')
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

const bashTokenPattern = /(\x22(?:\\.|[^\x22\\])*\x22|'(?:\\.|[^'\\])*'|#[^\n]*|\$(?:\{[^}\n]+\}|[A-Za-z_][\w]*|[0-9@*#?$!-])|\b[A-Za-z_][\w]*(?=\s*\(\s*\)\s*\{)|\b(?:sudo|apt|apt-get|yum|dnf|pacman|brew|systemctl|service|docker|podman|kubectl|helm|rm|cp|mv|sed|awk|grep|find|chmod|chown|curl|wget|echo|printf|read|set|test|cat|mkdir|touch|tar|ssh|scp|rsync|if|then|elif|else|fi|for|in|do|done|while|until|case|esac|select|function|export|source|local|readonly|declare|unset|shift|trap|exit|return|break|continue)\b|&&|\|\||<<|>>|[|;&<>])/g
const powershellTokenPattern = /(\x22(?:\\.|[^\x22\\])*\x22|'(?:''|[^'])*'|#[^\n]*|\$(?:\{[^}\n]+\}|(?:env|global|script|local|private):[A-Za-z_][\w]*|[A-Za-z_?][\w?]*|[_^$])|\b(?:Add|Clear|Connect|ConvertFrom|ConvertTo|Copy|Disable|Disconnect|Enable|Enter|Exit|Export|Find|Format|ForEach|Get|Import|Install|Invoke|Join|Measure|Move|New|Out|Read|Receive|Register|Remove|Rename|Restart|Select|Send|Set|Sort|Split|Start|Stop|Test|Uninstall|Unregister|Update|Wait|Where|Write)-[A-Z][A-Za-z0-9-]*\b|\b(?:function|filter|param|begin|process|end|if|elseif|else|foreach|for|while|do|switch|try|catch|finally|throw|return|break|continue|class|enum|using)\b|-(?:eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin|replace|split|join|is|isnot|as|and|or|xor|not)\b|&&|\|\||[|;&<>])/gi
const cmdTokenPattern = /(\x22(?:[^\x22]|\x22\x22)*\x22|(?:^|\s)(?:rem\b.*|::.*)$|%(?:[A-Za-z_][\w]*|[0-9*])%|![A-Za-z_][\w]*!|\b(?:echo|set|setlocal|endlocal|if|else|for|in|do|call|goto|shift|exit|start|title|color|copy|move|del|erase|type|dir|mkdir|md|rmdir|rd|pushd|popd|tasklist|taskkill|where|find|findstr)\b|&&|\|\||>>|[|&<>])/gi

function highlightShellLine(line: string, language: ShellScriptLanguage) {
  const tokenPattern = language === 'powershell'
    ? powershellTokenPattern
    : language === 'cmd'
      ? cmdTokenPattern
      : bashTokenPattern
  tokenPattern.lastIndex = 0
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
  if (/^\s*(?:rem\b|::)/i.test(token)) return "<span class='shell-token comment'>" + escaped + '</span>'
  if (/^%[^%]+%$/.test(token) || /^![^!]+!$/.test(token)) return "<span class='shell-token variable'>" + escaped + '</span>'
  if (/^-(?:eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin|replace|split|join|is|isnot|as|and|or|xor|not)$/i.test(token)) return "<span class='shell-token operator'>" + escaped + '</span>'
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

async function sendScriptRequest(
  mode: 'generate' | 'revise' | 'regenerate' = hasDraftScript.value ? 'revise' : 'generate',
  target: 'draft' | 'selected' = 'draft'
) {
  if (target === 'draft' && scriptPanelMode.value !== 'generate') openGenerateMode()
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
  try {
    unlisten = await onAiChatStream(requestId, (event) => {
      if (stopRequested.value || currentRequestId.value !== requestId) return
      if (event.kind === 'chunk') {
        answer += event.delta
        updateAssistantMessage(assistantMessage.id, answer, true)
      }
      if (event.kind === 'error' && event.error) {
        if (stopRequested.value) return
        finishAnswerTimer(assistantMessage.id)
        updateAssistantMessage(assistantMessage.id, `模型调用失败。\n\n错误详情：${event.error}`, false, true)
      }
    })
    const response = await chatWithAiProviderStream(requestId, {
      config: props.config,
      apiKey,
      question: prompt,
      terminalSnapshot: recordedOutput.value || props.terminalSnapshot,
      commandHistory: userMessage.sourceCommands ?? []
    })
    if (stopRequested.value || currentRequestId.value !== requestId) return
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
    if (stopRequested.value || currentRequestId.value !== requestId) return
    finishAnswerTimer(assistantMessage.id)
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
  sourceConnectionId = scriptSourceConnectionId.value,
  sourceWorkspaceSessionId = scriptSourceWorkspaceSessionId.value,
  sourceCommandSnapshot = [...sourceCommands.value]
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

async function sendSelectedScriptRequest() {
  const content = selectedScriptContent.value.trimEnd()
  if (!selectedScript.value || !content.trim()) {
    panelError.value = '当前脚本为空，无法请求 AI 修改。'
    return
  }
  draftScriptId.value = selectedScript.value.id
  draftScriptContent.value = content
  await sendScriptRequest('revise', 'selected')
}

async function removeScript(script: UpdateScript) {
  if (!window.confirm(`删除脚本 ${script.name}？`)) return
  try {
    if (scriptStoreMode.value === 'sqlite') {
      await deleteUpdateScript(script.id)
    } else {
      deletePreviewScript(script.id)
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
  if (!hasUsableConfig.value) {
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
      terminalSnapshot: recordedOutput.value || props.terminalSnapshot,
      commandHistory: sourceCommands.value
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
  emit('writeTerminalInput', `bash -s <<'AI_TERM_SCRIPT'\n${prepared}\nAI_TERM_SCRIPT\n`)
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
function toggleSelectedScriptEditor() {
  if (!selectedScript.value) return
  selectedScriptEditing.value = !selectedScriptEditing.value
}

function updateSelectedScriptDraft(value: string) {
  selectedScriptDraft.value = value
  saveState.value = 'idle'
  scriptExecutionNotice.value = ''
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

function shellCommandForPart(part: MessagePart) {
  if (part.type !== 'code') return ''
  return shellCommandFromCodeBlock(part.language, part.content)
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
    const sourceMessage = messages.value.find((message) => message.id === messageId)
    draftSourceConnectionId.value = sourceMessage?.sourceConnectionId ?? ''
    draftSourceWorkspaceSessionId.value = sourceMessage?.sourceWorkspaceSessionId ?? ''
    draftSourceCommands.value = [...(sourceMessage?.sourceCommands ?? [])]
    scriptDrafts.value = {
      ...scriptDrafts.value,
      [messageId]: content
    }
  }
}

function updateDraftScriptContent(value: string) {
  draftScriptContent.value = value
  saveState.value = 'idle'
  scriptExecutionNotice.value = ''
}

function clearDraftScript() {
  if (hasDraftScript.value && !window.confirm('清空当前脚本草稿？未保存的内容将丢失。')) return
  draftScriptContent.value = ''
  draftScriptId.value = ''
  draftSourceConnectionId.value = ''
  draftSourceWorkspaceSessionId.value = ''
  draftSourceCommands.value = []
  draftEditorCursor.value = { line: 1, column: 1 }
  saveState.value = 'idle'
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
    ? await generateScriptTitle(
        content,
        fallbackName,
        latestUserScriptRequest(),
        draftSourceCommands.value.length ? draftSourceCommands.value : undefined
      )
    : existing.name
  const script: UpdateScript = {
    id: existing?.id || `script-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    connectionId: existing?.connectionId ?? (draftSourceConnectionId.value || scriptSourceConnectionId.value),
    workspaceSessionId: existing?.workspaceSessionId ?? (draftSourceWorkspaceSessionId.value || scriptSourceWorkspaceSessionId.value),
    name,
    description: inferDescription(latestAssistantText()) || inferDescription(latestUserScriptRequest()) || '手动保存脚本',
    content,
    sourceCommands: draftSourceCommands.value.length ? draftSourceCommands.value : sourceCommands.value,
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
    draftSourceConnectionId.value = script.connectionId
    draftSourceWorkspaceSessionId.value = script.workspaceSessionId
    draftSourceCommands.value = [...script.sourceCommands]
    selectedScriptId.value = script.id
    selectedScriptDraft.value = content
    saveState.value = 'saved'
  } catch (error) {
    if (isTauriUnavailableError(error)) {
      scriptStoreMode.value = 'preview'
      savePreviewScript(script)
      scripts.value = [script, ...scripts.value.filter((item) => item.id !== script.id)]
      draftScriptId.value = script.id
      draftSourceConnectionId.value = script.connectionId
      draftSourceWorkspaceSessionId.value = script.workspaceSessionId
      draftSourceCommands.value = [...script.sourceCommands]
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
  stopAnswerTimer()
  answerElapsedSeconds.value = 0
  answerDurations.value = {}
  messages.value = []
  scriptDrafts.value = {}
  editingMessageId.value = ''
  selectedScriptId.value = ''
  draftScriptId.value = ''
  draftScriptContent.value = ''
  draftSourceConnectionId.value = ''
  draftSourceWorkspaceSessionId.value = ''
  draftSourceCommands.value = []
  collapsedMessages.value = {}
  saveState.value = 'idle'
  panelError.value = ''
}

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

function startAnswerTimer() {
  stopAnswerTimer()
  const startedAt = Date.now()
  answerElapsedSeconds.value = 0
  answerTimer = window.setInterval(() => {
    answerElapsedSeconds.value = Math.floor((Date.now() - startedAt) / 1000)
  }, STREAM_TIMER_INTERVAL_MS)
}

function stopAnswerTimer() {
  if (answerTimer) window.clearInterval(answerTimer)
  answerTimer = undefined
}

function finishAnswerTimer(messageId?: string) {
  const seconds = answerTimer ? Math.max(1, answerElapsedSeconds.value) : answerElapsedSeconds.value
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
  const shellBlock = parseMessageParts(answer)
    .find((part) => part.type === 'code' && shellCommandForPart(part))
  return shellBlock?.type === 'code' ? shellCommandForPart(shellBlock) : ''
}

function displayAnswerWithoutScript(answer: string) {
  const parts = parseMessageParts(answer)
  if (!parts.some((part) => part.type === 'code' && shellCommandForPart(part))) return answer.trim()
  const displayText = parts
    .map((part) => {
      if (part.type === 'text') return part.content
      if (shellCommandForPart(part)) return ''
      const language = codeBlockLabel(part.language, part.content)
      return `\`\`\`${language === 'text' ? '' : language}\n${part.content}\n\`\`\``
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return displayText || '已生成脚本，可在卡片中编辑、保存或执行。'
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

function isDangerousScript(content: string) {
  return analyzeScriptRisks(preparedScriptContent(content)).length > 0
}

function parsePreviewScripts(raw: string | null) {
  if (!raw) return { scripts: [] as UpdateScript[], valid: true }
  try {
    const value = JSON.parse(raw)
    return { scripts: Array.isArray(value) ? value as UpdateScript[] : [], valid: Array.isArray(value) }
  } catch {
    return { scripts: [] as UpdateScript[], valid: false }
  }
}

function mergePreviewScripts(scriptGroups: UpdateScript[][]) {
  const scriptsById = new Map<string, UpdateScript>()
  scriptGroups.flat().forEach((script) => {
    if (!script || typeof script.id !== 'string' || !script.id) return
    const current = scriptsById.get(script.id)
    if (!current || previewScriptUpdatedAt(script) > previewScriptUpdatedAt(current)) {
      scriptsById.set(script.id, script)
    }
  })
  return [...scriptsById.values()].sort((left, right) => previewScriptUpdatedAt(right) - previewScriptUpdatedAt(left))
}

function previewScriptUpdatedAt(script: UpdateScript) {
  const updatedAt = Date.parse(script.updatedAt)
  if (Number.isFinite(updatedAt)) return updatedAt
  const createdAt = Date.parse(script.createdAt)
  return Number.isFinite(createdAt) ? createdAt : 0
}

function migratePreviewScripts() {
  try {
    const globalStore = parsePreviewScripts(window.localStorage.getItem(PREVIEW_SCRIPT_STORAGE_KEY))
    const legacyKeys: string[] = []
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index)
      if (key && key !== PREVIEW_SCRIPT_STORAGE_KEY && key.startsWith(LEGACY_PREVIEW_SCRIPT_STORAGE_PREFIX)) {
        legacyKeys.push(key)
      }
    }

    const migratedKeys: string[] = []
    const legacyGroups = legacyKeys.flatMap((key) => {
      const legacyStore = parsePreviewScripts(window.localStorage.getItem(key))
      if (!legacyStore.valid) return []
      migratedKeys.push(key)
      const sourceConnectionId = key.slice(LEGACY_PREVIEW_SCRIPT_STORAGE_PREFIX.length)
      return [legacyStore.scripts.map((script) => ({
        ...script,
        connectionId: script.connectionId || sourceConnectionId
      }))]
    })
    const mergedScripts = mergePreviewScripts([globalStore.scripts, ...legacyGroups])

    if (globalStore.valid && migratedKeys.length > 0) {
      window.localStorage.setItem(PREVIEW_SCRIPT_STORAGE_KEY, JSON.stringify(mergedScripts))
      migratedKeys.forEach((key) => window.localStorage.removeItem(key))
    }
    return mergedScripts
  } catch {
    return [] as UpdateScript[]
  }
}

function loadPreviewScripts() {
  return migratePreviewScripts()
}

function savePreviewScript(script: UpdateScript) {
  const nextScripts = [script, ...loadPreviewScripts().filter((item) => item.id !== script.id)]
  window.localStorage.setItem(PREVIEW_SCRIPT_STORAGE_KEY, JSON.stringify(nextScripts))
}

function deletePreviewScript(scriptId: string) {
  const nextScripts = loadPreviewScripts().filter((item) => item.id !== scriptId)
  window.localStorage.setItem(PREVIEW_SCRIPT_STORAGE_KEY, JSON.stringify(nextScripts))
}

function connectionLabel(connectionId?: string) {
  if (!connectionId) return '未知连接'
  return props.connectionLabels[connectionId] || connectionId
}

function executionTargetsDifferFromSource(sourceConnectionId?: string) {
  if (!sourceConnectionId) return false
  const targetConnectionIds = props.executionTargetConnectionIds.length
    ? props.executionTargetConnectionIds
    : [props.connectionId]
  return targetConnectionIds.some((connectionId) => connectionId !== sourceConnectionId)
}

function scriptSourceLabel(script: UpdateScript) {
  return connectionLabel(script.connectionId?.trim())
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function focusScriptComposer() {
  if (!hasUsableConfig.value) return
  void nextTick(() => {
    scriptComposerInput.value?.focus()
  })
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
        <div class="script-primary-actions">
        <button class="icon-button" type="button" title="脚本库" aria-label="脚本库" @click="openLibraryMode"><UiIcon name="list" /></button>
        <button class="text-button" type="button" title="新增脚本" @click="createScriptConversation"><UiIcon name="plus" />新建脚本</button>
        <button v-if="!props.recording.isRecording" class="text-button record-action" type="button" @click="startRecording">
          <UiIcon :name="recordingHasData ? 'refresh' : 'play'" />{{ recordingActionLabel }}
        </button>
        <button v-else class="text-button danger" type="button" @click="stopRecording"><UiIcon name="stop" />停止录制</button>
        </div>
      </div>
    </div>

    <ContextMenu
      v-if="scriptEditorMenu"
      :x="scriptEditorMenu.x"
      :y="scriptEditorMenu.y"
      :title="scriptEditorMenu.source === 'draft' ? '草稿操作' : '脚本操作'"
      :items="scriptEditorMenuItems"
      @close="closeScriptEditorMenu"
    />

    <div v-if="renamingScript" class="modal-backdrop" role="presentation" @click.self="closeRenameScriptDialog">
      <form class="modal rename-modal" role="dialog" aria-modal="true" aria-label="编辑脚本名称" @submit.prevent="renameScript">
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
      <section class="modal script-preview-modal" role="dialog" aria-modal="true" aria-label="脚本放大预览">
        <div class="modal-head">
          <div class="script-preview-title">
            <span class="script-file-icon"><UiIcon name="script" size="13" /></span>
            <strong>{{ expandedScriptTitle }}</strong>
            <button
              v-if="expandedScriptReadiness.issues.length"
              class="script-readiness-status readiness-pending"
              type="button"
              :title="expandedScriptReadiness.message"
              @click="focusNextExpandedReadinessIssue"
            >{{ expandedScriptReadiness.label }} · 第 {{ readinessLinesText(expandedScriptReadiness.issues) }} 行</button>
            <span v-else class="script-preview-mode">编辑模式</span>
          </div>
          <div class="script-editor-tools">
            <button class="icon-button" type="button" title="保存脚本" aria-label="保存脚本" :disabled="!expandedScriptContent.trim()" @click="saveExpandedScript"><UiIcon name="save" /></button>
            <button class="icon-button" type="button" title="复制脚本" aria-label="复制脚本" @click="copyExpandedScript"><UiIcon name="copy" /></button>
            <button class="icon-button" type="button" title="执行脚本" aria-label="执行脚本" :disabled="!canExecuteExpandedScript" @click="executeExpandedScript"><UiIcon name="play" /></button>
            <button class="icon-button" type="button" title="关闭预览" aria-label="关闭预览" @click="closeScriptPreview"><UiIcon name="close" /></button>
          </div>
        </div>
        <div class="script-expanded-editor">
          <div class="script-editor-shell">
            <pre ref="expandedScriptLineRail" class="script-line-rail" aria-hidden="true">{{ expandedScriptLineNumbers }}</pre>
            <pre ref="expandedScriptHighlight" class="script-code-overlay" aria-hidden="true"><code v-html="expandedScriptHighlightedHtml" /></pre>
            <textarea
              ref="expandedScriptTextarea"
              :value="expandedScriptContent"
              wrap="off"
              spellcheck="false"
              aria-label="编辑放大脚本"
              @input="updateExpandedScriptContent(($event.target as HTMLTextAreaElement).value)"
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
      <section class="modal script-risk-modal" role="dialog" aria-modal="true" :aria-label="pendingExecutionTitle">
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
    <p v-else-if="saveState === 'saved'" class="script-feedback">脚本已保存到 {{ scriptStoreMode === 'sqlite' ? 'SQLite' : 'localStorage' }}.</p>

    <div v-if="scriptPanelMode === 'library'" class="script-library" :class="{ 'detail-view': scriptLibraryView === 'detail' }">
      <template v-if="scriptLibraryView === 'list'">
        <div class="session-search script-library-search">
          <span><UiIcon name="search" size="14" /></span>
          <input ref="librarySearchInput" v-model="scriptSearch" placeholder="搜索脚本..." aria-label="搜索脚本" />
        </div>

        <div v-if="filteredScripts.length === 0" class="script-library-empty">
          <strong>暂无脚本</strong>
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
                <small>{{ script.description || script.updatedAt }} · 来源 {{ scriptSourceLabel(script) }}</small>
              </span>
              <button class="icon-button" type="button" title="编辑脚本名" aria-label="编辑脚本名" @click.stop="openRenameScriptDialog(script)"><UiIcon name="edit" /></button>
              <button class="icon-button danger" type="button" title="删除脚本" aria-label="删除脚本" @click.stop="removeScript(script)"><UiIcon name="trash" /></button>
            </article>
          </div>
        </div>
      </template>

      <section v-else-if="scriptLibraryView === 'detail' && selectedScript" class="script-preview">
        <div class="script-library-editor">
          <div class="script-editor-toolbar">
            <div
              class="script-file-tab"
              :class="{
                'has-risk': selectedScriptRiskStatus.level === 'medium' || selectedScriptRiskStatus.level === 'high',
                'has-readiness-issues': selectedScriptReadiness.issues.length > 0
              }"
            >
              <span class="script-file-icon"><UiIcon name="script" size="13" /></span>
              <strong>{{ selectedScript.name }}</strong>
              <span v-if="selectedScriptDirty" class="script-dirty-dot" title="有未保存的修改" aria-label="有未保存的修改" />
              <button
                v-if="hasSelectedScriptContent"
                class="script-readiness-status"
                :class="`readiness-${selectedScriptReadiness.level}`"
                :title="selectedScriptReadiness.message"
                type="button"
                @click="focusNextSelectedReadinessIssue"
              ><template v-if="selectedScriptReadiness.issues.length">待填 {{ selectedScriptReadiness.issues.length }} · {{ readinessLinesText(selectedScriptReadiness.issues) }}行</template><template v-else>{{ selectedScriptReadiness.label }}</template></button>
              <span
                v-if="hasSelectedScriptContent"
                class="script-editor-risk"
                :class="`risk-${selectedScriptRiskStatus.level}`"
                :title="selectedScriptRiskStatus.message"
              >{{ scriptRiskDisplayLabel(selectedScriptRiskStatus) }}</span>
            </div>
            <div class="script-editor-tools">
              <button class="icon-button" type="button" title="保存脚本" aria-label="保存脚本" :disabled="!hasSelectedScriptContent" @click="saveSelectedScript"><UiIcon name="save" /></button>
              <button
                class="text-button script-run-button"
                :class="{
                  'medium-risk-run': selectedScriptRiskStatus.level === 'medium',
                  'high-risk-run': selectedScriptRiskStatus.level === 'high'
                }"
                type="button"
                :title="selectedScriptRiskStatus.level === 'high' ? '检测到高风险命令，运行前必须确认' : '运行脚本'"
                :disabled="!canExecuteSelectedScript"
                @click="executeSelectedScript"
              ><UiIcon name="play" />运行</button>
              <button class="icon-button" type="button" title="更多操作" aria-label="更多操作" @click="openScriptEditorMenu($event, 'selected')"><UiIcon name="more" /></button>
            </div>
          </div>
          <div class="script-editor-shell">
            <pre ref="selectedScriptLineRail" class="script-line-rail" aria-hidden="true">{{ selectedScriptLineNumbers }}</pre>
            <pre ref="selectedScriptHighlight" class="script-code-overlay" aria-hidden="true"><code v-html="selectedScriptHighlightedHtml" /></pre>
            <textarea
              ref="selectedScriptTextarea"
              :value="selectedScriptContent"
              wrap="off"
              spellcheck="false"
              aria-label="编辑脚本"
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
      <p v-else class="empty-state script-preview-empty">选择脚本查看内容</p>
    </div>

    <div v-else class="script-generate">
      <div class="script-recorder" :class="{ idle: !props.recording.isRecording && !recordingHasData }">
        <span class="record-dot" :class="{ active: props.recording.isRecording }" />
        <div>
          <strong>{{ props.recording.isRecording ? '正在录制操作上下文' : recordingHasData ? '录制上下文已就绪' : '可录制操作，也可直接粘贴脚本' }}</strong>
          <small v-if="props.recording.isRecording || recordingHasData">{{ recordedCommands.length }} 条命令 &middot; {{ recordedOutput.length }} 字符输出{{ props.recording.isRecording ? ' · 录制中' : '' }}</small>
        </div>
      </div>

      <div class="script-workbench">
        <section class="script-draft-card">

          <div class="script-editor-toolbar">
            <div
              class="script-file-tab"
              :class="{
                'has-risk': draftScriptRiskStatus.level === 'medium' || draftScriptRiskStatus.level === 'high',
                'has-readiness-issues': draftScriptReadiness.issues.length > 0
              }"
            >
              <span class="script-file-icon"><UiIcon name="script" size="13" /></span>
              <strong>{{ draftScriptTitle }}</strong>
              <span v-if="draftScriptDirty" class="script-dirty-dot" title="有未保存的修改" aria-label="有未保存的修改" />
              <button
                v-if="hasDraftScript"
                class="script-readiness-status"
                :class="`readiness-${draftScriptReadiness.level}`"
                :title="draftScriptReadiness.message"
                type="button"
                @click="focusNextDraftReadinessIssue"
              ><template v-if="draftScriptReadiness.issues.length">待填 {{ draftScriptReadiness.issues.length }} · {{ readinessLinesText(draftScriptReadiness.issues) }}行</template><template v-else>{{ draftScriptReadiness.label }}</template></button>
              <span
                v-if="hasDraftScript"
                class="script-editor-risk"
                :class="`risk-${draftScriptRiskStatus.level}`"
                :title="draftScriptRiskStatus.message"
              >{{ scriptRiskDisplayLabel(draftScriptRiskStatus) }}</span>
            </div>
            <div class="script-editor-tools">
              <button class="icon-button" type="button" title="保存脚本草稿" aria-label="保存脚本草稿" :disabled="!hasDraftScript" @click="saveDraftScript"><UiIcon name="save" /></button>
              <button
                class="text-button script-run-button"
                :class="{
                  'medium-risk-run': draftScriptRiskStatus.level === 'medium',
                  'high-risk-run': draftScriptRiskStatus.level === 'high'
                }"
                type="button"
                :title="draftScriptRiskStatus.level === 'high' ? '检测到高风险命令，运行前必须确认' : '运行脚本'"
                :disabled="!canExecuteDraft"
                @click="executeDraftScript"
              ><UiIcon name="play" />运行</button>
              <button class="icon-button" type="button" title="更多操作" aria-label="更多操作" @click="openScriptEditorMenu($event, 'draft')"><UiIcon name="more" /></button>
            </div>
          </div>
          <div class="script-editor-shell">
            <pre ref="draftEditorLineRail" class="script-line-rail" aria-hidden="true">{{ draftLineNumbers }}</pre>
            <pre ref="draftScriptHighlight" class="script-code-overlay" aria-hidden="true"><code v-html="draftScriptHighlightedHtml" /></pre>
            <textarea
              ref="draftEditorTextarea"
              :value="draftScriptContent"
              wrap="off"
              spellcheck="false"
              aria-label="脚本草稿"
              placeholder="在这里粘贴、生成或编写 Shell 脚本..."
              @input="handleDraftEditorInput"
              @click="updateDraftEditorCursor"
              @keyup="updateDraftEditorCursor"
              @select="updateDraftEditorCursor"
              @scroll="syncDraftLineRail"
            />
            <div v-if="!hasDraftScript && !props.recording.isRecording" class="script-empty-guide">
              <small>可直接粘贴、编写脚本，或在下方描述让 AI 生成</small>
            </div>
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
            <small>{{ isGenerating ? '正在生成…' : scriptReplyCountText }}</small>
          </span>
          <button class="icon-button danger" type="button" title="清空对话" aria-label="清空对话" @click="clearConversation"><UiIcon name="trash" size="13" /></button>
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
              <div v-if="message.streaming && !message.text" class="thinking-row"><span /><span /><span />正在处理脚本，已等待 {{ formatAnswerDuration(messageAnswerDuration(message)) }}</div>
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
                      <button class="text-button" type="button" @click="applyDraftScript(shellCommandForPart(part), message.id)">设为草稿</button>
                      <button class="text-button primary-action" type="button" @click="executeScriptContent(shellCommandForPart(part), message.sourceConnectionId ? { connectionId: message.sourceConnectionId } : undefined)">执行</button>
                    </div>
                  </div>
                  <pre><code>{{ part.content }}</code></pre>
                </div>
              </template>
              <div v-if="message.scriptContent" class="code-block script-code-card">
                <div class="code-head">
                  <span>{{ message.savedScriptId ? '已保存' : '草稿' }}</span>
                  <span class="command-risk-status" :class="`risk-${scriptRiskStatusForScript(scriptContentForMessage(message)).level}`">{{ scriptRiskStatusForScript(scriptContentForMessage(message)).label }}</span>
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
        </div>
    </section>
    <div v-if="showScriptComposer" class="assistant-compose unified-ai-compose script-ai-compose" @pointerdown="focusScriptComposer">
        <textarea
          ref="scriptComposerInput"
          id="script-ai-prompt"
          v-model="askText"
          :disabled="!hasUsableConfig"
          rows="2"
          :placeholder="scriptComposerPlaceholder"
          :title="scriptComposerPlaceholder"
          aria-label="询问 AI 修改脚本"
          @keydown="handleComposerKeydown"
        />
        <button
          class="icon-button"
          type="button"
          :title="isGenerating ? '停止回答' : 'Ctrl+Enter / ⌘+Enter 发送'"
          :aria-label="isGenerating ? '停止回答' : '发送'"
          :disabled="!isGenerating && !hasUsableConfig"
          @click="isGenerating ? stopScriptGeneration() : sendActiveScriptRequest()"
        >
          <UiIcon v-if="isGenerating" name="stop" />
          <UiIcon v-else name="arrow-right" />
        </button>
      </div>
  </section>
</template>
