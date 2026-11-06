use super::*;
use crate::domain::filesystem::agent_files::{self, *};

pub(super) fn file_error(error: ssh2::Error) -> FileError {
    let kind = match error.code() {
        ssh2::ErrorCode::SFTP(2) => FileErrorKind::Missing,
        ssh2::ErrorCode::SFTP(3) => FileErrorKind::PermissionDenied,
        _ => FileErrorKind::Transport,
    };
    FileError::new(kind, error.to_string())
}

pub(super) fn metadata(stat: &ssh2::FileStat) -> FileMetadata {
    let kind = if stat.is_file() {
        FileKind::File
    } else if stat.is_dir() {
        FileKind::Directory
    } else if stat.perm.unwrap_or(0) & 0o170000 == 0o120000 {
        FileKind::Symlink
    } else {
        FileKind::Other
    };
    FileMetadata {
        kind,
        size: stat.size.unwrap_or(0),
        modified_ns: stat
            .mtime
            .and_then(|seconds| seconds.checked_mul(1_000_000_000)),
        identity: Some(format!("{:?}:{:?}:{:?}", stat.uid, stat.gid, stat.perm)),
    }
}

pub(super) fn resolve(connection: &NativeSftpConnection, path: &str) -> FileResult<String> {
    check_file_path_syntax(path)?;
    let resolved = connection
        .sftp
        .realpath(Path::new(path))
        .map_err(file_error)?;
    let value = resolved.to_str().ok_or_else(|| {
        FileError::new(
            FileErrorKind::UnsupportedEncoding,
            "SFTP 文件路径不是有效的 UTF-8",
        )
    })?;
    check_file_path_syntax(value)?;
    Ok(value.into())
}

/// One immutable route, one pooled connection. No system-sftp download or
/// fallback to another host after an operation has started.
pub(super) fn on_bound_route<T>(
    profile: &ConnectionProfile,
    expected_route: &str,
    target: &SftpTargetOverride,
    cancel: Option<&SftpCancelToken>,
    action: impl Fn(&NativeSftpConnection) -> FileResult<T>,
) -> FileResult<T> {
    validate_sftp_profile_route(profile, Some(expected_route))
        .map_err(|error| FileError::new(FileErrorKind::TargetChanged, error.to_string()))?;
    FileError::cancelled(cancel.map(Arc::as_ref))?;
    if native_sftp_routes(profile, target).is_empty() {
        return Err(FileError::new(
            FileErrorKind::Unavailable,
            "此连接未启用原生 SFTP 文件读取",
        ));
    }
    let route = primary_sftp_route(profile, target);
    let key = native_sftp_cache_key(profile, &route);
    run_cached_native_sftp_route(&route, &key, cancel, |connection| {
        action(connection)
            .map_err(anyhow::Error::new)
            .context(SFTP_ACTION_STARTED)
    })
    .map_err(|error| {
        if cancel.is_some_and(|token| token.load(Ordering::SeqCst)) {
            return FileError::new(FileErrorKind::Cancelled, "文件操作已取消");
        }
        if let Some(error) = error.downcast_ref::<FileError>() {
            return error.clone();
        }
        let message = format!("{error:#}");
        // No file action produced this error: the channel itself was not
        // available. Initial selection may use the current terminal instead;
        // dispatch never changes provider. Host-key/auth failures stay explicit.
        let kind = if contains_host_key_verification_failure(&message.to_ascii_lowercase())
            || message.to_ascii_lowercase().contains("authentication")
            || message.contains("认证失败")
        {
            FileErrorKind::Transport
        } else {
            FileErrorKind::Unavailable
        };
        FileError::new(kind, message)
    })
}

fn sftp_environment(connection: &NativeSftpConnection) -> FileResult<FileEnvironment> {
    let evidence = |path, limit| {
        read_bounded_evidence(
            connection.sftp.open(Path::new(path)).map_err(file_error)?,
            limit,
        )
    };
    let link = |path| -> FileResult<String> {
        connection
            .sftp
            .readlink(Path::new(path))
            .map_err(file_error)?
            .to_str()
            .map(str::to_owned)
            .ok_or_else(|| {
                FileError::new(FileErrorKind::Unavailable, "SFTP 环境路径无法表示为 UTF-8")
            })
    };
    let environment = FileEnvironment::Linux {
        boot: evidence("/proc/sys/kernel/random/boot_id", 64)?,
        mount: link("/proc/self/ns/mnt")?,
        root: link("/proc/self/root")?,
        root_mount: Some(linux_root_mount(&evidence(
            "/proc/self/mountinfo",
            MAX_MOUNTINFO_BYTES,
        )?)?),
        credentials: linux_credentials(&evidence("/proc/self/status", 16384)?)?,
        security: evidence("/proc/self/attr/current", 4096)?,
    };
    environment.validate()?;
    Ok(environment)
}

pub fn inspect_agent_file_sftp(
    profile: &ConnectionProfile,
    expected_route: &str,
    target: &SftpTargetOverride,
    terminal: &FileInspection,
    cancel: Option<&SftpCancelToken>,
) -> FileResult<FileInspection> {
    terminal.validate(&terminal.path)?;
    let expected = terminal.environment.as_ref().ok_or_else(|| {
        FileError::new(
            FileErrorKind::Unavailable,
            "当前终端没有可与 SFTP 核对的文件环境证据",
        )
    })?;
    if !matches!(expected, FileEnvironment::Linux { .. }) {
        return Err(FileError::new(
            FileErrorKind::Unavailable,
            "此平台的 SFTP 文件环境无法可靠核对，使用当前终端",
        ));
    }
    on_bound_route(profile, expected_route, target, cancel, |connection| {
        let environment = sftp_environment(connection).map_err(|_| {
            FileError::new(
                FileErrorKind::Unavailable,
                "SFTP 不提供完整的文件环境证据，使用当前终端",
            )
        })?;
        if !expected.matches(&environment) {
            return Err(FileError::new(
                FileErrorKind::Unavailable,
                "SFTP 与当前终端的主机、账号或文件系统不同",
            ));
        }
        // Target file lookup occurs only after establishing the mapping. A
        // missing/denied target is returned as such, never read in another login.
        let resolved_path = resolve(connection, &terminal.path)?;
        let metadata = metadata(
            &connection
                .sftp
                .stat(Path::new(&resolved_path))
                .map_err(file_error)?,
        );
        Ok(FileInspection {
            path: terminal.path.clone(),
            resolved_path,
            revision: metadata.revision(),
            metadata,
            environment: Some(environment),
            scope: terminal.scope.clone(),
        })
    })
}
pub(super) fn check_environment(
    connection: &NativeSftpConnection,
    permit: Option<&FileAccessPermit>,
) -> FileResult<()> {
    if let Some(permit) = permit {
        if !permit.environment().matches(
            &sftp_environment(connection).map_err(|_| {
                FileError::new(FileErrorKind::TargetChanged, "SFTP 文件环境证据已失效")
            })?,
        ) {
            return Err(FileError::new(
                FileErrorKind::TargetChanged,
                "SFTP 文件环境自审查后发生变化",
            ));
        }
    }
    Ok(())
}
pub(super) fn authorized_path(
    connection: &NativeSftpConnection,
    path: &str,
    permit: Option<&FileAccessPermit>,
) -> FileResult<String> {
    check_environment(connection, permit)?;
    let resolved = resolve(connection, path)?;
    if let Some(permit) = permit {
        permit.check_path(path, &resolved)?;
    } else {
        check_file_path(path)?;
        check_file_path(&resolved)?;
    }
    Ok(resolved)
}

pub fn read_agent_file_sftp(
    profile: &ConnectionProfile,
    expected_route: &str,
    target: &SftpTargetOverride,
    path: &str,
    options: &FileReadOptions,
    resume: Option<&FilePosition>,
    expected_revision: Option<&str>,
    cancel: Option<&SftpCancelToken>,
) -> FileResult<FileReadResponse> {
    read_impl(
        profile,
        expected_route,
        target,
        path,
        options,
        resume,
        expected_revision,
        cancel,
        None,
    )
}
pub fn read_agent_file_sftp_with_permit(
    profile: &ConnectionProfile,
    expected_route: &str,
    target: &SftpTargetOverride,
    permit: &FileAccessPermit,
    options: &FileReadOptions,
    resume: Option<&FilePosition>,
    cancel: Option<&SftpCancelToken>,
) -> FileResult<FileReadResponse> {
    read_impl(
        profile,
        expected_route,
        target,
        &permit.path,
        options,
        resume,
        Some(&permit.revision),
        cancel,
        Some(permit),
    )
}
fn read_impl(
    profile: &ConnectionProfile,
    expected_route: &str,
    target: &SftpTargetOverride,
    path: &str,
    options: &FileReadOptions,
    resume: Option<&FilePosition>,
    expected_revision: Option<&str>,
    cancel: Option<&SftpCancelToken>,
    permit: Option<&FileAccessPermit>,
) -> FileResult<FileReadResponse> {
    options.validate()?;
    if permit.is_none() {
        check_file_path(path)?;
    }
    on_bound_route(profile, expected_route, target, cancel, |connection| {
        let resolved = authorized_path(connection, path, permit)?;
        let path_stat = metadata(
            &connection
                .sftp
                .lstat(Path::new(&resolved))
                .map_err(file_error)?,
        );
        if path_stat.kind != FileKind::File {
            return Err(FileError::new(
                FileErrorKind::NotRegularFile,
                "路径不是普通文件",
            ));
        }
        let mut file = connection
            .sftp
            .open(Path::new(&resolved))
            .map_err(file_error)?;
        let before = metadata(&file.stat().map_err(file_error)?);
        if before.kind != FileKind::File
            || before != path_stat
            || resolve(connection, path)? != resolved
        {
            return Err(FileError::new(
                FileErrorKind::VersionChanged,
                "文件在打开期间发生变化",
            ));
        }
        let revision = before.revision();
        if expected_revision.is_some_and(|expected| expected != revision) {
            return Err(FileError::new(
                FileErrorKind::VersionChanged,
                "文件自上一页读取后发生变化，请重新读取",
            ));
        }
        let page = agent_files::read_text_page(
            &mut file,
            before.size,
            options,
            resume,
            cancel.map(Arc::as_ref),
        )?;
        let after = metadata(&file.stat().map_err(file_error)?);
        check_environment(connection, permit)?;
        Ok(FileReadResponse {
            path: path.into(),
            resolved_path: resolved,
            metadata: before.clone(),
            revision,
            changed_during_read: before != after,
            page,
        })
    })
}

pub fn list_agent_directory_sftp(
    profile: &ConnectionProfile,
    expected_route: &str,
    target: &SftpTargetOverride,
    path: &str,
    offset: usize,
    limit: usize,
    expected_revision: Option<&str>,
    cancel: Option<&SftpCancelToken>,
) -> FileResult<FileDirectoryResponse> {
    list_impl(
        profile,
        expected_route,
        target,
        path,
        offset,
        limit,
        expected_revision,
        cancel,
        None,
    )
}
pub fn list_agent_directory_sftp_with_permit(
    profile: &ConnectionProfile,
    expected_route: &str,
    target: &SftpTargetOverride,
    permit: &FileAccessPermit,
    offset: usize,
    limit: usize,
    cancel: Option<&SftpCancelToken>,
) -> FileResult<FileDirectoryResponse> {
    list_impl(
        profile,
        expected_route,
        target,
        &permit.path,
        offset,
        limit,
        Some(&permit.revision),
        cancel,
        Some(permit),
    )
}
fn list_impl(
    profile: &ConnectionProfile,
    expected_route: &str,
    target: &SftpTargetOverride,
    path: &str,
    offset: usize,
    limit: usize,
    expected_revision: Option<&str>,
    cancel: Option<&SftpCancelToken>,
    permit: Option<&FileAccessPermit>,
) -> FileResult<FileDirectoryResponse> {
    if permit.is_none() {
        check_file_path(path)?;
    }
    on_bound_route(profile, expected_route, target, cancel, |connection| {
        let resolved = authorized_path(connection, path, permit)?;
        let before = metadata(
            &connection
                .sftp
                .stat(Path::new(&resolved))
                .map_err(file_error)?,
        );
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
        let mut directory = connection
            .sftp
            .opendir(Path::new(&resolved))
            .map_err(file_error)?;
        let mut raw_entries = 0;
        let entries = std::iter::from_fn(|| loop {
            if let Err(error) = FileError::cancelled(cancel.map(Arc::as_ref)) {
                return Some(Err(error));
            }
            // Even dot entries from a malformed server consume a scan budget.
            raw_entries += 1;
            if raw_entries > agent_files::MAX_DIRECTORY_SCAN + 2 {
                return Some(Err(FileError::new(
                    FileErrorKind::ScanLimit,
                    "SFTP 目录扫描达到上限",
                )));
            }
            match directory.readdir() {
                Ok((name, stat)) => {
                    if name == Path::new(".") || name == Path::new("..") {
                        continue;
                    }
                    return Some(
                        name.to_str()
                            .ok_or_else(|| {
                                FileError::new(
                                    FileErrorKind::UnsupportedEncoding,
                                    "SFTP 目录包含非 UTF-8 文件名",
                                )
                            })
                            .map(|name| FileDirectoryEntry {
                                name: name.into(),
                                kind: metadata(&stat).kind,
                                size: stat.size,
                            }),
                    );
                }
                Err(error) if error.code() == ssh2::ErrorCode::Session(-16) => return None, // libssh2 readdir EOF
                Err(error) => return Some(Err(file_error(error))),
            }
        });
        let page = agent_files::directory_page(entries, offset, limit, cancel.map(Arc::as_ref))?;
        let after = metadata(
            &connection
                .sftp
                .stat(Path::new(&resolved))
                .map_err(file_error)?,
        );
        check_environment(connection, permit)?;
        Ok(FileDirectoryResponse {
            path: path.into(),
            resolved_path: resolved,
            revision,
            changed_during_read: before != after,
            page,
        })
    })
}
