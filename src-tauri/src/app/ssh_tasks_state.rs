use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{bail, Result};

use super::{session_mut, AppState};
use crate::domain::command_policy::ExecutionTarget;
use crate::domain::terminal::ssh_tasks::{
    execute_ssh_task, SshTaskControl, SshTaskEvent, SshTaskIntent, SshTaskReference,
    SshTaskRequest, SshTaskSnapshot, SshTaskStore, SshTaskTarget,
};

#[derive(Default)]
pub(super) struct SessionSshTasks {
    pending: SshTaskStore,
    active: HashMap<String, Arc<SshTaskControl>>,
}

impl SessionSshTasks {
    pub fn invalidate_pending(&mut self) {
        self.pending.invalidate();
    }
    pub fn invalidate_route(&mut self) {
        self.pending.invalidate();
        for task in self.active.values() {
            task.stop_observing();
        }
    }
    fn reserve(&mut self) -> Result<()> {
        let mut completed = vec![];
        let mut running = 0;
        for (id, task) in &self.active {
            let state = task.snapshot();
            if state.status.is_finished() {
                completed.push((state.finished_at, id.clone()));
            } else {
                running += 1;
            }
        }
        if running >= 4 {
            bail!("同一连接最多同时观察 4 个独立任务");
        }
        completed.sort();
        for (_, id) in completed
            .into_iter()
            .take(self.active.len().saturating_sub(15))
        {
            self.active.remove(&id);
        }
        Ok(())
    }
}

impl Drop for SessionSshTasks {
    fn drop(&mut self) {
        self.invalidate_route();
    }
}

impl AppState {
    pub async fn prepare_ssh_task(
        &self,
        expected: ExecutionTarget,
        request: SshTaskRequest,
    ) -> Result<SshTaskIntent> {
        if self.command_execution_target(&expected.session_id).await? != expected {
            bail!("独立任务来源连接已变化");
        }
        let profile = self
            .get_connection_profile(&expected.profile_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("当前目标不是已保存的 SSH 连接"))?;
        let profile_copy = profile.clone();
        let origin = expected.clone();
        let intent = tokio::task::spawn_blocking(move || {
            SshTaskStore::prepare(request, origin, profile_copy)
        })
        .await??;
        let mut sessions = self.sessions.lock().await;
        let record = session_mut(&mut sessions, &expected.session_id)?;
        record
            .ssh_tasks
            .pending
            .insert(intent, profile, &record.execution_target)
    }

    pub async fn approve_ssh_task(
        &self,
        reference: &SshTaskReference,
        reviewed: &SshTaskRequest,
        target: &SshTaskTarget,
    ) -> Result<()> {
        let mut sessions = self.sessions.lock().await;
        let record = session_mut(&mut sessions, &reference.origin.session_id)?;
        record
            .ssh_tasks
            .pending
            .approve(reference, &record.execution_target, reviewed, target)
    }

    pub async fn start_ssh_task(
        &self,
        reference: &SshTaskReference,
        on_event: impl Fn(SshTaskEvent) + Send + Sync + 'static,
    ) -> Result<SshTaskSnapshot> {
        let profile = self
            .get_connection_profile(&reference.origin.profile_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("独立任务连接配置已删除"))?;
        let mut sessions = self.sessions.lock().await;
        let record = session_mut(&mut sessions, &reference.origin.session_id)?;
        record.ssh_tasks.reserve()?;
        let dispatch =
            record
                .ssh_tasks
                .pending
                .consume(reference, &record.execution_target, &profile)?;
        let control = SshTaskControl::new(&dispatch, on_event);
        let initial = control.snapshot();
        record
            .ssh_tasks
            .active
            .insert(reference.id.clone(), control.clone());
        // The approval is consumed exactly once before spawning. No retry or
        // route fallback exists, including on worker/connection failure.
        tokio::task::spawn_blocking(move || execute_ssh_task(dispatch, control));
        Ok(initial)
    }

    pub async fn read_ssh_task(&self, reference: &SshTaskReference) -> Result<SshTaskSnapshot> {
        let mut sessions = self.sessions.lock().await;
        let record = session_mut(&mut sessions, &reference.origin.session_id)?;
        let task = record
            .ssh_tasks
            .active
            .get(&reference.id)
            .ok_or_else(|| anyhow::anyhow!("独立任务已失效或尚未派发"))?;
        let snapshot = task.snapshot();
        if snapshot.reference != *reference {
            bail!("独立任务目标不一致");
        }
        Ok(snapshot)
    }

    pub async fn stop_observing_ssh_task(&self, reference: &SshTaskReference) -> Result<bool> {
        let mut sessions = self.sessions.lock().await;
        let record = session_mut(&mut sessions, &reference.origin.session_id)?;
        let pending = record.ssh_tasks.pending.cancel(reference);
        if let Some(task) = record.ssh_tasks.active.get(&reference.id) {
            if task.snapshot().reference != *reference {
                bail!("独立任务目标不一致");
            }
            task.stop_observing();
            Ok(true)
        } else {
            Ok(pending)
        }
    }
}
