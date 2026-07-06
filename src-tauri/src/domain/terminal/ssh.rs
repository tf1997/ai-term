use anyhow::{anyhow, bail, Context, Result};
use ssh2::{
    Channel, CheckResult, Error as Ssh2Error, KeyboardInteractivePrompt, KnownHostFileKind, Prompt,
    Session,
};
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use std::{env, fs};

use crate::domain::connection::models::{AuthEndpoint, AuthMode, ConnectionProfile, JumpMode};
use crate::domain::pty::{
    append_limited_lossy, spawn_pty_process, write_to_pty, PtyCommand, PtySession,
};

const SSH_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const SSH_AUTH_TIMEOUT_MS: u32 = 30_000;
const SSH_IO_RETRY_DELAY: Duration = Duration::from_millis(8);
const SSH_IO_RETRY_TIMEOUT: Duration = Duration::from_secs(30);

pub trait TerminalSession: Send + Sync {
    fn write(&mut self, bytes: &[u8]) -> Result<()>;
    fn resize(&mut self, cols: u16, rows: u16) -> Result<()>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshLaunchPlan {
    pub program: String,
    pub args: Vec<String>,
    pub passwords: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SshConnectionBackend {
    SystemSsh,
    NativeDirect,
    NativeBastion,
}

pub struct SshTerminalSession {
    pty: PtySession,
}

pub struct NativeSshTerminalSession {
    channel: Channel,
    _target_session: Session,
    _gateway_session: Option<Session>,
    _forward_guard: Option<LocalForwardGuard>,
}

struct LocalForwardGuard {
    stop: Arc<AtomicBool>,
    wake_addr: SocketAddr,
}

impl Drop for LocalForwardGuard {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect_timeout(&self.wake_addr, Duration::from_millis(80));
    }
}

impl TerminalSession for SshTerminalSession {
    fn write(&mut self, bytes: &[u8]) -> Result<()> {
        self.pty.write(bytes)
    }

    fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        self.pty.resize(cols, rows)
    }
}

impl TerminalSession for NativeSshTerminalSession {
    fn write(&mut self, bytes: &[u8]) -> Result<()> {
        write_all_retry(&mut self.channel, bytes)
            .context("failed to write to native SSH shell channel")
    }

    fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        retry_ssh2(|| {
            self.channel
                .request_pty_size(cols as u32, rows as u32, None, None)
        })
        .context("failed to resize native SSH pty")
    }
}

pub fn ssh_connection_backend(profile: &ConnectionProfile) -> SshConnectionBackend {
    match profile.jump_mode {
        JumpMode::InteractiveMenu if profile.menu_profile_id.trim().is_empty() => {
            SshConnectionBackend::NativeBastion
        }
        JumpMode::InteractiveMenu => SshConnectionBackend::SystemSsh,
        JumpMode::Direct => SshConnectionBackend::NativeDirect,
    }
}

pub fn app_known_hosts_ssh_args() -> Vec<String> {
    let mut args = vec![
        "-o".to_string(),
        "StrictHostKeyChecking=accept-new".to_string(),
    ];
    if let Some(path) = app_known_hosts_path() {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        args.push("-o".to_string());
        args.push(format!("UserKnownHostsFile={}", path.to_string_lossy()));
    }
    args
}

pub fn build_ssh_launch_plan(profile: &ConnectionProfile) -> SshLaunchPlan {
    let endpoint = match profile.jump_mode {
        JumpMode::Direct => &profile.target,
        JumpMode::InteractiveMenu => &profile.gateway,
    };

    SshLaunchPlan {
        program: "ssh".into(),
        args: {
            let mut args = vec!["-tt".into()];
            args.extend(app_known_hosts_ssh_args());
            args.extend([
                "-p".into(),
                endpoint.port.unwrap_or(22).to_string(),
                ssh_destination(endpoint),
            ]);
            args
        },
        passwords: plaintext_passwords(profile),
    }
}

pub fn spawn_ssh_terminal(
    profile: &ConnectionProfile,
    cols: u16,
    rows: u16,
    on_output: impl Fn(Vec<u8>) + Send + 'static,
    on_exit: impl FnOnce() + Send + 'static,
) -> Result<Box<dyn TerminalSession>> {
    match ssh_connection_backend(profile) {
        SshConnectionBackend::NativeDirect => match connect_endpoint(&profile.target)
            .with_context(|| format!("failed to connect {}", endpoint_label(&profile.target)))
        {
            Ok(target) => start_native_shell(target, None, None, cols, rows, on_output, on_exit)
                .map(|session| Box::new(session) as Box<dyn TerminalSession>),
            Err(error) if should_fallback_native_direct_error(&error) => {
                on_output(native_direct_fallback_notice(&error).into_bytes());
                spawn_ssh_launch_plan(
                    build_ssh_launch_plan(profile),
                    cols,
                    rows,
                    on_output,
                    on_exit,
                )
                .map(|session| Box::new(session) as Box<dyn TerminalSession>)
            }
            Err(error) => Err(error),
        },
        SshConnectionBackend::NativeBastion => {
            spawn_native_bastion_terminal(profile, cols, rows, on_output, on_exit)
                .map(|session| Box::new(session) as Box<dyn TerminalSession>)
        }
        SshConnectionBackend::SystemSsh => spawn_ssh_launch_plan(
            build_ssh_launch_plan(profile),
            cols,
            rows,
            on_output,
            on_exit,
        )
        .map(|session| Box::new(session) as Box<dyn TerminalSession>),
    }
}

pub fn should_fallback_native_direct_error(error: &anyhow::Error) -> bool {
    let message = format!("{error:#}").to_ascii_lowercase();
    (message.contains("failed to connect") || message.contains("ssh handshake failed"))
        && !message.contains("authentication")
        && !message.contains("known_hosts")
        && !message.contains("host key")
}

fn native_direct_fallback_notice(error: &anyhow::Error) -> String {
    format!(
        "\r\nAI Term native SSH failed before authentication; falling back to system ssh.\r\nReason: {error:#}\r\n\r\n"
    )
}

fn spawn_native_bastion_terminal(
    profile: &ConnectionProfile,
    cols: u16,
    rows: u16,
    on_output: impl Fn(Vec<u8>) + Send + 'static,
    on_exit: impl FnOnce() + Send + 'static,
) -> Result<NativeSshTerminalSession> {
    let gateway = connect_endpoint(&profile.gateway).with_context(|| {
        format!(
            "failed to connect bastion {}",
            endpoint_label(&profile.gateway)
        )
    })?;
    gateway.set_blocking(false);

    let target_port = profile.target.port.unwrap_or(22);
    let forward_guard =
        start_local_forward(gateway.clone(), profile.target.host.clone(), target_port)
            .with_context(|| {
                format!(
                    "failed to open bastion forwarding from {} to {}:{}",
                    endpoint_label(&profile.gateway),
                    profile.target.host,
                    target_port
                )
            })?;

    let target = connect_endpoint_via(
        &profile.target,
        forward_guard.wake_addr.ip().to_string(),
        forward_guard.wake_addr.port(),
    )
    .with_context(|| {
        format!(
            "failed to connect target through bastion {}",
            endpoint_label(&profile.target)
        )
    })?;

    start_native_shell(
        target,
        Some(gateway),
        Some(forward_guard),
        cols,
        rows,
        on_output,
        on_exit,
    )
}

fn start_native_shell(
    target: Session,
    gateway: Option<Session>,
    forward_guard: Option<LocalForwardGuard>,
    cols: u16,
    rows: u16,
    on_output: impl Fn(Vec<u8>) + Send + 'static,
    on_exit: impl FnOnce() + Send + 'static,
) -> Result<NativeSshTerminalSession> {
    let mut channel = target
        .channel_session()
        .context("failed to create native SSH shell channel")?;
    channel
        .request_pty(
            "xterm-256color",
            None,
            Some((cols as u32, rows as u32, 0, 0)),
        )
        .context("failed to request native SSH pty")?;
    channel
        .shell()
        .context("failed to start native SSH shell")?;
    target.set_blocking(false);

    let mut reader = channel.clone();
    thread::spawn(move || {
        let mut buffer = [0; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => on_output(buffer[..count].to_vec()),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(SSH_IO_RETRY_DELAY);
                }
                Err(_) => break,
            }
        }
        on_exit();
    });

    Ok(NativeSshTerminalSession {
        channel,
        _target_session: target,
        _gateway_session: gateway,
        _forward_guard: forward_guard,
    })
}

fn spawn_ssh_launch_plan(
    plan: SshLaunchPlan,
    cols: u16,
    rows: u16,
    on_output: impl Fn(Vec<u8>) + Send + 'static,
    on_exit: impl FnOnce() + Send + 'static,
) -> Result<SshTerminalSession> {
    let process = spawn_pty_process(PtyCommand::new(plan.program, plan.args), cols, rows)?;
    let writer = process.writer.clone();
    let mut reader = process.reader;
    let mut child = process.child;
    let passwords = plan.passwords;

    thread::spawn(move || {
        let mut buffer = [0; 8192];
        let mut prompt_window = String::new();
        let mut password_index = 0;
        let mut host_key_hint_sent = false;
        let mut missing_password_hint_sent = false;
        let mut saved_password_hint_sent = false;
        let mut rejected_password_hint_sent = false;

        loop {
            match std::io::Read::read(&mut reader, &mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let output = buffer[..count].to_vec();
                    append_limited_lossy(&mut prompt_window, &output, 4096);

                    if !host_key_hint_sent && output_contains_host_key_warning(&prompt_window) {
                        on_output(host_key_warning_hint(&prompt_window).into_bytes());
                        host_key_hint_sent = true;
                    }

                    if output_contains_password_prompt(&prompt_window) {
                        if password_index < passwords.len() {
                            if !saved_password_hint_sent {
                                on_output(
                                    password_prompt_hint(passwords.len(), password_index)
                                        .as_bytes()
                                        .to_vec(),
                                );
                                saved_password_hint_sent = true;
                            }
                            let secret = &passwords[password_index];
                            if write_to_pty(&writer, format!("{secret}\n").as_bytes()).is_ok() {
                                password_index += 1;
                                prompt_window.clear();
                            }
                        } else if passwords.is_empty() && !missing_password_hint_sent {
                            on_output(
                                password_prompt_hint(passwords.len(), password_index)
                                    .as_bytes()
                                    .to_vec(),
                            );
                            missing_password_hint_sent = true;
                        } else if !passwords.is_empty() && !rejected_password_hint_sent {
                            on_output(
                                password_prompt_hint(passwords.len(), password_index)
                                    .as_bytes()
                                    .to_vec(),
                            );
                            rejected_password_hint_sent = true;
                        }
                    }

                    on_output(output);
                }
                Err(_) => break,
            }
        }
    });

    thread::spawn(move || {
        let _ = child.wait();
        on_exit();
    });

    Ok(SshTerminalSession {
        pty: process.session,
    })
}

fn connect_endpoint(endpoint: &AuthEndpoint) -> Result<Session> {
    connect_endpoint_via(endpoint, endpoint.host.clone(), endpoint.port.unwrap_or(22))
}

fn connect_endpoint_via(endpoint: &AuthEndpoint, host: String, port: u16) -> Result<Session> {
    let stream = connect_tcp(&host, port)?;
    let mut session = Session::new().context("failed to create SSH session")?;
    session.set_timeout(SSH_AUTH_TIMEOUT_MS);
    session.set_tcp_stream(stream);
    session.handshake().context("SSH handshake failed")?;
    verify_known_host(&session, endpoint)?;
    authenticate_endpoint(&session, endpoint)?;
    if !session.authenticated() {
        bail!("SSH authentication failed for {}", endpoint_label(endpoint));
    }
    Ok(session)
}

fn connect_tcp(host: &str, port: u16) -> Result<TcpStream> {
    let addrs = (host, port)
        .to_socket_addrs()
        .with_context(|| format!("failed to resolve {host}:{port}"))?
        .collect::<Vec<_>>();
    let mut last_error = None;
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, SSH_CONNECT_TIMEOUT) {
            Ok(stream) => {
                let _ = stream.set_nodelay(true);
                return Ok(stream);
            }
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error
        .map(anyhow::Error::from)
        .unwrap_or_else(|| anyhow!("no address resolved for {host}:{port}")))
    .with_context(|| format!("failed to connect {host}:{port}"))
}

fn verify_known_host(session: &Session, endpoint: &AuthEndpoint) -> Result<()> {
    let (key, key_type) = session.host_key().ok_or_else(|| {
        anyhow!(
            "SSH host key is not available for {}",
            endpoint_label(endpoint)
        )
    })?;
    let host = endpoint.host.trim();
    let port = endpoint.port.unwrap_or(22);
    let path = app_known_hosts_path()
        .ok_or_else(|| anyhow!("failed to resolve AI Term known_hosts path"))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "failed to create known_hosts directory {}",
                parent.display()
            )
        })?;
    }

    let mut known_hosts = session
        .known_hosts()
        .context("failed to load known_hosts handle")?;
    if path.exists() {
        known_hosts
            .read_file(&path, KnownHostFileKind::OpenSSH)
            .with_context(|| format!("failed to read known_hosts {}", path.display()))?;
    }

    match check_known_host(&known_hosts, host, port, key) {
        CheckResult::Match => Ok(()),
        CheckResult::NotFound => {
            known_hosts
                .add(
                    &known_host_entry_name(host, port),
                    key,
                    "ai-term",
                    key_type.into(),
                )
                .with_context(|| {
                    format!("failed to add host key for {}", endpoint_label(endpoint))
                })?;
            known_hosts
                .write_file(&path, KnownHostFileKind::OpenSSH)
                .with_context(|| format!("failed to write known_hosts {}", path.display()))?;
            Ok(())
        }
        CheckResult::Mismatch => bail!(
            "{}",
            native_host_key_warning_hint(endpoint, &path, host_key_sha256_fingerprint(&session))
        ),
        CheckResult::Failure => bail!(
            "SSH host key verification failed: unable to check known_hosts for {}",
            endpoint_label(endpoint)
        ),
    }
}

fn check_known_host(
    known_hosts: &ssh2::KnownHosts,
    host: &str,
    port: u16,
    key: &[u8],
) -> CheckResult {
    if port == 22 {
        known_hosts.check(host, key)
    } else {
        known_hosts.check_port(host, port, key)
    }
}

fn known_host_entry_name(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    }
}

fn native_host_key_warning_hint(
    endpoint: &AuthEndpoint,
    path: &std::path::Path,
    fingerprint: Option<String>,
) -> String {
    let fingerprint = fingerprint
        .map(|value| format!("\nNew fingerprint: {value}"))
        .unwrap_or_default();
    format!(
        "SSH host key verification failed: the host key for {} does not match AI Term known_hosts.{fingerprint}\nKnown hosts: {}\nConfirm the new fingerprint with an administrator before removing the old entry and reconnecting.",
        endpoint_label(endpoint),
        path.display()
    )
}

fn host_key_sha256_fingerprint(session: &Session) -> Option<String> {
    session.host_key_hash(ssh2::HashType::Sha256).map(|bytes| {
        let hex = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        format!("SHA256(hex): {hex}")
    })
}

pub fn remove_ai_term_known_host(host: &str, port: u16) -> Result<usize> {
    let host = host.trim();
    if host.is_empty() {
        bail!("SSH host is empty");
    }

    let path = app_known_hosts_path()
        .ok_or_else(|| anyhow!("failed to resolve AI Term known_hosts path"))?;
    if !path.exists() {
        return Ok(0);
    }

    let original = fs::read_to_string(&path)
        .with_context(|| format!("failed to read known_hosts {}", path.display()))?;
    let mut removed = 0;
    let mut kept = Vec::new();
    for line in original.lines() {
        if known_hosts_line_matches_endpoint(line, host, port) {
            removed += 1;
        } else {
            kept.push(line);
        }
    }

    if removed > 0 {
        let mut next = kept.join("\n");
        if !next.is_empty() && original.ends_with('\n') {
            next.push('\n');
        }
        fs::write(&path, next)
            .with_context(|| format!("failed to write known_hosts {}", path.display()))?;
    }

    Ok(removed)
}

pub fn known_hosts_line_matches_endpoint(line: &str, host: &str, port: u16) -> bool {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return false;
    }
    let Some(hosts) = line.split_whitespace().next() else {
        return false;
    };
    let host = host.trim();
    known_host_aliases(host, port).iter().any(|alias| {
        hosts
            .split(',')
            .any(|entry| entry.trim().eq_ignore_ascii_case(alias))
    })
}

fn known_host_aliases(host: &str, port: u16) -> Vec<String> {
    let mut aliases = vec![known_host_entry_name(host, port)];
    if port == 22 {
        aliases.push(format!("[{host}]:22"));
    } else {
        aliases.push(host.to_string());
    }
    aliases
}

fn authenticate_endpoint(session: &Session, endpoint: &AuthEndpoint) -> Result<()> {
    let username = endpoint.username.trim();
    if username.is_empty() {
        bail!("SSH username is empty for {}", endpoint.host);
    }

    let password = endpoint_plaintext_password(endpoint);
    let mut errors = Vec::new();

    if inspect_auth_methods(session, username, &mut errors) {
        return Ok(());
    }

    match endpoint.auth_mode {
        AuthMode::Auto => {
            if password.is_some()
                && try_password_auth(session, username, password.as_deref(), &mut errors)
            {
                return Ok(());
            }
            if try_agent_auth(session, username, &mut errors) {
                return Ok(());
            }
            if try_public_key_files(
                session,
                endpoint,
                username,
                password.as_deref(),
                true,
                &mut errors,
            ) {
                return Ok(());
            }
            if password.is_none()
                && try_password_auth(session, username, password.as_deref(), &mut errors)
            {
                return Ok(());
            }
        }
        AuthMode::Password => {
            if try_password_auth(session, username, password.as_deref(), &mut errors) {
                return Ok(());
            }
            if try_agent_auth(session, username, &mut errors) {
                return Ok(());
            }
            if try_public_key_files(
                session,
                endpoint,
                username,
                password.as_deref(),
                true,
                &mut errors,
            ) {
                return Ok(());
            }
        }
        AuthMode::Key => {
            if try_public_key_files(session, endpoint, username, None, true, &mut errors) {
                return Ok(());
            }
            if try_agent_auth(session, username, &mut errors) {
                return Ok(());
            }
        }
    }

    if errors.is_empty() {
        bail!("SSH 认证失败：{}", endpoint_label(endpoint));
    }
    bail!(
        "SSH 认证失败：{}。已探测服务端认证方式，并尝试 ssh-agent、本机默认私钥以及已保存密码（如有）。请确认认证方式，或保存该端点实际需要的密码/密钥。({})",
        endpoint_label(endpoint),
        errors.join("; ")
    )
}

fn inspect_auth_methods(session: &Session, username: &str, errors: &mut Vec<String>) -> bool {
    match session.auth_methods(username) {
        Ok(methods) if session.authenticated() => {
            if !methods.is_empty() {
                errors.push(format!("server auth methods: {methods}"));
            }
            true
        }
        Ok(methods) => {
            if !methods.is_empty() {
                errors.push(format!("server auth methods: {methods}"));
            }
            false
        }
        Err(error) if session.authenticated() => {
            errors.push(format!("auth methods probe: {error}"));
            true
        }
        Err(error) => {
            errors.push(format!("auth methods probe: {error}"));
            false
        }
    }
}
fn try_agent_auth(session: &Session, username: &str, errors: &mut Vec<String>) -> bool {
    match session.userauth_agent(username) {
        Ok(()) if session.authenticated() => true,
        Ok(()) => false,
        Err(error) => {
            errors.push(format!("ssh-agent: {error}"));
            false
        }
    }
}

fn try_password_auth(
    session: &Session,
    username: &str,
    password: Option<&str>,
    errors: &mut Vec<String>,
) -> bool {
    let Some(secret) = password else {
        errors.push("password: no saved password".to_string());
        return false;
    };

    match session.userauth_password(username, secret) {
        Ok(()) if session.authenticated() => return true,
        Ok(()) => {}
        Err(error) => errors.push(format!("password: {error}")),
    }

    let mut prompter = StaticPasswordPrompter {
        password: secret.to_string(),
    };
    match session.userauth_keyboard_interactive(username, &mut prompter) {
        Ok(()) if session.authenticated() => true,
        Ok(()) => false,
        Err(error) => {
            errors.push(format!("keyboard-interactive: {error}"));
            false
        }
    }
}

fn try_public_key_files(
    session: &Session,
    endpoint: &AuthEndpoint,
    username: &str,
    password: Option<&str>,
    include_defaults: bool,
    errors: &mut Vec<String>,
) -> bool {
    let candidates = private_key_candidates(endpoint, include_defaults);
    if candidates.is_empty() {
        errors.push("publickey: no private key candidates".to_string());
        return false;
    }

    for candidate in candidates {
        if !candidate.path.is_file() {
            if candidate.explicit {
                errors.push(format!(
                    "publickey {}: key file not found",
                    candidate.path.display()
                ));
            }
            continue;
        }

        if let Some(secret) = password {
            match session.userauth_pubkey_file(username, None, &candidate.path, Some(secret)) {
                Ok(()) if session.authenticated() => return true,
                Ok(()) => {}
                Err(error) => errors.push(format!(
                    "publickey {} with passphrase: {error}",
                    candidate.path.display()
                )),
            }
        }

        match session.userauth_pubkey_file(username, None, &candidate.path, None) {
            Ok(()) if session.authenticated() => return true,
            Ok(()) => {}
            Err(error) => errors.push(format!("publickey {}: {error}", candidate.path.display())),
        }
    }

    false
}

struct PrivateKeyCandidate {
    path: PathBuf,
    explicit: bool,
}

fn private_key_candidates(
    endpoint: &AuthEndpoint,
    include_defaults: bool,
) -> Vec<PrivateKeyCandidate> {
    let mut candidates = Vec::new();

    if let Some(value) = endpoint
        .credential_ref
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        push_unique_key_candidate(&mut candidates, expand_home_path(value), true);
    }

    if include_defaults {
        if let Some(ssh_dir) = ssh_directory() {
            for name in [
                "ai-term-ed25519",
                "id_ed25519",
                "id_ecdsa",
                "id_rsa",
                "id_dsa",
            ] {
                push_unique_key_candidate(&mut candidates, ssh_dir.join(name), false);
            }
        }
    }

    candidates
}

fn push_unique_key_candidate(
    candidates: &mut Vec<PrivateKeyCandidate>,
    path: PathBuf,
    explicit: bool,
) {
    if candidates.iter().any(|candidate| candidate.path == path) {
        return;
    }
    candidates.push(PrivateKeyCandidate { path, explicit });
}

fn expand_home_path(value: &str) -> PathBuf {
    let trimmed = value.trim();
    if trimmed == "~" {
        return home_directory().unwrap_or_else(|| PathBuf::from(trimmed));
    }
    if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        if let Some(home) = home_directory() {
            return home.join(rest);
        }
    }
    PathBuf::from(trimmed)
}

fn ssh_directory() -> Option<PathBuf> {
    home_directory().map(|home| home.join(".ssh"))
}

fn app_known_hosts_path() -> Option<PathBuf> {
    ssh_directory().map(|directory| directory.join("ai-term_known_hosts"))
}

fn home_directory() -> Option<PathBuf> {
    env_path("HOME").or_else(|| env_path("USERPROFILE"))
}

fn env_path(name: &str) -> Option<PathBuf> {
    let value = env::var_os(name)?;
    if value.to_string_lossy().trim().is_empty() {
        return None;
    }
    Some(PathBuf::from(value))
}

struct StaticPasswordPrompter {
    password: String,
}

impl KeyboardInteractivePrompt for StaticPasswordPrompter {
    fn prompt<'a>(
        &mut self,
        _username: &str,
        _instructions: &str,
        prompts: &[Prompt<'a>],
    ) -> Vec<String> {
        prompts.iter().map(|_| self.password.clone()).collect()
    }
}

fn start_local_forward(
    gateway: Session,
    target_host: String,
    target_port: u16,
) -> Result<LocalForwardGuard> {
    let listener =
        TcpListener::bind(("127.0.0.1", 0)).context("failed to bind local forwarding socket")?;
    let wake_addr = listener.local_addr()?;
    listener.set_nonblocking(true)?;
    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_thread = stop.clone();

    thread::spawn(move || {
        while !stop_for_thread.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let _ = handle_forward_connection(
                        &gateway,
                        stream,
                        &target_host,
                        target_port,
                        &stop_for_thread,
                    );
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(SSH_IO_RETRY_DELAY);
                }
                Err(_) => break,
            }
        }
    });

    Ok(LocalForwardGuard { stop, wake_addr })
}

fn handle_forward_connection(
    gateway: &Session,
    mut local: TcpStream,
    target_host: &str,
    target_port: u16,
    stop: &AtomicBool,
) -> Result<()> {
    local.set_nonblocking(true)?;
    let mut remote = retry_ssh2(|| gateway.channel_direct_tcpip(target_host, target_port, None))
        .with_context(|| {
            format!("bastion cannot open direct-tcpip to {target_host}:{target_port}")
        })?;
    pump_forward(&mut local, &mut remote, stop)
}

fn pump_forward(local: &mut TcpStream, remote: &mut Channel, stop: &AtomicBool) -> Result<()> {
    let mut local_buffer = [0; 16 * 1024];
    let mut remote_buffer = [0; 16 * 1024];

    while !stop.load(Ordering::SeqCst) {
        let mut progressed = false;

        match local.read(&mut local_buffer) {
            Ok(0) => break,
            Ok(count) => {
                write_all_retry(remote, &local_buffer[..count])?;
                progressed = true;
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(error.into()),
        }

        match remote.read(&mut remote_buffer) {
            Ok(0) => break,
            Ok(count) => {
                write_all_retry(local, &remote_buffer[..count])?;
                progressed = true;
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(error.into()),
        }

        if !progressed {
            thread::sleep(SSH_IO_RETRY_DELAY);
        }
    }

    let _ = local.shutdown(std::net::Shutdown::Both);
    Ok(())
}

fn write_all_retry<W: Write>(writer: &mut W, mut bytes: &[u8]) -> Result<()> {
    let started = Instant::now();
    while !bytes.is_empty() {
        match writer.write(bytes) {
            Ok(0) => bail!("SSH channel closed while writing"),
            Ok(count) => {
                bytes = &bytes[count..];
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                if started.elapsed() > SSH_IO_RETRY_TIMEOUT {
                    return Err(error).context("timed out while writing SSH data");
                }
                thread::sleep(SSH_IO_RETRY_DELAY);
            }
            Err(error) => return Err(error.into()),
        }
    }
    writer.flush()?;
    Ok(())
}

fn retry_ssh2<T>(mut operation: impl FnMut() -> std::result::Result<T, Ssh2Error>) -> Result<T> {
    let started = Instant::now();
    loop {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) => {
                let io_error = io::Error::from(error);
                if io_error.kind() == io::ErrorKind::WouldBlock {
                    if started.elapsed() > SSH_IO_RETRY_TIMEOUT {
                        return Err(io_error).context("timed out while waiting for SSH operation");
                    }
                    thread::sleep(SSH_IO_RETRY_DELAY);
                    continue;
                }
                return Err(io_error.into());
            }
        }
    }
}

fn ssh_destination(endpoint: &AuthEndpoint) -> String {
    format!("{}@{}", endpoint.username, endpoint.host)
}

fn endpoint_label(endpoint: &AuthEndpoint) -> String {
    format!(
        "{}@{}:{}",
        endpoint.username,
        endpoint.host,
        endpoint.port.unwrap_or(22)
    )
}

fn plaintext_passwords(profile: &ConnectionProfile) -> Vec<String> {
    match profile.jump_mode {
        JumpMode::Direct => endpoint_plaintext_password(&profile.target)
            .into_iter()
            .collect(),
        JumpMode::InteractiveMenu => endpoint_plaintext_password(&profile.gateway)
            .into_iter()
            .collect(),
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

pub fn output_contains_password_prompt(output: &str) -> bool {
    let normalized = output.to_lowercase();
    normalized.contains("password:")
        || normalized.contains("password for ")
        || normalized.contains("'s password")
}

pub fn password_prompt_hint(
    saved_password_count: usize,
    used_password_count: usize,
) -> &'static str {
    if saved_password_count == 0 {
        "\r\n[AI Term] 当前连接没有保存密码；OpenSSH 不会记住上次手动输入的登录密码。可在连接编辑里保存目标密码，或配置 SSH key/agent 免密登录。\r\n"
    } else if used_password_count >= saved_password_count {
        "\r\n[AI Term] 已保存密码没有通过认证，远端仍在请求密码。请检查连接配置里的目标密码，或改用 SSH key/agent。\r\n"
    } else {
        "\r\n[AI Term] 检测到密码提示，正在使用已保存密码自动登录。\r\n"
    }
}

pub fn output_contains_host_key_warning(output: &str) -> bool {
    let normalized = output.to_lowercase();
    normalized.contains("remote host identification has changed")
        || normalized.contains("possible dns spoofing detected")
        || normalized.contains("host key verification failed")
        || normalized.contains("offending") && normalized.contains("known_hosts")
}

pub fn host_key_warning_hint(output: &str) -> String {
    let known_hosts = extract_known_hosts_location(output)
        .map(|location| format!("\n本机记录位置：{location}"))
        .unwrap_or_default();
    let fingerprint = extract_host_key_fingerprint(output)
        .map(|value| format!("\n远端新指纹：{value}"))
        .unwrap_or_default();

    format!(
        "\r\n\r\n[AI Term] SSH 主机密钥校验失败。堡垒机或目标机的 host key 与本机 known_hosts 旧记录不一致，OpenSSH 已阻止连接。\n这可能是服务器重装/地址复用导致，也可能是中间人攻击；请先向管理员确认新指纹可信。{fingerprint}{known_hosts}\n确认可信后，可删除对应 known_hosts 条目再重连。不要在未确认时关闭 StrictHostKeyChecking。\r\n"
    )
}

fn extract_known_hosts_location(output: &str) -> Option<String> {
    for line in output.lines() {
        let lower = line.to_lowercase();
        let Some(index) = lower.find("known_hosts") else {
            continue;
        };
        let start = line[..index]
            .rfind(|ch: char| ch.is_whitespace())
            .map(|value| value + 1)
            .unwrap_or(0);
        let mut value = line[start..]
            .trim()
            .trim_matches(['.', ',', ';'])
            .to_string();
        if !value.is_empty() && !value.contains(':') && index + "known_hosts".len() <= line.len() {
            value = line[start..index + "known_hosts".len()].trim().to_string();
        }
        if !value.is_empty() {
            return Some(value);
        }
    }
    None
}

fn extract_host_key_fingerprint(output: &str) -> Option<String> {
    for line in output.lines() {
        if let Some(index) = line.find("SHA256:") {
            let value = line[index..]
                .split_whitespace()
                .next()
                .unwrap_or("")
                .trim_matches(['.', ',', ';'])
                .to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

#[derive(Debug, Default)]
pub struct PendingSshSession {
    pub written: Vec<u8>,
    pub size: Option<(u16, u16)>,
}

impl TerminalSession for PendingSshSession {
    fn write(&mut self, bytes: &[u8]) -> Result<()> {
        self.written.extend_from_slice(bytes);
        Ok(())
    }

    fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        self.size = Some((cols, rows));
        Ok(())
    }
}
