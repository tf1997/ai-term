<script setup lang="ts">
import { ref } from 'vue'
import type { AiProviderConfig } from '../types/profile'
import type {
  AiContextStatus,
  AiMessage,
  CommandHistoryEntry,
  ScriptRecording,
  TerminalSelectionEvent,
  WorkspaceSession
} from '../types/workspace'
import AiPanel from './AiPanel.vue'
import CommandHistoryPanel from './CommandHistoryPanel.vue'
import FileTransferPanel from './FileTransferPanel.vue'
import ScriptPanel from './ScriptPanel.vue'

defineProps<{
  collapsed: boolean
  terminalId: string
  connectionId: string
  workspaceSessionId: string
  workspaceSessions: WorkspaceSession[]
  selectedAiConfigId: string
  aiConfig: AiProviderConfig
  apiKey: string
  terminalSnapshot: string
  terminalSelection?: TerminalSelectionEvent
  commandHistory: CommandHistoryEntry[]
  aiMessages: AiMessage[]
  aiContextStatus?: AiContextStatus
  scriptRecording: ScriptRecording
}>()

const emit = defineEmits<{
  close: []
  workspaceTabChanged: [tab: 'history' | 'ai' | 'scripts' | 'sftp']
  selectWorkspaceSession: [sessionId: string]
  createWorkspaceSession: []
  renameWorkspaceSession: [sessionId: string, name: string]
  deleteWorkspaceSession: [sessionId: string]
  updateWorkspaceSessionTitle: [connectionId: string, sessionId: string, title: string]
  appendAiMessage: [message: AiMessage]
  updateAiMessage: [message: AiMessage]
  setAiContextStatus: [connectionId: string, workspaceSessionId: string, status: AiContextStatus]
  executeCommand: [command: string]
  writeTerminalInput: [data: string]
  startScriptRecording: []
  stopScriptRecording: []
  clearScriptRecording: []
}>()

const activeWorkspaceTab = ref<'history' | 'ai' | 'scripts' | 'sftp'>('ai')
const scriptPanelVisited = ref(false)

function selectWorkspaceTab(tab: 'history' | 'ai' | 'scripts' | 'sftp') {
  activeWorkspaceTab.value = tab
  if (tab === 'scripts') scriptPanelVisited.value = true
  emit('workspaceTabChanged', tab)
}
</script>

<template>
  <aside v-show="!collapsed" class="right-panel workspace-panel">
    <div class="workspace-bar">
      <nav class="workspace-tabs" aria-label="Workspace">
        <button :class="{ active: activeWorkspaceTab === 'history' }" @click="selectWorkspaceTab('history')">
          命令历史
        </button>
        <button :class="{ active: activeWorkspaceTab === 'ai' }" @click="selectWorkspaceTab('ai')">
          AI 助手
        </button>
        <button :class="{ active: activeWorkspaceTab === 'scripts' }" @click="selectWorkspaceTab('scripts')">
          脚本
        </button>
        <button :class="{ active: activeWorkspaceTab === 'sftp' }" @click="selectWorkspaceTab('sftp')">
          SFTP
        </button>
      </nav>
      <button class="icon-button workspace-close" type="button" title="关闭工作区" aria-label="关闭工作区" @click="emit('close')">
        ×
      </button>
    </div>

    <CommandHistoryPanel
      v-if="activeWorkspaceTab === 'history'"
      :commands="commandHistory"
      @rerun="emit('executeCommand', $event)"
    />
    <AiPanel
      v-if="activeWorkspaceTab === 'ai'"
      :terminal-id="terminalId"
      :connection-id="connectionId"
      :workspace-session-id="workspaceSessionId"
      :workspace-sessions="workspaceSessions"
      :selected-config-id="selectedAiConfigId"
      :config="aiConfig"
      :api-key="apiKey"
      :terminal-snapshot="terminalSnapshot"
      :terminal-selection="terminalSelection"
      :command-history="commandHistory"
      :messages="aiMessages"
      :context-status="aiContextStatus"
      @select-session="emit('selectWorkspaceSession', $event)"
      @create-session="emit('createWorkspaceSession')"
      @rename-session="(sessionId, name) => emit('renameWorkspaceSession', sessionId, name)"
      @delete-session="emit('deleteWorkspaceSession', $event)"
      @update-session-title="(connectionId, sessionId, title) => emit('updateWorkspaceSessionTitle', connectionId, sessionId, title)"
      @append-message="emit('appendAiMessage', $event)"
      @update-message="emit('updateAiMessage', $event)"
      @set-context-status="(connectionId, workspaceSessionId, status) => emit('setAiContextStatus', connectionId, workspaceSessionId, status)"
      @execute-command="emit('executeCommand', $event)"
    />
    <ScriptPanel
      v-if="scriptPanelVisited"
      v-show="activeWorkspaceTab === 'scripts'"
      :terminal-id="terminalId"
      :connection-id="connectionId"
      :workspace-session-id="workspaceSessionId"
      :selected-config-id="selectedAiConfigId"
      :config="aiConfig"
      :api-key="apiKey"
      :terminal-snapshot="terminalSnapshot"
      :command-history="commandHistory"
      :recording="scriptRecording"
      @start-recording="emit('startScriptRecording')"
      @stop-recording="emit('stopScriptRecording')"
      @clear-recording="emit('clearScriptRecording')"
      @write-terminal-input="emit('writeTerminalInput', $event)"
    />
    <FileTransferPanel
      v-if="activeWorkspaceTab === 'sftp'"
      :connection-id="connectionId"
      :terminal-snapshot="terminalSnapshot"
      @write-terminal-input="emit('writeTerminalInput', $event)"
    />
  </aside>
</template>
