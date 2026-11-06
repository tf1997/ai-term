use super::*;

// A reviewed SFTP write performs fresh environment, path, content and metadata
// checks both before and after writing. These sequential round trips exceeded
// the reader's 20s limit on a real WAN connection. Keep all checks and a bounded,
// cancellable observation window; a timeout still never replays the mutation.
const FILE_EDIT_TASK_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum FileEditDispatchOutcome {
    Complete { record: FileChangeRecord },
    Terminal { capture: FileCapturePlan },
}
pub(super) struct EditCapture {
    dispatch: FileEditDispatch,
    helper: TerminalFileEditRequest,
    pub(super) intent_id: String,
    pub(super) dispatched: bool,
    pub(super) created: Instant,
}
impl AppState {
    pub async fn prepare_agent_file_edit(
        &self,
        expected: ExecutionTarget,
        request: FileEditRequest,
    ) -> FileResult<FileEditProposal> {
        let mut sessions = self.sessions.lock().await;
        let record = file_session(&mut sessions, &expected)?;
        record.files.edits.prepare(&expected, request)
    }
    pub async fn prepare_agent_file_restore(
        &self,
        expected: ExecutionTarget,
        baseline_id: String,
        change_id: String,
    ) -> FileResult<FileEditProposal> {
        let change = self
            .get_agent_file_change(change_id)
            .await?
            .ok_or_else(|| unavailable("文件变更记录不存在"))?;
        let mut sessions = self.sessions.lock().await;
        let record = file_session(&mut sessions, &expected)?;
        record
            .files
            .edits
            .prepare_restore(&expected, &baseline_id, &change)
    }
    pub async fn approve_agent_file_edit(
        &self,
        reference: FileOperationReference,
        review_hash: String,
    ) -> FileResult<()> {
        let mut sessions = self.sessions.lock().await;
        let record = file_session(&mut sessions, &reference.target)?;
        record
            .files
            .edits
            .approve(&reference, &record.execution_target, &review_hash)
    }
    pub async fn get_agent_file_change(&self, id: String) -> FileResult<Option<FileChangeRecord>> {
        run_store_task(
            self.store("文件变更记录").map_err(unavailable)?,
            move |store| store.get_agent_file_change(&id),
        )
        .await
        .map_err(unavailable)
    }
    pub async fn list_agent_file_changes(
        &self,
        profile_id: String,
        limit: u32,
    ) -> FileResult<Vec<FileChangeRecord>> {
        run_store_task(
            self.store("文件变更记录").map_err(unavailable)?,
            move |store| store.list_agent_file_changes(&profile_id, limit),
        )
        .await
        .map_err(unavailable)
    }
    async fn save_file_change(&self, record: FileChangeRecord) -> FileResult<()> {
        run_store_task(
            self.store("文件变更记录").map_err(unavailable)?,
            move |store| store.save_agent_file_change(&record),
        )
        .await
        .map_err(unavailable)
    }
    pub async fn dispatch_agent_file_edit(
        &self,
        reference: FileOperationReference,
    ) -> FileResult<FileEditDispatchOutcome> {
        let store = self.store("文件变更记录").map_err(unavailable)?;
        let registration = self
            .scoped_task(Some(reference.id.clone()))
            .map_err(unavailable)?;
        let dispatch = {
            let mut sessions = self.sessions.lock().await;
            let record = file_session(&mut sessions, &reference.target)?;
            FileError::cancelled(Some(&registration.token))?;
            let dispatch = record
                .files
                .edits
                .consume(&reference, &record.execution_target)?;
            record
                .files
                .active
                .insert(reference.id.clone(), Arc::downgrade(&registration.token));
            dispatch
        };
        // A write is never started without durable full pre/postimages (or a
        // redacted sensitive record). This row is evidence, not a retry queue.
        let journal = dispatch.record(FileEditOutcome {
            status: FileEditStatus::Dispatching,
            revision: None,
            content_hash: None,
            before_attributes: None,
            after_attributes: None,
            error: None,
        });
        self.save_file_change(journal).await?;
        let preparation = async {
            let profile = if dispatch.proposal().provider == FileProvider::Sftp {
                Some(
                    self.get_connection_profile(&reference.target.profile_id)
                        .await
                        .map_err(unavailable)?
                        .ok_or_else(|| unavailable("连接配置已删除"))?,
                )
            } else {
                None
            };
            let mut sessions = self.sessions.lock().await;
            let record = file_session(&mut sessions, &reference.target)?;
            FileError::cancelled(Some(&registration.token))?;
            let capture = if dispatch.proposal().provider == FileProvider::CurrentTerminal {
                let helper = TerminalFileEditRequest::from_dispatch(&dispatch)?;
                let prepared =
                    IntentStore::prepare_file_edit(helper.clone(), record.execution_target.clone());
                let intent = record
                    .intents
                    .insert(prepared, &record.execution_target)
                    .map_err(unavailable)?;
                record.files.edit_captures.insert(
                    reference.id.clone(),
                    EditCapture {
                        dispatch: dispatch.clone(),
                        helper,
                        intent_id: intent.reference.id.clone(),
                        dispatched: false,
                        created: Instant::now(),
                    },
                );
                Some(FileCapturePlan {
                    reference: reference.clone(),
                    intent,
                    max_output_chars: TERMINAL_FILE_OUTPUT_LIMIT,
                })
            } else {
                None
            };
            Ok::<_, FileError>((profile, capture))
        }
        .await;
        let (profile, capture) = match preparation {
            Ok(value) => value,
            Err(error) => {
                let record = dispatch.record(FileEditOutcome::failure(error, false));
                self.save_file_change(record.clone()).await?;
                return Ok(FileEditDispatchOutcome::Complete { record });
            }
        };
        if let Some(capture) = capture {
            return Ok(FileEditDispatchOutcome::Terminal { capture });
        }
        let token = registration.token.clone();
        let worker_token = token.clone();
        let worker = dispatch.clone();
        // The worker saves its final result even if the caller stops observing,
        // a target invalidates, or the UI's bounded wait expires.
        let handle = tokio::task::spawn_blocking(move || -> FileResult<FileChangeRecord> {
            let started = AtomicBool::new(false);
            let outcome = match profile {
                Some(profile) => sftp::edit_agent_file_sftp(
                    &profile,
                    &SftpTargetOverride::default(),
                    &worker,
                    Some(&worker_token),
                    &started,
                ),
                None => edit_local_file(&worker, Some(&worker_token), &started),
            };
            let record = worker.record(outcome);
            store.save_agent_file_change(&record).map_err(unavailable)?;
            Ok(record)
        });
        let observed = bounded_task_for(&token, FILE_EDIT_TASK_TIMEOUT, async {
            handle.await.map_err(unavailable)?
        })
        .await;
        let record = match observed {
            Ok(record) => record,
            Err(error) => dispatch.record(FileEditOutcome::failure(error, true)),
        };
        // Do not rewrite an eventual worker result with an observer timeout.
        Ok(FileEditDispatchOutcome::Complete { record })
    }
    pub async fn finish_agent_terminal_file_edit(
        &self,
        reference: FileOperationReference,
        output: String,
    ) -> FileResult<FileChangeRecord> {
        let capture = {
            let mut sessions = self.sessions.lock().await;
            let record = file_session(&mut sessions, &reference.target)?;
            let capture = record
                .files
                .edit_captures
                .remove(&reference.id)
                .ok_or_else(|| {
                    unavailable("编辑观察已取消或环境已改变，请核对变更记录和当前文件")
                })?;
            if !capture.dispatched || capture.dispatch.proposal().reference != reference {
                return Err(unavailable("文件编辑尚未派发，不能接受写入结果"));
            }
            capture
        };
        let outcome = capture
            .helper
            .parse(&output)
            .map(|value| capture.dispatch.validate_outcome(value))
            .unwrap_or_else(|error| FileEditOutcome::failure(error, true));
        let record = capture.dispatch.record(outcome);
        self.save_file_change(record.clone()).await?;
        Ok(record)
    }
}
