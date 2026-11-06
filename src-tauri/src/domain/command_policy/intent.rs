use std::collections::HashMap;
use std::time::{Duration, Instant};

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use super::transport::{render_transport, CaptureKind, CaptureTransport, InternalProbe};
use super::{
    analyze_command, analyze_reusable_command, AnalysisBudget, AnalysisIssue, AnalysisStatus,
    CommandAnalysis, CommandExportAnalysis, Decision, ExecutionTarget, ShellDialect, SourceRange,
    POLICY_VERSION,
};

const MAX_PENDING_INTENTS: usize = 16;
const INTENT_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum OperationKind {
    Command,
    BashScript,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntentReference {
    pub id: String,
    pub operation: OperationKind,
    pub target: ExecutionTarget,
    pub policy_version: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandIntent {
    pub reference: IntentReference,
    pub source: String,
    pub source_sensitive: bool,
    pub operation: OperationKind,
    pub analysis: CommandAnalysis,
    pub expires_in_ms: u64,
    pub capture: CaptureTransport,
    /// For display/filtering only. Dispatch never accepts this field back.
    pub terminal_input: String,
}

// No approval state can be provided through deserialization or restored from
// persisted conversations. Only this store can issue and consume approval.
struct PendingIntent {
    export: CommandExportAnalysis,
    intent: CommandIntent,
    approved: bool,
    expires: Instant,
    preserves_context: bool,
}

pub struct PreparedIntent {
    export: CommandExportAnalysis,
    source: String,
    operation: OperationKind,
    target: ExecutionTarget,
    analysis: CommandAnalysis,
    capture_kind: CaptureKind,
    internal: bool,
    preserves_context: bool,
}

pub struct IntentStore {
    pending: HashMap<String, PendingIntent>,
    ttl: Duration,
}

impl Default for IntentStore {
    fn default() -> Self {
        Self::with_ttl(INTENT_TTL)
    }
}

impl IntentStore {
    pub fn with_ttl(ttl: Duration) -> Self {
        Self {
            pending: HashMap::new(),
            ttl,
        }
    }

    /// Run outside the session lock/on a blocking worker. Insertion rechecks
    /// the target after parsing, so an intervening input/reconnect invalidates it.
    pub fn prepare(
        source: String,
        operation: OperationKind,
        target: ExecutionTarget,
    ) -> Result<PreparedIntent> {
        Self::prepare_input(source, operation, target, false)
    }

    fn prepare_input(
        source: String,
        operation: OperationKind,
        target: ExecutionTarget,
        bracketed: bool,
    ) -> Result<PreparedIntent> {
        if source.len() > AnalysisBudget::default().max_bytes {
            bail!("命令超过 64 KiB 分析上限");
        }
        if operation == OperationKind::Command && source.contains('\t') && !bracketed {
            bail!("当前未协商括号粘贴，交互命令中的 Tab 会触发补全，请使用空格或脚本入口");
        }
        let shell = if operation == OperationKind::BashScript {
            ShellDialect::Bash
        } else {
            target.context.shell
        };
        let mut analysis = analyze_command(&source, shell, AnalysisBudget::default());
        if target.context.working_directory.is_none()
            || target.context.user.is_none()
            || target.context.environment_scope.is_none()
            || (operation == OperationKind::BashScript
                && !matches!(
                    target.context.shell,
                    ShellDialect::Bash | ShellDialect::Posix | ShellDialect::Zsh
                ))
        {
            analysis.analysis_status = AnalysisStatus::Unknown;
            if analysis.decision != Decision::Deny {
                analysis.decision = Decision::Ask;
            }
            analysis.unknown_reasons.push(AnalysisIssue {
                code: "target-context".into(),
                message: "当前 Shell 的目录、身份、环境或执行能力尚未完整确认。".into(),
                range: SourceRange::new(&source, 0, source.len()),
            });
        }
        let export = analyze_reusable_command(&source, shell);
        Ok(PreparedIntent {
            export,
            source,
            operation,
            target,
            analysis,
            capture_kind: CaptureKind::None,
            internal: false,
            preserves_context: false,
        })
    }

    pub fn prepare_capture(
        source: String,
        operation: OperationKind,
        target: ExecutionTarget,
        capture: CaptureKind,
    ) -> Result<PreparedIntent> {
        if operation == OperationKind::Command
            && source.contains('\n')
            && !matches!(
                target.context.shell,
                ShellDialect::Bash | ShellDialect::Posix | ShellDialect::Zsh
            )
        {
            bail!("当前 Shell 尚不支持可靠的多行命令派发，请先核对环境或使用对应脚本入口");
        }
        let bracketed = capture == CaptureKind::Bracketed
            && operation == OperationKind::Command
            && matches!(target.context.shell, ShellDialect::Bash | ShellDialect::Zsh);
        let mut prepared = Self::prepare_input(source, operation, target, bracketed)?;
        // The application only selects Bracketed after a live multiline probe;
        // ordinary marker support alone cannot safely transport multiple lines.
        prepared.capture_kind = if prepared.source.contains('\n')
            && (capture == CaptureKind::Markers
                || capture == CaptureKind::None && operation == OperationKind::Command)
        {
            CaptureKind::Sentinel
        } else if capture == CaptureKind::Bracketed
            && (operation != OperationKind::Command
                || !matches!(
                    prepared.target.context.shell,
                    ShellDialect::Bash | ShellDialect::Zsh
                ))
        {
            CaptureKind::Sentinel
        } else {
            capture
        };
        Ok(prepared)
    }

    /// Application-owned, bounded read-only programs. No caller-supplied shell
    /// source or boolean can opt an arbitrary command into this path.
    pub fn prepare_probe(probe: InternalProbe, target: ExecutionTarget) -> Result<PreparedIntent> {
        let source = probe.source()?;
        let preserves_context = !matches!(probe, InternalProbe::ShellIntegration {});
        Ok(PreparedIntent {
            export: CommandExportAnalysis::default(),
            source,
            operation: OperationKind::Command,
            target,
            analysis: CommandAnalysis {
                analysis_status: AnalysisStatus::Complete,
                decision: Decision::Allow,
                risks: vec![],
                unknown_reasons: vec![],
                highest_severity: None,
                policy_version: POLICY_VERSION.into(),
            },
            capture_kind: if matches!(probe, InternalProbe::BracketedCapture {}) {
                CaptureKind::Bracketed
            } else {
                CaptureKind::Sentinel
            },
            internal: true,
            preserves_context,
        })
    }

    /// The typed helper can only be constructed from a consumed file edit
    /// approval. Writes do not enter the read-only probe deserialization path.
    pub fn prepare_file_edit(
        request: crate::domain::filesystem::agent_files::TerminalFileEditRequest,
        target: ExecutionTarget,
    ) -> PreparedIntent {
        PreparedIntent {
            export: CommandExportAnalysis::default(),
            source: request.source(),
            operation: OperationKind::Command,
            target,
            analysis: CommandAnalysis {
                analysis_status: AnalysisStatus::Complete,
                decision: Decision::Allow,
                risks: vec![],
                unknown_reasons: vec![],
                highest_severity: None,
                policy_version: POLICY_VERSION.into(),
            },
            capture_kind: CaptureKind::Sentinel,
            internal: true,
            preserves_context: true,
        }
    }

    pub fn insert(
        &mut self,
        prepared: PreparedIntent,
        current: &ExecutionTarget,
    ) -> Result<CommandIntent> {
        if prepared.target != *current {
            bail!("执行目标在分析期间发生变化，请重新分析");
        }
        self.pending
            .retain(|_, entry| entry.expires > Instant::now());
        if self.pending.len() >= MAX_PENDING_INTENTS {
            bail!("待审批操作过多，请取消旧操作后重试");
        }
        let id = uuid::Uuid::new_v4().to_string();
        let capture = CaptureTransport::new(prepared.capture_kind, prepared.internal);
        let terminal_input = render_transport(&prepared.source, prepared.operation, &capture);
        let intent = CommandIntent {
            reference: IntentReference {
                id: id.clone(),
                operation: prepared.operation,
                target: prepared.target,
                policy_version: POLICY_VERSION.into(),
            },
            source: prepared.source,
            source_sensitive: prepared.export.sensitive,
            operation: prepared.operation,
            analysis: prepared.analysis,
            expires_in_ms: self.ttl.as_millis().min(u64::MAX as u128) as u64,
            capture,
            terminal_input,
        };
        self.pending.insert(
            id,
            PendingIntent {
                export: prepared.export,
                intent: intent.clone(),
                approved: false,
                expires: Instant::now() + self.ttl,
                preserves_context: prepared.preserves_context,
            },
        );
        Ok(intent)
    }

    fn checked(
        &mut self,
        reference: &IntentReference,
        current: &ExecutionTarget,
    ) -> Result<&mut PendingIntent> {
        let Some(entry) = self.pending.get_mut(&reference.id) else {
            bail!("操作已失效或已派发，请重新分析");
        };
        if entry.expires <= Instant::now() {
            bail!("审批已过期，请重新分析");
        }
        if entry.intent.reference != *reference || reference.target != *current {
            bail!("执行目标或操作记录已经变化，请重新分析");
        }
        if reference.policy_version != POLICY_VERSION
            || entry.intent.analysis.policy_version != POLICY_VERSION
        {
            bail!("命令策略已经更新，请重新分析");
        }
        if entry.intent.analysis.decision == Decision::Deny {
            bail!("命令被策略拒绝，不能通过批准覆盖");
        }
        Ok(entry)
    }

    /// Read-only draft material from this exact live intent. This neither grants
    /// nor consumes approval and cannot resurrect a dispatched intent.
    pub fn reusable_source(
        &mut self,
        reference: &IntentReference,
        current: &ExecutionTarget,
        marked_sensitive: bool,
    ) -> Result<CommandExportAnalysis> {
        let mut export = self.checked(reference, current)?.export.clone();
        if marked_sensitive
            && export
                .source
                .as_ref()
                .is_some_and(|source| source.secrets.is_empty())
        {
            export.source = None;
        }
        export.sensitive |= marked_sensitive;
        Ok(export)
    }

    pub(crate) fn reusable_source_for_step(
        &mut self,
        reference: &IntentReference,
        current: &ExecutionTarget,
        command: &str,
        marked_sensitive: bool,
    ) -> Result<CommandExportAnalysis> {
        let entry = self.checked(reference, current)?;
        if !marked_sensitive && !entry.export.sensitive && entry.intent.source != command {
            bail!("步骤内容与脚本来源命令不一致")
        }
        self.reusable_source(reference, current, marked_sensitive)
    }

    pub fn approve(
        &mut self,
        reference: &IntentReference,
        current: &ExecutionTarget,
        reviewed_source: &str,
    ) -> Result<()> {
        let entry = self.checked(reference, current)?;
        if entry.intent.source != reviewed_source {
            bail!("审批内容与待执行内容不一致，请重新分析");
        }
        entry.approved = true;
        Ok(())
    }

    /// Returns only the payload derived from the stored source. The caller must
    /// hold the same target lock until write, and must never retry a failed write
    /// with this ticket: partial terminal writes have unknown effects.
    pub fn consume(
        &mut self,
        reference: &IntentReference,
        current: &ExecutionTarget,
    ) -> Result<Vec<u8>> {
        self.consume_dispatch(reference, current)
            .map(|(payload, _)| payload)
    }

    pub fn consume_dispatch(
        &mut self,
        reference: &IntentReference,
        current: &ExecutionTarget,
    ) -> Result<(Vec<u8>, bool)> {
        let entry = self.checked(reference, current)?;
        if entry.intent.analysis.decision != Decision::Allow && !entry.approved {
            bail!("该命令需要用户批准");
        }
        if entry.intent.operation == OperationKind::BashScript {
            if !matches!(
                current.context.shell,
                ShellDialect::Bash | ShellDialect::Posix | ShellDialect::Zsh
            ) {
                bail!("当前 Shell 未确认支持 Bash 脚本启动模板");
            }
        }
        let payload = entry.intent.terminal_input.clone().into_bytes();
        let preserves_context = entry.preserves_context;
        self.pending.remove(&reference.id);
        Ok((payload, preserves_context))
    }

    pub fn cancel(&mut self, id: &str) -> bool {
        self.pending.remove(id).is_some()
    }
    pub fn invalidate(&mut self) {
        self.pending.clear();
    }
}
