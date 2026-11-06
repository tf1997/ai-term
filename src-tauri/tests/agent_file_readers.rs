use ai_term_lib::domain::filesystem::agent_files::*;
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, Ordering};

struct Counted {
    data: Cursor<Vec<u8>>,
    read: usize,
}
impl Read for Counted {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        let count = self.data.read(out)?;
        self.read += count;
        Ok(count)
    }
}
impl Seek for Counted {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        self.data.seek(position)
    }
}
fn counted(bytes: &[u8]) -> Counted {
    Counted {
        data: Cursor::new(bytes.to_vec()),
        read: 0,
    }
}

#[test]
fn reading_pages_preserves_exact_utf8_bom_crlf_and_no_final_newline() {
    let source = "\u{feff}中文 first\r\n  second \t\r\nlast without newline";
    let mut input = counted(source.as_bytes());
    let options = FileReadOptions {
        max_lines: 1,
        ..Default::default()
    };
    let first = read_text_page(&mut input, source.len() as u64, &options, None, None).unwrap();
    assert_eq!(first.content, "\u{feff}中文 first\r\n");
    assert_eq!(first.start.line, Some(1));
    assert_eq!(first.end.line, Some(2));
    assert!(!first.eof);
    assert!(!first.complete);
    let second = read_text_page(
        &mut input,
        source.len() as u64,
        &FileReadOptions::default(),
        Some(&first.end),
        None,
    )
    .unwrap();
    assert_eq!(format!("{}{}", first.content, second.content), source);
    assert!(second.eof);
    assert!(!second.complete);
    assert_eq!(second.end.line, Some(3));
    assert!(second.end.mid_line);
}

#[test]
fn byte_pages_never_split_a_unicode_scalar_and_make_progress_on_long_lines() {
    let source = "abc😀中文123\nnext";
    let mut input = counted(source.as_bytes());
    let options = FileReadOptions {
        max_bytes: 4,
        ..Default::default()
    };
    let mut combined = String::new();
    let mut position = None;
    for _ in 0..10 {
        let page = read_text_page(
            &mut input,
            source.len() as u64,
            &options,
            position.as_ref(),
            None,
        )
        .unwrap();
        assert!(page.content.len() <= 4);
        combined.push_str(&page.content);
        if page.eof {
            break;
        }
        assert!(page.end.byte > page.start.byte);
        position = Some(page.end);
    }
    assert_eq!(combined, source);
}

#[test]
fn line_offsets_are_scanned_under_a_hard_byte_budget() {
    let source = "line\n".repeat(500_000);
    let mut input = counted(source.as_bytes());
    let page = read_text_page(
        &mut input,
        source.len() as u64,
        &FileReadOptions {
            start_line: 490_000,
            ..Default::default()
        },
        None,
        None,
    )
    .unwrap();
    assert_eq!(page.content, "");
    assert!(!page.complete);
    assert!(!page.eof);
    assert_eq!(page.truncation, Some(FileTruncation::ScanBudget));
    assert!(input.read <= MAX_SCAN_BYTES + 1);
    let page = read_text_page(
        &mut input,
        source.len() as u64,
        &FileReadOptions {
            start_line: 3,
            max_lines: 2,
            ..Default::default()
        },
        None,
        None,
    )
    .unwrap();
    assert_eq!(page.content, "line\nline\n");
    assert_eq!(page.start.line, Some(3));
}

#[test]
fn tail_seeks_to_a_bounded_window_and_reports_partial_first_lines() {
    let source = format!("{}\nabc😀中文123\nend", "x".repeat(2_000_000));
    let mut input = counted(source.as_bytes());
    let page = read_text_page(
        &mut input,
        source.len() as u64,
        &FileReadOptions {
            max_bytes: 12,
            tail: true,
            ..Default::default()
        },
        None,
        None,
    )
    .unwrap();
    assert!(source.ends_with(&page.content));
    assert!(page.content.len() <= 12);
    assert!(page.start.mid_line);
    assert_eq!(page.start.line, None);
    assert!(!page.complete);
    assert!(page.eof);
    assert!(input.read <= 13);
    let page = read_text_page(
        &mut input,
        source.len() as u64,
        &FileReadOptions {
            max_lines: 1,
            tail: true,
            ..Default::default()
        },
        None,
        None,
    )
    .unwrap();
    assert_eq!(page.content, "end");
    assert!(!page.start.mid_line);
}

#[test]
fn empty_missing_binary_unsupported_encoding_and_cancelled_are_distinct() {
    let page = read_text_page(
        &mut Cursor::new(b""),
        0,
        &FileReadOptions::default(),
        None,
        None,
    )
    .unwrap();
    assert_eq!(page.content, "");
    assert!(page.complete);
    assert!(page.eof);
    for (bytes, kind) in [
        (vec![0], FileErrorKind::Binary),
        (vec![0xff], FileErrorKind::UnsupportedEncoding),
        (vec![0xf0, 0x9f], FileErrorKind::UnsupportedEncoding),
    ] {
        assert_eq!(
            read_text_page(
                &mut counted(&bytes),
                bytes.len() as u64,
                &FileReadOptions::default(),
                None,
                None
            )
            .unwrap_err()
            .kind,
            kind
        );
    }
    let cancel = AtomicBool::new(true);
    let mut input = counted(b"data");
    assert_eq!(
        read_text_page(
            &mut input,
            4,
            &FileReadOptions::default(),
            None,
            Some(&cancel)
        )
        .unwrap_err()
        .kind,
        FileErrorKind::Cancelled
    );
    assert_eq!(input.read, 0);
    cancel.store(false, Ordering::SeqCst);
}

#[test]
fn directory_pages_have_entry_byte_and_scan_limits_without_collecting_the_tree() {
    let entries = || {
        (0..20_000).map(|i| {
            Ok(FileDirectoryEntry {
                name: format!("item{i}"),
                kind: FileKind::File,
                size: Some(1),
            })
        })
    };
    let page = directory_page(entries(), 100, 20, None).unwrap();
    assert_eq!(page.entries.len(), 20);
    assert_eq!(page.next_offset, Some(120));
    assert_eq!(page.scanned_entries, 121);
    let page = directory_page(entries(), 9990, 500, None).unwrap();
    assert_eq!(page.entries.len(), 10);
    assert_eq!(page.next_offset, None);
    assert_eq!(page.truncation, Some(FileTruncation::ScanBudget));
    let page = directory_page(
        (0..100).map(|_| {
            Ok(FileDirectoryEntry {
                name: "界".repeat(1300),
                kind: FileKind::File,
                size: None,
            })
        }),
        0,
        100,
        None,
    )
    .unwrap();
    assert_eq!(page.truncation, Some(FileTruncation::Bytes));
    assert!(serde_json::to_vec(&page.entries).unwrap().len() <= MAX_FILE_BYTES + 500);
}

#[test]
fn local_file_versions_and_resolved_sensitive_paths_are_checked() {
    let dir = std::env::temp_dir().join(format!("ai-term-file-reader-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let file = dir.join("normal.txt");
    std::fs::write(&file, "before").unwrap();
    let first = read_local_file(
        file.to_str().unwrap(),
        &FileReadOptions::default(),
        None,
        None,
        None,
    )
    .unwrap();
    assert_eq!(first.page.content, "before");
    assert!(first.page.complete);
    std::fs::write(&file, "after-longer").unwrap();
    assert_eq!(
        read_local_file(
            file.to_str().unwrap(),
            &FileReadOptions::default(),
            None,
            Some(&first.revision),
            None
        )
        .unwrap_err()
        .kind,
        FileErrorKind::VersionChanged
    );
    assert_eq!(
        read_local_file(
            dir.join("missing").to_str().unwrap(),
            &FileReadOptions::default(),
            None,
            None,
            None
        )
        .unwrap_err()
        .kind,
        FileErrorKind::Missing
    );
    #[cfg(unix)]
    {
        std::fs::write(dir.join(".env"), "fixture-private").unwrap();
        std::os::unix::fs::symlink(dir.join(".env"), dir.join("alias")).unwrap();
        assert_eq!(
            read_local_file(
                dir.join("alias").to_str().unwrap(),
                &FileReadOptions::default(),
                None,
                None,
                None
            )
            .unwrap_err()
            .kind,
            FileErrorKind::SensitivePath
        );
        std::os::unix::fs::symlink(&file, dir.join("normal-alias")).unwrap();
        assert_eq!(
            read_local_file(
                dir.join("normal-alias").to_str().unwrap(),
                &FileReadOptions::default(),
                None,
                None,
                None
            )
            .unwrap()
            .page
            .content,
            "after-longer"
        );
    }
    assert!(
        list_local_directory(dir.to_str().unwrap(), 0, 100, None, None)
            .unwrap()
            .page
            .entries
            .iter()
            .any(|entry| entry.name == "normal.txt")
    );
    std::fs::remove_dir_all(dir).unwrap();
}
