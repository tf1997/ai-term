<script setup lang="ts">
import { ref } from 'vue'
import type { AiProviderConfig } from '../types/profile'
import type { AiContextStatus, AiMessage, CommandHistoryEntry, WorkspaceSession } from '../types/workspace'
import AiPanel from './AiPanel.vue'
import CommandHistoryPanel from './CommandHistoryPanel.vue'
import FileTransferPanel from './FileTransferPanel.vue'

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
  commandHistory: CommandHistoryEntry[]
  aiMessages: AiMessage[]
  aiContextStatus?: AiContextStatus
}>()

const emit = defineEmits<{
  close: []
  selectWorkspaceSession: [sessionId: string]
  createWorkspaceSession: []
  renameWorkspaceSession: [sessionId: string]
  deleteWorkspaceSession: [sessionId: string]
  updateWorkspaceSessionTitle: [connectionId: string, sessionId: string, title: string]
  appendAiMessage: [message: AiMessage]
  updateAiMessage: [message: AiMessage]
  setAiContextStatus: [connectionId: string, workspaceSessionId: string, status: AiContextStatus]
  executeCommand: [command: string]
}>()

const activeWorkspaceTab = ref<'history' | 'ai' | 'sftp'>('ai')
</script>

<template>
  <aside v-show="!collapsed" class="right-panel workspace-panel">
    <div class="workspace-bar">
      <nav class="workspace-tabs" aria-label="Workspace">
        <button :class="{ active: activeWorkspaceTab === 'history' }" @click="activeWorkspaceTab = 'history'">
          命令历史
        </button>
        <button :class="{ active: activeWorkspaceTab === 'ai' }" @click="activeWorkspaceTab = 'ai'">
          AI 助手
        </button>
        <button :class="{ active: activeWorkspaceTab === 'sftp' }" @click="activeWorkspaceTab = 'sftp'">
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
      v-else-if="activeWorkspaceTab === 'ai'"
      :terminal-id="terminalId"
      :connection-id="connectionId"
      :workspace-session-id="workspaceSessionId"
      :workspace-sessions="workspaceSessions"
      :selected-config-id="selectedAiConfigId"
      :config="aiConfig"
      :api-key="apiKey"
      :terminal-snapshot="terminalSnapshot"
      :command-history="commandHistory"
      :messages="aiMessages"
      :context-status="aiContextStatus"
      @select-session="emit('selectWorkspaceSession', $event)"
      @create-session="emit('createWorkspaceSession')"
      @rename-session="emit('renameWorkspaceSession', $event)"
      @delete-session="emit('deleteWorkspaceSession', $event)"
      @update-session-title="(connectionId, sessionId, title) => emit('updateWorkspaceSessionTitle', connectionId, sessionId, title)"
      @append-message="emit('appendAiMessage', $event)"
      @update-message="emit('updateAiMessage', $event)"
      @set-context-status="(connectionId, workspaceSessionId, status) => emit('setAiContextStatus', connectionId, workspaceSessionId, status)"
      @execute-command="emit('executeCommand', $event)"
    />
    <FileTransferPanel v-else />
  </aside>
</template>
