use super::sqlite::SqliteConfigStore;
use crate::domain::ai::checkpoints::*;
use crate::domain::ai::recovery::*;
use crate::domain::command_policy::{
    analyze_command, AnalysisBudget, CommandExportAnalysis, Decision, ExecutionTarget, ShellDialect,
};
use anyhow::{bail, Context, Result};
use rusqlite::{params, OptionalExtension};
use std::{
    fs::{File, OpenOptions},
    path::Path,
};

impl SqliteConfigStore {
    /// Held for the entire run, including approval/observation waits. The OS
    /// releases this on crash; there is no time lease that can expire mid-write.
    pub fn lock_agent_run(&self, run_id: &str) -> Result<File> {
        uuid::Uuid::parse_str(run_id)?;
        self.initialize()?;
        let database = Path::new(self.database_path()).canonicalize()?;
        let directory = database.with_extension("agent-runs");
        std::fs::create_dir_all(&directory)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options.open(directory.join(format!("{run_id}.lock")))?;
        lock.try_lock()
            .context("任务已由其他窗口或进程持有，请先结束其观察")?;
        Ok(lock)
    }
    pub fn create_agent_checkpoint(&self, checkpoint: &AgentCheckpoint) -> Result<()> {
        self.connection()?.execute("INSERT INTO agent_runs (run_id, profile_id, workspace_session_id, sequence, status, updated_at, payload) VALUES (?1,?2,?3,0,?4,?5,?6)", params![checkpoint.run_id, checkpoint.target.profile_id, checkpoint.workspace_session_id, checkpoint.state.status, checkpoint.updated_at, serde_json::to_string(checkpoint)?])?;
        Ok(())
    }
    pub fn update_agent_checkpoint(
        &self,
        run_id: &str,
        update: AgentCheckpointUpdate,
        dispatch_target: Option<ExecutionTarget>,
    ) -> Result<AgentCheckpoint> {
        self.update_agent_checkpoint_with_source(run_id, update, dispatch_target, None)
    }

    pub(crate) fn update_agent_checkpoint_with_source(
        &self,
        run_id: &str,
        mut update: AgentCheckpointUpdate,
        dispatch_target: Option<ExecutionTarget>,
        script: Option<CommandExportAnalysis>,
    ) -> Result<AgentCheckpoint> {
        update.sanitize()?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let payload: String = transaction.query_row(
            "SELECT payload FROM agent_runs WHERE run_id=?1",
            [run_id],
            |row| row.get(0),
        )?;
        let mut checkpoint: AgentCheckpoint = serde_json::from_str(&payload)?;
        if checkpoint.sequence != update.expected_sequence {
            bail!("检查点序号已变化，旧运行不能覆盖新记录")
        }
        if checkpoint.boundary == "finished" {
            bail!("已结束的运行不能继续写入检查点")
        }
        if let Some(plan) = &mut update.state.plan {
            for item in &mut plan.items {
                item.user_confirmation = checkpoint
                    .user_inputs
                    .iter()
                    .rev()
                    .find(|input| {
                        input.confirmed_plan_items.iter().any(|confirmed| {
                            confirmed.id == item.id && confirmed.description == item.description
                        })
                    })
                    .map(|input| PlanUserConfirmation {
                        message_id: input.message_id.clone(),
                        confirmed_at: input.created_at,
                    });
            }
        }
        let inspecting = checkpoint
            .recovery
            .as_ref()
            .is_some_and(|recovery| recovery.phase == "inspecting");
        if let Some(recovery) = &checkpoint.recovery {
            for id in &recovery.source_step_ids {
                let original = checkpoint
                    .state
                    .steps
                    .iter()
                    .find(|step| &step.id == id)
                    .ok_or_else(|| anyhow::anyhow!("原步骤记录缺失"))?;
                let incoming = update
                    .state
                    .steps
                    .iter_mut()
                    .find(|step| &step.id == id)
                    .ok_or_else(|| anyhow::anyhow!("不能丢弃恢复前的步骤记录"))?;
                *incoming = original.clone();
                if update.step_id.as_ref() == Some(id) && dispatch_target.is_some() {
                    bail!("历史步骤不能重新派发，检查必须使用新的步骤 ID")
                }
            }
            if inspecting {
                if let Some(target) = &dispatch_target {
                    same_recovery_environment(&recovery.current_target, target)?;
                }
            }
        }
        for step in &mut update.state.steps {
            let previous = checkpoint
                .state
                .steps
                .iter()
                .find(|saved| saved.id == step.id);
            step.execution_target = previous.and_then(|saved| saved.execution_target.clone());
            step.script_source = previous.and_then(|saved| saved.script_source.clone());
            step.sensitive |= previous.is_some_and(|saved| saved.sensitive);
            step.recovery_inspection = previous.is_some_and(|saved| saved.recovery_inspection);
            if update.step_id.as_deref() == Some(&step.id) {
                if let Some(target) = &dispatch_target {
                    if let Some(script) = &script {
                        if step.tool_name != "run_command"
                            || !["prepared", "before-dispatch"].contains(&update.boundary.as_str())
                        {
                            bail!("脚本来源只能绑定尚未派发的命令步骤")
                        }
                        // A step cannot switch to a different intent's source.
                        if let Some(saved) = &step.script_source {
                            if Some(saved) != script.source.as_ref() {
                                bail!("步骤脚本来源已经变化")
                            }
                        }
                        step.script_source = script.source.clone();
                        step.sensitive |= script.sensitive;
                    }
                    step.execution_target = Some(target.clone());
                    step.recovery_inspection = inspecting;
                    if inspecting && update.boundary == "before-dispatch" {
                        if !matches!(
                            step.tool_name.as_str(),
                            "read_file" | "list_directory" | "run_command"
                        ) {
                            bail!("恢复核对期间仅允许只读检查，不能修改或启动独立任务")
                        }
                        // Additional bounded syntax guard; the normal command
                        // policy still analyzes the actual shell and asks for approval.
                        if step.tool_name == "run_command"
                            && analyze_command(
                                &step.command,
                                ShellDialect::Bash,
                                AnalysisBudget::default(),
                            )
                            .decision
                                != Decision::Allow
                        {
                            bail!("恢复检查命令包含修改或未知行为")
                        }
                    }
                }
            }
        }
        update.state.redact_sensitive();
        if let Some(target) = dispatch_target {
            checkpoint.last_target = Some(target);
        }
        checkpoint.sequence += 1;
        checkpoint.boundary = update.boundary;
        checkpoint.step_id = update.step_id;
        checkpoint.state = update.state;
        checkpoint.updated_at = now_ms();
        if serde_json::to_vec(&checkpoint)?.len() > 4 * 1024 * 1024 {
            bail!("任务检查点超过 4 MiB 预算")
        }
        transaction.execute(
            "UPDATE agent_runs SET sequence=?2,status=?3,updated_at=?4,payload=?5 WHERE run_id=?1",
            params![
                run_id,
                checkpoint.sequence,
                checkpoint.state.status,
                checkpoint.updated_at,
                serde_json::to_string(&checkpoint)?
            ],
        )?;
        transaction.commit()?;
        Ok(checkpoint)
    }

    pub fn reopen_agent_checkpoint(
        &self,
        run_id: &str,
        expected_sequence: u64,
        current: ExecutionTarget,
        route_key: &str,
    ) -> Result<AgentCheckpoint> {
        let original = self
            .get_agent_checkpoint(run_id)?
            .ok_or_else(|| anyhow::anyhow!("任务记录不存在"))?;
        let mut file_results = std::collections::HashMap::new();
        for file in original
            .state
            .steps
            .iter()
            .flat_map(|step| &step.file_edits)
        {
            if let Some(id) = &file.change_id {
                if let Some(record) = self.get_agent_file_change(id)? {
                    file_results.insert(id.clone(), record);
                }
            }
        }
        self.change_agent_checkpoint(run_id, expected_sequence, |record| {
            if record.route_key.as_deref() != Some(route_key) {
                bail!("原任务缺少路由证据或连接路由已修改，不能直接恢复")
            }
            let previous = record
                .last_target
                .as_ref()
                .unwrap_or(&record.target)
                .clone();
            same_recovery_environment(&previous, &current)?;
            if !checkpoint_needs_attention(record) {
                bail!("任务已经结束")
            }
            for step in &mut record.state.steps {
                for file in &mut step.file_edits {
                    if let Some(result) =
                        file.change_id.as_ref().and_then(|id| file_results.get(id))
                    {
                        if result.target.profile_id == record.target.profile_id
                            && file.path.as_deref() == Some(&result.path)
                            && file.environment_scope.as_deref() == Some(&result.environment_scope)
                        {
                            use crate::domain::filesystem::agent_files::FileEditStatus;
                            if matches!(
                                result.outcome.status,
                                FileEditStatus::Applied
                                    | FileEditStatus::Conflict
                                    | FileEditStatus::Failed
                            ) {
                                file.status = match result.outcome.status {
                                    FileEditStatus::Applied => "applied",
                                    FileEditStatus::Conflict => "conflict",
                                    _ => "failed",
                                }
                                .into();
                                file.revision = result.outcome.revision.clone();
                            }
                        }
                    }
                }
                if !step.file_edits.is_empty() && !unknown_effect(step) {
                    step.execution_phase = "finished".into();
                    step.status = if step.file_edits.iter().all(|file| file.status == "applied") {
                        "completed"
                    } else {
                        "failed"
                    }
                    .into();
                }
            }
            let required_step_ids = record
                .state
                .steps
                .iter()
                .filter(|step| {
                    unknown_effect(step)
                        && !record
                            .resolved_effects
                            .iter()
                            .any(|resolved| resolved.step_id == step.id)
                })
                .map(|step| step.id.clone())
                .collect();
            record.recovery = Some(AgentRecovery {
                phase: "inspecting".into(),
                source_sequence: record.sequence,
                source_step_ids: record
                    .state
                    .steps
                    .iter()
                    .map(|step| step.id.clone())
                    .collect(),
                required_step_ids,
                original_target: previous,
                current_target: current,
                resolutions: vec![],
            });
            for check in &mut record.state.verifications {
                check.status = "unavailable".into();
                check.actual = "恢复后需要核对最新现场，历史验证不是当前状态".into();
            }
            record.state.status = "calling-model".into();
            record.state.error = None;
            record.state.stop_reason = None;
            record.state.final_text.clear();
            record.boundary = "recovering".into();
            record.step_id = None;
            Ok(())
        })
    }
    pub fn confirm_agent_recovery(
        &self,
        run_id: &str,
        expected_sequence: u64,
        current: ExecutionTarget,
        mut resolutions: Vec<RecoveryResolution>,
    ) -> Result<AgentCheckpoint> {
        self.change_agent_checkpoint(run_id, expected_sequence, |record| {
            let recovery = record
                .recovery
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("任务未进入恢复核对"))?;
            if recovery.current_target.session_instance != current.session_instance
                || recovery.current_target.context != current.context
            {
                bail!("核对后目标环境再次变化，请重新开始恢复检查")
            }
            validate_recovery_resolutions(record, &resolutions)?;
            for resolution in &mut resolutions {
                if record.state.steps.iter().any(|step| {
                    step.sensitive
                        && (step.id == resolution.step_id
                            || resolution.evidence_step_ids.contains(&step.id))
                }) {
                    resolution.observation = "[敏感检查结论未存储，请重新核对现场]".into();
                }
            }
            record.resolved_effects.extend(resolutions.clone());
            let recovery = record.recovery.as_mut().unwrap();
            recovery.phase = "continuing".into();
            recovery.resolutions = resolutions;
            record.boundary = "resumed".into();
            record.state.status = "calling-model".into();
            Ok(())
        })
    }
    /// Explicitly answering a saved question resumes the same goal and plan.
    /// Unknown effects or a replaced session still enter the recovery review.
    pub fn reply_agent_checkpoint(
        &self,
        run_id: &str,
        expected_sequence: u64,
        current: ExecutionTarget,
        route_key: &str,
        reply: AgentRunReply,
    ) -> Result<AgentCheckpoint> {
        reply.validate()?;
        let sensitive = crate::domain::command_policy::analyze_reusable_command(
            &reply.text,
            ShellDialect::Bash,
        )
        .sensitive;
        self.change_agent_checkpoint(run_id, expected_sequence, |record| {
            if record.state.status != "waiting-input" || record.boundary != "finished" {
                bail!("任务当前没有等待回复，请重新载入任务记录")
            }
            if record.route_key.as_deref() != Some(route_key) {
                bail!("任务路由已经变化，不能直接接续")
            }
            let previous = record
                .last_target
                .as_ref()
                .unwrap_or(&record.target)
                .clone();
            same_recovery_environment(&previous, &current)?;
            if record.user_inputs.len() >= 32
                || record
                    .user_inputs
                    .iter()
                    .map(|input| input.text.len() + input.question.len())
                    .sum::<usize>()
                    + reply.text.len()
                    + record.state.final_text.len()
                    > 65536
                || record
                    .user_inputs
                    .iter()
                    .any(|input| input.message_id == reply.message_id)
            {
                bail!("任务回复重复或超过上下文预算")
            }
            let required_step_ids: Vec<_> = record
                .state
                .steps
                .iter()
                .filter(|step| {
                    unknown_effect(step)
                        && !record
                            .resolved_effects
                            .iter()
                            .any(|resolved| resolved.step_id == step.id)
                })
                .map(|step| step.id.clone())
                .collect();
            let inspecting = !required_step_ids.is_empty()
                || previous.session_instance != current.session_instance
                || previous.context.shell != current.context.shell;
            let mut confirmed_plan_items = Vec::new();
            let confirmed_at = now_ms();
            let mut confirmed_ids = std::collections::HashSet::new();
            for id in &reply.confirmed_plan_item_ids {
                if !confirmed_ids.insert(id) {
                    bail!("确认的计划项不能重复")
                }
                let item = record
                    .state
                    .plan
                    .as_ref()
                    .and_then(|plan| plan.items.iter().find(|item| &item.id == id))
                    .ok_or_else(|| anyhow::anyhow!("确认的计划项不存在，请重新载入计划"))?;
                if matches!(item.status.as_str(), "completed" | "cancelled" | "skipped") {
                    bail!("只能确认当前尚未完成的计划项")
                }
                confirmed_plan_items.push(UserConfirmedPlanItem {
                    id: item.id.clone(),
                    description: item.description.clone(),
                });
            }
            if !confirmed_plan_items.is_empty() {
                let plan = record.state.plan.as_mut().unwrap();
                plan.version = plan
                    .version
                    .checked_add(1)
                    .ok_or_else(|| anyhow::anyhow!("计划版本超出范围"))?;
                plan.reason = "用户在回复任务问题时确认了已完成事项".into();
                plan.changes.push(CheckpointPlanChange {
                    version: plan.version,
                    reason: plan.reason.clone(),
                });
                if plan.changes.len() > 8 {
                    plan.changes.drain(..plan.changes.len() - 8);
                }
                for item in &mut plan.items {
                    if confirmed_ids.contains(&item.id) {
                        item.status = "completed".into();
                        item.user_confirmation = Some(PlanUserConfirmation {
                            message_id: reply.message_id.clone(),
                            confirmed_at,
                        });
                    }
                }
            }
            record.user_inputs.push(AgentUserInput {
                question: if crate::domain::command_policy::analyze_reusable_command(
                    &record.state.final_text,
                    ShellDialect::Bash,
                )
                .sensitive
                {
                    "[敏感问题原文未存储]".into()
                } else {
                    record.state.final_text.clone()
                },
                message_id: reply.message_id,
                text: if sensitive {
                    "[敏感回复未存储，需要时请重新提供]".into()
                } else {
                    reply.text
                },
                redacted: sensitive,
                created_at: confirmed_at,
                confirmed_plan_items,
            });
            record.recovery = Some(AgentRecovery {
                phase: if inspecting {
                    "inspecting"
                } else {
                    "continuing"
                }
                .into(),
                source_sequence: record.sequence,
                source_step_ids: record
                    .state
                    .steps
                    .iter()
                    .map(|step| step.id.clone())
                    .collect(),
                required_step_ids,
                original_target: previous,
                current_target: current.clone(),
                resolutions: vec![],
            });
            // Waiting releases the terminal: old observations may have changed.
            for check in &mut record.state.verifications {
                check.status = "unavailable".into();
                check.actual = "等待回复后需核对最新现场，历史验证不是本次结果".into();
            }
            record.last_target = Some(current);
            record.message_id = reply.assistant_message_id;
            record.state.status = "calling-model".into();
            record.state.error = None;
            record.state.stop_reason = None;
            record.state.final_text.clear();
            record.boundary = if inspecting { "recovering" } else { "resumed" }.into();
            record.step_id = None;
            Ok(())
        })
    }
    fn change_agent_checkpoint(
        &self,
        run_id: &str,
        expected_sequence: u64,
        change: impl FnOnce(&mut AgentCheckpoint) -> Result<()>,
    ) -> Result<AgentCheckpoint> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let payload: String = transaction.query_row(
            "SELECT payload FROM agent_runs WHERE run_id=?1",
            [run_id],
            |row| row.get(0),
        )?;
        let mut record: AgentCheckpoint = serde_json::from_str(&payload)?;
        if record.sequence != expected_sequence {
            bail!("任务记录已经变化，请重新载入")
        }
        change(&mut record)?;
        record.sequence += 1;
        record.updated_at = now_ms();
        if serde_json::to_vec(&record)?.len() > 4 * 1024 * 1024 {
            bail!("任务检查点超过 4 MiB 预算")
        }
        transaction.execute(
            "UPDATE agent_runs SET sequence=?2,status=?3,updated_at=?4,payload=?5 WHERE run_id=?1",
            params![
                run_id,
                record.sequence,
                record.state.status,
                record.updated_at,
                serde_json::to_string(&record)?
            ],
        )?;
        transaction.commit()?;
        Ok(record)
    }
    pub fn get_agent_checkpoint(&self, run_id: &str) -> Result<Option<AgentCheckpoint>> {
        let json: Option<String> = self
            .connection()?
            .query_row(
                "SELECT payload FROM agent_runs WHERE run_id=?1",
                [run_id],
                |row| row.get(0),
            )
            .optional()?;
        json.map(|value| serde_json::from_str(&value).map_err(Into::into))
            .transpose()
    }
    pub fn completed_agent_checkpoint_for_message(
        &self,
        profile_id: &str,
        workspace_session_id: &str,
        message_id: &str,
    ) -> Result<Option<AgentCheckpoint>> {
        let json: Option<String> = self.connection()?.query_row(
            "SELECT payload FROM agent_runs WHERE profile_id=?1 AND workspace_session_id=?2 AND status='done' AND json_extract(payload, '$.messageId')=?3 AND json_extract(payload, '$.boundary')='finished' ORDER BY updated_at DESC, run_id DESC LIMIT 1",
            params![profile_id, workspace_session_id, message_id], |row| row.get(0)
        ).optional()?;
        json.map(|value| serde_json::from_str(&value).map_err(Into::into))
            .transpose()
    }
    pub fn list_agent_checkpoints(
        &self,
        profile_id: &str,
        workspace_session_id: &str,
    ) -> Result<Vec<AgentCheckpoint>> {
        let connection = self.connection()?;
        // Keep this predicate aligned with checkpoint_needs_attention. Filter
        // before LIMIT so archived runs cannot hide older unfinished work.
        let mut query = connection.prepare(
            "SELECT payload FROM agent_runs WHERE profile_id=?1 AND workspace_session_id=?2 AND (
                status <> 'done'
                OR EXISTS (SELECT 1 FROM json_each(payload, '$.state.plan.items')
                    WHERE json_extract(value, '$.status') NOT IN ('completed', 'skipped', 'cancelled'))
                OR EXISTS (SELECT 1 FROM json_each(payload, '$.state.steps') AS step
                    WHERE json_extract(step.value, '$.toolName') NOT IN ('read_file', 'list_directory')
                    AND NOT EXISTS (SELECT 1 FROM json_each(payload, '$.resolvedEffects') AS resolution
                        WHERE json_extract(resolution.value, '$.stepId') = json_extract(step.value, '$.id'))
                    AND (
                        EXISTS (SELECT 1 FROM json_each(step.value, '$.fileEdits') AS file
                            WHERE json_extract(file.value, '$.status') IN ('dispatching', 'unknown'))
                        OR (COALESCE(json_array_length(step.value, '$.fileEdits'), 0) = 0
                            AND json_extract(step.value, '$.executionPhase') <> 'not-started'
                            AND json_extract(step.value, '$.status') <> 'skipped'
                            AND (json_extract(step.value, '$.executionPhase') <> 'finished'
                                OR (json_extract(step.value, '$.toolName') IN ('run_command', 'run_ssh_task')
                                    AND json_extract(step.value, '$.exitCode') IS NULL)))
                    ))
            ) ORDER BY updated_at DESC,run_id DESC LIMIT 100",
        )?;
        let rows = query.query_map(params![profile_id, workspace_session_id], |row| {
            row.get::<_, String>(0)
        })?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }
}
