use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ShellDialect {
    Bash,
    Posix,
    Zsh,
    Powershell,
    Cmd,
    #[default]
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AnalysisStatus {
    Complete,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Allow,
    Ask,
    Deny,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum RiskSeverity {
    Medium,
    High,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RiskKind {
    Delete,
    Edit,
    Reboot,
    Upgrade,
    Service,
    Network,
    Permission,
    Disk,
    Execution,
}

/// Byte offsets are UTF-8; lines and UTF-16 columns are one-based for the UI.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceRange {
    pub start_byte: usize,
    pub end_byte: usize,
    pub start_line: usize,
    pub start_column: usize,
    pub end_line: usize,
    pub end_column: usize,
}

impl SourceRange {
    pub fn new(source: &str, start: usize, end: usize) -> Self {
        let position = |offset: usize| {
            let prefix = &source[..offset];
            (
                prefix.bytes().filter(|b| *b == b'\n').count() + 1,
                prefix
                    .rsplit('\n')
                    .next()
                    .unwrap_or("")
                    .encode_utf16()
                    .count()
                    + 1,
            )
        };
        let (start_line, start_column) = position(start);
        let (end_line, end_column) = position(end);
        Self {
            start_byte: start,
            end_byte: end,
            start_line,
            start_column,
            end_line,
            end_column,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandRisk {
    pub rule_id: String,
    pub kind: RiskKind,
    pub severity: RiskSeverity,
    pub message: String,
    pub range: SourceRange,
    pub targets: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisIssue {
    pub code: String,
    pub message: String,
    pub range: SourceRange,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandAnalysis {
    pub analysis_status: AnalysisStatus,
    pub decision: Decision,
    pub risks: Vec<CommandRisk>,
    pub unknown_reasons: Vec<AnalysisIssue>,
    pub highest_severity: Option<RiskSeverity>,
    pub policy_version: String,
}

/// Reported shell context is useful for binding, but not proof of remote identity.
/// Unknown fields remain unknown rather than borrowing the SSH login environment.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionContext {
    pub shell: ShellDialect,
    pub working_directory: Option<String>,
    pub user: Option<String>,
    pub environment_scope: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionTarget {
    pub session_id: String,
    pub session_instance: String,
    pub profile_id: String,
    pub route_version: u64,
    pub context_version: u64,
    pub context: ExecutionContext,
}

impl ExecutionTarget {
    pub fn new(session_id: String, profile_id: String) -> Self {
        Self {
            session_id,
            session_instance: uuid::Uuid::new_v4().to_string(),
            profile_id,
            route_version: 0,
            context_version: 0,
            context: ExecutionContext::default(),
        }
    }

    pub fn invalidate_context(&mut self) {
        self.context_version += 1;
        self.context = ExecutionContext::default();
    }
}
