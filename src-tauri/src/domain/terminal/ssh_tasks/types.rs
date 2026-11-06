use std::collections::BTreeMap;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use crate::domain::command_policy::{CommandAnalysis, ExecutionTarget};
use crate::domain::connection::models::{ConnectionProfile, JumpMode};

pub const MAX_TASK_OUTPUT_BYTES: usize = 64 * 1024;
pub const DEFAULT_TASK_PATH: &str = "/usr/local/bin:/usr/bin:/bin";

fn default_timeout() -> u64 {
    120_000
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshTaskRequest {
    pub command: String,
    pub working_directory: String,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
}

impl SshTaskRequest {
    pub fn validate(&self) -> Result<()> {
        if self.command.trim().is_empty()
            || self.command.len() > 64 * 1024
            || self
                .command
                .chars()
                .any(|c| c == '\0' || (c.is_control() && !matches!(c, '\n' | '\r' | '\t')))
        {
            bail!("独立任务命令为空、包含控制字符或超过 64 KiB");
        }
        if !self.working_directory.starts_with('/')
            || self.working_directory.len() > 4096
            || self.working_directory.chars().any(char::is_control)
        {
            bail!("独立任务需要显式的 POSIX 绝对工作目录");
        }
        if !(1_000..=600_000).contains(&self.timeout_ms) {
            bail!("独立任务观察时限必须为 1—600 秒");
        }
        if self.environment.len() > 32
            || self
                .environment
                .iter()
                .map(|(k, v)| k.len() + v.len())
                .sum::<usize>()
                > 16 * 1024
        {
            bail!("独立任务环境超过 32 项或 16 KiB");
        }
        for (key, value) in &self.environment {
            if key.is_empty()
                || !key.bytes().enumerate().all(|(i, c)| {
                    c == b'_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit())
                })
                || value.contains('\0')
            {
                bail!("无效的独立任务环境变量");
            }
        }
        Ok(())
    }

    pub fn effective_environment(&self) -> BTreeMap<String, String> {
        let mut environment = self.environment.clone();
        environment
            .entry("PATH".into())
            .or_insert_with(|| DEFAULT_TASK_PATH.into());
        environment
    }
}

/// A display-only route description; passwords/key references are never sent.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshTaskTarget {
    pub profile_id: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub gateway: Option<String>,
}

impl SshTaskTarget {
    pub fn from_profile(profile: &ConnectionProfile) -> Result<Self> {
        if profile.jump_mode == JumpMode::InteractiveMenu
            && !profile.menu_profile_id.trim().is_empty()
        {
            bail!("交互菜单连接不能直接映射到独立 SSH 任务，请使用当前终端");
        }
        if profile.target.host.trim().is_empty() || profile.target.username.trim().is_empty() {
            bail!("独立 SSH 任务需要明确的登录主机和账号");
        }
        Ok(Self {
            profile_id: profile.id.clone(),
            host: profile.target.host.clone(),
            port: profile.target.port.unwrap_or(22),
            user: profile.target.username.clone(),
            gateway: (profile.jump_mode == JumpMode::InteractiveMenu).then(|| {
                format!(
                    "{}@{}:{}",
                    profile.gateway.username,
                    profile.gateway.host,
                    profile.gateway.port.unwrap_or(22)
                )
            }),
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshTaskReference {
    pub id: String,
    pub origin: ExecutionTarget,
    pub policy_version: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTaskIntent {
    pub reference: SshTaskReference,
    pub request: SshTaskRequest,
    pub target: SshTaskTarget,
    pub effective_environment: BTreeMap<String, String>,
    pub analysis: CommandAnalysis,
    pub expires_in_ms: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SshTaskStatus {
    Connecting,
    Running,
    Completed,
    NotStarted,
    Unknown,
}

impl SshTaskStatus {
    pub fn is_finished(self) -> bool {
        !matches!(self, Self::Connecting | Self::Running)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTaskSnapshot {
    pub reference: SshTaskReference,
    pub target: SshTaskTarget,
    pub sequence: u64,
    pub status: SshTaskStatus,
    pub stdout: String,
    pub stderr: String,
    pub output_bytes: usize,
    pub truncated: bool,
    pub exit_code: Option<i32>,
    pub exit_signal: Option<String>,
    /// libssh2 reports zero even when the server omits exit-status. Completion
    /// therefore requires the fixed wrapper's fresh exit trailer and EOF/close.
    pub exit_evidence: Option<String>,
    pub reason: Option<String>,
    pub started_at: u64,
    pub finished_at: Option<u64>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SshTaskStream {
    Stdout,
    Stderr,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTaskEvent {
    pub reference: SshTaskReference,
    pub sequence: u64,
    pub status: SshTaskStatus,
    pub stream: Option<SshTaskStream>,
    pub delta: String,
    pub truncated: bool,
}
