#![cfg(unix)]
use ai_term_lib::domain::filesystem::agent_files::*;
use std::io::Cursor;
use std::process::Command;

fn run<T: serde::de::DeserializeOwned>(request: &TerminalFileRequest) -> FileResult<T> {
    let output = Command::new("/bin/sh")
        .args(["-c", &request.source()])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    request.parse(std::str::from_utf8(&output.stdout).unwrap())
}
fn inspect(path: &std::path::Path) -> FileInspection {
    run(&TerminalFileRequest::inspect(path.to_str().unwrap().into()).unwrap()).unwrap()
}

#[test]
fn real_terminal_reader_matches_native_page_content_and_ranges() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("literal ' $(echo never) 中文.txt");
    for source in [
        "\u{feff}first  \r\n第二行\r\nlast",
        "abc😀中文123\nnext",
        "",
        "a\n",
        "1234",
        "long",
    ]
    .map(str::to_owned)
    .into_iter()
    .chain(["line\n".repeat(250_000)])
    {
        std::fs::write(&path, &source).unwrap();
        let inspection = inspect(&path);
        for options in [
            FileReadOptions::default(),
            FileReadOptions {
                max_lines: 1,
                ..Default::default()
            },
            FileReadOptions {
                max_bytes: 4,
                ..Default::default()
            },
            FileReadOptions {
                start_line: 200_000,
                ..Default::default()
            },
            FileReadOptions {
                tail: true,
                max_lines: 2,
                max_bytes: 12,
                ..Default::default()
            },
        ] {
            let request =
                TerminalFileRequest::read(&inspection, options.clone(), None, false).unwrap();
            let result: FileReadResponse = run(&request).unwrap();
            let native = read_text_page(
                &mut Cursor::new(source.as_bytes()),
                source.len() as u64,
                &options,
                None,
                None,
            )
            .unwrap();
            assert_eq!(result.page.content, native.content);
            assert_eq!(result.page.start, native.start);
            assert_eq!(result.page.end, native.end);
            assert_eq!(result.page.eof, native.eof);
            assert_eq!(result.page.complete, native.complete);
            assert_eq!(result.page.truncation, native.truncation);
            assert!(result.page.scanned_bytes <= MAX_SCAN_BYTES + 1);
        }
    }
}

#[test]
fn real_terminal_reader_rejects_changed_scope_version_and_sensitive_alias_without_grant() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("test.txt");
    std::fs::write(&file, b"before").unwrap();
    let inspection = inspect(&file);
    if let (Some(proof), Ok(native)) = (&inspection.environment, local_file_environment()) {
        assert!(proof.matches(&native));
    }
    let mut changed = inspection.clone();
    changed.scope = "a".repeat(64);
    assert_eq!(
        run::<FileReadResponse>(
            &TerminalFileRequest::read(&changed, FileReadOptions::default(), None, false).unwrap()
        )
        .unwrap_err()
        .kind,
        FileErrorKind::TargetChanged
    );
    std::fs::write(&file, b"after").unwrap();
    assert_eq!(
        run::<FileReadResponse>(
            &TerminalFileRequest::read(&inspection, FileReadOptions::default(), None, false)
                .unwrap()
        )
        .unwrap_err()
        .kind,
        FileErrorKind::VersionChanged
    );
    let secret = directory.path().join(".env");
    std::fs::write(&secret, b"secret fixture").unwrap();
    let alias = directory.path().join("alias.txt");
    std::os::unix::fs::symlink(&secret, &alias).unwrap();
    let inspected_alias = inspect(&alias);
    assert_eq!(
        TerminalFileRequest::read(&inspected_alias, FileReadOptions::default(), None, false)
            .unwrap_err()
            .kind,
        FileErrorKind::SensitivePath
    );
    let approved =
        TerminalFileRequest::read(&inspected_alias, FileReadOptions::default(), None, true)
            .unwrap();
    assert_eq!(
        run::<FileReadResponse>(&approved).unwrap().page.content,
        "secret fixture"
    );
    std::fs::remove_file(&alias).unwrap();
    std::os::unix::fs::symlink(&file, &alias).unwrap();
    assert_eq!(
        run::<FileReadResponse>(&approved).unwrap_err().kind,
        FileErrorKind::VersionChanged
    );
}

#[test]
fn real_terminal_reader_paginates_directories_and_reports_distinct_errors() {
    let directory = tempfile::tempdir().unwrap();
    for index in 0..205 {
        std::fs::write(directory.path().join(format!("file{index}")), b"").unwrap();
    }
    let inspection = inspect(directory.path());
    let first: FileDirectoryResponse =
        run(&TerminalFileRequest::list(&inspection, 0, 100, false).unwrap()).unwrap();
    let second: FileDirectoryResponse =
        run(
            &TerminalFileRequest::list(&inspection, first.page.next_offset.unwrap(), 500, false)
                .unwrap(),
        )
        .unwrap();
    assert_eq!(first.page.entries.len(), 100);
    assert_eq!(second.page.entries.len(), 105);
    assert_eq!(second.page.next_offset, None);
    assert_eq!(
        run::<FileInspection>(
            &TerminalFileRequest::inspect(
                directory.path().join("missing").to_str().unwrap().into()
            )
            .unwrap()
        )
        .unwrap_err()
        .kind,
        FileErrorKind::Missing
    );
    let binary = directory.path().join("binary");
    std::fs::write(&binary, b"a\0b").unwrap();
    assert_eq!(
        run::<FileReadResponse>(
            &TerminalFileRequest::read(&inspect(&binary), FileReadOptions::default(), None, false)
                .unwrap()
        )
        .unwrap_err()
        .kind,
        FileErrorKind::Binary
    );
    std::fs::write(&binary, b"a\xff").unwrap();
    assert_eq!(
        run::<FileReadResponse>(
            &TerminalFileRequest::read(&inspect(&binary), FileReadOptions::default(), None, false)
                .unwrap()
        )
        .unwrap_err()
        .kind,
        FileErrorKind::UnsupportedEncoding
    );
}

#[test]
fn protocol_requires_one_fresh_complete_bounded_response() {
    let request = TerminalFileRequest::inspect("/tmp/test".into()).unwrap();
    assert_eq!(
        request
            .parse::<FileInspection>("AI_TERM_FILE_old_e30=\n")
            .unwrap_err()
            .kind,
        FileErrorKind::Unavailable
    );
    let malformed = format!("AI_TERM_FILE_{}_invalid!\n", request.nonce());
    assert!(request.parse::<FileInspection>(&malformed).is_err());
    assert!(request
        .parse::<FileInspection>(&"x".repeat(TERMINAL_FILE_OUTPUT_LIMIT + 1))
        .is_err());
    let directory = tempfile::tempdir().unwrap();
    let request = TerminalFileRequest::inspect(directory.path().to_str().unwrap().into()).unwrap();
    let output = Command::new("/bin/sh")
        .args(["-c", &request.source()])
        .output()
        .unwrap();
    let duplicate = String::from_utf8(output.stdout).unwrap().repeat(2);
    assert!(request.parse::<FileInspection>(&duplicate).is_err());
}

#[test]
fn verified_local_provider_requires_review_and_rechecks_file_version() {
    use ai_term_lib::domain::command_policy::ExecutionTarget;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join(".env");
    std::fs::write(&path, b"fixture secret").unwrap();
    let terminal = inspect(&path);
    if terminal.environment.is_none() {
        return;
    } // e.g. Linux seccomp: terminal provider only
    let inspected = inspect_local_agent_file(&terminal).unwrap();
    let target = ExecutionTarget::new("local-session".into(), "local".into());
    let mut store = FileOperationStore::default();
    let request = FileToolRequest::ReadFile {
        path: terminal.path.clone(),
        options: FileReadOptions::default(),
        cursor: None,
    };
    let operation = store
        .prepare(
            target.clone(),
            request,
            FileProvider::Local,
            inspected.clone(),
        )
        .unwrap();
    assert!(store.consume(&operation.reference, &target).is_err());
    store
        .approve(
            &operation.reference,
            &target,
            &inspected.resolved_path,
            &inspected.revision,
        )
        .unwrap();
    let permit = store
        .consume(&operation.reference, &target)
        .unwrap()
        .native_permit()
        .unwrap();
    let result =
        read_local_file_with_permit(&permit, &FileReadOptions::default(), None, None).unwrap();
    assert_eq!(result.page.content, "fixture secret");
    std::fs::write(&path, b"changed fixture").unwrap();
    assert_eq!(
        read_local_file_with_permit(&permit, &FileReadOptions::default(), None, None)
            .unwrap_err()
            .kind,
        FileErrorKind::VersionChanged
    );
}
