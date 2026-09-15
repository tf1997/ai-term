use std::future::Future;
use std::sync::atomic::Ordering;
use std::time::Duration;

use super::state::AppState;
use crate::domain::connection::sftp::SftpCancelToken;

const CANCELLATION_POLL: Duration = Duration::from_millis(20);
const WORKER_STOP_GRACE: Duration = Duration::from_millis(750);

pub(crate) fn requested_timeout(timeout_ms: Option<u64>, maximum: Duration) -> Duration {
    timeout_ms
        .map(Duration::from_millis)
        .unwrap_or(maximum)
        .min(maximum)
}

#[derive(Clone, Copy)]
enum TaskStop {
    Cancelled,
    TimedOut,
}

impl TaskStop {
    fn message(self) -> String {
        match self {
            Self::Cancelled => "SFTP task cancelled",
            Self::TimedOut => {
                "SFTP task timed out; check network access, authentication and SFTP availability"
            }
        }
        .into()
    }
}

async fn until_stopped<T>(
    future: impl Future<Output = T>,
    deadline: tokio::time::Instant,
    token: &SftpCancelToken,
) -> Result<T, TaskStop> {
    // Check before polling the operation, including immediately-ready results.
    if token.load(Ordering::SeqCst) {
        return Err(TaskStop::Cancelled);
    }
    if tokio::time::Instant::now() >= deadline {
        return Err(TaskStop::TimedOut);
    }
    tokio::select! {
        biased;
        _ = async {
            while !token.load(Ordering::SeqCst) { tokio::time::sleep(CANCELLATION_POLL).await; }
        } => Err(TaskStop::Cancelled),
        _ = tokio::time::sleep_until(deadline) => Err(TaskStop::TimedOut),
        result = future => {
            if token.load(Ordering::SeqCst) { Err(TaskStop::Cancelled) }
            else if tokio::time::Instant::now() >= deadline { Err(TaskStop::TimedOut) }
            else { Ok(result) }
        }
    }
}

/// One deadline covers profile/keychain lookup, all routes, SSH/SFTP startup,
/// retries and the operation. Every command gets a token, even without taskId.
pub(crate) async fn run_sftp_task<P, T>(
    state: &AppState,
    task_id: Option<String>,
    timeout: Duration,
    profile: impl Future<Output = Result<P, String>>,
    action: impl FnOnce(P, SftpCancelToken) -> anyhow::Result<T> + Send + 'static,
) -> Result<T, String>
where
    P: Send + 'static,
    T: Send + 'static,
{
    let deadline = tokio::time::Instant::now() + timeout;
    let task = state.scoped_task(task_id)?;
    let profile = until_stopped(profile, deadline, &task.token)
        .await
        .map_err(TaskStop::message)??;
    let token = task.token.clone();
    let mut operation = tokio::task::spawn_blocking(move || {
        if token.load(Ordering::SeqCst) {
            anyhow::bail!("SFTP task cancelled");
        }
        let result = action(profile, token.clone());
        if token.load(Ordering::SeqCst) {
            anyhow::bail!("SFTP task cancelled");
        }
        result
    });
    match until_stopped(&mut operation, deadline, &task.token).await {
        Ok(joined) => joined
            .map_err(|error| error.to_string())?
            .map_err(|error| format!("{error:#}")),
        Err(reason) => {
            task.token.store(true, Ordering::SeqCst);
            // Abort queued work and allow running socket/process watchers to
            // stop their worker before publishing the timeout/cancel result.
            operation.abort();
            let _ = tokio::time::timeout(WORKER_STOP_GRACE, &mut operation).await;
            Err(reason.message())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{atomic::AtomicBool, Arc};
    use std::time::Instant;

    #[tokio::test]
    async fn total_deadline_includes_profile_lookup_and_never_starts_late_work() {
        let state = AppState::default();
        let ran = Arc::new(AtomicBool::new(false));
        let did_run = ran.clone();
        let result = run_sftp_task(
            &state,
            Some("profile-timeout".into()),
            Duration::from_millis(30),
            async {
                tokio::time::sleep(Duration::from_secs(5)).await;
                Ok(())
            },
            move |_, _| {
                did_run.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .await;
        assert!(result.unwrap_err().contains("timed out"));
        assert!(!ran.load(Ordering::SeqCst));
        assert_eq!(state.active_task_count(), 0);
    }

    #[tokio::test]
    async fn cancellation_during_profile_lookup_and_before_registration_prevents_work() {
        let state = AppState::default();
        let operation = run_sftp_task(
            &state,
            Some("profile-cancel".into()),
            Duration::from_secs(5),
            std::future::pending::<Result<(), String>>(),
            |_, _| -> anyhow::Result<()> { panic!("must not start") },
        );
        let cancel = async {
            tokio::time::sleep(Duration::from_millis(10)).await;
            assert!(state.cancel_task("profile-cancel").await);
        };
        let (result, _) = tokio::join!(operation, cancel);
        assert!(result.unwrap_err().contains("cancelled"));
        assert_eq!(state.active_task_count(), 0);

        state.cancel_task("before-register").await;
        let result = run_sftp_task(
            &state,
            Some("before-register".into()),
            Duration::from_secs(1),
            async { Ok(()) },
            |_, _| -> anyhow::Result<()> { panic!("must not start") },
        )
        .await;
        assert!(result.unwrap_err().contains("cancelled"));
        assert_eq!(state.active_task_count(), 0);
    }

    #[tokio::test]
    async fn timeout_without_task_id_stops_blocking_worker() {
        let state = AppState::default();
        let exited = Arc::new(AtomicBool::new(false));
        let worker_exited = exited.clone();
        let started = Instant::now();
        let result = run_sftp_task(
            &state,
            None,
            Duration::from_millis(80),
            async { Ok(()) },
            move |_, token| {
                while !token.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(2));
                }
                worker_exited.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .await;
        assert!(result.unwrap_err().contains("timed out"));
        assert!(exited.load(Ordering::SeqCst));
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(state.active_task_count(), 0);
    }

    #[tokio::test]
    async fn profile_errors_and_panics_always_unregister() {
        let state = AppState::default();
        let result = run_sftp_task(
            &state,
            Some("missing".into()),
            Duration::from_secs(1),
            async { Err::<(), _>("missing profile".into()) },
            |_, _| Ok(()),
        )
        .await;
        assert_eq!(result.unwrap_err(), "missing profile");
        assert_eq!(state.active_task_count(), 0);
        let result = run_sftp_task(
            &state,
            Some("panic".into()),
            Duration::from_secs(1),
            async { Ok(()) },
            |_, _| -> anyhow::Result<()> { panic!("worker panic") },
        )
        .await;
        assert!(result.unwrap_err().contains("panic"));
        assert_eq!(state.active_task_count(), 0);
    }

    #[tokio::test]
    async fn dropping_command_future_cancels_and_unregisters_blocking_work() {
        let state = AppState::default();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (stopped_tx, stopped_rx) = tokio::sync::oneshot::channel();
        let mut operation = Box::pin(run_sftp_task(
            &state,
            Some("drop".into()),
            Duration::from_secs(3),
            async { Ok(()) },
            move |_, token| {
                let _ = started_tx.send(());
                while !token.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(2));
                }
                let _ = stopped_tx.send(());
                Ok(())
            },
        ));
        tokio::select! { _ = &mut operation => panic!("worker should be waiting"), _ = started_rx => {} }
        drop(operation);
        tokio::time::timeout(Duration::from_secs(1), stopped_rx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(state.active_task_count(), 0);
    }

    #[test]
    fn requested_deadline_is_never_extended_by_the_caller() {
        let maximum = Duration::from_secs(20);
        assert_eq!(requested_timeout(None, maximum), maximum);
        assert_eq!(
            requested_timeout(Some(500), maximum),
            Duration::from_millis(500)
        );
        assert_eq!(requested_timeout(Some(90_000), maximum), maximum);
        assert_eq!(requested_timeout(Some(0), maximum), Duration::ZERO);
    }
}
