export type { ScriptRecording } from './domain/recording'
export type { TaskScriptSource, TaskScriptDraft, TaskScriptMetadata, ScriptParameter, TaskScriptFileChange } from './domain/taskScript'
export interface TaskScriptImport { requestId: string; draft: import('./domain/taskScript').TaskScriptDraft }
