use tauri::{Manager, State};

use super::state::AppState;
use crate::domain::command_policy::ExecutionTarget;
use crate::domain::terminal::ssh_tasks::{
    SshTaskIntent, SshTaskReference, SshTaskRequest, SshTaskSnapshot, SshTaskTarget,
};

#[tauri::command]
pub async fn prepare_ssh_task(
    expected: ExecutionTarget,
    request: SshTaskRequest,
    state: State<'_, AppState>,
) -> Result<SshTaskIntent, String> {
    state
        .prepare_ssh_task(expected, request)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn approve_ssh_task(
    reference: SshTaskReference,
    reviewed: SshTaskRequest,
    target: SshTaskTarget,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .approve_ssh_task(&reference, &reviewed, &target)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_ssh_task(
    reference: SshTaskReference,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<SshTaskSnapshot, String> {
    state
        .start_ssh_task(&reference, move |event| {
            let _ = app.emit_all(&format!("ssh-task:{}", event.reference.id), event);
        })
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn read_ssh_task(
    reference: SshTaskReference,
    state: State<'_, AppState>,
) -> Result<SshTaskSnapshot, String> {
    state
        .read_ssh_task(&reference)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn stop_observing_ssh_task(
    reference: SshTaskReference,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    state
        .stop_observing_ssh_task(&reference)
        .await
        .map_err(|e| e.to_string())
}
