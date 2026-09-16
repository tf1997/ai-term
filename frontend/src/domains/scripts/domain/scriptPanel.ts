import type { AiProviderConfig } from '../../ai/types'
import type { ScriptRecording } from './recording'

export interface ScriptPanelProps {
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
  recording: ScriptRecording
}
export interface ScriptPanelEvents {
  startRecording: []
  stopRecording: []
  clearRecording: []
  writeTerminalInput: [data: string]
}
export type ScriptPanelEmit = <Event extends keyof ScriptPanelEvents>(event: Event, ...args: ScriptPanelEvents[Event]) => void

export interface ScriptChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  scriptContent?: string
  savedScriptId?: string
  targetDocumentId?: string
  targetTitle?: string
  applicationState?: 'applied' | 'pending' | 'unavailable' | 'dismissed'
  streaming?: boolean
  error?: boolean
  createdAt: string
  durationSeconds?: number
  sourceConnectionId?: string
  sourceWorkspaceSessionId?: string
  sourceCommands?: string[]
}

export interface ScriptExecutionSource {
  connectionId: string
  name?: string
}

export type ScriptPanelMode = 'library' | 'generate'

export type ScriptLibraryView = 'list' | 'detail'

export type ScriptPreviewSource = 'draft' | 'selected' | ''

export type ScriptEditorSource = 'draft' | 'selected'

export interface EditorCursor {
  line: number
  column: number
}
