use anyhow::{Context, Result};
use std::path::PathBuf;

use crate::domain::pty::{spawn_pty_process, PtyCommand, PtySession};

use super::ssh::TerminalSession;

pub struct LocalTerminalSession {
    pty: PtySession,
}

impl LocalTerminalSession {
    pub fn write(&mut self, bytes: &[u8]) -> Result<()> {
        TerminalSession::write(self, bytes)
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        TerminalSession::resize(self, cols, rows)
    }
}

impl TerminalSession for LocalTerminalSession {
    fn write(&mut self, bytes: &[u8]) -> Result<()> {
        self.pty.write(bytes)
    }

    fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        self.pty.resize(cols, rows)
    }
}

pub fn spawn_local_terminal(
    cols: u16,
    rows: u16,
    on_output: impl Fn(Vec<u8>) + Send + 'static,
    on_exit: impl FnOnce() + Send + 'static,
) -> Result<LocalTerminalSession> {
    let command = local_shell_command()?;
    let process = spawn_pty_process(command, cols, rows)?;
    let mut reader = process.reader;
    let mut child = process.child;

    std::thread::spawn(move || {
        let mut buffer = [0; 8192];
        loop {
            match std::io::Read::read(&mut reader, &mut buffer) {
                Ok(0) => break,
                Ok(count) => on_output(buffer[..count].to_vec()),
                Err(_) => break,
            }
        }
    });

    std::thread::spawn(move || {
        let _ = child.wait();
        on_exit();
    });

    Ok(LocalTerminalSession {
        pty: process.session,
    })
}

pub fn default_shell() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var_os("ComSpec")
            .map(PathBuf::from)
            .filter(|path| path.exists())
            .unwrap_or_else(|| PathBuf::from("cmd.exe"))
    }

    #[cfg(not(windows))]
    {
        std::env::var_os("SHELL")
            .map(PathBuf::from)
            .filter(|path| path.exists())
            .unwrap_or_else(|| PathBuf::from("/bin/sh"))
    }
}

fn local_shell_command() -> Result<PtyCommand> {
    let shell = default_shell();
    let program = shell
        .to_str()
        .context("shell path cannot be represented as UTF-8")?
        .to_string();

    let args = if cfg!(windows) {
        Vec::new()
    } else {
        vec!["-i".into()]
    };

    Ok(PtyCommand::new(program, args))
}
