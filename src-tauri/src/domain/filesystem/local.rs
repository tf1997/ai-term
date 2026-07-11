use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalDirectoryResponse {
    pub path: String,
    pub home: String,
    pub entries: Vec<LocalFileEntry>,
}

pub fn home_directory() -> Result<String> {
    home_path()
        .map(|path| path_to_string(&path))
        .ok_or_else(|| anyhow::anyhow!("failed to resolve user home directory"))
}

pub fn root_directories() -> Vec<String> {
    #[cfg(windows)]
    {
        return ('A'..='Z')
            .map(|letter| format!("{letter}:\\"))
            .filter(|path| Path::new(path).is_dir())
            .collect();
    }

    #[cfg(not(windows))]
    {
        vec!["/".to_string()]
    }
}

pub fn open_path(path: &str) -> Result<()> {
    let home =
        home_path().ok_or_else(|| anyhow::anyhow!("failed to resolve user home directory"))?;
    let requested = if path.trim().is_empty() {
        home
    } else {
        expand_tilde(path, &home)
    };

    if !requested.exists() {
        bail!("local path does not exist: {}", path_to_string(&requested));
    }

    let target = if requested.is_absolute() {
        requested
    } else {
        std::env::current_dir()
            .context("failed to resolve current directory")?
            .join(requested)
    };
    open_platform_path(&target)
}

pub fn list_directory(path: &str) -> Result<LocalDirectoryResponse> {
    let home =
        home_path().ok_or_else(|| anyhow::anyhow!("failed to resolve user home directory"))?;
    let requested = if path.trim().is_empty() {
        home.clone()
    } else {
        expand_tilde(path, &home)
    };

    if !requested.is_dir() {
        bail!(
            "local path is not a directory: {}",
            path_to_string(&requested)
        );
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(&requested).with_context(|| {
        format!(
            "failed to read local directory {}",
            path_to_string(&requested)
        )
    })? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        let path = entry.path();
        entries.push(LocalFileEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: path_to_string(&path),
            is_dir: metadata.is_dir(),
            size: if metadata.is_file() {
                metadata.len()
            } else {
                0
            },
            modified: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs().to_string())
                .unwrap_or_default(),
        });
    }

    entries.sort_by(|left, right| {
        right
            .is_dir
            .cmp(&left.is_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    Ok(LocalDirectoryResponse {
        path: path_to_string(&requested),
        home: path_to_string(&home),
        entries,
    })
}

pub(crate) fn home_path() -> Option<PathBuf> {
    home_path_from_env(
        std::env::var_os("HOME"),
        std::env::var_os("USERPROFILE"),
        std::env::var_os("HOMEDRIVE"),
        std::env::var_os("HOMEPATH"),
    )
}

fn home_path_from_env(
    home: Option<OsString>,
    userprofile: Option<OsString>,
    homedrive: Option<OsString>,
    homepath: Option<OsString>,
) -> Option<PathBuf> {
    existing_home_path(home)
        .or_else(|| existing_home_path(userprofile))
        .or_else(|| home_from_drive_path(homedrive, homepath))
}

fn home_from_drive_path(
    homedrive: Option<OsString>,
    homepath: Option<OsString>,
) -> Option<PathBuf> {
    let mut drive = homedrive?;
    let path = homepath?;
    if drive.is_empty() || path.is_empty() {
        return None;
    }
    drive.push(path);
    existing_home_path(Some(drive))
}

fn existing_home_path(value: Option<OsString>) -> Option<PathBuf> {
    value
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
}

fn expand_tilde(path: &str, home: &Path) -> PathBuf {
    if path == "~" {
        home.to_path_buf()
    } else if let Some(rest) = tilde_path_rest(path) {
        home.join(rest)
    } else {
        PathBuf::from(path)
    }
}

fn tilde_path_rest(path: &str) -> Option<&str> {
    if let Some(rest) = path.strip_prefix("~/") {
        return Some(rest);
    }

    #[cfg(windows)]
    {
        if let Some(rest) = path.strip_prefix("~\\") {
            return Some(rest);
        }
    }

    None
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(windows)]
fn open_platform_path(path: &Path) -> Result<()> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut command = Command::new("explorer.exe");
    if path.is_file() {
        command.arg(format!("/select,{}", path_to_string(path)));
    } else {
        command.arg(path);
    }
    command
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .with_context(|| format!("failed to open local path {}", path_to_string(path)))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_platform_path(path: &Path) -> Result<()> {
    let mut command = Command::new("open");
    if path.is_file() {
        command.arg("-R").arg(path);
    } else {
        command.arg(path);
    }
    command
        .spawn()
        .with_context(|| format!("failed to open local path {}", path_to_string(path)))?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_platform_path(path: &Path) -> Result<()> {
    let target = if path.is_file() {
        path.parent().unwrap_or(path)
    } else {
        path
    };
    Command::new("xdg-open")
        .arg(target)
        .spawn()
        .with_context(|| format!("failed to open local path {}", path_to_string(target)))?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    fn temp_home() -> OsString {
        std::env::temp_dir().into_os_string()
    }

    #[test]
    fn home_path_from_env_uses_home_first() {
        let home = temp_home();

        assert_eq!(
            home_path_from_env(
                Some(home.clone()),
                Some(OsString::from("missing")),
                None,
                None
            ),
            Some(PathBuf::from(home))
        );
    }

    #[test]
    fn home_path_from_env_falls_back_to_userprofile() {
        let home = temp_home();

        assert_eq!(
            home_path_from_env(None, Some(home.clone()), None, None),
            Some(PathBuf::from(home))
        );
    }

    #[test]
    fn home_path_from_env_ignores_missing_home_before_userprofile() {
        let userprofile = temp_home();
        let missing_home = PathBuf::from(userprofile.clone()).join("ai-term-missing-home");

        assert_eq!(
            home_path_from_env(
                Some(missing_home.into_os_string()),
                Some(userprofile.clone()),
                None,
                None
            ),
            Some(PathBuf::from(userprofile))
        );
    }

    #[test]
    fn home_path_from_env_ignores_empty_values() {
        assert_eq!(
            home_path_from_env(Some(OsString::new()), Some(OsString::new()), None, None),
            None
        );
    }
    #[cfg(windows)]
    #[test]
    fn expand_tilde_accepts_windows_separator() {
        let home = PathBuf::from(r"C:\Users\ai-term");

        assert_eq!(expand_tilde(r"~\Desktop", &home), home.join("Desktop"));
    }
}
