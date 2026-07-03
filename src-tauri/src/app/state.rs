use anyhow::Result;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::Mutex;

use crate::domain::connection::models::{AiProviderConfig, ConnectionProfile};
use crate::domain::storage::sqlite::SqliteConfigStore;
use crate::domain::terminal::ssh::TerminalSession;
use crate::domain::workspace::{AiConversationMessage, CommandHistoryRecord, WorkspaceSession};
pub struct SessionRecord {
    pub id: String,
    pub profile_id: String,
    pub terminal: Option<Box<dyn TerminalSession>>,
}

#[derive(Default)]
pub struct AppState {
    sessions: Mutex<HashMap<String, SessionRecord>>,
    tasks: Mutex<HashMap<String, Arc<AtomicBool>>>,
    profile_store: Mutex<Option<SqliteConfigStore>>,
}

impl AppState {
    pub fn with_profile_store(profile_store: SqliteConfigStore) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            tasks: Mutex::new(HashMap::new()),
            profile_store: Mutex::new(Some(profile_store)),
        }
    }

    pub async fn register_task(&self, task_id: String) -> Arc<AtomicBool> {
        let token = Arc::new(AtomicBool::new(false));
        self.tasks.lock().await.insert(task_id, token.clone());
        token
    }

    pub async fn cancel_task(&self, task_id: &str) -> bool {
        let tasks = self.tasks.lock().await;
        if let Some(token) = tasks.get(task_id) {
            token.store(true, Ordering::SeqCst);
            true
        } else {
            false
        }
    }

    pub async fn finish_task(&self, task_id: &str) {
        self.tasks.lock().await.remove(task_id);
    }

    pub async fn register_session(&self, session_id: String, profile_id: String) {
        let record = SessionRecord {
            id: session_id.clone(),
            profile_id,
            terminal: None,
        };
        self.sessions.lock().await.insert(session_id, record);
    }

    pub async fn register_terminal_session(
        &self,
        session_id: String,
        profile_id: String,
        terminal: Box<dyn TerminalSession>,
    ) {
        let record = SessionRecord {
            id: session_id.clone(),
            profile_id,
            terminal: Some(terminal),
        };
        self.sessions.lock().await.insert(session_id, record);
    }

    pub async fn has_session(&self, session_id: &str) -> bool {
        self.sessions.lock().await.contains_key(session_id)
    }

    pub async fn remove_session(&self, session_id: &str) -> bool {
        self.sessions.lock().await.remove(session_id).is_some()
    }

    pub async fn write_terminal(&self, session_id: &str, data: Vec<u8>) -> Result<bool> {
        let mut sessions = self.sessions.lock().await;
        let record = session_mut(&mut sessions, session_id)?;
        if let Some(terminal) = &mut record.terminal {
            terminal.write(&data)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub async fn resize_terminal(&self, session_id: &str, _cols: u16, _rows: u16) -> Result<()> {
        let mut sessions = self.sessions.lock().await;
        let record = session_mut(&mut sessions, session_id)?;
        if let Some(terminal) = &mut record.terminal {
            terminal.resize(_cols, _rows)?;
        }
        Ok(())
    }

    pub async fn save_connection_profile(&self, profile: ConnectionProfile) -> Result<()> {
        let store = self.profile_store.lock().await;
        let Some(store) = store.as_ref() else {
            anyhow::bail!("connection profile store is not configured");
        };
        store.save_connection_profile(&profile)
    }

    pub async fn list_connection_profiles(&self) -> Result<Vec<ConnectionProfile>> {
        let store = self.profile_store.lock().await;
        let Some(store) = store.as_ref() else {
            anyhow::bail!("connection profile store is not configured");
        };
        store.list_connection_profiles()
    }

    pub async fn get_connection_profile(&self, id: &str) -> Result<Option<ConnectionProfile>> {
        let store = self.profile_store.lock().await;
        let Some(store) = store.as_ref() else {
            anyhow::bail!("connection profile store is not configured");
        };
        store.get_connection_profile(id)
    }

    pub async fn delete_connection_profile(&self, id: &str) -> Result<bool> {
        let store = self.profile_store.lock().await;
        let Some(store) = store.as_ref() else {
            anyhow::bail!("connection profile store is not configured");
        };
        store.delete_connection_profile(id)
    }

    pub async fn save_ai_provider_config(&self, config: AiProviderConfig) -> Result<()> {
        let store = self.profile_store.lock().await;
        let Some(store) = store.as_ref() else {
            anyhow::bail!("ai provider config store is not configured");
        };
        store.save_ai_provider_config(&config)
    }

    pub async fn list_ai_provider_configs(&self) -> Result<Vec<AiProviderConfig>> {
        let store = self.profile_store.lock().await;
        let Some(store) = store.as_ref() else {
            anyhow::bail!("ai provider config store is not configured");
        };
        store.list_ai_provider_configs()
    }

    pub async fn get_ai_provider_config(&self, id: &str) -> Result<Option<AiProviderConfig>> {
        let store = self.profile_store.lock().await;
        let Some(store) = store.as_ref() else {
            anyhow::bail!("ai provider config store is not configured");
        };
        store.get_ai_provider_config(id)
    }

    pub async fn delete_ai_provider_config(&self, id: &str) -> Result<bool> {
        let store = self.profile_store.lock().await;
        let Some(store) = store.as_ref() else {
            anyhow::bail!("ai provider config store is not configured");
        };
        store.delete_ai_provider_config(id)
    }

    pub async fn save_command_history_record(&self, record: CommandHistoryRecord) -> Result<()> {
        let store = self.profile_store.lock().await;
        let Some(store) = store.as_ref() else {
            anyhow::bail!("workspace history store is not configured");
        };
        store.save_command_history_record(&record)
    }

    pub async fn save_workspace_session(&self, session: WorkspaceSession) -> Result<()> {
        let store = self.profile_store.lock().await;
        let Some(store) = store.as_ref() else {
            anyhow::bail!("workspace session store is not configured");
        };
        store.save_workspace_session(&session)
    }

    pub async fn list_workspace_sessions(
        &self,
        connection_id: &str,
    ) -> Result<Vec<WorkspaceSession>> {
        let store = self.profile_store.lock().await;
        let Some(store) = store.as_ref() else {
            anyhow::bail!("workspace session store is not configured");
        };
        store.list_workspace_sessions(connection_id)
    }

    pub async fn delete_workspace_session(&self, id: &str) -> Result<bool> {
        let store = self.profile_store.lock().await;
        let Some(store) = store.as_ref() else {
            anyhow::bail!("workspace session store is not configured");
        };
        store.delete_workspace_session(id)
    }

    pub async fn list_command_history(
        &self,
        connection_id: &str,
        workspace_session_id: &str,
    ) -> Result<Vec<CommandHistoryRecord>> {
        let store = self.profile_store.lock().await;
        let Some(store) = store.as_ref() else {
            anyhow::bail!("workspace history store is not configured");
        };
        store.list_command_history(connection_id, workspace_session_id)
    }

    pub async fn save_ai_conversation_message(&self, message: AiConversationMessage) -> Result<()> {
        let store = self.profile_store.lock().await;
        let Some(store) = store.as_ref() else {
            anyhow::bail!("workspace conversation store is not configured");
        };
        store.save_ai_conversation_message(&message)
    }

    pub async fn list_ai_conversation_messages(
        &self,
        connection_id: &str,
        workspace_session_id: &str,
    ) -> Result<Vec<AiConversationMessage>> {
        let store = self.profile_store.lock().await;
        let Some(store) = store.as_ref() else {
            anyhow::bail!("workspace conversation store is not configured");
        };
        store.list_ai_conversation_messages(connection_id, workspace_session_id)
    }
}

fn session_mut<'a>(
    sessions: &'a mut HashMap<String, SessionRecord>,
    session_id: &str,
) -> Result<&'a mut SessionRecord> {
    sessions
        .get_mut(session_id)
        .ok_or_else(|| anyhow::anyhow!("unknown session {session_id}"))
}
