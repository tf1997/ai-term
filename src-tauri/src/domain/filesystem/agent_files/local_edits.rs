use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

pub fn edit_local_file(
    dispatch: &FileEditDispatch,
    cancel: Option<&AtomicBool>,
    started: &AtomicBool,
) -> FileEditOutcome {
    match write(dispatch, cancel, started) {
        Ok(value) => dispatch.validate_outcome(value),
        Err(error) => FileEditOutcome::failure(error, started.load(Ordering::SeqCst)),
    }
}

#[cfg(not(unix))]
fn write(
    _: &FileEditDispatch,
    _: Option<&AtomicBool>,
    _: &AtomicBool,
) -> FileResult<FileEditOutcome> {
    Err(FileError::new(
        FileErrorKind::Unavailable,
        "此平台没有已验证的安全本地写入实现",
    ))
}

#[cfg(unix)]
fn write(
    dispatch: &FileEditDispatch,
    cancel: Option<&AtomicBool>,
    started: &AtomicBool,
) -> FileResult<FileEditOutcome> {
    use super::local::{authorize_path, metadata, open_bound};
    use std::ffi::CString;
    use std::fs::File;
    use std::io::{Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::MetadataExt;
    use std::path::Path;

    let proposal = dispatch.proposal();
    if proposal.provider != FileProvider::Local {
        return Err(FileError::new(
            FileErrorKind::InvalidRequest,
            "文件提供方不匹配",
        ));
    }
    let permit = dispatch.native_permit()?;
    let resolved = authorize_path(&proposal.path, Some(&permit))?;
    let path = Path::new(&resolved);
    let parent = path
        .parent()
        .and_then(Path::to_str)
        .ok_or_else(|| FileError::new(FileErrorKind::InvalidRequest, "文件没有父目录"))?;
    let name = CString::new(path.file_name().unwrap().as_encoded_bytes())
        .map_err(|e| FileError::new(FileErrorKind::InvalidRequest, e.to_string()))?;
    let directory = open_bound(parent, true)?;
    let dirfd = directory.as_raw_fd();
    let conflict = || {
        FileError::new(
            FileErrorKind::VersionChanged,
            "文件内容、权限或路径自完整读取后发生变化",
        )
    };
    let check = || -> FileResult<File> {
        FileError::cancelled(cancel)?;
        if authorize_path(&proposal.path, Some(&permit))? != resolved {
            return Err(conflict());
        }
        // Both the path and the directory descriptor must still denote the
        // reviewed directory immediately before the commit.
        if metadata(&open_bound(parent, true)?.metadata()?) != metadata(&directory.metadata()?) {
            return Err(conflict());
        }
        let fd = unsafe {
            libc::openat(
                dirfd,
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let before = metadata(&file.metadata()?);
        if before.kind != FileKind::File || Some(&before.revision()) != proposal.revision.as_ref() {
            return Err(conflict());
        }
        let mut bytes = Vec::new();
        (&file)
            .take((MAX_FILE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)?;
        if proposal.before.as_deref().map(str::as_bytes) != Some(bytes.as_slice())
            || before != metadata(&file.metadata()?)
        {
            return Err(conflict());
        }
        Ok(file)
    };
    let original = check()?;
    let stat = original.metadata()?;
    let metadata_backup = super::extended_metadata::capture(&original);
    let before_attributes = FileEditAttributes {
        mode: stat.mode() & 0o7777,
        uid: stat.uid(),
        gid: stat.gid(),
        extended_metadata: metadata_backup
            .as_ref()
            .map(|value| !value.xattrs.is_empty() || value.acl.is_some()),
        metadata_backup,
    };
    // Files with multiple hard links cannot be safely represented by a single
    // path replacement; require an explicit workflow for their other aliases.
    if stat.nlink() != 1 {
        return Err(FileError::new(
            FileErrorKind::Unavailable,
            "文件有多个硬链接，不能按单一路径替换",
        ));
    }
    let wanted = proposal
        .restore_attributes
        .as_ref()
        .unwrap_or(&before_attributes);
    let mut temporary = None;
    struct Temp<'a> {
        directory: &'a File,
        name: CString,
        owned: bool,
    }
    impl Drop for Temp<'_> {
        fn drop(&mut self) {
            if self.owned {
                unsafe {
                    libc::unlinkat(self.directory.as_raw_fd(), self.name.as_ptr(), 0);
                }
            }
        }
    }
    if let Some(after) = &proposal.after {
        let temp_name = CString::new(format!(".ai-term-{}.tmp", uuid::Uuid::new_v4())).unwrap();
        let fd = unsafe {
            libc::openat(
                dirfd,
                temp_name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let cleanup = Temp {
            directory: &directory,
            name: temp_name,
            owned: true,
        };
        let mut file = unsafe { File::from_raw_fd(fd) };
        file.write_all(after.as_bytes())?;
        copy_extended_attributes(&original, &file)?;
        let actual = file.metadata()?;
        if (actual.uid() != wanted.uid || actual.gid() != wanted.gid)
            && unsafe { libc::fchown(fd, wanted.uid, wanted.gid) } < 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        if unsafe { libc::fchmod(fd, wanted.mode as libc::mode_t) } < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        file.sync_all()?;
        temporary = Some(cleanup);
    }
    check()?;
    FileError::cancelled(cancel)?;
    started.store(true, Ordering::SeqCst);
    let result = if let Some(temp) = &temporary {
        unsafe { libc::renameat(dirfd, temp.name.as_ptr(), dirfd, name.as_ptr()) }
    } else {
        unsafe { libc::unlinkat(dirfd, name.as_ptr(), 0) }
    };
    if result < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    if let Some(temp) = &mut temporary {
        temp.owned = false;
    }
    directory.sync_all()?;
    if !permit.environment().matches(&local_file_environment()?) {
        return Err(FileError::new(
            FileErrorKind::TargetChanged,
            "写入期间文件环境发生变化",
        ));
    }
    let (revision, content_hash, after_attributes) = if let Some(after) = &proposal.after {
        authorize_path(&proposal.path, Some(&permit))?;
        let current = open_bound(&resolved, false)?;
        let stat = current.metadata()?;
        let metadata_backup = super::extended_metadata::capture(&current);
        let mut actual = Vec::new();
        (&current)
            .take((MAX_FILE_BYTES + 1) as u64)
            .read_to_end(&mut actual)?;
        let attributes = FileEditAttributes {
            mode: stat.mode() & 0o7777,
            uid: stat.uid(),
            gid: stat.gid(),
            extended_metadata: metadata_backup
                .as_ref()
                .map(|value| !value.xattrs.is_empty() || value.acl.is_some()),
            metadata_backup,
        };
        if actual != after.as_bytes()
            || &attributes != wanted
            || metadata(&stat) != metadata(&current.metadata()?)
        {
            return Err(conflict());
        }
        (
            Some(metadata(&stat).revision()),
            Some(file_content_hash(after)),
            Some(attributes),
        )
    } else {
        match std::fs::symlink_metadata(&resolved) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err(conflict()),
        }
        (None, None, None)
    };
    // Replacing the parent while checking the write must never be reported as
    // success in the visible path, even though the bound directory was changed.
    if metadata(&open_bound(parent, true)?.metadata()?) != metadata(&directory.metadata()?) {
        return Err(conflict());
    }
    Ok(FileEditOutcome {
        status: FileEditStatus::Applied,
        revision,
        content_hash,
        before_attributes: Some(before_attributes),
        after_attributes,
        error: None,
    })
}

#[cfg(unix)]
fn copy_extended_attributes(source: &std::fs::File, destination: &std::fs::File) -> FileResult<()> {
    use std::os::fd::AsRawFd;
    let src = source.as_raw_fd();
    let dst = destination.as_raw_fd();
    #[cfg(target_os = "macos")]
    unsafe {
        // fcopyfile preserves extended attributes and ACLs without following
        // paths or replacing the already-bound temporary file descriptor.
        if libc::fcopyfile(
            src,
            dst,
            std::ptr::null_mut(),
            libc::COPYFILE_XATTR | libc::COPYFILE_ACL,
        ) != 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    #[cfg(target_os = "linux")]
    unsafe {
        let size = libc::flistxattr(src, std::ptr::null_mut(), 0);
        if size < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        if size > 65536 {
            return Err(FileError::new(
                FileErrorKind::ScanLimit,
                "扩展属性超过复制预算",
            ));
        }
        let mut names = vec![0u8; size as usize];
        let count = libc::flistxattr(src, names.as_mut_ptr().cast(), names.len());
        if count < 0 || count != size {
            return Err(FileError::new(
                FileErrorKind::VersionChanged,
                "扩展属性在准备写入时变化",
            ));
        }
        let mut total = names.len();
        for name in names.split_inclusive(|b| *b == 0) {
            let len = libc::fgetxattr(src, name.as_ptr().cast(), std::ptr::null_mut(), 0);
            if !(0..=65536).contains(&len) {
                return Err(FileError::new(
                    FileErrorKind::Unavailable,
                    "无法完整复制扩展属性",
                ));
            }
            total += len as usize;
            if total > MAX_FILE_BYTES {
                return Err(FileError::new(
                    FileErrorKind::ScanLimit,
                    "扩展属性超过复制预算",
                ));
            }
            let mut value = vec![0u8; len as usize];
            if libc::fgetxattr(
                src,
                name.as_ptr().cast(),
                value.as_mut_ptr().cast(),
                value.len(),
            ) != len
                || libc::fsetxattr(
                    dst,
                    name.as_ptr().cast(),
                    value.as_ptr().cast(),
                    value.len(),
                    0,
                ) < 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (src, dst);
        return Err(FileError::new(
            FileErrorKind::Unavailable,
            "无法验证此平台的文件权限元数据",
        ));
    }
    Ok(())
}
