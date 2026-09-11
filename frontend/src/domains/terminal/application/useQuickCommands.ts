import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import type { Ref } from 'vue'
import type { ConnectionProfile } from '../../connections/types'
import { isSensitiveCommand } from '../../../shared/security/commandPrivacy'
import { scriptRiskStatusForContent } from '../../../shared/security/scriptRisk'

interface QuickCommandOptions {
  props: { profile?: ConnectionProfile }
  terminalCompletionOpen: Readonly<Ref<boolean>>
  historyCommandSuggestions: () => string[]
  refreshCompletionSuggestions: () => void
}

export function useQuickCommands({ props, terminalCompletionOpen, historyCommandSuggestions, refreshCompletionSuggestions }: QuickCommandOptions) {
  type PinQuickCommandResult = 'added' | 'exists' | 'invalid' | 'limit'

  interface QuickCommandsChangedDetail {
    storageKey: string
    commands: string[]
  }

  const DEFAULT_QUICK_COMMANDS = ['pwd', 'ls -la', 'df -h', 'free -m', 'ps aux', 'git status']

  const QUICK_COMMAND_STORAGE_KEY_PREFIX = 'ai-term:quick-commands:v1'

  const QUICK_COMMAND_LIMIT = 12

  const quickCommands = ref<string[]>(loadQuickCommands())

  const quickCommandSettingsOpen = ref(false)

  const quickCommandItems = ref<string[]>([...quickCommands.value])

  const quickCommandRecommendations = ref<string[]>([])

  const quickCommandResetConfirm = ref(false)

  const quickCommandNotice = ref('')

  const quickCommandError = ref('')

  const QUICK_COMMANDS_CHANGED_EVENT = 'ai-term:quick-commands-changed'

  function loadQuickCommands() {
    try {
      const raw = window.localStorage.getItem(quickCommandStorageKey()) ?? window.localStorage.getItem(QUICK_COMMAND_STORAGE_KEY_PREFIX)
      if (!raw) return [...DEFAULT_QUICK_COMMANDS]
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return safeQuickCommandList(parsed)
    } catch (error) {
      console.warn('failed to load quick commands', error)
    }
    return [...DEFAULT_QUICK_COMMANDS]
  }

  function persistQuickCommands(commands: string[]) {
    window.localStorage.setItem(quickCommandStorageKey(), JSON.stringify(commands))
  }

  function handleQuickCommandsChanged(event: Event) {
    const detail = (event as CustomEvent<QuickCommandsChangedDetail>).detail
    if (!detail || detail.storageKey !== quickCommandStorageKey() || !Array.isArray(detail.commands)) return
    quickCommands.value = safeQuickCommandList(detail.commands)
    if (terminalCompletionOpen.value) refreshCompletionSuggestions()
  }

  function quickCommandStorageKey() {
    return `${QUICK_COMMAND_STORAGE_KEY_PREFIX}:${props.profile?.id || 'local'}`
  }

  function safeQuickCommandList(commands: string[]) {
    return normalizeQuickCommandList(commands.filter((command) => (
      !isSensitiveCommand(command)
      && !isHighRiskQuickCommand(command)
      && scriptRiskStatusForContent(command).level !== 'high'
    )))
  }

  function normalizeQuickCommandList(commands: string[]) {
    const seen = new Set<string>()
    const result: string[] = []
    commands.forEach((command) => {
      const value = command.trim()
      if (!value || seen.has(value) || value.length > 140) return
      seen.add(value)
      result.push(value)
    })
    return result.slice(0, QUICK_COMMAND_LIMIT)
  }

  const normalizedQuickCommandItems = computed(() => normalizeQuickCommandList(
    quickCommandItems.value.filter((command) => {
      const value = command.trim()
      return value
        && value.length <= 140
        && !isSensitiveCommand(value)
        && !isHighRiskQuickCommand(value)
        && scriptRiskStatusForContent(value).level !== 'high'
    })
  ))

  const quickCommandEnabledCount = computed(() => normalizedQuickCommandItems.value.length)

  const quickCommandHasBlockingIssues = computed(() =>
    quickCommandItems.value.some((command) => {
      const value = command.trim()
      return Boolean(value && (
        value.length > 140
        || isSensitiveCommand(value)
        || isHighRiskQuickCommand(value)
        || scriptRiskStatusForContent(value).level === 'high'
      ))
    })
  )

  const quickCommandCanSave = computed(() => quickCommandEnabledCount.value > 0 && !quickCommandHasBlockingIssues.value)

  function syncQuickCommandItems(commands: string[]) {
    quickCommandItems.value = commands.length > 0 ? [...commands] : ['']
  }

  function quickCommandDuplicate(command: string, index: number) {
    const value = command.trim()
    if (!value) return false
    return quickCommandItems.value.some((item, itemIndex) => itemIndex !== index && item.trim() === value)
  }

  function quickCommandStatus(command: string, index: number) {
    const value = command.trim()
    if (!value) {
      return { label: '未启用', level: 'muted', message: '空行不会保存。', blocking: false }
    }
    if (value.length > 140) {
      return { label: '过长', level: 'high', message: '超过 140 个字符，请缩短后保存。', blocking: true }
    }
    if (isSensitiveCommand(value)) {
      return { label: '敏感', level: 'high', message: '包含凭证或密钥的命令不能保存。', blocking: true }
    }
    if (isHighRiskQuickCommand(value)) {
      return { label: '高风险', level: 'high', message: '高风险命令不能保存为固定命令。', blocking: true }
    }
    if (quickCommandDuplicate(command, index)) {
      return { label: '重复', level: 'medium', message: '重复命令会在保存时自动合并。', blocking: false }
    }
    const risk = scriptRiskStatusForContent(value)
    if (risk.level === 'high') {
      return { label: risk.label, level: risk.level, message: risk.message, blocking: true }
    }
    if (risk.level === 'safe') {
      return { label: '可用', level: 'safe', message: '未检测到风险。', blocking: false }
    }
    return { label: risk.label, level: risk.level, message: risk.message, blocking: false }
  }

  function shouldShowQuickCommandMessage(command: string, index: number) {
    const status = quickCommandStatus(command, index)
    return status.level !== 'safe'
  }

  function addQuickCommandItem(index = quickCommandItems.value.length - 1) {
    if (quickCommandItems.value.length >= QUICK_COMMAND_LIMIT) {
      quickCommandNotice.value = `最多保留 ${QUICK_COMMAND_LIMIT} 条固定命令。`
      return
    }
    quickCommandItems.value.splice(index + 1, 0, '')
    quickCommandError.value = ''
  }

  function removeQuickCommandItem(index: number) {
    if (quickCommandItems.value.length <= 1) {
      syncQuickCommandItems([''])
      return
    }
    quickCommandItems.value.splice(index, 1)
  }

  function moveQuickCommandItem(index: number, direction: -1 | 1) {
    const nextIndex = index + direction
    if (nextIndex < 0 || nextIndex >= quickCommandItems.value.length) return
    const next = [...quickCommandItems.value]
    const current = next[index]
    next[index] = next[nextIndex]
    next[nextIndex] = current
    quickCommandItems.value = next
  }

  function handleQuickCommandSettingsPointerDown(event: PointerEvent) {
    event.preventDefault()
    event.stopPropagation()
    openQuickCommandSettings()
  }

  function openQuickCommandSettings() {
    syncQuickCommandItems(quickCommands.value)
    quickCommandRecommendations.value = []
    quickCommandResetConfirm.value = false
    quickCommandNotice.value = ''
    quickCommandError.value = ''
    quickCommandSettingsOpen.value = true
  }

  function closeQuickCommandSettings() {
    quickCommandSettingsOpen.value = false
    quickCommandRecommendations.value = []
    quickCommandResetConfirm.value = false
  }

  function saveQuickCommandSettings() {
    if (!quickCommandCanSave.value) {
      quickCommandError.value = quickCommandEnabledCount.value === 0 ? '至少保留 1 条固定命令。' : '请先处理高风险或过长命令。'
      return
    }
    const nextCommands = commitQuickCommands(normalizedQuickCommandItems.value)
    syncQuickCommandItems(nextCommands)
    quickCommandRecommendations.value = []
    quickCommandResetConfirm.value = false
    quickCommandError.value = ''
    quickCommandNotice.value = '固定命令已保存。'
  }

  function commitQuickCommands(commands: string[]) {
    const nextCommands = safeQuickCommandList(commands)
    quickCommands.value = nextCommands
    persistQuickCommands(nextCommands)
    window.dispatchEvent(new CustomEvent<QuickCommandsChangedDetail>(QUICK_COMMANDS_CHANGED_EVENT, {
      detail: { storageKey: quickCommandStorageKey(), commands: nextCommands }
    }))
    if (terminalCompletionOpen.value) refreshCompletionSuggestions()
    return nextCommands
  }

  function pinQuickCommand(command: string): PinQuickCommandResult {
    const value = command.trim()
    if (
      !value
      || value.length > 140
      || isSensitiveCommand(value)
      || isHighRiskQuickCommand(value)
      || scriptRiskStatusForContent(value).level === 'high'
    ) return 'invalid'
    if (quickCommands.value.includes(value)) return 'exists'
    if (quickCommands.value.length >= QUICK_COMMAND_LIMIT) return 'limit'
    commitQuickCommands([...quickCommands.value, value])
    return 'added'
  }

  function resetQuickCommandDraft() {
    quickCommandResetConfirm.value = true
    quickCommandError.value = ''
    quickCommandNotice.value = ''
  }

  function confirmResetQuickCommandDraft() {
    syncQuickCommandItems(DEFAULT_QUICK_COMMANDS)
    quickCommandRecommendations.value = []
    quickCommandResetConfirm.value = false
    quickCommandError.value = ''
    quickCommandNotice.value = '已恢复默认候选，保存后生效。'
  }

  function cancelResetQuickCommandDraft() {
    quickCommandResetConfirm.value = false
  }

  function addQuickCommandRecommendation(command: string) {
    const merged = normalizeQuickCommandList([...quickCommandItems.value, command])
    syncQuickCommandItems(merged)
    quickCommandError.value = ''
    quickCommandNotice.value = '已追加候选，保存后生效。'
  }

  function appendQuickCommandRecommendations() {
    const merged = normalizeQuickCommandList([...quickCommandItems.value, ...quickCommandRecommendations.value])
    syncQuickCommandItems(merged)
    quickCommandError.value = ''
    quickCommandNotice.value = '已追加全部推荐，保存后生效。'
  }

  function replaceQuickCommandsWithRecommendations() {
    syncQuickCommandItems(quickCommandRecommendations.value)
    quickCommandError.value = ''
    quickCommandNotice.value = '已替换为推荐候选，保存后生效。'
  }

  function quickCommandHistorySeed() {
    return historyCommandSuggestions()
      .map((command) => command.trim())
      .filter((command) => command && !isSensitiveCommand(command))
      .slice(-80)
  }

  function isHighRiskQuickCommand(command: string) {
    return /\b(rm\s+-rf|mkfs|shutdown|reboot|halt|poweroff|format\s+|del\s+\/|remove-item\b|dd\s+if=|chmod\s+-R\s+777)\b/i.test(command) || command.includes(':(){')
  }

  function localQuickCommandRecommendations() {
    const events = quickCommandHistorySeed()
    const stats = new Map<string, { command: string; count: number; lastIndex: number }>()
    events.forEach((command, index) => {
      if (isHighRiskQuickCommand(command) || scriptRiskStatusForContent(command).level === 'high') return
      const current = stats.get(command)
      if (current) {
        current.count += 1
        current.lastIndex = index
      } else {
        stats.set(command, { command, count: 1, lastIndex: index })
      }
    })
    const recencyWindow = Math.max(1, events.length / 4)
    const score = (item: { count: number; lastIndex: number }) => {
      const age = Math.max(0, events.length - item.lastIndex - 1)
      return Math.log1p(item.count) + Math.exp(-age / recencyWindow)
    }
    return normalizeQuickCommandList(
      [...stats.values()]
        .sort((first, second) => (
          score(second) - score(first)
          || second.count - first.count
          || second.lastIndex - first.lastIndex
          || first.command.localeCompare(second.command)
        ))
        .map(({ command }) => command)
        .concat(DEFAULT_QUICK_COMMANDS)
    )
  }

  function recommendQuickCommandsFromHistory() {
    const current = new Set(normalizedQuickCommandItems.value)
    quickCommandRecommendations.value = localQuickCommandRecommendations()
      .filter((command) => !current.has(command))
    quickCommandError.value = ''
    quickCommandNotice.value = quickCommandRecommendations.value.length > 0
      ? '已根据本机历史生成推荐候选。'
      : '当前固定命令已覆盖可用的历史候选。'
    quickCommandResetConfirm.value = false
  }

  onMounted(() => window.addEventListener(QUICK_COMMANDS_CHANGED_EVENT, handleQuickCommandsChanged))
  onBeforeUnmount(() => window.removeEventListener(QUICK_COMMANDS_CHANGED_EVENT, handleQuickCommandsChanged))

  return { DEFAULT_QUICK_COMMANDS, QUICK_COMMAND_STORAGE_KEY_PREFIX, QUICK_COMMAND_LIMIT, QUICK_COMMANDS_CHANGED_EVENT, quickCommands, quickCommandSettingsOpen, quickCommandItems, quickCommandRecommendations, quickCommandResetConfirm, quickCommandNotice, quickCommandError, loadQuickCommands, persistQuickCommands, handleQuickCommandsChanged, quickCommandStorageKey, safeQuickCommandList, normalizeQuickCommandList, normalizedQuickCommandItems, quickCommandEnabledCount, quickCommandHasBlockingIssues, quickCommandCanSave, syncQuickCommandItems, quickCommandDuplicate, quickCommandStatus, shouldShowQuickCommandMessage, addQuickCommandItem, removeQuickCommandItem, moveQuickCommandItem, handleQuickCommandSettingsPointerDown, openQuickCommandSettings, closeQuickCommandSettings, saveQuickCommandSettings, commitQuickCommands, pinQuickCommand, resetQuickCommandDraft, confirmResetQuickCommandDraft, cancelResetQuickCommandDraft, addQuickCommandRecommendation, appendQuickCommandRecommendations, replaceQuickCommandsWithRecommendations, quickCommandHistorySeed, isHighRiskQuickCommand, localQuickCommandRecommendations, recommendQuickCommandsFromHistory }
}
