//! Exact, expiring baselines and single-use approvals. Neither a model-provided
//! path nor a persisted conversation can manufacture a write capability.
use super::*;
use crate::domain::command_policy::ExecutionTarget;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::time::{Duration, Instant};

const TTL: Duration = Duration::from_secs(600);
const MAX_BASELINES: usize = 64;

pub fn file_content_hash(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}
fn invalid(message: &str) -> FileError {
    FileError::new(FileErrorKind::InvalidRequest, message)
}
fn stale() -> FileError {
    FileError::new(
        FileErrorKind::VersionChanged,
        "文件基线或编辑审批已失效，请重新完整读取",
    )
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextReplacement {
    pub old_text: String,
    pub new_text: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "kebab-case", deny_unknown_fields)]
pub enum FileChange {
    Replace { content: String },
    Patch { replacements: Vec<TextReplacement> },
    Delete {},
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileEditRequest {
    pub baseline_id: String,
    pub change: FileChange,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileEditAttributes {
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    /// None means the provider cannot establish whether ACLs/xattrs exist.
    #[serde(default)]
    pub extended_metadata: Option<bool>,
    #[serde(default)]
    pub metadata_backup: Option<FileExtendedMetadata>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileExtendedMetadata {
    pub platform: String,
    pub xattrs: std::collections::BTreeMap<String, String>,
    pub acl: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEditProposal {
    pub reference: FileOperationReference,
    pub provider: FileProvider,
    pub write_strategy: &'static str,
    pub path: String,
    pub resolved_path: String,
    pub environment_scope: String,
    pub revision: Option<String>,
    pub before: Option<String>,
    pub after: Option<String>,
    pub sensitive: bool,
    pub review_hash: String,
    pub restore_of: Option<String>,
    pub restore_attributes: Option<FileEditAttributes>,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FileEditStatus {
    Dispatching,
    Applied,
    Conflict,
    Failed,
    Unknown,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEditOutcome {
    pub status: FileEditStatus,
    pub revision: Option<String>,
    pub content_hash: Option<String>,
    pub before_attributes: Option<FileEditAttributes>,
    pub after_attributes: Option<FileEditAttributes>,
    pub error: Option<FileError>,
}
impl FileEditOutcome {
    pub fn failure(error: FileError, started: bool) -> Self {
        Self {
            status: if started {
                FileEditStatus::Unknown
            } else if matches!(
                error.kind,
                FileErrorKind::VersionChanged
                    | FileErrorKind::TargetChanged
                    | FileErrorKind::Missing
            ) {
                FileEditStatus::Conflict
            } else {
                FileEditStatus::Failed
            },
            revision: None,
            content_hash: None,
            before_attributes: None,
            after_attributes: None,
            error: Some(error),
        }
    }
}
/// Durable change history contains no approval or dispatch ticket. Sensitive
/// pre/postimages are retained only in the live session, never in SQLite.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeRecord {
    pub id: String,
    pub target: ExecutionTarget,
    pub provider: FileProvider,
    #[serde(default)]
    pub write_strategy: String,
    pub path: String,
    pub resolved_path: String,
    pub environment_scope: String,
    pub before: Option<String>,
    pub after: Option<String>,
    pub sensitive: bool,
    pub restore_of: Option<String>,
    pub outcome: FileEditOutcome,
    pub created_at: u64,
}
impl FileChangeRecord {
    pub fn persisted(&self) -> Self {
        let mut record = self.clone();
        if record.sensitive {
            record.before = None;
            record.after = None;
            if let Some(attrs) = &mut record.outcome.before_attributes {
                attrs.metadata_backup = None;
            }
            if let Some(attrs) = &mut record.outcome.after_attributes {
                attrs.metadata_backup = None;
            }
        }
        record
    }
}
#[derive(Clone, Debug)]
struct Baseline {
    target: ExecutionTarget,
    provider: FileProvider,
    path: String,
    resolved_path: String,
    scope: String,
    revision: Option<String>,
    content: Option<String>,
    dispatch: Option<FileDispatch>,
    route: Option<String>,
    sensitive: bool,
    created: Instant,
}
struct Pending {
    proposal: FileEditProposal,
    baseline: Baseline,
    approved: bool,
    created: Instant,
}
/// Private fields and no Deserialize: only consuming a reviewed proposal can
/// create a dispatch, including one used by an application-owned shell helper.
#[derive(Clone, Debug)]
pub struct FileEditDispatch {
    proposal: FileEditProposal,
    baseline: Baseline,
}
impl FileEditDispatch {
    pub fn proposal(&self) -> &FileEditProposal {
        &self.proposal
    }
    pub fn route(&self) -> Option<&str> {
        self.baseline.route.as_deref()
    }
    pub fn native_permit(&self) -> FileResult<FileAccessPermit> {
        self.baseline
            .dispatch
            .as_ref()
            .ok_or_else(|| invalid("缺失文件只能通过已核对的当前终端创建"))?
            .native_permit()
    }
    pub fn record(&self, outcome: FileEditOutcome) -> FileChangeRecord {
        let p = &self.proposal;
        FileChangeRecord {
            id: p.reference.id.clone(),
            target: p.reference.target.clone(),
            provider: p.provider,
            write_strategy: p.write_strategy.into(),
            path: p.path.clone(),
            resolved_path: p.resolved_path.clone(),
            environment_scope: p.environment_scope.clone(),
            before: p.before.clone(),
            after: p.after.clone(),
            sensitive: p.sensitive,
            restore_of: p.restore_of.clone(),
            outcome,
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        }
    }
    pub fn validate_outcome(&self, outcome: FileEditOutcome) -> FileEditOutcome {
        if outcome.status != FileEditStatus::Applied {
            return outcome;
        }
        let expected_hash = self.proposal.after.as_deref().map(file_content_hash);
        if outcome.error.is_some()
            || outcome.content_hash != expected_hash
            || outcome.revision.is_some() != self.proposal.after.is_some()
            || outcome.after_attributes.is_some() != self.proposal.after.is_some()
            || outcome.before_attributes.is_some() != self.proposal.before.is_some()
            || outcome
                .revision
                .as_ref()
                .is_some_and(|v| v.is_empty() || v.len() > 128)
        {
            return FileEditOutcome::failure(
                invalid("写入后的文件核验结果不完整，不能确认成功"),
                true,
            );
        }
        outcome
    }
}
#[derive(Default)]
pub struct FileEditStore {
    baselines: HashMap<String, Baseline>,
    pending: HashMap<String, Pending>,
}
impl FileEditStore {
    pub fn invalidate(&mut self) {
        self.baselines.clear();
        self.pending.clear();
    }
    fn prune(&mut self) {
        self.baselines
            .retain(|_, item| item.created.elapsed() < TTL);
        self.pending.retain(|_, item| item.created.elapsed() < TTL);
    }
    fn register(&mut self, baseline: Baseline) -> Option<String> {
        self.prune();
        if self.baselines.len() >= MAX_BASELINES {
            return None;
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.baselines.insert(id.clone(), baseline);
        Some(id)
    }
    pub fn register_read(
        &mut self,
        dispatch: FileDispatch,
        route: Option<String>,
        response: &FileToolResponse,
    ) -> Option<String> {
        let FileToolData::ReadFile { data } = &response.data else {
            return None;
        };
        if !data.page.complete
            || !data.page.eof
            || data.page.start.byte != 0
            || data.page.truncation.is_some()
            || data.changed_during_read
            || data.metadata.kind != FileKind::File
            || data.page.content.len() > MAX_FILE_BYTES
            || data.metadata.size != data.page.content.len() as u64
            || data.page.end.byte != data.metadata.size
            || response.target != dispatch.operation.reference.target
            || response.provider != dispatch.operation.provider
            || response.environment_scope != dispatch.inspection.scope
            || data.path != dispatch.inspection.path
            || data.resolved_path != dispatch.inspection.resolved_path
            || data.revision != dispatch.inspection.revision
            || data.page.content.contains('\0')
        {
            return None;
        }
        self.register(Baseline {
            target: response.target.clone(),
            provider: response.provider,
            path: data.path.clone(),
            resolved_path: data.resolved_path.clone(),
            scope: response.environment_scope.clone(),
            revision: Some(data.revision.clone()),
            content: Some(data.page.content.clone()),
            dispatch: Some(dispatch),
            route,
            sensitive: response.sensitive,
            created: Instant::now(),
        })
    }
    pub fn register_absence(
        &mut self,
        target: &ExecutionTarget,
        absence: &FileAbsence,
    ) -> Option<String> {
        if check_file_path_syntax(&absence.path).is_err()
            || check_file_path_syntax(&absence.resolved_path).is_err()
            || absence.environment_scope.len() != 64
            || !absence
                .environment_scope
                .bytes()
                .all(|b| b.is_ascii_hexdigit())
        {
            return None;
        }
        self.register(Baseline {
            target: target.clone(),
            provider: FileProvider::CurrentTerminal,
            path: absence.path.clone(),
            resolved_path: absence.resolved_path.clone(),
            scope: absence.environment_scope.clone(),
            revision: None,
            content: None,
            dispatch: None,
            route: None,
            sensitive: sensitive_file_path(&absence.path)
                || sensitive_file_path(&absence.resolved_path),
            created: Instant::now(),
        })
    }
    pub fn prepare(
        &mut self,
        target: &ExecutionTarget,
        request: FileEditRequest,
    ) -> FileResult<FileEditProposal> {
        self.prune();
        let baseline = self
            .baselines
            .get(&request.baseline_id)
            .ok_or_else(stale)?
            .clone();
        if baseline.target != *target {
            return Err(stale());
        }
        let after = match request.change {
            FileChange::Replace { content } => Some(content),
            FileChange::Delete {} => {
                if baseline.content.is_none() {
                    return Err(invalid("不能删除已经缺失的文件"));
                }
                None
            }
            FileChange::Patch { replacements } => {
                if replacements.is_empty() || replacements.len() > 64 {
                    return Err(invalid("补丁需要 1—64 项精确替换"));
                }
                let mut content = baseline
                    .content
                    .clone()
                    .ok_or_else(|| invalid("补丁需要已完整读取的现有文件"))?;
                for edit in replacements {
                    if edit.old_text.is_empty()
                        || content.match_indices(&edit.old_text).count() != 1
                    {
                        return Err(invalid("补丁原文必须在当前基线中恰好出现一次"));
                    }
                    if edit.new_text.len() > MAX_FILE_BYTES {
                        return Err(invalid("补丁超过 64 KiB"));
                    }
                    content = content.replacen(&edit.old_text, &edit.new_text, 1);
                    if content.len() > MAX_FILE_BYTES {
                        return Err(invalid("修改后的文件超过 64 KiB"));
                    }
                }
                Some(content)
            }
        };
        self.insert(baseline, after, None, None)
    }
    pub fn prepare_restore(
        &mut self,
        target: &ExecutionTarget,
        baseline_id: &str,
        record: &FileChangeRecord,
    ) -> FileResult<FileEditProposal> {
        self.prune();
        let baseline = self.baselines.get(baseline_id).ok_or_else(stale)?.clone();
        if record.sensitive || record.outcome.status != FileEditStatus::Applied {
            return Err(invalid("此记录没有可用于恢复的持久完整基线"));
        }
        if record.after.is_none()
            && !record
                .outcome
                .before_attributes
                .as_ref()
                .is_some_and(|attrs| {
                    attrs.extended_metadata == Some(false) || attrs.metadata_backup.is_some()
                })
        {
            return Err(invalid(
                "删除前的 ACL 或扩展属性未完整备份，不能自动恢复此文件",
            ));
        }
        if baseline.target != *target
            || target.profile_id != record.target.profile_id
            || baseline.scope != record.environment_scope
            || (record.after.is_some() && baseline.provider != record.provider)
            || baseline.path != record.path
            || baseline.resolved_path != record.resolved_path
            || baseline.content != record.after
            || baseline.revision != record.outcome.revision
        {
            return Err(FileError::new(
                FileErrorKind::VersionChanged,
                "文件或环境已偏离该次写入结果，恢复存在冲突",
            ));
        }
        self.insert(
            baseline,
            record.before.clone(),
            Some(record.id.clone()),
            record.outcome.before_attributes.clone(),
        )
    }
    fn insert(
        &mut self,
        baseline: Baseline,
        after: Option<String>,
        restore_of: Option<String>,
        restore_attributes: Option<FileEditAttributes>,
    ) -> FileResult<FileEditProposal> {
        if self.pending.len() >= 16 {
            return Err(invalid("待审批的文件修改过多"));
        }
        if after == baseline.content {
            return Err(invalid("修改没有改变文件内容"));
        }
        if after
            .as_ref()
            .is_some_and(|v| v.len() > MAX_FILE_BYTES || v.contains('\0'))
        {
            return Err(invalid("写入仅支持不含 NUL 的 UTF-8 文本，最多 64 KiB"));
        }
        let mut proposal = FileEditProposal {
            reference: FileOperationReference {
                id: uuid::Uuid::new_v4().to_string(),
                target: baseline.target.clone(),
            },
            provider: baseline.provider,
            write_strategy: if after.is_none() {
                "delete"
            } else if baseline.content.is_none() {
                "create-exclusive"
            } else if baseline.provider == FileProvider::Sftp {
                "in-place"
            } else {
                "atomic-replace"
            },
            path: baseline.path.clone(),
            resolved_path: baseline.resolved_path.clone(),
            environment_scope: baseline.scope.clone(),
            revision: baseline.revision.clone(),
            before: baseline.content.clone(),
            after,
            sensitive: baseline.sensitive,
            review_hash: String::new(),
            restore_of,
            restore_attributes,
        };
        proposal.review_hash =
            file_content_hash(&serde_json::to_string(&proposal).expect("serializable proposal"));
        self.pending.insert(
            proposal.reference.id.clone(),
            Pending {
                proposal: proposal.clone(),
                baseline,
                approved: false,
                created: Instant::now(),
            },
        );
        Ok(proposal)
    }
    pub fn approve(
        &mut self,
        reference: &FileOperationReference,
        target: &ExecutionTarget,
        review_hash: &str,
    ) -> FileResult<()> {
        self.prune();
        let pending = self.pending.get_mut(&reference.id).ok_or_else(stale)?;
        if reference != &pending.proposal.reference
            || &reference.target != target
            || review_hash != pending.proposal.review_hash
        {
            return Err(stale());
        }
        pending.approved = true;
        Ok(())
    }
    pub fn consume(
        &mut self,
        reference: &FileOperationReference,
        target: &ExecutionTarget,
    ) -> FileResult<FileEditDispatch> {
        self.prune();
        let pending = self.pending.get(&reference.id).ok_or_else(stale)?;
        if reference != &pending.proposal.reference || &reference.target != target {
            return Err(stale());
        }
        if !pending.approved {
            return Err(invalid("文件修改尚未获本次差异审批"));
        }
        let pending = self
            .pending
            .remove(&reference.id)
            .expect("checked pending proposal");
        Ok(FileEditDispatch {
            proposal: pending.proposal,
            baseline: pending.baseline,
        })
    }
    pub fn cancel(&mut self, id: &str) -> bool {
        self.pending.remove(id).is_some()
    }
}
