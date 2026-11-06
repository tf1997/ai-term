use std::io::{self, Read};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};

use super::protocol::{render_command, ExitProtocol, Utf8Stream};
use super::{
    SshTaskDispatch, SshTaskEvent, SshTaskSnapshot, SshTaskStatus, SshTaskStream,
    MAX_TASK_OUTPUT_BYTES,
};
use crate::domain::connection::models::JumpMode;
use crate::domain::terminal::ssh::connect_routed_endpoint;

type Listener = Arc<dyn Fn(SshTaskEvent) + Send + Sync>;

/// Cancellation closes only this task's dedicated transport. It means stop
/// observing, never confirmation that the remote process has been terminated.
pub struct SshTaskControl {
    pub(crate) stop: Arc<AtomicBool>,
    state: Mutex<SshTaskSnapshot>,
    listener: Listener,
}

impl SshTaskControl {
    pub fn new(
        dispatch: &SshTaskDispatch,
        listener: impl Fn(SshTaskEvent) + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            stop: Arc::new(AtomicBool::new(false)),
            state: Mutex::new(SshTaskSnapshot {
                reference: dispatch.intent.reference.clone(),
                target: dispatch.intent.target.clone(),
                sequence: 0,
                status: SshTaskStatus::Connecting,
                stdout: String::new(),
                stderr: String::new(),
                output_bytes: 0,
                truncated: false,
                exit_code: None,
                exit_signal: None,
                exit_evidence: None,
                reason: None,
                started_at: now_ms(),
                finished_at: None,
            }),
            listener: Arc::new(listener),
        })
    }

    pub fn snapshot(&self) -> SshTaskSnapshot {
        self.state.lock().unwrap().clone()
    }
    pub fn stop_observing(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }

    fn update(
        &self,
        stream: Option<SshTaskStream>,
        mut delta: String,
        change: impl FnOnce(&mut SshTaskSnapshot),
    ) {
        let event = {
            let mut state = self.state.lock().unwrap();
            change(&mut state);
            if let Some(stream) = stream {
                let available = MAX_TASK_OUTPUT_BYTES.saturating_sub(state.output_bytes);
                let mut keep = delta.len().min(available);
                while !delta.is_char_boundary(keep) {
                    keep -= 1;
                }
                let was_truncated = state.truncated;
                state.truncated |= keep < delta.len();
                delta.truncate(keep);
                if delta.is_empty() && was_truncated == state.truncated {
                    return;
                }
                state.output_bytes += delta.len();
                match stream {
                    SshTaskStream::Stdout => state.stdout.push_str(&delta),
                    SshTaskStream::Stderr => state.stderr.push_str(&delta),
                }
            }
            state.sequence += 1;
            SshTaskEvent {
                reference: state.reference.clone(),
                sequence: state.sequence,
                status: state.status,
                stream,
                delta,
                truncated: state.truncated,
            }
        };
        (self.listener)(event);
    }

    fn finish(
        &self,
        status: SshTaskStatus,
        code: Option<i32>,
        signal: Option<String>,
        reason: Option<String>,
        evidence: Option<String>,
    ) {
        self.update(None, String::new(), |state| {
            state.status = status;
            state.exit_code = code;
            state.exit_signal = signal;
            state.reason = reason;
            state.exit_evidence = evidence;
            state.finished_at = Some(now_ms());
        });
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn retry<T>(
    stop: &AtomicBool,
    deadline: Instant,
    mut operation: impl FnMut() -> std::result::Result<T, ssh2::Error>,
) -> Result<T> {
    loop {
        check(stop, deadline)?;
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) if error.code() == ssh2::ErrorCode::Session(-37) => {
                std::thread::sleep(Duration::from_millis(5))
            }
            Err(error) => return Err(error.into()),
        }
    }
}

fn check(stop: &AtomicBool, deadline: Instant) -> Result<()> {
    if stop.load(Ordering::SeqCst) {
        bail!("已停止观察；远端命令可能仍在运行，不能自动重放");
    }
    if Instant::now() >= deadline {
        bail!("独立任务观察超时；远端命令可能仍在运行，不能自动重放");
    }
    Ok(())
}

pub fn execute_ssh_task(dispatch: SshTaskDispatch, control: Arc<SshTaskControl>) {
    let deadline = Instant::now() + Duration::from_millis(dispatch.intent.request.timeout_ms);
    // A per-operation deadline also interrupts handshake/authentication calls.
    let watchdog_stop = Arc::new(AtomicBool::new(false));
    let done = watchdog_stop.clone();
    let cancel = control.stop.clone();
    let watchdog = std::thread::spawn(move || {
        while !done.load(Ordering::SeqCst) {
            if Instant::now() >= deadline {
                cancel.store(true, Ordering::SeqCst);
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    });
    let mut dispatch_attempted = false;
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let mut protocol = ExitProtocol::new(&nonce);
    let mut stdout = Utf8Stream::default();
    let mut stderr = Utf8Stream::default();
    let result: Result<(Option<i32>, Option<String>)> = (|| {
        check(&control.stop, deadline)?;
        let proxy = (dispatch.profile.jump_mode == JumpMode::InteractiveMenu)
            .then_some(&dispatch.profile.gateway);
        let connection =
            connect_routed_endpoint(&dispatch.profile.target, proxy, Some(&control.stop))?;
        let _cancel_io = connection.cancel_io_on(Some(&control.stop))?;
        let session = connection.session();
        session.set_blocking(false);
        let mut channel = retry(&control.stop, deadline, || session.channel_session())
            .context("无法打开独立 SSH 通道")?;
        let command = render_command(&dispatch.intent.request, &nonce);
        check(&control.stop, deadline)?;
        // Even a failed request/acknowledgement can have unknown remote effects.
        dispatch_attempted = true;
        retry(&control.stop, deadline, || channel.exec(&command)).context("SSH exec 请求未确认")?;
        control.update(None, String::new(), |state| {
            state.status = SshTaskStatus::Running
        });
        retry(&control.stop, deadline, || channel.send_eof())?;
        let mut buffer = [0u8; 8192];
        loop {
            check(&control.stop, deadline)?;
            let mut progress = false;
            // Alternate streams every bounded read; a full stderr window must
            // never deadlock a task whose stdout is quiet (or the reverse).
            for stream in [SshTaskStream::Stdout, SshTaskStream::Stderr] {
                let read = match stream {
                    SshTaskStream::Stdout => channel.read(&mut buffer),
                    SshTaskStream::Stderr => channel.stderr().read(&mut buffer),
                };
                match read {
                    Ok(0) => {}
                    Ok(count) => {
                        progress = true;
                        let text = match stream {
                            SshTaskStream::Stdout => stdout.feed(&buffer[..count], false),
                            SshTaskStream::Stderr => {
                                stderr.feed(&protocol.feed(&buffer[..count]), false)
                            }
                        };
                        if !text.is_empty() {
                            control.update(Some(stream), text, |_| {});
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                    Err(error) => return Err(error.into()),
                }
            }
            if !progress && channel.eof() {
                break;
            }
            if !progress {
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        retry(&control.stop, deadline, || channel.wait_close()).context("SSH 通道关闭未确认")?;
        Ok((
            channel.exit_status().ok(),
            channel
                .exit_signal()
                .ok()
                .and_then(|signal| signal.exit_signal),
        ))
    })();
    let text = stdout.feed(&[], true);
    if !text.is_empty() {
        control.update(Some(SshTaskStream::Stdout), text, |_| {});
    }
    let text = stderr.feed(&protocol.finish(), true);
    if !text.is_empty() {
        control.update(Some(SshTaskStream::Stderr), text, |_| {});
    }
    watchdog_stop.store(true, Ordering::SeqCst);
    let _ = watchdog.join();
    match result {
        Ok((hint, signal))
            if !protocol.invalid
                && protocol.started
                && protocol.exit.is_some()
                && signal.is_none()
                && hint.is_none_or(|hint| hint == 0 || Some(hint) == protocol.exit) =>
        {
            control.finish(
                SshTaskStatus::Completed,
                protocol.exit,
                None,
                None,
                Some("shell-trailer-and-channel-close".into()),
            );
        }
        Ok((_, signal)) if signal.is_some() => control.finish(
            SshTaskStatus::Completed,
            None,
            signal,
            Some("独立 SSH 进程被信号结束".into()),
            Some("ssh-exit-signal-and-channel-close".into()),
        ),
        Ok(_) if !protocol.invalid && protocol.setup_failed.is_some() => control.finish(
            SshTaskStatus::NotStarted,
            None,
            None,
            Some("独立任务工作目录无法进入，命令尚未开始".into()),
            Some("setup-failed-and-channel-close".into()),
        ),
        Ok(_) => control.finish(
            SshTaskStatus::Unknown,
            None,
            None,
            Some("未取得完整的独立任务退出证据；不能把缺失退出状态视为成功，也不能自动重放".into()),
            None,
        ),
        Err(error) => {
            let reason = if control.stop.load(Ordering::SeqCst) {
                if Instant::now() >= deadline {
                    "独立任务观察超时；远端进程可能仍在运行".into()
                } else {
                    "已停止观察；远端进程可能仍在运行".into()
                }
            } else {
                format!("{error:#}")
            };
            control.finish(
                if dispatch_attempted {
                    SshTaskStatus::Unknown
                } else {
                    SshTaskStatus::NotStarted
                },
                None,
                None,
                Some(reason),
                None,
            );
        }
    }
}
