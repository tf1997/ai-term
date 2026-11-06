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
    use app::agent_checkpoints::{
        begin_agent_run, completed_agent_checkpoint_for_message, confirm_agent_recovery,
        list_agent_checkpoints, recover_agent_run, release_agent_run, reply_agent_run,
        save_agent_checkpoint,
    };
    use app::host_knowledge::{
        delete_host_knowledge, host_knowledge_context, host_knowledge_scope, list_host_knowledge,
        save_host_knowledge,
    };
    use tauri::Manager;

    use app::command_policy::{
        analyze_command_intent, approve_command_intent, cancel_command_intent,
        command_execution_target, dispatch_command_intent, prepare_terminal_probe,
        update_command_context,
    };
    use app::commands::{
        ai_agent_turn_stream, cancel_task, chat_with_ai_provider, chat_with_ai_provider_stream,
        compress_ai_conversation, connect_local_terminal, connect_profile,
        delete_agent_command_allowlist_entry, delete_ai_provider_config, delete_connection_profile,
        delete_update_script, delete_workspace_session, disconnect_terminal,
        forget_ai_term_known_host, generate_ai_script_title, generate_ai_session_title,
        get_ai_provider_config, get_update_script, list_agent_command_allowlist,
        list_ai_conversation_messages, list_ai_provider_configs, list_command_history,
        list_connection_profiles, list_update_scripts, list_workspace_sessions,
        local_home_directory, local_list_directory, local_list_roots, local_open_path,
        probe_bastion_servers, save_agent_command_allowlist_entries,
        save_agent_command_allowlist_entry, save_ai_conversation_message, save_ai_provider_config,
        save_command_history_record, save_connection_profile, save_update_script,
        save_workspace_session, sftp_create_directory, sftp_delete_path, sftp_download_file,
        sftp_download_path, sftp_list_directory, sftp_probe, sftp_read_text_file,
        sftp_save_text_file, sftp_upload_file, sftp_upload_path, terminal_resize,
        terminal_session_active, terminal_write, touch_agent_command_allowlist_entry,
    };
    use app::file_tools::{
        approve_agent_file_edit, approve_agent_file_operation, cancel_agent_file_operation,
        dispatch_agent_file_edit, dispatch_agent_file_operation, finish_agent_file_inspection,
        finish_agent_terminal_file, finish_agent_terminal_file_edit, get_agent_file_change,
        list_agent_file_changes, prepare_agent_file_edit, prepare_agent_file_inspection,
        prepare_agent_file_restore,
    };
    use app::ssh_tasks::{
        approve_ssh_task, prepare_ssh_task, read_ssh_task, start_ssh_task, stop_observing_ssh_task,
    };
    use app::state::AppState;
    use domain::storage::sqlite::{default_database_path, SqliteConfigStore};

    tauri::Builder::default()
        .setup(|app| {
            let app_config_dir = app
                .path_resolver()
                .app_config_dir()
                .ok_or_else(|| "failed to resolve app config directory".to_string())?;
            let store = SqliteConfigStore::with_platform_credentials(default_database_path(
                &app_config_dir,
            ));
            store.initialize().map_err(|err| err.to_string())?;
            app.manage(AppState::with_profile_store(store));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            begin_agent_run,
            completed_agent_checkpoint_for_message,
            host_knowledge_scope,
            list_host_knowledge,
            save_host_knowledge,
            delete_host_knowledge,
            host_knowledge_context,
            recover_agent_run,
            reply_agent_run,
            confirm_agent_recovery,
            save_agent_checkpoint,
            release_agent_run,
            list_agent_checkpoints,
            prepare_ssh_task,
            approve_ssh_task,
            start_ssh_task,
            read_ssh_task,
            stop_observing_ssh_task,
            prepare_agent_file_inspection,
            finish_agent_file_inspection,
            approve_agent_file_operation,
            dispatch_agent_file_operation,
            finish_agent_terminal_file,
            cancel_agent_file_operation,
            prepare_agent_file_edit,
            prepare_agent_file_restore,
            approve_agent_file_edit,
            dispatch_agent_file_edit,
            finish_agent_terminal_file_edit,
            get_agent_file_change,
            list_agent_file_changes,
            command_execution_target,
            prepare_terminal_probe,
            update_command_context,
            analyze_command_intent,
            approve_command_intent,
            dispatch_command_intent,
            cancel_command_intent,
            ai_agent_turn_stream,
            cancel_task,
            chat_with_ai_provider,
            chat_with_ai_provider_stream,
            compress_ai_conversation,
            connect_local_terminal,
            connect_profile,
            delete_agent_command_allowlist_entry,
            delete_ai_provider_config,
            delete_connection_profile,
            delete_update_script,
            delete_workspace_session,
            disconnect_terminal,
            forget_ai_term_known_host,
            generate_ai_script_title,
            generate_ai_session_title,
            get_ai_provider_config,
            get_update_script,
            list_agent_command_allowlist,
            list_ai_conversation_messages,
            list_ai_provider_configs,
            list_command_history,
            list_connection_profiles,
            list_update_scripts,
            list_workspace_sessions,
            local_home_directory,
            local_list_roots,
            local_list_directory,
            local_open_path,
            probe_bastion_servers,
            save_agent_command_allowlist_entries,
            save_agent_command_allowlist_entry,
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
            sftp_read_text_file,
            sftp_save_text_file,
            sftp_upload_file,
            sftp_upload_path,
            terminal_write,
            terminal_resize,
            terminal_session_active,
            touch_agent_command_allowlist_entry
        ])
        .run(tauri::generate_context!())
        .expect("failed to run ai-term");
}
