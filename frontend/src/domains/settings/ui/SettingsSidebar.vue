<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { AiProviderConfig } from '../../ai/types'
import type { AgentAllowlistEntry } from '../../ai/types'
import { BUILTIN_READONLY_COMMANDS, validateAllowlistPattern } from '../../ai/index'
import { isWindowsPlatform } from '../../../shared/platform/platform'
import type { AppUserSettings } from '../model/settings'
import { createDefaultUserSettings, MAX_AGENT_COMMAND_TIMEOUT_SEC, MAX_AGENT_STEP_LIMIT, MAX_TERMINAL_FONT_SIZE, MIN_AGENT_COMMAND_TIMEOUT_SEC, MIN_AGENT_STEP_LIMIT, MIN_TERMINAL_FONT_SIZE, normalizeUserSettings } from '../model/userSettings'
import { AiConfigPanel } from '../../ai/views'
import UiIcon from '../../../shared/ui/UiIcon.vue'

type SettingsSection = 'ai' | 'terminal' | 'agent'
const windowsPlatform = isWindowsPlatform()
const defaultUserSettings = createDefaultUserSettings(windowsPlatform)

const props = defineProps<{
  aiConfigs: AiProviderConfig[]
  selectedAiConfigId: string
  aiConfig: AiProviderConfig
  editorOpen: boolean
  editorMode: 'create' | 'edit'
  saveState: 'idle' | 'saving' | 'saved' | 'error'
  saveError: string
  settings: AppUserSettings
  agentAllowlist: AgentAllowlistEntry[]
}>()

const emit = defineEmits<{
  selectAiConfig: [configId: string]
  createAiConfig: []
  editAiConfig: [configId?: string]
  deleteAiConfig: [configId: string]
  openMenu: [event: MouseEvent, configId: string]
  closeAiConfig: []
  saveAiConfig: [config: AiProviderConfig, apiKey: string]
  updateSettings: [settings: AppUserSettings]
  deleteAgentPattern: [pattern: string]
  addAgentPattern: [pattern: string]
  clearAgentPatterns: []
}>()

const activeSection = ref<SettingsSection>('ai')
const aiConfigSearch = ref('')
const draft = reactive<AppUserSettings>({ ...props.settings })

const settingsGroups: Array<{
  key: SettingsSection
  icon: 'ai' | 'terminal' | 'shield'
  shortTitle: string
  title: string
  description: string
  status: string
  ready: boolean
}> = [
  { key: 'ai', icon: 'ai', shortTitle: 'AI', title: 'AI 配置', description: '模型、API 地址和密钥', status: '已接入', ready: true },
  { key: 'terminal', icon: 'terminal', shortTitle: '终端', title: '终端外观', description: '字体、字号、默认 Shell 偏好', status: '已接入', ready: true },
  { key: 'agent', icon: 'shield', shortTitle: 'Agent', title: 'Agent 模式', description: '自动执行策略与命令允许列表', status: '已接入', ready: true }
]

const sortedAiConfigs = computed(() => {
  return [...props.aiConfigs].sort((first, second) => {
    if (first.id === props.selectedAiConfigId) return -1
    if (second.id === props.selectedAiConfigId) return 1
    return first.id.localeCompare(second.id)
  })
})

const filteredAiConfigs = computed(() => {
  const query = aiConfigSearch.value.trim().toLowerCase()
  if (!query) return sortedAiConfigs.value

  return sortedAiConfigs.value.filter((config) =>
    [config.id, config.model, config.baseUrl].some((value) => value.toLowerCase().includes(query))
  )
})

const aiConfigMeta = computed(() => {
  const total = props.aiConfigs.length
  if (!aiConfigSearch.value.trim()) return `${total} 个配置`
  return `${filteredAiConfigs.value.length} / ${total} 个配置`
})

watch(
  () => props.settings,
  (settings) => {
    Object.assign(draft, settings)
  },
  { deep: true }
)

function requestCreateAiConfig() {
  emit('createAiConfig')
}

function selectConfig(configId: string) {
  emit('selectAiConfig', configId)
}

function editConfig(configId: string) {
  emit('editAiConfig', configId)
}

function deleteConfig(configId: string) {
  emit('deleteAiConfig', configId)
}

function openConfigMenu(event: MouseEvent, configId: string) {
  emit('openMenu', event, configId)
}

function closeAiConfig() {
  emit('closeAiConfig')
}

function saveSettings() {
  emit('updateSettings', normalizeUserSettings(draft, windowsPlatform))
}

function resetTerminalAppearance() {
  draft.terminalFontFamily = defaultUserSettings.terminalFontFamily
  draft.terminalFontSize = defaultUserSettings.terminalFontSize
  saveSettings()
}

// ---- Agent 模式设置 ----

const manualPattern = ref('')
const manualPatternError = ref('')

const builtinPatterns = computed(() => BUILTIN_READONLY_COMMANDS.map((entry) => entry.pattern))

function addManualPattern() {
  const value = manualPattern.value.trim()
  const checked = validateAllowlistPattern(value)
  if (!checked.ok) {
    manualPatternError.value = checked.reason ?? '无效的命令前缀'
    return
  }
  manualPatternError.value = ''
  manualPattern.value = ''
  emit('addAgentPattern', value)
}

function agentEntryMeta(entry: AgentAllowlistEntry) {
  const source = entry.sourceCommand?.trim() ? `来源 ${entry.sourceCommand.trim()}` : '手动添加'
  const usage = entry.useCount > 0 ? ` · 命中 ${entry.useCount} 次` : ''
  const created = entry.createdAt ? ` · ${entry.createdAt.slice(0, 10)}` : ''
  return `${source}${usage}${created}`
}
</script>

<template>
  <aside class="sidebar settings-sidebar">
    <div class="section-head">
      <span class="section-title">设置</span>
      <button class="primary settings-new-config" type="button" title="新建 AI 配置" aria-label="新建 AI 配置" @click="requestCreateAiConfig">
        <UiIcon name="plus" />
        <span>AI 配置</span>
      </button>
    </div>

    <div class="settings-list settings-center">
      <section class="settings-hub" role="tablist" aria-label="设置分类">
        <button
          v-for="group in settingsGroups"
          :key="group.key"
          class="settings-option settings-tab"
          :class="{ active: activeSection === group.key }"
          type="button"
          role="tab"
          :aria-selected="activeSection === group.key"
          :aria-label="group.title"
          :title="group.description"
          @click="activeSection = group.key"
        >
          <span class="settings-option-icon">
            <UiIcon :name="group.icon" />
          </span>
          <span class="settings-option-copy">
            <strong>{{ group.shortTitle }}</strong>
            <span>{{ group.description }}</span>
          </span>
          <span class="settings-option-status" :class="{ ready: group.ready }">{{ group.status }}</span>
        </button>
      </section>

      <section v-if="activeSection === 'terminal'" class="settings-section settings-controls terminal-settings-panel" aria-label="终端外观设置">
        <div class="settings-section-head">
          <strong>终端外观</strong>
          <span>即时应用到所有终端</span>
        </div>
        <div class="terminal-settings-form">
          <label class="settings-field">
            <span>字体</span>
            <select v-model="draft.terminalFontFamily" aria-label="选择终端字体">
              <option v-if="windowsPlatform" value="&quot;Cascadia Mono&quot;, &quot;Cascadia Code&quot;, &quot;JetBrains Mono&quot;, Consolas, monospace">Windows 优化 Cascadia Mono（推荐）</option>
              <option value="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace">系统等宽</option>
              <option value="Cascadia Mono, Cascadia Code, Consolas, monospace">Cascadia Mono</option>
              <option value="Consolas, Lucida Console, monospace">Consolas</option>
              <option value="JetBrains Mono, Consolas, monospace">JetBrains Mono</option>
              <option value="Fira Code, Consolas, monospace">Fira Code</option>
              <option value="Menlo, Monaco, Consolas, monospace">Menlo / Monaco</option>
            </select>
            <small>影响终端正文、命令补全和脚本输出。</small>
          </label>
          <label class="settings-field inline">
            <span>字号</span>
            <input v-model.number="draft.terminalFontSize" type="number" :min="MIN_TERMINAL_FONT_SIZE" :max="MAX_TERMINAL_FONT_SIZE" />
          </label>
          <label class="settings-field">
            <span>默认 Shell 偏好</span>
            <select v-model="draft.defaultShell">
              <option value="system">跟随系统</option>
              <option value="powershell">PowerShell</option>
              <option value="cmd">cmd.exe</option>
              <option value="bash">bash/zsh</option>
            </select>
            <small>当前仅保存偏好，后续接入本地终端启动命令。</small>
          </label>
        </div>
        <div class="settings-actions">
          <button class="text-button" type="button" @click="resetTerminalAppearance">恢复默认</button>
          <button class="text-button primary-action" type="button" @click="saveSettings">保存设置</button>
        </div>
      </section>
      <section v-else-if="activeSection === 'agent'" class="settings-section settings-controls agent-settings-panel" aria-label="Agent 模式设置">
        <div class="settings-section-head">
          <strong>Agent 自动执行</strong>
          <span>风险与敏感命令永远人工审批</span>
        </div>
        <label class="settings-field agent-toggle-field">
          <span class="agent-toggle-row">
            <input v-model="draft.agentAutoExecReadonly" type="checkbox" @change="saveSettings" />
            自动执行只读检查命令
          </span>
          <small>开启后,内置只读命令集中的命令无需确认直接执行;执行过程仍在终端可见并记入步骤卡片。</small>
        </label>
        <div class="agent-budget-block">
          <div class="settings-section-head">
            <strong>任务预算</strong>
            <span>防死循环与长时间挂起</span>
          </div>
          <label class="settings-field inline">
            <span>每任务步数上限</span>
            <input
              v-model.number="draft.agentStepLimit"
              type="number"
              :min="MIN_AGENT_STEP_LIMIT"
              :max="MAX_AGENT_STEP_LIMIT"
              aria-label="每个 Agent 任务的最大步数"
              @change="saveSettings"
            />
          </label>
          <small>到达上限任务收尾,可在下一条消息里让 Agent 接着排查。</small>
          <label class="settings-field inline">
            <span>命令超时(秒)</span>
            <input
              v-model.number="draft.agentCommandTimeoutSec"
              type="number"
              :min="MIN_AGENT_COMMAND_TIMEOUT_SEC"
              :max="MAX_AGENT_COMMAND_TIMEOUT_SEC"
              aria-label="单条命令等待多久后询问是否继续等待"
              @change="saveSettings"
            />
          </label>
          <small>只是"要不要继续等"的询问点:超时不会终止终端里的命令,可选择继续等待并重新计时。</small>
        </div>
        <div class="agent-builtin-block">
          <div class="settings-section-head">
            <strong>内置只读命令集</strong>
            <span>{{ builtinPatterns.length }} 条 · 随上方开关整体启停</span>
          </div>
          <div class="agent-pattern-chips">
            <span v-for="pattern in builtinPatterns" :key="pattern" class="chip">{{ pattern }}</span>
          </div>
          <small class="agent-builtin-note">带危险参数时不放行(如 tail -f、find -delete、git branch -D);sudo、重定向写文件、命令替换一律人工。</small>
        </div>
        <div class="agent-allowlist-block">
          <div class="settings-section-head">
            <strong>总是允许列表</strong>
            <button
              v-if="agentAllowlist.length"
              class="text-button"
              type="button"
              @click="emit('clearAgentPatterns')"
            >清空</button>
          </div>
          <p v-if="!agentAllowlist.length" class="settings-empty">暂无条目。在 Agent 审批卡片点击「总是允许」,或在下方手动添加命令前缀。</p>
          <ul v-else class="agent-allowlist-entries">
            <li v-for="entry in agentAllowlist" :key="entry.pattern">
              <code>{{ entry.pattern }}</code>
              <span class="agent-entry-meta">{{ agentEntryMeta(entry) }}</span>
              <button
                class="icon-button danger"
                type="button"
                :title="`删除 ${entry.pattern}`"
                :aria-label="`删除 ${entry.pattern}`"
                @click="emit('deleteAgentPattern', entry.pattern)"
              >
                <UiIcon name="trash" />
              </button>
            </li>
          </ul>
          <div class="agent-manual-add">
            <input
              v-model="manualPattern"
              type="text"
              placeholder="如 git status 或 docker logs"
              aria-label="手动添加允许的命令前缀"
              @keydown.enter.prevent="addManualPattern"
            />
            <button class="text-button primary-action" type="button" @click="addManualPattern">添加</button>
          </div>
          <p v-if="manualPatternError" class="agent-manual-error">{{ manualPatternError }}</p>
        </div>
      </section>
      <section v-else class="settings-section settings-ai-list" aria-label="AI 配置列表">
        <div class="settings-section-head">
          <strong>AI 配置</strong>
          <span>{{ aiConfigMeta }}</span>
        </div>

        <label class="settings-search">
          <UiIcon name="search" size="14" />
          <input v-model="aiConfigSearch" type="search" placeholder="搜索 AI 配置、模型或地址" aria-label="搜索 AI 配置" />
        </label>

        <div class="settings-config-list">
          <article
            v-for="config in filteredAiConfigs"
            :key="config.id"
            class="settings-card"
            :class="{ active: config.id === selectedAiConfigId }"
            role="button"
            tabindex="0"
            @click="selectConfig(config.id)"
            @contextmenu.prevent="openConfigMenu($event, config.id)"
            @keydown.enter="selectConfig(config.id)"
          >
            <div class="settings-card-head">
              <div class="settings-card-main">
                <span v-if="config.id === selectedAiConfigId" class="settings-card-dot" aria-hidden="true"></span>
                <strong>{{ config.id }}</strong>
                <span v-if="config.id === selectedAiConfigId" class="settings-card-current">当前使用</span>
              </div>
              <div class="card-actions">
                <button class="icon-button" type="button" title="编辑 AI 配置" aria-label="编辑 AI 配置" @click.stop="editConfig(config.id)">
                  <UiIcon name="edit" />
                </button>
                <button class="icon-button danger" type="button" title="删除 AI 配置" aria-label="删除 AI 配置" @click.stop="deleteConfig(config.id)">
                  <UiIcon name="trash" />
                </button>
              </div>
            </div>
            <span :class="{ warning: !config.model }">{{ config.model || '未配置模型' }}</span>
            <small v-if="config.baseUrl">{{ config.baseUrl }}</small>
          </article>

          <p v-if="filteredAiConfigs.length === 0" class="settings-empty">没有匹配的 AI 配置</p>
        </div>
      </section>
    </div>

    <teleport to="body">
      <div v-if="editorOpen" class="modal-backdrop" role="presentation">
        <section class="modal ai-config-modal" role="dialog" aria-modal="true" aria-label="AI 配置">
          <div class="modal-head">
            <div>
              <strong>{{ editorMode === 'create' ? '新建 AI 配置' : '编辑 AI 配置' }}</strong>
              <span>配置写入 SQLite，API Key 保存到系统凭据管理器。</span>
            </div>
            <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="closeAiConfig">
              <UiIcon name="close" />
            </button>
          </div>
          <p v-if="saveState === 'saving'" class="save-feedback">保存中...</p>
          <p v-else-if="saveState === 'saved'" class="save-feedback ok">已保存，密钥已写入系统凭据管理器</p>
          <p v-else-if="saveState === 'error'" class="save-feedback error">{{ saveError }}</p>
          <AiConfigPanel
            :config="aiConfig"
            :editor-mode="editorMode"
            @save="(config, apiKey) => emit('saveAiConfig', config, apiKey)"
          />
        </section>
      </div>
    </teleport>
  </aside>
</template>
