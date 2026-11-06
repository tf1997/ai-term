use ai_term_lib::domain::{
    storage::sqlite::SqliteConfigStore,
    workspace::{task_script::ScriptTaskMetadata, UpdateScript},
};
use serde_json::json;

fn metadata() -> serde_json::Value {
    json!({ "version":1,"revision":1,"source":{"runId":uuid::Uuid::new_v4().to_string(),"messageId":"answer","workspaceSessionId":"workspace","stepIds":["verified"]},"environment":{"profileId":"host","routeKey":"route","user":"operator","environmentScope":"container","shell":"bash"},"parameters":[{"name":"TOKEN","label":"外部凭据","type":"secret","defaultValue":"MUST_NOT_PERSIST","required":true}],"checks":[{"id":"health","purpose":"验证状态","kind":"output-contains","expected":"healthy","stepId":"verified","required":true,"status":"passed"}],"prerequisites":["检查当前部署状态"] })
}
#[test]
fn script_provenance_survives_old_schema_migration_and_content_revisions_without_secret_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    rusqlite::Connection::open(&path).unwrap().execute_batch("CREATE TABLE update_scripts (id TEXT PRIMARY KEY,connection_id TEXT NOT NULL,workspace_session_id TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL,content TEXT NOT NULL,source_commands_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);").unwrap();
    let store = SqliteConfigStore::new(path.to_string_lossy());
    let mut script: UpdateScript = serde_json::from_value(json!({"id":"script","connectionId":"host","workspaceSessionId":"workspace","name":"task.sh","description":"from completed steps","content":"printf '%s' __AI_TERM_PARAM_TOKEN__","sourceCommands":["whoami"],"createdAt":"now","updatedAt":"now","taskMetadata":metadata()})).unwrap();
    store.save_update_script(&script).unwrap();
    let first = store.get_update_script("script").unwrap().unwrap();
    assert_eq!(first.task_metadata.as_ref().unwrap().revision, 1);
    assert!(!serde_json::to_string(&first)
        .unwrap()
        .contains("MUST_NOT_PERSIST"));
    store.save_update_script(&script).unwrap();
    assert_eq!(
        store
            .get_update_script("script")
            .unwrap()
            .unwrap()
            .task_metadata
            .unwrap()
            .revision,
        1
    );
    script.content.push_str("\nprintf done\n");
    store.save_update_script(&script).unwrap();
    drop(store);
    let store = SqliteConfigStore::new(path.to_string_lossy());
    let saved = store.list_update_scripts().unwrap().remove(0);
    let metadata = saved.task_metadata.unwrap();
    assert_eq!(metadata.revision, 2);
    assert_eq!(metadata.source.step_ids, vec!["verified"]);
    assert_eq!(metadata.checks[0].expected, "healthy");
    let mut old = serde_json::to_value(&script).unwrap();
    old.as_object_mut().unwrap().remove("taskMetadata");
    old["id"] = json!("legacy");
    store
        .save_update_script(&serde_json::from_value(old).unwrap())
        .unwrap();
    assert!(store
        .get_update_script("legacy")
        .unwrap()
        .unwrap()
        .task_metadata
        .is_none());
}
#[test]
fn provenance_rejects_extra_authority_fields_and_invalid_parameters() {
    let mut raw = metadata();
    raw["approved"] = json!(true);
    assert!(serde_json::from_value::<ScriptTaskMetadata>(raw).is_err());
    let mut raw = metadata();
    raw["parameters"][0]["name"] = json!("BAD;CMD");
    assert!(serde_json::from_value::<ScriptTaskMetadata>(raw)
        .unwrap()
        .sanitize()
        .is_err());
}

#[test]
fn omission_history_survives_storage_and_revisions_with_all_source_references_and_fixed_reasons() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("scripts.sqlite3");
    let mut data = metadata();
    data["omittedSteps"] = json!((0..999).map(|index| json!({
        "stepId":format!("{index:x<256}"), "tool":"run_ssh_task", "status":"completed", "reason":"unsupported-tool"
    })).collect::<Vec<_>>());
    data["omittedChecks"] = json!([{ "id":"omitted-health", "stepId":format!("{:x<256}", 0), "required":true, "status":"passed" }]);
    let mut script: UpdateScript = serde_json::from_value(json!({"id":"with-omissions","connectionId":"host","workspaceSessionId":"workspace","name":"partial.sh","description":"selected steps only","content":"printf ready","sourceCommands":["printf ready"],"createdAt":"now","updatedAt":"now","taskMetadata":data})).unwrap();
    let store = SqliteConfigStore::new(path.to_string_lossy());
    store.save_update_script(&script).unwrap();
    script.content.push_str("\nprintf checked");
    store.save_update_script(&script).unwrap();
    drop(store);
    let saved = SqliteConfigStore::new(path.to_string_lossy())
        .get_update_script(&script.id)
        .unwrap()
        .unwrap();
    let saved = saved.task_metadata.unwrap();
    assert_eq!(saved.revision, 2);
    assert_eq!(saved.omitted_steps.len(), 999);
    assert_eq!(saved.omitted_steps[998].step_id, format!("{:x<256}", 998));
    assert_eq!(saved.omitted_steps[998].reason, "unsupported-tool");
    assert_eq!(saved.source.step_ids, vec!["verified"]);
    assert!(saved.omitted_checks[0].required);
    assert_eq!(saved.omitted_checks[0].id, "omitted-health");
    assert!(serde_json::to_vec(&saved).unwrap().len() > 65536);
}

#[test]
fn omission_schema_rejects_duplicate_or_selected_ids_raw_source_unknown_reasons_and_excess_data() {
    let item = json!({"stepId":"other", "tool":"run_ssh_task", "status":"completed", "reason":"unsupported-tool"});
    for invalid in [
        json!({"command":"PRIVATE_SOURCE"}),
        json!({"approved":true}),
    ] {
        let mut with_extra = item.clone();
        with_extra
            .as_object_mut()
            .unwrap()
            .extend(invalid.as_object().unwrap().clone());
        let mut data = metadata();
        data["omittedSteps"] = json!([with_extra]);
        assert!(serde_json::from_value::<ScriptTaskMetadata>(data).is_err());
    }
    for (field, value) in [
        ("stepId", "verified"),
        ("tool", "terminal_write"),
        ("reason", "PRIVATE_FREEFORM_TEXT"),
        ("status", "invented"),
    ] {
        let mut changed = item.clone();
        changed[field] = json!(value);
        let mut data = metadata();
        data["omittedSteps"] = json!([changed]);
        assert!(serde_json::from_value::<ScriptTaskMetadata>(data)
            .unwrap()
            .sanitize()
            .is_err());
    }
    let mut duplicate = metadata();
    duplicate["omittedSteps"] = json!([item.clone(), item]);
    assert!(serde_json::from_value::<ScriptTaskMetadata>(duplicate)
        .unwrap()
        .sanitize()
        .is_err());
    let mut oversized = metadata();
    oversized["prerequisites"] = json!(["x".repeat(512 * 1024)]);
    assert!(serde_json::from_value::<ScriptTaskMetadata>(oversized)
        .unwrap()
        .sanitize()
        .is_err());
    let mut data = metadata();
    data["omittedChecks"] =
        json!([{ "id":"omitted-health", "stepId":"verified", "required":true, "status":"passed" }]);
    assert!(serde_json::from_value::<ScriptTaskMetadata>(data.clone())
        .unwrap()
        .sanitize()
        .is_err());
    data["omittedChecks"][0]["stepId"] = json!("missing-source");
    assert!(serde_json::from_value::<ScriptTaskMetadata>(data.clone())
        .unwrap()
        .sanitize()
        .is_err());
    data["omittedChecks"][0]["stepId"] = serde_json::Value::Null;
    data["omittedChecks"][0]["expected"] = json!("PRIVATE_CHECK_CONTENT");
    assert!(serde_json::from_value::<ScriptTaskMetadata>(data).is_err());
}
