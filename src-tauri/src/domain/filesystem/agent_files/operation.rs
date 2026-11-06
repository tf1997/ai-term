use super::*;
use crate::domain::command_policy::ExecutionTarget;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{Duration, Instant};

const MAX_PENDING: usize = 128;
const LIFETIME: Duration = Duration::from_secs(600);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "tool", rename_all = "snake_case", deny_unknown_fields)]
pub enum FileToolRequest {
    ReadFile {
        path: String,
        #[serde(default)]
        options: FileReadOptions,
        cursor: Option<String>,
    },
    ListDirectory {
        path: String,
        #[serde(default = "default_directory_limit")]
        limit: usize,
        cursor: Option<String>,
    },
}
fn default_directory_limit() -> usize {
    100
}
impl FileToolRequest {
    pub fn path(&self) -> &str {
        match self {
            Self::ReadFile { path, .. } | Self::ListDirectory { path, .. } => path,
        }
    }
    pub fn cursor(&self) -> Option<&str> {
        match self {
            Self::ReadFile { cursor, .. } | Self::ListDirectory { cursor, .. } => cursor.as_deref(),
        }
    }
    pub fn validate(&self) -> FileResult<()> {
        check_file_path_syntax(self.path())?;
        if self
            .cursor()
            .is_some_and(|cursor| uuid::Uuid::parse_str(cursor).is_err())
        {
            return Err(FileError::new(
                FileErrorKind::InvalidRequest,
                "无效的文件分页游标",
            ));
        }
        match self {
            Self::ReadFile {
                options, cursor, ..
            } => {
                options.validate()?;
                if cursor.is_some() && (options.start_line != 1 || options.tail) {
                    return Err(FileError::new(
                        FileErrorKind::InvalidRequest,
                        "分页游标不能与开始行或末尾读取同时使用",
                    ));
                }
            }
            Self::ListDirectory { limit, .. } if *limit == 0 || *limit > MAX_DIRECTORY_ENTRIES => {
                return Err(FileError::new(
                    FileErrorKind::InvalidRequest,
                    "目录最多返回 500 项",
                ))
            }
            _ => (),
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FileProvider {
    Local,
    Sftp,
    CurrentTerminal,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileOperationReference {
    pub id: String,
    pub target: ExecutionTarget,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOperation {
    pub reference: FileOperationReference,
    pub request: FileToolRequest,
    pub provider: FileProvider,
    pub resolved_path: String,
    pub revision: String,
    pub sensitive: bool,
}

#[derive(Clone, Debug)]
pub struct FileDispatch {
    pub operation: FileOperation,
    pub inspection: FileInspection,
    pub resume: Option<FilePosition>,
    pub offset: usize,
    pub directory_fingerprint: Option<String>,
}
/// Constructed only from a consumed file operation; never deserialized from IPC.
#[derive(Clone, Debug)]
pub struct FileAccessPermit {
    pub(crate) path: String,
    pub(crate) resolved_path: String,
    pub(crate) revision: String,
    pub(crate) environment: FileEnvironment,
    pub(crate) sensitive: bool,
}
impl FileAccessPermit {
    pub fn environment(&self) -> &FileEnvironment {
        &self.environment
    }
    pub(crate) fn check_path(&self, requested: &str, resolved: &str) -> FileResult<()> {
        check_file_path_syntax(requested)?;
        check_file_path_syntax(resolved)?;
        if requested != self.path || resolved != self.resolved_path {
            return Err(FileError::new(
                FileErrorKind::VersionChanged,
                "文件路径自审查后发生变化",
            ));
        }
        if !self.sensitive {
            check_file_path(requested)?;
            check_file_path(resolved)?;
        }
        Ok(())
    }
}
impl FileDispatch {
    pub fn native_permit(&self) -> FileResult<FileAccessPermit> {
        let environment = self.inspection.environment.clone().ok_or_else(|| {
            FileError::new(FileErrorKind::Unavailable, "无法证明文件提供方对应当前终端")
        })?;
        environment.validate()?;
        Ok(FileAccessPermit {
            path: self.inspection.path.clone(),
            resolved_path: self.inspection.resolved_path.clone(),
            revision: self.inspection.revision.clone(),
            environment,
            sensitive: self.operation.sensitive,
        })
    }
    pub fn terminal_request(&self) -> FileResult<TerminalFileRequest> {
        match &self.operation.request {
            FileToolRequest::ReadFile { options, .. } => TerminalFileRequest::read(
                &self.inspection,
                options.clone(),
                self.resume.clone(),
                self.operation.sensitive,
            ),
            FileToolRequest::ListDirectory { limit, .. } => TerminalFileRequest::list(
                &self.inspection,
                self.offset,
                *limit,
                self.operation.sensitive,
            ),
        }
    }
}
struct Pending {
    dispatch: FileDispatch,
    approved: bool,
    created: Instant,
}
#[derive(Clone)]
struct Cursor {
    target: ExecutionTarget,
    path: String,
    resolved_path: String,
    revision: String,
    provider: FileProvider,
    position: Option<FilePosition>,
    offset: Option<usize>,
    directory_fingerprint: Option<String>,
    created: Instant,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "tool", rename_all = "snake_case")]
pub enum FileToolData {
    ReadFile {
        #[serde(flatten)]
        data: FileReadResponse,
    },
    ListDirectory {
        #[serde(flatten)]
        data: FileDirectoryResponse,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileToolResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_id: Option<String>,
    pub environment_scope: String,
    pub provider: FileProvider,
    pub target: ExecutionTarget,
    #[serde(flatten)]
    pub data: FileToolData,
    pub next_cursor: Option<String>,
    pub sensitive: bool,
}

/// Single-use reviewed operations and opaque, version-bound pagination. No
/// approval or captured content is serialized into a recoverable capability.
#[derive(Default)]
pub struct FileOperationStore {
    operations: HashMap<String, Pending>,
    cursors: HashMap<String, Cursor>,
}
impl FileOperationStore {
    pub fn invalidate(&mut self) {
        self.operations.clear();
        self.cursors.clear();
    }
    fn prune(&mut self) {
        self.operations
            .retain(|_, item| item.created.elapsed() < LIFETIME);
        self.cursors
            .retain(|_, item| item.created.elapsed() < LIFETIME);
        while self.operations.len() >= MAX_PENDING {
            if let Some(id) = self
                .operations
                .iter()
                .min_by_key(|(_, item)| item.created)
                .map(|(id, _)| id.clone())
            {
                self.operations.remove(&id);
            }
        }
        while self.cursors.len() >= MAX_PENDING {
            if let Some(id) = self
                .cursors
                .iter()
                .min_by_key(|(_, item)| item.created)
                .map(|(id, _)| id.clone())
            {
                self.cursors.remove(&id);
            }
        }
    }
    pub fn prepare(
        &mut self,
        target: ExecutionTarget,
        request: FileToolRequest,
        provider: FileProvider,
        inspection: FileInspection,
    ) -> FileResult<FileOperation> {
        self.prune();
        request.validate()?;
        inspection.validate(request.path())?;
        let is_file = matches!(&request, FileToolRequest::ReadFile { .. });
        if is_file && inspection.metadata.kind != FileKind::File {
            return Err(FileError::new(
                FileErrorKind::NotRegularFile,
                "路径不是普通文件",
            ));
        }
        if !is_file && inspection.metadata.kind != FileKind::Directory {
            return Err(FileError::new(FileErrorKind::NotDirectory, "路径不是目录"));
        }
        let mut resume = None;
        let mut offset = 0;
        let mut directory_fingerprint = None;
        if let Some(id) = request.cursor() {
            let cursor = self.cursors.get(id).ok_or_else(|| {
                FileError::new(
                    FileErrorKind::TargetChanged,
                    "分页游标已过期或目标已经变化，请重新读取",
                )
            })?;
            if cursor.target != target
                || cursor.path != request.path()
                || cursor.provider != provider
                || is_file != cursor.position.is_some()
            {
                return Err(FileError::new(
                    FileErrorKind::TargetChanged,
                    "分页游标不属于当前目标、路径或读取方式",
                ));
            }
            if cursor.resolved_path != inspection.resolved_path
                || cursor.revision != inspection.revision
            {
                return Err(FileError::new(
                    FileErrorKind::VersionChanged,
                    "文件自上一页发生变化，请从新版本重新读取",
                ));
            }
            resume = cursor.position.clone();
            offset = cursor.offset.unwrap_or(0);
            directory_fingerprint = cursor.directory_fingerprint.clone();
        }
        let sensitive =
            sensitive_file_path(request.path()) || sensitive_file_path(&inspection.resolved_path);
        let operation = FileOperation {
            reference: FileOperationReference {
                id: uuid::Uuid::new_v4().to_string(),
                target,
            },
            request,
            provider,
            resolved_path: inspection.resolved_path.clone(),
            revision: inspection.revision.clone(),
            sensitive,
        };
        let dispatch = FileDispatch {
            operation: operation.clone(),
            inspection,
            resume,
            offset,
            directory_fingerprint,
        };
        self.operations.insert(
            operation.reference.id.clone(),
            Pending {
                dispatch,
                approved: !sensitive,
                created: Instant::now(),
            },
        );
        Ok(operation)
    }
    fn pending(
        &mut self,
        reference: &FileOperationReference,
        current: &ExecutionTarget,
    ) -> FileResult<&mut Pending> {
        self.prune();
        if reference.target != *current {
            return Err(FileError::new(
                FileErrorKind::TargetChanged,
                "文件读取目标已变化，请重新准备",
            ));
        }
        let pending = self.operations.get_mut(&reference.id).ok_or_else(|| {
            FileError::new(FileErrorKind::TargetChanged, "文件读取请求已过期或已经执行")
        })?;
        if pending.dispatch.operation.reference != *reference {
            return Err(FileError::new(
                FileErrorKind::TargetChanged,
                "文件读取引用不匹配",
            ));
        }
        Ok(pending)
    }
    pub fn approve(
        &mut self,
        reference: &FileOperationReference,
        current: &ExecutionTarget,
        reviewed_path: &str,
        reviewed_revision: &str,
    ) -> FileResult<()> {
        let pending = self.pending(reference, current)?;
        if pending.dispatch.inspection.resolved_path != reviewed_path
            || pending.dispatch.inspection.revision != reviewed_revision
        {
            return Err(FileError::new(
                FileErrorKind::VersionChanged,
                "批准的路径或版本与本次读取不一致",
            ));
        }
        pending.approved = true;
        Ok(())
    }
    pub fn cancel(&mut self, id: &str) -> bool {
        self.operations.remove(id).is_some()
    }
    pub fn consume(
        &mut self,
        reference: &FileOperationReference,
        current: &ExecutionTarget,
    ) -> FileResult<FileDispatch> {
        if !self.pending(reference, current)?.approved {
            return Err(FileError::new(
                FileErrorKind::SensitivePath,
                "敏感路径需要逐次批准读取",
            ));
        }
        Ok(self
            .operations
            .remove(&reference.id)
            .expect("validated operation")
            .dispatch)
    }
    pub fn finish(
        &mut self,
        dispatch: FileDispatch,
        current: &ExecutionTarget,
        data: FileToolData,
    ) -> FileResult<FileToolResponse> {
        self.prune();
        if dispatch.operation.reference.target != *current {
            return Err(FileError::new(
                FileErrorKind::TargetChanged,
                "文件读取完成前目标已变化，迟到结果已丢弃",
            ));
        }
        let (path, resolved, revision, position, offset) =
            match (&dispatch.operation.request, &data) {
                (FileToolRequest::ReadFile { options, .. }, FileToolData::ReadFile { data }) => {
                    if data.page.content.len() > options.max_bytes
                        || data.page.scanned_bytes > MAX_SCAN_BYTES + 1
                        || data.page.end.byte < data.page.start.byte
                        || data.page.complete && (!data.page.eof || data.page.start.byte != 0)
                    {
                        return Err(FileError::new(
                            FileErrorKind::Unavailable,
                            "文件阅读器返回了不一致或超限的范围",
                        ));
                    }
                    let can_resume = !data.changed_during_read
                        && !data.page.eof
                        && !options.tail
                        && data.page.end.byte > data.page.start.byte
                        && data.page.truncation != Some(FileTruncation::ScanBudget);
                    (
                        &data.path,
                        &data.resolved_path,
                        &data.revision,
                        can_resume.then(|| data.page.end.clone()),
                        None,
                    )
                }
                (
                    FileToolRequest::ListDirectory { limit, .. },
                    FileToolData::ListDirectory { data },
                ) => {
                    if dispatch
                        .directory_fingerprint
                        .as_ref()
                        .is_some_and(|expected| expected != &data.page.start_fingerprint)
                    {
                        return Err(FileError::new(
                            FileErrorKind::VersionChanged,
                            "目录项目或顺序自上一页发生变化，请重新列出",
                        ));
                    }
                    if data.page.entries.len() > *limit
                        || data.page.scanned_entries > MAX_DIRECTORY_SCAN
                        || serde_json::to_vec(&data.page.entries)
                            .expect("serializable entries")
                            .len()
                            > MAX_FILE_BYTES
                    {
                        return Err(FileError::new(
                            FileErrorKind::Unavailable,
                            "目录阅读器返回了超限结果",
                        ));
                    }
                    (
                        &data.path,
                        &data.resolved_path,
                        &data.revision,
                        None,
                        if data.changed_during_read {
                            None
                        } else {
                            data.page.next_offset
                        },
                    )
                }
                _ => {
                    return Err(FileError::new(
                        FileErrorKind::InvalidRequest,
                        "文件工具结果类型不匹配",
                    ))
                }
            };
        if path != &dispatch.inspection.path
            || resolved != &dispatch.inspection.resolved_path
            || revision != &dispatch.inspection.revision
        {
            return Err(FileError::new(
                FileErrorKind::VersionChanged,
                "文件工具结果不属于批准的路径或版本",
            ));
        }
        let next_cursor = if position.is_some() || offset.is_some() {
            let id = uuid::Uuid::new_v4().to_string();
            self.cursors.insert(
                id.clone(),
                Cursor {
                    target: current.clone(),
                    path: path.clone(),
                    resolved_path: resolved.clone(),
                    revision: revision.clone(),
                    provider: dispatch.operation.provider,
                    position,
                    offset,
                    directory_fingerprint: match &data {
                        FileToolData::ListDirectory { data } => {
                            Some(data.page.end_fingerprint.clone())
                        }
                        _ => None,
                    },
                    created: Instant::now(),
                },
            );
            Some(id)
        } else {
            None
        };
        Ok(FileToolResponse {
            baseline_id: None,
            environment_scope: dispatch.inspection.scope,
            provider: dispatch.operation.provider,
            target: current.clone(),
            data,
            next_cursor,
            sensitive: dispatch.operation.sensitive,
        })
    }
}
