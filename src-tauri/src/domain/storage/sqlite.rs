use anyhow::Result;
use rusqlite::{params, Connection};
use std::path::Path;

use crate::domain::connection::models::{
    AiProviderConfig, AiProviderType, AuthEndpoint, AuthMode, ConnectionProfile, ContextPolicy,
    FileTransferMode, JumpMode,
};
use crate::domain::workspace::{
    AiConversationMessage, AiMessageRole, CommandHistoryRecord, WorkspaceSession,
};

pub const SCHEMA: &str = include_str!("schema.sql");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqliteConfigStore {
    database_path: String,
}

impl SqliteConfigStore {
    pub fn new(database_path: impl Into<String>) -> Self {
        Self {
            database_path: database_path.into(),
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
        Ok(())
    }

    pub fn save_connection_profile(&self, profile: &ConnectionProfile) -> Result<()> {
        self.initialize()?;
        let connection = self.connection()?;
        connection.execute(
            r#"
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
              file_transfer_mode,
              updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
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
                profile.id,
                profile.name,
                profile.gateway.host,
                profile.gateway.port.unwrap_or(22),
                profile.gateway.username,
                auth_mode_to_str(&profile.gateway.auth_mode),
                profile.gateway.credential_ref,
                normalize_secret(profile.gateway.password.as_deref()),
                profile.target.host,
                profile.target.port,
                profile.target.username,
                auth_mode_to_str(&profile.target.auth_mode),
                profile.target.credential_ref,
                normalize_secret(profile.target.password.as_deref()),
                jump_mode_to_str(&profile.jump_mode),
                profile.menu_profile_id,
                file_transfer_mode_to_str(&profile.file_transfer_mode),
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
            let gateway_auth_mode: String = row.get(5)?;
            let target_auth_mode: String = row.get(11)?;
            let jump_mode: String = row.get(14)?;
            let file_transfer_mode: String = row.get(16)?;

            Ok(ConnectionProfile {
                id: row.get(0)?,
                name: row.get(1)?,
                gateway: AuthEndpoint {
                    host: row.get(2)?,
                    port: optional_i64_to_u16(row.get::<_, Option<i64>>(3)?),
                    username: row.get(4)?,
                    auth_mode: auth_mode_from_str(&gateway_auth_mode),
                    credential_ref: row.get(6)?,
                    password: row.get(7)?,
                },
                target: AuthEndpoint {
                    host: row.get(8)?,
                    port: optional_i64_to_u16(row.get::<_, Option<i64>>(9)?),
                    username: row.get(10)?,
                    auth_mode: auth_mode_from_str(&target_auth_mode),
                    credential_ref: row.get(12)?,
                    password: row.get(13)?,
                },
                jump_mode: jump_mode_from_str(&jump_mode),
                menu_profile_id: row.get(15)?,
                file_transfer_mode: file_transfer_mode_from_str(&file_transfer_mode),
            })
        })?;

        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn get_connection_profile(&self, id: &str) -> Result<Option<ConnectionProfile>> {
        Ok(self
            .list_connection_profiles()?
            .into_iter()
            .find(|profile| profile.id == id))
    }

    pub fn delete_connection_profile(&self, id: &str) -> Result<bool> {
        self.initialize()?;
        let connection = self.connection()?;
        let deleted = connection.execute("DELETE FROM connection_profiles WHERE id = ?1", [id])?;
        Ok(deleted > 0)
    }

    pub fn save_ai_provider_config(&self, config: &AiProviderConfig) -> Result<()> {
        self.initialize()?;
        let connection = self.connection()?;
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
                config.id,
                ai_provider_type_to_str(&config.provider),
                config.base_url,
                config.model,
                config.api_key_ref,
                normalize_secret(config.api_key.as_deref()),
                context_policy_to_str(&config.context_policy),
                config.system_prompt,
                config.risk_policy,
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

        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn get_ai_provider_config(&self, id: &str) -> Result<Option<AiProviderConfig>> {
        Ok(self
            .list_ai_provider_configs()?
            .into_iter()
            .find(|config| config.id == id))
    }

    pub fn delete_ai_provider_config(&self, id: &str) -> Result<bool> {
        self.initialize()?;
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

    pub fn list_workspace_sessions(&self, connection_id: &str) -> Result<Vec<WorkspaceSession>> {
        self.initialize()?;
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            r#"
            SELECT id, connection_id, name, summary, created_at, updated_at
            FROM workspace_sessions
            WHERE connection_id = ?1
            ORDER BY updated_at DESC, created_at DESC, id DESC
            "#,
        )?;

        let rows = statement.query_map([connection_id], |row| {
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
        transaction.execute("DELETE FROM command_history WHERE workspace_session_id = ?1", [id])?;
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
        Ok(())
    }

    pub fn list_command_history(
        &self,
        connection_id: &str,
        workspace_session_id: &str,
    ) -> Result<Vec<CommandHistoryRecord>> {
        self.initialize()?;
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            r#"
            SELECT id, connection_id, workspace_session_id, terminal_id, command, created_at
            FROM (
              SELECT id, connection_id, workspace_session_id, terminal_id, command, created_at
              FROM command_history
              WHERE connection_id = ?1
                AND workspace_session_id = ?2
              ORDER BY created_at DESC, id DESC
              LIMIT 300
            )
            ORDER BY created_at ASC, id ASC
            "#,
        )?;

        let rows = statement.query_map(params![connection_id, workspace_session_id], |row| {
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
        connection_id: &str,
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
              WHERE connection_id = ?1
                AND workspace_session_id = ?2
              ORDER BY created_at DESC, id DESC
              LIMIT 300
            )
            ORDER BY created_at ASC, id ASC
            "#,
        )?;

        let rows = statement.query_map(params![connection_id, workspace_session_id], |row| {
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
