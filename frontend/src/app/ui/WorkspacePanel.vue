<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AiProviderConfig } from '../../domains/ai/types'
import type { ConnectionProfile } from '../../domains/connections/types'
import type { AiContextStatus, AiMessage, WorkspaceSession } from '../../domains/ai/types'
import type { CommandHistoryEntry, TerminalOutputDeltaEvent, TerminalSelectionEvent } from '../../domains/terminal/types'
import type { ScriptRecording } from '../../domains/scripts/types'
import type { AgentCommandHandle, AgentCommandRunOptions, AiPanelMode } from '../../domains/ai/types'
import { AiPanel } from '../../domains/ai/views'
import { CommandHistoryPanel } from '../../domains/terminal/views'
import { ScriptPanel } from '../../domains/scripts/views'
import UiIcon from '../../shared/ui/UiIcon.vue'

const props = defineProps<{
  collapsed: boolean
  activeTab: 'history' | 'ai' | 'scripts'
  terminalId: string
  connectionId: string
  connectionProfile?: ConnectionProfile
  terminalStatus: 'idle' | 'connecting' | 'local' | 'remote' | 'sftp' | 'preview' | 'error'
  terminalConnectionGeneration: number
  workspaceSessionId: string
  workspaceSessions: WorkspaceSession[]
  connectionLabels: Record<string, string>
  executionTargetLabel: string
  executionTargetTitle: string
  executionTargetConnectionIds: string[]
  selectedAiConfigId: string
  aiConfigs?: AiProviderConfig[]
  aiConfig: AiProviderConfig
  apiKey: string
  terminalSnapshot: string
  terminalOutputEvent?: TerminalOutputDeltaEvent
  terminalSelection?: TerminalSelectionEvent
  commandHistory: CommandHistoryEntry[]
  aiMessages: AiMessage[]
  aiContextStatus?: AiContextStatus
  scriptRecording: ScriptRecording
  agentAvailabilityCheck?: () => string
  agentAvailabilityConfirm?: () => Promise<string>
  agentCommandRunner?: (terminalId: string, command: string, options?: AgentCommandRunOptions) => AgentCommandHandle
  agentAllowlistPatterns?: string[]
  agentBuiltinReadonlyEnabled?: boolean
  agentStepLimit?: number
  agentCommandTimeoutMs?: number
}>()

const emit = defineEmits<{
  selectAiConfig: [configId: string]
  configureAi: []
  clearTerminalSelection: []
  workspaceTabChanged: [tab: 'history' | 'ai' | 'scripts']
  selectWorkspaceSession: [sessionId: string]
  createWorkspaceSession: []
  renameWorkspaceSession: [sessionId: string, name: string]
  deleteWorkspaceSession: [sessionId: string]
  updateWorkspaceSessionTitle: [connectionId: string, sessionId: string, title: string]
  updateWorkspaceSessionContextSummary: [sessionId: string, summary: string, lastMessageId: string]
  setWorkspaceSessionMode: [sessionId: string, mode: AiPanelMode]
  allowAgentPattern: [pattern: string, sourceCommand: string]
  appendAiMessage: [message: AiMessage]
  updateAiMessage: [message: AiMessage]
  setAiContextStatus: [connectionId: string, workspaceSessionId: string, status: AiContextStatus]
  fillCommand: [command: string]
  pinQuickCommand: [command: string]
  executeCommand: [command: string]
  writeTerminalInput: [data: string]
  focusTerminal: []
  startScriptRecording: []
  stopScriptRecording: []
  clearScriptRecording: []
  aiError: [detail: string]
}>()

const activeWorkspaceTab = computed(() => props.activeTab)
const visitedTabs = ref(new Set([props.activeTab]))

function selectWorkspaceTab(tab: 'history' | 'ai' | 'scripts') {
  visitedTabs.value.add(tab)
  emit('workspaceTabChanged', tab)
}
</script>

<template>
  <aside v-show="!collapsed" class="right-panel workspace-panel">
    <div class="workspace-bar">
      <nav class="workspace-tabs" aria-label="右侧工作区">
        <button
          type="button"
          title="命令历史"
          aria-label="命令历史"
          :class="{ active: activeWorkspaceTab === 'history' }"
          @click="selectWorkspaceTab('history')"
        >
          <UiIcon name="history" />
          <span>历史</span>
        </button>
        <button
          type="button"
          title="AI 助手"
          aria-label="AI 助手"
          :class="{ active: activeWorkspaceTab === 'ai' }"
          @click="selectWorkspaceTab('ai')"
        >
          <UiIcon name="ai" />
          <span>AI</span>
        </button>
        <button
          type="button"
          title="脚本"
          aria-label="脚本"
          :class="{ active: activeWorkspaceTab === 'scripts' }"
          @click="selectWorkspaceTab('scripts')"
        >
          <UiIcon name="script" />
          <span>脚本</span>
        </button>
      </nav>
    </div>

    <CommandHistoryPanel
      v-if="visitedTabs.has('history')"
      v-show="activeWorkspaceTab === 'history'"
      :connection-id="connectionId"
      :commands="commandHistory"
      :connection-label="connectionLabels[connectionId] ?? connectionProfile?.name ?? '当前连接'"
      @fill="emit('fillCommand', $event)"
      @pin="emit('pinQuickCommand', $event)"
    />
    <AiPanel
      v-if="visitedTabs.has('ai')"
      v-show="activeWorkspaceTab === 'ai'"
      :terminal-id="terminalId"
      :terminal-connection-generation="terminalConnectionGeneration"
      :connection-id="connectionId"
      :workspace-session-id="workspaceSessionId"
      :workspace-sessions="workspaceSessions"
      :connection-labels="connectionLabels"
      :execution-target-label="executionTargetLabel"
      :execution-target-title="executionTargetTitle"
      :execution-target-connection-ids="executionTargetConnectionIds"
      :selected-config-id="selectedAiConfigId"
      :configs="aiConfigs"
      :config="aiConfig"
      :api-key="apiKey"
      :terminal-snapshot="terminalSnapshot"
      :terminal-selection="terminalSelection"
      :command-history="commandHistory"
      :messages="aiMessages"
      :context-status="aiContextStatus"
      :agent-availability-check="agentAvailabilityCheck"
      :agent-availability-confirm="agentAvailabilityConfirm"
      :agent-command-runner="agentCommandRunner"
      :agent-allowlist-patterns="agentAllowlistPatterns"
      :agent-builtin-readonly-enabled="agentBuiltinReadonlyEnabled"
      :agent-step-limit="agentStepLimit"
      :agent-command-timeout-ms="agentCommandTimeoutMs"
      @select-session="emit('selectWorkspaceSession', $event)"
      @select-config="emit('selectAiConfig', $event)"
      @configure-ai="emit('configureAi')"
      @clear-selection="emit('clearTerminalSelection')"
      @focus-terminal="emit('focusTerminal')"
      @create-session="emit('createWorkspaceSession')"
      @rename-session="(sessionId, name) => emit('renameWorkspaceSession', sessionId, name)"
      @delete-session="emit('deleteWorkspaceSession', $event)"
      @update-session-title="(connectionId, sessionId, title) => emit('updateWorkspaceSessionTitle', connectionId, sessionId, title)"
      @update-session-context-summary="(sessionId, summary, lastMessageId) => emit('updateWorkspaceSessionContextSummary', sessionId, summary, lastMessageId)"
      @set-session-mode="(sessionId: string, mode: AiPanelMode) => emit('setWorkspaceSessionMode', sessionId, mode)"
      @allow-agent-pattern="(pattern: string, sourceCommand: string) => emit('allowAgentPattern', pattern, sourceCommand)"
      @append-message="emit('appendAiMessage', $event)"
      @update-message="emit('updateAiMessage', $event)"
      @set-context-status="(connectionId, workspaceSessionId, status) => emit('setAiContextStatus', connectionId, workspaceSessionId, status)"
      @execute-command="emit('executeCommand', $event)"
      @ai-error="emit('aiError', $event)"
    />
    <ScriptPanel
      v-if="visitedTabs.has('scripts')"
      v-show="activeWorkspaceTab === 'scripts'"
      :terminal-id="terminalId"
      :connection-id="connectionId"
      :workspace-session-id="workspaceSessionId"
      :connection-labels="connectionLabels"
      :execution-target-label="executionTargetLabel"
      :execution-target-title="executionTargetTitle"
      :execution-target-connection-ids="executionTargetConnectionIds"
      :selected-config-id="selectedAiConfigId"
      :config="aiConfig"
      :api-key="apiKey"
      :recording="scriptRecording"
      @start-recording="emit('startScriptRecording')"
      @stop-recording="emit('stopScriptRecording')"
      @clear-recording="emit('clearScriptRecording')"
      @write-terminal-input="emit('writeTerminalInput', $event)"
    />
  </aside>
</template>
