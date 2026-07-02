use ai_term_lib::app::state::AppState;
use ai_term_lib::domain::connection::models::{
    AuthEndpoint, AuthMode, ConnectionProfile, FileTransferMode, JumpMode,
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
        gateway: endpoint("ssh.company.com", "company.user"),
        target: endpoint("10.12.8.21", "app"),
        jump_mode: JumpMode::InteractiveMenu,
        menu_profile_id: "company-default".into(),
        file_transfer_mode: FileTransferMode::Auto,
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
