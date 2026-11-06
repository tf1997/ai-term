use ai_term_lib::app::state::AppState;
use ai_term_lib::domain::connection::models::{
    AuthEndpoint, AuthMode, ConnectionProfile, ConnectionRole, FileTransferMode, JumpMode,
};
use ai_term_lib::domain::storage::sqlite::SqliteConfigStore;

fn endpoint(host: &str, username: &str) -> AuthEndpoint {
    AuthEndpoint {
        host: host.into(),
        port: Some(22),
        username: username.into(),
        auth_mode: AuthMode::Auto,
        credential_ref: None,
        password: None,
    }
}

fn profile(id: &str, name: &str) -> ConnectionProfile {
    ConnectionProfile {
        id: id.into(),
        name: name.into(),
        connection_role: ConnectionRole::Direct,
        gateway: endpoint("ssh.company.com", "company.user"),
        target: endpoint("10.12.8.21", "app"),
        jump_mode: JumpMode::InteractiveMenu,
        menu_profile_id: "company-default".into(),
        file_transfer_mode: FileTransferMode::Auto,
        shell_integration: true,
    }
}

fn state(name: &str) -> AppState {
    let path = std::env::temp_dir().join(format!(
        "ai-term-state-{name}-{}.sqlite3",
        uuid::Uuid::new_v4()
    ));
    AppState::with_profile_store(SqliteConfigStore::new(path.to_string_lossy()))
}

#[tokio::test]
async fn saved_connection_profile_can_be_listed() {
    let state = state("profiles-list");

    state
        .save_connection_profile(profile("prod-1", "prod-1"))
        .await
        .unwrap();

    assert_eq!(
        state.list_connection_profiles().await.unwrap(),
        vec![profile("prod-1", "prod-1")]
    );
}

#[tokio::test]
async fn saving_existing_connection_profile_updates_it() {
    let state = state("profiles-update");

    state
        .save_connection_profile(profile("prod-1", "prod-1"))
        .await
        .unwrap();
    state
        .save_connection_profile(profile("prod-1", "prod-renamed"))
        .await
        .unwrap();

    assert_eq!(
        state.list_connection_profiles().await.unwrap(),
        vec![profile("prod-1", "prod-renamed")]
    );
}

#[tokio::test]
async fn saved_connection_profile_can_be_loaded_by_id() {
    let state = state("state-profile-get");

    state
        .save_connection_profile(profile("prod-1", "prod-1"))
        .await
        .unwrap();

    assert_eq!(
        state
            .get_connection_profile("prod-1")
            .await
            .unwrap()
            .unwrap(),
        profile("prod-1", "prod-1")
    );
}

#[tokio::test]
async fn profile_edits_and_deletion_invalidate_outstanding_intents() {
    use ai_term_lib::domain::command_policy::OperationKind;
    use ai_term_lib::domain::terminal::ssh::TerminalSession;
    struct NoWriteTerminal;
    impl TerminalSession for NoWriteTerminal {
        fn write(&mut self, _: &[u8]) -> anyhow::Result<()> {
            panic!("stale intent reached terminal");
        }
        fn resize(&mut self, _: u16, _: u16) -> anyhow::Result<()> {
            Ok(())
        }
    }
    let state = state("profile-intent-invalidation");
    state
        .save_connection_profile(profile("profile", "old"))
        .await
        .unwrap();
    state
        .register_terminal_session(
            "session".into(),
            "profile".into(),
            Box::new(NoWriteTerminal),
        )
        .await;
    let target = state.command_execution_target("session").await.unwrap();
    let intent = state
        .analyze_command_intent(target.clone(), "ls".into(), OperationKind::Command)
        .await
        .unwrap();
    state
        .approve_command_intent(&intent.reference, &intent.source)
        .await
        .unwrap();
    state
        .save_connection_profile(profile("profile", "changed"))
        .await
        .unwrap();
    assert!(state
        .dispatch_command_intent(&intent.reference)
        .await
        .is_err());
    let changed = state.command_execution_target("session").await.unwrap();
    assert!(changed.route_version > target.route_version);
    let intent = state
        .analyze_command_intent(changed, "ls".into(), OperationKind::Command)
        .await
        .unwrap();
    state
        .approve_command_intent(&intent.reference, &intent.source)
        .await
        .unwrap();
    assert!(state.delete_connection_profile("profile").await.unwrap());
    assert!(state
        .dispatch_command_intent(&intent.reference)
        .await
        .is_err());
}
