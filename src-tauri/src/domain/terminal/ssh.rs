use anyhow::{bail, Context, Result};
use std::ffi::CString;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::ptr;
use std::thread;

use crate::domain::connection::models::{AuthEndpoint, AuthMode, ConnectionProfile, JumpMode};

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
    writer: File,
    child_pid: libc::pid_t,
}

impl TerminalSession for SshTerminalSession {
    fn write(&mut self, bytes: &[u8]) -> Result<()> {
        self.writer.write_all(bytes)?;
        self.writer.flush()?;
        Ok(())
    }

    fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        let size = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };

        let result = unsafe { libc::ioctl(self.writer.as_raw_fd(), libc::TIOCSWINSZ, &size) };
        if result == -1 {
            bail!("failed to resize ssh terminal");
        }
        Ok(())
    }
}

impl Drop for SshTerminalSession {
    fn drop(&mut self) {
        unsafe {
            libc::kill(self.child_pid, libc::SIGHUP);
            let mut status = 0;
            libc::waitpid(self.child_pid, &mut status, libc::WNOHANG);
        }
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
    let program = CString::new(plan.program.as_bytes())
        .context("ssh program contains an interior null byte")?;
    let mut argv_strings = Vec::with_capacity(plan.args.len() + 1);
    argv_strings.push(program.clone());
    for arg in &plan.args {
        argv_strings.push(
            CString::new(arg.as_bytes()).context("ssh argument contains an interior null byte")?,
        );
    }
    let mut argv: Vec<*const libc::c_char> = argv_strings.iter().map(|arg| arg.as_ptr()).collect();
    argv.push(ptr::null());

    let mut master_fd = 0;
    let mut size = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };

    let pid = unsafe {
        libc::forkpty(
            &mut master_fd,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut size as *mut libc::winsize,
        )
    };

    if pid < 0 {
        bail!("failed to fork ssh terminal");
    }

    if pid == 0 {
        unsafe {
            libc::execvp(program.as_ptr(), argv.as_ptr());
            libc::_exit(127);
        }
    }

    let reader_fd = unsafe { libc::dup(master_fd) };
    if reader_fd < 0 {
        unsafe {
            libc::close(master_fd);
            libc::kill(pid, libc::SIGHUP);
        }
        bail!("failed to duplicate ssh terminal file descriptor");
    }

    let password_writer = if plan.passwords.is_empty() {
        None
    } else {
        let password_writer_fd = unsafe { libc::dup(master_fd) };
        if password_writer_fd < 0 {
            unsafe {
                libc::close(reader_fd);
                libc::close(master_fd);
                libc::kill(pid, libc::SIGHUP);
            }
            bail!("failed to duplicate ssh password writer file descriptor");
        }
        Some(unsafe { File::from_raw_fd(password_writer_fd) })
    };

    let passwords = plan.passwords;
    let mut reader = unsafe { File::from_raw_fd(reader_fd) };
    thread::spawn(move || {
        let mut buffer = [0; 8192];
        let mut prompt_window = String::new();
        let mut password_writer = password_writer;
        let mut password_index = 0;

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let output = buffer[..count].to_vec();
                    if password_index < passwords.len() {
                        prompt_window.push_str(&String::from_utf8_lossy(&output));
                        if prompt_window.len() > 512 {
                            prompt_window = prompt_window
                                .chars()
                                .rev()
                                .take(512)
                                .collect::<String>()
                                .chars()
                                .rev()
                                .collect();
                        }

                        if output_contains_password_prompt(&prompt_window) {
                            if let Some(writer) = password_writer.as_mut() {
                                let secret = &passwords[password_index];
                                if writer.write_all(format!("{secret}\n").as_bytes()).is_ok() {
                                    let _ = writer.flush();
                                    password_index += 1;
                                    prompt_window.clear();
                                }
                            }
                        }
                    }

                    on_output(output);
                }
                Err(_) => break,
            }
        }
        on_exit();
    });

    let writer = unsafe { File::from_raw_fd(master_fd) };
    Ok(SshTerminalSession {
        writer,
        child_pid: pid,
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
        JumpMode::InteractiveMenu => [
            endpoint_plaintext_password(&profile.gateway),
            endpoint_plaintext_password(&profile.target),
        ]
        .into_iter()
        .flatten()
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
