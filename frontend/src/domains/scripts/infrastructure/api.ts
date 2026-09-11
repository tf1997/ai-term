
import { invoke } from '@tauri-apps/api/tauri'
import type { AiProviderConfig } from '../../ai/types'




import type { UpdateScript } from '../domain/recording'


export interface AiScriptTitleRequest {
  config: AiProviderConfig
  apiKey: string
  userRequest: string
  scriptContent: string
  sourceCommands: string[]
}

export interface AiScriptTitleResponse {
  title: string
}

export function generateAiScriptTitle(request: AiScriptTitleRequest) {
  return invoke<AiScriptTitleResponse>('generate_ai_script_title', { request })
}

export function listUpdateScripts() {
  return invoke<UpdateScript[]>('list_update_scripts')
}

export function getUpdateScript(id: string) {
  return invoke<UpdateScript | null>('get_update_script', { id })
}

export function saveUpdateScript(script: UpdateScript) {
  return invoke<void>('save_update_script', { script })
}

export function deleteUpdateScript(id: string) {
  return invoke<boolean>('delete_update_script', { id })
}
