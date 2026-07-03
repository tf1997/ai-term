use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
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

fn home_path() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn expand_tilde(path: &str, home: &Path) -> PathBuf {
    if path == "~" {
        home.to_path_buf()
    } else if let Some(rest) = path.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(path)
    }
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
