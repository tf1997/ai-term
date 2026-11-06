use super::*;
use crate::domain::connection::sftp::{self, SftpTargetOverride};
use crate::domain::filesystem::agent_files::*;
use serde::Serialize;
use std::sync::{atomic::Ordering, Weak};
use std::time::{Duration, Instant};

const MAX_PENDING: usize = 128;
const PENDING_TTL: Duration = Duration::from_secs(600);
const FILE_TASK_TIMEOUT: Duration = Duration::from_secs(20);

#[path = "agent_file_edits_state.rs"]
mod edits;
pub use edits::FileEditDispatchOutcome;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCapturePlan {
    pub reference: FileOperationReference,
    pub intent: CommandIntent,
    pub max_output_chars: usize,
}
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum FileDispatchOutcome {
    Complete { response: FileToolResponse },
    Terminal { capture: FileCapturePlan },
}
struct InspectionCapture {
    reference: FileOperationReference,
    request: FileToolRequest,
    helper: TerminalFileRequest,
    intent_id: String,
    dispatched: bool,
    created: Instant,
}
struct ReadCapture {
    dispatch: FileDispatch,
    helper: TerminalFileRequest,
    intent_id: String,
    dispatched: bool,
    created: Instant,
}
#[derive(Default)]
pub(super) struct SessionFileState {
    operations: FileOperationStore,
    edits: FileEditStore,
    edit_captures: HashMap<String, edits::EditCapture>,
    inspections: HashMap<String, InspectionCapture>,
    captures: HashMap<String, ReadCapture>,
    routes: HashMap<String, (String, Instant)>,
    active: HashMap<String, Weak<AtomicBool>>,
}
impl SessionFileState {
    pub(super) fn invalidate(&mut self) {
        for token in self.active.values().filter_map(Weak::upgrade) {
            token.store(true, Ordering::SeqCst);
        }
        self.operations.invalidate();
        self.edits.invalidate();
        self.edit_captures.clear();
        self.inspections.clear();
        self.captures.clear();
        self.routes.clear();
        self.active.clear();
    }
    pub(super) fn note_dispatched(&mut self, intent_id: &str) {
        for capture in self
            .edit_captures
            .values_mut()
            .filter(|item| item.intent_id == intent_id)
        {
            capture.dispatched = true;
        }
        for capture in self
            .inspections
            .values_mut()
            .filter(|item| item.intent_id == intent_id)
        {
            capture.dispatched = true;
        }
        for capture in self
            .captures
            .values_mut()
            .filter(|item| item.intent_id == intent_id)
        {
            capture.dispatched = true;
        }
    }
    fn prune(&mut self) -> FileResult<()> {
        self.edit_captures
            .retain(|_, item| item.created.elapsed() < PENDING_TTL);
        self.inspections
            .retain(|_, item| item.created.elapsed() < PENDING_TTL);
        self.captures
            .retain(|_, item| item.created.elapsed() < PENDING_TTL);
        self.routes
            .retain(|_, (_, created)| created.elapsed() < PENDING_TTL);
        self.active.retain(|_, token| token.strong_count() > 0);
        if self.inspections.len() + self.captures.len() + self.routes.len() >= MAX_PENDING {
            return Err(FileError::new(
                FileErrorKind::Unavailable,
                "待完成的文件请求过多，请取消旧请求",
            ));
        }
        Ok(())
    }
}
impl Drop for SessionFileState {
    fn drop(&mut self) {
        self.invalidate();
    }
}

fn file_session<'a>(
    sessions: &'a mut HashMap<String, SessionRecord>,
    expected: &ExecutionTarget,
) -> FileResult<&'a mut SessionRecord> {
    let record = sessions
        .get_mut(&expected.session_id)
        .ok_or_else(|| FileError::new(FileErrorKind::TargetChanged, "文件工具绑定的终端已关闭"))?;
    if record.terminal.is_none() || record.execution_target != *expected {
        return Err(FileError::new(
            FileErrorKind::TargetChanged,
            "文件工具绑定的目标环境已经变化",
        ));
    }
    Ok(record)
}
fn unavailable(error: impl std::fmt::Display) -> FileError {
    FileError::new(FileErrorKind::Unavailable, error.to_string())
}
fn prepare_helper(
    record: &mut SessionRecord,
    helper: TerminalFileRequest,
) -> FileResult<CommandIntent> {
    let prepared = IntentStore::prepare_probe(
        InternalProbe::FileReader { request: helper },
        record.execution_target.clone(),
    )
    .map_err(unavailable)?;
    record
        .intents
        .insert(prepared, &record.execution_target)
        .map_err(unavailable)
}
async fn bounded_task<T>(
    token: &Arc<AtomicBool>,
    future: impl std::future::Future<Output = FileResult<T>>,
) -> FileResult<T> {
    bounded_task_for(token, FILE_TASK_TIMEOUT, future).await
}
async fn bounded_task_for<T>(
    token: &Arc<AtomicBool>,
    timeout: Duration,
    future: impl std::future::Future<Output = FileResult<T>>,
) -> FileResult<T> {
    tokio::pin!(future);
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        FileError::cancelled(Some(token))?;
        if tokio::time::Instant::now() >= deadline {
            token.store(true, Ordering::SeqCst);
            return Err(FileError::new(
                FileErrorKind::Unavailable,
                format!("文件操作超过 {} 秒，已停止等待", timeout.as_secs()),
            ));
        }
        tokio::select! {
            biased;
            _ = tokio::time::sleep(Duration::from_millis(20)) => {},
            result = &mut future => { FileError::cancelled(Some(token))?; return result; }
        }
    }
}

#[cfg(test)]
mod timeout_tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn slow_write_observation_can_finish_without_extending_the_read_budget() {
        let token = Arc::new(AtomicBool::new(false));
        let slow = || async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Ok(42)
        };
        assert_eq!(
            bounded_task_for(&token, Duration::from_secs(60), slow())
                .await
                .unwrap(),
            42
        );
        assert!(!token.load(Ordering::SeqCst));
        let error = bounded_task(&token, slow()).await.unwrap_err();
        assert_eq!(error.kind, FileErrorKind::Unavailable);
        assert!(token.load(Ordering::SeqCst));
    }

    #[tokio::test(start_paused = true)]
    async fn longer_write_observation_still_reacts_to_cancellation() {
        let token = Arc::new(AtomicBool::new(false));
        let cancel = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(1)).await;
            cancel.store(true, Ordering::SeqCst);
        });
        let start = tokio::time::Instant::now();
        let error = bounded_task_for::<()>(&token, Duration::from_secs(60), std::future::pending())
            .await
            .unwrap_err();
        assert_eq!(error.kind, FileErrorKind::Cancelled);
        assert!(start.elapsed() < Duration::from_secs(2));
    }
}

impl AppState {
    pub async fn prepare_agent_file_inspection(
        &self,
        expected: ExecutionTarget,
        request: FileToolRequest,
    ) -> FileResult<FileCapturePlan> {
        request.validate()?;
        let helper = TerminalFileRequest::inspect(request.path().into())?;
        let mut sessions = self.sessions.lock().await;
        let record = file_session(&mut sessions, &expected)?;
        record.files.prune()?;
        let intent = prepare_helper(record, helper.clone())?;
        let reference = FileOperationReference {
            id: uuid::Uuid::new_v4().to_string(),
            target: expected,
        };
        record.files.inspections.insert(
            reference.id.clone(),
            InspectionCapture {
                reference: reference.clone(),
                request,
                helper,
                intent_id: intent.reference.id.clone(),
                dispatched: false,
                created: Instant::now(),
            },
        );
        Ok(FileCapturePlan {
            reference,
            intent,
            max_output_chars: 65_536,
        })
    }

    pub async fn finish_agent_file_inspection(
        &self,
        reference: FileOperationReference,
        output: String,
    ) -> FileResult<FileOperation> {
        let registration = self
            .scoped_task(Some(reference.id.clone()))
            .map_err(unavailable)?;
        let inspection = {
            let mut sessions = self.sessions.lock().await;
            let record = file_session(&mut sessions, &reference.target)?;
            record.files.prune()?;
            let inspection = record
                .files
                .inspections
                .remove(&reference.id)
                .ok_or_else(|| {
                    FileError::new(FileErrorKind::TargetChanged, "文件检查已经取消或过期")
                })?;
            if !inspection.dispatched || inspection.reference != reference {
                return Err(FileError::new(
                    FileErrorKind::InvalidRequest,
                    "文件检查尚未派发，不能接受结果",
                ));
            }
            record
                .files
                .active
                .insert(reference.id.clone(), Arc::downgrade(&registration.token));
            inspection
        };
        let terminal: FileInspection = match inspection.helper.parse(&output) {
            Ok(value) => value,
            Err(mut error) => {
                if let Some(absence) = &error.absence {
                    check_file_path_syntax(&absence.resolved_path)?;
                    if error.kind != FileErrorKind::Missing
                        || absence.path != inspection.request.path()
                        || absence.environment_scope.len() != 64
                        || !absence
                            .environment_scope
                            .bytes()
                            .all(|byte| byte.is_ascii_hexdigit())
                    {
                        return Err(unavailable("文件缺失证据未绑定请求路径和环境"));
                    }
                }
                let mut sessions = self.sessions.lock().await;
                let record = file_session(&mut sessions, &reference.target)?;
                if let Some(absence) = &mut error.absence {
                    absence.baseline_id = record
                        .files
                        .edits
                        .register_absence(&reference.target, absence);
                }
                return Err(error);
            }
        };
        terminal.validate(inspection.request.path())?;
        let expected = &reference.target;
        let token = registration.token.clone();
        let (provider, selected, route) = bounded_task(&token, async {
            let profile = if expected.profile_id == "local" {
                None
            } else {
                Some(
                    self.get_connection_profile(&expected.profile_id)
                        .await
                        .map_err(unavailable)?
                        .ok_or_else(|| {
                            FileError::new(FileErrorKind::TargetChanged, "连接配置已经删除")
                        })?,
                )
            };
            let worker_token = token.clone();
            tokio::task::spawn_blocking(move || {
                FileError::cancelled(Some(&worker_token))?;
                let candidate = match &profile {
                    None => inspect_local_agent_file(&terminal)
                        .map(|selected| (FileProvider::Local, selected, None)),
                    Some(profile) => {
                        let route = sftp::sftp_profile_route(profile);
                        sftp::inspect_agent_file_sftp(
                            profile,
                            &route,
                            &SftpTargetOverride::default(),
                            &terminal,
                            Some(&worker_token),
                        )
                        .map(|selected| (FileProvider::Sftp, selected, Some(route)))
                    }
                };
                match candidate {
                    Ok(value) => Ok(value),
                    Err(error) if error.kind == FileErrorKind::Unavailable => {
                        Ok((FileProvider::CurrentTerminal, terminal, None))
                    }
                    Err(error) => Err(error),
                }
            })
            .await
            .map_err(unavailable)?
        })
        .await?;
        let mut sessions = self.sessions.lock().await;
        let record = file_session(&mut sessions, expected)?;
        FileError::cancelled(Some(&token))?;
        let operation = record.files.operations.prepare(
            expected.clone(),
            inspection.request,
            provider,
            selected,
        )?;
        if let Some(route) = route {
            record
                .files
                .routes
                .insert(operation.reference.id.clone(), (route, Instant::now()));
        }
        record.files.active.remove(&reference.id);
        Ok(operation)
    }

    pub async fn approve_agent_file_operation(
        &self,
        reference: &FileOperationReference,
        reviewed_path: &str,
        reviewed_revision: &str,
    ) -> FileResult<()> {
        let mut sessions = self.sessions.lock().await;
        let record = file_session(&mut sessions, &reference.target)?;
        record.files.operations.approve(
            reference,
            &record.execution_target,
            reviewed_path,
            reviewed_revision,
        )
    }

    pub async fn dispatch_agent_file_operation(
        &self,
        reference: FileOperationReference,
    ) -> FileResult<FileDispatchOutcome> {
        let registration = self
            .scoped_task(Some(reference.id.clone()))
            .map_err(unavailable)?;
        let (dispatch, route) = {
            let mut sessions = self.sessions.lock().await;
            let record = file_session(&mut sessions, &reference.target)?;
            FileError::cancelled(Some(&registration.token))?;
            let dispatch = record
                .files
                .operations
                .consume(&reference, &record.execution_target)?;
            let route = record
                .files
                .routes
                .remove(&reference.id)
                .map(|(route, _)| route);
            if dispatch.operation.provider == FileProvider::CurrentTerminal {
                let helper = dispatch.terminal_request()?;
                let intent = prepare_helper(record, helper.clone())?;
                record.files.captures.insert(
                    reference.id.clone(),
                    ReadCapture {
                        dispatch,
                        helper,
                        intent_id: intent.reference.id.clone(),
                        dispatched: false,
                        created: Instant::now(),
                    },
                );
                return Ok(FileDispatchOutcome::Terminal {
                    capture: FileCapturePlan {
                        reference,
                        intent,
                        max_output_chars: TERMINAL_FILE_OUTPUT_LIMIT,
                    },
                });
            }
            record
                .files
                .active
                .insert(reference.id.clone(), Arc::downgrade(&registration.token));
            (dispatch, route)
        };
        let token = registration.token.clone();
        let baseline_dispatch = dispatch.clone();
        let baseline_route = route.clone();
        let data = bounded_task(&token, async {
            let profile = if dispatch.operation.provider == FileProvider::Sftp {
                Some(
                    self.get_connection_profile(&reference.target.profile_id)
                        .await
                        .map_err(unavailable)?
                        .ok_or_else(|| {
                            FileError::new(FileErrorKind::TargetChanged, "连接配置已经删除")
                        })?,
                )
            } else {
                None
            };
            let worker = dispatch.clone();
            let worker_token = token.clone();
            tokio::task::spawn_blocking(move || {
                FileError::cancelled(Some(&worker_token))?;
                let permit = worker.native_permit()?;
                match (&worker.operation.request, profile) {
                    (FileToolRequest::ReadFile { options, .. }, None) => {
                        read_local_file_with_permit(
                            &permit,
                            options,
                            worker.resume.as_ref(),
                            Some(&worker_token),
                        )
                        .map(|data| FileToolData::ReadFile { data })
                    }
                    (FileToolRequest::ListDirectory { limit, .. }, None) => {
                        list_local_directory_with_permit(
                            &permit,
                            worker.offset,
                            *limit,
                            Some(&worker_token),
                        )
                        .map(|data| FileToolData::ListDirectory { data })
                    }
                    (FileToolRequest::ReadFile { options, .. }, Some(profile)) => {
                        sftp::read_agent_file_sftp_with_permit(
                            &profile,
                            route.as_deref().ok_or_else(|| {
                                FileError::new(FileErrorKind::TargetChanged, "SFTP 绑定缺失")
                            })?,
                            &SftpTargetOverride::default(),
                            &permit,
                            options,
                            worker.resume.as_ref(),
                            Some(&worker_token),
                        )
                        .map(|data| FileToolData::ReadFile { data })
                    }
                    (FileToolRequest::ListDirectory { limit, .. }, Some(profile)) => {
                        sftp::list_agent_directory_sftp_with_permit(
                            &profile,
                            route.as_deref().ok_or_else(|| {
                                FileError::new(FileErrorKind::TargetChanged, "SFTP 绑定缺失")
                            })?,
                            &SftpTargetOverride::default(),
                            &permit,
                            worker.offset,
                            *limit,
                            Some(&worker_token),
                        )
                        .map(|data| FileToolData::ListDirectory { data })
                    }
                }
            })
            .await
            .map_err(unavailable)?
        })
        .await?;
        let mut sessions = self.sessions.lock().await;
        let record = file_session(&mut sessions, &reference.target)?;
        FileError::cancelled(Some(&token))?;
        record.files.active.remove(&reference.id);
        let mut response =
            record
                .files
                .operations
                .finish(dispatch, &record.execution_target, data)?;
        response.baseline_id =
            record
                .files
                .edits
                .register_read(baseline_dispatch, baseline_route, &response);
        Ok(FileDispatchOutcome::Complete { response })
    }

    pub async fn finish_agent_terminal_file(
        &self,
        reference: FileOperationReference,
        output: String,
    ) -> FileResult<FileToolResponse> {
        let mut sessions = self.sessions.lock().await;
        let record = file_session(&mut sessions, &reference.target)?;
        record.files.prune()?;
        let capture =
            record.files.captures.remove(&reference.id).ok_or_else(|| {
                FileError::new(FileErrorKind::TargetChanged, "文件读取已取消或过期")
            })?;
        if !capture.dispatched || capture.dispatch.operation.reference != reference {
            return Err(FileError::new(
                FileErrorKind::InvalidRequest,
                "文件读取尚未派发，不能接受结果",
            ));
        }
        let data = match capture.dispatch.operation.request {
            FileToolRequest::ReadFile { .. } => FileToolData::ReadFile {
                data: capture.helper.parse(&output)?,
            },
            FileToolRequest::ListDirectory { .. } => FileToolData::ListDirectory {
                data: capture.helper.parse(&output)?,
            },
        };
        let baseline = capture.dispatch.clone();
        let mut response =
            record
                .files
                .operations
                .finish(capture.dispatch, &record.execution_target, data)?;
        response.baseline_id = record.files.edits.register_read(baseline, None, &response);
        Ok(response)
    }

    pub async fn cancel_agent_file_operation(&self, reference: &FileOperationReference) -> bool {
        self.tasks.cancel(&reference.id);
        let mut sessions = self.sessions.lock().await;
        let Some(record) = sessions.get_mut(&reference.target.session_id) else {
            return false;
        };
        if record.execution_target.session_instance != reference.target.session_instance {
            return false;
        }
        let mut cancelled = record.files.operations.cancel(&reference.id);
        cancelled |= record.files.edits.cancel(&reference.id);
        if let Some(item) = record.files.edit_captures.remove(&reference.id) {
            record.intents.cancel(&item.intent_id);
            cancelled = true;
        }
        if let Some(item) = record.files.inspections.remove(&reference.id) {
            record.intents.cancel(&item.intent_id);
            cancelled = true;
        }
        if let Some(item) = record.files.captures.remove(&reference.id) {
            record.intents.cancel(&item.intent_id);
            cancelled = true;
        }
        record.files.routes.remove(&reference.id);
        if let Some(token) = record
            .files
            .active
            .remove(&reference.id)
            .and_then(|token| token.upgrade())
        {
            token.store(true, Ordering::SeqCst);
            cancelled = true;
        }
        cancelled
    }
}
