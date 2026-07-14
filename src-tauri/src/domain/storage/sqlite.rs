use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use std::{fmt, path::Path, sync::Arc};

use crate::domain::auth::credentials::{
    CredentialStore, MemoryCredentialStore, SystemCredentialStore,
};
use crate::domain::connection::models::{
    AiProviderConfig, AiProviderType, AuthEndpoint, AuthMode, ConnectionProfile, ConnectionRole,
    ContextPolicy, FileTransferMode, JumpMode,
};
use crate::domain::workspace::{
    AiConversationMessage, AiMessageRole, CommandHistoryRecord, UpdateScript, WorkspaceSession,
};

pub const SCHEMA: &str = include_str!("schema.sql");
const COMMAND_HISTORY_RETENTION_LIMIT: i64 = 1000;

#[derive(Clone)]
pub struct SqliteConfigStore {
    database_path: String,
    credential_store: Arc<dyn CredentialStore>,
}

impl fmt::Debug for SqliteConfigStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SqliteConfigStore")
            .field("database_path", &self.database_path)
            .finish_non_exhaustive()
    }
}

impl SqliteConfigStore {
    pub fn new(database_path: impl Into<String>) -> Self {
        Self::with_credential_store(database_path, Arc::new(MemoryCredentialStore::default()))
    }

    pub fn with_system_credentials(database_path: impl Into<String>) -> Self {
        Self::with_credential_store(database_path, Arc::new(SystemCredentialStore::new()))
    }

    pub fn with_credential_store(
        database_path: impl Into<String>,
        credential_store: Arc<dyn CredentialStore>,
    ) -> Self {
        Self {
            database_path: database_path.into(),
            credential_store,
        }
    }

    pub fn database_path(&self) -> &str {
        &self.database_path
    }

    pub fn initialize(&self) -> Result<()> {
        let connection = self.connection()?;
        connection.execute_batch(SCHEMA)?;
        migrate_connection_profiles(&connection)?;
        migrate_ai_provider_configs(&connection)?;
        migrate_command_history(&connection)?;
        migrate_ai_conversation_messages(&connection)?;
        migrate_update_scripts(&connection)?;
        Ok(())
    }

    pub fn save_connection_profile(&self, profile: &ConnectionProfile) -> Result<()> {
        self.initialize()?;
        let connection = self.connection()?;
        let stored = self.prepare_connection_profile_for_storage(profile)?;
        connection.execute(
            r#"
            INSERT INTO connection_profiles (
              id,
              name,
              connection_role,
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
              file_transfer_mode,
              updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              connection_role = excluded.connection_role,
              gateway_host = excluded.gateway_host,
              gateway_port = excluded.gateway_port,
              gateway_username = excluded.gateway_username,
              gateway_auth_mode = excluded.gateway_auth_mode,
              gateway_credential_ref = excluded.gateway_credential_ref,
              gateway_password = excluded.gateway_password,
              target_host = excluded.target_host,
              target_port = excluded.target_port,
              target_username = excluded.target_username,
              target_auth_mode = excluded.target_auth_mode,
              target_credential_ref = excluded.target_credential_ref,
              target_password = excluded.target_password,
              jump_mode = excluded.jump_mode,
              menu_profile_id = excluded.menu_profile_id,
              file_transfer_mode = excluded.file_transfer_mode,
              updated_at = CURRENT_TIMESTAMP
            "#,
            params![
                stored.id,
                stored.name,
                connection_role_to_str(&stored.connection_role),
                stored.gateway.host,
                stored.gateway.port.unwrap_or(22),
                stored.gateway.username,
                auth_mode_to_str(&stored.gateway.auth_mode),
                stored.gateway.credential_ref,
                Option::<String>::None,
                stored.target.host,
                stored.target.port,
                stored.target.username,
                auth_mode_to_str(&stored.target.auth_mode),
                stored.target.credential_ref,
                Option::<String>::None,
                jump_mode_to_str(&stored.jump_mode),
                stored.menu_profile_id,
                file_transfer_mode_to_str(&stored.file_transfer_mode),
            ],
        )?;
        Ok(())
    }

    pub fn list_connection_profiles(&self) -> Result<Vec<ConnectionProfile>> {
        self.initialize()?;
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            r#"
            SELECT
              id,
              name,
              connection_role,
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
            FROM connection_profiles
            ORDER BY name ASC, id ASC
            "#,
        )?;

        let rows = statement.query_map([], |row| {
            let connection_role: String = row.get(2)?;
            let gateway_auth_mode: String = row.get(6)?;
            let target_auth_mode: String = row.get(12)?;
            let jump_mode: String = row.get(15)?;
            let file_transfer_mode: String = row.get(17)?;

            Ok(ConnectionProfile {
                id: row.get(0)?,
                name: row.get(1)?,
                connection_role: connection_role_from_str(&connection_role),
                gateway: AuthEndpoint {
                    host: row.get(3)?,
                    port: optional_i64_to_u16(row.get::<_, Option<i64>>(4)?),
                    username: row.get(5)?,
                    auth_mode: auth_mode_from_str(&gateway_auth_mode),
                    credential_ref: row.get(7)?,
                    password: row.get(8)?,
                },
                target: AuthEndpoint {
                    host: row.get(9)?,
                    port: optional_i64_to_u16(row.get::<_, Option<i64>>(10)?),
                    username: row.get(11)?,
                    auth_mode: auth_mode_from_str(&target_auth_mode),
                    credential_ref: row.get(13)?,
                    password: row.get(14)?,
                },
                jump_mode: jump_mode_from_str(&jump_mode),
                menu_profile_id: row.get(16)?,
                file_transfer_mode: file_transfer_mode_from_str(&file_transfer_mode),
            })
        })?;

        let mut profiles = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        for profile in &mut profiles {
            self.hydrate_connection_profile_secrets(&connection, profile)?;
        }
        Ok(profiles)
    }

    pub fn get_connection_profile(&self, id: &str) -> Result<Option<ConnectionProfile>> {
        Ok(self
            .list_connection_profiles()?
            .into_iter()
            .find(|profile| profile.id == id))
    }

    pub fn delete_connection_profile(&self, id: &str) -> Result<bool> {
        self.initialize()?;
        if let Some(profile) = self.get_connection_profile(id)? {
            self.delete_connection_profile_secrets(&profile)?;
        }
        let connection = self.connection()?;
        let deleted = connection.execute("DELETE FROM connection_profiles WHERE id = ?1", [id])?;
        Ok(deleted > 0)
    }

    pub fn save_ai_provider_config(&self, config: &AiProviderConfig) -> Result<()> {
        self.initialize()?;
        let connection = self.connection()?;
        let stored = self.prepare_ai_provider_config_for_storage(config)?;
        connection.execute(
            r#"
            INSERT INTO ai_provider_configs (
              id,
              provider,
              base_url,
              model,
              api_key_ref,
              api_key,
              context_policy,
              system_prompt,
              risk_policy,
              updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
              provider = excluded.provider,
              base_url = excluded.base_url,
              model = excluded.model,
              api_key_ref = excluded.api_key_ref,
              api_key = excluded.api_key,
              context_policy = excluded.context_policy,
              system_prompt = excluded.system_prompt,
              risk_policy = excluded.risk_policy,
              updated_at = CURRENT_TIMESTAMP
            "#,
            params![
                stored.id,
                ai_provider_type_to_str(&stored.provider),
                stored.base_url,
                stored.model,
                stored.api_key_ref,
                Option::<String>::None,
                context_policy_to_str(&stored.context_policy),
                stored.system_prompt,
                stored.risk_policy,
            ],
        )?;
        Ok(())
    }

    pub fn list_ai_provider_configs(&self) -> Result<Vec<AiProviderConfig>> {
        self.initialize()?;
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            r#"
            SELECT
              id,
              provider,
              base_url,
              model,
              api_key_ref,
              api_key,
              context_policy,
              system_prompt,
              risk_policy
            FROM ai_provider_configs
            ORDER BY id ASC
            "#,
        )?;

        let rows = statement.query_map([], |row| {
            let provider: String = row.get(1)?;
            let context_policy: String = row.get(6)?;
            Ok(AiProviderConfig {
                id: row.get(0)?,
                provider: ai_provider_type_from_str(&provider),
                base_url: row.get(2)?,
                model: row.get(3)?,
                api_key_ref: row.get(4)?,
                api_key: row.get(5)?,
                context_policy: context_policy_from_str(&context_policy),
                system_prompt: row.get(7)?,
                risk_policy: row.get(8)?,
            })
        })?;

        let mut configs = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        for config in &mut configs {
            self.hydrate_ai_provider_config_secret(&connection, config)?;
        }
        Ok(configs)
    }

    pub fn get_ai_provider_config(&self, id: &str) -> Result<Option<AiProviderConfig>> {
        Ok(self
            .list_ai_provider_configs()?
            .into_iter()
            .find(|config| config.id == id))
    }

    pub fn delete_ai_provider_config(&self, id: &str) -> Result<bool> {
        self.initialize()?;
        if let Some(config) = self.get_ai_provider_config(id)? {
            self.delete_ai_provider_config_secret(&config)?;
        }
        let connection = self.connection()?;
        let deleted = connection.execute("DELETE FROM ai_provider_configs WHERE id = ?1", [id])?;
        Ok(deleted > 0)
    }

    pub fn save_workspace_session(&self, session: &WorkspaceSession) -> Result<()> {
        self.initialize()?;
        let connection = self.connection()?;
        connection.execute(
            r#"
            INSERT INTO workspace_sessions (
              id,
              connection_id,
              name,
              summary,
              created_at,
              updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(id) DO UPDATE SET
              connection_id = excluded.connection_id,
              name = excluded.name,
              summary = excluded.summary,
              updated_at = excluded.updated_at
            "#,
            params![
                session.id,
                session.connection_id,
                session.name,
                session.summary,
                session.created_at,
                session.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn list_workspace_sessions(&self) -> Result<Vec<WorkspaceSession>> {
        self.initialize()?;
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            r#"
            SELECT sessions.id, sessions.connection_id, sessions.name, sessions.summary, sessions.created_at, sessions.updated_at
            FROM workspace_sessions AS sessions
            WHERE EXISTS (
              SELECT 1
              FROM ai_conversation_messages AS messages
              WHERE messages.workspace_session_id = sessions.id
            )
            ORDER BY sessions.updated_at DESC, sessions.created_at DESC, sessions.id DESC
            "#,
        )?;

        let rows = statement.query_map([], |row| {
            Ok(WorkspaceSession {
                id: row.get(0)?,
                connection_id: row.get(1)?,
                name: row.get(2)?,
                summary: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?;

        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn delete_workspace_session(&self, id: &str) -> Result<bool> {
        self.initialize()?;
        let connection = self.connection()?;
        let transaction = connection.unchecked_transaction()?;
        let deleted = transaction.execute("DELETE FROM workspace_sessions WHERE id = ?1", [id])?;
        transaction.execute(
            "DELETE FROM ai_conversation_messages WHERE workspace_session_id = ?1",
            [id],
        )?;
        transaction.commit()?;
        Ok(deleted > 0)
    }

    pub fn save_command_history_record(&self, record: &CommandHistoryRecord) -> Result<()> {
        self.initialize()?;
        let connection = self.connection()?;
        connection.execute(
            r#"
            INSERT INTO command_history (
              id,
              connection_id,
              workspace_session_id,
              terminal_id,
              command,
              created_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(id) DO UPDATE SET
              connection_id = excluded.connection_id,
              workspace_session_id = excluded.workspace_session_id,
              terminal_id = excluded.terminal_id,
              command = excluded.command,
              created_at = excluded.created_at
            "#,
            params![
                record.id,
                record.connection_id,
                record.workspace_session_id,
                record.terminal_id,
                record.command,
                record.created_at,
            ],
        )?;
        Self::prune_command_history(&connection, &record.connection_id)?;
        Ok(())
    }

    fn prune_command_history(connection: &Connection, connection_id: &str) -> Result<()> {
        connection.execute(
            r#"
            DELETE FROM command_history
            WHERE connection_id = ?1
              AND id NOT IN (
                SELECT id
                FROM command_history
                WHERE connection_id = ?1
                ORDER BY created_at DESC, id DESC
                LIMIT ?2
              )
            "#,
            params![connection_id, COMMAND_HISTORY_RETENTION_LIMIT],
        )?;
        Ok(())
    }

    pub fn list_command_history(&self, connection_id: &str) -> Result<Vec<CommandHistoryRecord>> {
        self.initialize()?;
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            r#"
            SELECT id, connection_id, workspace_session_id, terminal_id, command, created_at
            FROM (
              SELECT id, connection_id, workspace_session_id, terminal_id, command, created_at
              FROM command_history
              WHERE connection_id = ?1
              ORDER BY created_at DESC, id DESC
              LIMIT 300
            )
            ORDER BY created_at ASC, id ASC
            "#,
        )?;

        let rows = statement.query_map([connection_id], |row| {
            Ok(CommandHistoryRecord {
                id: row.get(0)?,
                connection_id: row.get(1)?,
                workspace_session_id: row.get(2)?,
                terminal_id: row.get(3)?,
                command: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;

        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn save_ai_conversation_message(&self, message: &AiConversationMessage) -> Result<()> {
        self.initialize()?;
        let connection = self.connection()?;
        connection.execute(
            r#"
            INSERT INTO ai_conversation_messages (
              id,
              connection_id,
              workspace_session_id,
              terminal_id,
              role,
              text,
              command,
              error,
              created_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(id) DO UPDATE SET
              connection_id = excluded.connection_id,
              workspace_session_id = excluded.workspace_session_id,
              terminal_id = excluded.terminal_id,
              role = excluded.role,
              text = excluded.text,
              command = excluded.command,
              error = excluded.error,
              created_at = excluded.created_at
            "#,
            params![
                message.id,
                message.connection_id,
                message.workspace_session_id,
                message.terminal_id,
                ai_message_role_to_str(&message.role),
                message.text,
                normalize_secret(message.command.as_deref()),
                if message.error { 1 } else { 0 },
                message.created_at,
            ],
        )?;
        Ok(())
    }

    pub fn list_ai_conversation_messages(
        &self,
        workspace_session_id: &str,
    ) -> Result<Vec<AiConversationMessage>> {
        self.initialize()?;
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            r#"
            SELECT id, connection_id, workspace_session_id, terminal_id, role, text, command, error, created_at
            FROM (
              SELECT id, connection_id, workspace_session_id, terminal_id, role, text, command, error, created_at
              FROM ai_conversation_messages
              WHERE workspace_session_id = ?1
              ORDER BY created_at DESC, id DESC
              LIMIT 300
            )
            ORDER BY created_at ASC, id ASC
            "#,
        )?;

        let rows = statement.query_map([workspace_session_id], |row| {
            let role: String = row.get(4)?;
            let error: i64 = row.get(7)?;
            Ok(AiConversationMessage {
                id: row.get(0)?,
                connection_id: row.get(1)?,
                workspace_session_id: row.get(2)?,
                terminal_id: row.get(3)?,
                role: ai_message_role_from_str(&role),
                text: row.get(5)?,
                command: row.get(6)?,
                error: error != 0,
                created_at: row.get(8)?,
            })
        })?;

        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn save_update_script(&self, script: &UpdateScript) -> Result<()> {
        self.initialize()?;
        let connection = self.connection()?;
        let source_commands_json = serde_json::to_string(&script.source_commands)?;
        connection.execute(
            r#"
            INSERT INTO update_scripts (
              id,
              connection_id,
              workspace_session_id,
              name,
              description,
              content,
              source_commands_json,
              created_at,
              updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(id) DO UPDATE SET
              connection_id = excluded.connection_id,
              workspace_session_id = excluded.workspace_session_id,
              name = excluded.name,
              description = excluded.description,
              content = excluded.content,
              source_commands_json = excluded.source_commands_json,
              updated_at = excluded.updated_at
            "#,
            params![
                script.id,
                script.connection_id,
                script.workspace_session_id,
                script.name,
                script.description,
                script.content,
                source_commands_json,
                script.created_at,
                script.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn list_update_scripts(&self) -> Result<Vec<UpdateScript>> {
        self.initialize()?;
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            r#"
            SELECT
              id,
              connection_id,
              workspace_session_id,
              name,
              description,
              content,
              source_commands_json,
              created_at,
              updated_at
            FROM update_scripts
            ORDER BY updated_at DESC, created_at DESC, id DESC
            "#,
        )?;

        let rows = statement.query_map([], |row| {
            let source_commands_json: String = row.get(6)?;
            let source_commands =
                serde_json::from_str::<Vec<String>>(&source_commands_json).unwrap_or_default();
            Ok(UpdateScript {
                id: row.get(0)?,
                connection_id: row.get(1)?,
                workspace_session_id: row.get(2)?,
                name: row.get(3)?,
                description: row.get(4)?,
                content: row.get(5)?,
                source_commands,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })?;

        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn get_update_script(&self, id: &str) -> Result<Option<UpdateScript>> {
        self.initialize()?;
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            r#"
            SELECT
              id,
              connection_id,
              workspace_session_id,
              name,
              description,
              content,
              source_commands_json,
              created_at,
              updated_at
            FROM update_scripts
            WHERE id = ?1
            "#,
        )?;

        let mut rows = statement.query_map([id], |row| {
            let source_commands_json: String = row.get(6)?;
            let source_commands =
                serde_json::from_str::<Vec<String>>(&source_commands_json).unwrap_or_default();
            Ok(UpdateScript {
                id: row.get(0)?,
                connection_id: row.get(1)?,
                workspace_session_id: row.get(2)?,
                name: row.get(3)?,
                description: row.get(4)?,
                content: row.get(5)?,
                source_commands,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })?;

        rows.next().transpose().map_err(Into::into)
    }

    pub fn delete_update_script(&self, id: &str) -> Result<bool> {
        self.initialize()?;
        let connection = self.connection()?;
        let deleted = connection.execute("DELETE FROM update_scripts WHERE id = ?1", [id])?;
        Ok(deleted > 0)
    }

    fn prepare_connection_profile_for_storage(
        &self,
        profile: &ConnectionProfile,
    ) -> Result<ConnectionProfile> {
        let mut stored = profile.clone();
        self.prepare_endpoint_for_storage(&profile.id, "gateway", &mut stored.gateway)?;
        self.prepare_endpoint_for_storage(&profile.id, "target", &mut stored.target)?;
        Ok(stored)
    }

    fn prepare_endpoint_for_storage(
        &self,
        profile_id: &str,
        role: &str,
        endpoint: &mut AuthEndpoint,
    ) -> Result<()> {
        if let Some(secret) = normalize_secret(endpoint.password.as_deref()) {
            // A credential belongs to one profile endpoint. A copied profile may
            // carry its source reference, so always derive the key from its own ID.
            let key = connection_secret_ref(profile_id, role);
            self.credential_store
                .set_secret(&key, &secret)
                .with_context(|| {
                    format!("failed to save {role} SSH password to system credentials")
                })?;
            endpoint.credential_ref = Some(key);
        } else {
            endpoint.credential_ref = normalized_optional(endpoint.credential_ref.take());
        }
        endpoint.password = None;
        Ok(())
    }

    fn hydrate_connection_profile_secrets(
        &self,
        connection: &Connection,
        profile: &mut ConnectionProfile,
    ) -> Result<()> {
        self.hydrate_endpoint_secret(
            connection,
            &profile.id,
            "gateway",
            "gateway_credential_ref",
            "gateway_password",
            &mut profile.gateway,
        )?;
        self.hydrate_endpoint_secret(
            connection,
            &profile.id,
            "target",
            "target_credential_ref",
            "target_password",
            &mut profile.target,
        )?;
        Ok(())
    }

    fn hydrate_endpoint_secret(
        &self,
        connection: &Connection,
        profile_id: &str,
        role: &str,
        credential_ref_column: &str,
        password_column: &str,
        endpoint: &mut AuthEndpoint,
    ) -> Result<()> {
        if let Some(secret) = normalize_secret(endpoint.password.as_deref()) {
            let key = connection_secret_ref(profile_id, role);
            self.credential_store
                .set_secret(&key, &secret)
                .with_context(|| {
                    format!("failed to migrate {role} SSH password to system credentials")
                })?;
            connection.execute(
                &format!(
                    "UPDATE connection_profiles SET {credential_ref_column} = ?1, {password_column} = NULL WHERE id = ?2"
                ),
                params![&key, profile_id],
            )?;
            endpoint.credential_ref = Some(key);
            endpoint.password = Some(secret);
            return Ok(());
        }

        endpoint.credential_ref = normalized_optional(endpoint.credential_ref.take());
        if let Some(key) = endpoint.credential_ref.as_deref() {
            endpoint.password = self.credential_store.get_secret(key).with_context(|| {
                format!("failed to read {role} SSH password from system credentials")
            })?;
        } else {
            endpoint.password = None;
        }
        Ok(())
    }

    fn delete_connection_profile_secrets(&self, profile: &ConnectionProfile) -> Result<()> {
        for key in [
            profile.gateway.credential_ref.as_deref(),
            profile.target.credential_ref.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            self.credential_store
                .delete_secret(key)
                .with_context(|| format!("failed to delete SSH credential {key}"))?;
        }
        Ok(())
    }

    fn prepare_ai_provider_config_for_storage(
        &self,
        config: &AiProviderConfig,
    ) -> Result<AiProviderConfig> {
        let mut stored = config.clone();
        if let Some(secret) = normalize_secret(stored.api_key.as_deref()) {
            let key = normalized_string(&stored.api_key_ref)
                .unwrap_or_else(|| ai_provider_secret_ref(&stored.id));
            self.credential_store
                .set_secret(&key, &secret)
                .context("failed to save AI API key to system credentials")?;
            stored.api_key_ref = key;
        } else if let Some(key) = normalized_string(&stored.api_key_ref) {
            stored.api_key_ref = key;
        } else {
            stored.api_key_ref.clear();
        }
        stored.api_key = None;
        Ok(stored)
    }

    fn hydrate_ai_provider_config_secret(
        &self,
        connection: &Connection,
        config: &mut AiProviderConfig,
    ) -> Result<()> {
        if let Some(secret) = normalize_secret(config.api_key.as_deref()) {
            let key = normalized_string(&config.api_key_ref)
                .unwrap_or_else(|| ai_provider_secret_ref(&config.id));
            self.credential_store
                .set_secret(&key, &secret)
                .context("failed to migrate AI API key to system credentials")?;
            connection.execute(
                "UPDATE ai_provider_configs SET api_key_ref = ?1, api_key = NULL WHERE id = ?2",
                params![&key, config.id],
            )?;
            config.api_key_ref = key;
            config.api_key = Some(secret);
            return Ok(());
        }

        if let Some(key) = normalized_string(&config.api_key_ref) {
            config.api_key_ref = key.clone();
            config.api_key = self
                .credential_store
                .get_secret(&key)
                .context("failed to read AI API key from system credentials")?;
        } else {
            config.api_key_ref.clear();
            config.api_key = None;
        }
        Ok(())
    }

    fn delete_ai_provider_config_secret(&self, config: &AiProviderConfig) -> Result<()> {
        if let Some(key) = normalized_string(&config.api_key_ref) {
            self.credential_store
                .delete_secret(&key)
                .with_context(|| format!("failed to delete AI API credential {key}"))?;
        }
        Ok(())
    }
    fn connection(&self) -> Result<Connection> {
        if let Some(parent) = Path::new(&self.database_path).parent() {
            std::fs::create_dir_all(parent)?;
        }
        Ok(Connection::open(&self.database_path)?)
    }
}

fn migrate_connection_profiles(connection: &Connection) -> Result<()> {
    ensure_column(
        connection,
        "connection_profiles",
        "connection_role",
        "TEXT NOT NULL DEFAULT 'direct'",
    )?;
    ensure_column(
        connection,
        "connection_profiles",
        "gateway_password",
        "TEXT",
    )?;
    ensure_column(connection, "connection_profiles", "target_password", "TEXT")?;
    Ok(())
}

fn migrate_ai_provider_configs(connection: &Connection) -> Result<()> {
    ensure_column(connection, "ai_provider_configs", "api_key", "TEXT")?;
    Ok(())
}

fn migrate_command_history(connection: &Connection) -> Result<()> {
    ensure_column(
        connection,
        "command_history",
        "workspace_session_id",
        "TEXT NOT NULL DEFAULT 'default'",
    )?;
    ensure_column(
        connection,
        "command_history",
        "terminal_id",
        "TEXT NOT NULL DEFAULT 'unknown'",
    )?;
    Ok(())
}

fn migrate_ai_conversation_messages(connection: &Connection) -> Result<()> {
    ensure_column(
        connection,
        "ai_conversation_messages",
        "workspace_session_id",
        "TEXT NOT NULL DEFAULT 'default'",
    )?;
    Ok(())
}

fn migrate_update_scripts(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS update_scripts (
          id TEXT PRIMARY KEY NOT NULL,
          connection_id TEXT NOT NULL,
          workspace_session_id TEXT NOT NULL DEFAULT 'default',
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL,
          source_commands_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_update_scripts_connection_updated
          ON update_scripts(connection_id, updated_at);
        "#,
    )?;
    Ok(())
}

fn ensure_column(
    connection: &Connection,
    table_name: &str,
    column_name: &str,
    column_type: &str,
) -> Result<()> {
    if table_has_column(connection, table_name, column_name)? {
        return Ok(());
    }

    connection.execute(
        &format!("ALTER TABLE {table_name} ADD COLUMN {column_name} {column_type}"),
        [],
    )?;
    Ok(())
}

fn table_has_column(connection: &Connection, table_name: &str, column_name: &str) -> Result<bool> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table_name})"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    for row in rows {
        if row? == column_name {
            return Ok(true);
        }
    }
    Ok(false)
}

fn normalized_optional(value: Option<String>) -> Option<String> {
    value.and_then(|value| normalized_string(&value))
}

fn normalized_string(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn connection_secret_ref(profile_id: &str, role: &str) -> String {
    format!("ssh-profile:{profile_id}:{role}:password")
}

fn ai_provider_secret_ref(config_id: &str) -> String {
    format!("ai-provider:{config_id}")
}
fn normalize_secret(value: Option<&str>) -> Option<String> {
    value.and_then(|secret| {
        let trimmed = secret.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(secret.to_string())
        }
    })
}

pub fn schema_contains_required_tables() -> bool {
    let required = [
        "connection_profiles",
        "menu_profiles",
        "ai_provider_configs",
        "app_settings",
        "workspace_sessions",
        "command_history",
        "ai_conversation_messages",
        "update_scripts",
    ];

    required.iter().all(|table| SCHEMA.contains(table))
}

pub fn default_database_path(app_config_dir: &Path) -> String {
    app_config_dir
        .join("ai-term.sqlite3")
        .to_string_lossy()
        .into_owned()
}

pub fn validate_schema() -> Result<()> {
    if schema_contains_required_tables() {
        Ok(())
    } else {
        anyhow::bail!("sqlite schema is missing required config tables")
    }
}

fn auth_mode_to_str(value: &AuthMode) -> &'static str {
    match value {
        AuthMode::Auto => "auto",
        AuthMode::Password => "password",
        AuthMode::Key => "key",
    }
}

fn auth_mode_from_str(value: &str) -> AuthMode {
    match value {
        "password" => AuthMode::Password,
        "key" => AuthMode::Key,
        _ => AuthMode::Auto,
    }
}

fn connection_role_to_str(value: &ConnectionRole) -> &'static str {
    match value {
        ConnectionRole::Direct => "direct",
        ConnectionRole::Bastion => "bastion",
    }
}

fn connection_role_from_str(value: &str) -> ConnectionRole {
    match value {
        "bastion" => ConnectionRole::Bastion,
        _ => ConnectionRole::Direct,
    }
}

fn jump_mode_to_str(value: &JumpMode) -> &'static str {
    match value {
        JumpMode::Direct => "direct",
        JumpMode::InteractiveMenu => "interactive-menu",
    }
}

fn jump_mode_from_str(value: &str) -> JumpMode {
    match value {
        "direct" => JumpMode::Direct,
        _ => JumpMode::InteractiveMenu,
    }
}

fn file_transfer_mode_to_str(value: &FileTransferMode) -> &'static str {
    match value {
        FileTransferMode::Auto => "auto",
        FileTransferMode::SftpDirect => "sftp-direct",
        FileTransferMode::SftpGateway => "sftp-gateway",
        FileTransferMode::ScpThroughTerminal => "scp-through-terminal",
        FileTransferMode::InlineSmallFile => "inline-small-file",
    }
}

fn file_transfer_mode_from_str(value: &str) -> FileTransferMode {
    match value {
        "sftp-direct" => FileTransferMode::SftpDirect,
        "sftp-gateway" => FileTransferMode::SftpGateway,
        "scp-through-terminal" => FileTransferMode::ScpThroughTerminal,
        "inline-small-file" => FileTransferMode::InlineSmallFile,
        _ => FileTransferMode::Auto,
    }
}

fn optional_i64_to_u16(value: Option<i64>) -> Option<u16> {
    value.and_then(|port| u16::try_from(port).ok())
}

fn ai_provider_type_to_str(value: &AiProviderType) -> &'static str {
    match value {
        AiProviderType::OpenAiCompatible => "open-ai-compatible",
        AiProviderType::OpenAi => "open-ai",
        AiProviderType::CompanyGateway => "company-gateway",
        AiProviderType::Ollama => "ollama",
        AiProviderType::CustomHttp => "custom-http",
    }
}

fn ai_provider_type_from_str(value: &str) -> AiProviderType {
    match value {
        "open-ai" | "openai" => AiProviderType::OpenAi,
        "company-gateway" => AiProviderType::CompanyGateway,
        "ollama" => AiProviderType::Ollama,
        "custom-http" => AiProviderType::CustomHttp,
        "open-ai-compatible" | "openai-compatible" => AiProviderType::OpenAiCompatible,
        _ => AiProviderType::OpenAiCompatible,
    }
}

fn context_policy_to_str(value: &ContextPolicy) -> &'static str {
    match value {
        ContextPolicy::SelectedOutputOnly => "selected-output-only",
        ContextPolicy::ActiveCommandOutput => "active-command-output",
        ContextPolicy::ManualAttachments => "manual-attachments",
    }
}

fn context_policy_from_str(value: &str) -> ContextPolicy {
    match value {
        "active-command-output" => ContextPolicy::ActiveCommandOutput,
        "manual-attachments" => ContextPolicy::ManualAttachments,
        _ => ContextPolicy::SelectedOutputOnly,
    }
}

fn ai_message_role_to_str(value: &AiMessageRole) -> &'static str {
    match value {
        AiMessageRole::User => "user",
        AiMessageRole::Assistant => "assistant",
    }
}

fn ai_message_role_from_str(value: &str) -> AiMessageRole {
    match value {
        "assistant" => AiMessageRole::Assistant,
        _ => AiMessageRole::User,
    }
}
