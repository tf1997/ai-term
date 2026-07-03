use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::ffi::CString;
use std::os::fd::RawFd;
use std::ptr;
use std::time::{Duration, Instant};

use super::models::{AuthEndpoint, AuthMode, ConnectionProfile};
use crate::domain::terminal::ssh::output_contains_password_prompt;

const PROBE_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BastionServerCandidate {
    pub host: String,
    pub username: Option<String>,
    pub label: String,
    pub source_line: String,
}

pub fn probe_servers(profile: &ConnectionProfile) -> Result<Vec<BastionServerCandidate>> {
    let output = run_gateway_probe(profile, PROBE_TIMEOUT)?;
    Ok(parse_server_candidates(&output, profile))
}

fn run_gateway_probe(profile: &ConnectionProfile, timeout: Duration) -> Result<String> {
    let endpoint = &profile.gateway;
    let program = CString::new("ssh").context("ssh program contains an interior null byte")?;
    let args = vec![
        "-tt".to_string(),
        "-o".to_string(),
        "BatchMode=no".to_string(),
        "-o".to_string(),
        "StrictHostKeyChecking=accept-new".to_string(),
        "-o".to_string(),
        "NumberOfPasswordPrompts=1".to_string(),
        "-p".to_string(),
        endpoint.port.unwrap_or(22).to_string(),
        endpoint_destination(endpoint),
    ];

    let mut argv_strings = Vec::with_capacity(args.len() + 1);
    argv_strings.push(program.clone());
    for arg in &args {
        argv_strings.push(
            CString::new(arg.as_bytes()).context("ssh argument contains an interior null byte")?,
        );
    }
    let mut argv: Vec<*const libc::c_char> = argv_strings.iter().map(|arg| arg.as_ptr()).collect();
    argv.push(ptr::null());

    let mut master_fd = 0;
    let pid = unsafe {
        libc::forkpty(
            &mut master_fd,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
        )
    };

    if pid < 0 {
        bail!("failed to fork gateway probe");
    }

    if pid == 0 {
        unsafe {
            libc::execvp(program.as_ptr(), argv.as_ptr());
            libc::_exit(127);
        }
    }

    set_nonblocking(master_fd)?;
    let password = endpoint_plaintext_password(endpoint);
    let started = Instant::now();
    let mut output = Vec::new();
    let mut prompt_window = String::new();
    let mut password_sent = false;
    let mut host_key_confirmed = false;
    let mut newline_sent = false;

    loop {
        let mut buffer = [0_u8; 8192];
        loop {
            let count = unsafe {
                libc::read(
                    master_fd,
                    buffer.as_mut_ptr() as *mut libc::c_void,
                    buffer.len(),
                )
            };
            if count > 0 {
                let chunk = &buffer[..count as usize];
                output.extend_from_slice(chunk);
                prompt_window.push_str(&String::from_utf8_lossy(chunk));
                if prompt_window.len() > 4096 {
                    prompt_window = prompt_window
                        .chars()
                        .rev()
                        .take(4096)
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect();
                }
            } else {
                break;
            }
        }

        let normalized = prompt_window.to_lowercase();
        if !host_key_confirmed
            && normalized.contains("are you sure you want to continue connecting")
        {
            write_all(master_fd, b"yes\n")?;
            host_key_confirmed = true;
            prompt_window.clear();
        }

        if !password_sent && output_contains_password_prompt(&prompt_window) {
            let Some(secret) = password.as_ref() else {
                terminate_child(pid, master_fd);
                bail!("gateway probe requires a saved gateway password");
            };
            write_all(master_fd, format!("{secret}\n").as_bytes())?;
            password_sent = true;
            prompt_window.clear();
        }

        if !newline_sent && should_nudge_menu(&prompt_window) {
            write_all(master_fd, b"\n")?;
            newline_sent = true;
        }

        if started.elapsed() >= timeout {
            terminate_child(pid, master_fd);
            return Ok(String::from_utf8_lossy(&output).into_owned());
        }

        let mut status = 0;
        let wait_result = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        if wait_result == pid {
            unsafe {
                libc::close(master_fd);
            }
            return Ok(String::from_utf8_lossy(&output).into_owned());
        }

        std::thread::sleep(Duration::from_millis(30));
    }
}

fn should_nudge_menu(output: &str) -> bool {
    let lower = output.to_lowercase();
    lower.contains("press enter")
        || lower.contains("continue")
        || lower.contains("menu")
        || lower.contains("select")
        || lower.contains("server")
}

fn parse_server_candidates(
    output: &str,
    profile: &ConnectionProfile,
) -> Vec<BastionServerCandidate> {
    let mut candidates = Vec::new();
    for line in output.lines() {
        let clean = strip_ansi(line).trim().to_string();
        if clean.is_empty() {
            continue;
        }
        for host in extract_ipv4_candidates(&clean) {
            if is_private_or_public_host(&host)
                && !candidates
                    .iter()
                    .any(|item: &BastionServerCandidate| item.host == host)
            {
                let username = extract_username_for_host(&clean, &host)
                    .or_else(|| non_empty(profile.target.username.clone()));
                let label = clean.chars().take(96).collect::<String>();
                candidates.push(BastionServerCandidate {
                    host,
                    username,
                    label,
                    source_line: clean.clone(),
                });
            }
        }
    }
    candidates
}

fn extract_ipv4_candidates(line: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    for ch in line.chars().chain([' ']) {
        if ch.is_ascii_digit() || ch == '.' {
            current.push(ch);
            continue;
        }
        if is_ipv4(&current) {
            result.push(current.clone());
        }
        current.clear();
    }
    result
}

fn is_ipv4(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    parts.len() == 4
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.len() <= 3
                && part.chars().all(|ch| ch.is_ascii_digit())
                && part.parse::<u8>().is_ok()
        })
}

fn is_private_or_public_host(host: &str) -> bool {
    !host.starts_with("0.") && host != "255.255.255.255" && host != "127.0.0.1"
}

fn extract_username_for_host(line: &str, host: &str) -> Option<String> {
    let at_pattern = format!("@{host}");
    if let Some(index) = line.find(&at_pattern) {
        let before = &line[..index];
        let username = before
            .split(|ch: char| ch.is_whitespace() || matches!(ch, ':' | '[' | '(' | '<'))
            .next_back()
            .unwrap_or("")
            .trim_matches(|ch: char| !is_username_char(ch));
        return non_empty(username.to_string());
    }
    None
}

fn is_username_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.')
}

fn strip_ansi(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        output.push(ch);
    }
    output
}

fn endpoint_destination(endpoint: &AuthEndpoint) -> String {
    format!("{}@{}", endpoint.username, endpoint.host)
}

fn endpoint_plaintext_password(endpoint: &AuthEndpoint) -> Option<String> {
    if endpoint.auth_mode == AuthMode::Key {
        return None;
    }
    non_empty(endpoint.password.clone().unwrap_or_default())
}

fn non_empty(value: String) -> Option<String> {
    if value.trim().is_empty() {
        None
    } else {
        Some(value)
    }
}

fn set_nonblocking(fd: RawFd) -> Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        bail!("failed to read gateway probe pty flags");
    }
    let result = unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) };
    if result < 0 {
        bail!("failed to set gateway probe pty nonblocking");
    }
    Ok(())
}

fn write_all(fd: RawFd, bytes: &[u8]) -> Result<()> {
    let mut written = 0;
    while written < bytes.len() {
        let count = unsafe {
            libc::write(
                fd,
                bytes[written..].as_ptr() as *const libc::c_void,
                bytes.len() - written,
            )
        };
        if count < 0 {
            bail!("failed to write to gateway probe");
        }
        written += count as usize;
    }
    Ok(())
}

fn terminate_child(pid: libc::pid_t, fd: RawFd) {
    unsafe {
        libc::kill(pid, libc::SIGTERM);
        let mut status = 0;
        libc::waitpid(pid, &mut status, 0);
        libc::close(fd);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::connection::models::{AuthEndpoint, AuthMode, FileTransferMode, JumpMode};

    fn endpoint(host: &str, username: &str) -> AuthEndpoint {
        AuthEndpoint {
            host: host.into(),
            port: Some(22),
            username: username.into(),
            auth_mode: AuthMode::Auto,
            credential_ref: None,
            password: None,
        }
    }

    fn profile() -> ConnectionProfile {
        ConnectionProfile {
            id: "prod".into(),
            name: "prod".into(),
            gateway: endpoint("ssh.company.com", "me"),
            target: endpoint("10.1.1.1", "app"),
            jump_mode: JumpMode::InteractiveMenu,
            menu_profile_id: "default".into(),
            file_transfer_mode: FileTransferMode::Auto,
        }
    }

    #[test]
    fn parses_ip_candidates_from_menu_output() {
        let output = "1) app@10.12.8.21 prod-app\n2) 10.12.8.22 db\n";
        let candidates = parse_server_candidates(output, &profile());
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].host, "10.12.8.21");
        assert_eq!(candidates[0].username.as_deref(), Some("app"));
        assert_eq!(candidates[1].username.as_deref(), Some("app"));
    }

    #[test]
    fn ignores_non_ip_numbers() {
        assert!(extract_ipv4_candidates("1) prod 8080").is_empty());
        assert_eq!(
            extract_ipv4_candidates("host 192.168.1.5"),
            vec!["192.168.1.5"]
        );
    }
}
