use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::mpsc::RecvTimeoutError;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use super::models::{AuthEndpoint, AuthMode, ConnectionProfile, FileTransferMode, JumpMode};
use crate::domain::filesystem::local::home_path;
use crate::domain::pty::{
    append_limited_lossy, spawn_pty_process, spawn_reader_channel, write_to_pty, PtyCommand,
    PtySession,
};
use crate::domain::terminal::ssh::{
    app_known_hosts_ssh_args, host_key_warning_hint, output_contains_host_key_warning,
    output_contains_password_prompt,
};
use portable_pty::Child;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(600);
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const SFTP_CHILD_EXIT_GRACE: Duration = Duration::from_millis(500);
const SFTP_READY_GRACE: Duration = Duration::from_millis(1500);
const SFTP_OUTPUT_QUIET_GRACE: Duration = Duration::from_millis(120);

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
    let target = apply_target_override(&profile.target, target_override);
    let mut args = vec!["-o".into(), "BatchMode=no".into()];
    args.extend(app_known_hosts_ssh_args());
    args.extend(["-o".into(), "NumberOfPasswordPrompts=2".into()]);

    if should_use_gateway(profile) {
        args.push("-o".into());
        args.push(format!(
            "ProxyJump={}",
            proxy_jump_destination(&profile.gateway)
        ));
    }

    args.push("-P".into());
    args.push(target.port.unwrap_or(22).to_string());
    args.push(endpoint_destination(&target));

    SftpLaunchPlan {
        program: "sftp".into(),
        args,
        passwords: plaintext_passwords(profile),
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
    let output = run_sftp_commands(
        profile,
        target_override,
        vec![
            format!("cd {}", quote_sftp_path(&remote_path)?),
            "pwd".into(),
            "ls -la".into(),
            "bye".into(),
        ],
        cancel_token,
    )?;

    parse_list_output(&output, &remote_path)
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
    match run_sftp_launch_plan(
        build_sftp_launch_plan_with_target(profile, target_override),
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
    progress: Option<&mut dyn FnMut(SftpProgressUpdate)>,
) -> Result<SftpTransferResponse> {
    let local_path = expand_tilde(local_path);
    if !Path::new(&local_path).is_file() {
        bail!("local file does not exist: {local_path}");
    }
    let remote_dir = normalize_remote_path(remote_dir);
    let remote_path = upload_target_path(&remote_dir, &local_path);
    run_sftp_launch_plan(
        build_sftp_launch_plan_with_target(profile, target_override),
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
    progress: Option<&mut dyn FnMut(SftpProgressUpdate)>,
) -> Result<SftpTransferResponse> {
    let local_path = expand_tilde(local_path);
    let local = Path::new(&local_path);
    if !local.exists() {
        bail!("local path does not exist: {local_path}");
    }

    let is_dir = local.is_dir();
    let remote_dir = normalize_remote_path(remote_dir);
    let remote_path = upload_target_path(&remote_dir, &local_path);
    let put_command = if is_dir {
        format!("put -r {}", quote_sftp_path(&local_path)?)
    } else {
        format!("put {}", quote_sftp_path(&local_path)?)
    };
    run_sftp_launch_plan(
        build_sftp_launch_plan_with_target(profile, target_override),
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
    progress: Option<&mut dyn FnMut(SftpProgressUpdate)>,
) -> Result<SftpTransferResponse> {
    let remote_path = normalize_remote_path(remote_path);
    let local_path = expand_tilde(local_path);
    run_sftp_launch_plan(
        build_sftp_launch_plan_with_target(profile, target_override),
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
    progress: Option<&mut dyn FnMut(SftpProgressUpdate)>,
) -> Result<SftpTransferResponse> {
    let remote_path = normalize_remote_path(remote_path);
    let local_dir = expand_tilde(local_dir);
    let local = Path::new(&local_dir);
    std::fs::create_dir_all(local)
        .with_context(|| format!("failed to create local directory: {local_dir}"))?;
    if !local.is_dir() {
        bail!("local path is not a directory: {local_dir}");
    }

    let target_path = download_target_path(&local_dir, &remote_path);
    let get_command = if is_dir {
        format!("get -r {}", quote_sftp_path(&remote_path)?)
    } else {
        format!("get {}", quote_sftp_path(&remote_path)?)
    };
    run_sftp_launch_plan(
        build_sftp_launch_plan_with_target(profile, target_override),
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

fn run_sftp_commands(
    profile: &ConnectionProfile,
    target_override: &SftpTargetOverride,
    commands: Vec<String>,
    cancel_token: Option<&SftpCancelToken>,
) -> Result<String> {
    run_sftp_commands_with_progress(profile, target_override, commands, cancel_token, None)
}

fn run_sftp_commands_with_progress(
    profile: &ConnectionProfile,
    target_override: &SftpTargetOverride,
    commands: Vec<String>,
    cancel_token: Option<&SftpCancelToken>,
    progress: Option<&mut dyn FnMut(SftpProgressUpdate)>,
) -> Result<String> {
    run_sftp_launch_plan(
        build_sftp_launch_plan_with_target(profile, target_override),
        commands,
        COMMAND_TIMEOUT,
        cancel_token,
        progress,
    )
}

fn run_sftp_launch_plan(
    plan: SftpLaunchPlan,
    commands: Vec<String>,
    timeout: Duration,
    cancel_token: Option<&SftpCancelToken>,
    mut progress: Option<&mut dyn FnMut(SftpProgressUpdate)>,
) -> Result<String> {
    if is_cancelled(cancel_token) {
        bail!("SFTP task cancelled");
    }

    let mut process = spawn_pty_process(PtyCommand::new(plan.program, plan.args), 80, 24)?;
    let writer = process.writer.clone();
    let output_rx = spawn_reader_channel(process.reader);
    let line_ending = sftp_line_ending();
    let commands_payload = format!("{}{}", commands.join(line_ending), line_ending);
    let mut output = Vec::new();
    let mut prompt_window = String::new();
    let mut password_index = 0;
    let mut commands_sent = false;
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
                    &mut progress,
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
                &mut progress,
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

        if !commands_sent
            && should_send_sftp_commands(
                &normalized_prompt,
                started.elapsed(),
                last_output_at.elapsed(),
                password_index,
                plan.passwords.len(),
            )
        {
            write_to_pty(&writer, commands_payload.as_bytes())?;
            commands_sent = true;
            prompt_window.clear();
        }

        if let Some(status) = process.child.try_wait()? {
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

fn emit_sftp_progress(chunk: &[u8], progress: &mut Option<&mut dyn FnMut(SftpProgressUpdate)>) {
    let Some(callback) = progress.as_deref_mut() else {
        return;
    };
    let text = String::from_utf8_lossy(chunk);
    let Some(percent) = extract_sftp_progress_percent(&text) else {
        return;
    };
    callback(SftpProgressUpdate {
        percent: Some(percent),
        text: last_sftp_progress_line(&text),
    });
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

fn is_cancelled(cancel_token: Option<&SftpCancelToken>) -> bool {
    cancel_token
        .map(|token| token.load(Ordering::SeqCst))
        .unwrap_or(false)
}

fn should_use_gateway(profile: &ConnectionProfile) -> bool {
    matches!(profile.file_transfer_mode, FileTransferMode::SftpGateway)
        || matches!(profile.jump_mode, JumpMode::InteractiveMenu)
}

fn endpoint_destination(endpoint: &AuthEndpoint) -> String {
    format!("{}@{}", endpoint.username, endpoint.host)
}

fn proxy_jump_destination(endpoint: &AuthEndpoint) -> String {
    match endpoint.port {
        Some(port) if port != 22 => format!("{}@{}:{port}", endpoint.username, endpoint.host),
        _ => endpoint_destination(endpoint),
    }
}

fn apply_target_override(
    target: &AuthEndpoint,
    target_override: &SftpTargetOverride,
) -> AuthEndpoint {
    let mut target = target.clone();
    if let Some(host) = target_override
        .host
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
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
    target
}

fn plaintext_passwords(profile: &ConnectionProfile) -> Vec<String> {
    if should_use_gateway(profile) {
        [
            endpoint_plaintext_password(&profile.gateway),
            endpoint_plaintext_password(&profile.target),
        ]
        .into_iter()
        .flatten()
        .collect()
    } else {
        endpoint_plaintext_password(&profile.target)
            .into_iter()
            .collect()
    }
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
    let path = parse_remote_working_directory(output).unwrap_or_else(|| fallback_path.to_string());

    let entries = output
        .lines()
        .filter_map(|line| parse_ls_line(line, &path))
        .filter(|entry| entry.name != "." && entry.name != "..")
        .collect();

    Ok(SftpListResponse { path, entries })
}

fn parse_remote_working_directory(output: &str) -> Option<String> {
    output
        .lines()
        .filter_map(|line| line.strip_prefix("Remote working directory: "))
        .last()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn parse_ls_line(line: &str, current_path: &str) -> Option<SftpFileEntry> {
    let trimmed = line.trim();
    let first = trimmed.chars().next()?;
    if !matches!(first, 'd' | '-' | 'l') {
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
        .filter(|line| !line.trim().is_empty())
        .take(30)
        .collect::<Vec<_>>()
        .join("\n")
}

fn summarize_sftp_error(error: &str) -> String {
    let cleaned = clean_sftp_output(error);
    if cleaned.is_empty() {
        "SFTP 不可用：没有收到 sftp 响应，请检查堡垒机是否允许 ProxyJump/端口转发或目标机是否开放 SFTP。".into()
    } else {
        format!(
            "SFTP 不可用：{cleaned}\n可切换到终端通道传输小文件，或检查堡垒机是否允许 ProxyJump/端口转发。"
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
