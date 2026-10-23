//! Run with AI_TERM_SFTP_FIXTURE_PYTHON pointing to a Python with paramiko, then
//! `cargo test --lib protocol_tests -- --ignored --test-threads=1`.
use super::*;
use crate::domain::terminal::ssh::with_test_known_hosts;
use std::io::{BufRead, BufReader};
use std::process::{Child as ProcessChild, Command, Stdio};
use std::thread;

struct Fixture {
    child: ProcessChild,
    directory: PathBuf,
    root: PathBuf,
    known_hosts: PathBuf,
    audit: PathBuf,
    port: u16,
}

impl Fixture {
    fn start() -> Self {
        Self::start_with_args(&[])
    }

    fn start_with_args(options: &[&str]) -> Self {
        let python = std::env::var_os("AI_TERM_SFTP_FIXTURE_PYTHON").expect(
            "set AI_TERM_SFTP_FIXTURE_PYTHON to an isolated Python with paramiko installed",
        );
        let parent = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/sftp-fixtures");
        fs::create_dir_all(&parent).unwrap();
        // libssh2/OpenSSH consume ordinary Windows paths, not Rust's verbatim
        // \\?\ paths returned by canonicalize(). Cleanup canonicalizes separately.
        let directory = parent.join(Uuid::new_v4().to_string());
        let root = directory.join("root");
        fs::create_dir_all(root.join("stall-readdir")).unwrap();
        fs::write(root.join("hello.txt"), b"hello from SFTP\n").unwrap();
        fs::write(
            root.join("stall-read.txt"),
            b"must not write after cancellation",
        )
        .unwrap();
        let audit = directory.join("audit.jsonl");
        let error_log = directory.join("server-error.log");
        let mut command = Command::new(python);
        command
            .arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sftp_server.py"))
            .arg("--root")
            .arg(&root)
            .arg("--audit")
            .arg(&audit)
            .args(options)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(File::create(&error_log).unwrap());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let ready: serde_json::Value = serde_json::from_str(&line).unwrap_or_else(|error| {
            panic!(
                "fixture failed to start: {error}; {}",
                fs::read_to_string(error_log).unwrap_or_default()
            )
        });
        Self {
            child,
            known_hosts: directory.join("known_hosts"),
            directory,
            root,
            audit,
            port: ready["port"].as_u64().unwrap() as u16,
        }
    }

    fn profile(&self) -> ConnectionProfile {
        let endpoint = AuthEndpoint {
            host: "127.0.0.1".into(),
            port: Some(self.port),
            username: "fixture".into(),
            auth_mode: AuthMode::Password,
            credential_ref: None,
            password: Some("fixture-password".into()),
        };
        ConnectionProfile {
            id: self.directory.to_string_lossy().into(),
            name: "loopback fixture".into(),
            connection_role: ConnectionRole::Direct,
            target: endpoint.clone(),
            gateway: endpoint,
            jump_mode: JumpMode::Direct,
            menu_profile_id: String::new(),
            file_transfer_mode: FileTransferMode::SftpDirect,
        }
    }

    fn event_count(&self, event: &str) -> usize {
        event_count(&self.audit, event)
    }

    fn cli_plan(&self) -> SftpLaunchPlan {
        let mut plan = build_sftp_launch_plan(&self.profile());
        // Tests cannot load a user's SSH config, agent or default private keys.
        plan.args.splice(
            0..0,
            [
                "-F".into(),
                "none".into(),
                "-o".into(),
                "PubkeyAuthentication=no".into(),
            ],
        );
        plan
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if std::thread::panicking() {
            eprintln!(
                "fixture audit: {}",
                fs::read_to_string(&self.audit).unwrap_or_default()
            );
            eprintln!(
                "fixture stderr: {}",
                fs::read_to_string(self.directory.join("server-error.log")).unwrap_or_default()
            );
        }
        clear_cached_native_sftp_routes(&self.profile(), &SftpTargetOverride::default());
        let _ = self.child.kill();
        let _ = self.child.wait();
        // Verify the absolute cleanup target is a direct child of our test root.
        let parent = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/sftp-fixtures");
        if let (Ok(parent), Ok(target)) = (parent.canonicalize(), self.directory.canonicalize()) {
            if target.parent() == Some(parent.as_path()) {
                let _ = fs::remove_dir_all(target);
            }
        }
    }
}

fn event_count(audit: &Path, event: &str) -> usize {
    fs::read_to_string(audit)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|entry| entry["event"].as_str() == Some(event))
        .count()
}

fn wait_event(audit: &Path, event: &str) {
    let started = Instant::now();
    while event_count(audit, event) == 0 {
        assert!(
            started.elapsed() < Duration::from_secs(8),
            "fixture did not report {event}: {}",
            fs::read_to_string(audit).unwrap_or_default()
        );
        thread::sleep(Duration::from_millis(5));
    }
}

#[test]
#[ignore = "requires isolated Python/paramiko loopback fixture"]
fn native_protocol_roundtrip_and_cache_reuse_do_not_retain_old_cancellation() {
    let fixture = Fixture::start();
    with_test_known_hosts(fixture.known_hosts.clone(), || {
        let profile = fixture.profile();
        let target = SftpTargetOverride::default();
        let first_token = Arc::new(AtomicBool::new(false));
        let probe = probe_sftp_with_cancel(&profile, &target, Some(&first_token));
        assert!(probe.available, "{}", probe.message);
        assert_eq!(probe.profile_route, sftp_profile_route(&profile));
        let first = list_directory_with_cancel(&profile, "/", &target, Some(&first_token)).unwrap();
        assert!(first.entries.iter().any(|entry| entry.name == "hello.txt"));
        first_token.store(true, Ordering::SeqCst);
        let second_token = Arc::new(AtomicBool::new(false));
        let second =
            list_directory_with_cancel(&profile, "/", &target, Some(&second_token)).unwrap();
        assert_eq!(first, second);

        let upload = fixture.directory.join("upload file.txt");
        fs::write(&upload, b"roundtrip payload\n").unwrap();
        create_directory_with_cancel(&profile, "/created", &target, Some(&second_token)).unwrap();
        upload_file_to_remote_path_with_cancel(
            &profile,
            upload.to_str().unwrap(),
            "/created/upload file.txt",
            &target,
            Some(&second_token),
        )
        .unwrap();
        let downloaded = fixture.directory.join("downloaded.txt");
        download_file_with_cancel(
            &profile,
            "/created/upload file.txt",
            downloaded.to_str().unwrap(),
            &target,
            Some(&second_token),
        )
        .unwrap();
        assert_eq!(fs::read(&upload).unwrap(), fs::read(downloaded).unwrap());
        let read = read_remote_text_file_with_cancel(
            &profile,
            "/created/upload file.txt",
            &target,
            Some(&second_token),
        )
        .unwrap();
        let saved = save_remote_text_file_with_cancel(
            &profile,
            &read.path,
            "edited\n",
            &read.revision,
            false,
            &target,
            Some(&second_token),
        )
        .unwrap();
        assert_ne!(read.revision, saved.revision);
        assert_eq!(
            fs::read(fixture.root.join("created/upload file.txt")).unwrap(),
            b"edited\n"
        );
        let conflict = save_remote_text_file_with_cancel(
            &profile,
            &read.path,
            "stale\n",
            &read.revision,
            false,
            &target,
            Some(&second_token),
        )
        .unwrap_err();
        assert!(conflict.to_string().starts_with(REMOTE_FILE_CHANGED_PREFIX));
        delete_path_with_cancel(&profile, &read.path, false, &target, Some(&second_token)).unwrap();
        delete_path_with_cancel(&profile, "/created", true, &target, Some(&second_token)).unwrap();
        assert!(!fixture.root.join("created").exists());
        assert_eq!(
            fixture.event_count("connect"),
            1,
            "all operations should reuse the same SSH/SFTP channel"
        );
    });
}

#[test]
#[ignore = "requires isolated Python/paramiko loopback fixture"]
fn native_cancellation_stops_stalled_sftp_read_without_route_retry_or_late_write() {
    let fixture = Fixture::start();
    let token = Arc::new(AtomicBool::new(false));
    let cancel_token = token.clone();
    let audit = fixture.audit.clone();
    let cancel = thread::spawn(move || {
        wait_event(&audit, "stall-read");
        let at = Instant::now();
        cancel_token.store(true, Ordering::SeqCst);
        at
    });
    let destination = fixture.directory.join("cancelled-download.txt");
    let result = with_test_known_hosts(fixture.known_hosts.clone(), || {
        download_file_with_cancel(
            &fixture.profile(),
            "/stall-read.txt",
            destination.to_str().unwrap(),
            &SftpTargetOverride::default(),
            Some(&token),
        )
    });
    assert!(format!("{:#}", result.unwrap_err()).contains("cancelled"));
    assert!(cancel.join().unwrap().elapsed() < Duration::from_secs(1));
    wait_event(&fixture.audit, "disconnect");
    assert_eq!(fixture.event_count("connect"), 1);
    assert_eq!(fs::metadata(destination).unwrap().len(), 0);
}

#[tokio::test]
#[ignore = "requires isolated Python/paramiko loopback fixture"]
async fn command_deadline_interrupts_real_cached_sftp_io_without_task_id() {
    let fixture = Fixture::start();
    with_test_known_hosts(fixture.known_hosts.clone(), || {
        list_directory(&fixture.profile(), "/", &SftpTargetOverride::default())
    })
    .unwrap();
    let profile = fixture.profile();
    let known_hosts = fixture.known_hosts.clone();
    let state = crate::app::state::AppState::default();
    let started = Instant::now();
    let result = crate::app::sftp_task::run_sftp_task(
        &state,
        None,
        Duration::from_millis(250),
        async { Ok(profile) },
        move |profile, token| {
            with_test_known_hosts(known_hosts, || {
                list_directory_with_cancel(
                    &profile,
                    "/stall-readdir",
                    &SftpTargetOverride::default(),
                    Some(&token),
                )
            })
        },
    )
    .await;
    assert!(result.unwrap_err().contains("timed out"));
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(state.active_task_count(), 0);
    assert_eq!(fixture.event_count("stall-readdir"), 1);
    wait_event(&fixture.audit, "disconnect");
    assert_eq!(fixture.event_count("connect"), 1);
}

#[test]
#[ignore = "requires isolated Python/paramiko loopback fixture"]
fn native_failed_write_is_not_replayed_on_another_route_or_cli_backend() {
    let fixture = Fixture::start();
    let source = fixture.directory.join("source.txt");
    fs::write(&source, b"write may already have reached the server").unwrap();
    let result = with_test_known_hosts(fixture.known_hosts.clone(), || {
        upload_file_to_remote_path_with_cancel(
            &fixture.profile(),
            source.to_str().unwrap(),
            "/fail-write.txt",
            &SftpTargetOverride::default(),
            None,
        )
    });
    assert!(format!("{:#}", result.unwrap_err()).contains(SFTP_ACTION_STARTED));
    assert_eq!(fixture.event_count("connect"), 1);
    assert_eq!(fixture.event_count("write"), 1);
}

#[test]
#[ignore = "requires isolated Python/paramiko loopback fixture"]
fn parallel_folder_upload_preserves_nested_files_and_monotonic_progress() {
    let fixture = Fixture::start_with_args(&["--write-delay-ms", "5"]);
    let source = fixture.directory.join("many files");
    fs::create_dir_all(source.join("nested/empty")).unwrap();
    for index in 0..64 {
        fs::write(
            source.join(format!("nested/file {index}.bin")),
            vec![index as u8; 32 * 1024],
        )
        .unwrap();
    }
    let large = vec![0xab; 8 * 1024 * 1024];
    fs::write(source.join("large.bin"), &large).unwrap();
    fs::write(source.join("empty.txt"), []).unwrap();
    let mut updates = Vec::new();
    let start = Instant::now();
    let result = with_test_known_hosts(fixture.known_hosts.clone(), || {
        upload_path_with_progress(
            &fixture.profile(),
            source.to_str().unwrap(),
            "/",
            &SftpTargetOverride::default(),
            None,
            Some(&mut |update| updates.push(update)),
        )
    })
    .unwrap();
    eprintln!(
        "folder upload: {} ms, {} connections",
        start.elapsed().as_millis(),
        fixture.event_count("connect")
    );
    assert!(result.is_dir);
    assert_eq!(fixture.event_count("connect"), 4);
    assert_eq!(
        fixture.event_count("open"),
        66,
        "each file is uploaded once"
    );
    let uploaded = fixture.root.join("many files");
    assert!(uploaded.join("nested/empty").is_dir());
    assert!(fs::read(uploaded.join("empty.txt")).unwrap().is_empty());
    assert_eq!(fs::read(uploaded.join("large.bin")).unwrap(), large);
    for index in 0..64 {
        assert_eq!(
            fs::read(uploaded.join(format!("nested/file {index}.bin"))).unwrap(),
            vec![index as u8; 32 * 1024]
        );
    }
    let counts: Vec<_> = updates
        .iter()
        .filter_map(|update| update.transferred_bytes)
        .collect();
    assert!(counts.windows(2).all(|pair| pair[0] <= pair[1]));
    assert_eq!(counts.last(), Some(&(10 * 1024 * 1024)));
    assert_eq!(updates.last().unwrap().percent, Some(100));
}

#[test]
#[ignore = "requires isolated Python/paramiko loopback fixture"]
fn folder_upload_degrades_to_one_connection_when_server_limits_sessions() {
    let fixture = Fixture::start_with_args(&["--max-connections", "1"]);
    let source = fixture.directory.join("limited");
    fs::create_dir(&source).unwrap();
    for index in 0..12 {
        fs::write(source.join(format!("{index}.txt")), b"payload").unwrap();
    }
    with_test_known_hosts(fixture.known_hosts.clone(), || {
        upload_path(
            &fixture.profile(),
            source.to_str().unwrap(),
            "/",
            &SftpTargetOverride::default(),
        )
    })
    .unwrap();
    assert_eq!(fixture.event_count("connect"), 1);
    assert_eq!(fixture.event_count("connection-rejected"), 1);
    for index in 0..12 {
        assert_eq!(
            fs::read(fixture.root.join(format!("limited/{index}.txt"))).unwrap(),
            b"payload"
        );
    }
}

#[tokio::test]
#[ignore = "requires isolated Python/paramiko loopback fixture"]
async fn idle_timeout_stops_all_parallel_upload_workers() {
    let fixture = Fixture::start();
    let source = fixture.directory.join("stalled");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("stall-write.txt"), vec![0; 1024 * 1024]).unwrap();
    for index in 0..12 {
        fs::write(source.join(format!("{index}.txt")), b"ok").unwrap();
    }
    let profile = fixture.profile();
    let known_hosts = fixture.known_hosts.clone();
    let state = crate::app::state::AppState::default();
    let result = crate::app::sftp_task::run_sftp_transfer_task(
        &state,
        None,
        Duration::from_secs(2),
        async { Ok(profile) },
        move |profile, token, activity| {
            with_test_known_hosts(known_hosts, || {
                upload_path_with_progress(
                    &profile,
                    source.to_str().unwrap(),
                    "/",
                    &SftpTargetOverride::default(),
                    Some(&token),
                    Some(&mut |_| activity.touch()),
                )
            })
        },
    )
    .await;
    assert!(result.unwrap_err().contains("no progress"));
    assert_eq!(state.active_task_count(), 0);
    assert_eq!(fixture.event_count("stall-write"), 1);
    let count = fixture.event_count("open");
    thread::sleep(Duration::from_millis(100));
    assert_eq!(
        fixture.event_count("open"),
        count,
        "no late uploads after timeout"
    );
    assert_eq!(
        fixture.event_count("disconnect"),
        fixture.event_count("connect")
    );
}

#[test]
#[ignore = "requires isolated Python/paramiko loopback fixture"]
fn upload_close_error_is_reported_instead_of_false_success() {
    let fixture = Fixture::start();
    let source = fixture.directory.join("fail-close.txt");
    fs::write(&source, b"payload").unwrap();
    let result = with_test_known_hosts(fixture.known_hosts.clone(), || {
        upload_file(
            &fixture.profile(),
            source.to_str().unwrap(),
            "/",
            &SftpTargetOverride::default(),
        )
    });
    assert!(format!("{:#}", result.unwrap_err()).contains("failed to close"));
    assert_eq!(
        fixture.event_count("open"),
        1,
        "a failed upload is never replayed"
    );
}

#[tokio::test]
#[ignore = "requires isolated Python/paramiko loopback fixture"]
async fn large_upload_with_real_progress_outlives_the_initial_idle_budget() {
    let fixture = Fixture::start_with_args(&["--write-delay-ms", "20"]);
    let source = fixture.directory.join("large.bin");
    let bytes = vec![0xa5; 4 * 1024 * 1024];
    fs::write(&source, &bytes).unwrap();
    let profile = fixture.profile();
    let known_hosts = fixture.known_hosts.clone();
    let state = crate::app::state::AppState::default();
    let started = Instant::now();
    crate::app::sftp_task::run_sftp_transfer_task(
        &state,
        None,
        Duration::from_secs(1),
        async { Ok(profile) },
        move |profile, token, activity| {
            with_test_known_hosts(known_hosts, || {
                upload_path_with_progress(
                    &profile,
                    source.to_str().unwrap(),
                    "/",
                    &SftpTargetOverride::default(),
                    Some(&token),
                    Some(&mut |_| activity.touch()),
                )
            })
        },
    )
    .await
    .unwrap();
    assert!(started.elapsed() > Duration::from_secs(2));
    assert_eq!(fs::read(fixture.root.join("large.bin")).unwrap(), bytes);
    assert_eq!(state.active_task_count(), 0);
}

#[test]
#[ignore = "requires isolated Python/paramiko loopback fixture"]
fn compare_serial_and_parallel_many_file_uploads() {
    let mut elapsed = Vec::new();
    for max_connections in ["1", "4"] {
        let fixture = Fixture::start_with_args(&[
            "--write-delay-ms",
            "10",
            "--max-connections",
            max_connections,
        ]);
        let source = fixture.directory.join("batch");
        fs::create_dir(&source).unwrap();
        for index in 0..200 {
            fs::write(source.join(format!("{index}.bin")), vec![index as u8; 8192]).unwrap();
        }
        let started = Instant::now();
        with_test_known_hosts(fixture.known_hosts.clone(), || {
            upload_path(
                &fixture.profile(),
                source.to_str().unwrap(),
                "/",
                &SftpTargetOverride::default(),
            )
        })
        .unwrap();
        elapsed.push(started.elapsed());
        assert_eq!(
            fixture.event_count("connect"),
            max_connections.parse::<usize>().unwrap()
        );
        assert_eq!(fixture.event_count("open"), 200);
        for index in 0..200 {
            assert_eq!(
                fs::read(fixture.root.join(format!("batch/{index}.bin"))).unwrap(),
                vec![index as u8; 8192]
            );
        }
    }
    // Report timings, but do not impose machine-load-sensitive speed assertions.
    eprintln!(
        "200-file fixture (10 ms/write): serial {:?}, parallel {:?}, speedup {:.2}x",
        elapsed[0],
        elapsed[1],
        elapsed[0].as_secs_f64() / elapsed[1].as_secs_f64()
    );
}

#[test]
#[ignore = "requires isolated Python/paramiko loopback fixture"]
fn failed_parallel_upload_stops_peers_without_replaying_files() {
    let fixture = Fixture::start_with_args(&["--write-delay-ms", "5"]);
    let source = fixture.directory.join("failure");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("fail-write.txt"), vec![1; 64 * 1024]).unwrap();
    for index in 0..32 {
        fs::write(source.join(format!("{index}.txt")), vec![2; 64 * 1024]).unwrap();
    }
    let mut completed = false;
    let result = with_test_known_hosts(fixture.known_hosts.clone(), || {
        upload_path_with_progress(
            &fixture.profile(),
            source.to_str().unwrap(),
            "/",
            &SftpTargetOverride::default(),
            None,
            Some(&mut |update| {
                completed |= update.text.starts_with("传输完成");
            }),
        )
    });
    let error = format!("{:#}", result.unwrap_err());
    assert!(error.contains(SFTP_ACTION_STARTED));
    assert!(
        !error.contains("cancelled"),
        "preserve the failing worker's original error: {error}"
    );
    assert!(!completed);
    let opens = fixture.event_count("open");
    thread::sleep(Duration::from_millis(100));
    assert_eq!(fixture.event_count("open"), opens);
    assert_eq!(fixture.event_count("connect"), 4, "no retry connections");
    assert_eq!(fixture.event_count("disconnect"), 4);
}

#[test]
#[ignore = "requires isolated Python/paramiko and OpenSSH sftp loopback fixture"]
fn system_sftp_protocol_listing_and_cancellation_close_ssh_descendants() {
    let fixture = Fixture::start();
    with_test_known_hosts(fixture.known_hosts.clone(), || {
        let output = run_sftp_launch_plan_with_progress_ref(
            fixture.cli_plan(),
            vec!["pwd".into(), "ls -l /".into(), "bye".into()],
            Duration::from_secs(8),
            None,
            &mut None,
        )
        .unwrap();
        assert!(output.contains("hello.txt"), "{output}");
        wait_event(&fixture.audit, "disconnect");
        let token = Arc::new(AtomicBool::new(false));
        let cancel_token = token.clone();
        let audit = fixture.audit.clone();
        let cancel = thread::spawn(move || {
            wait_event(&audit, "stall-readdir");
            let at = Instant::now();
            cancel_token.store(true, Ordering::SeqCst);
            at
        });
        let result = run_sftp_launch_plan_with_progress_ref(
            fixture.cli_plan(),
            vec!["ls -l /stall-readdir".into(), "bye".into()],
            Duration::from_secs(8),
            Some(&token),
            &mut None,
        );
        assert!(result.unwrap_err().to_string().contains("cancelled"));
        assert!(cancel.join().unwrap().elapsed() < Duration::from_secs(2));
        let started = Instant::now();
        while fixture.event_count("disconnect") < 2 {
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "ssh child remained connected after sftp cancellation"
            );
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(fixture.event_count("connect"), 2);
    });
}

#[test]
#[ignore = "requires isolated Python/paramiko and OpenSSH sftp loopback fixture"]
fn system_sftp_deadline_without_task_id_stops_stalled_child() {
    let fixture = Fixture::start();
    with_test_known_hosts(fixture.known_hosts.clone(), || {
        let started = Instant::now();
        let result = run_sftp_launch_plan_with_progress_ref(
            fixture.cli_plan(),
            vec!["ls -l /stall-readdir".into()],
            Duration::from_secs(3),
            None,
            &mut None,
        );
        assert!(result.unwrap_err().to_string().contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(fixture.event_count("stall-readdir"), 1);
        wait_event(&fixture.audit, "disconnect");
    });
}

#[test]
#[ignore = "requires isolated Python/paramiko and OpenSSH sftp loopback fixture"]
fn system_sftp_upload_progress_extends_its_process_watchdog() {
    let fixture = Fixture::start_with_args(&["--write-delay-ms", "20"]);
    let source = fixture.directory.join("cli-large.bin");
    let bytes = vec![0x7b; 4 * 1024 * 1024];
    fs::write(&source, &bytes).unwrap();
    let started = Instant::now();
    with_test_known_hosts(fixture.known_hosts.clone(), || {
        run_sftp_launch_plan_with_progress_ref(
            fixture.cli_plan(),
            vec![
                format!(
                    "put {} /cli-large.bin",
                    quote_sftp_path(source.to_str().unwrap()).unwrap()
                ),
                "bye".into(),
            ],
            Duration::from_secs(2),
            None,
            &mut None,
        )
    })
    .unwrap();
    assert!(started.elapsed() > Duration::from_secs(2));
    assert_eq!(fs::read(fixture.root.join("cli-large.bin")).unwrap(), bytes);
    wait_event(&fixture.audit, "disconnect");
}

#[test]
#[ignore = "requires isolated Python/paramiko and OpenSSH sftp loopback fixture"]
fn system_sftp_failed_directory_change_never_sends_the_queued_write() {
    let fixture = Fixture::start();
    let source = fixture.directory.join("must-not-upload.txt");
    fs::write(&source, b"must stay local").unwrap();
    with_test_known_hosts(fixture.known_hosts.clone(), || {
        let result = run_sftp_launch_plan_with_progress_ref(
            fixture.cli_plan(),
            vec![
                "cd /missing-directory".into(),
                format!("put {}", quote_sftp_path(source.to_str().unwrap()).unwrap()),
                "bye".into(),
            ],
            Duration::from_secs(8),
            None,
            &mut None,
        );
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("SFTP command failed"));
        assert_eq!(fixture.event_count("write"), 0);
        assert!(!fixture.root.join("must-not-upload.txt").exists());
    });
}
