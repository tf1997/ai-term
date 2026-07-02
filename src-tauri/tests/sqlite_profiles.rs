use ai_term_lib::domain::connection::models::{
    AuthEndpoint, AuthMode, ConnectionProfile, FileTransferMode, JumpMode,
};
use ai_term_lib::domain::storage::sqlite::SqliteConfigStore;
use rusqlite::Connection;

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

fn temp_db_path(name: &str) -> String {
    let path =
        std::env::temp_dir().join(format!("ai-term-{name}-{}.sqlite3", uuid::Uuid::new_v4()));
    path.to_string_lossy().into_owned()
}

#[test]
fn sqlite_store_saves_and_lists_connection_profiles() {
    let store = SqliteConfigStore::new(temp_db_path("profiles-list"));
    store.initialize().unwrap();

    store
        .save_connection_profile(&profile("prod-1", "prod-1"))
        .unwrap();

    assert_eq!(
        store.list_connection_profiles().unwrap(),
        vec![profile("prod-1", "prod-1")]
    );
}

#[test]
fn sqlite_store_updates_existing_connection_profile() {
    let store = SqliteConfigStore::new(temp_db_path("profiles-update"));
    store.initialize().unwrap();

    store
        .save_connection_profile(&profile("prod-1", "prod-1"))
        .unwrap();
    store
        .save_connection_profile(&profile("prod-1", "prod-renamed"))
        .unwrap();

    assert_eq!(
        store.list_connection_profiles().unwrap(),
        vec![profile("prod-1", "prod-renamed")]
    );
}

#[test]
fn sqlite_store_deletes_connection_profiles() {
    let store = SqliteConfigStore::new(temp_db_path("profiles-delete"));
    let saved = profile("prod-1", "prod-1");

    store.save_connection_profile(&saved).unwrap();

    assert!(store.delete_connection_profile("prod-1").unwrap());
    assert!(!store.delete_connection_profile("missing").unwrap());
    assert!(store.list_connection_profiles().unwrap().is_empty());
}

#[test]
fn sqlite_store_roundtrips_direct_connection_profiles() {
    let store = SqliteConfigStore::new(temp_db_path("profiles-direct"));
    store.initialize().unwrap();

    let direct = ConnectionProfile {
        id: "direct-prod-1".into(),
        name: "direct-prod-1".into(),
        gateway: endpoint("", ""),
        target: endpoint("10.12.8.21", "app"),
        jump_mode: JumpMode::Direct,
        menu_profile_id: "".into(),
        file_transfer_mode: FileTransferMode::SftpDirect,
    };

    store.save_connection_profile(&direct).unwrap();

    assert_eq!(store.list_connection_profiles().unwrap(), vec![direct]);
}

#[test]
fn sqlite_store_roundtrips_plaintext_ssh_passwords() {
    let store = SqliteConfigStore::new(temp_db_path("profiles-passwords"));
    store.initialize().unwrap();

    let mut password_profile = profile("prod-password", "prod-password");
    password_profile.gateway.auth_mode = AuthMode::Password;
    password_profile.gateway.password = Some("gateway-secret".into());
    password_profile.target.auth_mode = AuthMode::Password;
    password_profile.target.password = Some("target-secret".into());

    store.save_connection_profile(&password_profile).unwrap();

    assert_eq!(
        store.list_connection_profiles().unwrap(),
        vec![password_profile]
    );
}

#[test]
fn sqlite_store_migrates_existing_profiles_table_for_plaintext_passwords() {
    let database_path = temp_db_path("profiles-password-migration");
    let connection = Connection::open(&database_path).unwrap();
    connection
        .execute_batch(
            r#"
            CREATE TABLE connection_profiles (
              id TEXT PRIMARY KEY NOT NULL,
              name TEXT NOT NULL,
              gateway_host TEXT NOT NULL,
              gateway_port INTEGER NOT NULL DEFAULT 22,
              gateway_username TEXT NOT NULL,
              gateway_auth_mode TEXT NOT NULL,
              gateway_credential_ref TEXT,
              target_host TEXT NOT NULL,
              target_port INTEGER,
              target_username TEXT NOT NULL,
              target_auth_mode TEXT NOT NULL,
              target_credential_ref TEXT,
              jump_mode TEXT NOT NULL,
              menu_profile_id TEXT NOT NULL,
              file_transfer_mode TEXT NOT NULL,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            "#,
        )
        .unwrap();
    drop(connection);

    let store = SqliteConfigStore::new(database_path);
    let mut password_profile = profile("prod-migrated", "prod-migrated");
    password_profile.gateway.password = Some("gateway-secret".into());
    password_profile.target.password = Some("target-secret".into());

    store.save_connection_profile(&password_profile).unwrap();

    assert_eq!(
        store.list_connection_profiles().unwrap(),
        vec![password_profile]
    );
}
