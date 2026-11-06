use super::{FileError, FileErrorKind, FileResult};

/// The same check is required for the requested path and its resolved target.
/// Sensitive contents need a separately reviewed access operation; no ordinary
/// file reader can enable them by accepting an `internal` flag from a model.
pub fn check_file_path(path: &str) -> FileResult<()> {
    check_file_path_syntax(path)?;
    if sensitive_file_path(path) {
        return Err(FileError::new(
            FileErrorKind::SensitivePath,
            "该路径可能包含凭据，需要单独确认读取范围",
        ));
    }
    Ok(())
}

pub fn check_file_path_syntax(path: &str) -> FileResult<()> {
    let bytes = path.as_bytes();
    let absolute = path.starts_with('/')
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'/' | b'\\'));
    if !absolute
        || path.len() > 4096
        || path.chars().any(char::is_control)
        || path
            .split(['/', '\\'])
            .any(|part| matches!(part, "." | ".."))
    {
        return Err(FileError::new(
            FileErrorKind::InvalidRequest,
            "文件工具需要不含控制字符和上级跳转的绝对路径",
        ));
    }
    Ok(())
}

pub fn sensitive_file_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/").to_lowercase();
    let parts = normalized
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let base = parts.last().copied().unwrap_or("");
    parts.iter().any(|part| {
        matches!(*part, ".ssh" | ".aws" | ".kube" | ".docker" | "keychains")
            || *part == ".env"
            || part.starts_with(".env.")
            || part.starts_with("shadow")
            || part.starts_with("gshadow")
            || part.starts_with("sudoers")
    }) || [".pem", ".key", ".p12", ".pfx", ".jks", ".keychain-db"]
        .iter()
        .any(|suffix| base.ends_with(suffix))
        || [
            ".netrc",
            ".npmrc",
            ".pypirc",
            "login data",
            "logins.json",
            "cookies",
        ]
        .contains(&base)
}
