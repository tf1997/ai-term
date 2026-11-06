import { invoke } from '@tauri-apps/api/tauri'
import type { ExecutionTarget } from '../../../shared/security/commandPolicy'
import type { HostKnowledge, HostKnowledgeDraft, HostKnowledgeScope } from '../domain/hostKnowledge'
export const hostKnowledgeScope = (expected: ExecutionTarget) => invoke<HostKnowledgeScope>('host_knowledge_scope', { expected })
export const listHostKnowledge = (profileId: string) => invoke<HostKnowledge[]>('list_host_knowledge', { profileId })
export const saveHostKnowledge = (expected: ExecutionTarget, draft: HostKnowledgeDraft) => invoke<HostKnowledge>('save_host_knowledge', { expected, draft })
export const deleteHostKnowledge = (profileId: string, id: string, revision: number) => invoke<boolean>('delete_host_knowledge', { profileId, id, revision })
export const hostKnowledgeContext = (expected: ExecutionTarget, query: string, runId?: string) => invoke<string>('host_knowledge_context', { expected, query, runId: runId ?? null })
