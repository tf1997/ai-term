use ai_term_lib::domain::storage::sqlite::SqliteConfigStore;
use ai_term_lib::domain::workspace::{
    AiConversationMessage, AiMessageRole, WorkspaceSession, LOCAL_CONNECTION_ID,
};
use rusqlite::Connection;

fn temp_db_path(name: &str) -> String {
    let path =
        std::env::temp_dir().join(format!("ai-term-{name}-{}.sqlite3", uuid::Uuid::new_v4()));
    path.to_string_lossy().into_owned()
}

fn session(id: &str, ai_mode: &str, created_at: &str) -> WorkspaceSession {
    WorkspaceSession {
        id: id.into(),
        connection_id: LOCAL_CONNECTION_ID.into(),
        name: "Agent storage test".into(),
        summary: "".into(),
        context_summary: "".into(),
        context_summary_last_message_id: "".into(),
        ai_mode: ai_mode.into(),
        created_at: created_at.into(),
        updated_at: created_at.into(),
    }
}

fn ai_message(
    id: &str,
    workspace_session_id: &str,
    payload_json: &str,
    created_at: &str,
) -> AiConversationMessage {
    AiConversationMessage {
        id: id.into(),
        connection_id: LOCAL_CONNECTION_ID.into(),
        workspace_session_id: workspace_session_id.into(),
        terminal_id: "terminal-1".into(),
        role: AiMessageRole::Assistant,
        text: "任务完成".into(),
        command: None,
        error: false,
        payload_json: payload_json.into(),
        created_at: created_at.into(),
    }
}

#[test]
fn sqlite_store_migrates_legacy_tables_with_agent_defaults() {
    // 构造未包含 ai_mode / payload_json 列的旧库,验证打开时增量迁移补默认值。
    let database_path = temp_db_path("agent-legacy-migration");
    let connection = Connection::open(&database_path).unwrap();
    connection
        .execute_batch(
            r#"
            CREATE TABLE workspace_sessions (
              id TEXT PRIMARY KEY NOT NULL,
              connection_id TEXT NOT NULL,
              name TEXT NOT NULL,
              summary TEXT NOT NULL DEFAULT '',
              context_summary TEXT NOT NULL DEFAULT '',
              context_summary_last_message_id TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE ai_conversation_messages (
              id TEXT PRIMARY KEY NOT NULL,
              connection_id TEXT NOT NULL,
              workspace_session_id TEXT NOT NULL DEFAULT 'default',
              terminal_id TEXT NOT NULL,
              role TEXT NOT NULL,
              text TEXT NOT NULL,
              command TEXT,
              error INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            INSERT INTO workspace_sessions (
              id, connection_id, name, created_at, updated_at
            ) VALUES (
              'legacy-session', 'prod-1', '旧版会话',
              '2026-07-02T09:00:00Z', '2026-07-02T09:00:00Z'
            );

            INSERT INTO ai_conversation_messages (
              id, connection_id, workspace_session_id, terminal_id, role, text, created_at
            ) VALUES (
              'legacy-message', 'prod-1', 'legacy-session', 'terminal-1',
              'user', '查看磁盘占用', '2026-07-02T09:00:01Z'
            );
            "#,
        )
        .unwrap();
    drop(connection);

    let store = SqliteConfigStore::new(database_path);

    let sessions = store.list_workspace_sessions().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].id, "legacy-session");
    assert_eq!(sessions[0].ai_mode, "chat");

    let messages = store
        .list_ai_conversation_messages("legacy-session")
        .unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].id, "legacy-message");
    assert_eq!(messages[0].payload_json, "");
}

#[test]
fn sqlite_store_roundtrips_workspace_session_ai_mode() {
    let store = SqliteConfigStore::new(temp_db_path("agent-session-mode"));
    let agent_session = session("conversation-agent", "agent", "2026-07-02T09:00:00Z");

    store.save_workspace_session(&agent_session).unwrap();
    // list 只返回有消息的会话,补一条消息让会话可见。
    store
        .save_ai_conversation_message(&ai_message(
            "agent-message",
            &agent_session.id,
            "",
            "2026-07-02T09:00:01Z",
        ))
        .unwrap();

    assert_eq!(
        store.list_workspace_sessions().unwrap(),
        vec![agent_session]
    );
}

#[test]
fn sqlite_store_roundtrips_ai_message_payload_json() {
    let store = SqliteConfigStore::new(temp_db_path("agent-message-payload"));
    let payload =
        r#"{"mode":"agent","agentStatus":"done","agentSteps":[{"command":"df -h","exitCode":0}]}"#;
    let message = ai_message(
        "agent-payload",
        "conversation-agent",
        payload,
        "2026-07-02T09:00:01Z",
    );

    store.save_ai_conversation_message(&message).unwrap();

    assert_eq!(
        store
            .list_ai_conversation_messages("conversation-agent")
            .unwrap(),
        vec![message]
    );
}

#[test]
fn sqlite_store_manages_agent_command_allowlist_entries() {
    let store = SqliteConfigStore::new(temp_db_path("agent-allowlist"));

    store
        .save_agent_command_allowlist_entry("git status", "git status --porcelain")
        .unwrap();

    let entries = store.list_agent_command_allowlist().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].pattern, "git status");
    assert_eq!(entries[0].source_command, "git status --porcelain");
    assert!(!entries[0].created_at.is_empty());
    assert_eq!(entries[0].last_used_at, None);
    assert_eq!(entries[0].use_count, 0);

    store
        .touch_agent_command_allowlist_entry("git status")
        .unwrap();
    store
        .touch_agent_command_allowlist_entry("git status")
        .unwrap();
    // 条目不存在时 touch 静默成功。
    store
        .touch_agent_command_allowlist_entry("missing")
        .unwrap();

    let touched = store.list_agent_command_allowlist().unwrap();
    assert_eq!(touched.len(), 1);
    assert_eq!(touched[0].use_count, 2);
    assert!(touched[0]
        .last_used_at
        .as_deref()
        .is_some_and(|value| !value.is_empty()));

    // 同 pattern 重复保存不覆盖原记录(来源命令与统计保持不变)。
    store
        .save_agent_command_allowlist_entry("git status", "git status -sb")
        .unwrap();
    let kept = store.list_agent_command_allowlist().unwrap();
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].source_command, "git status --porcelain");
    assert_eq!(kept[0].use_count, 2);

    assert!(store
        .delete_agent_command_allowlist_entry("git status")
        .unwrap());
    assert!(!store
        .delete_agent_command_allowlist_entry("git status")
        .unwrap());
    assert!(store.list_agent_command_allowlist().unwrap().is_empty());
}

#[test]
fn sqlite_store_saves_compound_allowlist_entries_as_one_batch() {
    let store = SqliteConfigStore::new(temp_db_path("agent-allowlist-batch"));
    let patterns = vec!["ps".to_string(), "grep".to_string(), "head".to_string()];

    store
        .save_agent_command_allowlist_entries(
            &patterns
                .iter()
                .map(|p| (p.clone(), "ps | grep | head".to_string()))
                .collect::<Vec<_>>(),
        )
        .unwrap();

    let entries = store.list_agent_command_allowlist().unwrap();
    assert_eq!(entries.len(), 3);
    assert!(entries
        .iter()
        .all(|entry| entry.source_command == "ps | grep | head"));
}

#[test]
fn workspace_models_keep_camel_case_contract_and_legacy_defaults() {
    // 旧前端数据不带 aiMode / payloadJson,反序列化取默认值而不报错。
    let legacy_session: WorkspaceSession = serde_json::from_str(
        r#"{
            "id": "conversation-1",
            "connectionId": "local",
            "name": "旧版会话",
            "summary": "",
            "createdAt": "2026-07-02T09:00:00Z",
            "updatedAt": "2026-07-02T09:00:00Z"
        }"#,
    )
    .unwrap();
    assert_eq!(legacy_session.ai_mode, "chat");

    let legacy_message: AiConversationMessage = serde_json::from_str(
        r#"{
            "id": "ai-1",
            "connectionId": "local",
            "workspaceSessionId": "conversation-1",
            "terminalId": "terminal-1",
            "role": "assistant",
            "text": "ok",
            "command": null,
            "error": false,
            "createdAt": "2026-07-02T09:00:01Z"
        }"#,
    )
    .unwrap();
    assert_eq!(legacy_message.payload_json, "");

    // 序列化字段名与前端 types/agent.ts、types/workspace.ts 的 camelCase 契约一致。
    let session_json = serde_json::to_value(&legacy_session).unwrap();
    assert_eq!(session_json["aiMode"], "chat");

    let message_json = serde_json::to_value(&legacy_message).unwrap();
    assert_eq!(message_json["payloadJson"], "");

    let entry = ai_term_lib::domain::workspace::AgentCommandAllowlistEntry {
        pattern: "git status".into(),
        source_command: "git status --porcelain".into(),
        created_at: "2026-07-02T09:00:00Z".into(),
        last_used_at: None,
        use_count: 0,
    };
    let entry_json = serde_json::to_value(&entry).unwrap();
    assert_eq!(entry_json["pattern"], "git status");
    assert_eq!(entry_json["sourceCommand"], "git status --porcelain");
    assert_eq!(entry_json["createdAt"], "2026-07-02T09:00:00Z");
    assert_eq!(entry_json["useCount"], 0);
    // 从未命中时 lastUsedAt 不序列化,匹配前端可选字段语义。
    assert!(entry_json.get("lastUsedAt").is_none());
}
