use ai_term_lib::domain::storage::sqlite::SqliteConfigStore;
use ai_term_lib::domain::workspace::{
    AiConversationMessage, AiMessageRole, CommandHistoryRecord, WorkspaceSession,
    LOCAL_CONNECTION_ID,
};

fn temp_db_path(name: &str) -> String {
    let path =
        std::env::temp_dir().join(format!("ai-term-{name}-{}.sqlite3", uuid::Uuid::new_v4()));
    path.to_string_lossy().into_owned()
}

fn session(id: &str, connection_id: &str, name: &str) -> WorkspaceSession {
    WorkspaceSession {
        id: id.into(),
        connection_id: connection_id.into(),
        name: name.into(),
        summary: "".into(),
        created_at: "2026-07-02T09:00:00Z".into(),
        updated_at: "2026-07-02T09:00:00Z".into(),
    }
}

#[test]
fn sqlite_store_roundtrips_workspace_sessions() {
    let store = SqliteConfigStore::new(temp_db_path("workspace-sessions"));
    let first = session("prod-1:session:1", "prod-1", "排查 CPU");
    let second = session("prod-1:session:2", "prod-1", "发布窗口");
    let local = session("local:default", LOCAL_CONNECTION_ID, "本地默认");

    store.save_workspace_session(&first).unwrap();
    store.save_workspace_session(&second).unwrap();
    store.save_workspace_session(&local).unwrap();

    assert_eq!(
        store.list_workspace_sessions("prod-1").unwrap(),
        vec![second, first.clone()]
    );
    assert!(store.delete_workspace_session(&first.id).unwrap());
    assert_eq!(store.list_workspace_sessions("prod-1").unwrap().len(), 1);
}

#[test]
fn sqlite_store_roundtrips_command_history_by_workspace_session() {
    let store = SqliteConfigStore::new(temp_db_path("workspace-history"));
    let prod_command = CommandHistoryRecord {
        id: "cmd-1".into(),
        connection_id: "prod-1".into(),
        workspace_session_id: "prod-1:session:1".into(),
        terminal_id: "terminal-1".into(),
        command: "df -h".into(),
        created_at: "2026-07-02T10:00:00Z".into(),
    };
    let local_command = CommandHistoryRecord {
        id: "cmd-local".into(),
        connection_id: LOCAL_CONNECTION_ID.into(),
        workspace_session_id: "local:default".into(),
        terminal_id: "local-1".into(),
        command: "pwd".into(),
        created_at: "2026-07-02T10:01:00Z".into(),
    };

    store.save_command_history_record(&prod_command).unwrap();
    store.save_command_history_record(&local_command).unwrap();

    assert_eq!(
        store
            .list_command_history("prod-1", "prod-1:session:1")
            .unwrap(),
        vec![prod_command]
    );
    assert_eq!(
        store
            .list_command_history(LOCAL_CONNECTION_ID, "local:default")
            .unwrap(),
        vec![local_command]
    );
    assert!(store
        .list_command_history("prod-1", "prod-1:session:2")
        .unwrap()
        .is_empty());
}

#[test]
fn sqlite_store_roundtrips_ai_messages_by_workspace_session() {
    let store = SqliteConfigStore::new(temp_db_path("workspace-ai"));
    let user_message = AiConversationMessage {
        id: "ai-1".into(),
        connection_id: "prod-1".into(),
        workspace_session_id: "prod-1:session:1".into(),
        terminal_id: "terminal-1".into(),
        role: AiMessageRole::User,
        text: "查一下磁盘".into(),
        command: None,
        error: false,
        created_at: "2026-07-02T10:00:00Z".into(),
    };
    let assistant_message = AiConversationMessage {
        id: "ai-2".into(),
        connection_id: "prod-1".into(),
        workspace_session_id: "prod-1:session:1".into(),
        terminal_id: "terminal-1".into(),
        role: AiMessageRole::Assistant,
        text: "可以执行 df -h".into(),
        command: Some("df -h".into()),
        error: false,
        created_at: "2026-07-02T10:00:01Z".into(),
    };

    store.save_ai_conversation_message(&user_message).unwrap();
    store
        .save_ai_conversation_message(&assistant_message)
        .unwrap();

    assert_eq!(
        store
            .list_ai_conversation_messages("prod-1", "prod-1:session:1")
            .unwrap(),
        vec![user_message, assistant_message]
    );
    assert!(store
        .list_ai_conversation_messages(LOCAL_CONNECTION_ID, "local:default")
        .unwrap()
        .is_empty());
    assert!(store
        .list_ai_conversation_messages("prod-1", "prod-1:session:2")
        .unwrap()
        .is_empty());
}
