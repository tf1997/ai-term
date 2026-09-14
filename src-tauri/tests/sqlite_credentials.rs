use ai_term_lib::domain::auth::credentials::{CredentialStore, MemoryCredentialStore};
use ai_term_lib::domain::storage::credentials::SqliteCredentialStore;
use anyhow::{bail, Result};
use rusqlite::Connection;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};

fn temp_db_path() -> String {
    std::env::temp_dir()
        .join(format!(
            "ai-term-credentials-{}.sqlite3",
            uuid::Uuid::new_v4()
        ))
        .to_string_lossy()
        .into_owned()
}

// The old keyring can become available again after an offline save or deletion.
// It deliberately refuses deletion to exercise stale legacy credentials.
struct UnreliableLegacyStore {
    available: AtomicBool,
    reads: AtomicUsize,
}

impl UnreliableLegacyStore {
    fn new(available: bool) -> Self {
        Self {
            available: AtomicBool::new(available),
            reads: AtomicUsize::new(0),
        }
    }
}

impl CredentialStore for UnreliableLegacyStore {
    fn set_secret(&self, _key: &str, _value: &str) -> Result<()> {
        panic!("new passwords must not be written to the legacy keyring")
    }

    fn get_secret(&self, _key: &str) -> Result<Option<String>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        if self.available.load(Ordering::SeqCst) {
            Ok(Some("old-keyring-password".into()))
        } else {
            bail!("system credential helper is unavailable")
        }
    }

    fn delete_secret(&self, _key: &str) -> Result<()> {
        bail!("system credential helper cannot delete this entry")
    }
}

#[test]
fn imports_legacy_credentials_and_can_reopen_without_the_keyring() {
    let path = temp_db_path();
    let legacy = Arc::new(MemoryCredentialStore::default());
    legacy.set_secret("existing", "legacy-password").unwrap();
    let store = SqliteCredentialStore::new(&path).with_legacy_store(legacy.clone());

    assert_eq!(
        store.get_secret("existing").unwrap().as_deref(),
        Some("legacy-password")
    );
    assert_eq!(legacy.get_secret("existing").unwrap(), None);
    drop(store);

    let reopened = SqliteCredentialStore::new(path);
    assert_eq!(
        reopened.get_secret("existing").unwrap().as_deref(),
        Some("legacy-password")
    );
}

#[test]
fn unavailable_keyring_does_not_block_saving_reading_or_deleting_passwords() {
    let path = temp_db_path();
    let legacy = Arc::new(UnreliableLegacyStore::new(false));
    let store = SqliteCredentialStore::new(&path).with_legacy_store(legacy.clone());
    assert_eq!(store.get_secret("missing-legacy-password").unwrap(), None);

    let password = "  p'ass\"word;密碼\nwith whitespace  ";
    store.set_secret("saved", password).unwrap();
    assert_eq!(
        store.get_secret("saved").unwrap().as_deref(),
        Some(password)
    );
    assert_eq!(legacy.reads.load(Ordering::SeqCst), 1);
    drop(store);

    let reopened = SqliteCredentialStore::new(&path).with_legacy_store(legacy.clone());
    assert_eq!(
        reopened.get_secret("saved").unwrap().as_deref(),
        Some(password)
    );
    reopened.delete_secret("saved").unwrap();
    reopened.delete_secret("missing-legacy-password").unwrap();
    reopened.delete_secret("saved").unwrap();

    // Restoring the keyring must not resurrect an explicitly deleted password.
    legacy.available.store(true, Ordering::SeqCst);
    drop(reopened);
    let reopened = SqliteCredentialStore::new(path).with_legacy_store(legacy.clone());
    assert_eq!(reopened.get_secret("saved").unwrap(), None);
    assert_eq!(
        reopened.get_secret("missing-legacy-password").unwrap(),
        None
    );
    assert_eq!(legacy.reads.load(Ordering::SeqCst), 1);
}

#[test]
fn deleted_migrated_password_stays_deleted_when_legacy_cleanup_fails() {
    let path = temp_db_path();
    let legacy = Arc::new(UnreliableLegacyStore::new(true));
    let store = SqliteCredentialStore::new(&path).with_legacy_store(legacy.clone());
    assert_eq!(
        store.get_secret("existing").unwrap().as_deref(),
        Some("old-keyring-password")
    );
    store.delete_secret("existing").unwrap();
    drop(store);

    let reopened = SqliteCredentialStore::new(path).with_legacy_store(legacy.clone());
    assert_eq!(reopened.get_secret("existing").unwrap(), None);
    assert_eq!(legacy.reads.load(Ordering::SeqCst), 1);
    reopened.set_secret("existing", "new-password").unwrap();
    assert_eq!(
        reopened.get_secret("existing").unwrap().as_deref(),
        Some("new-password")
    );
    assert_eq!(legacy.reads.load(Ordering::SeqCst), 1);
}

#[test]
fn failed_database_migration_keeps_the_legacy_password() {
    let path = temp_db_path();
    let legacy = Arc::new(MemoryCredentialStore::default());
    legacy.set_secret("existing", "legacy-password").unwrap();
    let store = SqliteCredentialStore::new(&path).with_legacy_store(legacy.clone());
    store.set_secret("initialize", "password").unwrap();
    let connection = Connection::open(path).unwrap();
    connection
        .execute_batch(
            "CREATE TRIGGER fail_credential_write BEFORE INSERT ON credentials
             BEGIN SELECT RAISE(ABORT, 'database write failed'); END;",
        )
        .unwrap();

    assert!(store.get_secret("existing").is_err());
    assert_eq!(
        legacy.get_secret("existing").unwrap().as_deref(),
        Some("legacy-password")
    );
}

struct ConcurrentLegacyStore {
    database_path: String,
    replacement: Option<&'static str>,
}

impl CredentialStore for ConcurrentLegacyStore {
    fn set_secret(&self, _key: &str, _value: &str) -> Result<()> {
        unreachable!()
    }

    fn get_secret(&self, key: &str) -> Result<Option<String>> {
        // A second database connection saves/deletes while a legacy read is pending.
        let other_store = SqliteCredentialStore::new(&self.database_path);
        if let Some(value) = self.replacement {
            other_store.set_secret(key, value)?;
        } else {
            other_store.delete_secret(key)?;
        }
        Ok(Some("stale-legacy-password".into()))
    }

    fn delete_secret(&self, _key: &str) -> Result<()> {
        Ok(())
    }
}

#[test]
fn legacy_migration_cannot_overwrite_a_concurrent_database_save_or_deletion() {
    for replacement in [Some("new-password"), None] {
        let path = temp_db_path();
        let legacy = Arc::new(ConcurrentLegacyStore {
            database_path: path.clone(),
            replacement,
        });
        let store = SqliteCredentialStore::new(&path).with_legacy_store(legacy);
        assert_eq!(
            store.get_secret("existing").unwrap().as_deref(),
            replacement
        );
        drop(store);
        assert_eq!(
            SqliteCredentialStore::new(path)
                .get_secret("existing")
                .unwrap()
                .as_deref(),
            replacement
        );
    }
}

#[cfg(unix)]
#[test]
fn credential_database_and_existing_wal_files_are_only_accessible_by_the_owner() {
    use std::os::unix::fs::PermissionsExt;

    let path = temp_db_path();
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch("PRAGMA journal_mode = WAL; CREATE TABLE existing_config (id TEXT);")
        .unwrap();
    for suffix in ["", "-wal", "-shm"] {
        std::fs::set_permissions(
            format!("{path}{suffix}"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
    }

    let store = SqliteCredentialStore::new(&path);
    store.set_secret("saved", "password").unwrap();
    for suffix in ["", "-wal", "-shm"] {
        let permissions = std::fs::metadata(format!("{path}{suffix}"))
            .unwrap()
            .permissions();
        assert_eq!(permissions.mode() & 0o777, 0o600);
    }
}
