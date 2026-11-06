use super::state::{AppState, FileCapturePlan, FileDispatchOutcome, FileEditDispatchOutcome};
use crate::domain::command_policy::ExecutionTarget;
use crate::domain::filesystem::agent_files::{
    FileChangeRecord, FileEditProposal, FileEditRequest, FileError, FileOperation,
    FileOperationReference, FileToolRequest, FileToolResponse,
};
use tauri::State;

#[tauri::command]
pub async fn prepare_agent_file_inspection(
    expected: ExecutionTarget,
    request: FileToolRequest,
    state: State<'_, AppState>,
) -> Result<FileCapturePlan, FileError> {
    state.prepare_agent_file_inspection(expected, request).await
}
#[tauri::command]
pub async fn finish_agent_file_inspection(
    reference: FileOperationReference,
    output: String,
    state: State<'_, AppState>,
) -> Result<FileOperation, FileError> {
    state.finish_agent_file_inspection(reference, output).await
}
#[tauri::command]
pub async fn approve_agent_file_operation(
    reference: FileOperationReference,
    reviewed_path: String,
    reviewed_revision: String,
    state: State<'_, AppState>,
) -> Result<(), FileError> {
    state
        .approve_agent_file_operation(&reference, &reviewed_path, &reviewed_revision)
        .await
}
#[tauri::command]
pub async fn dispatch_agent_file_operation(
    reference: FileOperationReference,
    state: State<'_, AppState>,
) -> Result<FileDispatchOutcome, FileError> {
    state.dispatch_agent_file_operation(reference).await
}
#[tauri::command]
pub async fn finish_agent_terminal_file(
    reference: FileOperationReference,
    output: String,
    state: State<'_, AppState>,
) -> Result<FileToolResponse, FileError> {
    state.finish_agent_terminal_file(reference, output).await
}
#[tauri::command]
pub async fn cancel_agent_file_operation(
    reference: FileOperationReference,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    Ok(state.cancel_agent_file_operation(&reference).await)
}

#[tauri::command]
pub async fn prepare_agent_file_edit(
    expected: ExecutionTarget,
    request: FileEditRequest,
    state: State<'_, AppState>,
) -> Result<FileEditProposal, FileError> {
    state.prepare_agent_file_edit(expected, request).await
}
#[tauri::command]
pub async fn prepare_agent_file_restore(
    expected: ExecutionTarget,
    baseline_id: String,
    change_id: String,
    state: State<'_, AppState>,
) -> Result<FileEditProposal, FileError> {
    state
        .prepare_agent_file_restore(expected, baseline_id, change_id)
        .await
}
#[tauri::command]
pub async fn approve_agent_file_edit(
    reference: FileOperationReference,
    review_hash: String,
    state: State<'_, AppState>,
) -> Result<(), FileError> {
    state.approve_agent_file_edit(reference, review_hash).await
}
#[tauri::command]
pub async fn dispatch_agent_file_edit(
    reference: FileOperationReference,
    state: State<'_, AppState>,
) -> Result<FileEditDispatchOutcome, FileError> {
    state.dispatch_agent_file_edit(reference).await
}
#[tauri::command]
pub async fn finish_agent_terminal_file_edit(
    reference: FileOperationReference,
    output: String,
    state: State<'_, AppState>,
) -> Result<FileChangeRecord, FileError> {
    state
        .finish_agent_terminal_file_edit(reference, output)
        .await
}
#[tauri::command]
pub async fn get_agent_file_change(
    id: String,
    state: State<'_, AppState>,
) -> Result<Option<FileChangeRecord>, FileError> {
    state.get_agent_file_change(id).await
}
#[tauri::command]
pub async fn list_agent_file_changes(
    profile_id: String,
    limit: u32,
    state: State<'_, AppState>,
) -> Result<Vec<FileChangeRecord>, FileError> {
    state.list_agent_file_changes(profile_id, limit).await
}
