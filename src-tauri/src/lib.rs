pub mod app;
pub mod domain;

pub use domain::ai::config as ai;
pub use domain::auth::credentials;
pub use domain::auth::keys;
pub use domain::connection::gateway;
pub use domain::connection::models;
pub use domain::connection::profiles;
pub use domain::connection::transfer;
pub use domain::storage::sqlite;
pub use domain::terminal::ssh;

pub fn run() {
    use tauri::Manager;

    use app::commands::{
        cancel_task, chat_with_ai_provider, chat_with_ai_provider_stream, connect_local_terminal,
        connect_profile, delete_ai_provider_config, delete_connection_profile,
        delete_update_script, delete_workspace_session, disconnect_terminal,
        generate_ai_script_title, generate_ai_session_title, get_ai_provider_config,
        get_update_script, list_ai_conversation_messages, list_ai_provider_configs,
        list_command_history, list_connection_profiles, list_update_scripts,
        list_workspace_sessions, local_home_directory, local_list_directory, probe_bastion_servers,
        save_ai_conversation_message, save_ai_provider_config, save_command_history_record,
        save_connection_profile, save_update_script, save_workspace_session, sftp_create_directory,
        sftp_delete_path, sftp_download_file, sftp_download_path, sftp_list_directory, sftp_probe,
        sftp_upload_file, sftp_upload_path, terminal_resize, terminal_write,
    };
    use app::state::AppState;
    use domain::storage::sqlite::{default_database_path, SqliteConfigStore};

    tauri::Builder::default()
        .setup(|app| {
            let app_config_dir = app
                .path_resolver()
                .app_config_dir()
                .ok_or_else(|| "failed to resolve app config directory".to_string())?;
            let store = SqliteConfigStore::new(default_database_path(&app_config_dir));
            store.initialize().map_err(|err| err.to_string())?;
            app.manage(AppState::with_profile_store(store));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cancel_task,
            chat_with_ai_provider,
            chat_with_ai_provider_stream,
            connect_local_terminal,
            connect_profile,
            delete_ai_provider_config,
            delete_connection_profile,
            delete_update_script,
            delete_workspace_session,
            disconnect_terminal,
            generate_ai_script_title,
            generate_ai_session_title,
            get_ai_provider_config,
            get_update_script,
            list_ai_conversation_messages,
            list_ai_provider_configs,
            list_command_history,
            list_connection_profiles,
            list_update_scripts,
            list_workspace_sessions,
            local_home_directory,
            local_list_directory,
            probe_bastion_servers,
            save_ai_conversation_message,
            save_ai_provider_config,
            save_command_history_record,
            save_connection_profile,
            save_update_script,
            save_workspace_session,
            sftp_create_directory,
            sftp_delete_path,
            sftp_download_file,
            sftp_download_path,
            sftp_list_directory,
            sftp_probe,
            sftp_upload_file,
            sftp_upload_path,
            terminal_write,
            terminal_resize
        ])
        .run(tauri::generate_context!())
        .expect("failed to run ai-term");
}
