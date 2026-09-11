


export interface UpdateScript {
  id: string
  /** Source connection only; saved scripts are globally visible. */
  connectionId: string
  workspaceSessionId: string
  name: string
  description: string
  content: string
  sourceCommands: string[]
  createdAt: string
  updatedAt: string
}

export interface ScriptRecording {
  terminalId: string
  connectionId: string
  workspaceSessionId: string
  isRecording: boolean
  startedAt: string
  stoppedAt?: string
  commands: string[]
  terminalOutput: string
}
