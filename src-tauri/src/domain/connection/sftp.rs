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
};
use crate::domain::terminal::ssh::output_contains_password_prompt;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(90);
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(600);
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

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
    let mut args = vec![
        "-o".into(),
        "BatchMode=no".into(),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
        "-o".into(),
        "NumberOfPasswordPrompts=2".into(),
    ];

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
    Ok(SftpTransferResponse {
        message: format!("created {remote_path}"),
    })
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
    Ok(SftpTransferResponse {
        message: format!("deleted {remote_path}"),
    })
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
    let local_path = expand_tilde(local_path);
    if !Path::new(&local_path).is_file() {
        bail!("local file does not exist: {local_path}");
    }
    let remote_dir = normalize_remote_path(remote_dir);
    run_sftp_commands(
        profile,
        target_override,
        vec![
            format!("cd {}", quote_sftp_path(&remote_dir)?),
            format!("put {}", quote_sftp_path(&local_path)?),
            "bye".into(),
        ],
        cancel_token,
    )?;
    Ok(SftpTransferResponse {
        message: format!("uploaded {local_path} to {remote_dir}"),
    })
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
    let local_path = expand_tilde(local_path);
    let local = Path::new(&local_path);
    if !local.exists() {
        bail!("local path does not exist: {local_path}");
    }

    let remote_dir = normalize_remote_path(remote_dir);
    let put_command = if local.is_dir() {
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
    )?;

    Ok(SftpTransferResponse {
        message: format!("uploaded {local_path} to {remote_dir}"),
    })
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
    let remote_path = normalize_remote_path(remote_path);
    let local_path = expand_tilde(local_path);
    run_sftp_commands(
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
        cancel_token,
    )?;
    Ok(SftpTransferResponse {
        message: format!("downloaded {remote_path} to {local_path}"),
    })
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
    let remote_path = normalize_remote_path(remote_path);
    let local_dir = expand_tilde(local_dir);
    let local = Path::new(&local_dir);
    std::fs::create_dir_all(local)
        .with_context(|| format!("failed to create local directory: {local_dir}"))?;
    if !local.is_dir() {
        bail!("local path is not a directory: {local_dir}");
    }

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
    )?;

    Ok(SftpTransferResponse {
        message: format!("downloaded {remote_path} to {local_dir}"),
    })
}

fn run_sftp_commands(
    profile: &ConnectionProfile,
    target_override: &SftpTargetOverride,
    commands: Vec<String>,
    cancel_token: Option<&SftpCancelToken>,
) -> Result<String> {
    run_sftp_launch_plan(
        build_sftp_launch_plan_with_target(profile, target_override),
        commands,
        COMMAND_TIMEOUT,
        cancel_token,
    )
}

fn run_sftp_launch_plan(
    plan: SftpLaunchPlan,
    commands: Vec<String>,
    timeout: Duration,
    cancel_token: Option<&SftpCancelToken>,
) -> Result<String> {
    if is_cancelled(cancel_token) {
        bail!("SFTP task cancelled");
    }

    let mut process = spawn_pty_process(PtyCommand::new(plan.program, plan.args), 80, 24)?;
    let writer = process.writer.clone();
    let output_rx = spawn_reader_channel(process.reader);
    let commands_payload = format!("{}\n", commands.join("\n"));
    let mut output = Vec::new();
    let mut prompt_window = String::new();
    let mut password_index = 0;
    let mut commands_sent = false;
    let mut host_key_confirmed = false;
    let started = Instant::now();

    loop {
        if is_cancelled(cancel_token) {
            process.session.kill();
            let _ = process.child.wait();
            bail!("SFTP task cancelled");
        }

        match output_rx.recv_timeout(Duration::from_millis(20)) {
            Ok(chunk) => {
                output.extend_from_slice(&chunk);
                append_limited_lossy(&mut prompt_window, &chunk, 2048);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {}
        }

        while let Ok(chunk) = output_rx.try_recv() {
            output.extend_from_slice(&chunk);
            append_limited_lossy(&mut prompt_window, &chunk, 2048);
        }

        let normalized_prompt = prompt_window.to_lowercase();
        if !host_key_confirmed
            && normalized_prompt.contains("are you sure you want to continue connecting")
        {
            write_to_pty(&writer, b"yes\n")?;
            host_key_confirmed = true;
            prompt_window.clear();
        }

        if output_contains_password_prompt(&prompt_window) {
            if password_index >= plan.passwords.len() {
                process.session.kill();
                let _ = process.child.wait();
                let text = String::from_utf8_lossy(&output).into_owned();
                bail!(
                    "SFTP requires a password/passphrase, but no plaintext password is saved for this profile\n{}",
                    clean_sftp_output(&text)
                );
            }

            let secret = format!("{}\n", plan.passwords[password_index]);
            write_to_pty(&writer, secret.as_bytes())?;
            password_index += 1;
            prompt_window.clear();
        }

        if !commands_sent && normalized_prompt.contains("sftp>") {
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
            process.session.kill();
            let _ = process.child.wait();
            let text = String::from_utf8_lossy(&output).into_owned();
            bail!("SFTP command timed out\n{}", clean_sftp_output(&text));
        }
    }
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
}
