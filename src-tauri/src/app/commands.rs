use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{Manager, State};
use uuid::Uuid;

use crate::app::events::{
    ai_chat_stream_event_name, sftp_transfer_event_name, terminal_closed_event_name,
    terminal_data_event_name, AiChatStreamEvent, AiChatStreamEventKind, SftpTransferEvent,
    TerminalClosedEvent, TerminalDataEvent,
};
use crate::app::state::AppState;
use crate::domain::ai::chat::{
    chat_with_provider, chat_with_provider_stream, generate_script_title, generate_session_title,
    AiChatRequest, AiChatResponse, AiScriptTitleRequest, AiScriptTitleResponse,
    AiSessionTitleRequest, AiSessionTitleResponse,
};
use crate::domain::ai::config::validate_ai_config;
use crate::domain::connection::bastion::{probe_servers, BastionServerCandidate};
use crate::domain::connection::models::AiProviderConfig;
use crate::domain::connection::models::ConnectionProfile;
use crate::domain::connection::profiles::validate_profile;
use crate::domain::connection::sftp::{
    create_directory_with_cancel, delete_path_with_cancel, download_file_with_progress,
    download_path_with_progress, list_directory_with_cancel, probe_sftp_with_cancel,
    upload_file_with_progress, upload_path_with_progress, SftpCancelToken, SftpListResponse,
    SftpProbeResponse, SftpProgressUpdate, SftpTargetOverride, SftpTransferResponse,
};
use crate::domain::filesystem::local::{
    home_directory, list_directory as list_local_directory_impl, LocalDirectoryResponse,
};
use crate::domain::terminal::local::spawn_local_terminal;
use crate::domain::terminal::ssh::spawn_ssh_terminal;
use crate::domain::workspace::{
    AiConversationMessage, CommandHistoryRecord, UpdateScript, WorkspaceSession,
};

const SFTP_COMMAND_TIMEOUT: Duration = Duration::from_secs(45);

#[tauri::command]
pub async fn connect_profile(
    profile_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let session_id = Uuid::new_v4().to_string();
    let profile = state
        .get_connection_profile(&profile_id)
        .await
        .map_err(|err| err.to_string())?
        .ok_or_else(|| format!("connection profile {profile_id} was not found"))?;
    validate_profile(&profile).map_err(|err| err.to_string())?;

    let output_session_id = session_id.clone();
    let closed_session_id = session_id.clone();
    let app_for_output = app.clone();
    let app_for_close = app.clone();
    let terminal = spawn_ssh_terminal(
        &profile,
        cols,
        rows,
        move |bytes| {
            let data = String::from_utf8_lossy(&bytes).into_owned();
            let _ = app_for_output.emit_all(
                &terminal_data_event_name(&output_session_id),
                TerminalDataEvent {
                    session_id: output_session_id.clone(),
                    data,
                },
            );
        },
        move || {
            let _ = app_for_close.emit_all(
                &terminal_closed_event_name(&closed_session_id),
                TerminalClosedEvent {
                    session_id: closed_session_id.clone(),
                    reason: "eof".into(),
                },
            );
            let close_app = app_for_close.clone();
            tauri::async_runtime::spawn(async move {
                remove_terminal_session_after_exit(close_app, closed_session_id).await;
            });
        },
    )
    .map_err(|err| err.to_string())?;

    state
        .register_terminal_session(session_id.clone(), profile_id, Box::new(terminal))
        .await;
    Ok(session_id)
}

#[tauri::command]
pub async fn connect_local_terminal(
    cols: u16,
    rows: u16,
    session_id: Option<String>,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let session_id = session_id
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let output_session_id = session_id.clone();
    let closed_session_id = session_id.clone();
    let app_for_output = app.clone();
    let app_for_close = app.clone();
    let terminal = spawn_local_terminal(
        cols,
        rows,
        move |bytes| {
            let data = String::from_utf8_lossy(&bytes).into_owned();
            let _ = app_for_output.emit_all(
                &terminal_data_event_name(&output_session_id),
                TerminalDataEvent {
                    session_id: output_session_id.clone(),
                    data,
                },
            );
        },
        move || {
            let _ = app_for_close.emit_all(
                &terminal_closed_event_name(&closed_session_id),
                TerminalClosedEvent {
                    session_id: closed_session_id.clone(),
                    reason: "eof".into(),
                },
            );
            let close_app = app_for_close.clone();
            tauri::async_runtime::spawn(async move {
                remove_terminal_session_after_exit(close_app, closed_session_id).await;
            });
        },
    )
    .map_err(|err| err.to_string())?;

    state
        .register_terminal_session(session_id.clone(), "local".into(), Box::new(terminal))
        .await;

    Ok(session_id)
}

#[tauri::command]
pub async fn terminal_write(
    session_id: String,
    data: String,
    state: State<'_, AppState>,
    _app: tauri::AppHandle,
) -> Result<(), String> {
    let handled_by_terminal = state
        .write_terminal(&session_id, data.clone().into_bytes())
        .await
        .map_err(|err| err.to_string())?;

    if handled_by_terminal {
        return Ok(());
    }

    Err(format!(
        "session {session_id} is not attached to a terminal"
    ))
}

#[tauri::command]
pub async fn terminal_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .resize_terminal(&session_id, cols, rows)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn cancel_task(task_id: String, state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.cancel_task(&task_id).await)
}

async fn remove_terminal_session_after_exit(app: tauri::AppHandle, session_id: String) {
    let state = app.state::<AppState>();
    state.remove_session(&session_id).await;
}

#[tauri::command]
pub async fn terminal_session_active(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    Ok(state.has_session(&session_id).await)
}

#[tauri::command]
pub async fn disconnect_terminal(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    Ok(state.remove_session(&session_id).await)
}

#[tauri::command]
pub async fn list_connection_profiles(
    state: State<'_, AppState>,
) -> Result<Vec<ConnectionProfile>, String> {
    state
        .list_connection_profiles()
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn save_connection_profile(
    profile: ConnectionProfile,
    state: State<'_, AppState>,
) -> Result<(), String> {
    validate_profile(&profile).map_err(|err| err.to_string())?;
    state
        .save_connection_profile(profile)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn delete_connection_profile(
    id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    state
        .delete_connection_profile(&id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn list_ai_provider_configs(
    state: State<'_, AppState>,
) -> Result<Vec<AiProviderConfig>, String> {
    state
        .list_ai_provider_configs()
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn get_ai_provider_config(
    id: String,
    state: State<'_, AppState>,
) -> Result<Option<AiProviderConfig>, String> {
    state
        .get_ai_provider_config(&id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn save_ai_provider_config(
    config: AiProviderConfig,
    state: State<'_, AppState>,
) -> Result<(), String> {
    validate_ai_config(&config).map_err(|err| err.to_string())?;
    state
        .save_ai_provider_config(config)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn delete_ai_provider_config(
    id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    state
        .delete_ai_provider_config(&id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn chat_with_ai_provider(request: AiChatRequest) -> Result<AiChatResponse, String> {
    chat_with_provider(request)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn chat_with_ai_provider_stream(
    request_id: String,
    request: AiChatRequest,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<AiChatResponse, String> {
    let event_name = ai_chat_stream_event_name(&request_id);
    let chunk_request_id = request_id.clone();
    let chunk_app = app.clone();
    let chunk_event_name = event_name.clone();
    let cancel_token = state.register_task(request_id.clone()).await;

    let result = chat_with_provider_stream(
        request,
        move |delta| {
            let _ = chunk_app.emit_all(
                &chunk_event_name,
                AiChatStreamEvent {
                    request_id: chunk_request_id.clone(),
                    kind: AiChatStreamEventKind::Chunk,
                    delta,
                    error: None,
                    context_compressed: None,
                    context_chars: None,
                    history_count: None,
                },
            );
        },
        Some(&cancel_token),
    )
    .await;
    state.finish_task(&request_id).await;

    match result {
        Ok(response) => {
            let _ = app.emit_all(
                &event_name,
                AiChatStreamEvent {
                    request_id,
                    kind: AiChatStreamEventKind::Done,
                    delta: String::new(),
                    error: None,
                    context_compressed: Some(response.context_compressed),
                    context_chars: Some(response.context_chars),
                    history_count: Some(response.history_count),
                },
            );
            Ok(response)
        }
        Err(error) => {
            let message = error.to_string();
            let _ = app.emit_all(
                &event_name,
                AiChatStreamEvent {
                    request_id,
                    kind: AiChatStreamEventKind::Error,
                    delta: String::new(),
                    error: Some(message.clone()),
                    context_compressed: None,
                    context_chars: None,
                    history_count: None,
                },
            );
            Err(message)
        }
    }
}

#[tauri::command]
pub async fn generate_ai_session_title(
    request: AiSessionTitleRequest,
) -> Result<AiSessionTitleResponse, String> {
    generate_session_title(request)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn generate_ai_script_title(
    request: AiScriptTitleRequest,
) -> Result<AiScriptTitleResponse, String> {
    generate_script_title(request)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn save_command_history_record(
    record: CommandHistoryRecord,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .save_command_history_record(record)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn save_workspace_session(
    session: WorkspaceSession,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .save_workspace_session(session)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn list_workspace_sessions(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<WorkspaceSession>, String> {
    state
        .list_workspace_sessions(&connection_id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn delete_workspace_session(
    id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    state
        .delete_workspace_session(&id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn list_command_history(
    connection_id: String,
    workspace_session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<CommandHistoryRecord>, String> {
    state
        .list_command_history(&connection_id, &workspace_session_id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn save_ai_conversation_message(
    message: AiConversationMessage,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .save_ai_conversation_message(message)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn list_ai_conversation_messages(
    connection_id: String,
    workspace_session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<AiConversationMessage>, String> {
    state
        .list_ai_conversation_messages(&connection_id, &workspace_session_id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn save_update_script(
    script: UpdateScript,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .save_update_script(script)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn list_update_scripts(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<UpdateScript>, String> {
    state
        .list_update_scripts(&connection_id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn get_update_script(
    id: String,
    state: State<'_, AppState>,
) -> Result<Option<UpdateScript>, String> {
    state
        .get_update_script(&id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn delete_update_script(id: String, state: State<'_, AppState>) -> Result<bool, String> {
    state
        .delete_update_script(&id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn local_home_directory() -> Result<String, String> {
    home_directory().map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn local_list_directory(path: String) -> Result<LocalDirectoryResponse, String> {
    tokio::task::spawn_blocking(move || list_local_directory_impl(&path))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn sftp_list_directory(
    connection_id: String,
    path: String,
    target_host: Option<String>,
    target_username: Option<String>,
    task_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<SftpListResponse, String> {
    let profile = sftp_profile(&connection_id, &state).await?;
    let target_override = SftpTargetOverride {
        host: target_host,
        username: target_username,
    };
    let (task_id, cancel_token) = register_optional_task(task_id, &state).await;
    let timeout_token = cancel_token.clone();
    let operation = tokio::task::spawn_blocking(move || {
        list_directory_with_cancel(&profile, &path, &target_override, cancel_token.as_ref())
    });
    let result = match tokio::time::timeout(SFTP_COMMAND_TIMEOUT, operation).await {
        Ok(joined) => joined
            .map_err(|err| err.to_string())?
            .map_err(|err| err.to_string()),
        Err(_) => {
            if let Some(token) = timeout_token {
                token.store(true, Ordering::SeqCst);
            }
            Err("SFTP directory listing timed out; Windows sftp.exe or the PTY session did not return. Please check saved passwords, host-key prompts, ProxyJump access, and whether the remote server allows SFTP.".into())
        }
    };
    finish_optional_task(task_id, &state).await;
    result
}

#[tauri::command]
pub async fn sftp_probe(
    connection_id: String,
    target_host: Option<String>,
    target_username: Option<String>,
    task_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<SftpProbeResponse, String> {
    let profile = sftp_profile(&connection_id, &state).await?;
    let target_override = SftpTargetOverride {
        host: target_host,
        username: target_username,
    };
    let (task_id, cancel_token) = register_optional_task(task_id, &state).await;
    let result = tokio::task::spawn_blocking(move || {
        probe_sftp_with_cancel(&profile, &target_override, cancel_token.as_ref())
    })
    .await
    .map_err(|err| err.to_string());
    finish_optional_task(task_id, &state).await;
    result
}

#[tauri::command]
pub async fn sftp_create_directory(
    connection_id: String,
    path: String,
    target_host: Option<String>,
    target_username: Option<String>,
    task_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<SftpTransferResponse, String> {
    let profile = sftp_profile(&connection_id, &state).await?;
    let target_override = SftpTargetOverride {
        host: target_host,
        username: target_username,
    };
    let (task_id, cancel_token) = register_optional_task(task_id, &state).await;
    let result = tokio::task::spawn_blocking(move || {
        create_directory_with_cancel(&profile, &path, &target_override, cancel_token.as_ref())
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string());
    finish_optional_task(task_id, &state).await;
    result
}

#[tauri::command]
pub async fn sftp_delete_path(
    connection_id: String,
    path: String,
    is_dir: bool,
    target_host: Option<String>,
    target_username: Option<String>,
    task_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<SftpTransferResponse, String> {
    let profile = sftp_profile(&connection_id, &state).await?;
    let target_override = SftpTargetOverride {
        host: target_host,
        username: target_username,
    };
    let (task_id, cancel_token) = register_optional_task(task_id, &state).await;
    let result = tokio::task::spawn_blocking(move || {
        delete_path_with_cancel(
            &profile,
            &path,
            is_dir,
            &target_override,
            cancel_token.as_ref(),
        )
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string());
    finish_optional_task(task_id, &state).await;
    result
}

#[tauri::command]
pub async fn sftp_upload_file(
    connection_id: String,
    local_path: String,
    remote_dir: String,
    target_host: Option<String>,
    target_username: Option<String>,
    task_id: Option<String>,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<SftpTransferResponse, String> {
    let profile = sftp_profile(&connection_id, &state).await?;
    let target_override = SftpTargetOverride {
        host: target_host,
        username: target_username,
    };
    let (task_id, cancel_token) = register_optional_task(task_id, &state).await;
    let progress_task_id = task_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        with_sftp_progress(app, progress_task_id, |progress| {
            upload_file_with_progress(
                &profile,
                &local_path,
                &remote_dir,
                &target_override,
                cancel_token.as_ref(),
                progress,
            )
        })
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string());
    finish_optional_task(task_id, &state).await;
    result
}

#[tauri::command]
pub async fn sftp_upload_path(
    connection_id: String,
    local_path: String,
    remote_dir: String,
    target_host: Option<String>,
    target_username: Option<String>,
    task_id: Option<String>,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<SftpTransferResponse, String> {
    let profile = sftp_profile(&connection_id, &state).await?;
    let target_override = SftpTargetOverride {
        host: target_host,
        username: target_username,
    };
    let (task_id, cancel_token) = register_optional_task(task_id, &state).await;
    let progress_task_id = task_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        with_sftp_progress(app, progress_task_id, |progress| {
            upload_path_with_progress(
                &profile,
                &local_path,
                &remote_dir,
                &target_override,
                cancel_token.as_ref(),
                progress,
            )
        })
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string());
    finish_optional_task(task_id, &state).await;
    result
}

#[tauri::command]
pub async fn sftp_download_file(
    connection_id: String,
    remote_path: String,
    local_path: String,
    target_host: Option<String>,
    target_username: Option<String>,
    task_id: Option<String>,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<SftpTransferResponse, String> {
    let profile = sftp_profile(&connection_id, &state).await?;
    let target_override = SftpTargetOverride {
        host: target_host,
        username: target_username,
    };
    let (task_id, cancel_token) = register_optional_task(task_id, &state).await;
    let progress_task_id = task_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        with_sftp_progress(app, progress_task_id, |progress| {
            download_file_with_progress(
                &profile,
                &remote_path,
                &local_path,
                &target_override,
                cancel_token.as_ref(),
                progress,
            )
        })
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string());
    finish_optional_task(task_id, &state).await;
    result
}

#[tauri::command]
pub async fn sftp_download_path(
    connection_id: String,
    remote_path: String,
    local_dir: String,
    is_dir: bool,
    target_host: Option<String>,
    target_username: Option<String>,
    task_id: Option<String>,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<SftpTransferResponse, String> {
    let profile = sftp_profile(&connection_id, &state).await?;
    let target_override = SftpTargetOverride {
        host: target_host,
        username: target_username,
    };
    let (task_id, cancel_token) = register_optional_task(task_id, &state).await;
    let progress_task_id = task_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        with_sftp_progress(app, progress_task_id, |progress| {
            download_path_with_progress(
                &profile,
                &remote_path,
                &local_dir,
                is_dir,
                &target_override,
                cancel_token.as_ref(),
                progress,
            )
        })
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string());
    finish_optional_task(task_id, &state).await;
    result
}

#[tauri::command]
pub async fn probe_bastion_servers(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<BastionServerCandidate>, String> {
    let profile = sftp_profile(&connection_id, &state).await?;
    tokio::task::spawn_blocking(move || probe_servers(&profile))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())
}

fn with_sftp_progress<T, F>(
    app: tauri::AppHandle,
    task_id: Option<String>,
    action: F,
) -> anyhow::Result<T>
where
    F: FnOnce(Option<&mut dyn FnMut(SftpProgressUpdate)>) -> anyhow::Result<T>,
{
    if let Some(task_id) = task_id {
        let event_name = sftp_transfer_event_name(&task_id);
        let mut callback = move |update: SftpProgressUpdate| {
            let _ = app.emit_all(
                &event_name,
                SftpTransferEvent {
                    task_id: task_id.clone(),
                    percent: update.percent,
                    text: update.text,
                },
            );
        };
        action(Some(&mut callback))
    } else {
        action(None)
    }
}
async fn register_optional_task(
    task_id: Option<String>,
    state: &State<'_, AppState>,
) -> (Option<String>, Option<SftpCancelToken>) {
    if let Some(task_id) = task_id {
        let token = state.register_task(task_id.clone()).await;
        (Some(task_id), Some(token))
    } else {
        (None, None)
    }
}

async fn finish_optional_task(task_id: Option<String>, state: &State<'_, AppState>) {
    if let Some(task_id) = task_id {
        state.finish_task(&task_id).await;
    }
}

async fn sftp_profile(
    connection_id: &str,
    state: &State<'_, AppState>,
) -> Result<ConnectionProfile, String> {
    if connection_id == "local" {
        return Err("SFTP requires a remote connection profile".into());
    }

    let profile = state
        .get_connection_profile(connection_id)
        .await
        .map_err(|err| err.to_string())?
        .ok_or_else(|| format!("connection profile {connection_id} was not found"))?;
    validate_profile(&profile).map_err(|err| err.to_string())?;
    Ok(profile)
}
