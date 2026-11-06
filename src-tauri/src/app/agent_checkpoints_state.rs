use super::{run_store_task, AppState};
use crate::domain::ai::recovery::RecoveryResolution;
use crate::domain::{ai::checkpoints::*, command_policy::ExecutionTarget};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::fs::File;

pub(super) struct AgentRunOwner {
    token: String,
    target: ExecutionTarget,
    _lock: File,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunLease {
    pub run_id: String,
    pub token: String,
    pub sequence: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRecoverySession {
    pub lease: AgentRunLease,
    pub checkpoint: AgentCheckpoint,
}

impl AppState {
    pub async fn completed_agent_checkpoint_for_message(
        &self,
        profile_id: String,
        workspace_session_id: String,
        message_id: String,
    ) -> Result<Option<AgentCheckpoint>> {
        run_store_task(self.store("task script source")?, move |store| {
            store.completed_agent_checkpoint_for_message(
                &profile_id,
                &workspace_session_id,
                &message_id,
            )
        })
        .await
    }
    pub(super) async fn agent_route_key(&self, target: &ExecutionTarget) -> Result<String> {
        if target.profile_id == "local" {
            return Ok("local-route-v1".into());
        }
        let profile = self
            .get_connection_profile(&target.profile_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("连接配置已经删除"))?;
        Ok(crate::domain::connection::sftp::sftp_profile_route(
            &profile,
        ))
    }
    pub async fn recover_agent_run(
        &self,
        expected: ExecutionTarget,
        run_id: String,
        expected_sequence: u64,
    ) -> Result<AgentRecoverySession> {
        if self.command_execution_target(&expected.session_id).await? != expected {
            bail!("恢复目标已经变化")
        }
        let route = self.agent_route_key(&expected).await?;
        let mut owners = self.agent_runs.lock().await;
        if owners.contains_key(&run_id) {
            bail!("任务仍由另一个窗口执行或观察")
        }
        let target = expected.clone();
        let (checkpoint, lock) = run_store_task(self.store("agent recovery")?, move |store| {
            let lock = store.lock_agent_run(&run_id)?;
            let checkpoint =
                store.reopen_agent_checkpoint(&run_id, expected_sequence, target, &route)?;
            Ok((checkpoint, lock))
        })
        .await?;
        let lease = AgentRunLease {
            run_id: checkpoint.run_id.clone(),
            token: uuid::Uuid::new_v4().to_string(),
            sequence: checkpoint.sequence,
        };
        owners.insert(
            checkpoint.run_id.clone(),
            AgentRunOwner {
                token: lease.token.clone(),
                target: expected,
                _lock: lock,
            },
        );
        Ok(AgentRecoverySession { lease, checkpoint })
    }
    pub async fn confirm_agent_recovery(
        &self,
        lease: AgentRunLease,
        expected: ExecutionTarget,
        expected_sequence: u64,
        resolutions: Vec<RecoveryResolution>,
    ) -> Result<AgentCheckpoint> {
        let owners = self.agent_runs.lock().await;
        let owner = owners
            .get(&lease.run_id)
            .ok_or_else(|| anyhow::anyhow!("恢复运行所有权已失效"))?;
        if owner.token != lease.token
            || owner.target.session_instance != expected.session_instance
            || self.command_execution_target(&expected.session_id).await? != expected
        {
            bail!("核对后的目标或运行所有权已经变化")
        }
        let route = self.agent_route_key(&expected).await?;
        run_store_task(self.store("agent recovery")?, move |store| {
            if store
                .get_agent_checkpoint(&lease.run_id)?
                .and_then(|record| record.route_key)
                .as_deref()
                != Some(&route)
            {
                bail!("连接路由已经变化")
            }
            store.confirm_agent_recovery(&lease.run_id, expected_sequence, expected, resolutions)
        })
        .await
    }
    pub async fn reply_agent_run(
        &self,
        expected: ExecutionTarget,
        run_id: String,
        expected_sequence: u64,
        reply: AgentRunReply,
    ) -> Result<AgentRecoverySession> {
        reply.validate()?;
        if self.command_execution_target(&expected.session_id).await? != expected {
            bail!("任务回复目标已经变化")
        }
        let route = self.agent_route_key(&expected).await?;
        let mut owners = self.agent_runs.lock().await;
        if owners.contains_key(&run_id) {
            bail!("任务仍由另一个窗口执行或观察")
        }
        let target = expected.clone();
        let (checkpoint, lock) = run_store_task(self.store("agent reply")?, move |store| {
            let lock = store.lock_agent_run(&run_id)?;
            let checkpoint =
                store.reply_agent_checkpoint(&run_id, expected_sequence, target, &route, reply)?;
            Ok((checkpoint, lock))
        })
        .await?;
        let lease = AgentRunLease {
            run_id: checkpoint.run_id.clone(),
            token: uuid::Uuid::new_v4().to_string(),
            sequence: checkpoint.sequence,
        };
        owners.insert(
            checkpoint.run_id.clone(),
            AgentRunOwner {
                token: lease.token.clone(),
                target: expected,
                _lock: lock,
            },
        );
        Ok(AgentRecoverySession { lease, checkpoint })
    }

    pub async fn begin_agent_run(
        &self,
        expected: ExecutionTarget,
        start: AgentRunStart,
    ) -> Result<AgentRunLease> {
        start.validate()?;
        if self.command_execution_target(&expected.session_id).await? != expected {
            bail!("任务目标已变化")
        }
        let mut owners = self.agent_runs.lock().await;
        if owners.contains_key(&start.run_id) {
            bail!("此任务已有活动执行者")
        }
        let store = self.store("agent checkpoints")?;
        let route_key = self.agent_route_key(&expected).await?;
        let target = expected.clone();
        let (checkpoint, lock) = run_store_task(store, move |store| {
            let lock = store.lock_agent_run(&start.run_id)?;
            let checkpoint = AgentCheckpoint {
                user_inputs: vec![],
                route_key: Some(route_key),
                last_target: Some(target.clone()),
                recovery: None,
                resolved_effects: vec![],
                run_id: start.run_id,
                workspace_session_id: start.workspace_session_id,
                message_id: start.message_id,
                goal: start.goal,
                target,
                sequence: 0,
                boundary: "started".into(),
                step_id: None,
                state: AgentCheckpointState {
                    status: "calling-model".into(),
                    ..Default::default()
                },
                created_at: now_ms(),
                updated_at: now_ms(),
            };
            store.create_agent_checkpoint(&checkpoint)?;
            Ok((checkpoint, lock))
        })
        .await?;
        let lease = AgentRunLease {
            run_id: checkpoint.run_id.clone(),
            token: uuid::Uuid::new_v4().to_string(),
            sequence: 0,
        };
        owners.insert(
            checkpoint.run_id,
            AgentRunOwner {
                token: lease.token.clone(),
                target: expected,
                _lock: lock,
            },
        );
        Ok(lease)
    }
    pub async fn save_agent_checkpoint(
        &self,
        lease: AgentRunLease,
        mut update: AgentCheckpointUpdate,
    ) -> Result<u64> {
        let mut owners = self.agent_runs.lock().await;
        let owner = owners
            .get(&lease.run_id)
            .ok_or_else(|| anyhow::anyhow!("运行所有权已失效"))?;
        if owner.token != lease.token {
            bail!("运行所有权不匹配")
        }
        let mut dispatch_target = None;
        if update.boundary == "before-dispatch" || update.boundary == "prepared" {
            let target = self
                .command_execution_target(&owner.target.session_id)
                .await?;
            if target.session_instance != owner.target.session_instance
                || target.profile_id != owner.target.profile_id
                || target.route_version != owner.target.route_version
            {
                bail!("任务原连接已失效，不能继续派发")
            }
            dispatch_target = Some(target);
        }
        let script = if let Some(reference) = update.script_intent.take() {
            let target = dispatch_target
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("脚本来源只能在派发前绑定"))?;
            let step = update
                .state
                .steps
                .iter()
                .find(|step| Some(&step.id) == update.step_id.as_ref())
                .ok_or_else(|| anyhow::anyhow!("脚本来源步骤不存在"))?;
            if step.tool_name != "run_command"
                || reference.target != *target
                || reference.operation != crate::domain::command_policy::OperationKind::Command
            {
                bail!("脚本来源与当前命令目标不一致")
            }
            let mut sessions = self.sessions.lock().await;
            let record = super::session_mut(&mut sessions, &target.session_id)?;
            if record.execution_target != *target {
                bail!("脚本来源目标已经变化")
            }
            Some(record.intents.reusable_source_for_step(
                &reference,
                target,
                &step.command,
                step.sensitive,
            )?)
        } else {
            None
        };
        let run_id = lease.run_id.clone();
        let finished = update.boundary == "finished";
        let checkpoint = run_store_task(self.store("agent checkpoints")?, move |store| {
            store.update_agent_checkpoint_with_source(&run_id, update, dispatch_target, script)
        })
        .await?;
        if finished {
            owners.remove(&lease.run_id);
        }
        Ok(checkpoint.sequence)
    }
    pub async fn release_agent_run(&self, lease: AgentRunLease) -> Result<()> {
        let mut owners = self.agent_runs.lock().await;
        if let Some(owner) = owners.get(&lease.run_id) {
            if owner.token != lease.token {
                bail!("运行所有权不匹配")
            }
            owners.remove(&lease.run_id);
        }
        Ok(())
    }
    pub async fn list_agent_checkpoints(
        &self,
        profile_id: String,
        workspace_session_id: String,
    ) -> Result<Vec<AgentCheckpoint>> {
        run_store_task(self.store("agent checkpoints")?, move |store| {
            store.list_agent_checkpoints(&profile_id, &workspace_session_id)
        })
        .await
    }
}
