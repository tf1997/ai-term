use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

const CANCELLED_TASK_TTL: Duration = Duration::from_secs(300);
const CANCELLED_TASK_LIMIT: usize = 1024;

#[derive(Default)]
struct TaskEntries {
    active: HashMap<String, Arc<AtomicBool>>,
    // IPC cancellation can arrive before the corresponding command is polled.
    cancelled: HashMap<String, Instant>,
}

#[derive(Default)]
pub(crate) struct TaskRegistry(Mutex<TaskEntries>);

impl TaskRegistry {
    pub(crate) fn register(&self, id: String) -> Arc<AtomicBool> {
        let mut entries = self.0.lock().unwrap_or_else(|error| error.into_inner());
        Self::prune(&mut entries);
        if let Some(token) = entries.active.get(&id) {
            return token.clone();
        }
        let cancelled = entries.cancelled.remove(&id).is_some();
        let token = Arc::new(AtomicBool::new(cancelled));
        entries.active.insert(id, token.clone());
        token
    }

    pub(crate) fn scoped(self: &Arc<Self>, id: Option<String>) -> Result<TaskRegistration, String> {
        let mut entries = self.0.lock().unwrap_or_else(|error| error.into_inner());
        Self::prune(&mut entries);
        if id
            .as_ref()
            .is_some_and(|id| entries.active.contains_key(id))
        {
            return Err("task ID is already active".into());
        }
        let cancelled = id
            .as_ref()
            .is_some_and(|id| entries.cancelled.remove(id).is_some());
        let token = Arc::new(AtomicBool::new(cancelled));
        if let Some(id) = &id {
            entries.active.insert(id.clone(), token.clone());
        }
        Ok(TaskRegistration {
            registry: self.clone(),
            id,
            token,
        })
    }

    pub(crate) fn cancel(&self, id: &str) -> bool {
        let mut entries = self.0.lock().unwrap_or_else(|error| error.into_inner());
        Self::prune(&mut entries);
        if let Some(token) = entries.active.get(id) {
            token.store(true, Ordering::SeqCst);
            true
        } else {
            entries.cancelled.insert(id.to_string(), Instant::now());
            Self::prune(&mut entries);
            false
        }
    }

    pub(crate) fn finish(&self, id: &str) {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .active
            .remove(id);
    }

    fn prune(entries: &mut TaskEntries) {
        entries
            .cancelled
            .retain(|_, at| at.elapsed() < CANCELLED_TASK_TTL);
        while entries.cancelled.len() > CANCELLED_TASK_LIMIT {
            let oldest = entries
                .cancelled
                .iter()
                .min_by_key(|(_, at)| *at)
                .map(|(id, _)| id.clone());
            if let Some(id) = oldest {
                entries.cancelled.remove(&id);
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn active_count(&self) -> usize {
        self.0.lock().unwrap().active.len()
    }
}

/// Cancels detached blocking work and unregisters even if the command future is
/// dropped, a profile lookup fails, or a worker panics.
pub(crate) struct TaskRegistration {
    registry: Arc<TaskRegistry>,
    id: Option<String>,
    pub(crate) token: Arc<AtomicBool>,
}

impl Drop for TaskRegistration {
    fn drop(&mut self) {
        self.token.store(true, Ordering::SeqCst);
        if let Some(id) = &self.id {
            let mut entries = self
                .registry
                .0
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if entries
                .active
                .get(id)
                .is_some_and(|token| Arc::ptr_eq(token, &self.token))
            {
                entries.active.remove(id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_before_registration_is_not_lost() {
        let registry = Arc::new(TaskRegistry::default());
        assert!(!registry.cancel("late"));
        let task = registry.scoped(Some("late".into())).unwrap();
        assert!(task.token.load(Ordering::SeqCst));
        drop(task);
        assert_eq!(registry.active_count(), 0);
    }

    #[test]
    fn scoped_cleanup_cancels_the_worker_and_does_not_remove_another_registration() {
        let registry = Arc::new(TaskRegistry::default());
        let task = registry.scoped(Some("same".into())).unwrap();
        let old_token = task.token.clone();
        assert!(registry.scoped(Some("same".into())).is_err());
        registry.finish("same");
        let replacement = registry.scoped(Some("same".into())).unwrap();
        drop(task);
        assert!(old_token.load(Ordering::SeqCst));
        assert!(!replacement.token.load(Ordering::SeqCst));
        assert_eq!(registry.active_count(), 1);
        drop(replacement);
        assert_eq!(registry.active_count(), 0);
    }

    #[test]
    fn unregistered_cancellations_are_bounded_and_expire() {
        let registry = TaskRegistry::default();
        for id in 0..(CANCELLED_TASK_LIMIT + 4) {
            registry.cancel(&id.to_string());
        }
        let mut entries = registry.0.lock().unwrap();
        assert_eq!(entries.cancelled.len(), CANCELLED_TASK_LIMIT);
        entries
            .cancelled
            .insert("expired".into(), Instant::now() - CANCELLED_TASK_TTL);
        TaskRegistry::prune(&mut entries);
        assert!(!entries.cancelled.contains_key("expired"));
    }
}
