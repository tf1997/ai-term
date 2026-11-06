use super::state::AppState;
use crate::domain::{ai::host_knowledge::*, command_policy::ExecutionTarget};
use tauri::State;
#[tauri::command]
pub async fn host_knowledge_scope(
    expected: ExecutionTarget,
    state: State<'_, AppState>,
) -> Result<HostKnowledgeScope, String> {
    state
        .host_knowledge_scope(expected)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn list_host_knowledge(
    profile_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<HostKnowledge>, String> {
    state
        .list_host_knowledge(profile_id)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn save_host_knowledge(
    expected: ExecutionTarget,
    draft: HostKnowledgeDraft,
    state: State<'_, AppState>,
) -> Result<HostKnowledge, String> {
    state
        .save_host_knowledge(expected, draft)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn delete_host_knowledge(
    profile_id: String,
    id: String,
    revision: u64,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    state
        .delete_host_knowledge(profile_id, id, revision)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn host_knowledge_context(
    expected: ExecutionTarget,
    query: String,
    run_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state
        .host_knowledge_context(expected, query, run_id)
        .await
        .map_err(|e| e.to_string())
}
