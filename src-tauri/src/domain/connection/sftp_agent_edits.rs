use super::agent_files::{
    authorized_path, check_environment, file_error, metadata, on_bound_route, resolve,
};
use super::*;
use crate::domain::filesystem::agent_files::*;

/// Dispatch stays on the reader's established route. SFTP v3 rename flags
/// cannot require overwrite/atomic semantics. Keep the original file object,
/// advertise an in-place write, and retain unknown partial effects on failure.
pub fn edit_agent_file_sftp(
    profile: &ConnectionProfile,
    target: &SftpTargetOverride,
    dispatch: &FileEditDispatch,
    cancel: Option<&SftpCancelToken>,
    started: &AtomicBool,
) -> FileEditOutcome {
    let result = write(profile, target, dispatch, cancel, started);
    match result {
        Ok(value) => dispatch.validate_outcome(value),
        Err(error) => FileEditOutcome::failure(error, started.load(Ordering::SeqCst)),
    }
}
fn attributes(stat: &ssh2::FileStat) -> FileResult<FileEditAttributes> {
    match (stat.perm, stat.uid, stat.gid) {
        (Some(mode), Some(uid), Some(gid)) => Ok(FileEditAttributes {
            mode: mode & 0o7777,
            uid,
            gid,
            extended_metadata: None,
            metadata_backup: None,
        }),
        _ => Err(FileError::new(
            FileErrorKind::Unavailable,
            "SFTP 未返回完整的权限及属主，不能安全替换文件",
        )),
    }
}
fn write(
    profile: &ConnectionProfile,
    target: &SftpTargetOverride,
    dispatch: &FileEditDispatch,
    cancel: Option<&SftpCancelToken>,
    started: &AtomicBool,
) -> FileResult<FileEditOutcome> {
    let p = dispatch.proposal();
    if p.provider != FileProvider::Sftp {
        return Err(FileError::new(
            FileErrorKind::InvalidRequest,
            "文件提供方不匹配",
        ));
    }
    let permit = dispatch.native_permit()?;
    let route = dispatch
        .route()
        .ok_or_else(|| FileError::new(FileErrorKind::TargetChanged, "SFTP 写入路径绑定缺失"))?;
    on_bound_route(profile, route, target, cancel, |connection| {
        let resolved = authorized_path(connection, &p.path, Some(&permit))?;
        let path = Path::new(&resolved);
        let conflict = || {
            FileError::new(
                FileErrorKind::VersionChanged,
                "SFTP 文件内容、版本或路径自完整读取后发生变化",
            )
        };
        let check = || -> FileResult<ssh2::FileStat> {
            FileError::cancelled(cancel.map(Arc::as_ref))?;
            if authorized_path(connection, &p.path, Some(&permit))? != resolved {
                return Err(conflict());
            }
            let before = connection.sftp.lstat(path).map_err(file_error)?;
            if !before.is_file() || Some(&metadata(&before).revision()) != p.revision.as_ref() {
                return Err(conflict());
            }
            let mut file = connection.sftp.open(path).map_err(file_error)?;
            if metadata(&file.stat().map_err(file_error)?) != metadata(&before) {
                return Err(conflict());
            }
            let mut bytes = Vec::new();
            (&mut file)
                .take((MAX_FILE_BYTES + 1) as u64)
                .read_to_end(&mut bytes)?;
            if p.before.as_deref().map(str::as_bytes) != Some(bytes.as_slice())
                || metadata(&file.stat().map_err(file_error)?) != metadata(&before)
                || metadata(&connection.sftp.lstat(path).map_err(file_error)?) != metadata(&before)
                || resolve(connection, &p.path)? != resolved
            {
                return Err(conflict());
            }
            Ok(before)
        };
        let before = check()?;
        let before_attributes = attributes(&before)?;
        let wanted = p.restore_attributes.as_ref().unwrap_or(&before_attributes);
        if let Some(after) = &p.after {
            use std::io::{Seek, SeekFrom};
            // No CREATE or TRUNCATE: opening the reviewed object must not itself
            // change it. Existing server ACLs/xattrs stay on the same object.
            let mut file = connection
                .sftp
                .open_mode(
                    path,
                    ssh2::OpenFlags::READ | ssh2::OpenFlags::WRITE,
                    0,
                    ssh2::OpenType::File,
                )
                .map_err(file_error)?;
            if metadata(&file.stat().map_err(file_error)?) != metadata(&before) {
                return Err(conflict());
            }
            let mut original = Vec::new();
            (&mut file)
                .take((MAX_FILE_BYTES + 1) as u64)
                .read_to_end(&mut original)?;
            if p.before.as_deref().map(str::as_bytes) != Some(original.as_slice())
                || metadata(&file.stat().map_err(file_error)?) != metadata(&before)
            {
                return Err(conflict());
            }
            file.seek(SeekFrom::Start(0))?;
            check()?;
            check_environment(connection, Some(&permit))?;
            FileError::cancelled(cancel.map(Arc::as_ref))?;
            started.store(true, Ordering::SeqCst);
            file.write_all(after.as_bytes())?;
            // Truncate only after the replacement bytes have been sent. Any
            // failed write, size update, or close acknowledgement is unknown.
            file.setstat(ssh2::FileStat {
                size: Some(after.len() as u64),
                uid: None,
                gid: None,
                perm: None,
                atime: None,
                mtime: None,
            })
            .map_err(file_error)?;
            let current = attributes(&file.stat().map_err(file_error)?)?;
            if current != *wanted {
                file.setstat(ssh2::FileStat {
                    size: None,
                    uid: Some(wanted.uid),
                    gid: Some(wanted.gid),
                    perm: Some(wanted.mode),
                    atime: None,
                    mtime: None,
                })
                .map_err(file_error)?;
            }
            file.close().map_err(file_error)?;
        } else {
            check()?;
            check_environment(connection, Some(&permit))?;
            FileError::cancelled(cancel.map(Arc::as_ref))?;
            started.store(true, Ordering::SeqCst);
            connection.sftp.unlink(path).map_err(file_error)?;
        }
        check_environment(connection, Some(&permit))?;
        let (revision, content_hash, after_attributes) = if let Some(after) = &p.after {
            if resolve(connection, &p.path)? != resolved {
                return Err(conflict());
            }
            let before = connection.sftp.lstat(path).map_err(file_error)?;
            if !before.is_file() {
                return Err(conflict());
            }
            let mut file = connection.sftp.open(path).map_err(file_error)?;
            if metadata(&file.stat().map_err(file_error)?) != metadata(&before) {
                return Err(conflict());
            }
            let mut actual = Vec::new();
            (&mut file)
                .take((MAX_FILE_BYTES + 1) as u64)
                .read_to_end(&mut actual)?;
            let actual_attributes = attributes(&before)?;
            if actual != after.as_bytes()
                || actual_attributes != *wanted
                || metadata(&file.stat().map_err(file_error)?) != metadata(&before)
                || metadata(&connection.sftp.lstat(path).map_err(file_error)?) != metadata(&before)
            {
                return Err(conflict());
            }
            (
                Some(metadata(&before).revision()),
                Some(file_content_hash(after)),
                Some(actual_attributes),
            )
        } else {
            match connection.sftp.lstat(path) {
                Err(error) if error.code() == ssh2::ErrorCode::SFTP(2) => {}
                _ => return Err(conflict()),
            }
            (None, None, None)
        };
        check_environment(connection, Some(&permit))?;
        Ok(FileEditOutcome {
            status: FileEditStatus::Applied,
            revision,
            content_hash,
            before_attributes: Some(before_attributes),
            after_attributes,
            error: None,
        })
    })
}
