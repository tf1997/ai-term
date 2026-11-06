use super::*;
use std::fs::{self, File, Metadata, OpenOptions};
use std::sync::atomic::AtomicBool;

pub(super) fn metadata(value: &Metadata) -> FileMetadata {
    let kind = if value.file_type().is_symlink() {
        FileKind::Symlink
    } else if value.is_file() {
        FileKind::File
    } else if value.is_dir() {
        FileKind::Directory
    } else {
        FileKind::Other
    };
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        Some(format!(
            "{}:{}:{}:{}:{}:{}:{}",
            value.dev(),
            value.ino(),
            value.uid(),
            value.gid(),
            value.mode(),
            value.ctime(),
            value.ctime_nsec()
        ))
    };
    #[cfg(not(unix))]
    let identity = None;
    FileMetadata {
        kind,
        size: value.len(),
        modified_ns: value
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|duration| duration.as_nanos().try_into().ok()),
        identity,
    }
}

fn resolve(path: &str) -> FileResult<String> {
    check_file_path_syntax(path)?;
    let canonical = fs::canonicalize(path)?;
    let value = canonical
        .to_str()
        .ok_or_else(|| {
            FileError::new(FileErrorKind::UnsupportedEncoding, "文件路径不是有效 UTF-8")
        })?
        .trim_start_matches("\\\\?\\")
        .to_string();
    check_file_path_syntax(&value)?;
    Ok(value)
}

pub(super) fn open_bound(path: &str, directory: bool) -> FileResult<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(
            libc::O_NOFOLLOW | libc::O_NONBLOCK | if directory { libc::O_DIRECTORY } else { 0 },
        );
    }
    let file = options.open(path)?;
    if !directory && !file.metadata()?.is_file() {
        return Err(FileError::new(
            FileErrorKind::NotRegularFile,
            "路径不是普通文件",
        ));
    }
    // Resolve the opened descriptor before reading. A parent symlink swapped
    // between canonicalize and open must not disclose a private target.
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        let actual = fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))?;
        let actual = actual.to_str().ok_or_else(|| {
            FileError::new(FileErrorKind::UnsupportedEncoding, "文件路径不是有效 UTF-8")
        })?;
        check_file_path_syntax(actual)?;
        if actual != path {
            return Err(FileError::new(
                FileErrorKind::VersionChanged,
                "文件路径在打开期间变化",
            ));
        }
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::fd::AsRawFd;
        let mut buffer = [0u8; libc::PATH_MAX as usize];
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) } < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let end = buffer
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(buffer.len());
        let actual = std::str::from_utf8(&buffer[..end]).map_err(|_| {
            FileError::new(FileErrorKind::UnsupportedEncoding, "文件路径不是有效 UTF-8")
        })?;
        check_file_path_syntax(actual)?;
        if actual != path {
            return Err(FileError::new(
                FileErrorKind::VersionChanged,
                "文件路径在打开期间变化",
            ));
        }
    }
    Ok(file)
}

pub fn inspect_local_agent_file(terminal: &FileInspection) -> FileResult<FileInspection> {
    terminal.validate(&terminal.path)?;
    let environment = local_file_environment()?;
    if !terminal
        .environment
        .as_ref()
        .is_some_and(|expected| expected.matches(&environment))
    {
        return Err(FileError::new(
            FileErrorKind::Unavailable,
            "本地文件环境与当前终端不一致",
        ));
    }
    let resolved_path = resolve(&terminal.path)?;
    let metadata = metadata(&fs::metadata(&resolved_path)?);
    Ok(FileInspection {
        path: terminal.path.clone(),
        resolved_path,
        revision: metadata.revision(),
        metadata,
        environment: Some(environment),
        scope: terminal.scope.clone(),
    })
}

pub(super) fn authorize_path(path: &str, permit: Option<&FileAccessPermit>) -> FileResult<String> {
    if let Some(permit) = permit {
        if !permit.environment.matches(&local_file_environment()?) {
            return Err(FileError::new(
                FileErrorKind::TargetChanged,
                "本地文件访问环境已变化",
            ));
        }
    } else {
        check_file_path(path)?;
    }
    let resolved = resolve(path)?;
    if let Some(permit) = permit {
        permit.check_path(path, &resolved)?;
    } else {
        check_file_path(&resolved)?;
    }
    Ok(resolved)
}

pub fn read_local_file(
    path: &str,
    options: &FileReadOptions,
    resume: Option<&FilePosition>,
    expected_revision: Option<&str>,
    cancel: Option<&AtomicBool>,
) -> FileResult<FileReadResponse> {
    read_local_impl(path, options, resume, expected_revision, cancel, None)
}
pub fn read_local_file_with_permit(
    permit: &FileAccessPermit,
    options: &FileReadOptions,
    resume: Option<&FilePosition>,
    cancel: Option<&AtomicBool>,
) -> FileResult<FileReadResponse> {
    read_local_impl(
        &permit.path,
        options,
        resume,
        Some(&permit.revision),
        cancel,
        Some(permit),
    )
}
fn read_local_impl(
    path: &str,
    options: &FileReadOptions,
    resume: Option<&FilePosition>,
    expected_revision: Option<&str>,
    cancel: Option<&AtomicBool>,
    permit: Option<&FileAccessPermit>,
) -> FileResult<FileReadResponse> {
    FileError::cancelled(cancel)?;
    options.validate()?;
    let resolved = authorize_path(path, permit)?;
    let mut file = open_bound(&resolved, false)?;
    let before = metadata(&file.metadata()?);
    let revision = before.revision();
    if expected_revision.is_some_and(|expected| expected != revision) {
        return Err(FileError::new(
            FileErrorKind::VersionChanged,
            "文件自审查或上一页读取后发生变化，请从新版本重新读取",
        ));
    }
    let page = read_text_page(&mut file, before.size, options, resume, cancel)?;
    let after = metadata(&file.metadata()?);
    FileError::cancelled(cancel)?;
    if let Some(permit) = permit {
        if !permit.environment.matches(&local_file_environment()?) {
            return Err(FileError::new(
                FileErrorKind::TargetChanged,
                "读取期间本地文件环境已变化",
            ));
        }
    }
    Ok(FileReadResponse {
        path: path.into(),
        resolved_path: resolved,
        revision,
        metadata: before.clone(),
        changed_during_read: before != after,
        page,
    })
}

pub fn list_local_directory(
    path: &str,
    offset: usize,
    limit: usize,
    expected_revision: Option<&str>,
    cancel: Option<&AtomicBool>,
) -> FileResult<FileDirectoryResponse> {
    list_local_impl(path, offset, limit, expected_revision, cancel, None)
}
pub fn list_local_directory_with_permit(
    permit: &FileAccessPermit,
    offset: usize,
    limit: usize,
    cancel: Option<&AtomicBool>,
) -> FileResult<FileDirectoryResponse> {
    list_local_impl(
        &permit.path,
        offset,
        limit,
        Some(&permit.revision),
        cancel,
        Some(permit),
    )
}
fn list_local_impl(
    path: &str,
    offset: usize,
    limit: usize,
    expected_revision: Option<&str>,
    cancel: Option<&AtomicBool>,
    permit: Option<&FileAccessPermit>,
) -> FileResult<FileDirectoryResponse> {
    FileError::cancelled(cancel)?;
    let resolved = authorize_path(path, permit)?;
    let directory = open_bound(&resolved, true)?;
    let before = metadata(&directory.metadata()?);
    if before.kind != FileKind::Directory {
        return Err(FileError::new(FileErrorKind::NotDirectory, "路径不是目录"));
    }
    let revision = before.revision();
    if expected_revision.is_some_and(|expected| expected != revision) {
        return Err(FileError::new(
            FileErrorKind::VersionChanged,
            "目录自上一页读取后发生变化，请重新列出",
        ));
    }
    // fdopendir keeps the same verified directory across parent path changes.
    #[cfg(unix)]
    let entries = UnixDirectory::new(&directory)?;
    #[cfg(not(unix))]
    let entries = fs::read_dir(&resolved)?.map(|entry| -> FileResult<FileDirectoryEntry> {
        let entry = entry?;
        let meta = metadata(&fs::symlink_metadata(entry.path())?);
        let name = entry.file_name().into_string().map_err(|_| {
            FileError::new(
                FileErrorKind::UnsupportedEncoding,
                "目录包含非 UTF-8 文件名",
            )
        })?;
        Ok(FileDirectoryEntry {
            name,
            kind: meta.kind,
            size: Some(meta.size),
        })
    });
    let page = directory_page(entries, offset, limit, cancel)?;
    let after = metadata(&directory.metadata()?);
    FileError::cancelled(cancel)?;
    if let Some(permit) = permit {
        if !permit.environment.matches(&local_file_environment()?) {
            return Err(FileError::new(
                FileErrorKind::TargetChanged,
                "读取期间本地文件环境已变化",
            ));
        }
    }
    Ok(FileDirectoryResponse {
        path: path.into(),
        resolved_path: resolved,
        revision,
        changed_during_read: before != after,
        page,
    })
}

#[cfg(unix)]
struct UnixDirectory {
    pointer: *mut libc::DIR,
}
#[cfg(unix)]
impl UnixDirectory {
    fn new(file: &File) -> FileResult<Self> {
        use std::os::fd::AsRawFd;
        let fd = unsafe { libc::dup(file.as_raw_fd()) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let pointer = unsafe { libc::fdopendir(fd) };
        if pointer.is_null() {
            let error = std::io::Error::last_os_error();
            unsafe {
                libc::close(fd);
            }
            return Err(error.into());
        }
        Ok(Self { pointer })
    }
}
#[cfg(unix)]
impl Iterator for UnixDirectory {
    type Item = FileResult<FileDirectoryEntry>;
    fn next(&mut self) -> Option<Self::Item> {
        loop {
            #[cfg(target_os = "macos")]
            unsafe {
                *libc::__error() = 0;
            }
            #[cfg(target_os = "linux")]
            unsafe {
                *libc::__errno_location() = 0;
            }
            let raw = unsafe { libc::readdir(self.pointer) };
            if raw.is_null() {
                let error = std::io::Error::last_os_error();
                return if error.raw_os_error().unwrap_or(0) == 0 {
                    None
                } else {
                    Some(Err(error.into()))
                };
            }
            let name = unsafe { std::ffi::CStr::from_ptr((*raw).d_name.as_ptr()) };
            if name.to_bytes() == b"." || name.to_bytes() == b".." {
                continue;
            }
            let name_text = match name.to_str() {
                Ok(value) => value,
                Err(_) => {
                    return Some(Err(FileError::new(
                        FileErrorKind::UnsupportedEncoding,
                        "目录包含非 UTF-8 文件名",
                    )))
                }
            };
            let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
            if unsafe {
                libc::fstatat(
                    libc::dirfd(self.pointer),
                    name.as_ptr(),
                    metadata.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } < 0
            {
                return Some(Err(std::io::Error::last_os_error().into()));
            }
            let metadata = unsafe { metadata.assume_init() };
            let kind = match metadata.st_mode & libc::S_IFMT {
                libc::S_IFREG => FileKind::File,
                libc::S_IFDIR => FileKind::Directory,
                libc::S_IFLNK => FileKind::Symlink,
                _ => FileKind::Other,
            };
            return Some(Ok(FileDirectoryEntry {
                name: name_text.into(),
                kind,
                size: metadata.st_size.try_into().ok(),
            }));
        }
    }
}
#[cfg(unix)]
impl Drop for UnixDirectory {
    fn drop(&mut self) {
        unsafe {
            libc::closedir(self.pointer);
        }
    }
}
