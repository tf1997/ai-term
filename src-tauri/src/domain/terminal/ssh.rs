use anyhow::Result;
use std::thread;

use crate::domain::connection::models::{AuthEndpoint, AuthMode, ConnectionProfile, JumpMode};
use crate::domain::pty::{
    append_limited_lossy, spawn_pty_process, write_to_pty, PtyCommand, PtySession,
};

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

pub struct SshTerminalSession {
    pty: PtySession,
}

impl TerminalSession for SshTerminalSession {
    fn write(&mut self, bytes: &[u8]) -> Result<()> {
        self.pty.write(bytes)
    }

    fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        self.pty.resize(cols, rows)
    }
}

pub fn build_ssh_launch_plan(profile: &ConnectionProfile) -> SshLaunchPlan {
    let endpoint = match profile.jump_mode {
        JumpMode::Direct => &profile.target,
        JumpMode::InteractiveMenu => &profile.gateway,
    };

    SshLaunchPlan {
        program: "ssh".into(),
        args: vec![
            "-tt".into(),
            "-p".into(),
            endpoint.port.unwrap_or(22).to_string(),
            ssh_destination(endpoint),
        ],
        passwords: plaintext_passwords(profile),
    }
}

pub fn spawn_ssh_terminal(
    profile: &ConnectionProfile,
    cols: u16,
    rows: u16,
    on_output: impl Fn(Vec<u8>) + Send + 'static,
    on_exit: impl FnOnce() + Send + 'static,
) -> Result<SshTerminalSession> {
    spawn_ssh_launch_plan(
        build_ssh_launch_plan(profile),
        cols,
        rows,
        on_output,
        on_exit,
    )
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

        loop {
            match std::io::Read::read(&mut reader, &mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let output = buffer[..count].to_vec();
                    if password_index < passwords.len() {
                        append_limited_lossy(&mut prompt_window, &output, 512);

                        if output_contains_password_prompt(&prompt_window) {
                            let secret = &passwords[password_index];
                            if write_to_pty(&writer, format!("{secret}\n").as_bytes()).is_ok() {
                                password_index += 1;
                                prompt_window.clear();
                            }
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

fn ssh_destination(endpoint: &AuthEndpoint) -> String {
    format!("{}@{}", endpoint.username, endpoint.host)
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
