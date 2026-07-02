use tauri::{Manager, State};
use uuid::Uuid;

use crate::app::events::{
    ai_chat_stream_event_name, terminal_closed_event_name, terminal_data_event_name,
    AiChatStreamEvent, AiChatStreamEventKind, TerminalClosedEvent, TerminalDataEvent,
};
use crate::app::state::AppState;
use crate::domain::ai::chat::{
    chat_with_provider, chat_with_provider_stream, generate_session_title, AiChatRequest,
    AiChatResponse, AiSessionTitleRequest, AiSessionTitleResponse,
};
use crate::domain::ai::config::validate_ai_config;
use crate::domain::connection::models::AiProviderConfig;
use crate::domain::connection::models::ConnectionProfile;
use crate::domain::connection::profiles::validate_profile;
use crate::domain::terminal::local::spawn_local_terminal;
use crate::domain::terminal::ssh::spawn_ssh_terminal;
use crate::domain::workspace::{AiConversationMessage, CommandHistoryRecord, WorkspaceSession};

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
                    session_id: closed_session_id,
                    reason: "eof".into(),
                },
            );
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
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let session_id = Uuid::new_v4().to_string();
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
                    session_id: closed_session_id,
                    reason: "eof".into(),
                },
            );
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
) -> Result<AiChatResponse, String> {
    let event_name = ai_chat_stream_event_name(&request_id);
    let chunk_request_id = request_id.clone();
    let chunk_app = app.clone();
    let chunk_event_name = event_name.clone();

    let result = chat_with_provider_stream(request, move |delta| {
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
    })
    .await;

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
