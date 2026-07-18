CREATE TABLE IF NOT EXISTS connection_profiles (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  connection_role TEXT NOT NULL DEFAULT 'direct',
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

CREATE TABLE IF NOT EXISTS menu_profiles (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  success_patterns_json TEXT NOT NULL,
  failure_patterns_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_provider_configs (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  api_key_ref TEXT NOT NULL,
  api_key TEXT,
  context_policy TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  risk_policy TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workspace_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  context_summary TEXT NOT NULL DEFAULT '',
  context_summary_last_message_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_workspace_sessions_connection_updated
  ON workspace_sessions(connection_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_workspace_sessions_updated
  ON workspace_sessions(updated_at);

CREATE TABLE IF NOT EXISTS command_history (
  id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL,
  workspace_session_id TEXT NOT NULL DEFAULT 'default',
  terminal_id TEXT NOT NULL,
  command TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_command_history_connection_created
  ON command_history(connection_id, workspace_session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_command_history_connection_all_created
  ON command_history(connection_id, created_at);

CREATE TABLE IF NOT EXISTS ai_conversation_messages (
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

CREATE INDEX IF NOT EXISTS idx_ai_conversation_connection_created
  ON ai_conversation_messages(connection_id, workspace_session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_ai_conversation_session_created
  ON ai_conversation_messages(workspace_session_id, created_at);

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

CREATE INDEX IF NOT EXISTS idx_update_scripts_updated
  ON update_scripts(updated_at);
