#![cfg(unix)]
use ai_term_lib::app::state::{
    AppState, FileCapturePlan, FileDispatchOutcome, FileEditDispatchOutcome,
};
use ai_term_lib::domain::command_policy::{
    ExecutionContext, ExecutionTarget, InternalProbe, ShellDialect,
};
use ai_term_lib::domain::filesystem::agent_files::*;
use ai_term_lib::domain::storage::sqlite::SqliteConfigStore;
use ai_term_lib::domain::terminal::ssh::TerminalSession;
use base64::Engine;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct ShellTerminal {
    output: Arc<Mutex<String>>,
    hide_native_proof: bool,
}
impl TerminalSession for ShellTerminal {
    fn write(&mut self, data: &[u8]) -> anyhow::Result<()> {
        let source = std::str::from_utf8(data)?.trim_end_matches('\r');
        let result = std::process::Command::new("/bin/sh")
            .args(["-c", source])
            .output()?;
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let mut output = String::from_utf8(result.stdout)?;
        if self.hide_native_proof {
            output = output
                .lines()
                .map(|line| {
                    let Some(prefix_end) = line
                        .strip_prefix("AI_TERM_FILE_")
                        .and_then(|rest| rest.find('_'))
                        .map(|n| n + 14)
                    else {
                        return line.to_owned();
                    };
                    let Ok(data) =
                        base64::engine::general_purpose::STANDARD.decode(&line[prefix_end..])
                    else {
                        return line.to_owned();
                    };
                    let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(&data) else {
                        return line.to_owned();
                    };
                    if value["value"].get("environment").is_some() {
                        value["value"]["environment"] = serde_json::Value::Null;
                    }
                    format!(
                        "{}{}",
                        &line[..prefix_end],
                        base64::engine::general_purpose::STANDARD
                            .encode(serde_json::to_vec(&value).unwrap())
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
        }
        *self.output.lock().unwrap() = output;
        Ok(())
    }
    fn resize(&mut self, _: u16, _: u16) -> anyhow::Result<()> {
        Ok(())
    }
}
async fn setup(force_terminal: bool) -> (AppState, ShellTerminal, ExecutionTarget) {
    let state = AppState::with_profile_store(SqliteConfigStore::new(":memory:"));
    let terminal = ShellTerminal {
        hide_native_proof: force_terminal,
        ..Default::default()
    };
    state
        .register_terminal_session("session".into(), "local".into(), Box::new(terminal.clone()))
        .await;
    let target = state.command_execution_target("session").await.unwrap();
    let target = state
        .update_command_context(
            &target,
            ExecutionContext {
                shell: ShellDialect::Posix,
                working_directory: Some("/tmp".into()),
                user: Some("fixture".into()),
                environment_scope: Some("fixture scope".into()),
            },
        )
        .await
        .unwrap();
    (state, terminal, target)
}
async fn capture(state: &AppState, terminal: &ShellTerminal, plan: &FileCapturePlan) -> String {
    state
        .dispatch_command_intent(&plan.intent.reference)
        .await
        .unwrap();
    terminal.output.lock().unwrap().clone()
}
fn request(path: &std::path::Path, cursor: Option<String>) -> FileToolRequest {
    FileToolRequest::ReadFile {
        path: path.to_str().unwrap().into(),
        options: FileReadOptions {
            max_lines: 1,
            ..Default::default()
        },
        cursor,
    }
}
async fn prepare(
    state: &AppState,
    terminal: &ShellTerminal,
    target: &ExecutionTarget,
    request: FileToolRequest,
) -> FileOperation {
    let plan = state
        .prepare_agent_file_inspection(target.clone(), request)
        .await
        .unwrap();
    let output = capture(state, terminal, &plan).await;
    state
        .finish_agent_file_inspection(plan.reference, output)
        .await
        .unwrap()
}
async fn execute(
    state: &AppState,
    terminal: &ShellTerminal,
    operation: &FileOperation,
) -> FileToolResponse {
    match state
        .dispatch_agent_file_operation(operation.reference.clone())
        .await
        .unwrap()
    {
        FileDispatchOutcome::Complete { response } => response,
        FileDispatchOutcome::Terminal { capture: plan } => {
            let output = capture(state, terminal, &plan).await;
            state
                .finish_agent_terminal_file(plan.reference, output)
                .await
                .unwrap()
        }
    }
}

#[tokio::test]
async fn production_file_flow_uses_verified_native_or_current_terminal_and_opaque_pagination() {
    for force_terminal in [false, true] {
        let (state, terminal, target) = setup(force_terminal).await;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("with space.txt");
        std::fs::write(&path, "\u{feff}first\r\nsecond").unwrap();
        let operation = prepare(&state, &terminal, &target, request(&path, None)).await;
        if force_terminal {
            assert_eq!(operation.provider, FileProvider::CurrentTerminal);
        }
        let first = execute(&state, &terminal, &operation).await;
        if let FileToolData::ReadFile { data } = &first.data {
            assert_eq!(data.page.content, "\u{feff}first\r\n");
        } else {
            panic!("wrong tool");
        }
        assert!(state
            .dispatch_agent_file_operation(operation.reference)
            .await
            .is_err());
        let next = prepare(
            &state,
            &terminal,
            &target,
            request(&path, first.next_cursor),
        )
        .await;
        let second = execute(&state, &terminal, &next).await;
        if let FileToolData::ReadFile { data } = second.data {
            assert_eq!(data.page.content, "second");
            assert!(data.page.eof);
        }
        assert!(second.next_cursor.is_none());
        assert_eq!(
            state.command_execution_target("session").await.unwrap(),
            target
        );
    }
}

#[tokio::test]
async fn sensitive_file_requires_exact_backend_review_and_late_result_cannot_cross_raw_input() {
    let (state, terminal, target) = setup(true).await;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join(".env");
    std::fs::write(&path, b"fixture secret").unwrap();
    let operation = prepare(&state, &terminal, &target, request(&path, None)).await;
    assert!(operation.sensitive);
    assert_eq!(
        state
            .dispatch_agent_file_operation(operation.reference.clone())
            .await
            .unwrap_err()
            .kind,
        FileErrorKind::SensitivePath
    );
    state
        .approve_agent_file_operation(
            &operation.reference,
            &operation.resolved_path,
            &operation.revision,
        )
        .await
        .unwrap();
    let FileDispatchOutcome::Terminal { capture: plan } = state
        .dispatch_agent_file_operation(operation.reference.clone())
        .await
        .unwrap()
    else {
        panic!("expected terminal");
    };
    let output = capture(&state, &terminal, &plan).await;
    state
        .write_terminal("session", b"true\r".to_vec())
        .await
        .unwrap();
    assert_eq!(
        state
            .finish_agent_terminal_file(plan.reference, output)
            .await
            .unwrap_err()
            .kind,
        FileErrorKind::TargetChanged
    );
    assert!(state
        .approve_agent_file_operation(
            &operation.reference,
            &operation.resolved_path,
            &operation.revision
        )
        .await
        .is_err());
}

#[tokio::test]
async fn cancelled_undispatched_and_reconnected_file_operations_cannot_be_completed() {
    let (state, terminal, target) = setup(false).await;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("a");
    std::fs::write(&path, b"a").unwrap();
    let plan = state
        .prepare_agent_file_inspection(target.clone(), request(&path, None))
        .await
        .unwrap();
    assert_eq!(
        state
            .finish_agent_file_inspection(plan.reference.clone(), "".into())
            .await
            .unwrap_err()
            .kind,
        FileErrorKind::InvalidRequest
    );
    let plan = state
        .prepare_agent_file_inspection(target.clone(), request(&path, None))
        .await
        .unwrap();
    assert!(state.cancel_agent_file_operation(&plan.reference).await);
    assert!(state
        .dispatch_command_intent(&plan.intent.reference)
        .await
        .is_err());
    let operation = prepare(&state, &terminal, &target, request(&path, None)).await;
    state
        .register_terminal_session("session".into(), "local".into(), Box::new(terminal.clone()))
        .await;
    assert_eq!(
        state
            .dispatch_agent_file_operation(operation.reference)
            .await
            .unwrap_err()
            .kind,
        FileErrorKind::TargetChanged
    );
}

#[test]
fn model_cannot_deserialize_an_application_owned_reader_or_sensitive_grant() {
    for value in [
        r#"{"kind":"file-reader","request":{"action":"read","path":"/etc/shadow","approvedPaths":["/etc/shadow","/etc/shadow"]}}"#,
        r#"{"tool":"read_file","path":"/etc/shadow","approved":true}"#,
    ] {
        assert!(serde_json::from_str::<InternalProbe>(value).is_err());
        assert!(serde_json::from_str::<FileToolRequest>(value).is_err());
    }
}

#[tokio::test]
async fn directory_pages_and_missing_file_snapshots_keep_the_observed_environment() {
    let (state, terminal, target) = setup(true).await;
    let directory = tempfile::tempdir().unwrap();
    for index in 0..3 {
        std::fs::write(directory.path().join(format!("entry {index}")), b"").unwrap();
    }
    let first = prepare(
        &state,
        &terminal,
        &target,
        FileToolRequest::ListDirectory {
            path: directory.path().to_str().unwrap().into(),
            limit: 1,
            cursor: None,
        },
    )
    .await;
    let first = execute(&state, &terminal, &first).await;
    let next = prepare(
        &state,
        &terminal,
        &target,
        FileToolRequest::ListDirectory {
            path: directory.path().to_str().unwrap().into(),
            limit: 5,
            cursor: first.next_cursor,
        },
    )
    .await;
    let next = execute(&state, &terminal, &next).await;
    if let FileToolData::ListDirectory { data } = next.data {
        assert_eq!(data.page.entries.len(), 2);
    } else {
        panic!("wrong tool result");
    }
    let missing = directory.path().join("not created yet");
    let plan = state
        .prepare_agent_file_inspection(target, request(&missing, None))
        .await
        .unwrap();
    let output = capture(&state, &terminal, &plan).await;
    let error = state
        .finish_agent_file_inspection(plan.reference, output)
        .await
        .unwrap_err();
    assert_eq!(error.kind, FileErrorKind::Missing);
    let absence = error.absence.unwrap();
    assert_eq!(absence.path, missing.to_str().unwrap());
    assert_eq!(absence.environment_scope, first.environment_scope);
}

#[tokio::test]
async fn production_edits_use_complete_baselines_manual_approval_durable_journal_and_readback() {
    for force_terminal in [false, true] {
        let (state, terminal, target) = setup(force_terminal).await;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config");
        std::fs::write(&path, "before").unwrap();
        let operation = prepare(&state, &terminal, &target, request(&path, None)).await;
        let read = execute(&state, &terminal, &operation).await;
        let proposal = state
            .prepare_agent_file_edit(
                target.clone(),
                FileEditRequest {
                    baseline_id: read.baseline_id.unwrap(),
                    change: FileChange::Replace {
                        content: "after".into(),
                    },
                },
            )
            .await
            .unwrap();
        assert!(state
            .dispatch_agent_file_edit(proposal.reference.clone())
            .await
            .is_err());
        state
            .approve_agent_file_edit(proposal.reference.clone(), proposal.review_hash)
            .await
            .unwrap();
        let completed = match state
            .dispatch_agent_file_edit(proposal.reference.clone())
            .await
            .unwrap()
        {
            FileEditDispatchOutcome::Complete { record } => record,
            FileEditDispatchOutcome::Terminal { capture: plan } => {
                assert_eq!(
                    state
                        .get_agent_file_change(proposal.reference.id.clone())
                        .await
                        .unwrap()
                        .unwrap()
                        .outcome
                        .status,
                    FileEditStatus::Unknown
                );
                let output = capture(&state, &terminal, &plan).await;
                state
                    .finish_agent_terminal_file_edit(plan.reference, output)
                    .await
                    .unwrap()
            }
        };
        assert_eq!(
            completed.outcome.status,
            FileEditStatus::Applied,
            "{completed:?}"
        );
        assert_eq!(completed.provider, read.provider);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "after");
        assert!(state
            .dispatch_agent_file_edit(proposal.reference.clone())
            .await
            .is_err());
        let persisted = state
            .get_agent_file_change(proposal.reference.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(persisted.before.as_deref(), Some("before"));
        assert_eq!(persisted.outcome.status, FileEditStatus::Applied);
        let operation = prepare(&state, &terminal, &target, request(&path, None)).await;
        let read = execute(&state, &terminal, &operation).await;
        let restore = state
            .prepare_agent_file_restore(target.clone(), read.baseline_id.unwrap(), persisted.id)
            .await
            .unwrap();
        assert!(
            state
                .dispatch_agent_file_edit(restore.reference)
                .await
                .is_err(),
            "restoration always needs fresh approval"
        );
    }
}

#[tokio::test]
async fn cancelled_terminal_write_observation_leaves_unknown_journal_and_never_retries() {
    let (state, terminal, target) = setup(true).await;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("config");
    std::fs::write(&path, "before").unwrap();
    let operation = prepare(&state, &terminal, &target, request(&path, None)).await;
    let read = execute(&state, &terminal, &operation).await;
    let proposal = state
        .prepare_agent_file_edit(
            target,
            FileEditRequest {
                baseline_id: read.baseline_id.unwrap(),
                change: FileChange::Replace {
                    content: "after".into(),
                },
            },
        )
        .await
        .unwrap();
    state
        .approve_agent_file_edit(proposal.reference.clone(), proposal.review_hash)
        .await
        .unwrap();
    let FileEditDispatchOutcome::Terminal { capture: plan } = state
        .dispatch_agent_file_edit(proposal.reference.clone())
        .await
        .unwrap()
    else {
        panic!("expected terminal")
    };
    let output = capture(&state, &terminal, &plan).await;
    state.cancel_agent_file_operation(&proposal.reference).await;
    assert!(state
        .finish_agent_terminal_file_edit(plan.reference, output)
        .await
        .is_err());
    let persisted = state
        .get_agent_file_change(proposal.reference.id.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(persisted.outcome.status, FileEditStatus::Unknown);
    assert_eq!(std::fs::read_to_string(path).unwrap(), "after");
    assert!(state
        .dispatch_agent_file_edit(proposal.reference)
        .await
        .is_err());
}
