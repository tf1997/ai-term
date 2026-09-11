import { computed, ref } from 'vue'
import type { Ref } from 'vue'
import type { ScriptRecording } from '../domain/recording'
import { DEFAULT_AI_SESSION_ID, nowText } from '../../ai/index'

interface ScriptRecordingOptions {
  activeTerminalId: Readonly<Ref<string>>
  activeConnectionId: Readonly<Ref<string>>
  activeAiSessionId: Readonly<Ref<string>>
}

export function useScriptRecording({ activeTerminalId, activeConnectionId, activeAiSessionId }: ScriptRecordingOptions) {
  const scriptRecordingsByTerminal = ref<Record<string, ScriptRecording>>({})

  const activeScriptRecording = computed(() => {
    return scriptRecordingsByTerminal.value[activeTerminalId.value] ?? createIdleScriptRecording(activeTerminalId.value)
  })

  function createIdleScriptRecording(terminalId: string): ScriptRecording {
    return {
      terminalId,
      connectionId: activeConnectionId.value,
      workspaceSessionId: activeAiSessionId.value || DEFAULT_AI_SESSION_ID,
      isRecording: false,
      startedAt: '',
      commands: [],
      terminalOutput: ''
    }
  }

  function startScriptRecording() {
    const terminalId = activeTerminalId.value
    scriptRecordingsByTerminal.value = {
      ...scriptRecordingsByTerminal.value,
      [terminalId]: {
        terminalId,
        connectionId: activeConnectionId.value,
        workspaceSessionId: activeAiSessionId.value || DEFAULT_AI_SESSION_ID,
        isRecording: true,
        startedAt: nowText(),
        commands: [],
        terminalOutput: ''
      }
    }
  }

  function stopScriptRecording() {
    const recording = scriptRecordingsByTerminal.value[activeTerminalId.value]
    if (!recording) return
    scriptRecordingsByTerminal.value = {
      ...scriptRecordingsByTerminal.value,
      [activeTerminalId.value]: {
        ...recording,
        isRecording: false,
        stoppedAt: nowText()
      }
    }
  }

  function clearScriptRecording() {
    const nextRecordings = { ...scriptRecordingsByTerminal.value }
    delete nextRecordings[activeTerminalId.value]
    scriptRecordingsByTerminal.value = nextRecordings
  }

  function appendRecordingOutput(terminalId: string, delta: string) {
    if (!delta) return
    const recording = scriptRecordingsByTerminal.value[terminalId]
    if (!recording?.isRecording) return
    scriptRecordingsByTerminal.value = {
      ...scriptRecordingsByTerminal.value,
      [terminalId]: {
        ...recording,
        terminalOutput: `${recording.terminalOutput}${delta}`.slice(-120_000)
      }
    }
  }

  function appendRecordingCommand(terminalId: string, command: string) {
    const recording = scriptRecordingsByTerminal.value[terminalId]
    if (!recording?.isRecording) return
    scriptRecordingsByTerminal.value = {
      ...scriptRecordingsByTerminal.value,
      [terminalId]: {
        ...recording,
        commands: [...recording.commands, command].slice(-200)
      }
    }
  }

  function removeScriptRecording(terminalId: string) {
    delete scriptRecordingsByTerminal.value[terminalId]
  }

  return { activeScriptRecording, startScriptRecording, stopScriptRecording, clearScriptRecording, appendRecordingOutput, appendRecordingCommand, removeScriptRecording }
}
