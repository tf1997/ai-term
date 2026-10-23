//! Bounded parallel uploads use independent SSH sessions: libssh2 serializes
//! channels on a shared session, so sharing one session would not add throughput.
use super::*;
use std::collections::HashSet;
use std::sync::atomic::AtomicUsize;
use std::sync::mpsc::{sync_channel, RecvTimeoutError};

const MAX_UPLOAD_WORKERS: usize = 4;
const PARALLEL_UPLOAD_MIN_FILES: usize = 8;

struct UploadFile {
    local: PathBuf,
    remote: String,
}

#[derive(Default)]
struct UploadPlan {
    directories: Vec<String>,
    files: Vec<UploadFile>,
    total: u64,
    last_scan_report: Option<Instant>,
}

impl UploadPlan {
    fn report_scan(&mut self, progress: &mut Option<&mut dyn FnMut(SftpProgressUpdate)>) {
        if self
            .last_scan_report
            .is_none_or(|last| last.elapsed() >= Duration::from_millis(100))
        {
            self.last_scan_report = Some(Instant::now());
            if let Some(callback) = progress.as_deref_mut() {
                callback(plain_progress_update(
                    None,
                    format!("正在扫描文件夹 · {} 个文件", self.files.len()),
                ));
            }
        }
    }

    fn scan(
        &mut self,
        local: &Path,
        remote: &str,
        ancestors: &mut HashSet<PathBuf>,
        cancel: Option<&SftpCancelToken>,
        progress: &mut Option<&mut dyn FnMut(SftpProgressUpdate)>,
    ) -> Result<()> {
        ensure_not_cancelled(cancel)?;
        let metadata = fs::metadata(local)
            .with_context(|| format!("failed to stat local path {}", local.display()))?;
        if metadata.is_dir() {
            let canonical = local.canonicalize()?;
            if !ancestors.insert(canonical.clone()) {
                bail!("folder contains a symbolic link cycle: {}", local.display());
            }
            self.directories.push(remote.to_owned());
            self.report_scan(progress);
            for entry in fs::read_dir(local)? {
                let entry = entry?;
                let child = join_remote_path(remote, &entry.file_name().to_string_lossy());
                self.scan(&entry.path(), &child, ancestors, cancel, progress)?;
            }
            ancestors.remove(&canonical);
        } else if metadata.is_file() {
            self.total = self.total.saturating_add(metadata.len());
            self.files.push(UploadFile {
                local: local.to_owned(),
                remote: remote.to_owned(),
            });
            self.report_scan(progress);
        } else {
            bail!("unsupported local file type: {}", local.display());
        }
        Ok(())
    }
}

enum UploadEvent {
    Progress(usize, u64),
    Failed(anyhow::Error),
}

pub(super) fn upload_directory(
    connection: &NativeSftpConnection,
    route: &SftpRoute,
    local: &Path,
    remote: &str,
    cancel: Option<&SftpCancelToken>,
    progress: &mut Option<&mut dyn FnMut(SftpProgressUpdate)>,
) -> Result<()> {
    let mut plan = UploadPlan::default();
    plan.scan(local, remote, &mut HashSet::new(), cancel, progress)?;
    let started = Instant::now();
    let _timeout = NativeTransferTimeout::new(connection);
    // Parents are created once, before any worker can open a child file.
    let mut last_directory_report: Option<Instant> = None;
    for directory in &plan.directories {
        ensure_not_cancelled(cancel)?;
        native_ensure_dir(&connection.sftp, directory)?;
        if last_directory_report.is_none_or(|last| last.elapsed() >= Duration::from_millis(100)) {
            last_directory_report = Some(Instant::now());
            if let Some(callback) = progress.as_deref_mut() {
                callback(plain_progress_update(
                    None,
                    format!("正在准备远端目录 · {directory}"),
                ));
            }
        }
    }

    // Establish additional sessions before dispatching writes. Servers limiting
    // connections can still complete the upload with the sessions already open.
    let desired = if plan.files.len() >= PARALLEL_UPLOAD_MIN_FILES {
        MAX_UPLOAD_WORKERS
    } else {
        1
    };
    let mut extra = Vec::new();
    for _ in 1..desired {
        ensure_not_cancelled(cancel)?;
        match connect_native_sftp_route(route, cancel) {
            Ok(next) => extra.push(next),
            Err(error) => {
                ensure_not_cancelled(cancel)?;
                if contains_host_key_verification_failure(&format!("{error:#}")) {
                    return Err(error);
                }
                break;
            }
        }
    }
    let connections: Vec<_> = std::iter::once(connection).chain(extra.iter()).collect();
    let stop = Arc::new(AtomicBool::new(false));
    let next = AtomicUsize::new(0);
    let result = std::thread::scope(|scope| -> Result<()> {
        let (send, receive) = sync_channel(32);
        let mut handles = Vec::new();
        for (worker, connection) in connections.iter().copied().enumerate() {
            let send = send.clone();
            let stop = &stop;
            let next = &next;
            let files = &plan.files;
            let started = &started;
            let total = plan.total;
            handles.push(scope.spawn(move || {
                let result = (|| -> Result<()> {
                    let _guard = connection._ssh.cancel_io_on(Some(stop))?;
                    let _timeout = NativeTransferTimeout::new(connection);
                    let mut buffer = vec![0; NATIVE_SFTP_COPY_BUFFER_SIZE];
                    let mut transferred = 0;
                    let mut report = |update: SftpProgressUpdate| {
                        let _ = send.send(UploadEvent::Progress(
                            worker,
                            update.transferred_bytes.unwrap_or(0),
                        ));
                    };
                    loop {
                        ensure_not_cancelled(Some(stop))?;
                        let Some(file) = files.get(next.fetch_add(1, Ordering::SeqCst)) else {
                            break;
                        };
                        upload_file_native_to(
                            &connection.sftp,
                            &file.local,
                            &file.remote,
                            &mut buffer,
                            Some(stop),
                            &mut Some(&mut report),
                            total,
                            &mut transferred,
                            started,
                        )?;
                        // Closing an empty file is progress too.
                        let _ = send.send(UploadEvent::Progress(worker, transferred));
                    }
                    Ok(())
                })();
                if let Err(error) = result {
                    // Preserve the originating failure; peers interrupted by
                    // our token must not replace it with a cancellation error.
                    if !stop.swap(true, Ordering::SeqCst) {
                        let _ = send.send(UploadEvent::Failed(error));
                    }
                }
            }));
        }
        drop(send);
        let mut counts = vec![0u64; connections.len()];
        let mut failure = None;
        loop {
            if is_cancelled(cancel) {
                stop.store(true, Ordering::SeqCst);
            }
            match receive.recv_timeout(Duration::from_millis(20)) {
                Ok(UploadEvent::Progress(worker, bytes)) => {
                    counts[worker] = bytes;
                    if failure.is_none() && !stop.load(Ordering::SeqCst) {
                        emit_native_transfer_progress(
                            progress,
                            plan.total,
                            counts.iter().sum(),
                            &started,
                        );
                    }
                }
                Ok(UploadEvent::Failed(error)) => {
                    failure = Some(error);
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        for handle in handles {
            if handle.join().is_err() && failure.is_none() {
                failure = Some(anyhow::anyhow!("SFTP upload worker panicked"));
            }
        }
        ensure_not_cancelled(cancel)?;
        if let Some(error) = failure {
            return Err(error);
        }
        emit_native_transfer_done(progress, plan.total, counts.iter().sum(), &started);
        Ok(())
    });
    result
}
