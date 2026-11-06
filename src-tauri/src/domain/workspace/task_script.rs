use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptTaskMetadata {
    pub version: u32,
    pub revision: u64,
    pub source: ScriptTaskSource,
    pub environment: ScriptTaskEnvironment,
    pub parameters: Vec<ScriptParameter>,
    pub checks: Vec<ScriptTaskCheck>,
    pub prerequisites: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub omitted_steps: Vec<ScriptTaskOmission>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub omitted_checks: Vec<ScriptTaskOmittedCheck>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptTaskOmittedCheck {
    pub id: String,
    pub step_id: Option<String>,
    pub required: bool,
    pub status: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptTaskOmission {
    pub step_id: String,
    pub tool: String,
    pub status: String,
    pub reason: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptTaskSource {
    pub run_id: String,
    pub message_id: String,
    pub workspace_session_id: String,
    pub step_ids: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptTaskEnvironment {
    pub profile_id: String,
    pub route_key: String,
    pub user: String,
    pub environment_scope: String,
    pub shell: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptParameter {
    pub name: String,
    pub label: String,
    pub r#type: String,
    pub default_value: Option<String>,
    pub required: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptTaskCheck {
    pub id: String,
    pub purpose: String,
    pub kind: String,
    pub expected: String,
    pub step_id: Option<String>,
    pub required: bool,
    pub status: String,
}
impl ScriptTaskMetadata {
    /// Provenance is documentation, never approval or an execution capability.
    pub fn sanitize(&mut self) -> Result<()> {
        if self.version != 1
            || self.revision == 0
            || self.source.step_ids.is_empty()
            || self.source.step_ids.len() > 64
            || self.parameters.len() > 32
            || self.checks.len() + self.omitted_checks.len() > 12
            || self.prerequisites.len() > 32
            || self.source.step_ids.len() + self.omitted_steps.len() > 1000
        {
            bail!("脚本来源或参数格式超过预算")
        }
        uuid::Uuid::parse_str(&self.source.run_id)?;
        let mut step_ids = std::collections::HashSet::new();
        for id in &self.source.step_ids {
            if id.is_empty() || id.len() > 256 || !step_ids.insert(id) {
                bail!("脚本来源步骤标识无效或重复")
            }
        }
        for item in &self.omitted_steps {
            if item.step_id.is_empty()
                || item.step_id.len() > 256
                || !step_ids.insert(&item.step_id)
                || ![
                    "run_command",
                    "run_ssh_task",
                    "read_file",
                    "list_directory",
                    "apply_patch",
                    "write_file",
                    "delete_file",
                    "restore_file",
                ]
                .contains(&item.tool.as_str())
                || ![
                    "pending",
                    "running",
                    "completed",
                    "skipped",
                    "timeout",
                    "failed",
                ]
                .contains(&item.status.as_str())
                || ![
                    "not-selected",
                    "different-environment",
                    "not-completed",
                    "unknown-exit",
                    "unsupported-tool",
                    "missing-environment",
                    "missing-file-evidence",
                    "unsupported-file",
                    "unsupported-shell",
                    "sensitive-source",
                    "invalid-source",
                    "unsupported-command",
                    "session-state",
                ]
                .contains(&item.reason.as_str())
            {
                bail!("脚本待整理来源无效；只能保留唯一来源标识、工具、状态和固定原因")
            }
        }
        let mut check_ids: std::collections::HashSet<_> =
            self.checks.iter().map(|check| &check.id).collect();
        for check in &self.omitted_checks {
            if check.id.is_empty()
                || check.id.len() > 256
                || !check_ids.insert(&check.id)
                || check.step_id.as_ref().is_some_and(|id| {
                    id.is_empty()
                        || id.len() > 256
                        || !step_ids.contains(id)
                        || self.source.step_ids.contains(id)
                })
                || !["pending", "passed", "failed", "unavailable"].contains(&check.status.as_str())
            {
                bail!("未纳入的验证来源无效或与已选择的证据重复")
            }
        }
        let mut names = std::collections::HashSet::new();
        for parameter in &mut self.parameters {
            if parameter.name.is_empty()
                || parameter.name.len() > 64
                || !parameter.name.as_bytes()[0].is_ascii_uppercase()
                || !parameter
                    .name
                    .bytes()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
                || !names.insert(parameter.name.clone())
                || !["directory", "service", "text", "secret"].contains(&parameter.r#type.as_str())
                || parameter
                    .default_value
                    .as_ref()
                    .is_some_and(|value| value.len() > 16384 || value.contains('\0'))
            {
                bail!("脚本参数无效")
            }
            if parameter.r#type == "secret" {
                parameter.default_value = None;
            }
        }
        // A checkpoint can contain 1000 steps. Keep all omitted references in
        // the saved provenance; executable script source retains its own 64 KiB limit.
        if serde_json::to_vec(self)?.len() > 512 * 1024 {
            bail!("脚本来源元数据超过 512 KiB")
        }
        Ok(())
    }
}
