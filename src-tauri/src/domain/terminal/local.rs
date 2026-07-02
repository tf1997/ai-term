use anyhow::{bail, Context, Result};
use std::ffi::CString;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::path::PathBuf;
use std::ptr;
use std::thread;

use super::ssh::TerminalSession;

pub struct LocalTerminalSession {
    writer: File,
    child_pid: libc::pid_t,
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
            bail!("failed to resize local terminal");
        }
        Ok(())
    }
}

impl Drop for LocalTerminalSession {
    fn drop(&mut self) {
        unsafe {
            libc::kill(self.child_pid, libc::SIGHUP);
            let mut status = 0;
            libc::waitpid(self.child_pid, &mut status, libc::WNOHANG);
        }
    }
}

pub fn spawn_local_terminal(
    cols: u16,
    rows: u16,
    on_output: impl Fn(Vec<u8>) + Send + 'static,
    on_exit: impl FnOnce() + Send + 'static,
) -> Result<LocalTerminalSession> {
    let shell = default_shell();
    let shell_c = CString::new(shell.to_string_lossy().as_bytes())
        .context("shell path contains an interior null byte")?;
    let interactive_arg = CString::new("-i").unwrap();

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
        bail!("failed to fork local terminal");
    }

    if pid == 0 {
        unsafe {
            libc::execl(
                shell_c.as_ptr(),
                shell_c.as_ptr(),
                interactive_arg.as_ptr(),
                ptr::null::<libc::c_char>(),
            );
            libc::_exit(127);
        }
    }

    let reader_fd = unsafe { libc::dup(master_fd) };
    if reader_fd < 0 {
        unsafe {
            libc::close(master_fd);
            libc::kill(pid, libc::SIGHUP);
        }
        bail!("failed to duplicate local terminal file descriptor");
    }

    let mut reader = unsafe { File::from_raw_fd(reader_fd) };
    thread::spawn(move || {
        let mut buffer = [0; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => on_output(buffer[..count].to_vec()),
                Err(_) => break,
            }
        }
        on_exit();
    });

    let writer = unsafe { File::from_raw_fd(master_fd) };
    Ok(LocalTerminalSession {
        writer,
        child_pid: pid,
    })
}

pub fn default_shell() -> PathBuf {
    std::env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|path| path.exists())
        .unwrap_or_else(|| PathBuf::from("/bin/sh"))
}
