use ai_term_lib::domain::auth::credentials::{CredentialStore, MemoryCredentialStore};
use ai_term_lib::domain::connection::models::{
    AuthEndpoint, AuthMode, ConnectionProfile, ConnectionRole, FileTransferMode, JumpMode,
};
use ai_term_lib::domain::storage::sqlite::SqliteConfigStore;
use rusqlite::Connection;
use std::sync::Arc;

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
        connection_role: ConnectionRole::Direct,
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
fn sqlite_store_roundtrips_bastion_connection_role() {
    let store = SqliteConfigStore::new(temp_db_path("profiles-bastion-role"));
    store.initialize().unwrap();

    let mut bastion = profile("bastion-prod-1", "bastion-prod-1");
    bastion.connection_role = ConnectionRole::Bastion;

    store.save_connection_profile(&bastion).unwrap();

    assert_eq!(store.list_connection_profiles().unwrap(), vec![bastion]);
}

#[test]
fn sqlite_store_moves_ssh_passwords_to_credential_store() {
    let credentials = Arc::new(MemoryCredentialStore::default());
    let store = SqliteConfigStore::with_credential_store(
        temp_db_path("profiles-passwords"),
        credentials.clone(),
    );
    store.initialize().unwrap();

    let mut password_profile = profile("prod-password", "prod-password");
    password_profile.gateway.auth_mode = AuthMode::Password;
    password_profile.gateway.password = Some("gateway-secret".into());
    password_profile.target.auth_mode = AuthMode::Password;
    password_profile.target.password = Some("target-secret".into());

    store.save_connection_profile(&password_profile).unwrap();

    let mut expected = password_profile.clone();
    expected.gateway.credential_ref = Some("ssh-profile:prod-password:gateway:password".into());
    expected.target.credential_ref = Some("ssh-profile:prod-password:target:password".into());
    assert_eq!(store.list_connection_profiles().unwrap(), vec![expected]);

    let connection = Connection::open(store.database_path()).unwrap();
    let raw: (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = connection
        .query_row(
            r#"
            SELECT gateway_credential_ref, gateway_password, target_credential_ref, target_password
            FROM connection_profiles
            WHERE id = ?1
            "#,
            ["prod-password"],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();

    let gateway_ref = raw.0.as_deref().unwrap();
    let target_ref = raw.2.as_deref().unwrap();
    assert_eq!(raw.1, None);
    assert_eq!(raw.3, None);
    assert_eq!(
        credentials.get_secret(gateway_ref).unwrap().as_deref(),
        Some("gateway-secret")
    );
    assert_eq!(
        credentials.get_secret(target_ref).unwrap().as_deref(),
        Some("target-secret")
    );
}

#[test]
fn copied_profile_cannot_overwrite_source_profile_password() {
    let credentials = Arc::new(MemoryCredentialStore::default());
    let store = SqliteConfigStore::with_credential_store(
        temp_db_path("profiles-copied-password"),
        credentials,
    );

    let mut source = profile("source", "source");
    source.target.auth_mode = AuthMode::Password;
    source.target.password = Some("source-secret".into());
    store.save_connection_profile(&source).unwrap();

    let mut copied = source.clone();
    copied.id = "copied".into();
    copied.name = "copied".into();
    copied.target.credential_ref = Some("ssh-profile:source:target:password".into());
    copied.target.password = Some("copied-secret".into());
    store.save_connection_profile(&copied).unwrap();

    let profiles = store.list_connection_profiles().unwrap();
    let saved_source = profiles.iter().find(|item| item.id == "source").unwrap();
    let saved_copy = profiles.iter().find(|item| item.id == "copied").unwrap();
    assert_eq!(
        saved_source.target.password.as_deref(),
        Some("source-secret")
    );
    assert_eq!(saved_copy.target.password.as_deref(), Some("copied-secret"));
    assert_eq!(
        saved_copy.target.credential_ref.as_deref(),
        Some("ssh-profile:copied:target:password")
    );
}

#[test]
fn sqlite_store_adds_legacy_secret_columns_to_existing_profiles_table() {
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

    let mut expected = password_profile.clone();
    expected.gateway.credential_ref = Some("ssh-profile:prod-migrated:gateway:password".into());
    expected.target.credential_ref = Some("ssh-profile:prod-migrated:target:password".into());
    assert_eq!(store.list_connection_profiles().unwrap(), vec![expected]);
}

#[test]
fn sqlite_store_migrates_legacy_plaintext_ssh_passwords_on_read() {
    let database_path = temp_db_path("profiles-legacy-plaintext");
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
              gateway_password TEXT,
              target_host TEXT NOT NULL,
              target_port INTEGER,
              target_username TEXT NOT NULL,
              target_auth_mode TEXT NOT NULL,
              target_credential_ref TEXT,
              target_password TEXT,
              jump_mode TEXT NOT NULL,
              menu_profile_id TEXT NOT NULL,
              file_transfer_mode TEXT NOT NULL,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO connection_profiles (
              id,
              name,
              gateway_host,
              gateway_port,
              gateway_username,
              gateway_auth_mode,
              gateway_credential_ref,
              gateway_password,
              target_host,
              target_port,
              target_username,
              target_auth_mode,
              target_credential_ref,
              target_password,
              jump_mode,
              menu_profile_id,
              file_transfer_mode
            ) VALUES (
              'legacy-prod',
              'legacy-prod',
              'ssh.company.com',
              22,
              'company.user',
              'password',
              NULL,
              'gateway-secret',
              '10.12.8.21',
              22,
              'app',
              'password',
              NULL,
              'target-secret',
              'interactive-menu',
              'company-default',
              'auto'
            );
            "#,
        )
        .unwrap();
    drop(connection);

    let credentials = Arc::new(MemoryCredentialStore::default());
    let store = SqliteConfigStore::with_credential_store(database_path, credentials.clone());
    let mut expected = profile("legacy-prod", "legacy-prod");
    expected.gateway.auth_mode = AuthMode::Password;
    expected.gateway.credential_ref = Some("ssh-profile:legacy-prod:gateway:password".into());
    expected.gateway.password = Some("gateway-secret".into());
    expected.target.auth_mode = AuthMode::Password;
    expected.target.credential_ref = Some("ssh-profile:legacy-prod:target:password".into());
    expected.target.password = Some("target-secret".into());

    assert_eq!(store.list_connection_profiles().unwrap(), vec![expected]);

    let connection = Connection::open(store.database_path()).unwrap();
    let raw: (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = connection
        .query_row(
            r#"
            SELECT gateway_credential_ref, gateway_password, target_credential_ref, target_password
            FROM connection_profiles
            WHERE id = ?1
            "#,
            ["legacy-prod"],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();

    assert_eq!(
        raw.0.as_deref(),
        Some("ssh-profile:legacy-prod:gateway:password")
    );
    assert_eq!(raw.1, None);
    assert_eq!(
        raw.2.as_deref(),
        Some("ssh-profile:legacy-prod:target:password")
    );
    assert_eq!(raw.3, None);
    assert_eq!(
        credentials
            .get_secret("ssh-profile:legacy-prod:gateway:password")
            .unwrap()
            .as_deref(),
        Some("gateway-secret")
    );
    assert_eq!(
        credentials
            .get_secret("ssh-profile:legacy-prod:target:password")
            .unwrap()
            .as_deref(),
        Some("target-secret")
    );
}

#[test]
fn database_credentials_persist_ssh_passwords_across_restarts() {
    let database_path = temp_db_path("profiles-database-restart");
    let store = SqliteConfigStore::with_database_credentials(&database_path);
    let mut saved = profile("database-prod", "database-prod");
    saved.gateway.auth_mode = AuthMode::Password;
    saved.gateway.password = Some(" gateway-secret\n".into());
    saved.target.auth_mode = AuthMode::Password;
    saved.target.password = Some("目标-secret\t ".into());
    store.save_connection_profile(&saved).unwrap();
    drop(store);

    saved.gateway.credential_ref = Some("ssh-profile:database-prod:gateway:password".into());
    saved.target.credential_ref = Some("ssh-profile:database-prod:target:password".into());
    let reopened = SqliteConfigStore::with_database_credentials(&database_path);
    assert_eq!(
        reopened.get_connection_profile(&saved.id).unwrap(),
        Some(saved.clone())
    );
    assert_eq!(reopened.list_connection_profiles().unwrap(), vec![saved]);
}

#[test]
fn database_credentials_update_passwords_and_preserve_them_when_input_is_blank() {
    let database_path = temp_db_path("profiles-database-update");
    let store = SqliteConfigStore::with_database_credentials(&database_path);
    let mut saved = profile("database-update", "before-update");
    saved.gateway.password = Some("gateway-original".into());
    saved.target.password = Some("target-original".into());
    store.save_connection_profile(&saved).unwrap();

    let mut updated = store.get_connection_profile(&saved.id).unwrap().unwrap();
    updated.name = "after-update".into();
    updated.gateway.password = Some("gateway-updated".into());
    updated.target.password = Some("target-updated".into());
    store.save_connection_profile(&updated).unwrap();

    let mut blank_input = updated.clone();
    blank_input.gateway.password = None;
    blank_input.target.password = Some(" \t\r\n".into());
    store.save_connection_profile(&blank_input).unwrap();
    drop(store);

    let reopened = SqliteConfigStore::with_database_credentials(database_path);
    assert_eq!(
        reopened.get_connection_profile(&updated.id).unwrap(),
        Some(updated)
    );
}

#[test]
fn database_credentials_keep_copied_profile_passwords_independent() {
    let database_path = temp_db_path("profiles-database-copy");
    let store = SqliteConfigStore::with_database_credentials(&database_path);
    let mut source = profile("database-source", "database-source");
    source.gateway.password = Some("gateway-source".into());
    source.target.password = Some("target-source".into());
    store.save_connection_profile(&source).unwrap();
    let source = store.get_connection_profile(&source.id).unwrap().unwrap();

    let mut copied = source.clone();
    copied.id = "database-copy".into();
    copied.name = "database-copy".into();
    copied.gateway.password = Some("gateway-copy".into());
    copied.target.password = Some("target-copy".into());
    store.save_connection_profile(&copied).unwrap();
    drop(store);

    copied.gateway.credential_ref = Some("ssh-profile:database-copy:gateway:password".into());
    copied.target.credential_ref = Some("ssh-profile:database-copy:target:password".into());
    let reopened = SqliteConfigStore::with_database_credentials(database_path);
    assert_eq!(
        reopened.get_connection_profile(&copied.id).unwrap(),
        Some(copied.clone())
    );
    assert_eq!(
        reopened.get_connection_profile(&source.id).unwrap(),
        Some(source.clone())
    );
    assert!(reopened.delete_connection_profile(&copied.id).unwrap());
    assert_eq!(
        reopened.get_connection_profile(&source.id).unwrap(),
        Some(source)
    );
}

#[test]
fn database_credentials_delete_both_ssh_passwords() {
    let database_path = temp_db_path("profiles-database-delete");
    let store = SqliteConfigStore::with_database_credentials(&database_path);
    let mut saved = profile("database-delete", "database-delete");
    saved.gateway.password = Some("gateway-delete".into());
    saved.target.password = Some("target-delete".into());
    store.save_connection_profile(&saved).unwrap();
    drop(store);

    let reopened = SqliteConfigStore::with_database_credentials(&database_path);
    assert!(reopened.delete_connection_profile(&saved.id).unwrap());
    assert!(!reopened.delete_connection_profile(&saved.id).unwrap());
    drop(reopened);

    let connection = Connection::open(&database_path).unwrap();
    let password_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM credentials WHERE value IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(password_count, 0);
    drop(connection);

    let reopened = SqliteConfigStore::with_database_credentials(database_path);
    assert!(reopened.list_connection_profiles().unwrap().is_empty());
}

#[test]
fn database_credentials_migrate_legacy_ssh_passwords_and_preserve_them_after_restart() {
    let database_path = temp_db_path("profiles-database-legacy");
    let store = SqliteConfigStore::with_database_credentials(&database_path);
    let mut expected = profile("database-legacy", "database-legacy");
    expected.gateway.auth_mode = AuthMode::Password;
    expected.target.auth_mode = AuthMode::Password;
    store.save_connection_profile(&expected).unwrap();

    let connection = Connection::open(&database_path).unwrap();
    connection
        .execute(
            "UPDATE connection_profiles SET gateway_password = ?1, target_password = ?2 WHERE id = ?3",
            ["gateway-legacy", "target-legacy", &expected.id],
        )
        .unwrap();
    drop(connection);

    expected.gateway.password = Some("gateway-legacy".into());
    expected.gateway.credential_ref = Some("ssh-profile:database-legacy:gateway:password".into());
    expected.target.password = Some("target-legacy".into());
    expected.target.credential_ref = Some("ssh-profile:database-legacy:target:password".into());
    assert_eq!(
        store.list_connection_profiles().unwrap(),
        vec![expected.clone()]
    );
    drop(store);

    let connection = Connection::open(&database_path).unwrap();
    let legacy_passwords: (Option<String>, Option<String>) = connection
        .query_row(
            "SELECT gateway_password, target_password FROM connection_profiles WHERE id = ?1",
            [&expected.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(legacy_passwords, (None, None));
    drop(connection);

    let reopened = SqliteConfigStore::with_database_credentials(database_path);
    assert_eq!(
        reopened.get_connection_profile(&expected.id).unwrap(),
        Some(expected)
    );
}

#[cfg(all(unix, not(target_os = "macos")))]
#[test]
fn platform_credentials_store_ssh_passwords_in_database_on_unix() {
    let database_path = temp_db_path("profiles-platform-credentials");
    let store = SqliteConfigStore::with_platform_credentials(&database_path);
    let mut saved = profile("platform-password", "platform-password");
    saved.gateway.password = Some("platform-gateway-secret".into());
    saved.target.password = Some("platform-target-secret".into());
    store.save_connection_profile(&saved).unwrap();
    drop(store);

    saved.gateway.credential_ref = Some("ssh-profile:platform-password:gateway:password".into());
    saved.target.credential_ref = Some("ssh-profile:platform-password:target:password".into());
    let reopened = SqliteConfigStore::with_database_credentials(database_path);
    assert_eq!(
        reopened.get_connection_profile(&saved.id).unwrap(),
        Some(saved)
    );
}
