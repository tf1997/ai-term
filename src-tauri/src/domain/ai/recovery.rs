use super::checkpoints::*;
use crate::domain::command_policy::ExecutionTarget;
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryResolution {
    pub step_id: String,
    pub evidence_step_ids: Vec<String>,
    /// A human description of the observed current state, not an invented exit code.
    pub observation: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRecovery {
    pub phase: String,
    pub source_sequence: u64,
    pub source_step_ids: Vec<String>,
    pub required_step_ids: Vec<String>,
    pub original_target: ExecutionTarget,
    pub current_target: ExecutionTarget,
    pub resolutions: Vec<RecoveryResolution>,
}

pub fn unknown_effect(step: &AgentCheckpointStep) -> bool {
    if matches!(step.tool_name.as_str(), "read_file" | "list_directory") {
        return false;
    }
    if !step.file_edits.is_empty() {
        return step
            .file_edits
            .iter()
            .any(|file| matches!(file.status.as_str(), "dispatching" | "unknown"));
    }
    if step.execution_phase == "not-started" || step.status == "skipped" {
        return false;
    }
    step.execution_phase != "finished"
        || (matches!(step.tool_name.as_str(), "run_command" | "run_ssh_task")
            && step.exit_code.is_none())
}

/// A finished reply can still leave work or unobserved effects to reconcile.
/// Cancelled/skipped plan items are history, never successful execution evidence.
pub fn checkpoint_needs_attention(record: &AgentCheckpoint) -> bool {
    record.state.status != "done"
        || record.state.plan.as_ref().is_some_and(|plan| {
            plan.items
                .iter()
                .any(|item| !matches!(item.status.as_str(), "completed" | "skipped" | "cancelled"))
        })
        || record.state.steps.iter().any(|step| {
            unknown_effect(step)
                && !record
                    .resolved_effects
                    .iter()
                    .any(|item| item.step_id == step.id)
        })
}
pub fn same_recovery_environment(
    previous: &ExecutionTarget,
    current: &ExecutionTarget,
) -> Result<()> {
    if previous.profile_id != current.profile_id {
        bail!("恢复目标与原连接不同")
    }
    let old = &previous.context;
    let new = &current.context;
    if old.user.is_none()
        || old.environment_scope.is_none()
        || new.user.is_none()
        || new.environment_scope.is_none()
        || new.working_directory.is_none()
    {
        bail!("缺少可比较的主机、账号或环境证据，请先确认原目标环境")
    }
    if old.user != new.user || old.environment_scope != new.environment_scope {
        bail!("当前账号、主机或容器环境与原任务不同，请切换回原环境后再恢复")
    }
    Ok(())
}
pub fn validate_recovery_resolutions(
    record: &AgentCheckpoint,
    resolutions: &[RecoveryResolution],
) -> Result<()> {
    let recovery = record
        .recovery
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("任务尚未进入恢复检查"))?;
    if recovery.phase != "inspecting" {
        bail!("恢复确认已经消费")
    }
    let required: std::collections::HashSet<_> = recovery.required_step_ids.iter().collect();
    let mut resolved = std::collections::HashSet::new();
    for resolution in resolutions {
        if !required.contains(&resolution.step_id)
            || !resolved.insert(&resolution.step_id)
            || resolution.observation.trim().len() < 2
            || resolution.observation.chars().count() > 1000
            || resolution
                .observation
                .chars()
                .any(|ch| ch.is_control() && ch != '\n' && ch != '\t')
            || resolution.evidence_step_ids.is_empty()
            || resolution.evidence_step_ids.len() > 8
        {
            bail!("每个未知步骤需要当前检查依据和明确的现场结论")
        }
        for id in &resolution.evidence_step_ids {
            let step = record
                .state
                .steps
                .iter()
                .find(|step| &step.id == id)
                .ok_or_else(|| anyhow::anyhow!("核验依据不存在"))?;
            if recovery.source_step_ids.contains(id)
                || !step.recovery_inspection
                || !matches!(
                    step.tool_name.as_str(),
                    "read_file" | "list_directory" | "run_command"
                )
                || !(step.status == "completed" && step.execution_phase == "finished"
                    || step.file_read.as_ref().is_some_and(|read| read.absent))
            {
                bail!("只能引用恢复后实际完成的只读检查")
            }
            if step.execution_target.as_ref().is_none_or(|target| {
                target.session_instance != recovery.current_target.session_instance
                    || same_recovery_environment(target, &recovery.current_target).is_err()
            }) {
                bail!("核验依据来自不同环境")
            }
        }
        let original = record
            .state
            .steps
            .iter()
            .find(|step| step.id == resolution.step_id)
            .ok_or_else(|| anyhow::anyhow!("原步骤记录缺失"))?;
        for file in original
            .file_edits
            .iter()
            .filter(|file| matches!(file.status.as_str(), "dispatching" | "unknown"))
        {
            let matched = record
                .state
                .steps
                .iter()
                .filter(|step| resolution.evidence_step_ids.contains(&step.id))
                .filter_map(|step| step.file_read.as_ref())
                .any(|read| {
                    file.path.is_some()
                        && (file.path.as_ref() == read.resolved_path.as_ref()
                            || file.path.as_ref() == Some(&read.path))
                        && file.environment_scope.is_some()
                        && file.environment_scope == read.environment_scope
                        && (read.absent
                            || read.complete
                                && !read.changed_during_read
                                && read.revision.is_some())
                });
            if !matched {
                bail!("未知文件写入需要同路径、同环境的最新完整读取或已验证的不存在证据")
            }
        }
    }
    if resolved != required {
        bail!("仍有未知操作尚未核对，不能继续修改")
    }
    Ok(())
}
