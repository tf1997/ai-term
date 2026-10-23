use anyhow::Result;
use portable_pty::Child;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// Interrupts even a blocked PTY write. On Windows the job owns ssh.exe and
/// ProxyJump descendants as well as sftp.exe; killing only sftp leaves them alive.
pub(super) struct SftpProcessCancellation {
    stop: Option<mpsc::Sender<()>>,
    worker: Option<JoinHandle<()>>,
    _tree: Arc<ProcessTree>,
    deadline: Arc<Mutex<Instant>>,
    idle_timeout: Option<Duration>,
}

impl SftpProcessCancellation {
    pub(super) fn new(
        child: &dyn Child,
        token: Option<&Arc<AtomicBool>>,
        timeout: Duration,
        idle: bool,
    ) -> Result<Self> {
        let tree = Arc::new(ProcessTree::new(child)?);
        let watched_tree = tree.clone();
        let mut killer = child.clone_killer();
        let token = token.cloned();
        let (send, receive) = mpsc::channel();
        let deadline = Arc::new(Mutex::new(Instant::now() + timeout));
        let watched_deadline = deadline.clone();
        let worker = thread::spawn(move || loop {
            if token
                .as_ref()
                .is_some_and(|token| token.load(Ordering::SeqCst))
                || Instant::now() >= *watched_deadline.lock().unwrap()
            {
                watched_tree.terminate();
                let _ = killer.kill();
                break;
            }
            let remaining = watched_deadline
                .lock()
                .unwrap()
                .saturating_duration_since(Instant::now());
            match receive.recv_timeout(remaining.min(Duration::from_millis(20))) {
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                _ => break,
            }
        });
        Ok(Self {
            stop: Some(send),
            worker: Some(worker),
            _tree: tree,
            deadline,
            idle_timeout: idle.then_some(timeout),
        })
    }

    pub(super) fn touch(&self) {
        if let Some(timeout) = self.idle_timeout {
            let mut deadline = self.deadline.lock().unwrap();
            let now = Instant::now();
            if now < *deadline {
                *deadline = now + timeout;
            }
        }
    }

    pub(super) fn timed_out(&self) -> bool {
        Instant::now() >= *self.deadline.lock().unwrap()
    }
}

impl Drop for SftpProcessCancellation {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        // Closing the final job handle also cleans up descendants on errors or
        // normal exit if a helper outlives the sftp parent.
    }
}

#[cfg(windows)]
struct ProcessTree(std::os::windows::io::OwnedHandle);

#[cfg(windows)]
impl ProcessTree {
    fn new(child: &dyn Child) -> Result<Self> {
        use anyhow::Context;
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        let process = child
            .as_raw_handle()
            .context("SFTP child has no process handle")?;
        unsafe {
            let raw = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if raw.is_null() {
                return Err(std::io::Error::last_os_error())
                    .context("failed to create SFTP process job");
            }
            let job = OwnedHandle::from_raw_handle(raw);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
            {
                return Err(std::io::Error::last_os_error())
                    .context("failed to configure SFTP process job");
            }
            if AssignProcessToJobObject(job.as_raw_handle(), process) == 0 {
                return Err(std::io::Error::last_os_error())
                    .context("failed to assign SFTP process job");
            }
            Ok(Self(job))
        }
    }

    fn terminate(&self) {
        use std::os::windows::io::AsRawHandle;
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0.as_raw_handle(), 1);
        }
    }
}

#[cfg(not(windows))]
struct ProcessTree;

#[cfg(not(windows))]
impl ProcessTree {
    fn new(_child: &dyn Child) -> Result<Self> {
        Ok(Self)
    }
    // portable-pty's Unix killer signals the process group.
    fn terminate(&self) {}
}
