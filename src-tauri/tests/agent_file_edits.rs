#![cfg(unix)]
use ai_term_lib::domain::command_policy::ExecutionTarget;
use ai_term_lib::domain::filesystem::agent_files::*;
use ai_term_lib::domain::storage::sqlite::SqliteConfigStore;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::Path;
use std::sync::atomic::AtomicBool;

fn shell<T: serde::de::DeserializeOwned>(helper: &TerminalFileRequest) -> FileResult<T> {
    let result = std::process::Command::new("/bin/sh")
        .args(["-c", &helper.source()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    helper.parse(std::str::from_utf8(&result.stdout).unwrap())
}
fn baseline(
    store: &mut FileEditStore,
    target: &ExecutionTarget,
    path: &Path,
    provider: FileProvider,
) -> String {
    let helper = TerminalFileRequest::inspect(path.to_str().unwrap().into()).unwrap();
    let inspected: FileInspection = match shell(&helper) {
        Ok(inspected) => inspected,
        Err(error) if error.kind == FileErrorKind::Missing => {
            return store
                .register_absence(target, &error.absence.unwrap())
                .unwrap()
        }
        Err(error) => panic!("{error:?}"),
    };
    let inspected = if provider == FileProvider::Local {
        inspect_local_agent_file(&inspected).unwrap()
    } else {
        inspected
    };
    let request = FileToolRequest::ReadFile {
        path: path.to_str().unwrap().into(),
        options: FileReadOptions {
            max_lines: MAX_FILE_BYTES,
            ..Default::default()
        },
        cursor: None,
    };
    let mut operations = FileOperationStore::default();
    let operation = operations
        .prepare(target.clone(), request, provider, inspected)
        .unwrap();
    if operation.sensitive {
        operations
            .approve(
                &operation.reference,
                target,
                &operation.resolved_path,
                &operation.revision,
            )
            .unwrap();
    }
    let dispatch = operations.consume(&operation.reference, target).unwrap();
    let data = match provider {
        FileProvider::Local => read_local_file_with_permit(
            &dispatch.native_permit().unwrap(),
            &FileReadOptions {
                max_lines: MAX_FILE_BYTES,
                ..Default::default()
            },
            None,
            None,
        )
        .unwrap(),
        FileProvider::CurrentTerminal => shell(&dispatch.terminal_request().unwrap()).unwrap(),
        _ => unreachable!(),
    };
    let response = operations
        .finish(dispatch.clone(), target, FileToolData::ReadFile { data })
        .unwrap();
    store.register_read(dispatch, None, &response).unwrap()
}
fn approve(
    store: &mut FileEditStore,
    target: &ExecutionTarget,
    proposal: &FileEditProposal,
) -> FileEditDispatch {
    assert!(store.consume(&proposal.reference, target).is_err());
    assert!(store
        .approve(&proposal.reference, target, "other review")
        .is_err());
    store
        .approve(&proposal.reference, target, &proposal.review_hash)
        .unwrap();
    let dispatch = store.consume(&proposal.reference, target).unwrap();
    assert!(store.consume(&proposal.reference, target).is_err());
    dispatch
}
fn execute(dispatch: &FileEditDispatch) -> FileEditOutcome {
    if dispatch.proposal().provider == FileProvider::Local {
        edit_local_file(dispatch, None, &AtomicBool::new(false))
    } else {
        let helper = TerminalFileEditRequest::from_dispatch(dispatch).unwrap();
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", &helper.source()])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        dispatch.validate_outcome(
            helper
                .parse(std::str::from_utf8(&output.stdout).unwrap())
                .unwrap(),
        )
    }
}
fn target() -> ExecutionTarget {
    ExecutionTarget::new("session".into(), "local".into())
}
fn replace(
    store: &mut FileEditStore,
    target: &ExecutionTarget,
    baseline_id: String,
    content: &str,
) -> FileEditProposal {
    store
        .prepare(
            target,
            FileEditRequest {
                baseline_id,
                change: FileChange::Replace {
                    content: content.into(),
                },
            },
        )
        .unwrap()
}

#[test]
fn local_and_terminal_patch_preserve_exact_bytes_permissions_and_require_fresh_restore_approval() {
    for provider in [FileProvider::Local, FileProvider::CurrentTerminal] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("literal ' $(never) 中文.txt");
        let source = "\u{feff}first  \r\nsecond\r\nlast";
        std::fs::write(&path, source).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
        let mut store = FileEditStore::default();
        let target = target();
        let baseline_id = baseline(&mut store, &target, &path, provider);
        let proposal = store
            .prepare(
                &target,
                FileEditRequest {
                    baseline_id,
                    change: FileChange::Patch {
                        replacements: vec![TextReplacement {
                            old_text: "second".into(),
                            new_text: "第二行".into(),
                        }],
                    },
                },
            )
            .unwrap();
        let dispatch = approve(&mut store, &target, &proposal);
        let outcome = execute(&dispatch);
        assert_eq!(outcome.status, FileEditStatus::Applied, "{outcome:?}");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "\u{feff}first  \r\n第二行\r\nlast"
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o7777,
            0o640
        );
        let record = dispatch.record(outcome);
        let fresh = baseline(&mut store, &target, &path, provider);
        let restore = store.prepare_restore(&target, &fresh, &record).unwrap();
        assert_eq!(restore.restore_of.as_deref(), Some(record.id.as_str()));
        let restored = execute(&approve(&mut store, &target, &restore));
        assert_eq!(restored.status, FileEditStatus::Applied, "{restored:?}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), source);
    }
}

#[test]
fn approval_does_not_override_external_content_permission_or_path_changes() {
    for provider in [FileProvider::Local, FileProvider::CurrentTerminal] {
        for scenario in ["content", "permission", "symlink"] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("config");
            std::fs::write(&path, "before").unwrap();
            let mut store = FileEditStore::default();
            let target = target();
            let baseline_id = baseline(&mut store, &target, &path, provider);
            let proposal = replace(&mut store, &target, baseline_id, "after");
            let dispatch = approve(&mut store, &target, &proposal);
            match scenario {
                "content" => std::fs::write(&path, "externally changed").unwrap(),
                "permission" => {
                    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o400)).unwrap()
                }
                _ => {
                    let other = dir.path().join("other");
                    std::fs::write(&other, "before").unwrap();
                    std::fs::remove_file(&path).unwrap();
                    symlink(other, &path).unwrap();
                }
            }
            let outcome = execute(&dispatch);
            assert_eq!(
                outcome.status,
                FileEditStatus::Conflict,
                "{provider:?} {scenario}: {outcome:?}"
            );
            assert_ne!(std::fs::read_to_string(&path).unwrap(), "after");
        }
    }
}

#[test]
fn create_delete_and_restore_are_distinct_operations_and_absence_is_rechecked() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("new-config");
    let mut store = FileEditStore::default();
    let target = target();
    let missing = baseline(&mut store, &target, &path, FileProvider::CurrentTerminal);
    let create = replace(&mut store, &target, missing.clone(), "created\n");
    let dispatch = approve(&mut store, &target, &create);
    let result = execute(&dispatch);
    assert_eq!(result.status, FileEditStatus::Applied, "{result:?}");
    assert!(result.before_attributes.is_none());
    let stale_create = replace(&mut store, &target, missing, "must not overwrite");
    assert_eq!(
        execute(&approve(&mut store, &target, &stale_create)).status,
        FileEditStatus::Conflict
    );
    // A local deletion can be inverted via a newly verified terminal absence;
    // that new operation still reads and writes through one provider.
    let read = baseline(&mut store, &target, &path, FileProvider::Local);
    let delete = store
        .prepare(
            &target,
            FileEditRequest {
                baseline_id: read,
                change: FileChange::Delete {},
            },
        )
        .unwrap();
    let deletion = approve(&mut store, &target, &delete);
    let result = execute(&deletion);
    assert_eq!(result.status, FileEditStatus::Applied, "{result:?}");
    assert!(!path.exists());
    let record = deletion.record(result);
    let missing = baseline(&mut store, &target, &path, FileProvider::CurrentTerminal);
    let restore = store
        .prepare_restore(&target, &missing, &record)
        .unwrap_or_else(|error| panic!("{error:?}; attrs={:?}", record.outcome.before_attributes));
    let result = execute(&approve(&mut store, &target, &restore));
    assert_eq!(result.status, FileEditStatus::Applied, "{result:?}");
    assert_eq!(std::fs::read_to_string(path).unwrap(), "created\n");
}

#[test]
fn strict_patch_target_and_restore_conflicts_cannot_be_bypassed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config");
    std::fs::write(&path, "same same").unwrap();
    let target = target();
    let mut store = FileEditStore::default();
    let baseline_id = baseline(&mut store, &target, &path, FileProvider::Local);
    assert!(store
        .prepare(
            &target,
            FileEditRequest {
                baseline_id: baseline_id.clone(),
                change: FileChange::Patch {
                    replacements: vec![TextReplacement {
                        old_text: "same".into(),
                        new_text: "different".into()
                    }]
                }
            }
        )
        .is_err());
    let mut other = target.clone();
    other.profile_id = "other".into();
    assert!(store
        .prepare(
            &other,
            FileEditRequest {
                baseline_id: baseline_id.clone(),
                change: FileChange::Delete {}
            }
        )
        .is_err());
    let proposal = replace(&mut store, &target, baseline_id, "after");
    let dispatch = approve(&mut store, &target, &proposal);
    let record = dispatch.record(execute(&dispatch));
    std::fs::write(&path, "external edit").unwrap();
    let fresh = baseline(&mut store, &target, &path, FileProvider::Local);
    assert!(store.prepare_restore(&target, &fresh, &record).is_err());
    store.invalidate();
    assert!(store.prepare_restore(&target, &fresh, &record).is_err());
}

#[test]
fn persisted_dispatch_is_unknown_sensitive_images_are_removed_and_final_result_is_not_downgraded() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config");
    std::fs::write(&path, "before").unwrap();
    let target = target();
    let mut store = FileEditStore::default();
    let baseline_id = baseline(&mut store, &target, &path, FileProvider::Local);
    let proposal = replace(&mut store, &target, baseline_id, "after");
    let dispatch = approve(&mut store, &target, &proposal);
    let mut pending = dispatch.record(FileEditOutcome::failure(
        FileError::new(FileErrorKind::Unavailable, "pending"),
        true,
    ));
    pending.outcome.status = FileEditStatus::Dispatching;
    let database = SqliteConfigStore::new(dir.path().join("changes.sqlite").to_str().unwrap());
    database.initialize().unwrap();
    database.save_agent_file_change(&pending).unwrap();
    assert_eq!(
        database
            .get_agent_file_change(&pending.id)
            .unwrap()
            .unwrap()
            .outcome
            .status,
        FileEditStatus::Unknown
    );
    let result = dispatch.record(execute(&dispatch));
    database.save_agent_file_change(&result).unwrap();
    database.save_agent_file_change(&pending).unwrap();
    let persisted = database.get_agent_file_change(&result.id).unwrap().unwrap();
    assert_eq!(persisted.outcome.status, FileEditStatus::Applied);
    assert_eq!(persisted.before.as_deref(), Some("before"));
    let mut sensitive = result.clone();
    sensitive.id = "sensitive".into();
    sensitive.sensitive = true;
    database.save_agent_file_change(&sensitive).unwrap();
    let persisted = database
        .get_agent_file_change("sensitive")
        .unwrap()
        .unwrap();
    assert!(persisted.before.is_none() && persisted.after.is_none());
    assert_eq!(
        database.list_agent_file_changes("local", 10).unwrap().len(),
        2
    );
}

#[test]
fn precommit_cancellation_and_malformed_receipts_do_not_report_success() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config");
    std::fs::write(&path, "before").unwrap();
    let target = target();
    let mut store = FileEditStore::default();
    let baseline_id = baseline(&mut store, &target, &path, FileProvider::Local);
    let proposal = replace(&mut store, &target, baseline_id, "after");
    let dispatch = approve(&mut store, &target, &proposal);
    let started = AtomicBool::new(false);
    let result = edit_local_file(&dispatch, Some(&AtomicBool::new(true)), &started);
    assert_eq!(result.status, FileEditStatus::Failed);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "before");
    let mut result = execute(&dispatch);
    result.content_hash = Some("fabricated".into());
    assert_eq!(
        dispatch.validate_outcome(result).status,
        FileEditStatus::Unknown
    );
}

#[test]
fn partial_changed_or_unseen_bytes_never_create_an_edit_baseline() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config");
    std::fs::write(&path, "complete\n").unwrap();
    let inspection: FileInspection =
        shell(&TerminalFileRequest::inspect(path.to_str().unwrap().into()).unwrap()).unwrap();
    let target = target();
    let mut operations = FileOperationStore::default();
    let request = FileToolRequest::ReadFile {
        path: path.to_str().unwrap().into(),
        options: FileReadOptions::default(),
        cursor: None,
    };
    let operation = operations
        .prepare(
            target.clone(),
            request,
            FileProvider::CurrentTerminal,
            inspection,
        )
        .unwrap();
    let dispatch = operations.consume(&operation.reference, &target).unwrap();
    let data = shell(&dispatch.terminal_request().unwrap()).unwrap();
    let response = operations
        .finish(dispatch.clone(), &target, FileToolData::ReadFile { data })
        .unwrap();
    for scenario in [
        "partial",
        "changed",
        "truncated",
        "missing bytes",
        "wrong target",
    ] {
        let mut response = response.clone();
        let FileToolData::ReadFile { data } = &mut response.data else {
            unreachable!()
        };
        match scenario {
            "partial" => data.page.complete = false,
            "changed" => data.changed_during_read = true,
            "truncated" => data.page.truncation = Some(FileTruncation::Bytes),
            "missing bytes" => data.page.content = "complete".into(),
            _ => response.target.context_version += 1,
        }
        assert!(
            FileEditStore::default()
                .register_read(dispatch.clone(), None, &response)
                .is_none(),
            "{scenario}"
        );
    }
    assert!(FileEditStore::default()
        .register_read(dispatch, None, &response)
        .is_some());
}

#[test]
fn terminal_payload_bounds_escape_expansion_and_preserves_control_bytes() {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config");
    std::fs::write(&path, "before").unwrap();
    let mut store = FileEditStore::default();
    let target = target();
    let id = baseline(&mut store, &target, &path, FileProvider::CurrentTerminal);
    let after = "\u{1b}".repeat(MAX_FILE_BYTES);
    let proposal = replace(&mut store, &target, id, &after);
    let dispatch = approve(&mut store, &target, &proposal);
    let helper = TerminalFileEditRequest::from_dispatch(&dispatch).unwrap();
    let source = helper.source();
    assert!(
        source.len() < 196608,
        "JSON escaping must not expand terminal argv without bound"
    );
    let mut process = Command::new("/bin/sh")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    process
        .stdin
        .take()
        .unwrap()
        .write_all(source.as_bytes())
        .unwrap();
    let output = process.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result = helper
        .parse(std::str::from_utf8(&output.stdout).unwrap())
        .unwrap();
    assert_eq!(result.status, FileEditStatus::Applied, "{result:?}");
    assert_eq!(std::fs::read_to_string(path).unwrap(), after);
}

#[test]
fn extended_permissions_survive_edits_and_deletion_restore_uses_complete_metadata_backup() {
    for provider in [FileProvider::Local, FileProvider::CurrentTerminal] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("with-extra-permissions");
        std::fs::write(&path, "before").unwrap();
        #[cfg(target_os = "macos")]
        assert!(std::process::Command::new("chmod")
            .args(["+a", "everyone allow read"])
            .arg(&path)
            .status()
            .unwrap()
            .success());
        #[cfg(target_os = "linux")]
        assert!(std::process::Command::new("python3")
            .args([
                "-c",
                "import os,sys; os.setxattr(sys.argv[1], 'user.ai_term_fixture', b'metadata')"
            ])
            .arg(&path)
            .status()
            .unwrap()
            .success());
        let target = target();
        let mut store = FileEditStore::default();
        let id = baseline(&mut store, &target, &path, provider);
        let proposal = replace(&mut store, &target, id, "after");
        let edit = approve(&mut store, &target, &proposal);
        let result = execute(&edit);
        assert_eq!(result.status, FileEditStatus::Applied, "{result:?}");
        assert_eq!(
            result.before_attributes.unwrap().extended_metadata,
            Some(true)
        );
        assert_eq!(
            result.after_attributes.unwrap().extended_metadata,
            Some(true)
        );
        let id = baseline(&mut store, &target, &path, provider);
        let proposal = store
            .prepare(
                &target,
                FileEditRequest {
                    baseline_id: id,
                    change: FileChange::Delete {},
                },
            )
            .unwrap();
        let delete = approve(&mut store, &target, &proposal);
        let result = execute(&delete);
        assert_eq!(result.status, FileEditStatus::Applied, "{result:?}");
        let change = delete.record(result);
        let missing = baseline(&mut store, &target, &path, FileProvider::CurrentTerminal);
        let mut incomplete = change.clone();
        incomplete
            .outcome
            .before_attributes
            .as_mut()
            .unwrap()
            .metadata_backup = None;
        assert!(store
            .prepare_restore(&target, &missing, &incomplete)
            .is_err());
        let restore = store.prepare_restore(&target, &missing, &change).unwrap();
        let restored = execute(&approve(&mut store, &target, &restore));
        assert_eq!(restored.status, FileEditStatus::Applied, "{restored:?}");
        assert_eq!(restored.after_attributes, change.outcome.before_attributes);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "after");
    }
}
