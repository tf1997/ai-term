use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    fmt,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use crate::domain::auth::credentials::{validate_key, CredentialStore};

/// Persistent credentials in the application's SQLite database.
///
/// This uses its own connection: SqliteConfigStore holds its connection mutex
/// while calling CredentialStore, so sharing that mutex would deadlock.
pub struct SqliteCredentialStore {
    database_path: String,
    connection: Mutex<Option<Connection>>,
    legacy_store: Option<Arc<dyn CredentialStore>>,
}

impl fmt::Debug for SqliteCredentialStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SqliteCredentialStore")
            .field("database_path", &self.database_path)
            .finish_non_exhaustive()
    }
}

impl SqliteCredentialStore {
    pub fn new(database_path: impl Into<String>) -> Self {
        Self {
            database_path: database_path.into(),
            connection: Mutex::new(None),
            legacy_store: None,
        }
    }

    /// Import existing system credentials on demand. New writes only use SQLite.
    pub fn with_legacy_store(mut self, legacy_store: Arc<dyn CredentialStore>) -> Self {
        self.legacy_store = Some(legacy_store);
        self
    }

    fn with_connection<T>(&self, operation: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let mut guard = self
            .connection
            .lock()
            .expect("sqlite credential store mutex poisoned");
        if guard.is_none() {
            if let Some(parent) = Path::new(&self.database_path)
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
            {
                std::fs::create_dir_all(parent)?;
            }
            let connection = Connection::open(&self.database_path)
                .context("failed to open SQLite credential storage")?;
            connection.busy_timeout(Duration::from_secs(5))?;
            connection.execute_batch(
                "PRAGMA journal_mode = WAL;\n                 PRAGMA synchronous = NORMAL;",
            )?;
            #[cfg(unix)]
            restrict_database_permissions(&self.database_path)?;
            connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS credentials (
                    key TEXT PRIMARY KEY NOT NULL,
                    value TEXT
                );",
            )?;
            *guard = Some(connection);
        }
        operation(guard.as_ref().expect("credential connection initialized"))
    }
}

impl CredentialStore for SqliteCredentialStore {
    fn set_secret(&self, key: &str, value: &str) -> Result<()> {
        let key = validate_key(key)?;
        self.with_connection(|connection| {
            connection.execute(
                "INSERT INTO credentials (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )?;
            Ok(())
        })
    }

    fn get_secret(&self, key: &str) -> Result<Option<String>> {
        let key = validate_key(key)?;
        self.with_connection(|connection| {
            if let Some(value) = stored_value(connection, key)? {
                return Ok(value);
            }

            // Older Linux versions used secret-tool. A missing helper, locked
            // keyring, or unavailable desktop service must not block profiles.
            let Some(legacy_store) = &self.legacy_store else {
                return Ok(None);
            };
            let Ok(Some(value)) = legacy_store.get_secret(key) else {
                return Ok(None);
            };
            // A concurrent save/delete is authoritative over the legacy value.
            connection.execute(
                "INSERT INTO credentials (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO NOTHING",
                params![key, value],
            )?;
            let _ = legacy_store.delete_secret(key);
            Ok(stored_value(connection, key)?.flatten())
        })
    }

    fn delete_secret(&self, key: &str) -> Result<()> {
        let key = validate_key(key)?;
        self.with_connection(|connection| {
            // Keep an empty entry so an unavailable legacy keyring cannot
            // restore a deleted password when it becomes available again.
            connection.execute(
                "INSERT INTO credentials (key, value) VALUES (?1, NULL)
                 ON CONFLICT(key) DO UPDATE SET value = NULL",
                [key],
            )?;
            if let Some(legacy_store) = &self.legacy_store {
                let _ = legacy_store.delete_secret(key);
            }
            Ok(())
        })
    }
}

fn stored_value(connection: &Connection, key: &str) -> Result<Option<Option<String>>> {
    connection
        .query_row(
            "SELECT value FROM credentials WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .optional()
        .map_err(Into::into)
}

#[cfg(unix)]
fn restrict_database_permissions(database_path: &str) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    if database_path == ":memory:" {
        return Ok(());
    }
    // WAL and shared-memory files may already exist from the config connection.
    for suffix in ["", "-wal", "-shm"] {
        let path = format!("{database_path}{suffix}");
        match std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && !suffix.is_empty() => {}
            Err(error) => {
                return Err(error).context("failed to restrict SQLite credential file permissions")
            }
        }
    }
    Ok(())
}
