//! Durable task facts. This is deliberately separate from model request/config
//! and approval types: a recovered checkpoint conveys no execution authority.
use crate::domain::command_policy::{CommandScriptSource, ExecutionTarget, IntentReference};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunStart {
    pub run_id: String,
    pub workspace_session_id: String,
    pub message_id: String,
    pub goal: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunReply {
    pub message_id: String,
    pub assistant_message_id: String,
    pub text: String,
    #[serde(default)]
    pub confirmed_plan_item_ids: Vec<String>,
}
impl AgentRunReply {
    pub fn validate(&self) -> Result<()> {
        if self.message_id.is_empty()
            || self.message_id.len() > 256
            || self.assistant_message_id.is_empty()
            || self.assistant_message_id.len() > 256
            || self.message_id == self.assistant_message_id
            || self.text.trim().is_empty()
            || self.text.len() > 8192
            || self.text.contains('\0')
            || self.confirmed_plan_item_ids.len() > 12
            || self
                .confirmed_plan_item_ids
                .iter()
                .any(|id| id.is_empty() || id.len() > 256 || id.chars().any(char::is_control))
        {
            bail!("任务回复需要有效消息标识和不超过 8 KiB 的文字")
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentUserInput {
    pub message_id: String,
    pub question: String,
    pub text: String,
    pub redacted: bool,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub confirmed_plan_items: Vec<UserConfirmedPlanItem>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserConfirmedPlanItem {
    pub id: String,
    pub description: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanUserConfirmation {
    pub message_id: String,
    pub confirmed_at: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCheckpointStep {
    #[serde(default)]
    pub script_source: Option<CommandScriptSource>,
    #[serde(default)]
    pub execution_target: Option<ExecutionTarget>,
    #[serde(default)]
    pub recovery_inspection: bool,
    pub id: String,
    pub tool_name: String,
    pub command: String,
    pub reason: String,
    pub sensitive: bool,
    pub status: String,
    pub execution_phase: String,
    pub output: Option<String>,
    pub output_truncated: bool,
    pub exit_code: Option<i32>,
    pub failure_reason: Option<String>,
    pub working_directory: Option<String>,
    pub file_read: Option<CheckpointFileRead>,
    pub file_edits: Vec<CheckpointFileEdit>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointFileRead {
    #[serde(default)]
    pub absent: bool,
    pub path: String,
    pub resolved_path: Option<String>,
    pub revision: Option<String>,
    pub environment_scope: Option<String>,
    pub complete: bool,
    pub changed_during_read: bool,
    pub content: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointFileEdit {
    pub change_id: Option<String>,
    pub path: Option<String>,
    pub environment_scope: Option<String>,
    pub revision: Option<String>,
    pub status: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointPlanItem {
    pub id: String,
    pub description: String,
    pub status: String,
    pub step_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_confirmation: Option<PlanUserConfirmation>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointPlanChange {
    pub version: u64,
    pub reason: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointPlan {
    pub version: u64,
    pub reason: String,
    pub items: Vec<CheckpointPlanItem>,
    pub changes: Vec<CheckpointPlanChange>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointCheck {
    pub kind: String,
    pub expected: String,
    pub step_id: Option<String>,
    pub stream: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointVerification {
    pub id: String,
    pub purpose: String,
    pub required: bool,
    pub check: CheckpointCheck,
    pub status: String,
    pub actual: String,
    pub observed_at: u64,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCheckpointState {
    pub status: String,
    pub steps: Vec<AgentCheckpointStep>,
    pub plan: Option<CheckpointPlan>,
    pub verifications: Vec<CheckpointVerification>,
    pub final_text: String,
    pub error: Option<String>,
    pub stop_reason: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCheckpointUpdate {
    /// Ephemeral linkage, consumed by AppState before persistence.
    #[serde(default)]
    pub script_intent: Option<IntentReference>,
    pub expected_sequence: u64,
    pub boundary: String,
    pub step_id: Option<String>,
    pub state: AgentCheckpointState,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCheckpoint {
    #[serde(default)]
    pub user_inputs: Vec<AgentUserInput>,
    #[serde(default)]
    pub route_key: Option<String>,
    #[serde(default)]
    pub last_target: Option<ExecutionTarget>,
    #[serde(default)]
    pub recovery: Option<super::recovery::AgentRecovery>,
    #[serde(default)]
    pub resolved_effects: Vec<super::recovery::RecoveryResolution>,
    pub run_id: String,
    pub workspace_session_id: String,
    pub message_id: String,
    pub goal: String,
    pub target: ExecutionTarget,
    pub sequence: u64,
    pub boundary: String,
    pub step_id: Option<String>,
    pub state: AgentCheckpointState,
    pub created_at: u64,
    pub updated_at: u64,
}
impl AgentRunStart {
    pub fn validate(&self) -> Result<()> {
        uuid::Uuid::parse_str(&self.run_id)?;
        if self.goal.trim().is_empty()
            || self.goal.len() > 65536
            || self.message_id.is_empty()
            || self.message_id.len() > 256
            || self.workspace_session_id.is_empty()
            || self.workspace_session_id.len() > 256
        {
            bail!("任务检查点标识或目标超过预算")
        }
        Ok(())
    }
}
impl AgentCheckpointUpdate {
    pub fn sanitize(&mut self) -> Result<()> {
        self.script_intent = None;
        if ![
            "prepared",
            "before-dispatch",
            "observing",
            "result",
            "progress",
            "finished",
        ]
        .contains(&self.boundary.as_str())
        {
            bail!("未知检查点边界")
        }
        if ![
            "calling-model",
            "awaiting-approval",
            "executing",
            "awaiting-user",
            "waiting-input",
            "done",
            "stopped",
            "error",
        ]
        .contains(&self.state.status.as_str())
        {
            bail!("未知任务状态")
        }
        if self.state.steps.len() > 1000
            || self.state.verifications.len() > 12
            || self
                .state
                .plan
                .as_ref()
                .is_some_and(|p| p.items.len() > 12 || p.changes.len() > 8)
        {
            bail!("任务检查点超过条目预算")
        }
        let mut ids = std::collections::HashSet::new();
        if let Some(plan) = &mut self.state.plan {
            for item in &mut plan.items {
                // Only native reply records can supply user attribution.
                item.user_confirmation = None;
            }
        }
        for step in &mut self.state.steps {
            // Only the live intent store may supply reusable command source.
            step.script_source = None;
            if step.id.is_empty() || step.id.len() > 256 || !ids.insert(step.id.clone()) {
                bail!("检查点步骤 ID 无效或重复")
            }
            if ![
                "run_command",
                "run_ssh_task",
                "read_file",
                "list_directory",
                "apply_patch",
                "write_file",
                "delete_file",
                "restore_file",
            ]
            .contains(&step.tool_name.as_str())
                || !["not-started", "dispatching", "running", "finished"]
                    .contains(&step.execution_phase.as_str())
                || ![
                    "pending",
                    "running",
                    "completed",
                    "skipped",
                    "timeout",
                    "failed",
                ]
                .contains(&step.status.as_str())
            {
                bail!("检查点步骤类型或阶段无效")
            }
            if step.file_edits.len() > 8
                || step.command.len() > 65536
                || step.output.as_ref().is_some_and(|s| s.len() > 262144)
                || step
                    .file_read
                    .as_ref()
                    .and_then(|r| r.content.as_ref())
                    .is_some_and(|s| s.len() > 65536)
            {
                bail!("检查点步骤内容超过预算")
            }
        }
        if self.step_id.as_ref().is_some_and(|id| !ids.contains(id)) {
            bail!("检查点引用了不存在的步骤")
        }
        self.state.redact_sensitive();
        if serde_json::to_vec(self)?.len() > 4 * 1024 * 1024 {
            bail!("任务检查点超过 4 MiB 预算")
        }
        Ok(())
    }
}
impl AgentCheckpointState {
    pub(crate) fn redact_sensitive(&mut self) {
        for step in self.steps.iter_mut().filter(|step| step.sensitive) {
            step.command = "[敏感命令未存储]".into();
            step.reason = "[敏感步骤说明未存储]".into();
            if step.failure_reason.is_some() {
                step.failure_reason = Some("[敏感失败详情未存储]".into());
            }
            step.output = None;
            if let Some(read) = &mut step.file_read {
                read.content = None;
            }
            for verification in &mut self.verifications {
                if verification.check.step_id.as_deref() == Some(&step.id) {
                    verification.check.expected = "[敏感预期未存储]".into();
                    verification.actual = "[敏感证据未存储]".into();
                    verification.purpose = "核对敏感步骤结果".into();
                    verification.status = "unavailable".into();
                }
            }
        }
    }
}
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
