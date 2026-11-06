use std::sync::{Arc, Mutex};

use ai_term_lib::app::state::AppState;
use ai_term_lib::domain::command_policy::{
    ExecutionContext, ExecutionTarget, IntentReference, InternalProbe, OperationKind, ShellDialect,
};
use ai_term_lib::domain::terminal::ssh::TerminalSession;
use anyhow::{bail, Result};

#[derive(Clone, Default)]
struct RecordingTerminal {
    writes: Arc<Mutex<Vec<Vec<u8>>>>,
    fail_after_write: bool,
}

#[tokio::test]
async fn bracketed_multiline_bytes_stay_bound_to_review_and_cannot_be_replayed() {
    use ai_term_lib::domain::command_policy::CaptureKind;
    let state = AppState::default();
    let terminal = RecordingTerminal::default();
    state
        .register_terminal_session(
            "session".into(),
            "profile".into(),
            Box::new(terminal.clone()),
        )
        .await;
    let target = known_target(&state, "session").await;
    let source = "printf 'first\\n'\n\tprintf 'second\\n'\n(exit 9)";
    let intent = state
        .analyze_captured_command_intent(
            target.clone(),
            source.into(),
            OperationKind::Command,
            CaptureKind::Bracketed,
        )
        .await
        .unwrap();
    assert_eq!(intent.capture.kind, CaptureKind::Bracketed);
    assert!(state
        .approve_command_intent(&intent.reference, "printf changed")
        .await
        .is_err());
    state
        .approve_command_intent(&intent.reference, source)
        .await
        .unwrap();
    state
        .dispatch_command_intent(&intent.reference)
        .await
        .unwrap();
    assert_eq!(
        terminal.writes.lock().unwrap().as_slice(),
        [format!("\x1b[200~{source}\x1b[201~\r").into_bytes()]
    );
    assert!(state
        .dispatch_command_intent(&intent.reference)
        .await
        .is_err());
    let target = known_target(&state, "session").await;
    let intent = state
        .analyze_captured_command_intent(
            target.clone(),
            "printf first\nprintf second".into(),
            OperationKind::Command,
            CaptureKind::None,
        )
        .await
        .unwrap();
    assert_eq!(intent.capture.kind, CaptureKind::Sentinel);
    for source in [
        "printf first\n\x1b[201~printf injected",
        "printf first\rprintf second",
    ] {
        let intent = state
            .analyze_captured_command_intent(
                target.clone(),
                source.into(),
                OperationKind::Command,
                CaptureKind::Bracketed,
            )
            .await
            .unwrap();
        assert!(state
            .approve_command_intent(&intent.reference, source)
            .await
            .is_err());
        assert!(state
            .dispatch_command_intent(&intent.reference)
            .await
            .is_err());
    }
}

#[tokio::test]
async fn fixed_readonly_probe_preserves_pending_approval_but_failed_write_invalidates_it() {
    for fail_after_write in [false, true] {
        let state = AppState::default();
        let terminal = RecordingTerminal {
            fail_after_write,
            ..Default::default()
        };
        state
            .register_terminal_session(
                "session".into(),
                "profile".into(),
                Box::new(terminal.clone()),
            )
            .await;
        let reference = approved(&state, "session").await;
        let probe = state
            .prepare_terminal_probe(reference.target.clone(), InternalProbe::Capture {})
            .await
            .unwrap();
        assert_eq!(probe.source, "(printf 'AI_TERM_CAPTURE_OK\\n'; exit 7)");
        assert!(probe.capture.internal);
        let result = state.dispatch_command_intent(&probe.reference).await;
        if fail_after_write {
            assert!(result.is_err());
            assert!(state.dispatch_command_intent(&reference).await.is_err());
            assert_eq!(terminal.writes.lock().unwrap().len(), 1);
        } else {
            result.unwrap();
            assert_eq!(
                state.command_execution_target("session").await.unwrap(),
                reference.target
            );
            state.dispatch_command_intent(&reference).await.unwrap();
            assert_eq!(terminal.writes.lock().unwrap().len(), 2);
        }
    }
}

#[test]
fn probes_cannot_accept_arbitrary_commands_or_unbounded_private_paths() {
    for json in [
        r#"{"kind":"capture","source":"anything"}"#,
        r#"{"kind":"context","internal":true}"#,
        r#"{"kind":"shell-integration","source":"anything"}"#,
    ] {
        assert!(serde_json::from_str::<InternalProbe>(json).is_err());
    }
    for path in [
        "relative",
        "/etc/../etc/shadow",
        "/etc/shadow",
        "/home/u/.ssh/id_rsa",
        "/tmp/a\ncmd",
        "/tmp/.env",
        "/tmp/config.key",
    ] {
        assert!(InternalProbe::FileSnapshot {
            paths: vec![path.into()],
            nonce: "test".into()
        }
        .source()
        .is_err());
    }
    assert!(InternalProbe::FileSnapshot {
        paths: vec!["/tmp/a".into(); 101],
        nonce: "test".into()
    }
    .source()
    .is_err());
    assert!(InternalProbe::FileSnapshot {
        paths: vec!["/tmp/a".into()],
        nonce: "bad;nonce".into()
    }
    .source()
    .is_err());
}

impl TerminalSession for RecordingTerminal {
    fn write(&mut self, bytes: &[u8]) -> Result<()> {
        self.writes.lock().unwrap().push(bytes.to_vec());
        if self.fail_after_write {
            bail!("simulated partial write");
        }
        Ok(())
    }
    fn resize(&mut self, _: u16, _: u16) -> Result<()> {
        Ok(())
    }
}

async fn known_target(state: &AppState, id: &str) -> ExecutionTarget {
    let target = state.command_execution_target(id).await.unwrap();
    state
        .update_command_context(
            &target,
            ExecutionContext {
                shell: ShellDialect::Bash,
                working_directory: Some("/srv/app".into()),
                user: Some("operator".into()),
                environment_scope: Some("host".into()),
            },
        )
        .await
        .unwrap()
}

async fn approved(state: &AppState, id: &str) -> IntentReference {
    let target = known_target(state, id).await;
    let intent = state
        .analyze_command_intent(target, "rm -rf /tmp/example".into(), OperationKind::Command)
        .await
        .unwrap();
    state
        .approve_command_intent(&intent.reference, &intent.source)
        .await
        .unwrap();
    intent.reference
}

#[tokio::test]
async fn reconnecting_same_session_id_does_not_restore_approval() {
    let state = AppState::default();
    let old = RecordingTerminal::default();
    let new = RecordingTerminal::default();
    state
        .register_terminal_session("session".into(), "profile".into(), Box::new(old.clone()))
        .await;
    let reference = approved(&state, "session").await;
    state.remove_session("session").await;
    state
        .register_terminal_session("session".into(), "profile".into(), Box::new(new.clone()))
        .await;
    assert!(state.dispatch_command_intent(&reference).await.is_err());
    assert!(old.writes.lock().unwrap().is_empty());
    assert!(new.writes.lock().unwrap().is_empty());
    assert_ne!(
        state
            .command_execution_target("session")
            .await
            .unwrap()
            .session_instance,
        reference.target.session_instance
    );
}

#[tokio::test]
async fn keyboard_input_invalidates_approval_before_dispatch() {
    let state = AppState::default();
    let terminal = RecordingTerminal::default();
    state
        .register_terminal_session(
            "session".into(),
            "profile".into(),
            Box::new(terminal.clone()),
        )
        .await;
    let reference = approved(&state, "session").await;
    state
        .write_terminal("session", b"cd /other\r".to_vec())
        .await
        .unwrap();
    assert!(state.dispatch_command_intent(&reference).await.is_err());
    assert_eq!(
        terminal.writes.lock().unwrap().as_slice(),
        &[b"cd /other\r".to_vec()]
    );
    assert_eq!(
        state
            .command_execution_target("session")
            .await
            .unwrap()
            .context
            .shell,
        ShellDialect::Unknown
    );
}

#[tokio::test]
async fn changed_context_and_stale_reports_cannot_rebind_approval() {
    let state = AppState::default();
    let terminal = RecordingTerminal::default();
    state
        .register_terminal_session(
            "session".into(),
            "profile".into(),
            Box::new(terminal.clone()),
        )
        .await;
    let reference = approved(&state, "session").await;
    let mut changed = reference.target.context.clone();
    changed.environment_scope = Some("container".into());
    state
        .update_command_context(&reference.target, changed)
        .await
        .unwrap();
    assert!(state
        .update_command_context(&reference.target, reference.target.context.clone())
        .await
        .is_err());
    assert!(state.dispatch_command_intent(&reference).await.is_err());
    assert!(terminal.writes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn approval_cannot_move_between_targets() {
    let state = AppState::default();
    let terminal = RecordingTerminal::default();
    state
        .register_terminal_session("a".into(), "profile-a".into(), Box::new(terminal.clone()))
        .await;
    state
        .register_terminal_session("b".into(), "profile-b".into(), Box::new(terminal.clone()))
        .await;
    let mut reference = approved(&state, "a").await;
    reference.target = known_target(&state, "b").await;
    assert!(state.dispatch_command_intent(&reference).await.is_err());
    assert!(terminal.writes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn concurrent_dispatch_cannot_consume_a_ticket_twice() {
    let state = AppState::default();
    let terminal = RecordingTerminal::default();
    state
        .register_terminal_session(
            "session".into(),
            "profile".into(),
            Box::new(terminal.clone()),
        )
        .await;
    let reference = approved(&state, "session").await;
    let (a, b) = tokio::join!(
        state.dispatch_command_intent(&reference),
        state.dispatch_command_intent(&reference)
    );
    assert_ne!(a.is_ok(), b.is_ok());
    assert_eq!(terminal.writes.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn failed_write_consumes_approval_and_is_not_replayed() {
    let state = AppState::default();
    let terminal = RecordingTerminal {
        fail_after_write: true,
        ..Default::default()
    };
    state
        .register_terminal_session(
            "session".into(),
            "profile".into(),
            Box::new(terminal.clone()),
        )
        .await;
    let reference = approved(&state, "session").await;
    let error = state.dispatch_command_intent(&reference).await.unwrap_err();
    assert!(error.to_string().contains("实际效果可能未知"));
    assert!(state.dispatch_command_intent(&reference).await.is_err());
    assert_eq!(terminal.writes.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn approval_fields_cannot_be_deserialized_into_a_reference() {
    let state = AppState::default();
    state
        .register_terminal_session(
            "session".into(),
            "profile".into(),
            Box::new(RecordingTerminal::default()),
        )
        .await;
    let reference = approved(&state, "session").await;
    let mut json = serde_json::to_value(&reference).unwrap();
    json["approved"] = true.into();
    assert!(serde_json::from_value::<IntentReference>(json).is_err());
}

#[tokio::test]
async fn cancellation_and_missing_terminal_never_dispatch() {
    let state = AppState::default();
    state
        .register_session("unattached".into(), "profile".into())
        .await;
    assert!(state.command_execution_target("unattached").await.is_err());
    let terminal = RecordingTerminal::default();
    state
        .register_terminal_session(
            "session".into(),
            "profile".into(),
            Box::new(terminal.clone()),
        )
        .await;
    let reference = approved(&state, "session").await;
    assert!(state.cancel_command_intent(&reference).await.unwrap());
    assert!(state.dispatch_command_intent(&reference).await.is_err());
    assert!(terminal.writes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn shell_hook_installation_invalidates_old_approvals() {
    let state = AppState::default();
    let terminal = RecordingTerminal::default();
    state
        .register_terminal_session("integration".into(), "profile".into(), Box::new(terminal))
        .await;
    let reference = approved(&state, "integration").await;
    let probe = state
        .prepare_terminal_probe(reference.target.clone(), InternalProbe::ShellIntegration {})
        .await
        .unwrap();
    assert!(probe.capture.internal);
    state
        .dispatch_command_intent(&probe.reference)
        .await
        .unwrap();
    assert!(state.dispatch_command_intent(&reference).await.is_err());
}
