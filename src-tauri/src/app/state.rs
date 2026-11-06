use anyhow::{Context, Result};
use std::collections::HashMap;
use std::sync::{atomic::AtomicBool, Arc};
use tokio::sync::Mutex;

#[path = "agent_files_state.rs"]
mod agent_files;
pub use agent_files::{FileCapturePlan, FileDispatchOutcome, FileEditDispatchOutcome};
#[path = "agent_checkpoints_state.rs"]
mod agent_checkpoints;
#[path = "host_knowledge_state.rs"]
mod host_knowledge;
#[path = "ssh_tasks_state.rs"]
mod ssh_tasks;
pub use agent_checkpoints::{AgentRecoverySession, AgentRunLease};

use super::tasks::{TaskRegistration, TaskRegistry};
use crate::domain::command_policy::{
    CaptureKind, CommandIntent, ExecutionContext, ExecutionTarget, IntentReference, IntentStore,
    InternalProbe, OperationKind,
};
use crate::domain::connection::models::{AiProviderConfig, ConnectionProfile};
use crate::domain::storage::sqlite::SqliteConfigStore;
use crate::domain::terminal::ssh::TerminalSession;
use crate::domain::workspace::{
    AgentCommandAllowlistEntry, AiConversationMessage, CommandHistoryRecord, UpdateScript,
    WorkspaceSession,
};
pub struct SessionRecord {
    pub id: String,
    pub profile_id: String,
    pub terminal: Option<Box<dyn TerminalSession>>,
    pub execution_target: ExecutionTarget,
    intents: IntentStore,
    files: agent_files::SessionFileState,
    ssh_tasks: ssh_tasks::SessionSshTasks,
}

#[derive(Default)]
pub struct AppState {
    agent_runs: Mutex<HashMap<String, agent_checkpoints::AgentRunOwner>>,
    sessions: Mutex<HashMap<String, SessionRecord>>,
    tasks: Arc<TaskRegistry>,
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
            agent_runs: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            tasks: Arc::new(TaskRegistry::default()),
            profile_store: Some(Arc::new(profile_store)),
        }
    }

    fn store(&self, purpose: &str) -> Result<Arc<SqliteConfigStore>> {
        self.profile_store
            .clone()
            .ok_or_else(|| anyhow::anyhow!("{purpose} store is not configured"))
    }

    pub async fn register_task(&self, task_id: String) -> Arc<AtomicBool> {
        self.tasks.register(task_id)
    }

    pub async fn cancel_task(&self, task_id: &str) -> bool {
        self.tasks.cancel(task_id)
    }

    pub async fn finish_task(&self, task_id: &str) {
        self.tasks.finish(task_id);
    }

    pub(crate) fn scoped_task(&self, task_id: Option<String>) -> Result<TaskRegistration, String> {
        self.tasks.scoped(task_id)
    }

    #[cfg(test)]
    pub(crate) fn active_task_count(&self) -> usize {
        self.tasks.active_count()
    }

    pub async fn register_session(&self, session_id: String, profile_id: String) {
        let record = SessionRecord {
            execution_target: ExecutionTarget::new(session_id.clone(), profile_id.clone()),
            intents: IntentStore::default(),
            files: agent_files::SessionFileState::default(),
            ssh_tasks: ssh_tasks::SessionSshTasks::default(),
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
            execution_target: ExecutionTarget::new(session_id.clone(), profile_id.clone()),
            intents: IntentStore::default(),
            files: agent_files::SessionFileState::default(),
            ssh_tasks: ssh_tasks::SessionSshTasks::default(),
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
        // Any raw input can change readline state, cwd, identity or shell. The
        // legacy keyboard channel therefore invalidates outstanding approvals.
        record.execution_target.invalidate_context();
        record.intents.invalidate();
        record.ssh_tasks.invalidate_pending();
        record.files.invalidate();
        if let Some(terminal) = &mut record.terminal {
            terminal.write(&data)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub async fn command_execution_target(&self, session_id: &str) -> Result<ExecutionTarget> {
        let mut sessions = self.sessions.lock().await;
        let record = session_mut(&mut sessions, session_id)?;
        if record.terminal.is_none() {
            anyhow::bail!("目标尚未连接到终端");
        }
        Ok(record.execution_target.clone())
    }

    pub async fn update_command_context(
        &self,
        expected: &ExecutionTarget,
        context: ExecutionContext,
    ) -> Result<ExecutionTarget> {
        for value in [
            &context.working_directory,
            &context.user,
            &context.environment_scope,
        ]
        .into_iter()
        .flatten()
        {
            if value.len() > 4096 || value.trim().is_empty() || value.chars().any(char::is_control)
            {
                anyhow::bail!("无效的执行环境信息");
            }
        }
        let mut sessions = self.sessions.lock().await;
        let record = session_mut(&mut sessions, &expected.session_id)?;
        if record.execution_target != *expected {
            anyhow::bail!("目标已经变化，旧环境报告已丢弃");
        }
        if record.execution_target.context != context {
            record.execution_target.context = context;
            record.execution_target.context_version += 1;
            record.intents.invalidate();
            record.ssh_tasks.invalidate_pending();
            record.files.invalidate();
        }
        Ok(record.execution_target.clone())
    }

    pub async fn analyze_command_intent(
        &self,
        expected: ExecutionTarget,
        source: String,
        operation: OperationKind,
    ) -> Result<CommandIntent> {
        self.analyze_captured_command_intent(expected, source, operation, CaptureKind::None)
            .await
    }

    pub async fn analyze_captured_command_intent(
        &self,
        expected: ExecutionTarget,
        source: String,
        operation: OperationKind,
        capture: CaptureKind,
    ) -> Result<CommandIntent> {
        if self.command_execution_target(&expected.session_id).await? != expected {
            anyhow::bail!("目标已经变化，请重新分析");
        }
        let target = expected.clone();
        let prepared = tokio::task::spawn_blocking(move || {
            IntentStore::prepare_capture(source, operation, target, capture)
        })
        .await??;
        let mut sessions = self.sessions.lock().await;
        let record = session_mut(&mut sessions, &expected.session_id)?;
        record.intents.insert(prepared, &record.execution_target)
    }

    pub async fn prepare_terminal_probe(
        &self,
        expected: ExecutionTarget,
        probe: InternalProbe,
    ) -> Result<CommandIntent> {
        let prepared = IntentStore::prepare_probe(probe, expected.clone())?;
        let mut sessions = self.sessions.lock().await;
        let record = session_mut(&mut sessions, &expected.session_id)?;
        if record.terminal.is_none() {
            anyhow::bail!("目标尚未连接到终端");
        }
        record.intents.insert(prepared, &record.execution_target)
    }

    pub async fn approve_command_intent(
        &self,
        reference: &IntentReference,
        reviewed_source: &str,
    ) -> Result<()> {
        let mut sessions = self.sessions.lock().await;
        let record = session_mut(&mut sessions, &reference.target.session_id)?;
        record
            .intents
            .approve(reference, &record.execution_target, reviewed_source)
    }

    pub async fn cancel_command_intent(&self, reference: &IntentReference) -> Result<bool> {
        let mut sessions = self.sessions.lock().await;
        let record = session_mut(&mut sessions, &reference.target.session_id)?;
        Ok(record.intents.cancel(&reference.id))
    }

    pub async fn dispatch_command_intent(&self, reference: &IntentReference) -> Result<()> {
        // Consume and write under ONE lock: raw input, context changes, profile
        // edits and replacement sessions cannot intervene after validation.
        let mut sessions = self.sessions.lock().await;
        let record = session_mut(&mut sessions, &reference.target.session_id)?;
        if record.terminal.is_none() {
            anyhow::bail!("目标尚未连接到终端");
        }
        let (payload, preserves_context) = record
            .intents
            .consume_dispatch(reference, &record.execution_target)?;
        if !preserves_context {
            record.execution_target.invalidate_context();
            record.intents.invalidate();
            record.ssh_tasks.invalidate_pending();
            record.files.invalidate();
        }
        let result = record
            .terminal
            .as_mut()
            .expect("checked terminal")
            .write(&payload)
            .context("终端写入失败，实际效果可能未知；批准已消费，不得自动重放");
        if result.is_err() && preserves_context {
            record.execution_target.invalidate_context();
            record.intents.invalidate();
            record.ssh_tasks.invalidate_pending();
            record.files.invalidate();
        }
        if result.is_ok() {
            record.files.note_dispatched(&reference.id);
        }
        result
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
        let profile_id = profile.id.clone();
        run_store_task(store, move |store| store.save_connection_profile(&profile)).await?;
        self.invalidate_profile_intents(&profile_id).await;
        Ok(())
    }

    async fn invalidate_profile_intents(&self, profile_id: &str) {
        let mut sessions = self.sessions.lock().await;
        for record in sessions.values_mut().filter(|r| r.profile_id == profile_id) {
            record.execution_target.route_version += 1;
            record.ssh_tasks.invalidate_route();
            record.execution_target.invalidate_context();
            record.intents.invalidate();
            record.ssh_tasks.invalidate_pending();
            record.files.invalidate();
        }
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
        let profile_id = id.to_string();
        let deleted = run_store_task(store, move |store| {
            store.delete_connection_profile(&profile_id)
        })
        .await?;
        if deleted {
            self.invalidate_profile_intents(id).await;
        }
        Ok(deleted)
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

    pub async fn list_agent_command_allowlist(&self) -> Result<Vec<AgentCommandAllowlistEntry>> {
        let store = self.store("agent allowlist")?;
        run_store_task(store, |store| store.list_agent_command_allowlist()).await
    }

    pub async fn save_agent_command_allowlist_entry(
        &self,
        pattern: &str,
        source_command: &str,
    ) -> Result<()> {
        let store = self.store("agent allowlist")?;
        let pattern = pattern.to_string();
        let source_command = source_command.to_string();
        run_store_task(store, move |store| {
            store.save_agent_command_allowlist_entry(&pattern, &source_command)
        })
        .await
    }

    pub async fn save_agent_command_allowlist_entries(
        &self,
        patterns: &[String],
        source_command: &str,
    ) -> Result<()> {
        let store = self.store("agent allowlist")?;
        let entries = patterns
            .iter()
            .map(|pattern| (pattern.clone(), source_command.to_string()))
            .collect::<Vec<_>>();
        run_store_task(store, move |store| {
            store.save_agent_command_allowlist_entries(&entries)
        })
        .await
    }

    pub async fn delete_agent_command_allowlist_entry(&self, pattern: &str) -> Result<bool> {
        let store = self.store("agent allowlist")?;
        let pattern = pattern.to_string();
        run_store_task(store, move |store| {
            store.delete_agent_command_allowlist_entry(&pattern)
        })
        .await
    }

    pub async fn touch_agent_command_allowlist_entry(&self, pattern: &str) -> Result<()> {
        let store = self.store("agent allowlist")?;
        let pattern = pattern.to_string();
        run_store_task(store, move |store| {
            store.touch_agent_command_allowlist_entry(&pattern)
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
