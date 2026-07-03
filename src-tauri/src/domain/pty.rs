use anyhow::{Context, Result};
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;

pub type SharedPtyWriter = Arc<Mutex<Box<dyn Write + Send>>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PtyCommand {
    pub program: String,
    pub args: Vec<String>,
}

impl PtyCommand {
    pub fn new(program: impl Into<String>, args: Vec<String>) -> Self {
        Self {
            program: program.into(),
            args,
        }
    }

    fn builder(&self) -> CommandBuilder {
        let mut command = CommandBuilder::new(&self.program);
        command.args(&self.args);
        command
    }
}

pub struct PtySession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: SharedPtyWriter,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

impl PtySession {
    pub fn write(&self, bytes: &[u8]) -> Result<()> {
        write_to_pty(&self.writer, bytes)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .lock()
            .expect("pty master mutex poisoned")
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("failed to resize pty")
    }

    pub fn kill(&mut self) {
        let _ = self.killer.kill();
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        self.kill();
    }
}

pub struct PtyProcess {
    pub session: PtySession,
    pub reader: Box<dyn Read + Send>,
    pub writer: SharedPtyWriter,
    pub child: Box<dyn Child + Send + Sync>,
}

pub fn spawn_pty_process(command: PtyCommand, cols: u16, rows: u16) -> Result<PtyProcess> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("failed to open pty")?;

    let child = pair
        .slave
        .spawn_command(command.builder())
        .with_context(|| format!("failed to spawn {}", command.program))?;
    let killer = child.clone_killer();
    let reader = pair
        .master
        .try_clone_reader()
        .context("failed to clone pty reader")?;
    let writer = Arc::new(Mutex::new(
        pair.master
            .take_writer()
            .context("failed to take pty writer")?,
    ));

    Ok(PtyProcess {
        session: PtySession {
            master: Mutex::new(pair.master),
            writer: writer.clone(),
            killer,
        },
        reader,
        writer,
        child,
    })
}

pub fn write_to_pty(writer: &SharedPtyWriter, bytes: &[u8]) -> Result<()> {
    let mut writer = writer.lock().expect("pty writer mutex poisoned");
    writer.write_all(bytes).context("failed to write to pty")?;
    writer.flush().context("failed to flush pty")
}

pub fn spawn_reader_channel(mut reader: Box<dyn Read + Send>) -> Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buffer = [0; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    if tx.send(buffer[..count].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    rx
}

pub fn append_limited_lossy(target: &mut String, bytes: &[u8], max_chars: usize) {
    target.push_str(&String::from_utf8_lossy(bytes));
    if target.chars().count() > max_chars {
        *target = target
            .chars()
            .rev()
            .take(max_chars)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
    }
}
