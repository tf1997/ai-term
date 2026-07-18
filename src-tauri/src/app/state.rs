use anyhow::{Context, Result};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::Mutex;

use crate::domain::connection::models::{AiProviderConfig, ConnectionProfile};
use crate::domain::storage::sqlite::SqliteConfigStore;
use crate::domain::terminal::ssh::TerminalSession;
use crate::domain::workspace::{
    AiConversationMessage, CommandHistoryRecord, UpdateScript, WorkspaceSession,
};
pub struct SessionRecord {
    pub id: String,
    pub profile_id: String,
    pub terminal: Option<Box<dyn TerminalSession>>,
}

#[derive(Default)]
pub struct AppState {
    sessions: Mutex<HashMap<String, SessionRecord>>,
    tasks: Mutex<HashMap<String, Arc<AtomicBool>>>,
    // The store synchronizes internally around one persistent SQLite
    // connection, so no async lock is needed here; sharing the Arc lets each
    // call run on the blocking pool without serializing unrelated commands.
    profile_store: Option<Arc<SqliteConfigStore>>,
}

/// Runs a blocking store operation on the blocking thread pool so SQLite and
/// OS-keychain work never stalls the async runtime workers.
async fn run_store_task<T, F>(store: Arc<SqliteConfigStore>, task: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&SqliteConfigStore) -> Result<T> + Send + 'static,
{
    tokio::task::spawn_blocking(move || task(&store))
        .await
        .context("storage task failed to complete")?
}

impl AppState {
    pub fn with_profile_store(profile_store: SqliteConfigStore) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            tasks: Mutex::new(HashMap::new()),
            profile_store: Some(Arc::new(profile_store)),
        }
    }

    fn store(&self, purpose: &str) -> Result<Arc<SqliteConfigStore>> {
        self.profile_store
            .clone()
            .ok_or_else(|| anyhow::anyhow!("{purpose} store is not configured"))
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
        let store = self.store("connection profile")?;
        run_store_task(store, move |store| store.save_connection_profile(&profile)).await
    }

    pub async fn list_connection_profiles(&self) -> Result<Vec<ConnectionProfile>> {
        let store = self.store("connection profile")?;
        run_store_task(store, |store| store.list_connection_profiles()).await
    }

    pub async fn get_connection_profile(&self, id: &str) -> Result<Option<ConnectionProfile>> {
        let store = self.store("connection profile")?;
        let id = id.to_string();
        run_store_task(store, move |store| store.get_connection_profile(&id)).await
    }

    pub async fn delete_connection_profile(&self, id: &str) -> Result<bool> {
        let store = self.store("connection profile")?;
        let id = id.to_string();
        run_store_task(store, move |store| store.delete_connection_profile(&id)).await
    }

    pub async fn save_ai_provider_config(&self, config: AiProviderConfig) -> Result<()> {
        let store = self.store("ai provider config")?;
        run_store_task(store, move |store| store.save_ai_provider_config(&config)).await
    }

    pub async fn list_ai_provider_configs(&self) -> Result<Vec<AiProviderConfig>> {
        let store = self.store("ai provider config")?;
        run_store_task(store, |store| store.list_ai_provider_configs()).await
    }

    pub async fn get_ai_provider_config(&self, id: &str) -> Result<Option<AiProviderConfig>> {
        let store = self.store("ai provider config")?;
        let id = id.to_string();
        run_store_task(store, move |store| store.get_ai_provider_config(&id)).await
    }

    pub async fn delete_ai_provider_config(&self, id: &str) -> Result<bool> {
        let store = self.store("ai provider config")?;
        let id = id.to_string();
        run_store_task(store, move |store| store.delete_ai_provider_config(&id)).await
    }

    pub async fn save_command_history_record(&self, record: CommandHistoryRecord) -> Result<()> {
        let store = self.store("workspace history")?;
        run_store_task(store, move |store| {
            store.save_command_history_record(&record)
        })
        .await
    }

    pub async fn save_workspace_session(&self, session: WorkspaceSession) -> Result<()> {
        let store = self.store("workspace session")?;
        run_store_task(store, move |store| store.save_workspace_session(&session)).await
    }

    pub async fn list_workspace_sessions(&self) -> Result<Vec<WorkspaceSession>> {
        let store = self.store("workspace session")?;
        run_store_task(store, |store| store.list_workspace_sessions()).await
    }

    pub async fn delete_workspace_session(&self, id: &str) -> Result<bool> {
        let store = self.store("workspace session")?;
        let id = id.to_string();
        run_store_task(store, move |store| store.delete_workspace_session(&id)).await
    }

    pub async fn list_command_history(
        &self,
        connection_id: &str,
    ) -> Result<Vec<CommandHistoryRecord>> {
        let store = self.store("workspace history")?;
        let connection_id = connection_id.to_string();
        run_store_task(store, move |store| {
            store.list_command_history(&connection_id)
        })
        .await
    }

    pub async fn save_ai_conversation_message(&self, message: AiConversationMessage) -> Result<()> {
        let store = self.store("workspace conversation")?;
        run_store_task(store, move |store| {
            store.save_ai_conversation_message(&message)
        })
        .await
    }

    pub async fn list_ai_conversation_messages(
        &self,
        workspace_session_id: &str,
    ) -> Result<Vec<AiConversationMessage>> {
        let store = self.store("workspace conversation")?;
        let workspace_session_id = workspace_session_id.to_string();
        run_store_task(store, move |store| {
            store.list_ai_conversation_messages(&workspace_session_id)
        })
        .await
    }

    pub async fn save_update_script(&self, script: UpdateScript) -> Result<()> {
        let store = self.store("workspace script")?;
        run_store_task(store, move |store| store.save_update_script(&script)).await
    }

    pub async fn list_update_scripts(&self) -> Result<Vec<UpdateScript>> {
        let store = self.store("workspace script")?;
        run_store_task(store, |store| store.list_update_scripts()).await
    }

    pub async fn get_update_script(&self, id: &str) -> Result<Option<UpdateScript>> {
        let store = self.store("workspace script")?;
        let id = id.to_string();
        run_store_task(store, move |store| store.get_update_script(&id)).await
    }

    pub async fn delete_update_script(&self, id: &str) -> Result<bool> {
        let store = self.store("workspace script")?;
        let id = id.to_string();
        run_store_task(store, move |store| store.delete_update_script(&id)).await
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
