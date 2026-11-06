<script setup lang="ts">
import type { AiPanelEvents, AiSessionPanelsProps } from '../../domain/aiPanel'
import { useAiSessionPanels } from '../../application/useAiSessionPanels'
import AiPanel from './AiPanel.vue'

const props = withDefaults(defineProps<AiSessionPanelsProps>(), { active: true })
const emit = defineEmits<AiPanelEvents>()
const { panels, activityChanged } = useAiSessionPanels(props, activity => emit('activityChange', activity))
</script>

<template>
  <AiPanel v-for="panel in panels" :key="panel.id" v-show="panel.props.active" v-bind="panel.props"
    @activity-change="activityChanged"
    @create-script-draft="emit('createScriptDraft', $event)"
    @select-config="emit('selectConfig', $event)"
    @configure-ai="emit('configureAi')"
    @clear-selection="emit('clearSelection')"
    @focus-terminal="emit('focusTerminal')"
    @append-message="emit('appendMessage', $event)"
    @update-message="emit('updateMessage', $event)"
    @set-context-status="(connectionId, sessionId, status) => emit('setContextStatus', connectionId, sessionId, status)"
    @execute-command="emit('executeCommand', $event)"
    @select-session="emit('selectSession', $event)"
    @create-session="emit('createSession')"
    @rename-session="(sessionId, name) => emit('renameSession', sessionId, name)"
    @delete-session="emit('deleteSession', $event)"
    @update-session-title="(connectionId, sessionId, title) => emit('updateSessionTitle', connectionId, sessionId, title)"
    @update-session-context-summary="(sessionId, summary, lastMessageId) => emit('updateSessionContextSummary', sessionId, summary, lastMessageId)"
    @set-session-mode="(sessionId, mode) => emit('setSessionMode', sessionId, mode)"
    @ai-error="emit('aiError', $event)"
  />
</template>
