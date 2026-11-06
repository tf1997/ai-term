use ai_term_lib::{
    app::state::AppState,
    domain::{
        ai::checkpoints::*, command_policy::ExecutionTarget, storage::sqlite::SqliteConfigStore,
        terminal::ssh::TerminalSession,
    },
};
use serde_json::json;

struct NoWriteTerminal;
impl TerminalSession for NoWriteTerminal {
    fn write(&mut self, _: &[u8]) -> anyhow::Result<()> {
        panic!("checkpoint must never dispatch a command")
    }
    fn resize(&mut self, _: u16, _: u16) -> anyhow::Result<()> {
        Ok(())
    }
}
fn start() -> AgentRunStart {
    AgentRunStart {
        run_id: uuid::Uuid::new_v4().to_string(),
        workspace_session_id: "workspace".into(),
        message_id: "message".into(),
        goal: "check fixture service".into(),
    }
}
fn update(sequence: u64, boundary: &str, phase: &str) -> AgentCheckpointUpdate {
    serde_json::from_value(json!({"expectedSequence":sequence,"boundary":boundary,"stepId":"write","state":{"status":"executing","steps":[{"id":"write","toolName":"run_command","command":"fixture-only-command","reason":"test boundary","sensitive":false,"status":"running","executionPhase":phase,"output":null,"outputTruncated":false,"exitCode":null,"failureReason":null,"workingDirectory":null,"fileRead":null,"fileEdits":[]}],"plan":null,"verifications":[],"finalText":"","error":null,"stopReason":null}})).unwrap()
}
async fn app(path: &str) -> (AppState, ExecutionTarget) {
    let state = AppState::with_profile_store(SqliteConfigStore::new(path));
    state
        .register_terminal_session("terminal".into(), "local".into(), Box::new(NoWriteTerminal))
        .await;
    let target = state.command_execution_target("terminal").await.unwrap();
    (state, target)
}

#[tokio::test]
async fn live_command_template_survives_updates_without_credentials_or_approval() {
    use ai_term_lib::domain::command_policy::{ExecutionContext, OperationKind, ShellDialect};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let path = path.to_str().unwrap();
    let (state, target) = app(path).await;
    let target = state
        .update_command_context(
            &target,
            ExecutionContext {
                shell: ShellDialect::Bash,
                working_directory: Some("/tmp".into()),
                user: Some("fixture".into()),
                environment_scope: Some("host".into()),
            },
        )
        .await
        .unwrap();
    let lease = state
        .begin_agent_run(target.clone(), start())
        .await
        .unwrap();
    let command = "export APP_PASSWORD='PRIVATE_FIXTURE_CREDENTIAL'";
    let intent = state
        .analyze_captured_command_intent(
            target.clone(),
            command.into(),
            OperationKind::Command,
            Default::default(),
        )
        .await
        .unwrap();
    let mut prepared = update(0, "prepared", "not-started");
    prepared.script_intent = Some(intent.reference.clone());
    prepared.state.steps[0].command = command.into();
    // Native analysis must enforce sensitivity even if the client omitted it.
    state
        .save_agent_checkpoint(lease.clone(), prepared)
        .await
        .unwrap();
    let store = SqliteConfigStore::new(path);
    let saved = store.get_agent_checkpoint(&lease.run_id).unwrap().unwrap();
    assert!(saved.state.steps[0].sensitive);
    let template = saved.state.steps[0].script_source.clone().unwrap();
    assert_eq!(template.secrets.len(), 1);
    assert!(!serde_json::to_string(&saved)
        .unwrap()
        .contains("PRIVATE_FIXTURE_CREDENTIAL"));
    assert!(!serde_json::to_string(&saved)
        .unwrap()
        .contains(&intent.reference.id));
    // No terminal writes/implicit approval happen while producing this source.
    state
        .cancel_command_intent(&intent.reference)
        .await
        .unwrap();
    let mut result = update(1, "result", "finished");
    result.state.steps[0].command = command.into();
    result.state.steps[0].output = Some("PRIVATE_FIXTURE_CREDENTIAL".into());
    result.state.steps[0].status = "completed".into();
    result.state.steps[0].exit_code = Some(0);
    result.state.steps[0].script_source = Some(
        ai_term_lib::domain::command_policy::analyze_reusable_command(
            "echo forged",
            ShellDialect::Bash,
        )
        .source
        .unwrap(),
    );
    state
        .save_agent_checkpoint(lease.clone(), result)
        .await
        .unwrap();
    let saved = store.get_agent_checkpoint(&lease.run_id).unwrap().unwrap();
    assert_eq!(saved.state.steps[0].script_source, Some(template));
    assert!(saved.state.steps[0].sensitive);
    assert!(saved.state.steps[0].output.is_none());
    assert!(!serde_json::to_string(&saved)
        .unwrap()
        .contains("PRIVATE_FIXTURE_CREDENTIAL"));
    drop(state);
    drop(store);
    let saved = SqliteConfigStore::new(path)
        .get_agent_checkpoint(&lease.run_id)
        .unwrap()
        .unwrap();
    assert!(saved.state.steps[0].script_source.is_some());
    let bytes = std::fs::read(path).unwrap();
    assert!(!bytes
        .windows(b"PRIVATE_FIXTURE_CREDENTIAL".len())
        .any(|part| part == b"PRIVATE_FIXTURE_CREDENTIAL"));
}

#[tokio::test]
async fn checkpoint_cannot_invent_reusable_source_or_bind_another_command_or_target() {
    use ai_term_lib::domain::command_policy::{
        analyze_reusable_command, ExecutionContext, OperationKind, ShellDialect,
    };
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let path = path.to_str().unwrap();
    let (state, target) = app(path).await;
    let target = state
        .update_command_context(
            &target,
            ExecutionContext {
                shell: ShellDialect::Bash,
                working_directory: Some("/tmp".into()),
                user: Some("fixture".into()),
                environment_scope: Some("host".into()),
            },
        )
        .await
        .unwrap();
    let lease = state
        .begin_agent_run(target.clone(), start())
        .await
        .unwrap();
    let mut forged = update(0, "prepared", "not-started");
    forged.state.steps[0].script_source =
        analyze_reusable_command("echo forged", ShellDialect::Bash).source;
    state
        .save_agent_checkpoint(lease.clone(), forged)
        .await
        .unwrap();
    let store = SqliteConfigStore::new(path);
    assert!(store
        .get_agent_checkpoint(&lease.run_id)
        .unwrap()
        .unwrap()
        .state
        .steps[0]
        .script_source
        .is_none());
    let command = "export FIXTURE=ok";
    let intent = state
        .analyze_captured_command_intent(
            target.clone(),
            command.into(),
            OperationKind::Command,
            Default::default(),
        )
        .await
        .unwrap();
    let mut bound = update(1, "before-dispatch", "dispatching");
    bound.script_intent = Some(intent.reference.clone());
    assert!(state
        .save_agent_checkpoint(lease.clone(), bound.clone())
        .await
        .is_err());
    bound.state.steps[0].command = command.into();
    bound.script_intent.as_mut().unwrap().target.context.user = Some("forged".into());
    assert!(state
        .save_agent_checkpoint(lease.clone(), bound.clone())
        .await
        .is_err());
    bound.script_intent = Some(intent.reference.clone());
    state
        .cancel_command_intent(&intent.reference)
        .await
        .unwrap();
    assert!(state
        .save_agent_checkpoint(lease.clone(), bound)
        .await
        .is_err());
    assert_eq!(
        store
            .get_agent_checkpoint(&lease.run_id)
            .unwrap()
            .unwrap()
            .sequence,
        1
    );
}

#[tokio::test]
async fn durable_boundaries_survive_restart_without_becoming_results_or_approval_tokens() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let path = path.to_str().unwrap();
    let (state, target) = app(path).await;
    let input = start();
    let id = input.run_id.clone();
    let lease = state.begin_agent_run(target, input).await.unwrap();
    assert_eq!(
        state
            .save_agent_checkpoint(lease.clone(), update(0, "prepared", "not-started"))
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        state
            .save_agent_checkpoint(lease.clone(), update(1, "before-dispatch", "dispatching"))
            .await
            .unwrap(),
        2
    );
    drop(state);
    let store = SqliteConfigStore::new(path);
    let record = store.get_agent_checkpoint(&id).unwrap().unwrap();
    assert_eq!(record.sequence, 2);
    assert_eq!(record.state.steps[0].execution_phase, "dispatching");
    assert_eq!(record.state.steps[0].exit_code, None);
    assert!(!serde_json::to_string(&record)
        .unwrap()
        .contains(&lease.token));
    let _new_owner = store.lock_agent_run(&id).unwrap();
    assert_eq!(
        store
            .list_agent_checkpoints("local", "workspace")
            .unwrap()
            .len(),
        1
    );
    assert!(store
        .list_agent_checkpoints("different-host", "workspace")
        .unwrap()
        .is_empty());
    assert!(store
        .list_agent_checkpoints("local", "different-workspace")
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn another_window_process_stale_sequence_or_old_owner_cannot_overwrite_a_run() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let path = path.to_str().unwrap();
    let (state, target) = app(path).await;
    let input = start();
    let lease = state
        .begin_agent_run(target.clone(), input.clone())
        .await
        .unwrap();
    assert!(state.begin_agent_run(target, input.clone()).await.is_err());
    let (other, target) = app(path).await;
    assert!(other.begin_agent_run(target, input).await.is_err());
    let mut forged = lease.clone();
    forged.token = "different-owner".into();
    assert!(state
        .save_agent_checkpoint(forged, update(0, "before-dispatch", "dispatching"))
        .await
        .is_err());
    state
        .save_agent_checkpoint(lease.clone(), update(0, "prepared", "not-started"))
        .await
        .unwrap();
    assert!(state
        .save_agent_checkpoint(lease.clone(), update(0, "result", "finished"))
        .await
        .is_err());
    state.release_agent_run(lease.clone()).await.unwrap();
    assert!(state
        .save_agent_checkpoint(lease, update(1, "before-dispatch", "dispatching"))
        .await
        .is_err());
}

#[tokio::test]
async fn reconnected_target_stops_new_dispatch_but_allows_existing_result_to_be_journaled() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let (state, target) = app(path.to_str().unwrap()).await;
    let lease = state.begin_agent_run(target, start()).await.unwrap();
    state
        .save_agent_checkpoint(lease.clone(), update(0, "before-dispatch", "dispatching"))
        .await
        .unwrap();
    assert!(state
        .completed_agent_checkpoint_for_message(
            "local".into(),
            "workspace".into(),
            "message".into()
        )
        .await
        .unwrap()
        .is_none());
    state
        .register_terminal_session("terminal".into(), "local".into(), Box::new(NoWriteTerminal))
        .await;
    assert!(state
        .save_agent_checkpoint(lease.clone(), update(1, "before-dispatch", "dispatching"))
        .await
        .is_err());
    let mut final_update = update(1, "finished", "finished");
    final_update.state.status = "done".into();
    final_update.state.steps[0].exit_code = Some(0);
    state
        .save_agent_checkpoint(lease.clone(), final_update)
        .await
        .unwrap();
    let source = state
        .completed_agent_checkpoint_for_message(
            "local".into(),
            "workspace".into(),
            "message".into(),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(source.run_id, lease.run_id);
    assert_eq!(source.state.steps[0].exit_code, Some(0));
    assert!(state
        .completed_agent_checkpoint_for_message(
            "different-profile".into(),
            "workspace".into(),
            "message".into()
        )
        .await
        .unwrap()
        .is_none());
    assert!(state
        .list_agent_checkpoints("local".into(), "workspace".into())
        .await
        .unwrap()
        .is_empty());
    assert!(state
        .save_agent_checkpoint(lease, update(2, "result", "finished"))
        .await
        .is_err());
}

#[test]
fn checkpoint_schema_rejects_runtime_config_capabilities_and_bounds_data_while_redacting_sensitive_steps(
) {
    let mut data = serde_json::to_value(update(0, "prepared", "not-started")).unwrap();
    data["state"]["apiKey"] = json!("PRIVATE_KEY");
    assert!(serde_json::from_value::<AgentCheckpointUpdate>(data).is_err());
    let mut data = serde_json::to_value(update(0, "prepared", "not-started")).unwrap();
    data["state"]["steps"][0]["approved"] = json!(true);
    assert!(serde_json::from_value::<AgentCheckpointUpdate>(data).is_err());
    let mut value = update(0, "prepared", "not-started");
    value.state.steps[0].sensitive = true;
    value.state.steps[0].command = "PRIVATE_COMMAND".into();
    value.state.steps[0].output = Some("PRIVATE_OUTPUT".into());
    value.sanitize().unwrap();
    assert!(!serde_json::to_string(&value).unwrap().contains("PRIVATE_"));
    value.state.steps[0].command = "x".repeat(65537);
    assert!(value.sanitize().is_err());
    let mut value = update(0, "before-dispatch", "dispatching");
    value.step_id = Some("invented".into());
    assert!(value.sanitize().is_err());
}

async fn known_app(path: &str, cwd: &str) -> (AppState, ExecutionTarget) {
    use ai_term_lib::domain::command_policy::{ExecutionContext, ShellDialect};
    let (state, target) = app(path).await;
    let target = state
        .update_command_context(
            &target,
            ExecutionContext {
                shell: ShellDialect::Bash,
                working_directory: Some(cwd.into()),
                user: Some("operator".into()),
                environment_scope: Some("host-container".into()),
            },
        )
        .await
        .unwrap();
    (state, target)
}

#[tokio::test]
async fn finished_plans_archive_cancelled_and_skipped_items_but_keep_unresolved_execution_visible()
{
    use ai_term_lib::domain::ai::recovery::checkpoint_needs_attention;
    for (status, unknown, expected) in [
        ("completed", false, false),
        ("cancelled", false, false),
        ("skipped", false, false),
        ("pending", false, true),
        ("in-progress", false, true),
        ("waiting", false, true),
        ("failed", false, true),
        ("cancelled", true, true),
        ("skipped", true, true),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.db");
        let path = path.to_str().unwrap();
        let (state, target) = known_app(path, "/tmp").await;
        let lease = state
            .begin_agent_run(target.clone(), start())
            .await
            .unwrap();
        let mut finished = update(0, "finished", "finished");
        finished.state.status = "done".into();
        finished.state.steps[0].status = "completed".into();
        finished.state.steps[0].exit_code = if unknown { None } else { Some(0) };
        finished.state.plan = Some(serde_json::from_value(json!({
            "version":2, "reason":"adjusted after inspection", "changes":[],
            "items":[{"id":"action", "description":"planned action", "status":status, "stepIds":["write"]}]
        })).unwrap());
        state
            .save_agent_checkpoint(lease.clone(), finished)
            .await
            .unwrap();
        drop(state);
        let store = SqliteConfigStore::new(path);
        let saved = store.get_agent_checkpoint(&lease.run_id).unwrap().unwrap();
        assert_eq!(
            checkpoint_needs_attention(&saved),
            expected,
            "{status}, unknown={unknown}"
        );
        assert_eq!(
            !store
                .list_agent_checkpoints("local", "workspace")
                .unwrap()
                .is_empty(),
            expected
        );
        let (state, current) = known_app(path, "/tmp").await;
        let recovered = state.recover_agent_run(current, lease.run_id, 1).await;
        assert_eq!(recovered.is_ok(), expected, "{status}, unknown={unknown}");
        if unknown {
            let recovery = recovered.unwrap().checkpoint.recovery.unwrap();
            assert_eq!(recovery.phase, "inspecting");
            assert_eq!(recovery.required_step_ids, vec!["write"]);
        }
    }
}

async fn waiting_run(state: &AppState, target: &ExecutionTarget, unknown: bool) -> AgentCheckpoint {
    let lease = state
        .begin_agent_run(target.clone(), start())
        .await
        .unwrap();
    let mut waiting = update(0, "finished", if unknown { "running" } else { "finished" });
    waiting.state.status = "waiting-input".into();
    waiting.state.final_text = "继续使用 A 还是 B 配置？".into();
    waiting.state.verifications = vec![serde_json::from_value(json!({"id":"old-check","purpose":"旧检查","required":true,"check":{"kind":"output-contains","expected":"A","stepId":"write","stream":null},"status":"passed","actual":"A","observedAt":1})).unwrap()];
    waiting.state.steps[0].status = if unknown { "running" } else { "completed" }.into();
    waiting.state.steps[0].exit_code = if unknown { None } else { Some(0) };
    waiting.state.plan = Some(serde_json::from_value(json!({"version":2,"reason":"等待选择","items":[{"id":"inspect","description":"检查配置","status":"completed","stepIds":["write"]},{"id":"configure","description":"应用配置","status":"waiting","stepIds":[]}],"changes":[]})).unwrap());
    state.save_agent_checkpoint(lease, waiting).await.unwrap();
    state
        .list_agent_checkpoints("local".into(), "workspace".into())
        .await
        .unwrap()
        .into_iter()
        .find(|record| record.state.status == "waiting-input")
        .unwrap()
}
fn reply() -> AgentRunReply {
    AgentRunReply {
        message_id: "reply-message".into(),
        assistant_message_id: "continued-answer".into(),
        text: "选择 B，先检查语法".into(),
        confirmed_plan_item_ids: vec![],
    }
}

#[tokio::test]
async fn explicit_user_plan_confirmation_is_bound_to_saved_item_and_never_resolves_unknown_execution(
) {
    for unknown in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.db");
        let path = path.to_str().unwrap();
        let (state, target) = known_app(path, "/tmp").await;
        let saved = waiting_run(&state, &target, unknown).await;
        for ids in [
            vec!["missing"],
            vec!["inspect"],
            vec!["configure", "configure"],
        ] {
            let mut invalid = reply();
            invalid.confirmed_plan_item_ids = ids.into_iter().map(str::to_owned).collect();
            assert!(state
                .reply_agent_run(
                    target.clone(),
                    saved.run_id.clone(),
                    saved.sequence,
                    invalid
                )
                .await
                .is_err());
            assert_eq!(
                SqliteConfigStore::new(path)
                    .get_agent_checkpoint(&saved.run_id)
                    .unwrap()
                    .unwrap()
                    .sequence,
                saved.sequence
            );
        }
        let mut answer = reply();
        answer.confirmed_plan_item_ids = vec!["configure".into()];
        let resumed = state
            .reply_agent_run(target, saved.run_id.clone(), saved.sequence, answer.clone())
            .await
            .unwrap();
        let checkpoint = &resumed.checkpoint;
        let plan = checkpoint.state.plan.as_ref().unwrap();
        assert_eq!(plan.version, 3);
        let item = &plan.items[1];
        assert_eq!(item.status, "completed");
        assert!(item.step_ids.is_empty());
        assert_eq!(
            item.user_confirmation.as_ref().unwrap().message_id,
            answer.message_id
        );
        assert_eq!(
            checkpoint.user_inputs[0].confirmed_plan_items[0].description,
            item.description
        );
        assert_eq!(
            checkpoint.recovery.as_ref().unwrap().phase,
            if unknown { "inspecting" } else { "continuing" }
        );
        assert_eq!(
            checkpoint
                .recovery
                .as_ref()
                .unwrap()
                .required_step_ids
                .len(),
            usize::from(unknown)
        );
        assert_eq!(checkpoint.state.verifications[0].status, "unavailable");
        let mut progress = AgentCheckpointUpdate {
            expected_sequence: checkpoint.sequence,
            boundary: "progress".into(),
            step_id: None,
            state: checkpoint.state.clone(),
            script_intent: None,
        };
        let items = &mut progress.state.plan.as_mut().unwrap().items;
        items[0].user_confirmation = items[1].user_confirmation.clone();
        state
            .save_agent_checkpoint(resumed.lease.clone(), progress.clone())
            .await
            .unwrap();
        let store = SqliteConfigStore::new(path);
        let saved = store.get_agent_checkpoint(&saved.run_id).unwrap().unwrap();
        assert!(
            saved.state.plan.as_ref().unwrap().items[0]
                .user_confirmation
                .is_none(),
            "client cannot move attribution to another item"
        );
        assert!(saved.state.plan.as_ref().unwrap().items[1]
            .user_confirmation
            .is_some());
        progress.expected_sequence = saved.sequence;
        progress.state.plan.as_mut().unwrap().items[1].description = "different work".into();
        state
            .save_agent_checkpoint(resumed.lease.clone(), progress)
            .await
            .unwrap();
        state.release_agent_run(resumed.lease).await.unwrap();
        drop(state);
        let reopened = SqliteConfigStore::new(path)
            .get_agent_checkpoint(&saved.run_id)
            .unwrap()
            .unwrap();
        assert!(
            reopened.state.plan.as_ref().unwrap().items[1]
                .user_confirmation
                .is_none(),
            "changed statement has no old confirmation"
        );
        assert_eq!(
            reopened.user_inputs[0].confirmed_plan_items[0].description,
            "应用配置"
        );
    }
}

#[tokio::test]
async fn replying_to_a_saved_question_keeps_goal_plan_and_history_but_never_approval() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let path = path.to_str().unwrap();
    let (state, target) = known_app(path, "/tmp").await;
    let waiting = waiting_run(&state, &target, false).await;
    let resumed = state
        .reply_agent_run(
            target.clone(),
            waiting.run_id.clone(),
            waiting.sequence,
            reply(),
        )
        .await
        .unwrap();
    assert_eq!(resumed.checkpoint.run_id, waiting.run_id);
    assert_eq!(resumed.checkpoint.goal, waiting.goal);
    assert_eq!(resumed.checkpoint.message_id, "continued-answer");
    assert_eq!(resumed.checkpoint.state.plan.as_ref().unwrap().version, 2);
    assert_eq!(resumed.checkpoint.state.steps[0].id, "write");
    assert_eq!(
        resumed.checkpoint.state.verifications[0].status,
        "unavailable"
    );
    assert_eq!(
        resumed.checkpoint.recovery.as_ref().unwrap().phase,
        "continuing"
    );
    assert_eq!(
        resumed.checkpoint.user_inputs[0].question,
        waiting.state.final_text
    );
    assert_eq!(resumed.checkpoint.user_inputs[0].text, reply().text);
    assert!(state
        .reply_agent_run(
            target.clone(),
            waiting.run_id.clone(),
            waiting.sequence,
            reply()
        )
        .await
        .is_err());
    let store = SqliteConfigStore::new(path);
    let mut changed = resumed.checkpoint.state.clone();
    changed.steps[0].command = "FORGED_OLD_STEP".into();
    let update = AgentCheckpointUpdate {
        script_intent: None,
        expected_sequence: resumed.lease.sequence,
        boundary: "progress".into(),
        step_id: None,
        state: changed,
    };
    state
        .save_agent_checkpoint(resumed.lease.clone(), update)
        .await
        .unwrap();
    let saved = store
        .get_agent_checkpoint(&waiting.run_id)
        .unwrap()
        .unwrap();
    assert_eq!(saved.state.steps[0].command, waiting.state.steps[0].command);
    assert_eq!(saved.user_inputs[0].text, reply().text);
    assert!(!serde_json::to_string(&saved)
        .unwrap()
        .contains(&resumed.lease.token));
    drop(state);
    drop(store);
    let saved = SqliteConfigStore::new(path)
        .get_agent_checkpoint(&waiting.run_id)
        .unwrap()
        .unwrap();
    assert_eq!(saved.user_inputs.len(), 1);
}

#[tokio::test]
async fn waiting_reply_rejects_stale_scope_and_preserves_review_for_unknown_or_reconnected_execution(
) {
    for unknown in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.db");
        let path = path.to_str().unwrap();
        let (state, target) = known_app(path, "/tmp").await;
        let waiting = waiting_run(&state, &target, unknown).await;
        assert!(state
            .reply_agent_run(target.clone(), waiting.run_id.clone(), 0, reply())
            .await
            .is_err());
        let mut wrong = target.clone();
        wrong.context.user = Some("other-user".into());
        assert!(state
            .reply_agent_run(wrong, waiting.run_id.clone(), waiting.sequence, reply())
            .await
            .is_err());
        let (active, current) = if unknown {
            (state, target)
        } else {
            drop(state);
            known_app(path, "/tmp").await
        };
        let resumed = active
            .reply_agent_run(current, waiting.run_id, waiting.sequence, reply())
            .await
            .unwrap();
        assert_eq!(
            resumed.checkpoint.recovery.as_ref().unwrap().phase,
            "inspecting"
        );
        assert_eq!(
            resumed
                .checkpoint
                .recovery
                .as_ref()
                .unwrap()
                .required_step_ids
                .len(),
            usize::from(unknown)
        );
    }
}

#[tokio::test]
async fn sensitive_replies_are_not_kept_in_checkpoint_and_invalid_inputs_do_not_consume_waiting_state(
) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let path = path.to_str().unwrap();
    let (state, target) = known_app(path, "/tmp").await;
    let waiting = waiting_run(&state, &target, false).await;
    let mut invalid = reply();
    invalid.text = "字".repeat(3000);
    assert!(state
        .reply_agent_run(
            target.clone(),
            waiting.run_id.clone(),
            waiting.sequence,
            invalid
        )
        .await
        .is_err());
    let mut secret = reply();
    secret.text = "APP_PASSWORD=PRIVATE_REPLY_CREDENTIAL".into();
    let resumed = state
        .reply_agent_run(target, waiting.run_id.clone(), waiting.sequence, secret)
        .await
        .unwrap();
    assert!(resumed.checkpoint.user_inputs[0].redacted);
    assert!(!serde_json::to_string(&resumed.checkpoint)
        .unwrap()
        .contains("PRIVATE_REPLY_CREDENTIAL"));
    assert_eq!(resumed.checkpoint.sequence, waiting.sequence + 1);
}
fn checkpoint_update(
    record: &AgentCheckpoint,
    boundary: &str,
    step: Option<AgentCheckpointStep>,
) -> AgentCheckpointUpdate {
    let mut state = record.state.clone();
    let step_id = step.as_ref().map(|step| step.id.clone());
    if let Some(step) = step {
        if let Some(previous) = state.steps.iter_mut().find(|old| old.id == step.id) {
            *previous = step;
        } else {
            state.steps.push(step);
        }
    }
    AgentCheckpointUpdate {
        script_intent: None,
        expected_sequence: record.sequence,
        boundary: boundary.into(),
        step_id,
        state,
    }
}
fn readonly_step() -> AgentCheckpointStep {
    let mut step = update(0, "prepared", "dispatching").state.steps.remove(0);
    step.id = "fresh-check".into();
    step.command = "pwd".into();
    step
}

#[tokio::test]
async fn recovery_reacquires_owner_checks_environment_and_requires_new_evidence_before_continuing()
{
    use ai_term_lib::domain::ai::recovery::RecoveryResolution;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let path = path.to_str().unwrap();
    let (state, target) = known_app(path, "/old").await;
    let start = start();
    let id = start.run_id.clone();
    let old_lease = state.begin_agent_run(target, start).await.unwrap();
    state
        .save_agent_checkpoint(
            old_lease.clone(),
            update(0, "before-dispatch", "dispatching"),
        )
        .await
        .unwrap();
    drop(state);
    let (state, current) = known_app(path, "/new").await;
    let session = state
        .recover_agent_run(current.clone(), id.clone(), 1)
        .await
        .unwrap();
    let recovery = session.checkpoint.recovery.as_ref().unwrap();
    assert_eq!(
        recovery
            .original_target
            .context
            .working_directory
            .as_deref(),
        Some("/old")
    );
    assert_eq!(
        recovery.current_target.context.working_directory.as_deref(),
        Some("/new")
    );
    assert_eq!(recovery.required_step_ids, vec!["write"]);
    assert_ne!(session.lease.token, old_lease.token);
    assert!(state
        .save_agent_checkpoint(old_lease, update(2, "result", "finished"))
        .await
        .is_err());
    assert!(state
        .recover_agent_run(current.clone(), id.clone(), 2)
        .await
        .is_err());
    assert!(state
        .confirm_agent_recovery(session.lease.clone(), current.clone(), 2, vec![])
        .await
        .is_err());
    assert!(state
        .save_agent_checkpoint(
            session.lease.clone(),
            update(2, "before-dispatch", "dispatching")
        )
        .await
        .is_err());
    let mut unsafe_step = readonly_step();
    unsafe_step.command = "touch /tmp/fixture".into();
    assert!(state
        .save_agent_checkpoint(
            session.lease.clone(),
            checkpoint_update(&session.checkpoint, "before-dispatch", Some(unsafe_step))
        )
        .await
        .is_err());
    let mut ssh_step = readonly_step();
    ssh_step.tool_name = "run_ssh_task".into();
    assert!(state
        .save_agent_checkpoint(
            session.lease.clone(),
            checkpoint_update(&session.checkpoint, "before-dispatch", Some(ssh_step))
        )
        .await
        .is_err());
    let store = SqliteConfigStore::new(path);
    state
        .save_agent_checkpoint(
            session.lease.clone(),
            checkpoint_update(
                &session.checkpoint,
                "before-dispatch",
                Some(readonly_step()),
            ),
        )
        .await
        .unwrap();
    let record = store.get_agent_checkpoint(&id).unwrap().unwrap();
    let mut evidence = readonly_step();
    evidence.status = "completed".into();
    evidence.execution_phase = "finished".into();
    evidence.exit_code = Some(0);
    evidence.output = Some("/new".into());
    state
        .save_agent_checkpoint(
            session.lease.clone(),
            checkpoint_update(&record, "result", Some(evidence)),
        )
        .await
        .unwrap();
    let mut resolution = RecoveryResolution {
        step_id: "write".into(),
        evidence_step_ids: vec!["write".into()],
        observation: "已根据新检查核对当前目录，继续尚未完成的事项".into(),
    };
    assert!(state
        .confirm_agent_recovery(
            session.lease.clone(),
            current.clone(),
            4,
            vec![resolution.clone()]
        )
        .await
        .is_err());
    resolution.evidence_step_ids = vec!["fresh-check".into()];
    let confirmed = state
        .confirm_agent_recovery(
            session.lease.clone(),
            current.clone(),
            4,
            vec![resolution.clone()],
        )
        .await
        .unwrap();
    assert_eq!(confirmed.recovery.as_ref().unwrap().phase, "continuing");
    assert_eq!(confirmed.state.steps[0].execution_phase, "dispatching");
    assert_eq!(confirmed.state.steps[0].exit_code, None);
    assert!(state
        .confirm_agent_recovery(session.lease.clone(), current.clone(), 5, vec![resolution])
        .await
        .is_err());
    state.release_agent_run(session.lease).await.unwrap();
    let reopened = state.recover_agent_run(current, id, 5).await.unwrap();
    assert!(reopened
        .checkpoint
        .recovery
        .unwrap()
        .required_step_ids
        .is_empty());
}

#[tokio::test]
async fn recovery_rejects_different_user_scope_route_and_unknown_legacy_environment() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let path = path.to_str().unwrap();
    let (state, target) = known_app(path, "/old").await;
    let start = start();
    let id = start.run_id.clone();
    let lease = state.begin_agent_run(target.clone(), start).await.unwrap();
    state
        .save_agent_checkpoint(lease.clone(), update(0, "before-dispatch", "dispatching"))
        .await
        .unwrap();
    state.release_agent_run(lease).await.unwrap();
    let store = SqliteConfigStore::new(path);
    for mutate in 0..4 {
        let mut wrong = target.clone();
        match mutate {
            0 => wrong.context.user = Some("root".into()),
            1 => wrong.context.environment_scope = Some("other-container".into()),
            2 => wrong.context.environment_scope = None,
            _ => wrong.profile_id = "other-profile".into(),
        }
        assert!(store
            .reopen_agent_checkpoint(&id, 1, wrong, "local-route-v1")
            .is_err());
    }
    assert!(store
        .reopen_agent_checkpoint(&id, 1, target.clone(), "different-route")
        .is_err());
    assert_eq!(
        store.get_agent_checkpoint(&id).unwrap().unwrap().sequence,
        1
    );
    let mut context = target.context.clone();
    context.environment_scope = None;
    let unknown = state
        .update_command_context(&target, context)
        .await
        .unwrap();
    assert!(state.recover_agent_run(unknown, id, 1).await.is_err());
}

#[tokio::test]
async fn unknown_file_requires_fresh_complete_matching_file_or_verified_absence() {
    use ai_term_lib::domain::ai::recovery::{validate_recovery_resolutions, RecoveryResolution};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let path = path.to_str().unwrap();
    let (state, target) = known_app(path, "/tmp").await;
    let start = start();
    let id = start.run_id.clone();
    let lease = state.begin_agent_run(target.clone(), start).await.unwrap();
    let mut write = update(0, "before-dispatch", "dispatching");
    write.state.steps[0].tool_name = "write_file".into();
    write.state.steps[0].file_edits.push(CheckpointFileEdit {
        change_id: None,
        path: Some("/tmp/file".into()),
        environment_scope: Some("file-scope".into()),
        revision: None,
        status: "unknown".into(),
    });
    state
        .save_agent_checkpoint(lease.clone(), write)
        .await
        .unwrap();
    state.release_agent_run(lease).await.unwrap();
    let mut record = state
        .recover_agent_run(target.clone(), id, 1)
        .await
        .unwrap()
        .checkpoint;
    let mut evidence = readonly_step();
    evidence.tool_name = "read_file".into();
    evidence.status = "completed".into();
    evidence.execution_phase = "finished".into();
    evidence.recovery_inspection = true;
    evidence.execution_target = Some(target);
    evidence.file_read = Some(CheckpointFileRead {
        path: "/tmp/file".into(),
        resolved_path: Some("/tmp/file".into()),
        revision: Some("new-revision".into()),
        environment_scope: Some("file-scope".into()),
        content: Some("current".into()),
        complete: true,
        changed_during_read: false,
        absent: false,
    });
    record.state.steps.push(evidence);
    let resolutions = vec![RecoveryResolution {
        step_id: "write".into(),
        evidence_step_ids: vec!["fresh-check".into()],
        observation: "当前文件已包含所需内容，无需重放原写入".into(),
    }];
    validate_recovery_resolutions(&record, &resolutions).unwrap();
    for case in 0..5 {
        let mut wrong = record.clone();
        let step = wrong.state.steps.last_mut().unwrap();
        let read = step.file_read.as_mut().unwrap();
        match case {
            0 => read.complete = false,
            1 => read.changed_during_read = true,
            2 => read.environment_scope = Some("other-container".into()),
            3 => {
                read.path = "/tmp/unrelated".into();
                read.resolved_path = None;
            }
            _ => step.execution_target.as_mut().unwrap().session_instance = "stale".into(),
        }
        assert!(validate_recovery_resolutions(&wrong, &resolutions).is_err());
    }
    let step = record.state.steps.last_mut().unwrap();
    step.status = "failed".into();
    let read = step.file_read.as_mut().unwrap();
    read.complete = false;
    read.content = None;
    read.revision = None;
    read.absent = true;
    validate_recovery_resolutions(&record, &resolutions).unwrap();
}

#[tokio::test]
async fn recovery_reconciles_late_durable_file_receipt_preserving_partial_batch_and_unfinished_plan(
) {
    use ai_term_lib::domain::filesystem::agent_files::FileChangeRecord;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let path = path.to_str().unwrap();
    let (state, target) = known_app(path, "/tmp").await;
    let start = start();
    let id = start.run_id.clone();
    let lease = state.begin_agent_run(target.clone(), start).await.unwrap();
    let change_id = uuid::Uuid::new_v4().to_string();
    let mut write = update(0, "finished", "dispatching");
    write.state.status = "done".into();
    write.state.steps[0].tool_name = "write_file".into();
    write.state.steps[0].file_edits = vec![
        CheckpointFileEdit {
            change_id: Some(change_id.clone()),
            path: Some("/tmp/first".into()),
            environment_scope: Some("file-scope".into()),
            revision: None,
            status: "dispatching".into(),
        },
        CheckpointFileEdit {
            change_id: None,
            path: Some("/tmp/second".into()),
            environment_scope: Some("file-scope".into()),
            revision: None,
            status: "not-started".into(),
        },
    ];
    write.state.plan = Some(CheckpointPlan {
        version: 1,
        reason: "remaining work".into(),
        items: vec![CheckpointPlanItem {
            id: "remaining".into(),
            description: "finish second file".into(),
            status: "pending".into(),
            step_ids: vec![],
            user_confirmation: None,
        }],
        changes: vec![],
    });
    state.save_agent_checkpoint(lease, write).await.unwrap();
    let store = SqliteConfigStore::new(path);
    let receipt: FileChangeRecord = serde_json::from_value(json!({ "id":change_id,"target":target,"provider":"local","path":"/tmp/first","resolvedPath":"/tmp/first","environmentScope":"file-scope","before":"before","after":"after","sensitive":false,"restoreOf":null,"outcome":{"status":"applied","revision":"verified-new-revision"},"createdAt":1 })).unwrap();
    store.save_agent_file_change(&receipt).unwrap();
    assert_eq!(
        store
            .list_agent_checkpoints("local", "workspace")
            .unwrap()
            .len(),
        1
    );
    let resumed = state.recover_agent_run(target, id, 1).await.unwrap();
    assert!(resumed
        .checkpoint
        .recovery
        .unwrap()
        .required_step_ids
        .is_empty());
    let step = &resumed.checkpoint.state.steps[0];
    assert_eq!(step.file_edits[0].status, "applied");
    assert_eq!(
        step.file_edits[0].revision.as_deref(),
        Some("verified-new-revision")
    );
    assert_eq!(step.file_edits[1].status, "not-started");
    assert_ne!(step.status, "completed");
}
