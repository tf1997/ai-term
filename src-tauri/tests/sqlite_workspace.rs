use ai_term_lib::domain::storage::sqlite::SqliteConfigStore;
use ai_term_lib::domain::workspace::{
    AiConversationMessage, AiMessageRole, CommandHistoryRecord, UpdateScript, WorkspaceSession,
    LOCAL_CONNECTION_ID,
};

fn temp_db_path(name: &str) -> String {
    let path =
        std::env::temp_dir().join(format!("ai-term-{name}-{}.sqlite3", uuid::Uuid::new_v4()));
    path.to_string_lossy().into_owned()
}

fn session(id: &str, connection_id: &str, name: &str, created_at: &str) -> WorkspaceSession {
    WorkspaceSession {
        id: id.into(),
        connection_id: connection_id.into(),
        name: name.into(),
        summary: "".into(),
        context_summary: "".into(),
        context_summary_last_message_id: "".into(),
        created_at: created_at.into(),
        updated_at: created_at.into(),
    }
}

fn command(
    id: &str,
    connection_id: &str,
    workspace_session_id: &str,
    terminal_id: &str,
    value: &str,
    created_at: &str,
) -> CommandHistoryRecord {
    CommandHistoryRecord {
        id: id.into(),
        connection_id: connection_id.into(),
        workspace_session_id: workspace_session_id.into(),
        terminal_id: terminal_id.into(),
        command: value.into(),
        created_at: created_at.into(),
    }
}

fn ai_message(
    id: &str,
    connection_id: &str,
    workspace_session_id: &str,
    terminal_id: &str,
    role: AiMessageRole,
    text: &str,
    created_at: &str,
) -> AiConversationMessage {
    AiConversationMessage {
        id: id.into(),
        connection_id: connection_id.into(),
        workspace_session_id: workspace_session_id.into(),
        terminal_id: terminal_id.into(),
        role,
        text: text.into(),
        command: None,
        error: false,
        created_at: created_at.into(),
    }
}

fn script(
    id: &str,
    connection_id: &str,
    workspace_session_id: &str,
    name: &str,
    updated_at: &str,
) -> UpdateScript {
    UpdateScript {
        id: id.into(),
        connection_id: connection_id.into(),
        workspace_session_id: workspace_session_id.into(),
        name: name.into(),
        description: format!("{name} description"),
        content: format!("#!/usr/bin/env bash\necho {name}"),
        source_commands: vec![format!("echo {name}")],
        created_at: updated_at.into(),
        updated_at: updated_at.into(),
    }
}

#[test]
fn sqlite_store_lists_workspace_sessions_across_connections() {
    let store = SqliteConfigStore::new(temp_db_path("workspace-sessions"));
    let first = session(
        "conversation-1",
        "prod-1",
        "Investigate CPU",
        "2026-07-02T09:00:00Z",
    );
    let second = session(
        "conversation-2",
        "prod-2",
        "Release window",
        "2026-07-02T10:00:00Z",
    );
    let local = session(
        "conversation-local",
        LOCAL_CONNECTION_ID,
        "Local work",
        "2026-07-02T11:00:00Z",
    );
    let command_only = session(
        "legacy-command-session",
        "prod-legacy",
        "Legacy command",
        "2026-07-02T12:00:00Z",
    );
    let legacy_command = command(
        "legacy-command",
        "prod-legacy",
        &command_only.id,
        "terminal-legacy",
        "uptime",
        "2026-07-02T12:00:01Z",
    );

    store.save_workspace_session(&first).unwrap();
    store.save_workspace_session(&second).unwrap();
    store.save_workspace_session(&local).unwrap();
    store.save_workspace_session(&command_only).unwrap();
    store.save_command_history_record(&legacy_command).unwrap();
    store
        .save_ai_conversation_message(&ai_message(
            "ai-first",
            &first.connection_id,
            &first.id,
            "terminal-1",
            AiMessageRole::User,
            "Investigate CPU",
            "2026-07-02T09:00:01Z",
        ))
        .unwrap();
    store
        .save_ai_conversation_message(&ai_message(
            "ai-second",
            &second.connection_id,
            &second.id,
            "terminal-2",
            AiMessageRole::User,
            "Plan the release",
            "2026-07-02T10:00:01Z",
        ))
        .unwrap();
    store
        .save_ai_conversation_message(&ai_message(
            "ai-local",
            &local.connection_id,
            &local.id,
            "local-1",
            AiMessageRole::User,
            "Inspect local files",
            "2026-07-02T11:00:01Z",
        ))
        .unwrap();

    assert_eq!(
        store.list_workspace_sessions().unwrap(),
        vec![local.clone(), second.clone(), first.clone()]
    );

    assert!(store.delete_workspace_session(&first.id).unwrap());
    assert_eq!(
        store.list_workspace_sessions().unwrap(),
        vec![local, second]
    );
    assert_eq!(
        store.list_command_history("prod-legacy").unwrap(),
        vec![legacy_command]
    );
}

#[test]
fn sqlite_store_lists_command_history_by_connection_across_workspace_sessions() {
    let store = SqliteConfigStore::new(temp_db_path("workspace-history"));
    let first_session_command = command(
        "cmd-1",
        "prod-1",
        "conversation-1",
        "terminal-1",
        "df -h",
        "2026-07-02T10:00:00Z",
    );
    let second_session_command = command(
        "cmd-2",
        "prod-1",
        "conversation-2",
        "terminal-2",
        "free -h",
        "2026-07-02T10:01:00Z",
    );
    let local_command = command(
        "cmd-local",
        LOCAL_CONNECTION_ID,
        "conversation-local",
        "local-1",
        "pwd",
        "2026-07-02T10:02:00Z",
    );

    store
        .save_command_history_record(&first_session_command)
        .unwrap();
    store
        .save_command_history_record(&second_session_command)
        .unwrap();
    store.save_command_history_record(&local_command).unwrap();

    assert_eq!(
        store.list_command_history("prod-1").unwrap(),
        vec![first_session_command, second_session_command]
    );
    assert_eq!(
        store.list_command_history(LOCAL_CONNECTION_ID).unwrap(),
        vec![local_command]
    );
    assert!(store.list_command_history("prod-2").unwrap().is_empty());
}

#[test]
fn command_history_retention_is_shared_by_all_sessions_on_a_connection() {
    let store = SqliteConfigStore::new(temp_db_path("workspace-history-retention"));
    store.initialize().unwrap();

    let mut connection = rusqlite::Connection::open(store.database_path()).unwrap();
    let transaction = connection.transaction().unwrap();
    for index in 0..1000 {
        transaction
            .execute(
                r#"
                INSERT INTO command_history (
                  id, connection_id, workspace_session_id, terminal_id, command, created_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                "#,
                rusqlite::params![
                    format!("existing-{index:04}"),
                    "prod-1",
                    if index % 2 == 0 {
                        "conversation-1"
                    } else {
                        "conversation-2"
                    },
                    "terminal-1",
                    format!("echo {index}"),
                    format!("2026-07-02T10:00:{index:04}Z"),
                ],
            )
            .unwrap();
    }
    transaction.commit().unwrap();

    let newest = command(
        "newest",
        "prod-1",
        "conversation-3",
        "terminal-3",
        "uname -a",
        "2026-07-02T10:00:9999Z",
    );
    store.save_command_history_record(&newest).unwrap();

    let retained: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM command_history WHERE connection_id = ?1",
            ["prod-1"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(retained, 1000);
}

#[test]
fn sqlite_store_lists_ai_messages_by_conversation_across_source_connections() {
    let store = SqliteConfigStore::new(temp_db_path("workspace-ai"));
    let user_message = ai_message(
        "ai-1",
        "prod-1",
        "conversation-shared",
        "terminal-1",
        AiMessageRole::User,
        "Check disk usage",
        "2026-07-02T10:00:00Z",
    );
    let assistant_message = ai_message(
        "ai-2",
        "prod-2",
        "conversation-shared",
        "terminal-2",
        AiMessageRole::Assistant,
        "Run df -h on the selected target",
        "2026-07-02T10:00:01Z",
    );
    let other_conversation_message = ai_message(
        "ai-3",
        "prod-1",
        "conversation-other",
        "terminal-1",
        AiMessageRole::User,
        "Check memory",
        "2026-07-02T10:00:02Z",
    );

    store.save_ai_conversation_message(&user_message).unwrap();
    store
        .save_ai_conversation_message(&assistant_message)
        .unwrap();
    store
        .save_ai_conversation_message(&other_conversation_message)
        .unwrap();

    assert_eq!(
        store
            .list_ai_conversation_messages("conversation-shared")
            .unwrap(),
        vec![user_message, assistant_message]
    );
    assert_eq!(
        store
            .list_ai_conversation_messages("conversation-other")
            .unwrap(),
        vec![other_conversation_message]
    );
}

#[test]
fn deleting_workspace_session_keeps_command_history_and_deletes_ai_messages() {
    let store = SqliteConfigStore::new(temp_db_path("delete-workspace-session"));
    let workspace_session = session(
        "conversation-delete",
        "prod-1",
        "Temporary conversation",
        "2026-07-02T09:00:00Z",
    );
    let history = command(
        "cmd-retained",
        "prod-1",
        &workspace_session.id,
        "terminal-1",
        "uname -a",
        "2026-07-02T10:00:00Z",
    );
    let message = ai_message(
        "ai-deleted",
        "prod-1",
        &workspace_session.id,
        "terminal-1",
        AiMessageRole::User,
        "Explain the host",
        "2026-07-02T10:00:01Z",
    );

    store.save_workspace_session(&workspace_session).unwrap();
    store.save_command_history_record(&history).unwrap();
    store.save_ai_conversation_message(&message).unwrap();

    assert!(store
        .delete_workspace_session(&workspace_session.id)
        .unwrap());
    assert!(store.list_workspace_sessions().unwrap().is_empty());
    assert_eq!(store.list_command_history("prod-1").unwrap(), vec![history]);
    assert!(store
        .list_ai_conversation_messages(&workspace_session.id)
        .unwrap()
        .is_empty());
}

#[test]
fn sqlite_store_persists_session_context_summary() {
    let store = SqliteConfigStore::new(temp_db_path("session-context-summary"));
    let mut compacted = session(
        "conversation-compacted",
        "prod-1",
        "Long investigation",
        "2026-07-02T09:00:00Z",
    );
    compacted.context_summary = "早期对话摘要：已在 web-1 上定位到 nginx 502 由上游超时导致。".into();
    compacted.context_summary_last_message_id = "ai-0042".into();

    store.save_workspace_session(&compacted).unwrap();
    store
        .save_ai_conversation_message(&ai_message(
            "ai-latest",
            "prod-1",
            &compacted.id,
            "terminal-1",
            AiMessageRole::User,
            "继续排查",
            "2026-07-02T09:00:01Z",
        ))
        .unwrap();

    assert_eq!(store.list_workspace_sessions().unwrap(), vec![compacted]);
}

#[test]
fn sqlite_store_lists_update_scripts_globally() {
    let store = SqliteConfigStore::new(temp_db_path("global-scripts"));
    let prod_script = script(
        "script-prod",
        "prod-1",
        "conversation-1",
        "deploy-prod",
        "2026-07-02T10:00:00Z",
    );
    let local_script = script(
        "script-local",
        LOCAL_CONNECTION_ID,
        "conversation-local",
        "backup-local",
        "2026-07-02T11:00:00Z",
    );

    store.save_update_script(&prod_script).unwrap();
    store.save_update_script(&local_script).unwrap();

    assert_eq!(
        store.list_update_scripts().unwrap(),
        vec![local_script, prod_script]
    );
}
