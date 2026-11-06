use super::state::{AgentRecoverySession, AgentRunLease, AppState};
use crate::domain::ai::recovery::RecoveryResolution;
use crate::domain::{ai::checkpoints::*, command_policy::ExecutionTarget};
use tauri::State;

#[tauri::command]
pub async fn completed_agent_checkpoint_for_message(
    profile_id: String,
    workspace_session_id: String,
    message_id: String,
    state: State<'_, AppState>,
) -> Result<Option<AgentCheckpoint>, String> {
    state
        .completed_agent_checkpoint_for_message(profile_id, workspace_session_id, message_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn reply_agent_run(
    expected: ExecutionTarget,
    run_id: String,
    expected_sequence: u64,
    reply: AgentRunReply,
    state: State<'_, AppState>,
) -> Result<AgentRecoverySession, String> {
    state
        .reply_agent_run(expected, run_id, expected_sequence, reply)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn recover_agent_run(
    expected: ExecutionTarget,
    run_id: String,
    expected_sequence: u64,
    state: State<'_, AppState>,
) -> Result<AgentRecoverySession, String> {
    state
        .recover_agent_run(expected, run_id, expected_sequence)
        .await
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn confirm_agent_recovery(
    lease: AgentRunLease,
    expected: ExecutionTarget,
    expected_sequence: u64,
    resolutions: Vec<RecoveryResolution>,
    state: State<'_, AppState>,
) -> Result<AgentCheckpoint, String> {
    state
        .confirm_agent_recovery(lease, expected, expected_sequence, resolutions)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn begin_agent_run(
    expected: ExecutionTarget,
    start: AgentRunStart,
    state: State<'_, AppState>,
) -> Result<AgentRunLease, String> {
    state
        .begin_agent_run(expected, start)
        .await
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn save_agent_checkpoint(
    lease: AgentRunLease,
    update: AgentCheckpointUpdate,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    state
        .save_agent_checkpoint(lease, update)
        .await
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn release_agent_run(
    lease: AgentRunLease,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .release_agent_run(lease)
        .await
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn list_agent_checkpoints(
    profile_id: String,
    workspace_session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<AgentCheckpoint>, String> {
    state
        .list_agent_checkpoints(profile_id, workspace_session_id)
        .await
        .map_err(|error| error.to_string())
}
