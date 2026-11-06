use ai_term_lib::domain::command_policy::ExecutionTarget;
use ai_term_lib::domain::filesystem::agent_files::*;

fn target() -> ExecutionTarget {
    ExecutionTarget::new("session".into(), "profile".into())
}
fn inspection(path: &str) -> FileInspection {
    let metadata = FileMetadata {
        kind: FileKind::File,
        size: 20,
        modified_ns: Some(1),
        identity: Some("file 1".into()),
    };
    FileInspection {
        path: path.into(),
        resolved_path: path.into(),
        revision: metadata.revision(),
        metadata,
        environment: None,
        scope: "f".repeat(64),
    }
}
fn request(path: &str, cursor: Option<String>) -> FileToolRequest {
    FileToolRequest::ReadFile {
        path: path.into(),
        options: FileReadOptions::default(),
        cursor,
    }
}
fn result(inspection: &FileInspection) -> FileToolData {
    FileToolData::ReadFile {
        data: FileReadResponse {
            path: inspection.path.clone(),
            resolved_path: inspection.resolved_path.clone(),
            revision: inspection.revision.clone(),
            metadata: inspection.metadata.clone(),
            changed_during_read: false,
            page: FileReadPage {
                content: "first\n".into(),
                start: FilePosition {
                    byte: 0,
                    line: Some(1),
                    mid_line: false,
                },
                end: FilePosition {
                    byte: 6,
                    line: Some(2),
                    mid_line: false,
                },
                eof: false,
                complete: false,
                truncation: Some(FileTruncation::Lines),
                scanned_bytes: 20,
            },
        },
    }
}

#[test]
fn sensitive_approval_is_exact_single_use_and_is_not_carried_into_next_page() {
    let mut store = FileOperationStore::default();
    let target = target();
    let inspected = inspection("/home/test/.env");
    let operation = store
        .prepare(
            target.clone(),
            request(&inspected.path, None),
            FileProvider::CurrentTerminal,
            inspected.clone(),
        )
        .unwrap();
    assert!(operation.sensitive);
    assert_eq!(
        store
            .consume(&operation.reference, &target)
            .unwrap_err()
            .kind,
        FileErrorKind::SensitivePath
    );
    assert!(store
        .approve(
            &operation.reference,
            &target,
            "/other/.env",
            &inspected.revision
        )
        .is_err());
    assert!(store
        .approve(
            &operation.reference,
            &target,
            &inspected.path,
            "old version"
        )
        .is_err());
    store
        .approve(
            &operation.reference,
            &target,
            &inspected.path,
            &inspected.revision,
        )
        .unwrap();
    let dispatch = store.consume(&operation.reference, &target).unwrap();
    assert!(dispatch.terminal_request().is_ok());
    assert!(store.consume(&operation.reference, &target).is_err());
    let page = store.finish(dispatch, &target, result(&inspected)).unwrap();
    let next = store
        .prepare(
            target.clone(),
            request(&inspected.path, page.next_cursor),
            FileProvider::CurrentTerminal,
            inspected,
        )
        .unwrap();
    assert_eq!(
        store.consume(&next.reference, &target).unwrap_err().kind,
        FileErrorKind::SensitivePath
    );
}

#[test]
fn cursor_cannot_cross_target_route_context_path_provider_or_revision() {
    let mut store = FileOperationStore::default();
    let target = target();
    let inspected = inspection("/tmp/test.txt");
    let operation = store
        .prepare(
            target.clone(),
            request(&inspected.path, None),
            FileProvider::CurrentTerminal,
            inspected.clone(),
        )
        .unwrap();
    let dispatch = store.consume(&operation.reference, &target).unwrap();
    let page = store.finish(dispatch, &target, result(&inspected)).unwrap();
    let cursor = page.next_cursor.unwrap();
    let next = request(&inspected.path, Some(cursor.clone()));
    let mut changed_target = target.clone();
    changed_target.context_version += 1;
    assert_eq!(
        store
            .prepare(
                changed_target,
                next.clone(),
                FileProvider::CurrentTerminal,
                inspected.clone()
            )
            .unwrap_err()
            .kind,
        FileErrorKind::TargetChanged
    );
    let mut changed_target = target.clone();
    changed_target.route_version += 1;
    assert!(store
        .prepare(
            changed_target,
            next.clone(),
            FileProvider::CurrentTerminal,
            inspected.clone()
        )
        .is_err());
    assert!(store
        .prepare(
            target.clone(),
            request("/tmp/other", Some(cursor.clone())),
            FileProvider::CurrentTerminal,
            inspection("/tmp/other")
        )
        .is_err());
    assert!(store
        .prepare(
            target.clone(),
            next.clone(),
            FileProvider::Local,
            inspected.clone()
        )
        .is_err());
    let mut changed = inspected.clone();
    changed.revision = "new revision".into();
    assert_eq!(
        store
            .prepare(
                target.clone(),
                next.clone(),
                FileProvider::CurrentTerminal,
                changed
            )
            .unwrap_err()
            .kind,
        FileErrorKind::VersionChanged
    );
    let prepared = store
        .prepare(
            target.clone(),
            next,
            FileProvider::CurrentTerminal,
            inspected,
        )
        .unwrap();
    assert_eq!(
        store
            .consume(&prepared.reference, &target)
            .unwrap()
            .resume
            .unwrap()
            .byte,
        6
    );
}

#[test]
fn target_changes_discard_late_results_and_invalidation_clears_requests() {
    let mut store = FileOperationStore::default();
    let target = target();
    let inspected = inspection("/tmp/test.txt");
    let operation = store
        .prepare(
            target.clone(),
            request(&inspected.path, None),
            FileProvider::CurrentTerminal,
            inspected.clone(),
        )
        .unwrap();
    let dispatch = store.consume(&operation.reference, &target).unwrap();
    let replacement = ExecutionTarget::new(target.session_id.clone(), target.profile_id.clone());
    assert_eq!(
        store
            .finish(dispatch, &replacement, result(&inspected))
            .unwrap_err()
            .kind,
        FileErrorKind::TargetChanged
    );
    let operation = store
        .prepare(
            target.clone(),
            request(&inspected.path, None),
            FileProvider::CurrentTerminal,
            inspected,
        )
        .unwrap();
    store.invalidate();
    assert!(store.consume(&operation.reference, &target).is_err());
}

#[test]
fn changed_or_scan_limited_pages_never_issue_a_continuation() {
    let mut store = FileOperationStore::default();
    let target = target();
    let inspected = inspection("/tmp/test.txt");
    for mode in ["changed", "scan", "wrong path", "oversized"] {
        let operation = store
            .prepare(
                target.clone(),
                request(&inspected.path, None),
                FileProvider::CurrentTerminal,
                inspected.clone(),
            )
            .unwrap();
        let dispatch = store.consume(&operation.reference, &target).unwrap();
        let mut response = result(&inspected);
        if let FileToolData::ReadFile { data } = &mut response {
            match mode {
                "changed" => data.changed_during_read = true,
                "scan" => data.page.truncation = Some(FileTruncation::ScanBudget),
                "wrong path" => data.resolved_path = "/tmp/other".into(),
                _ => data.page.content = "x".repeat(MAX_FILE_BYTES + 1),
            }
        }
        let finished = store.finish(dispatch, &target, response);
        if mode == "changed" || mode == "scan" {
            assert!(finished.unwrap().next_cursor.is_none());
        } else {
            assert!(finished.is_err());
        }
    }
}

#[test]
fn unknown_tool_fields_and_unbounded_ranges_are_rejected() {
    assert!(serde_json::from_str::<FileToolRequest>(
        r#"{"tool":"read_file","path":"/tmp/a","command":"whoami"}"#
    )
    .is_err());
    let default: FileToolRequest =
        serde_json::from_str(r#"{"tool":"read_file","path":"/tmp/a"}"#).unwrap();
    assert!(default.validate().is_ok());
    let range: FileToolRequest = serde_json::from_str(
        r#"{"tool":"read_file","path":"/tmp/a","options":{"maxBytes":65537}}"#,
    )
    .unwrap();
    assert!(range.validate().is_err());
    let list: FileToolRequest =
        serde_json::from_str(r#"{"tool":"list_directory","path":"/tmp","limit":501}"#).unwrap();
    assert!(list.validate().is_err());
}

#[test]
fn directory_cursor_detects_reordering_even_when_metadata_revision_is_unchanged() {
    let mut store = FileOperationStore::default();
    let target = target();
    let mut inspected = inspection("/tmp/directory");
    inspected.metadata.kind = FileKind::Directory;
    let entries = |names: &[&str]| {
        names
            .iter()
            .map(|name| {
                Ok(FileDirectoryEntry {
                    name: (*name).into(),
                    kind: FileKind::File,
                    size: Some(0),
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
    };
    let request = FileToolRequest::ListDirectory {
        path: inspected.path.clone(),
        limit: 1,
        cursor: None,
    };
    let operation = store
        .prepare(
            target.clone(),
            request,
            FileProvider::CurrentTerminal,
            inspected.clone(),
        )
        .unwrap();
    let dispatch = store.consume(&operation.reference, &target).unwrap();
    let first = FileDirectoryResponse {
        path: inspected.path.clone(),
        resolved_path: inspected.path.clone(),
        revision: inspected.revision.clone(),
        changed_during_read: false,
        page: directory_page(entries(&["a", "b", "c"]), 0, 1, None).unwrap(),
    };
    let cursor = store
        .finish(
            dispatch,
            &target,
            FileToolData::ListDirectory { data: first },
        )
        .unwrap()
        .next_cursor;
    let operation = store
        .prepare(
            target.clone(),
            FileToolRequest::ListDirectory {
                path: inspected.path.clone(),
                limit: 1,
                cursor,
            },
            FileProvider::CurrentTerminal,
            inspected.clone(),
        )
        .unwrap();
    let dispatch = store.consume(&operation.reference, &target).unwrap();
    let changed = FileDirectoryResponse {
        path: inspected.path.clone(),
        resolved_path: inspected.path.clone(),
        revision: inspected.revision.clone(),
        changed_during_read: false,
        page: directory_page(entries(&["c", "b", "a"]), 1, 1, None).unwrap(),
    };
    assert_eq!(
        store
            .finish(
                dispatch,
                &target,
                FileToolData::ListDirectory { data: changed }
            )
            .unwrap_err()
            .kind,
        FileErrorKind::VersionChanged
    );
}
