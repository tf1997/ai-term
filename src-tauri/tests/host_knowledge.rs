use ai_term_lib::{
    app::state::AppState,
    domain::{
        ai::{checkpoints::*, host_knowledge::*},
        command_policy::{ExecutionContext, ExecutionTarget, ShellDialect},
        storage::sqlite::SqliteConfigStore,
        terminal::ssh::TerminalSession,
    },
};
use serde_json::json;
fn target() -> ExecutionTarget {
    let mut target = ExecutionTarget::new("terminal".into(), "local".into());
    target.context = ExecutionContext {
        shell: ShellDialect::Bash,
        working_directory: Some("/srv/app".into()),
        user: Some("operator".into()),
        environment_scope: Some("host-container".into()),
    };
    target
}
fn scope() -> HostKnowledgeScope {
    HostKnowledgeScope::from_target(&target(), "local-route-v1".into()).unwrap()
}
fn draft(value: &str) -> HostKnowledgeDraft {
    HostKnowledgeDraft {
        valid_for_days: 90,
        id: None,
        expected_revision: None,
        kind: HostKnowledgeKind::ConfigPath,
        title: "nginx 配置".into(),
        value: value.into(),
        status: HostKnowledgeStatus::Active,
        evidence: None,
    }
}
fn edit(record: &HostKnowledge) -> HostKnowledgeDraft {
    HostKnowledgeDraft {
        valid_for_days: 90,
        id: Some(record.id.clone()),
        expected_revision: Some(record.revision),
        kind: record.kind.clone(),
        title: record.title.clone(),
        value: record.value.clone(),
        status: HostKnowledgeStatus::Active,
        evidence: record.source.as_ref().map(|s| s.evidence.clone()),
    }
}
fn record(target: &ExecutionTarget, step_id: &str, absent: bool) -> AgentCheckpoint {
    serde_json::from_value(json!({"runId":uuid::Uuid::new_v4().to_string(),"workspaceSessionId":"workspace","messageId":"message","goal":"nginx 配置","target":target,"lastTarget":target,"routeKey":"local-route-v1","sequence":3,"boundary":"finished","stepId":step_id,"createdAt":1,"updatedAt":now_ms(),"state":{"status":"done","steps":[{"id":step_id,"toolName":"read_file","executionTarget":target,"command":"","reason":"检查配置路径","sensitive":false,"status":if absent {"failed"} else {"completed"},"executionPhase":"finished","output":null,"outputTruncated":false,"exitCode":if absent {1} else {0},"failureReason":null,"workingDirectory":null,"fileRead":{"path":"/etc/nginx/nginx.conf","resolvedPath":"/etc/nginx/nginx.conf","revision":"r1","environmentScope":"file-scope","absent":absent,"complete":!absent,"changedDuringRead":false,"content":"NEVER_IMPORT_FILE_BODY"},"fileEdits":[]}],"plan":null,"verifications":[],"finalText":"","error":null,"stopReason":null}})).unwrap()
}

#[test]
fn knowledge_is_persistent_versioned_and_deleted_without_erasing_other_scopes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let store = SqliteConfigStore::new(path.to_str().unwrap());
    let saved = store
        .save_host_knowledge(scope(), draft("/etc/nginx/nginx.conf"))
        .unwrap();
    let mut updated = edit(&saved);
    updated.value = "/opt/nginx/nginx.conf".into();
    let latest = store.save_host_knowledge(scope(), updated.clone()).unwrap();
    assert!(store.save_host_knowledge(scope(), updated).is_err());
    assert!(store
        .delete_host_knowledge("local", &saved.id, saved.revision)
        .is_err());
    drop(store);
    let store = SqliteConfigStore::new(path.to_str().unwrap());
    let context = store
        .host_knowledge_context(&scope(), &target(), "nginx", None)
        .unwrap();
    assert!(context.contains("/opt/nginx/nginx.conf"));
    assert!(!context.contains("/etc/nginx/nginx.conf"));
    for changed in [
        HostKnowledgeScope {
            user: "root".into(),
            ..scope()
        },
        HostKnowledgeScope {
            environment_scope: "other-container".into(),
            ..scope()
        },
        HostKnowledgeScope {
            route_key: "different-server".into(),
            ..scope()
        },
        HostKnowledgeScope {
            profile_id: "other-profile".into(),
            ..scope()
        },
    ] {
        assert!(store
            .save_host_knowledge(changed.clone(), edit(&latest))
            .is_err());
        let value = store
            .host_knowledge_context(&changed, &target(), "nginx", None)
            .unwrap();
        assert!(!value.contains("/opt/nginx/nginx.conf"));
    }
    assert!(!store
        .delete_host_knowledge("other", &latest.id, latest.revision)
        .unwrap());
    assert!(store
        .delete_host_knowledge("local", &latest.id, latest.revision)
        .unwrap());
    assert!(store.list_host_knowledge("local").unwrap().is_empty());
    assert!(!store
        .host_knowledge_context(&scope(), &target(), "nginx", None)
        .unwrap()
        .contains("/opt/nginx"));
}

#[test]
fn source_import_accepts_metadata_only_and_requires_matching_successful_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let store = SqliteConfigStore::new(dir.path().join("db").to_str().unwrap());
    let t = target();
    let mut source = record(&t, "read", false);
    store.create_agent_checkpoint(&source).unwrap();
    let mut input = draft("/etc/nginx/nginx.conf");
    input.evidence = Some(KnowledgeEvidence {
        run_id: source.run_id.clone(),
        step_id: "read".into(),
    });
    let saved = store.save_host_knowledge(scope(), input.clone()).unwrap();
    assert_eq!(
        saved.source.as_ref().unwrap().file_scope.as_deref(),
        Some("file-scope")
    );
    assert!(!serde_json::to_string(&saved)
        .unwrap()
        .contains("NEVER_IMPORT_FILE_BODY"));
    input.value = "/invented/path".into();
    assert!(store.save_host_knowledge(scope(), input.clone()).is_err());
    input.value = "/etc/nginx/nginx.conf".into();
    for mutation in ["sensitive", "unknown-exit", "cross-user", "cross-route"] {
        source.run_id = uuid::Uuid::new_v4().to_string();
        match mutation {
            "sensitive" => source.state.steps[0].sensitive = true,
            "unknown-exit" => {
                source.state.steps[0].sensitive = false;
                source.state.steps[0].exit_code = None
            }
            "cross-user" => {
                source.state.steps[0].exit_code = Some(0);
                source.state.steps[0]
                    .execution_target
                    .as_mut()
                    .unwrap()
                    .context
                    .user = Some("other".into())
            }
            _ => {
                source.state.steps[0].execution_target = Some(t.clone());
                source.route_key = Some("changed".into())
            }
        }
        store.create_agent_checkpoint(&source).unwrap();
        input.evidence.as_mut().unwrap().run_id = source.run_id.clone();
        assert!(
            store.save_host_knowledge(scope(), input.clone()).is_err(),
            "{mutation}"
        );
    }
}

#[test]
fn newer_tool_results_invalidate_missing_paths_and_do_not_replay_after_manual_confirmation() {
    let dir = tempfile::tempdir().unwrap();
    let store = SqliteConfigStore::new(dir.path().join("db").to_str().unwrap());
    let t = target();
    let source = record(&t, "missing", true);
    store
        .save_host_knowledge(scope(), draft("/etc/nginx/nginx.conf"))
        .unwrap();
    store.create_agent_checkpoint(&source).unwrap();
    let context = store
        .host_knowledge_context(&scope(), &t, "nginx 配置", Some(&source.run_id))
        .unwrap();
    assert!(context.contains("invalid"));
    assert!(!context.contains("/etc/nginx/nginx.conf"));
    let saved = store.list_host_knowledge("local").unwrap().remove(0);
    assert_eq!(saved.status, HostKnowledgeStatus::Invalid);
    assert_eq!(saved.last_observation.as_ref().unwrap().step_id, "missing");
    store.save_host_knowledge(scope(), edit(&saved)).unwrap();
    let context = store
        .host_knowledge_context(&scope(), &t, "nginx", Some(&source.run_id))
        .unwrap();
    assert!(context.contains("/etc/nginx/nginx.conf"));
    let other_session = target();
    assert!(store
        .host_knowledge_context(&scope(), &other_session, "nginx", Some(&source.run_id))
        .is_err());
}

#[test]
fn changed_resolution_and_failed_methods_require_review_without_reactivating_old_knowledge() {
    let dir = tempfile::tempdir().unwrap();
    let store = SqliteConfigStore::new(dir.path().join("db").to_str().unwrap());
    let t = target();
    let source = record(&t, "source", false);
    store.create_agent_checkpoint(&source).unwrap();
    let mut input = draft("/etc/nginx/nginx.conf");
    input.evidence = Some(KnowledgeEvidence {
        run_id: source.run_id.clone(),
        step_id: "source".into(),
    });
    store.save_host_knowledge(scope(), input).unwrap();
    let mut observation = record(&t, "changed", false);
    observation.state.steps[0]
        .file_read
        .as_mut()
        .unwrap()
        .resolved_path = Some("/new/nginx.conf".into());
    store.create_agent_checkpoint(&observation).unwrap();
    assert!(store
        .host_knowledge_context(&scope(), &t, "nginx", Some(&observation.run_id))
        .unwrap()
        .contains("needs-review"));
    let mut method = draft("nginx -t");
    method.kind = HostKnowledgeKind::Verification;
    store.save_host_knowledge(scope(), method).unwrap();
    observation.run_id = uuid::Uuid::new_v4().to_string();
    observation.state.steps[0].file_read = None;
    observation.state.steps[0].tool_name = "run_command".into();
    observation.state.steps[0].command = "nginx -t".into();
    observation.state.steps[0].exit_code = Some(1);
    store.create_agent_checkpoint(&observation).unwrap();
    let context = store
        .host_knowledge_context(&scope(), &t, "nginx", Some(&observation.run_id))
        .unwrap();
    assert!(!context.contains("nginx -t"));
    assert!(store
        .list_host_knowledge("local")
        .unwrap()
        .iter()
        .all(|r| r.status == HostKnowledgeStatus::NeedsReview));
}

#[test]
fn budgets_relevance_and_privacy_bound_the_long_term_context() {
    let dir = tempfile::tempdir().unwrap();
    let store = SqliteConfigStore::new(dir.path().join("db").to_str().unwrap());
    for value in [
        "/home/operator/.ssh/id_rsa",
        "/srv/.env",
        "curl --token secret",
        "curl --to\"ken\" secret",
        "AWS_SECRET_ACCESS_KEY=secret command",
        "KEY=value command",
        "https://user:pass@host",
        "-----BEGIN PRIVATE KEY-----",
        "Authorization: Bearer secret",
        "多行\n环境正文",
    ] {
        let mut input = draft(value);
        input.kind = HostKnowledgeKind::DeploymentMethod;
        assert!(
            store.save_host_knowledge(scope(), input).is_err(),
            "{value}"
        );
    }
    for index in 0..12 {
        let mut input = draft(&format!("/etc/nginx/{index}"));
        input.title = format!("nginx 配置 {index}");
        store.save_host_knowledge(scope(), input).unwrap();
    }
    let context = store
        .host_knowledge_context(&scope(), &target(), "nginx 配置", None)
        .unwrap();
    assert!(context.chars().count() <= MAX_KNOWLEDGE_CONTEXT);
    let json: serde_json::Value = serde_json::from_str(&context).unwrap();
    assert!(json["entries"].as_array().unwrap().len() <= 8);
    assert!(store
        .host_knowledge_context(&scope(), &target(), "postgres", None)
        .unwrap()
        .contains("\"entries\":[]"));
    let mut unknown = target();
    unknown.context.user = None;
    assert!(HostKnowledgeScope::from_target(&unknown, "route".into()).is_err());
}

struct NoWrite;
#[test]
fn expired_knowledge_is_withdrawn_and_legacy_records_get_a_finite_confirmation_deadline() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let store = SqliteConfigStore::new(path.to_str().unwrap());
    let mut input = draft("/etc/nginx/nginx.conf");
    input.valid_for_days = 7;
    let saved = store.save_host_knowledge(scope(), input).unwrap();
    assert_eq!(
        saved.expires_at.unwrap() - saved.confirmed_at.unwrap(),
        7 * KNOWLEDGE_DAY_MS
    );
    // Simulate elapsed time on the persisted record, without a wall-clock wait.
    let mut old = serde_json::to_value(&saved).unwrap();
    old.as_object_mut().unwrap().remove("expiresAt");
    old["confirmedAt"] = json!(1);
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute(
            "UPDATE host_knowledge SET payload=?1 WHERE id=?2",
            rusqlite::params![old.to_string(), saved.id],
        )
        .unwrap();
    let context = store
        .host_knowledge_context(&scope(), &target(), "nginx", None)
        .unwrap();
    assert!(context.contains("needs-review"));
    assert!(!context.contains("/etc/nginx/nginx.conf"));
    let expired = store.list_host_knowledge("local").unwrap().remove(0);
    assert_eq!(expired.status, HostKnowledgeStatus::NeedsReview);
    assert_eq!(expired.confirmed_at, Some(1));
    assert_eq!(expired.expires_at, Some(1 + 90 * KNOWLEDGE_DAY_MS));
    assert!(expired.revision > saved.revision);
    assert!(store.save_host_knowledge(scope(), edit(&saved)).is_err());
    let confirmed = store.save_host_knowledge(scope(), edit(&expired)).unwrap();
    assert_eq!(confirmed.status, HostKnowledgeStatus::Active);
    assert!(confirmed.expires_at.unwrap() > now_ms());
    assert!(store
        .host_knowledge_context(&scope(), &target(), "nginx", None)
        .unwrap()
        .contains("/etc/nginx/nginx.conf"));
    for days in [0, 366] {
        let mut invalid = draft("/etc/x");
        invalid.valid_for_days = days;
        assert!(store.save_host_knowledge(scope(), invalid).is_err());
    }
}

impl TerminalSession for NoWrite {
    fn write(&mut self, _: &[u8]) -> anyhow::Result<()> {
        panic!("knowledge must never execute")
    }
    fn resize(&mut self, _: u16, _: u16) -> anyhow::Result<()> {
        Ok(())
    }
}
#[tokio::test]
async fn native_api_rejects_stale_and_unknown_targets_and_survives_a_new_session() {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::with_profile_store(SqliteConfigStore::new(
        dir.path().join("db").to_str().unwrap(),
    ));
    state
        .register_terminal_session("terminal".into(), "local".into(), Box::new(NoWrite))
        .await;
    let unknown = state.command_execution_target("terminal").await.unwrap();
    assert!(state
        .save_host_knowledge(unknown.clone(), draft("/etc/nginx/nginx.conf"))
        .await
        .is_err());
    let known = state
        .update_command_context(&unknown, target().context)
        .await
        .unwrap();
    state
        .save_host_knowledge(known.clone(), draft("/etc/nginx/nginx.conf"))
        .await
        .unwrap();
    let mut context = known.context.clone();
    context.user = Some("root".into());
    let changed = state.update_command_context(&known, context).await.unwrap();
    assert!(state
        .host_knowledge_context(known.clone(), "nginx".into(), None)
        .await
        .is_err());
    assert!(!state
        .host_knowledge_context(changed, "nginx".into(), None)
        .await
        .unwrap()
        .contains("/etc/nginx"));
    state
        .register_terminal_session("terminal".into(), "local".into(), Box::new(NoWrite))
        .await;
    let target = state.command_execution_target("terminal").await.unwrap();
    let fresh = state
        .update_command_context(&target, known.context)
        .await
        .unwrap();
    assert!(state
        .host_knowledge_context(fresh, "nginx".into(), None)
        .await
        .unwrap()
        .contains("/etc/nginx"));
}
