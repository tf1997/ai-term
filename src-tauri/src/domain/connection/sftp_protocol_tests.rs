//! Run with AI_TERM_SFTP_FIXTURE_PYTHON pointing to a Python with paramiko, then
//! `cargo test --lib protocol_tests -- --ignored --test-threads=1`.
use super::*;
use crate::domain::terminal::ssh::with_test_known_hosts;
use std::io::{BufRead, BufReader};
use std::process::{Child as ProcessChild, Command, Stdio};
use std::thread;

const FIXTURE_ROOT_MOUNTINFO: &str =
    "25 1 8:1 / / rw,relatime - ext4 /dev/fixture rw\n26 25 0:5 / /proc rw - proc proc rw\n";

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
            shell_integration: true,
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

#[test]
#[ignore = "requires isolated Python/paramiko loopback fixture"]
fn agent_file_reads_are_bounded_preserve_bytes_and_bind_route_and_revision() {
    use crate::domain::filesystem::agent_files::*;
    let fixture = Fixture::start();
    let content = "\u{feff}line one\r\n第二行  \r\nlast";
    fs::write(fixture.root.join("with space.txt"), content).unwrap();
    fs::write(fixture.root.join("huge.log"), vec![b'a'; 4 * 1024 * 1024]).unwrap();
    fs::write(fixture.root.join("empty"), b"").unwrap();
    fs::write(fixture.root.join("binary"), b"a\0b").unwrap();
    fs::write(fixture.root.join("encoding"), b"a\xffb").unwrap();
    with_test_known_hosts(fixture.known_hosts.clone(), || {
        let profile = fixture.profile();
        let target = SftpTargetOverride::default();
        let route = sftp_profile_route(&profile);
        let options = FileReadOptions {
            max_lines: 1,
            ..Default::default()
        };
        let stale = read_agent_file_sftp(
            &profile,
            "wrong-route",
            &target,
            "/with space.txt",
            &options,
            None,
            None,
            None,
        )
        .unwrap_err();
        assert_eq!(stale.kind, FileErrorKind::TargetChanged);
        assert_eq!(fixture.event_count("connect"), 0);
        let first = read_agent_file_sftp(
            &profile,
            &route,
            &target,
            "/with space.txt",
            &options,
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(first.page.content, "\u{feff}line one\r\n");
        assert!(!first.page.eof);
        let next = read_agent_file_sftp(
            &profile,
            &route,
            &target,
            "/with space.txt",
            &FileReadOptions::default(),
            Some(&first.page.end),
            Some(&first.revision),
            None,
        )
        .unwrap();
        assert_eq!(first.page.content + &next.page.content, content);
        fs::write(fixture.root.join("with space.txt"), b"changed size").unwrap();
        assert_eq!(
            read_agent_file_sftp(
                &profile,
                &route,
                &target,
                "/with space.txt",
                &options,
                None,
                Some(&first.revision),
                None
            )
            .unwrap_err()
            .kind,
            FileErrorKind::VersionChanged
        );
        let before_reads = fixture.event_count("read");
        let large = read_agent_file_sftp(
            &profile,
            &route,
            &target,
            "/huge.log",
            &FileReadOptions::default(),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(large.page.content.len(), MAX_FILE_BYTES);
        assert!(!large.page.complete);
        let read_bytes: u64 = fs::read_to_string(&fixture.audit)
            .unwrap()
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .filter(|event| event["event"] == "read")
            .skip(before_reads)
            .map(|event| event["length"].as_u64().unwrap())
            .sum();
        assert!(
            read_bytes <= (MAX_FILE_BYTES + 32768) as u64,
            "SFTP read ahead exceeded bounded window: {read_bytes}"
        );
        assert!(
            read_agent_file_sftp(&profile, &route, &target, "/empty", &options, None, None, None)
                .unwrap()
                .page
                .complete
        );
        for (path, kind) in [
            ("/missing", FileErrorKind::Missing),
            ("/binary", FileErrorKind::Binary),
            ("/encoding", FileErrorKind::UnsupportedEncoding),
            ("/", FileErrorKind::NotRegularFile),
            ("/.env", FileErrorKind::SensitivePath),
        ] {
            assert_eq!(
                read_agent_file_sftp(&profile, &route, &target, path, &options, None, None, None)
                    .unwrap_err()
                    .kind,
                kind
            );
        }
        // File errors may retire the pooled transport; none is retried on another route.
        assert!(fixture.event_count("connect") <= 6);
    });
}

#[test]
#[ignore = "requires isolated Python/paramiko loopback fixture"]
fn agent_directory_pages_and_sensitive_symlinks_use_the_same_bound_sftp_route() {
    use crate::domain::filesystem::agent_files::*;
    let fixture = Fixture::start();
    fs::create_dir(fixture.root.join("entries")).unwrap();
    for n in 0..600 {
        fs::write(fixture.root.join(format!("entries/{n:04}.txt")), b"").unwrap();
    }
    fs::write(fixture.root.join(".env"), b"secret fixture").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(".env", fixture.root.join("alias.txt")).unwrap();
    with_test_known_hosts(fixture.known_hosts.clone(), || {
        let profile = fixture.profile();
        let route = sftp_profile_route(&profile);
        let target = SftpTargetOverride::default();
        let first =
            list_agent_directory_sftp(&profile, &route, &target, "/entries", 0, 100, None, None)
                .unwrap();
        assert_eq!(first.page.entries.len(), 100);
        assert_eq!(first.page.next_offset, Some(100));
        let next = list_agent_directory_sftp(
            &profile,
            &route,
            &target,
            "/entries",
            100,
            500,
            Some(&first.revision),
            None,
        )
        .unwrap();
        assert_eq!(next.page.entries.len(), 500);
        assert_eq!(next.page.next_offset, None);
        let mut names: Vec<_> = first
            .page
            .entries
            .iter()
            .chain(&next.page.entries)
            .map(|entry| entry.name.clone())
            .collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), 600);
        #[cfg(unix)]
        assert_eq!(
            read_agent_file_sftp(
                &profile,
                &route,
                &target,
                "/alias.txt",
                &FileReadOptions::default(),
                None,
                None,
                None
            )
            .unwrap_err()
            .kind,
            FileErrorKind::SensitivePath
        );
        assert_eq!(fixture.event_count("connect"), 1);
    });
}

#[test]
#[ignore = "requires isolated Python/paramiko loopback fixture"]
fn agent_sftp_cancel_does_not_retry_or_return_a_late_page() {
    use crate::domain::filesystem::agent_files::*;
    let fixture = Fixture::start();
    let token = Arc::new(AtomicBool::new(false));
    let cancellation = token.clone();
    let audit = fixture.audit.clone();
    let cancel = thread::spawn(move || {
        wait_event(&audit, "stall-read");
        cancellation.store(true, Ordering::SeqCst);
    });
    with_test_known_hosts(fixture.known_hosts.clone(), || {
        let profile = fixture.profile();
        let started = Instant::now();
        let error = read_agent_file_sftp(
            &profile,
            &sftp_profile_route(&profile),
            &SftpTargetOverride::default(),
            "/stall-read.txt",
            &FileReadOptions::default(),
            None,
            None,
            Some(&token),
        )
        .unwrap_err();
        assert_eq!(error.kind, FileErrorKind::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_eq!(fixture.event_count("connect"), 1);
    });
    cancel.join().unwrap();
}

#[test]
#[cfg(unix)]
#[ignore = "requires isolated Python/paramiko loopback fixture"]
fn agent_sftp_mapping_requires_namespace_root_credentials_and_fresh_evidence() {
    use crate::domain::command_policy::ExecutionTarget;
    use crate::domain::filesystem::agent_files::*;
    let fixture = Fixture::start();
    let proc = fixture.root.join("proc");
    fs::create_dir_all(proc.join("sys/kernel/random")).unwrap();
    fs::create_dir_all(proc.join("self/ns")).unwrap();
    fs::create_dir_all(proc.join("self/attr")).unwrap();
    let status = "Name:\tfixture\nUid:\t1000 1000 1000 1000\nGid:\t1000 1000 1000 1000\nGroups:\t1000 1001\nCapEff:\t0000000000000000\nNoNewPrivs:\t0\nSeccomp:\t0\n";
    let boot = "91aa2343-556d-4cd1-b33c-63406c4a146f";
    fs::write(proc.join("sys/kernel/random/boot_id"), boot).unwrap();
    fs::write(proc.join("self/status"), status).unwrap();
    fs::write(proc.join("self/attr/current"), "unconfined\n").unwrap();
    fs::write(proc.join("self/mountinfo"), FIXTURE_ROOT_MOUNTINFO).unwrap();
    std::os::unix::fs::symlink("mnt:[4026531841]", proc.join("self/ns/mnt")).unwrap();
    std::os::unix::fs::symlink("/", proc.join("self/root")).unwrap();
    let environment = FileEnvironment::Linux {
        boot: boot.into(),
        mount: "mnt:[4026531841]".into(),
        root: "/".into(),
        root_mount: Some(linux_root_mount(FIXTURE_ROOT_MOUNTINFO).unwrap()),
        credentials: linux_credentials(status).unwrap(),
        security: "unconfined".into(),
    };
    let terminal = FileInspection {
        path: "/hello.txt".into(),
        resolved_path: "/hello.txt".into(),
        metadata: FileMetadata {
            kind: FileKind::File,
            size: 0,
            modified_ns: None,
            identity: None,
        },
        revision: "terminal-version".into(),
        environment: Some(environment.clone()),
        scope: "f".repeat(64),
    };
    with_test_known_hosts(fixture.known_hosts.clone(), || {
        let profile = fixture.profile();
        let route = sftp_profile_route(&profile);
        let target = SftpTargetOverride::default();
        let mut mismatched = terminal.clone();
        if let Some(FileEnvironment::Linux { mount, .. }) = &mut mismatched.environment {
            *mount = "mnt:[4026531842]".into();
        }
        assert_eq!(
            inspect_agent_file_sftp(&profile, &route, &target, &mismatched, None)
                .unwrap_err()
                .kind,
            FileErrorKind::Unavailable
        );
        let inspected =
            inspect_agent_file_sftp(&profile, &route, &target, &terminal, None).unwrap();
        let execution_target = ExecutionTarget::new("session".into(), profile.id.clone());
        let mut store = FileOperationStore::default();
        let request = FileToolRequest::ReadFile {
            path: "/hello.txt".into(),
            options: FileReadOptions::default(),
            cursor: None,
        };
        let operation = store
            .prepare(
                execution_target.clone(),
                request,
                FileProvider::Sftp,
                inspected,
            )
            .unwrap();
        let permit = store
            .consume(&operation.reference, &execution_target)
            .unwrap()
            .native_permit()
            .unwrap();
        let result = read_agent_file_sftp_with_permit(
            &profile,
            &route,
            &target,
            &permit,
            &FileReadOptions::default(),
            None,
            None,
        )
        .unwrap();
        assert_eq!(result.page.content, "hello from SFTP\n");
        let target_reads = || {
            fs::read_to_string(&fixture.audit)
                .unwrap()
                .lines()
                .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
                .filter(|entry| entry["event"] == "open" && entry["path"] == "/hello.txt")
                .count()
        };
        assert_eq!(
            target_reads(),
            1,
            "environment inspection must not read target contents"
        );
        for changed_root in [
            FIXTURE_ROOT_MOUNTINFO.replace("8:1 / /", "8:1 /jail /"),
            "26 25 0:5 / /proc rw - proc proc rw\n".into(),
        ] {
            fs::write(proc.join("self/mountinfo"), changed_root).unwrap();
            assert_eq!(
                inspect_agent_file_sftp(&profile, &route, &target, &terminal, None)
                    .unwrap_err()
                    .kind,
                FileErrorKind::Unavailable,
                "same uid, namespace and root symlink are not enough for a chroot mapping"
            );
            assert_eq!(
                read_agent_file_sftp_with_permit(
                    &profile,
                    &route,
                    &target,
                    &permit,
                    &FileReadOptions::default(),
                    None,
                    None
                )
                .unwrap_err()
                .kind,
                FileErrorKind::TargetChanged
            );
            assert_eq!(
                target_reads(),
                1,
                "root mismatch must stop before opening target contents"
            );
        }
        fs::write(proc.join("self/mountinfo"), FIXTURE_ROOT_MOUNTINFO).unwrap();
        fs::write(
            proc.join("self/status"),
            status.replace("1000 1000 1000 1000", "0 0 0 0"),
        )
        .unwrap();
        assert_eq!(
            read_agent_file_sftp_with_permit(
                &profile,
                &route,
                &target,
                &permit,
                &FileReadOptions::default(),
                None,
                None
            )
            .unwrap_err()
            .kind,
            FileErrorKind::TargetChanged
        );
        assert_eq!(
            target_reads(),
            1,
            "changed identity must fail before target open"
        );
        fs::write(proc.join("self/status"), status).unwrap();
        let mut missing = terminal.clone();
        missing.path = "/missing".into();
        missing.resolved_path = missing.path.clone();
        assert_eq!(
            inspect_agent_file_sftp(&profile, &route, &target, &missing, None)
                .unwrap_err()
                .kind,
            FileErrorKind::Missing
        );
        let mut unavailable = profile.clone();
        unavailable.file_transfer_mode = FileTransferMode::InlineSmallFile;
        assert_eq!(
            inspect_agent_file_sftp(
                &unavailable,
                &sftp_profile_route(&unavailable),
                &target,
                &terminal,
                None
            )
            .unwrap_err()
            .kind,
            FileErrorKind::Unavailable
        );
    });
}

#[test]
#[cfg(unix)]
#[ignore = "requires isolated Python/paramiko loopback fixture"]
fn agent_sftp_edits_bind_complete_content_preserve_mode_and_do_not_retry_lost_close_ack() {
    use crate::domain::command_policy::ExecutionTarget;
    use crate::domain::filesystem::agent_files::*;
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::start();
    let proc = fixture.root.join("proc");
    fs::create_dir_all(proc.join("sys/kernel/random")).unwrap();
    fs::create_dir_all(proc.join("self/ns")).unwrap();
    fs::create_dir_all(proc.join("self/attr")).unwrap();
    let status = "Uid:\t1000 1000 1000 1000\nGid:\t1000 1000 1000 1000\nGroups:\t1000\nCapEff:\t0000000000000000\nNoNewPrivs:\t0\nSeccomp:\t0\n";
    let boot = "91aa2343-556d-4cd1-b33c-63406c4a146f";
    fs::write(proc.join("sys/kernel/random/boot_id"), boot).unwrap();
    fs::write(proc.join("self/status"), status).unwrap();
    fs::write(proc.join("self/attr/current"), "unconfined").unwrap();
    fs::write(proc.join("self/mountinfo"), FIXTURE_ROOT_MOUNTINFO).unwrap();
    std::os::unix::fs::symlink("mnt:[4026531841]", proc.join("self/ns/mnt")).unwrap();
    std::os::unix::fs::symlink("/", proc.join("self/root")).unwrap();
    let environment = FileEnvironment::Linux {
        boot: boot.into(),
        mount: "mnt:[4026531841]".into(),
        root: "/".into(),
        root_mount: Some(linux_root_mount(FIXTURE_ROOT_MOUNTINFO).unwrap()),
        credentials: linux_credentials(status).unwrap(),
        security: "unconfined".into(),
    };
    with_test_known_hosts(fixture.known_hosts.clone(), || {
        let profile = fixture.profile();
        let route = sftp_profile_route(&profile);
        let target = ExecutionTarget::new("session".into(), profile.id.clone());
        for scenario in ["success", "conflict", "lost-ack"] {
            let name = if scenario == "lost-ack" {
                "fail-edit-close.txt"
            } else {
                "edit.txt"
            };
            let path = format!("/{name}");
            fs::write(fixture.root.join(name), "before\r\n").unwrap();
            fs::set_permissions(fixture.root.join(name), fs::Permissions::from_mode(0o640))
                .unwrap();
            let terminal = FileInspection {
                path: path.clone(),
                resolved_path: path.clone(),
                metadata: FileMetadata {
                    kind: FileKind::File,
                    size: 0,
                    modified_ns: None,
                    identity: None,
                },
                revision: "terminal-version".into(),
                environment: Some(environment.clone()),
                scope: "f".repeat(64),
            };
            let inspected = inspect_agent_file_sftp(
                &profile,
                &route,
                &SftpTargetOverride::default(),
                &terminal,
                None,
            )
            .unwrap();
            let mut operations = FileOperationStore::default();
            let request = FileToolRequest::ReadFile {
                path,
                options: FileReadOptions::default(),
                cursor: None,
            };
            let operation = operations
                .prepare(target.clone(), request, FileProvider::Sftp, inspected)
                .unwrap();
            let dispatch = operations.consume(&operation.reference, &target).unwrap();
            let data = read_agent_file_sftp_with_permit(
                &profile,
                &route,
                &SftpTargetOverride::default(),
                &dispatch.native_permit().unwrap(),
                &FileReadOptions::default(),
                None,
                None,
            )
            .unwrap();
            let response = operations
                .finish(dispatch.clone(), &target, FileToolData::ReadFile { data })
                .unwrap();
            let mut edits = FileEditStore::default();
            let baseline_id = edits
                .register_read(dispatch, Some(route.clone()), &response)
                .unwrap();
            let proposal = edits
                .prepare(
                    &target,
                    FileEditRequest {
                        baseline_id,
                        change: FileChange::Replace {
                            content: "after\r\n".into(),
                        },
                    },
                )
                .unwrap();
            edits
                .approve(&proposal.reference, &target, &proposal.review_hash)
                .unwrap();
            let dispatch = edits.consume(&proposal.reference, &target).unwrap();
            if scenario == "conflict" {
                fs::write(fixture.root.join(name), "external").unwrap();
            }
            let result = edit_agent_file_sftp(
                &profile,
                &SftpTargetOverride::default(),
                &dispatch,
                None,
                &AtomicBool::new(false),
            );
            let expected = match scenario {
                "success" => FileEditStatus::Applied,
                "conflict" => FileEditStatus::Conflict,
                _ => FileEditStatus::Unknown,
            };
            assert_eq!(result.status, expected, "{scenario}: {result:?}");
            assert_eq!(
                fs::read_to_string(fixture.root.join(name)).unwrap(),
                if scenario == "conflict" {
                    "external"
                } else {
                    "after\r\n"
                }
            );
            assert_eq!(
                fs::metadata(fixture.root.join(name))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o7777,
                0o640
            );
        }
        let audit = fs::read_to_string(&fixture.audit).unwrap();
        assert_eq!(
            audit
                .lines()
                .filter(|line| line.contains("\"event\": \"write\"")
                    && line.contains("fail-edit-close.txt"))
                .count(),
            1,
            "unknown write must not retry"
        );
    });
}
