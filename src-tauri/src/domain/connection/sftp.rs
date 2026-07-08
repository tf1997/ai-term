use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::mpsc::RecvTimeoutError;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::models::{AuthEndpoint, AuthMode, ConnectionProfile, FileTransferMode, JumpMode};
use crate::domain::filesystem::local::home_path;
use crate::domain::pty::{
    append_limited_lossy, spawn_pty_process, spawn_reader_channel, write_to_pty, PtyCommand,
    PtySession,
};
use crate::domain::terminal::ssh::{
    app_known_hosts_ssh_args, connect_routed_endpoint, host_key_warning_hint,
    output_contains_host_key_warning, output_contains_password_prompt, RoutedSshSession,
};
use portable_pty::Child;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(600);
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const SFTP_CHILD_EXIT_GRACE: Duration = Duration::from_millis(500);
const SFTP_READY_GRACE: Duration = Duration::from_millis(1500);
const SFTP_OUTPUT_QUIET_GRACE: Duration = Duration::from_millis(120);
const SFTP_PTY_COLS: u16 = 240;
const SFTP_PTY_ROWS: u16 = 32;
const NATIVE_SFTP_POOL_TTL: Duration = Duration::from_secs(120);
const NATIVE_SFTP_POOL_MAX: usize = 8;

pub type SftpCancelToken = Arc<AtomicBool>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SftpFileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub permissions: String,
    pub modified: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SftpListResponse {
    pub path: String,
    pub entries: Vec<SftpFileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SftpTransferResponse {
    pub message: String,
    pub local_path: Option<String>,
    pub remote_path: Option<String>,
    pub target_path: Option<String>,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SftpProgressUpdate {
    pub percent: Option<u8>,
    pub text: String,
    pub transferred_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub bytes_per_second: Option<u64>,
    pub remaining_seconds: Option<u64>,
    pub eta_seconds: Option<u64>,
    pub estimated_completion_epoch_ms: Option<u64>,
    pub elapsed_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SftpProbeResponse {
    pub available: bool,
    pub path: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SftpLaunchPlan {
    pub program: String,
    pub args: Vec<String>,
    pub passwords: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SftpTargetOverride {
    pub host: Option<String>,
    pub username: Option<String>,
}

pub fn build_sftp_launch_plan(profile: &ConnectionProfile) -> SftpLaunchPlan {
    build_sftp_launch_plan_with_target(profile, &SftpTargetOverride::default())
}

pub fn build_sftp_launch_plan_with_target(
    profile: &ConnectionProfile,
    target_override: &SftpTargetOverride,
) -> SftpLaunchPlan {
    build_sftp_launch_plan_with_initial_path(profile, target_override, None)
}

fn build_sftp_launch_plan_with_initial_path(
    profile: &ConnectionProfile,
    target_override: &SftpTargetOverride,
    initial_remote_path: Option<&str>,
) -> SftpLaunchPlan {
    build_sftp_launch_plan_for_route(
        effective_sftp_route(profile, target_override),
        initial_remote_path,
    )
}

fn build_sftp_fallback_launch_plan_with_initial_path(
    profile: &ConnectionProfile,
    target_override: &SftpTargetOverride,
    initial_remote_path: Option<&str>,
) -> Option<SftpLaunchPlan> {
    Some(build_sftp_launch_plan_for_route(
        composite_username_fallback_route(profile, target_override)?,
        initial_remote_path,
    ))
}

fn build_sftp_launch_plan_for_route(
    route: SftpRoute,
    initial_remote_path: Option<&str>,
) -> SftpLaunchPlan {
    let mut args = vec!["-o".into(), "BatchMode=no".into()];
    args.extend(app_known_hosts_ssh_args());
    args.extend(["-o".into(), "NumberOfPasswordPrompts=2".into()]);

    if let Some(proxy) = route.proxy.as_ref() {
        args.push("-o".into());
        args.push(format!("ProxyJump={}", proxy_jump_destination(proxy)));
    }

    args.push("-P".into());
    args.push(route.target.port.unwrap_or(22).to_string());
    args.push(sftp_destination(&route.target, initial_remote_path));

    SftpLaunchPlan {
        program: "sftp".into(),
        args,
        passwords: plaintext_passwords(&route),
    }
}

pub fn list_directory(
    profile: &ConnectionProfile,
    path: &str,
    target_override: &SftpTargetOverride,
) -> Result<SftpListResponse> {
    list_directory_with_cancel(profile, path, target_override, None)
}

pub fn list_directory_with_cancel(
    profile: &ConnectionProfile,
    path: &str,
    target_override: &SftpTargetOverride,
    cancel_token: Option<&SftpCancelToken>,
) -> Result<SftpListResponse> {
    let remote_path = normalize_remote_path(path);
    let native_list_error =
        match try_native_list_directory(profile, &remote_path, target_override, cancel_token) {
            Some(Ok(response)) => return Ok(response),
            Some(Err(error)) if !should_fallback_native_sftp_error(&error) => return Err(error),
            Some(Err(error)) => Some(error),
            None => None,
        };

    let (output, parsed_path) = match run_sftp_commands(
        profile,
        target_override,
        list_directory_commands(&remote_path)?,
        cancel_token,
    ) {
        Ok(output) => (output, remote_path.clone()),
        Err(error) if should_retry_sftp_root_listing(&error) => {
            let fallback_path = "/".to_string();
            let output = run_sftp_commands_with_initial_path(
                profile,
                target_override,
                list_directory_without_cwd_commands(&fallback_path)?,
                cancel_token,
                &fallback_path,
            )?;
            (output, fallback_path)
        }
        Err(error) => return Err(error),
    };

    let parsed = parse_list_output(&output, &parsed_path)?;
    if !parsed.entries.is_empty() || is_cancelled(cancel_token) {
        return Ok(parsed);
    }

    let fallback_output = run_sftp_commands(
        profile,
        target_override,
        list_directory_without_cwd_commands(&parsed_path)?,
        cancel_token,
    )?;
    let fallback = parse_list_output(&fallback_output, &parsed_path)?;
    if fallback.entries.is_empty() {
        if let Some(error) = native_list_error {
            bail!(
                "原生 SFTP 读取失败，系统 sftp 也没有返回文件项。\n{}",
                clean_sftp_output(&error.to_string())
            );
        }
        Ok(parsed)
    } else {
        Ok(fallback)
    }
}

pub fn probe_sftp(
    profile: &ConnectionProfile,
    target_override: &SftpTargetOverride,
) -> SftpProbeResponse {
    probe_sftp_with_cancel(profile, target_override, None)
}

pub fn probe_sftp_with_cancel(
    profile: &ConnectionProfile,
    target_override: &SftpTargetOverride,
    cancel_token: Option<&SftpCancelToken>,
) -> SftpProbeResponse {
    match run_sftp_profile_commands_with_progress(
        profile,
        target_override,
        vec!["pwd".into(), "bye".into()],
        PROBE_TIMEOUT,
        cancel_token,
        None,
    ) {
        Ok(output) => {
            let path = parse_remote_working_directory(&output).unwrap_or_else(|| ".".into());
            SftpProbeResponse {
                available: true,
                path: Some(path.clone()),
                message: format!("SFTP 可用，远程目录 {path}"),
            }
        }
        Err(error) if should_retry_sftp_root_listing(&error) => {
            match run_sftp_profile_commands_with_initial_path(
                profile,
                target_override,
                list_directory_without_cwd_commands("/").unwrap_or_else(|_| vec!["bye".into()]),
                PROBE_TIMEOUT,
                cancel_token,
                None,
                "/",
            ) {
                Ok(_) => SftpProbeResponse {
                    available: true,
                    path: Some("/".into()),
                    message: "SFTP 可用，远程目录 /".into(),
                },
                Err(error) => SftpProbeResponse {
                    available: false,
                    path: None,
                    message: summarize_sftp_error(&error.to_string()),
                },
            }
        }
        Err(error) => SftpProbeResponse {
            available: false,
            path: None,
            message: summarize_sftp_error(&error.to_string()),
        },
    }
}

pub fn create_directory(
    profile: &ConnectionProfile,
    path: &str,
    target_override: &SftpTargetOverride,
) -> Result<SftpTransferResponse> {
    create_directory_with_cancel(profile, path, target_override, None)
}

pub fn create_directory_with_cancel(
    profile: &ConnectionProfile,
    path: &str,
    target_override: &SftpTargetOverride,
    cancel_token: Option<&SftpCancelToken>,
) -> Result<SftpTransferResponse> {
    let remote_path = normalize_remote_path(path);
    if let Some(response) = native_result_or_fallback(try_native_create_directory(
        profile,
        &remote_path,
        target_override,
        cancel_token,
    ))? {
        return Ok(response);
    }
    run_sftp_commands(
        profile,
        target_override,
        vec![
            format!("mkdir {}", quote_sftp_path(&remote_path)?),
            "bye".into(),
        ],
        cancel_token,
    )?;
    Ok(transfer_response(
        format!("created {remote_path}"),
        None,
        Some(remote_path.clone()),
        Some(remote_path),
        true,
    ))
}

pub fn delete_path(
    profile: &ConnectionProfile,
    path: &str,
    is_dir: bool,
    target_override: &SftpTargetOverride,
) -> Result<SftpTransferResponse> {
    delete_path_with_cancel(profile, path, is_dir, target_override, None)
}

pub fn delete_path_with_cancel(
    profile: &ConnectionProfile,
    path: &str,
    is_dir: bool,
    target_override: &SftpTargetOverride,
    cancel_token: Option<&SftpCancelToken>,
) -> Result<SftpTransferResponse> {
    let remote_path = normalize_remote_path(path);
    if let Some(response) = native_result_or_fallback(try_native_delete_path(
        profile,
        &remote_path,
        is_dir,
        target_override,
        cancel_token,
    ))? {
        return Ok(response);
    }
    let command = if is_dir { "rmdir" } else { "rm" };
    run_sftp_commands(
        profile,
        target_override,
        vec![
            format!("{command} {}", quote_sftp_path(&remote_path)?),
            "bye".into(),
        ],
        cancel_token,
    )?;
    Ok(transfer_response(
        format!("deleted {remote_path}"),
        None,
        Some(remote_path.clone()),
        Some(remote_path),
        is_dir,
    ))
}

pub fn upload_file(
    profile: &ConnectionProfile,
    local_path: &str,
    remote_dir: &str,
    target_override: &SftpTargetOverride,
) -> Result<SftpTransferResponse> {
    upload_file_with_cancel(profile, local_path, remote_dir, target_override, None)
}

pub fn upload_file_with_cancel(
    profile: &ConnectionProfile,
    local_path: &str,
    remote_dir: &str,
    target_override: &SftpTargetOverride,
    cancel_token: Option<&SftpCancelToken>,
) -> Result<SftpTransferResponse> {
    upload_file_with_progress(
        profile,
        local_path,
        remote_dir,
        target_override,
        cancel_token,
        None,
    )
}

pub fn upload_file_with_progress(
    profile: &ConnectionProfile,
    local_path: &str,
    remote_dir: &str,
    target_override: &SftpTargetOverride,
    cancel_token: Option<&SftpCancelToken>,
    mut progress: Option<&mut dyn FnMut(SftpProgressUpdate)>,
) -> Result<SftpTransferResponse> {
    let local_path = expand_tilde(local_path);
    if !Path::new(&local_path).is_file() {
        bail!("local file does not exist: {local_path}");
    }
    let remote_dir = normalize_remote_path(remote_dir);
    let remote_path = upload_target_path(&remote_dir, &local_path);
    if let Some(response) = native_result_or_fallback(try_native_upload_file(
        profile,
        &local_path,
        &remote_dir,
        &remote_path,
        target_override,
        cancel_token,
        &mut progress,
    ))? {
        return Ok(response);
    }
    run_sftp_profile_commands_with_progress(
        profile,
        target_override,
        vec![
            format!("cd {}", quote_sftp_path(&remote_dir)?),
            format!("put {}", quote_sftp_path(&local_path)?),
            "bye".into(),
        ],
        TRANSFER_TIMEOUT,
        cancel_token,
        progress,
    )?;
    Ok(transfer_response(
        format!("uploaded {local_path} to {remote_path}"),
        Some(local_path),
        Some(remote_path.clone()),
        Some(remote_path),
        false,
    ))
}

pub fn upload_path(
    profile: &ConnectionProfile,
    local_path: &str,
    remote_dir: &str,
    target_override: &SftpTargetOverride,
) -> Result<SftpTransferResponse> {
    upload_path_with_cancel(profile, local_path, remote_dir, target_override, None)
}

pub fn upload_path_with_cancel(
    profile: &ConnectionProfile,
    local_path: &str,
    remote_dir: &str,
    target_override: &SftpTargetOverride,
    cancel_token: Option<&SftpCancelToken>,
) -> Result<SftpTransferResponse> {
    upload_path_with_progress(
        profile,
        local_path,
        remote_dir,
        target_override,
        cancel_token,
        None,
    )
}

pub fn upload_path_with_progress(
    profile: &ConnectionProfile,
    local_path: &str,
    remote_dir: &str,
    target_override: &SftpTargetOverride,
    cancel_token: Option<&SftpCancelToken>,
    mut progress: Option<&mut dyn FnMut(SftpProgressUpdate)>,
) -> Result<SftpTransferResponse> {
    let local_path = expand_tilde(local_path);
    let local = Path::new(&local_path);
    if !local.exists() {
        bail!("local path does not exist: {local_path}");
    }

    let is_dir = local.is_dir();
    let remote_dir = normalize_remote_path(remote_dir);
    let remote_path = upload_target_path(&remote_dir, &local_path);
    if let Some(response) = native_result_or_fallback(try_native_upload_path(
        profile,
        &local_path,
        &remote_dir,
        &remote_path,
        is_dir,
        target_override,
        cancel_token,
        &mut progress,
    ))? {
        return Ok(response);
    }
    let put_command = if is_dir {
        format!("put -r {}", quote_sftp_path(&local_path)?)
    } else {
        format!("put {}", quote_sftp_path(&local_path)?)
    };
    run_sftp_profile_commands_with_progress(
        profile,
        target_override,
        vec![
            format!("cd {}", quote_sftp_path(&remote_dir)?),
            put_command,
            "bye".into(),
        ],
        TRANSFER_TIMEOUT,
        cancel_token,
        progress,
    )?;

    Ok(transfer_response(
        format!("uploaded {local_path} to {remote_path}"),
        Some(local_path),
        Some(remote_path.clone()),
        Some(remote_path),
        is_dir,
    ))
}

pub fn download_file(
    profile: &ConnectionProfile,
    remote_path: &str,
    local_path: &str,
    target_override: &SftpTargetOverride,
) -> Result<SftpTransferResponse> {
    download_file_with_cancel(profile, remote_path, local_path, target_override, None)
}

pub fn download_file_with_cancel(
    profile: &ConnectionProfile,
    remote_path: &str,
    local_path: &str,
    target_override: &SftpTargetOverride,
    cancel_token: Option<&SftpCancelToken>,
) -> Result<SftpTransferResponse> {
    download_file_with_progress(
        profile,
        remote_path,
        local_path,
        target_override,
        cancel_token,
        None,
    )
}

pub fn download_file_with_progress(
    profile: &ConnectionProfile,
    remote_path: &str,
    local_path: &str,
    target_override: &SftpTargetOverride,
    cancel_token: Option<&SftpCancelToken>,
    mut progress: Option<&mut dyn FnMut(SftpProgressUpdate)>,
) -> Result<SftpTransferResponse> {
    let remote_path = normalize_remote_path(remote_path);
    let local_path = expand_tilde(local_path);
    if let Some(response) = native_result_or_fallback(try_native_download_file(
        profile,
        &remote_path,
        &local_path,
        target_override,
        cancel_token,
        &mut progress,
    ))? {
        return Ok(response);
    }
    run_sftp_profile_commands_with_progress(
        profile,
        target_override,
        vec![
            format!(
                "get {} {}",
                quote_sftp_path(&remote_path)?,
                quote_sftp_path(&local_path)?
            ),
            "bye".into(),
        ],
        TRANSFER_TIMEOUT,
        cancel_token,
        progress,
    )?;
    Ok(transfer_response(
        format!("downloaded {remote_path} to {local_path}"),
        Some(local_path.clone()),
        Some(remote_path),
        Some(local_path),
        false,
    ))
}

pub fn download_path(
    profile: &ConnectionProfile,
    remote_path: &str,
    local_dir: &str,
    is_dir: bool,
    target_override: &SftpTargetOverride,
) -> Result<SftpTransferResponse> {
    download_path_with_cancel(
        profile,
        remote_path,
        local_dir,
        is_dir,
        target_override,
        None,
    )
}

pub fn download_path_with_cancel(
    profile: &ConnectionProfile,
    remote_path: &str,
    local_dir: &str,
    is_dir: bool,
    target_override: &SftpTargetOverride,
    cancel_token: Option<&SftpCancelToken>,
) -> Result<SftpTransferResponse> {
    download_path_with_progress(
        profile,
        remote_path,
        local_dir,
        is_dir,
        target_override,
        cancel_token,
        None,
    )
}

pub fn download_path_with_progress(
    profile: &ConnectionProfile,
    remote_path: &str,
    local_dir: &str,
    is_dir: bool,
    target_override: &SftpTargetOverride,
    cancel_token: Option<&SftpCancelToken>,
    mut progress: Option<&mut dyn FnMut(SftpProgressUpdate)>,
) -> Result<SftpTransferResponse> {
    let remote_path = normalize_remote_path(remote_path);
    let local_dir = expand_tilde(local_dir);
    let local = Path::new(&local_dir);
    fs::create_dir_all(local)
        .with_context(|| format!("failed to create local directory: {local_dir}"))?;
    if !local.is_dir() {
        bail!("local path is not a directory: {local_dir}");
    }

    let target_path = download_target_path(&local_dir, &remote_path);
    if let Some(response) = native_result_or_fallback(try_native_download_path(
        profile,
        &remote_path,
        &local_dir,
        &target_path,
        is_dir,
        target_override,
        cancel_token,
        &mut progress,
    ))? {
        return Ok(response);
    }
    let get_command = if is_dir {
        format!("get -r {}", quote_sftp_path(&remote_path)?)
    } else {
        format!("get {}", quote_sftp_path(&remote_path)?)
    };
    run_sftp_profile_commands_with_progress(
        profile,
        target_override,
        vec![
            format!("lcd {}", quote_sftp_path(&local_dir)?),
            get_command,
            "bye".into(),
        ],
        TRANSFER_TIMEOUT,
        cancel_token,
        progress,
    )?;

    Ok(transfer_response(
        format!("downloaded {remote_path} to {target_path}"),
        Some(target_path.clone()),
        Some(remote_path),
        Some(target_path),
        is_dir,
    ))
}

fn list_directory_commands(remote_path: &str) -> Result<Vec<String>> {
    Ok(vec![
        format!("cd {}", quote_sftp_path(remote_path)?),
        "pwd".into(),
        "ls -l".into(),
        "bye".into(),
    ])
}

fn list_directory_without_cwd_commands(remote_path: &str) -> Result<Vec<String>> {
    Ok(vec![
        format!("ls -l {}", quote_sftp_path(remote_path)?),
        "bye".into(),
    ])
}

fn try_native_list_directory(
    profile: &ConnectionProfile,
    remote_path: &str,
    target_override: &SftpTargetOverride,
    cancel_token: Option<&SftpCancelToken>,
) -> Option<Result<SftpListResponse>> {
    run_cached_native_sftp_routes(
        profile,
        target_override,
        cancel_token,
        |connection, _route| list_directory_native(connection, remote_path),
    )
}

fn try_native_create_directory(
    profile: &ConnectionProfile,
    remote_path: &str,
    target_override: &SftpTargetOverride,
    cancel_token: Option<&SftpCancelToken>,
) -> Option<Result<SftpTransferResponse>> {
    run_native_sftp_routes(
        profile,
        target_override,
        cancel_token,
        |connection, _route| {
            connection
                .sftp
                .mkdir(Path::new(remote_path), 0o755)
                .with_context(|| format!("failed to create native SFTP directory {remote_path}"))?;
            Ok(transfer_response(
                format!("created {remote_path}"),
                None,
                Some(remote_path.to_string()),
                Some(remote_path.to_string()),
                true,
            ))
        },
    )
}

fn try_native_delete_path(
    profile: &ConnectionProfile,
    remote_path: &str,
    is_dir: bool,
    target_override: &SftpTargetOverride,
    cancel_token: Option<&SftpCancelToken>,
) -> Option<Result<SftpTransferResponse>> {
    run_native_sftp_routes(
        profile,
        target_override,
        cancel_token,
        |connection, _route| {
            let path = Path::new(remote_path);
            if is_dir {
                connection.sftp.rmdir(path).with_context(|| {
                    format!("failed to remove native SFTP directory {remote_path}")
                })?;
            } else {
                connection
                    .sftp
                    .unlink(path)
                    .with_context(|| format!("failed to delete native SFTP file {remote_path}"))?;
            }
            Ok(transfer_response(
                format!("deleted {remote_path}"),
                None,
                Some(remote_path.to_string()),
                Some(remote_path.to_string()),
                is_dir,
            ))
        },
    )
}

fn try_native_upload_file(
    profile: &ConnectionProfile,
    local_path: &str,
    remote_dir: &str,
    remote_path: &str,
    target_override: &SftpTargetOverride,
    cancel_token: Option<&SftpCancelToken>,
    progress: &mut Option<&mut dyn FnMut(SftpProgressUpdate)>,
) -> Option<Result<SftpTransferResponse>> {
    run_native_sftp_routes(
        profile,
        target_override,
        cancel_token,
        |connection, _route| {
            let total = fs::metadata(local_path)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            let mut transferred = 0;
            let started = Instant::now();
            let local = Path::new(local_path);
            native_ensure_dir(&connection.sftp, remote_dir)?;
            upload_file_native_to(
                &connection.sftp,
                local,
                remote_path,
                cancel_token,
                progress,
                total,
                &mut transferred,
                &started,
            )?;
            emit_native_transfer_done(progress, total, transferred, &started);
            Ok(transfer_response(
                format!("uploaded {local_path} to {remote_path}"),
                Some(local_path.to_string()),
                Some(remote_path.to_string()),
                Some(remote_path.to_string()),
                false,
            ))
        },
    )
}

fn try_native_upload_path(
    profile: &ConnectionProfile,
    local_path: &str,
    remote_dir: &str,
    remote_path: &str,
    is_dir: bool,
    target_override: &SftpTargetOverride,
    cancel_token: Option<&SftpCancelToken>,
    progress: &mut Option<&mut dyn FnMut(SftpProgressUpdate)>,
) -> Option<Result<SftpTransferResponse>> {
    run_native_sftp_routes(
        profile,
        target_override,
        cancel_token,
        |connection, _route| {
            native_ensure_dir(&connection.sftp, remote_dir)?;
            let total = local_transfer_size(Path::new(local_path))?;
            let mut transferred = 0;
            let started = Instant::now();
            upload_path_native_to(
                &connection.sftp,
                Path::new(local_path),
                remote_path,
                cancel_token,
                progress,
                total,
                &mut transferred,
                &started,
            )?;
            emit_native_transfer_done(progress, total, transferred, &started);
            Ok(transfer_response(
                format!("uploaded {local_path} to {remote_path}"),
                Some(local_path.to_string()),
                Some(remote_path.to_string()),
                Some(remote_path.to_string()),
                is_dir,
            ))
        },
    )
}

fn try_native_download_file(
    profile: &ConnectionProfile,
    remote_path: &str,
    local_path: &str,
    target_override: &SftpTargetOverride,
    cancel_token: Option<&SftpCancelToken>,
    progress: &mut Option<&mut dyn FnMut(SftpProgressUpdate)>,
) -> Option<Result<SftpTransferResponse>> {
    run_native_sftp_routes(
        profile,
        target_override,
        cancel_token,
        |connection, _route| {
            let stat = connection
                .sftp
                .stat(Path::new(remote_path))
                .with_context(|| format!("failed to stat native SFTP file {remote_path}"))?;
            let total = stat.size.unwrap_or(0);
            let mut transferred = 0;
            let started = Instant::now();
            download_file_native_to(
                &connection.sftp,
                remote_path,
                Path::new(local_path),
                cancel_token,
                progress,
                total,
                &mut transferred,
                &started,
            )?;
            emit_native_transfer_done(progress, total, transferred, &started);
            Ok(transfer_response(
                format!("downloaded {remote_path} to {local_path}"),
                Some(local_path.to_string()),
                Some(remote_path.to_string()),
                Some(local_path.to_string()),
                false,
            ))
        },
    )
}

fn try_native_download_path(
    profile: &ConnectionProfile,
    remote_path: &str,
    local_dir: &str,
    target_path: &str,
    is_dir: bool,
    target_override: &SftpTargetOverride,
    cancel_token: Option<&SftpCancelToken>,
    progress: &mut Option<&mut dyn FnMut(SftpProgressUpdate)>,
) -> Option<Result<SftpTransferResponse>> {
    run_native_sftp_routes(
        profile,
        target_override,
        cancel_token,
        |connection, _route| {
            let total = remote_transfer_size(&connection.sftp, remote_path, is_dir)?;
            let mut transferred = 0;
            let started = Instant::now();
            if is_dir {
                download_dir_native_to(
                    &connection.sftp,
                    remote_path,
                    Path::new(target_path),
                    cancel_token,
                    progress,
                    total,
                    &mut transferred,
                    &started,
                )?;
            } else {
                fs::create_dir_all(local_dir)
                    .with_context(|| format!("failed to create local directory: {local_dir}"))?;
                download_file_native_to(
                    &connection.sftp,
                    remote_path,
                    Path::new(target_path),
                    cancel_token,
                    progress,
                    total,
                    &mut transferred,
                    &started,
                )?;
            }
            emit_native_transfer_done(progress, total, transferred, &started);
            Ok(transfer_response(
                format!("downloaded {remote_path} to {target_path}"),
                Some(target_path.to_string()),
                Some(remote_path.to_string()),
                Some(target_path.to_string()),
                is_dir,
            ))
        },
    )
}

fn native_result_or_fallback<T>(result: Option<Result<T>>) -> Result<Option<T>> {
    match result {
        Some(Ok(value)) => Ok(Some(value)),
        Some(Err(error)) if !should_fallback_native_sftp_error(&error) => Err(error),
        Some(Err(_)) | None => Ok(None),
    }
}

fn should_fallback_native_sftp_error(error: &anyhow::Error) -> bool {
    let message = format!("{error:#}").to_ascii_lowercase();
    !message.contains("host key")
        && !message.contains("known_hosts")
        && !message.contains("authentication")
        && !message.contains("permission denied")
        && !message.contains("no such file")
        && !message.contains("not a directory")
        && !message.contains("sftp task cancelled")
}

fn should_try_next_native_sftp_route(error: &anyhow::Error) -> bool {
    let message = format!("{error:#}").to_ascii_lowercase();
    !message.contains("host key")
        && !message.contains("known_hosts")
        && !message.contains("permission denied")
        && !message.contains("no such file")
        && !message.contains("not a directory")
        && !message.contains("sftp task cancelled")
}

struct NativeSftpConnection {
    sftp: ssh2::Sftp,
    _ssh: RoutedSshSession,
}

struct NativeSftpPoolEntry {
    connection: NativeSftpConnection,
    last_used: Instant,
}

static NATIVE_SFTP_POOL: OnceLock<Mutex<HashMap<String, NativeSftpPoolEntry>>> = OnceLock::new();

fn native_sftp_pool() -> &'static Mutex<HashMap<String, NativeSftpPoolEntry>> {
    NATIVE_SFTP_POOL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn run_cached_native_sftp_routes<T>(
    profile: &ConnectionProfile,
    target_override: &SftpTargetOverride,
    cancel_token: Option<&SftpCancelToken>,
    mut action: impl FnMut(&NativeSftpConnection, &SftpRoute) -> Result<T>,
) -> Option<Result<T>> {
    let routes = native_sftp_routes(profile, target_override);
    if routes.is_empty() {
        return None;
    }

    let mut errors = Vec::new();
    for route in routes {
        if let Err(error) = ensure_not_cancelled(cancel_token) {
            return Some(Err(error));
        }
        let cache_key = native_sftp_cache_key(profile, &route);
        let result = run_cached_native_sftp_route(&route, &cache_key, |connection| {
            action(connection, &route)
        });
        match result {
            Ok(value) => return Some(Ok(value)),
            Err(error) => {
                if !should_try_next_native_sftp_route(&error) {
                    return Some(Err(error));
                }
                errors.push(format!(
                    "{}: {}",
                    route_label(&route),
                    clean_sftp_output(&error.to_string())
                ));
            }
        }
    }

    Some(Err(anyhow::anyhow!(
        "原生 SFTP 路线全部失败\n{}",
        errors.join("\n\n")
    )))
}

fn run_cached_native_sftp_route<T>(
    route: &SftpRoute,
    cache_key: &str,
    mut action: impl FnMut(&NativeSftpConnection) -> Result<T>,
) -> Result<T> {
    if let Some(connection) = take_cached_native_sftp_connection(cache_key) {
        match action(&connection) {
            Ok(value) => {
                store_cached_native_sftp_connection(cache_key.to_string(), connection);
                return Ok(value);
            }
            Err(_) => {
                // Drop the stale cached session and retry the readonly listing once.
            }
        }
    }

    let connection = connect_native_sftp_route(route)?;
    match action(&connection) {
        Ok(value) => {
            store_cached_native_sftp_connection(cache_key.to_string(), connection);
            Ok(value)
        }
        Err(error) => Err(error),
    }
}

fn take_cached_native_sftp_connection(cache_key: &str) -> Option<NativeSftpConnection> {
    let mut pool = native_sftp_pool().lock().ok()?;
    prune_native_sftp_pool(&mut pool);
    pool.remove(cache_key).map(|entry| entry.connection)
}

fn store_cached_native_sftp_connection(cache_key: String, connection: NativeSftpConnection) {
    let Ok(mut pool) = native_sftp_pool().lock() else {
        return;
    };
    prune_native_sftp_pool(&mut pool);
    pool.insert(
        cache_key,
        NativeSftpPoolEntry {
            connection,
            last_used: Instant::now(),
        },
    );
    prune_native_sftp_pool(&mut pool);
}

fn prune_native_sftp_pool(pool: &mut HashMap<String, NativeSftpPoolEntry>) {
    let now = Instant::now();
    pool.retain(|_, entry| now.duration_since(entry.last_used) < NATIVE_SFTP_POOL_TTL);
    while pool.len() > NATIVE_SFTP_POOL_MAX {
        let Some(oldest_key) = pool
            .iter()
            .min_by_key(|(_, entry)| entry.last_used)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        pool.remove(&oldest_key);
    }
}

fn native_sftp_cache_key(profile: &ConnectionProfile, route: &SftpRoute) -> String {
    let proxy = route
        .proxy
        .as_ref()
        .map(native_endpoint_cache_key)
        .unwrap_or_else(|| "direct".into());
    format!(
        "{}|target:{}|proxy:{}",
        profile.id,
        native_endpoint_cache_key(&route.target),
        proxy
    )
}

fn native_endpoint_cache_key(endpoint: &AuthEndpoint) -> String {
    format!(
        "{}:{}:{}:{:?}:{}",
        endpoint.host.trim().to_ascii_lowercase(),
        endpoint.port.unwrap_or(22),
        endpoint.username.trim(),
        endpoint.auth_mode,
        endpoint.credential_ref.as_deref().unwrap_or_default()
    )
}
fn run_native_sftp_routes<T>(
    profile: &ConnectionProfile,
    target_override: &SftpTargetOverride,
    cancel_token: Option<&SftpCancelToken>,
    mut action: impl FnMut(&NativeSftpConnection, &SftpRoute) -> Result<T>,
) -> Option<Result<T>> {
    let routes = native_sftp_routes(profile, target_override);
    if routes.is_empty() {
        return None;
    }

    let mut errors = Vec::new();
    for route in routes {
        if let Err(error) = ensure_not_cancelled(cancel_token) {
            return Some(Err(error));
        }
        let result =
            connect_native_sftp_route(&route).and_then(|connection| action(&connection, &route));
        match result {
            Ok(value) => return Some(Ok(value)),
            Err(error) => {
                if !should_try_next_native_sftp_route(&error) {
                    return Some(Err(error));
                }
                errors.push(format!(
                    "{}: {}",
                    route_label(&route),
                    clean_sftp_output(&error.to_string())
                ));
            }
        }
    }

    Some(Err(anyhow::anyhow!(
        "原生 SFTP 路线全部失败\n{}",
        errors.join("\n\n")
    )))
}

fn native_sftp_routes(
    profile: &ConnectionProfile,
    target_override: &SftpTargetOverride,
) -> Vec<SftpRoute> {
    if !matches!(
        profile.file_transfer_mode,
        FileTransferMode::Auto | FileTransferMode::SftpDirect | FileTransferMode::SftpGateway
    ) {
        return Vec::new();
    }

    let mut routes = vec![effective_sftp_route(profile, target_override)];
    if let Some(fallback) = composite_username_fallback_route(profile, target_override) {
        if !routes.contains(&fallback) {
            routes.push(fallback);
        }
    }
    routes
}

fn connect_native_sftp_route(route: &SftpRoute) -> Result<NativeSftpConnection> {
    let ssh = connect_routed_endpoint(&route.target, route.proxy.as_ref())
        .with_context(|| format!("failed to connect native SFTP route {}", route_label(route)))?;
    let sftp = ssh
        .session()
        .sftp()
        .context("failed to open native SFTP subsystem")?;
    Ok(NativeSftpConnection { sftp, _ssh: ssh })
}

fn route_label(route: &SftpRoute) -> String {
    match route.proxy.as_ref() {
        Some(proxy) => format!(
            "{} via {}",
            endpoint_destination(&route.target),
            proxy_jump_destination(proxy)
        ),
        None => endpoint_destination(&route.target),
    }
}

fn list_directory_native(
    connection: &NativeSftpConnection,
    remote_path: &str,
) -> Result<SftpListResponse> {
    let requested = normalize_remote_path(remote_path);
    let request_path = Path::new(&requested);
    let path = connection
        .sftp
        .realpath(request_path)
        .ok()
        .map(|path| remote_path_to_string(&path))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| requested.clone());

    let mut entries = Vec::new();
    for (entry_path, stat) in connection
        .sftp
        .readdir(request_path)
        .with_context(|| format!("failed to read native SFTP directory {requested}"))?
    {
        let name = native_entry_name(&entry_path);
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        entries.push(SftpFileEntry {
            path: native_entry_path(&path, &entry_path, &name),
            is_dir: native_file_is_dir(&stat),
            name,
            size: stat.size.unwrap_or(0),
            permissions: native_permissions(&stat),
            modified: stat
                .mtime
                .map(|value| value.to_string())
                .unwrap_or_default(),
        });
    }

    Ok(SftpListResponse { path, entries })
}

fn remote_path_to_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn native_entry_name(path: &Path) -> String {
    let value = remote_path_to_string(path);
    value
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_string()
}

fn native_entry_path(base: &str, entry_path: &Path, name: &str) -> String {
    let value = remote_path_to_string(entry_path);
    if value.starts_with('/') || value.as_bytes().get(1) == Some(&b':') {
        value
    } else {
        join_remote_path(base, name)
    }
}

fn native_file_is_dir(stat: &ssh2::FileStat) -> bool {
    stat.perm.is_some_and(|mode| (mode & 0o170000) == 0o040000)
}

fn native_permissions(stat: &ssh2::FileStat) -> String {
    stat.perm.map(format_unix_mode).unwrap_or_default()
}

fn format_unix_mode(mode: u32) -> String {
    let mut value = String::with_capacity(10);
    value.push(match mode & 0o170000 {
        0o040000 => 'd',
        0o120000 => 'l',
        _ => '-',
    });
    for (read, write, exec) in [
        (0o400, 0o200, 0o100),
        (0o040, 0o020, 0o010),
        (0o004, 0o002, 0o001),
    ] {
        value.push(if mode & read != 0 { 'r' } else { '-' });
        value.push(if mode & write != 0 { 'w' } else { '-' });
        value.push(if mode & exec != 0 { 'x' } else { '-' });
    }
    value
}
fn upload_path_native_to(
    sftp: &ssh2::Sftp,
    local_path: &Path,
    remote_path: &str,
    cancel_token: Option<&SftpCancelToken>,
    progress: &mut Option<&mut dyn FnMut(SftpProgressUpdate)>,
    total: u64,
    transferred: &mut u64,
    started: &Instant,
) -> Result<()> {
    ensure_not_cancelled(cancel_token)?;
    if local_path.is_dir() {
        native_ensure_dir(sftp, remote_path)?;
        for entry in fs::read_dir(local_path)
            .with_context(|| format!("failed to read local directory {}", local_path.display()))?
        {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let child_remote = join_remote_path(remote_path, &name);
            upload_path_native_to(
                sftp,
                &entry.path(),
                &child_remote,
                cancel_token,
                progress,
                total,
                transferred,
                started,
            )?;
        }
        return Ok(());
    }

    upload_file_native_to(
        sftp,
        local_path,
        remote_path,
        cancel_token,
        progress,
        total,
        transferred,
        started,
    )
}

fn upload_file_native_to(
    sftp: &ssh2::Sftp,
    local_path: &Path,
    remote_path: &str,
    cancel_token: Option<&SftpCancelToken>,
    progress: &mut Option<&mut dyn FnMut(SftpProgressUpdate)>,
    total: u64,
    transferred: &mut u64,
    started: &Instant,
) -> Result<()> {
    ensure_not_cancelled(cancel_token)?;
    let mut local = File::open(local_path)
        .with_context(|| format!("failed to open local file {}", local_path.display()))?;
    let mut remote = sftp
        .open_mode(
            Path::new(remote_path),
            ssh2::OpenFlags::WRITE | ssh2::OpenFlags::CREATE | ssh2::OpenFlags::TRUNCATE,
            0o644,
            ssh2::OpenType::File,
        )
        .with_context(|| format!("failed to open native SFTP file for write {remote_path}"))?;
    copy_with_native_progress(
        &mut local,
        &mut remote,
        cancel_token,
        progress,
        total,
        transferred,
        started,
    )
}

fn download_dir_native_to(
    sftp: &ssh2::Sftp,
    remote_path: &str,
    local_path: &Path,
    cancel_token: Option<&SftpCancelToken>,
    progress: &mut Option<&mut dyn FnMut(SftpProgressUpdate)>,
    total: u64,
    transferred: &mut u64,
    started: &Instant,
) -> Result<()> {
    ensure_not_cancelled(cancel_token)?;
    fs::create_dir_all(local_path)
        .with_context(|| format!("failed to create local directory {}", local_path.display()))?;
    for (entry_path, stat) in sftp
        .readdir(Path::new(remote_path))
        .with_context(|| format!("failed to read native SFTP directory {remote_path}"))?
    {
        let name = native_entry_name(&entry_path);
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        let child_remote = native_entry_path(remote_path, &entry_path, &name);
        let child_local = local_path.join(&name);
        if native_file_is_dir(&stat) {
            download_dir_native_to(
                sftp,
                &child_remote,
                &child_local,
                cancel_token,
                progress,
                total,
                transferred,
                started,
            )?;
        } else {
            download_file_native_to(
                sftp,
                &child_remote,
                &child_local,
                cancel_token,
                progress,
                total,
                transferred,
                started,
            )?;
        }
    }
    Ok(())
}

fn download_file_native_to(
    sftp: &ssh2::Sftp,
    remote_path: &str,
    local_path: &Path,
    cancel_token: Option<&SftpCancelToken>,
    progress: &mut Option<&mut dyn FnMut(SftpProgressUpdate)>,
    total: u64,
    transferred: &mut u64,
    started: &Instant,
) -> Result<()> {
    ensure_not_cancelled(cancel_token)?;
    if let Some(parent) = local_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create local directory {}", parent.display()))?;
    }
    let mut remote = sftp
        .open(Path::new(remote_path))
        .with_context(|| format!("failed to open native SFTP file for read {remote_path}"))?;
    let mut local = File::create(local_path)
        .with_context(|| format!("failed to create local file {}", local_path.display()))?;
    copy_with_native_progress(
        &mut remote,
        &mut local,
        cancel_token,
        progress,
        total,
        transferred,
        started,
    )
}

fn copy_with_native_progress<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    cancel_token: Option<&SftpCancelToken>,
    progress: &mut Option<&mut dyn FnMut(SftpProgressUpdate)>,
    total: u64,
    transferred: &mut u64,
    started: &Instant,
) -> Result<()> {
    let mut buffer = [0u8; 64 * 1024];
    loop {
        ensure_not_cancelled(cancel_token)?;
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        writer.write_all(&buffer[..count])?;
        *transferred = transferred.saturating_add(count as u64);
        emit_native_transfer_progress(progress, total, *transferred, started);
    }
    writer.flush()?;
    Ok(())
}

fn native_ensure_dir(sftp: &ssh2::Sftp, remote_path: &str) -> Result<()> {
    match sftp.mkdir(Path::new(remote_path), 0o755) {
        Ok(()) => Ok(()),
        Err(error) if native_path_is_dir(sftp, remote_path) => {
            let _ = error;
            Ok(())
        }
        Err(error) => Err(error)
            .with_context(|| format!("failed to create native SFTP directory {remote_path}")),
    }
}

fn native_path_is_dir(sftp: &ssh2::Sftp, remote_path: &str) -> bool {
    sftp.stat(Path::new(remote_path))
        .ok()
        .is_some_and(|stat| native_file_is_dir(&stat))
}

fn local_transfer_size(path: &Path) -> Result<u64> {
    let metadata = fs::metadata(path)
        .with_context(|| format!("failed to stat local path {}", path.display()))?;
    if metadata.is_file() {
        return Ok(metadata.len());
    }
    if !metadata.is_dir() {
        return Ok(0);
    }
    let mut total = 0u64;
    for entry in fs::read_dir(path)
        .with_context(|| format!("failed to read local directory {}", path.display()))?
    {
        total = total.saturating_add(local_transfer_size(&entry?.path())?);
    }
    Ok(total)
}

fn remote_transfer_size(sftp: &ssh2::Sftp, remote_path: &str, is_dir: bool) -> Result<u64> {
    if !is_dir {
        return Ok(sftp
            .stat(Path::new(remote_path))
            .ok()
            .and_then(|stat| stat.size)
            .unwrap_or(0));
    }

    let mut total = 0u64;
    for (entry_path, stat) in sftp
        .readdir(Path::new(remote_path))
        .with_context(|| format!("failed to read native SFTP directory {remote_path}"))?
    {
        let name = native_entry_name(&entry_path);
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        if native_file_is_dir(&stat) {
            total = total.saturating_add(remote_transfer_size(
                sftp,
                &native_entry_path(remote_path, &entry_path, &name),
                true,
            )?);
        } else {
            total = total.saturating_add(stat.size.unwrap_or(0));
        }
    }
    Ok(total)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct SystemSftpProgressDetails {
    transferred_bytes: Option<u64>,
    total_bytes: Option<u64>,
    bytes_per_second: Option<u64>,
    remaining_seconds: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TransferProgressStats {
    bytes_per_second: Option<u64>,
    remaining_seconds: Option<u64>,
    estimated_completion_epoch_ms: Option<u64>,
    elapsed_seconds: u64,
}

fn emit_native_transfer_progress(
    progress: &mut Option<&mut dyn FnMut(SftpProgressUpdate)>,
    total: u64,
    transferred: u64,
    started: &Instant,
) {
    let Some(callback) = progress.as_deref_mut() else {
        return;
    };
    let percent = if total == 0 {
        100
    } else {
        ((transferred.saturating_mul(100) / total).min(100)) as u8
    };
    let stats = transfer_progress_stats(total, transferred, started);
    callback(SftpProgressUpdate {
        percent: Some(percent),
        text: format_transfer_progress_text(transferred, total, &stats),
        transferred_bytes: Some(transferred),
        total_bytes: Some(total),
        bytes_per_second: stats.bytes_per_second,
        remaining_seconds: stats.remaining_seconds,
        eta_seconds: stats.remaining_seconds,
        estimated_completion_epoch_ms: stats.estimated_completion_epoch_ms,
        elapsed_seconds: Some(stats.elapsed_seconds),
    });
}

fn emit_native_transfer_done(
    progress: &mut Option<&mut dyn FnMut(SftpProgressUpdate)>,
    total: u64,
    transferred: u64,
    started: &Instant,
) {
    let Some(callback) = progress.as_deref_mut() else {
        return;
    };
    let display_total = if total == 0 && transferred > 0 {
        transferred
    } else {
        total
    };
    let display_transferred = if display_total > 0 {
        display_total
    } else {
        transferred
    };
    let stats = transfer_progress_stats(display_total, display_transferred, started);
    callback(SftpProgressUpdate {
        percent: Some(100),
        text: format!(
            "传输完成 · {}",
            format_transfer_progress_text(display_transferred, display_total, &stats)
        ),
        transferred_bytes: Some(display_transferred),
        total_bytes: Some(display_total),
        bytes_per_second: stats.bytes_per_second,
        remaining_seconds: Some(0),
        eta_seconds: Some(0),
        estimated_completion_epoch_ms: unix_timestamp_ms(),
        elapsed_seconds: Some(stats.elapsed_seconds),
    });
}

fn plain_progress_update(percent: Option<u8>, text: impl Into<String>) -> SftpProgressUpdate {
    SftpProgressUpdate {
        percent,
        text: text.into(),
        transferred_bytes: None,
        total_bytes: None,
        bytes_per_second: None,
        remaining_seconds: None,
        eta_seconds: None,
        estimated_completion_epoch_ms: None,
        elapsed_seconds: None,
    }
}

fn transfer_progress_stats(
    total: u64,
    transferred: u64,
    started: &Instant,
) -> TransferProgressStats {
    let elapsed = started.elapsed();
    let elapsed_seconds = elapsed.as_secs();
    let elapsed_fractional = elapsed.as_secs_f64();
    let bytes_per_second = if transferred > 0 && elapsed_fractional > 0.0 {
        Some(((transferred as f64 / elapsed_fractional).round() as u64).max(1))
    } else {
        None
    };
    let remaining_seconds = if total <= transferred {
        Some(0)
    } else {
        bytes_per_second.map(|speed| div_ceil_u64(total.saturating_sub(transferred), speed.max(1)))
    };
    let estimated_completion_epoch_ms = remaining_seconds.and_then(|seconds| {
        unix_timestamp_ms().map(|now| now.saturating_add(seconds.saturating_mul(1000)))
    });

    TransferProgressStats {
        bytes_per_second,
        remaining_seconds,
        estimated_completion_epoch_ms,
        elapsed_seconds,
    }
}

fn format_transfer_progress_text(
    transferred: u64,
    total: u64,
    stats: &TransferProgressStats,
) -> String {
    let mut parts = vec![format!(
        "已传输 {} / {}",
        format_bytes(transferred),
        format_bytes(total)
    )];
    if let Some(speed) = stats.bytes_per_second {
        parts.push(format!("{}/s", format_bytes(speed)));
    }
    if let Some(seconds) = stats.remaining_seconds {
        parts.push(format!("剩余 {}", format_duration_compact(seconds)));
    }
    parts.join(" · ")
}

fn format_duration_compact(seconds: u64) -> String {
    if seconds >= 3600 {
        format!("{}小时{:02}分", seconds / 3600, (seconds % 3600) / 60)
    } else if seconds >= 60 {
        format!("{}分{:02}秒", seconds / 60, seconds % 60)
    } else {
        format!("{}秒", seconds)
    }
}

fn div_ceil_u64(value: u64, divisor: u64) -> u64 {
    if divisor == 0 {
        return 0;
    }
    value.saturating_add(divisor - 1) / divisor
}

fn unix_timestamp_ms() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0usize;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{} {}", bytes, UNITS[unit])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

fn ensure_not_cancelled(cancel_token: Option<&SftpCancelToken>) -> Result<()> {
    if is_cancelled(cancel_token) {
        bail!("SFTP task cancelled");
    }
    Ok(())
}
fn should_retry_sftp_root_listing(error: &anyhow::Error) -> bool {
    let message = error.to_string().to_lowercase();
    !contains_host_key_verification_failure(&message)
        && (message.contains("need cwd") || message.contains("couldn't canonicalize"))
}

fn should_try_composite_username_fallback(error: &anyhow::Error) -> bool {
    let message = error.to_string().to_lowercase();
    !message.contains("sftp task cancelled") && !contains_host_key_verification_failure(&message)
}

fn contains_host_key_verification_failure(message: &str) -> bool {
    message.contains("remote host identification has changed")
        || message.contains("possible dns spoofing detected")
        || message.contains("host key verification failed")
        || message.contains("ssh host key verification failed")
        || message.contains("ssh 主机密钥校验失败")
        || message.contains("known_hosts 旧记录")
        || message.contains("stricthostkeychecking")
        || (message.contains("offending") && message.contains("known_hosts"))
}

fn run_sftp_commands(
    profile: &ConnectionProfile,
    target_override: &SftpTargetOverride,
    commands: Vec<String>,
    cancel_token: Option<&SftpCancelToken>,
) -> Result<String> {
    run_sftp_commands_with_progress(profile, target_override, commands, cancel_token, None)
}

fn run_sftp_commands_with_initial_path(
    profile: &ConnectionProfile,
    target_override: &SftpTargetOverride,
    commands: Vec<String>,
    cancel_token: Option<&SftpCancelToken>,
    initial_remote_path: &str,
) -> Result<String> {
    run_sftp_profile_commands_with_initial_path(
        profile,
        target_override,
        commands,
        COMMAND_TIMEOUT,
        cancel_token,
        None,
        initial_remote_path,
    )
}

fn run_sftp_commands_with_progress(
    profile: &ConnectionProfile,
    target_override: &SftpTargetOverride,
    commands: Vec<String>,
    cancel_token: Option<&SftpCancelToken>,
    progress: Option<&mut dyn FnMut(SftpProgressUpdate)>,
) -> Result<String> {
    run_sftp_profile_commands_with_progress(
        profile,
        target_override,
        commands,
        COMMAND_TIMEOUT,
        cancel_token,
        progress,
    )
}

fn run_sftp_profile_commands_with_progress(
    profile: &ConnectionProfile,
    target_override: &SftpTargetOverride,
    commands: Vec<String>,
    timeout: Duration,
    cancel_token: Option<&SftpCancelToken>,
    progress: Option<&mut dyn FnMut(SftpProgressUpdate)>,
) -> Result<String> {
    run_sftp_profile_commands_with_initial_path(
        profile,
        target_override,
        commands,
        timeout,
        cancel_token,
        progress,
        "",
    )
}

fn run_sftp_profile_commands_with_initial_path(
    profile: &ConnectionProfile,
    target_override: &SftpTargetOverride,
    commands: Vec<String>,
    timeout: Duration,
    cancel_token: Option<&SftpCancelToken>,
    mut progress: Option<&mut dyn FnMut(SftpProgressUpdate)>,
    initial_remote_path: &str,
) -> Result<String> {
    let initial_remote_path = non_empty_initial_remote_path(initial_remote_path);
    let primary_result = run_sftp_launch_plan_with_progress_ref(
        build_sftp_launch_plan_with_initial_path(profile, target_override, initial_remote_path),
        commands.clone(),
        timeout,
        cancel_token,
        &mut progress,
    );

    match primary_result {
        Ok(output) => Ok(output),
        Err(primary_error) => {
            if !should_try_composite_username_fallback(&primary_error) {
                return Err(primary_error);
            }

            let Some(fallback_plan) = build_sftp_fallback_launch_plan_with_initial_path(
                profile,
                target_override,
                initial_remote_path,
            ) else {
                return Err(primary_error);
            };

            if let Some(callback) = progress.as_deref_mut() {
                callback(plain_progress_update(
                    None,
                    "ProxyJump 不可用，正在尝试复合用户名 SFTP...",
                ));
            }

            run_sftp_launch_plan_with_progress_ref(
                fallback_plan,
                commands,
                timeout,
                cancel_token,
                &mut progress,
            )
            .map_err(|fallback_error| {
                anyhow::anyhow!(
                    "SFTP ProxyJump 路线失败\n{}\n\nSFTP 复合用户名路线失败\n{}",
                    clean_sftp_output(&primary_error.to_string()),
                    clean_sftp_output(&fallback_error.to_string())
                )
            })
        }
    }
}

fn run_sftp_launch_plan_with_progress_ref(
    plan: SftpLaunchPlan,
    commands: Vec<String>,
    timeout: Duration,
    cancel_token: Option<&SftpCancelToken>,
    progress: &mut Option<&mut dyn FnMut(SftpProgressUpdate)>,
) -> Result<String> {
    if is_cancelled(cancel_token) {
        bail!("SFTP task cancelled");
    }

    let mut process = spawn_pty_process(
        PtyCommand::new(plan.program, plan.args),
        SFTP_PTY_COLS,
        SFTP_PTY_ROWS,
    )?;
    let writer = process.writer.clone();
    let output_rx = spawn_reader_channel(process.reader);
    let line_ending = sftp_line_ending();
    let mut command_index = 0usize;
    let mut output = Vec::new();
    let mut prompt_window = String::new();
    let mut password_index = 0;
    let mut host_key_confirmed = false;
    let started = Instant::now();
    let mut last_output_at = started;

    loop {
        if is_cancelled(cancel_token) {
            terminate_sftp_process(&mut process.session, process.child.as_mut());
            bail!("SFTP task cancelled");
        }

        match output_rx.recv_timeout(Duration::from_millis(20)) {
            Ok(chunk) => {
                collect_sftp_chunk(
                    &chunk,
                    &mut output,
                    &mut prompt_window,
                    &mut last_output_at,
                    progress,
                );
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {}
        }

        while let Ok(chunk) = output_rx.try_recv() {
            collect_sftp_chunk(
                &chunk,
                &mut output,
                &mut prompt_window,
                &mut last_output_at,
                progress,
            );
        }

        if let Some(response) = terminal_status_response(&prompt_window) {
            write_to_pty(&writer, response)?;
            prompt_window = prompt_window.replace("\x1b[6n", "");
            continue;
        }

        let normalized_prompt = prompt_window.to_lowercase();
        if output_contains_host_key_warning(&prompt_window) {
            terminate_sftp_process(&mut process.session, process.child.as_mut());
            bail!("{}", host_key_warning_hint(&prompt_window));
        }

        if !host_key_confirmed
            && normalized_prompt.contains("are you sure you want to continue connecting")
        {
            write_to_pty(&writer, format!("yes{}", line_ending).as_bytes())?;
            host_key_confirmed = true;
            prompt_window.clear();
            continue;
        }

        if output_contains_password_prompt(&prompt_window) {
            if password_index >= plan.passwords.len() {
                terminate_sftp_process(&mut process.session, process.child.as_mut());
                let text = String::from_utf8_lossy(&output).into_owned();
                bail!(
                    "SFTP requires a password/passphrase, but no plaintext password is saved for this profile\n{}",
                    clean_sftp_output(&text)
                );
            }

            let secret = format!("{}{}", plan.passwords[password_index], line_ending);
            write_to_pty(&writer, secret.as_bytes())?;
            password_index += 1;
            prompt_window.clear();
            continue;
        }

        if command_index < commands.len() {
            let ready_for_next_command = if command_index == 0 {
                should_send_sftp_commands(
                    &normalized_prompt,
                    started.elapsed(),
                    last_output_at.elapsed(),
                    password_index,
                    plan.passwords.len(),
                )
            } else {
                should_send_next_sftp_command(&normalized_prompt)
            };

            if ready_for_next_command {
                let command_payload = format!("{}{}", commands[command_index], line_ending);
                write_to_pty(&writer, command_payload.as_bytes())?;
                command_index += 1;
                prompt_window.clear();
            }
        }

        if let Some(status) = process.child.try_wait()? {
            drain_sftp_output(
                &output_rx,
                &mut output,
                &mut prompt_window,
                &mut last_output_at,
                progress,
                SFTP_CHILD_EXIT_GRACE,
            );
            let text = String::from_utf8_lossy(&output).into_owned();
            if !status.success() {
                bail!("SFTP command failed\n{}", clean_sftp_output(&text));
            }
            return Ok(text);
        }

        if started.elapsed() > timeout {
            terminate_sftp_process(&mut process.session, process.child.as_mut());
            let text = String::from_utf8_lossy(&output).into_owned();
            bail!("SFTP command timed out\n{}", clean_sftp_output(&text));
        }
    }
}
fn collect_sftp_chunk(
    chunk: &[u8],
    output: &mut Vec<u8>,
    prompt_window: &mut String,
    last_output_at: &mut Instant,
    progress: &mut Option<&mut dyn FnMut(SftpProgressUpdate)>,
) {
    output.extend_from_slice(chunk);
    append_limited_lossy(prompt_window, chunk, 2048);
    *last_output_at = Instant::now();
    emit_sftp_progress(chunk, progress);
}

fn drain_sftp_output(
    output_rx: &std::sync::mpsc::Receiver<Vec<u8>>,
    output: &mut Vec<u8>,
    prompt_window: &mut String,
    last_output_at: &mut Instant,
    progress: &mut Option<&mut dyn FnMut(SftpProgressUpdate)>,
    max_wait: Duration,
) {
    let started = Instant::now();
    while started.elapsed() < max_wait {
        match output_rx.recv_timeout(Duration::from_millis(20)) {
            Ok(chunk) => {
                collect_sftp_chunk(&chunk, output, prompt_window, last_output_at, progress)
            }
            Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {
                if started.elapsed() >= Duration::from_millis(80)
                    && last_output_at.elapsed() >= SFTP_OUTPUT_QUIET_GRACE
                {
                    break;
                }
            }
        }

        while let Ok(chunk) = output_rx.try_recv() {
            collect_sftp_chunk(&chunk, output, prompt_window, last_output_at, progress);
        }
    }
}

fn emit_sftp_progress(chunk: &[u8], progress: &mut Option<&mut dyn FnMut(SftpProgressUpdate)>) {
    let Some(callback) = progress.as_deref_mut() else {
        return;
    };
    let text = String::from_utf8_lossy(chunk);
    let Some(percent) = extract_sftp_progress_percent(&text) else {
        return;
    };
    let line = last_sftp_progress_line(&text);
    callback(system_sftp_progress_update(percent, line));
}

fn system_sftp_progress_update(percent: u8, text: String) -> SftpProgressUpdate {
    let details = parse_system_sftp_progress_details(&text, percent);
    let estimated_completion_epoch_ms = details.remaining_seconds.and_then(|seconds| {
        unix_timestamp_ms().map(|now| now.saturating_add(seconds.saturating_mul(1000)))
    });
    SftpProgressUpdate {
        percent: Some(percent),
        text,
        transferred_bytes: details.transferred_bytes,
        total_bytes: details.total_bytes,
        bytes_per_second: details.bytes_per_second,
        remaining_seconds: details.remaining_seconds,
        eta_seconds: details.remaining_seconds,
        estimated_completion_epoch_ms,
        elapsed_seconds: None,
    }
}

fn parse_system_sftp_progress_details(text: &str, percent: u8) -> SystemSftpProgressDetails {
    let Some((_, suffix)) = text.split_once(&format!("{percent}%")) else {
        return SystemSftpProgressDetails::default();
    };
    let tokens: Vec<&str> = suffix.split_whitespace().collect();
    let transferred_bytes = tokens
        .first()
        .and_then(|token| parse_transfer_size_token(token));
    let bytes_per_second = tokens
        .iter()
        .find(|token| token.to_ascii_lowercase().contains("/s"))
        .and_then(|token| parse_transfer_speed_token(token));
    let remaining_seconds = tokens
        .iter()
        .rev()
        .find_map(|token| parse_transfer_duration_token(token));
    let total_bytes = transferred_bytes.and_then(|bytes| {
        if percent == 0 {
            None
        } else {
            bytes
                .checked_mul(100)
                .map(|value| div_ceil_u64(value, u64::from(percent)))
        }
    });

    SystemSftpProgressDetails {
        transferred_bytes,
        total_bytes,
        bytes_per_second,
        remaining_seconds,
    }
}

fn parse_transfer_speed_token(token: &str) -> Option<u64> {
    parse_transfer_size_token(&token.replace("/s", "").replace("/S", ""))
}

fn parse_transfer_size_token(token: &str) -> Option<u64> {
    let normalized = token.trim().trim_matches(',');
    if normalized.is_empty() {
        return None;
    }
    let split_at = normalized
        .find(|ch: char| !(ch.is_ascii_digit() || ch == '.'))
        .unwrap_or(normalized.len());
    let (number, unit) = normalized.split_at(split_at);
    let value = number.parse::<f64>().ok()?;
    if !value.is_finite() || value < 0.0 {
        return None;
    }
    let unit = unit.to_ascii_lowercase();
    let multiplier = match unit.as_str() {
        "" | "b" => 1.0,
        "k" | "kb" | "kib" => 1024.0,
        "m" | "mb" | "mib" => 1024.0 * 1024.0,
        "g" | "gb" | "gib" => 1024.0 * 1024.0 * 1024.0,
        "t" | "tb" | "tib" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    Some((value * multiplier).round().max(0.0) as u64)
}

fn parse_transfer_duration_token(token: &str) -> Option<u64> {
    let token = token.trim().trim_matches(',');
    if token.is_empty() || !token.chars().all(|ch| ch.is_ascii_digit() || ch == ':') {
        return None;
    }
    let parts: Vec<u64> = token
        .split(':')
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    match parts.as_slice() {
        [minutes, seconds] => Some(minutes.saturating_mul(60).saturating_add(*seconds)),
        [hours, minutes, seconds] => Some(
            hours
                .saturating_mul(3600)
                .saturating_add(minutes.saturating_mul(60))
                .saturating_add(*seconds),
        ),
        _ => None,
    }
}

fn extract_sftp_progress_percent(text: &str) -> Option<u8> {
    let bytes = text.as_bytes();
    for index in 0..bytes.len() {
        if bytes[index] != b'%' {
            continue;
        }
        let mut start = index;
        while start > 0 && bytes[start - 1].is_ascii_digit() {
            start -= 1;
        }
        if start == index {
            continue;
        }
        if let Ok(value) = text[start..index].parse::<u8>() {
            if value <= 100 {
                return Some(value);
            }
        }
    }
    None
}

fn last_sftp_progress_line(text: &str) -> String {
    text.replace('\r', "\n")
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .chars()
        .take(160)
        .collect()
}
fn terminate_sftp_process(session: &mut PtySession, child: &mut dyn Child) {
    session.kill();
    let started = Instant::now();
    while started.elapsed() < SFTP_CHILD_EXIT_GRACE {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => return,
        }
    }
}

fn terminal_status_response(output: &str) -> Option<&'static [u8]> {
    if output.contains("\x1b[6n") {
        Some(b"\x1b[1;1R")
    } else {
        None
    }
}

fn sftp_line_ending() -> &'static str {
    if cfg!(windows) {
        "\r\n"
    } else {
        "\n"
    }
}

fn should_send_sftp_commands(
    normalized_prompt: &str,
    elapsed: Duration,
    quiet_for: Duration,
    password_index: usize,
    password_count: usize,
) -> bool {
    if normalized_prompt.contains("sftp>") {
        return true;
    }

    if normalized_prompt.contains("are you sure you want to continue connecting")
        || output_contains_password_prompt(normalized_prompt)
    {
        return false;
    }

    if normalized_prompt.contains("connected to ") && quiet_for >= SFTP_OUTPUT_QUIET_GRACE {
        return true;
    }

    elapsed >= SFTP_READY_GRACE && password_index >= password_count
}

fn should_send_next_sftp_command(normalized_prompt: &str) -> bool {
    normalized_prompt.contains("sftp>")
}

fn is_cancelled(cancel_token: Option<&SftpCancelToken>) -> bool {
    cancel_token
        .map(|token| token.load(Ordering::SeqCst))
        .unwrap_or(false)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SftpRoute {
    target: AuthEndpoint,
    proxy: Option<AuthEndpoint>,
}

fn effective_sftp_route(
    profile: &ConnectionProfile,
    target_override: &SftpTargetOverride,
) -> SftpRoute {
    let target = apply_target_override(&profile.target, target_override);
    let proxy = explicit_sftp_gateway(profile)
        .or_else(|| infer_direct_login_proxy(profile, target_override, &target));

    SftpRoute { target, proxy }
}

fn explicit_sftp_gateway(profile: &ConnectionProfile) -> Option<AuthEndpoint> {
    if matches!(profile.file_transfer_mode, FileTransferMode::SftpGateway) {
        non_empty_endpoint(&profile.gateway)
    } else {
        None
    }
}

fn infer_direct_login_proxy(
    profile: &ConnectionProfile,
    target_override: &SftpTargetOverride,
    target: &AuthEndpoint,
) -> Option<AuthEndpoint> {
    if !matches!(
        profile.file_transfer_mode,
        FileTransferMode::Auto | FileTransferMode::SftpDirect
    ) {
        return None;
    }
    if !matches!(profile.jump_mode, JumpMode::Direct) {
        return None;
    }
    if !target_override_has_host(target_override) {
        return None;
    }
    let proxy = non_empty_endpoint(&profile.target)?;
    if same_endpoint_host(&proxy, target) {
        None
    } else {
        Some(proxy)
    }
}

fn composite_username_fallback_route(
    profile: &ConnectionProfile,
    target_override: &SftpTargetOverride,
) -> Option<SftpRoute> {
    if !matches!(
        profile.file_transfer_mode,
        FileTransferMode::Auto | FileTransferMode::SftpDirect
    ) {
        return None;
    }
    if !matches!(profile.jump_mode, JumpMode::Direct) {
        return None;
    }

    let target_host = target_override
        .host
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let target_username = target_override
        .username
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let mut bastion = non_empty_endpoint(&profile.target)?;
    let bastion_username = bastion.username.trim().to_string();

    if bastion_username.is_empty()
        || is_composite_bastion_username(&bastion_username)
        || target_host.eq_ignore_ascii_case(bastion.host.trim())
    {
        return None;
    }

    bastion.username = format!("{bastion_username}/{target_host}/{target_username}");
    Some(SftpRoute {
        target: bastion,
        proxy: None,
    })
}

fn is_composite_bastion_username(username: &str) -> bool {
    username
        .split('/')
        .filter(|part| !part.trim().is_empty())
        .count()
        >= 3
}

fn target_override_has_host(target_override: &SftpTargetOverride) -> bool {
    target_override
        .host
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
}

fn non_empty_endpoint(endpoint: &AuthEndpoint) -> Option<AuthEndpoint> {
    if endpoint.host.trim().is_empty() {
        None
    } else {
        Some(endpoint.clone())
    }
}

fn same_endpoint_host(left: &AuthEndpoint, right: &AuthEndpoint) -> bool {
    left.host.trim().eq_ignore_ascii_case(right.host.trim())
}

fn endpoint_destination(endpoint: &AuthEndpoint) -> String {
    let host = endpoint.host.trim();
    let username = endpoint.username.trim();
    if username.is_empty() {
        host.to_string()
    } else {
        format!("{username}@{host}")
    }
}

fn sftp_destination(endpoint: &AuthEndpoint, initial_remote_path: Option<&str>) -> String {
    let destination = endpoint_destination(endpoint);
    let Some(path) = initial_remote_path.and_then(non_empty_initial_remote_path) else {
        return destination;
    };
    format!("{destination}:{path}")
}

fn non_empty_initial_remote_path(path: &str) -> Option<&str> {
    let path = path.trim();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

fn proxy_jump_destination(endpoint: &AuthEndpoint) -> String {
    let destination = endpoint_destination(endpoint);
    match endpoint.port {
        Some(port) if port != 22 => format!("{destination}:{port}"),
        _ => destination,
    }
}

fn apply_target_override(
    target: &AuthEndpoint,
    target_override: &SftpTargetOverride,
) -> AuthEndpoint {
    let mut target = target.clone();
    let mut host_changed = false;
    if let Some(host) = target_override
        .host
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        host_changed = !host.eq_ignore_ascii_case(target.host.trim());
        target.host = host.into();
    }
    if let Some(username) = target_override
        .username
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        target.username = username.into();
    }
    if host_changed {
        target.port = Some(22);
        target.password = None;
        target.credential_ref = None;
    }
    target
}

fn plaintext_passwords(route: &SftpRoute) -> Vec<String> {
    let mut passwords = Vec::new();
    if let Some(proxy) = route.proxy.as_ref().and_then(endpoint_plaintext_password) {
        passwords.push(proxy);
    }
    if let Some(target) = endpoint_plaintext_password(&route.target) {
        passwords.push(target);
    }
    passwords
}

fn endpoint_plaintext_password(endpoint: &AuthEndpoint) -> Option<String> {
    if endpoint.auth_mode == AuthMode::Key {
        return None;
    }

    endpoint.password.clone().and_then(|password| {
        if password.trim().is_empty() {
            None
        } else {
            Some(password)
        }
    })
}

fn quote_sftp_path(path: &str) -> Result<String> {
    if path.contains('\n') || path.contains('\r') {
        bail!("paths cannot contain newlines");
    }
    Ok(format!(
        "\"{}\"",
        path.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}

fn normalize_remote_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        ".".into()
    } else {
        trimmed.into()
    }
}

fn expand_tilde(path: &str) -> String {
    let Some(home) = home_path() else {
        return path.into();
    };

    let expanded = if path == "~" {
        home
    } else if let Some(rest) = path.strip_prefix("~/") {
        home.join(rest)
    } else {
        return path.into();
    };

    expanded.to_string_lossy().into_owned()
}

fn parse_list_output(output: &str, fallback_path: &str) -> Result<SftpListResponse> {
    let cleaned = clean_sftp_listing_output(output);
    fail_on_sftp_listing_error(&cleaned)?;
    let path =
        parse_remote_working_directory(&cleaned).unwrap_or_else(|| fallback_path.to_string());

    let entries = cleaned
        .lines()
        .filter_map(|line| parse_ls_line(line, &path))
        .filter(|entry| entry.name != "." && entry.name != "..")
        .collect();

    Ok(SftpListResponse { path, entries })
}

fn fail_on_sftp_listing_error(output: &str) -> Result<()> {
    if output.lines().any(is_sftp_listing_error_line) {
        bail!("SFTP 读取目录失败\n{}", clean_sftp_output(output));
    }
    Ok(())
}

fn is_sftp_listing_error_line(line: &str) -> bool {
    let line = line.trim();
    if line.is_empty() || line.starts_with("sftp>") {
        return false;
    }
    let lower = line.to_ascii_lowercase();
    lower.contains("permission denied")
        || lower.contains("no such file")
        || lower.contains("not a directory")
        || lower.contains("couldn't canonicalize")
        || lower.contains("need cwd")
        || lower.contains("remote readdir")
        || lower.contains("usage:")
        || lower.contains("failure")
}

fn clean_sftp_listing_output(output: &str) -> String {
    output
        .lines()
        .map(strip_terminal_controls)
        .collect::<Vec<_>>()
        .join("\n")
}

fn parse_remote_working_directory(output: &str) -> Option<String> {
    output
        .lines()
        .filter_map(|line| {
            line.trim()
                .strip_prefix("Remote working directory: ")
                .map(str::trim)
        })
        .last()
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn parse_ls_line(line: &str, current_path: &str) -> Option<SftpFileEntry> {
    let cleaned = strip_terminal_controls(line);
    let trimmed = trim_to_listing_record(cleaned.trim())?;
    parse_unix_ls_line(trimmed, current_path)
        .or_else(|| parse_windows_ls_line(trimmed, current_path))
}

fn trim_to_listing_record(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(rest) = trimmed.strip_prefix("sftp>") {
        return Some(rest.trim_start());
    }
    for (index, _) in trimmed.char_indices() {
        let candidate = &trimmed[index..];
        if looks_like_unix_permissions(candidate) {
            return Some(candidate);
        }
    }
    Some(trimmed)
}

fn looks_like_unix_permissions(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !matches!(first, 'd' | '-' | 'l') {
        return false;
    }
    chars
        .take(9)
        .filter(|ch| matches!(ch, 'r' | 'w' | 'x' | 's' | 'S' | 't' | 'T' | '-'))
        .count()
        == 9
}

fn parse_unix_ls_line(trimmed: &str, current_path: &str) -> Option<SftpFileEntry> {
    if !looks_like_unix_permissions(trimmed) {
        return None;
    }

    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    if parts.len() < 9 {
        return None;
    }

    let permissions = parts[0].to_string();
    let size = parts[4].parse::<u64>().unwrap_or(0);
    let modified = format!("{} {} {}", parts[5], parts[6], parts[7]);
    let name = parts[8..].join(" ");
    let name = name.split(" -> ").next().unwrap_or(&name).to_string();
    if name.is_empty() {
        return None;
    }

    Some(SftpFileEntry {
        path: join_remote_path(current_path, &name),
        is_dir: permissions.starts_with('d'),
        name,
        size,
        permissions,
        modified,
    })
}

fn parse_windows_ls_line(trimmed: &str, current_path: &str) -> Option<SftpFileEntry> {
    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    if parts.len() < 4 || !looks_like_windows_date(parts[0]) || !parts[1].contains(':') {
        return None;
    }

    let has_meridiem = parts
        .get(2)
        .is_some_and(|part| part.eq_ignore_ascii_case("AM") || part.eq_ignore_ascii_case("PM"));
    let marker_index = if has_meridiem { 3 } else { 2 };
    let name_index = marker_index + 1;
    let marker = *parts.get(marker_index)?;
    let name = parts.get(name_index..)?.join(" ");
    if name.is_empty() {
        return None;
    }

    let is_dir = marker.eq_ignore_ascii_case("<DIR>");
    let size = if is_dir {
        0
    } else {
        marker.replace(',', "").parse::<u64>().unwrap_or(0)
    };
    let modified = if has_meridiem {
        format!("{} {} {}", parts[0], parts[1], parts[2])
    } else {
        format!("{} {}", parts[0], parts[1])
    };
    let permissions = if is_dir { "<DIR>" } else { "-" }.to_string();

    Some(SftpFileEntry {
        path: join_remote_path(current_path, &name),
        is_dir,
        name,
        size,
        permissions,
        modified,
    })
}

fn looks_like_windows_date(value: &str) -> bool {
    let parts: Vec<&str> = value.split(|ch| ch == '/' || ch == '-').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()))
}

fn transfer_response(
    message: String,
    local_path: Option<String>,
    remote_path: Option<String>,
    target_path: Option<String>,
    is_dir: bool,
) -> SftpTransferResponse {
    SftpTransferResponse {
        message,
        local_path,
        remote_path,
        target_path,
        is_dir,
    }
}

fn remote_file_name(path: &str) -> String {
    let trimmed = path.trim().trim_end_matches('/');
    let name = trimmed.rsplit('/').next().unwrap_or(trimmed).trim();
    if name.is_empty() || name == "." || name == ".." {
        "download".into()
    } else {
        name.into()
    }
}

fn local_file_name(path: &str) -> String {
    let trimmed = path.trim().trim_end_matches(|ch| ch == '/' || ch == '\\');
    let name = trimmed
        .rsplit(|ch| ch == '/' || ch == '\\')
        .next()
        .unwrap_or(trimmed)
        .trim();
    if name.is_empty() {
        "upload".into()
    } else {
        name.into()
    }
}

fn local_child_path(base: &str, name: &str) -> String {
    let trimmed = base.trim_end_matches(|ch| ch == '/' || ch == '\\');
    if base == "/" {
        return format!("/{name}");
    }
    if trimmed.is_empty() {
        return name.into();
    }
    let separator = if base.contains('\\') {
        '\\'
    } else {
        std::path::MAIN_SEPARATOR
    };
    format!("{trimmed}{separator}{name}")
}

fn download_target_path(local_dir: &str, remote_path: &str) -> String {
    local_child_path(local_dir, &remote_file_name(remote_path))
}

fn upload_target_path(remote_dir: &str, local_path: &str) -> String {
    join_remote_path(remote_dir, &local_file_name(local_path))
}
fn join_remote_path(base: &str, name: &str) -> String {
    if base == "/" {
        format!("/{name}")
    } else if base.ends_with('/') {
        format!("{base}{name}")
    } else {
        format!("{base}/{name}")
    }
}

fn clean_sftp_output(output: &str) -> String {
    output
        .lines()
        .map(strip_terminal_controls)
        .filter(|line| !line.trim().is_empty())
        .take(30)
        .collect::<Vec<_>>()
        .join("\n")
}

fn strip_terminal_controls(value: &str) -> String {
    let without_ansi = strip_ansi_controls(value);
    strip_bare_csi_fragments(&without_ansi).trim().to_string()
}

fn strip_ansi_controls(value: &str) -> String {
    let mut result = String::new();
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            match chars.peek().copied() {
                Some('[') => {
                    chars.next();
                    while let Some(next) = chars.next() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    while let Some(next) = chars.next() {
                        if next == '\u{7}' {
                            break;
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        if ch.is_control() && ch != '\t' {
            continue;
        }
        result.push(ch);
    }
    result
}

fn strip_bare_csi_fragments(value: &str) -> String {
    let mut result = String::new();
    let chars: Vec<char> = value.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '[' {
            let mut cursor = index + 1;
            while cursor < chars.len()
                && (chars[cursor].is_ascii_digit() || matches!(chars[cursor], ';' | '?'))
            {
                cursor += 1;
            }
            if cursor > index + 1
                && cursor < chars.len()
                && matches!(chars[cursor], 'A'..='Z' | 'a'..='z')
            {
                index = cursor + 1;
                continue;
            }
        }
        result.push(chars[index]);
        index += 1;
    }
    result
}

fn summarize_sftp_error(error: &str) -> String {
    let cleaned = clean_sftp_output(error);
    if cleaned.is_empty() {
        "SFTP 不可用：没有收到 sftp 响应，请检查堡垒机是否允许 ProxyJump/端口转发或目标机是否开放 SFTP。".into()
    } else {
        format!(
            "SFTP 不可用：{cleaned}\n可切换到终端通道传输小文件，或检查堡垒机是否允许 ProxyJump/复合用户名 SFTP。"
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_endpoint(host: &str, username: &str, port: Option<u16>) -> AuthEndpoint {
        AuthEndpoint {
            host: host.into(),
            port,
            username: username.into(),
            auth_mode: AuthMode::Auto,
            credential_ref: None,
            password: None,
        }
    }

    fn direct_profile_targeting_bastion() -> ConnectionProfile {
        let mut target = test_endpoint("bastion.example.com", "ops", Some(2222));
        target.password = Some("bastion-password".into());
        ConnectionProfile {
            id: "direct-bastion".into(),
            name: "direct-bastion".into(),
            gateway: test_endpoint("", "", None),
            target,
            jump_mode: JumpMode::Direct,
            menu_profile_id: String::new(),
            file_transfer_mode: FileTransferMode::Auto,
        }
    }

    #[test]
    fn endpoint_destination_omits_empty_username() {
        assert_eq!(
            endpoint_destination(&test_endpoint("10.1.2.3", "", Some(22))),
            "10.1.2.3"
        );
    }

    #[test]
    fn direct_sftp_without_override_keeps_configured_target() {
        let plan = build_sftp_launch_plan(&direct_profile_targeting_bastion());
        assert!(!plan.args.iter().any(|arg| arg.starts_with("ProxyJump=")));
        assert!(plan
            .args
            .windows(2)
            .any(|pair| pair[0] == "-P" && pair[1] == "2222"));
        assert_eq!(
            plan.args.last().map(String::as_str),
            Some("ops@bastion.example.com")
        );
        assert_eq!(plan.passwords, vec!["bastion-password"]);
    }

    #[test]
    fn terminal_target_override_uses_direct_target_as_proxy_jump() {
        let plan = build_sftp_launch_plan_with_target(
            &direct_profile_targeting_bastion(),
            &SftpTargetOverride {
                host: Some("10.1.2.3".into()),
                username: Some("app".into()),
            },
        );

        assert!(plan
            .args
            .windows(2)
            .any(|pair| pair[0] == "-o" && pair[1] == "ProxyJump=ops@bastion.example.com:2222"));
        assert!(plan
            .args
            .windows(2)
            .any(|pair| pair[0] == "-P" && pair[1] == "22"));
        assert_eq!(plan.args.last().map(String::as_str), Some("app@10.1.2.3"));
        assert_eq!(plan.passwords, vec!["bastion-password"]);
    }

    #[test]
    fn terminal_target_override_fallback_uses_composite_bastion_username() {
        let plan = build_sftp_fallback_launch_plan_with_initial_path(
            &direct_profile_targeting_bastion(),
            &SftpTargetOverride {
                host: Some("10.1.2.3".into()),
                username: Some("app".into()),
            },
            None,
        )
        .expect("terminal target override should support composite username fallback");

        assert!(!plan
            .args
            .windows(2)
            .any(|pair| pair[0] == "-o" && pair[1].starts_with("ProxyJump=")));
        assert!(plan
            .args
            .windows(2)
            .any(|pair| pair[0] == "-P" && pair[1] == "2222"));
        assert_eq!(
            plan.args.last().map(String::as_str),
            Some("ops/10.1.2.3/app@bastion.example.com")
        );
        assert_eq!(plan.passwords, vec!["bastion-password"]);
    }
    #[test]
    fn native_sftp_routes_try_proxy_jump_then_composite_username() {
        let routes = native_sftp_routes(
            &direct_profile_targeting_bastion(),
            &SftpTargetOverride {
                host: Some("10.1.2.3".into()),
                username: Some("app".into()),
            },
        );

        assert_eq!(routes.len(), 2);
        assert_eq!(routes[0].target.host, "10.1.2.3");
        assert_eq!(routes[0].target.username, "app");
        assert_eq!(
            routes[0]
                .proxy
                .as_ref()
                .map(endpoint_destination)
                .as_deref(),
            Some("ops@bastion.example.com")
        );
        assert_eq!(routes[1].target.host, "bastion.example.com");
        assert_eq!(routes[1].target.username, "ops/10.1.2.3/app");
        assert!(routes[1].proxy.is_none());
    }

    #[test]
    fn native_sftp_routes_support_explicit_gateway() {
        let mut profile = direct_profile_targeting_bastion();
        profile.file_transfer_mode = FileTransferMode::SftpGateway;
        profile.gateway = test_endpoint("gateway.example.com", "jump", Some(2200));
        profile.target = test_endpoint("10.9.8.7", "deploy", Some(22));

        let routes = native_sftp_routes(&profile, &SftpTargetOverride::default());

        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].target.host, "10.9.8.7");
        assert_eq!(
            routes[0]
                .proxy
                .as_ref()
                .map(proxy_jump_destination)
                .as_deref(),
            Some("jump@gateway.example.com:2200")
        );
    }
    #[test]
    fn sftp_direct_target_override_uses_current_connection_as_proxy_jump() {
        let mut profile = direct_profile_targeting_bastion();
        profile.file_transfer_mode = FileTransferMode::SftpDirect;

        let plan = build_sftp_launch_plan_with_target(
            &profile,
            &SftpTargetOverride {
                host: Some("10.1.2.3".into()),
                username: Some("app".into()),
            },
        );

        assert!(plan
            .args
            .windows(2)
            .any(|pair| pair[0] == "-o" && pair[1] == "ProxyJump=ops@bastion.example.com:2222"));
        assert_eq!(plan.args.last().map(String::as_str), Some("app@10.1.2.3"));
    }

    #[test]
    fn retries_need_cwd_errors_with_absolute_root_listing() {
        let error =
            anyhow::anyhow!("SFTP command failed\nCouldn't canonicalize: Failure\nNeed cwd");
        assert!(should_retry_sftp_root_listing(&error));

        let commands = list_directory_without_cwd_commands("/").unwrap();
        assert_eq!(commands, vec!["ls -l \"/\"", "bye"]);
        assert!(!commands.iter().any(|command| command.starts_with("cd ")));
    }

    #[test]
    fn need_cwd_retry_starts_sftp_at_remote_root() {
        let plan = build_sftp_launch_plan_with_initial_path(
            &direct_profile_targeting_bastion(),
            &SftpTargetOverride {
                host: Some("10.1.2.3".into()),
                username: Some("app".into()),
            },
            Some("/"),
        );

        assert_eq!(plan.args.last().map(String::as_str), Some("app@10.1.2.3:/"));
        assert!(plan
            .args
            .windows(2)
            .any(|pair| pair[0] == "-o" && pair[1] == "ProxyJump=ops@bastion.example.com:2222"));
    }

    #[test]
    fn need_cwd_fallback_starts_composite_sftp_at_remote_root() {
        let plan = build_sftp_fallback_launch_plan_with_initial_path(
            &direct_profile_targeting_bastion(),
            &SftpTargetOverride {
                host: Some("10.1.2.3".into()),
                username: Some("app".into()),
            },
            Some("/"),
        )
        .expect("terminal target override should support composite username fallback");

        assert_eq!(
            plan.args.last().map(String::as_str),
            Some("ops/10.1.2.3/app@bastion.example.com:/")
        );
        assert!(!plan
            .args
            .windows(2)
            .any(|pair| pair[0] == "-o" && pair[1].starts_with("ProxyJump=")));
    }

    #[test]
    fn host_key_warning_does_not_try_fallback_or_need_cwd_retry() {
        let error = anyhow::anyhow!(
            "[AI Term] SSH 主机密钥校验失败。堡垒机或目标机的 host key 与本机 known_hosts 旧记录不一致。\nNeed cwd"
        );

        assert!(!should_try_composite_username_fallback(&error));
        assert!(!should_retry_sftp_root_listing(&error));
    }

    #[test]
    fn cleans_terminal_control_sequences_from_sftp_errors() {
        let output = clean_sftp_output(
            "\u{1b}[?25h\u{1b}[?25lusage: ssh destination [command]\u{1b}[?25h\r\n",
        );
        assert_eq!(output, "usage: ssh destination [command]");
    }

    #[test]
    fn native_sftp_helpers_keep_remote_paths_posix_like() {
        assert_eq!(
            native_entry_name(std::path::Path::new("/root/.bashrc")),
            ".bashrc"
        );
        assert_eq!(
            native_entry_path("/root", std::path::Path::new(".bashrc"), ".bashrc"),
            "/root/.bashrc"
        );
        assert_eq!(
            native_entry_path("/root", std::path::Path::new("/root/.ssh"), ".ssh"),
            "/root/.ssh"
        );
        assert_eq!(format_unix_mode(0o040755), "drwxr-xr-x");
        assert_eq!(format_unix_mode(0o100644), "-rw-r--r--");
    }

    #[test]
    fn reports_sftp_listing_errors_instead_of_empty_directory() {
        let error = parse_list_output(
            "sftp> ls -l /root\nremote readdir(\"/root\"): Permission denied\n",
            "/root",
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("SFTP 读取目录失败"));
        assert!(error.contains("Permission denied"));
    }

    #[test]
    fn parses_unix_listing() {
        let output = "Remote working directory: /var/log\n\
                      drwxr-xr-x    2 root root 4096 Jul 01 10:00 nginx\n\
                      -rw-r--r--    1 root root  123 Jul 02 09:30 syslog\n";

        let parsed = parse_list_output(output, ".").unwrap();
        assert_eq!(parsed.path, "/var/log");
        assert_eq!(parsed.entries.len(), 2);
        assert!(parsed.entries[0].is_dir);
        assert_eq!(parsed.entries[1].path, "/var/log/syslog");
    }

    #[test]
    fn parses_listing_after_windows_cursor_controls() {
        let output = "Remote working directory: /home/app\n\
                      drwxr-xr-x    2 app app 4096 Jul 15 2024 .arthas\u{1b}[12X\u{1b}[12C\n\
                      drwxr-xr-x    2 app app 4096 Jun 13 2023 .cache[13X[13C\n";

        let parsed = parse_list_output(output, ".").unwrap();
        assert_eq!(parsed.path, "/home/app");
        assert_eq!(parsed.entries.len(), 2);
        assert_eq!(parsed.entries[0].name, ".arthas");
        assert_eq!(parsed.entries[1].name, ".cache");
    }
    #[test]
    fn parses_listing_with_sftp_prompt_prefix() {
        let output = "Remote working directory: /home/app\n\
                      sftp> drwxr-xr-x    2 app app 4096 Jul 15 2024 releases\n";

        let parsed = parse_list_output(output, ".").unwrap();
        assert_eq!(parsed.entries.len(), 1);
        assert_eq!(parsed.entries[0].name, "releases");
        assert!(parsed.entries[0].is_dir);
    }

    #[test]
    fn parses_windows_style_listing() {
        let output = "Remote working directory: C:/Users/app\n\
                      07/06/2026  08:12 PM    <DIR>          Documents\n\
                      07/06/2026  08:13 PM             1,024 report.txt\n";

        let parsed = parse_list_output(output, ".").unwrap();
        assert_eq!(parsed.entries.len(), 2);
        assert_eq!(parsed.entries[0].name, "Documents");
        assert!(parsed.entries[0].is_dir);
        assert_eq!(parsed.entries[1].name, "report.txt");
        assert_eq!(parsed.entries[1].size, 1024);
    }
    #[test]
    fn parses_probe_working_directory() {
        let output = "Connected to 10.0.0.7.\nRemote working directory: /home/app\nsftp> bye\n";

        assert_eq!(
            parse_remote_working_directory(output).as_deref(),
            Some("/home/app")
        );
    }

    #[test]
    fn quotes_paths_for_sftp_commands() {
        assert_eq!(quote_sftp_path("/tmp/a b.txt").unwrap(), "\"/tmp/a b.txt\"");
        assert!(quote_sftp_path("/tmp/a\nb").is_err());
    }

    #[test]
    fn responds_to_windows_sftp_cursor_position_request() {
        assert_eq!(
            terminal_status_response("prefix\x1b[6nsuffix").unwrap(),
            b"\x1b[1;1R"
        );
        assert!(terminal_status_response("ordinary output").is_none());
    }

    #[test]
    fn computes_transfer_target_paths() {
        assert_eq!(remote_file_name("/var/log/syslog"), "syslog");
        assert_eq!(remote_file_name("relative/folder/"), "folder");
        assert_eq!(
            download_target_path("C:\\Users\\me\\Downloads", "/var/log/nginx"),
            "C:\\Users\\me\\Downloads\\nginx"
        );
        assert_eq!(
            upload_target_path("/opt/app", "C:\\tmp\\release.tar.gz"),
            "/opt/app/release.tar.gz"
        );
    }

    #[test]
    fn parses_sftp_transfer_progress_percent() {
        assert_eq!(
            extract_sftp_progress_percent("release.tar.gz  42% 12MB 1.0MB/s 00:08"),
            Some(42)
        );
        assert_eq!(
            extract_sftp_progress_percent("upload complete 100%"),
            Some(100)
        );
        assert_eq!(extract_sftp_progress_percent("Connected to host."), None);
    }

    #[test]
    fn parses_system_sftp_transfer_progress_details() {
        let details =
            parse_system_sftp_progress_details("release.tar.gz  42% 12MB 1.0MB/s 00:08", 42);
        assert_eq!(details.transferred_bytes, Some(12 * 1024 * 1024));
        assert_eq!(details.total_bytes, Some(29_959_315));
        assert_eq!(details.bytes_per_second, Some(1024 * 1024));
        assert_eq!(details.remaining_seconds, Some(8));
    }
    #[test]
    fn waits_for_sftp_prompt_before_follow_up_commands() {
        assert!(should_send_next_sftp_command("sftp> "));
        assert!(!should_send_next_sftp_command(
            "drwxr-xr-x 2 root root 4096 Jun 8 data"
        ));
        assert!(!should_send_next_sftp_command(""));
    }
    #[test]
    fn sends_sftp_commands_after_windows_ready_markers() {
        assert!(should_send_sftp_commands(
            "connected to 10.0.0.7.\r\n",
            Duration::from_millis(0),
            SFTP_OUTPUT_QUIET_GRACE,
            0,
            0,
        ));
        assert!(should_send_sftp_commands(
            "sftp> ",
            Duration::from_millis(0),
            Duration::from_millis(0),
            0,
            1,
        ));
        assert!(!should_send_sftp_commands(
            "user@host's password: ",
            SFTP_READY_GRACE,
            SFTP_READY_GRACE,
            0,
            1,
        ));
        assert!(!should_send_sftp_commands(
            "are you sure you want to continue connecting",
            SFTP_READY_GRACE,
            SFTP_READY_GRACE,
            0,
            0,
        ));
        assert!(!should_send_sftp_commands(
            "",
            SFTP_READY_GRACE,
            SFTP_READY_GRACE,
            0,
            1,
        ));
        assert!(should_send_sftp_commands(
            "",
            SFTP_READY_GRACE,
            SFTP_READY_GRACE,
            0,
            0,
        ));
    }
}
