use serde::{Deserialize, Serialize};
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};

pub const MAX_FILE_BYTES: usize = 65_536;
pub const MAX_SCAN_BYTES: usize = 1_048_576;
pub const MAX_DIRECTORY_ENTRIES: usize = 500;
pub const MAX_DIRECTORY_SCAN: usize = 10_000;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FileErrorKind {
    InvalidRequest,
    Missing,
    PermissionDenied,
    SensitivePath,
    Binary,
    UnsupportedEncoding,
    NotRegularFile,
    NotDirectory,
    Cancelled,
    TargetChanged,
    VersionChanged,
    ScanLimit,
    Unavailable,
    Transport,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileError {
    pub kind: FileErrorKind,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub absence: Option<FileAbsence>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileAbsence {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_id: Option<String>,
    pub path: String,
    pub resolved_path: String,
    pub environment_scope: String,
}
impl FileError {
    pub fn new(kind: FileErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            absence: None,
        }
    }
    pub fn cancelled(cancel: Option<&AtomicBool>) -> FileResult<()> {
        if cancel.is_some_and(|token| token.load(Ordering::SeqCst)) {
            Err(Self::new(FileErrorKind::Cancelled, "文件操作已取消"))
        } else {
            Ok(())
        }
    }
}
impl fmt::Display for FileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for FileError {}
impl From<std::io::Error> for FileError {
    fn from(error: std::io::Error) -> Self {
        #[cfg(unix)]
        if error.raw_os_error() == Some(libc::ENOTDIR) {
            return Self::new(FileErrorKind::NotDirectory, error.to_string());
        }
        #[cfg(unix)]
        if error.raw_os_error() == Some(libc::ELOOP) {
            return Self::new(
                FileErrorKind::VersionChanged,
                "文件路径在打开期间变为符号链接",
            );
        }
        let kind = match error.kind() {
            std::io::ErrorKind::NotFound => FileErrorKind::Missing,
            std::io::ErrorKind::PermissionDenied => FileErrorKind::PermissionDenied,
            _ => FileErrorKind::Transport,
        };
        Self::new(kind, error.to_string())
    }
}
pub type FileResult<T> = Result<T, FileError>;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileReadOptions {
    #[serde(default = "first_line")]
    pub start_line: u64,
    #[serde(default = "default_lines")]
    pub max_lines: usize,
    #[serde(default = "default_bytes")]
    pub max_bytes: usize,
    #[serde(default)]
    pub tail: bool,
}
fn first_line() -> u64 {
    1
}
fn default_lines() -> usize {
    200
}
fn default_bytes() -> usize {
    MAX_FILE_BYTES
}
impl Default for FileReadOptions {
    fn default() -> Self {
        Self {
            start_line: 1,
            max_lines: 200,
            max_bytes: MAX_FILE_BYTES,
            tail: false,
        }
    }
}
impl FileReadOptions {
    pub fn validate(&self) -> FileResult<()> {
        if self.start_line == 0
            || self.max_lines == 0
            || self.max_lines > MAX_FILE_BYTES
            || self.max_bytes < 4
            || self.max_bytes > MAX_FILE_BYTES
            || (self.tail && self.start_line != 1)
        {
            return Err(FileError::new(
                FileErrorKind::InvalidRequest,
                "无效的文件阅读范围（最多 65536 行、64 KiB）",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FileKind {
    File,
    Directory,
    Symlink,
    Other,
}

/// Metadata revisions are change hints, not an atomic snapshot guarantee.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileMetadata {
    pub kind: FileKind,
    pub size: u64,
    pub modified_ns: Option<u64>,
    pub identity: Option<String>,
}
impl FileMetadata {
    pub fn revision(&self) -> String {
        use sha2::{Digest, Sha256};
        format!(
            "metadata:{}",
            format_args!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(self).expect("serializable metadata"))
            )
        )
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FileTruncation {
    Bytes,
    Lines,
    ScanBudget,
    TailWindow,
}

/// Internal cursor coordinates. An IPC caller receives an opaque, target-bound
/// cursor from the application, never permission to seek on a different target.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FilePosition {
    pub byte: u64,
    pub line: Option<u64>,
    pub mid_line: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileReadPage {
    pub content: String,
    pub start: FilePosition,
    pub end: FilePosition,
    pub eof: bool,
    pub complete: bool,
    pub truncation: Option<FileTruncation>,
    pub scanned_bytes: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileReadResponse {
    pub path: String,
    pub resolved_path: String,
    pub metadata: FileMetadata,
    pub revision: String,
    pub changed_during_read: bool,
    #[serde(flatten)]
    pub page: FileReadPage,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileDirectoryEntry {
    pub name: String,
    pub kind: FileKind,
    pub size: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileDirectoryPage {
    pub start_fingerprint: String,
    pub end_fingerprint: String,
    pub entries: Vec<FileDirectoryEntry>,
    pub next_offset: Option<usize>,
    pub scanned_entries: usize,
    pub truncation: Option<FileTruncation>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileDirectoryResponse {
    pub path: String,
    pub resolved_path: String,
    pub revision: String,
    pub changed_during_read: bool,
    #[serde(flatten)]
    pub page: FileDirectoryPage,
}
