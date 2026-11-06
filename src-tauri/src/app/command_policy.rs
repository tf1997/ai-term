//! IPC contract for the guarded execution path. Frontend callers must keep the
//! returned reference alongside the exact source displayed for approval.
use tauri::State;

use super::state::AppState;
use crate::domain::command_policy::{
    CaptureKind, CommandIntent, ExecutionContext, ExecutionTarget, IntentReference, InternalProbe,
    OperationKind,
};

#[tauri::command]
pub async fn command_execution_target(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<ExecutionTarget, String> {
    state
        .command_execution_target(&session_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_command_context(
    expected: ExecutionTarget,
    context: ExecutionContext,
    state: State<'_, AppState>,
) -> Result<ExecutionTarget, String> {
    state
        .update_command_context(&expected, context)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn analyze_command_intent(
    expected: ExecutionTarget,
    source: String,
    operation: OperationKind,
    capture: Option<CaptureKind>,
    state: State<'_, AppState>,
) -> Result<CommandIntent, String> {
    state
        .analyze_captured_command_intent(expected, source, operation, capture.unwrap_or_default())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn prepare_terminal_probe(
    expected: ExecutionTarget,
    probe: InternalProbe,
    state: State<'_, AppState>,
) -> Result<CommandIntent, String> {
    state
        .prepare_terminal_probe(expected, probe)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn approve_command_intent(
    reference: IntentReference,
    reviewed_source: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .approve_command_intent(&reference, &reviewed_source)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn dispatch_command_intent(
    reference: IntentReference,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .dispatch_command_intent(&reference)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn cancel_command_intent(
    reference: IntentReference,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    state
        .cancel_command_intent(&reference)
        .await
        .map_err(|e| e.to_string())
}
