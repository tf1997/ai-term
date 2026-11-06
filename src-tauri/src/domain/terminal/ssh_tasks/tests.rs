use super::protocol::{render_command, ExitProtocol, Utf8Stream};
use super::*;
use crate::domain::command_policy::{Decision, ExecutionTarget};
use crate::domain::connection::models::{
    AuthEndpoint, AuthMode, ConnectionProfile, ConnectionRole, FileTransferMode, JumpMode,
};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

fn profile() -> ConnectionProfile {
    let endpoint = AuthEndpoint {
        host: "127.0.0.1".into(),
        port: Some(22),
        username: "fixture".into(),
        auth_mode: AuthMode::Password,
        credential_ref: None,
        password: Some("fixture-password".into()),
    };
    ConnectionProfile {
        id: "fixture".into(),
        name: "isolated fixture".into(),
        connection_role: ConnectionRole::Direct,
        gateway: endpoint.clone(),
        target: endpoint,
        jump_mode: JumpMode::Direct,
        menu_profile_id: String::new(),
        file_transfer_mode: FileTransferMode::Auto,
        shell_integration: true,
    }
}
fn request() -> SshTaskRequest {
    SshTaskRequest {
        command: "printf '%s' hello".into(),
        working_directory: "/tmp".into(),
        environment: BTreeMap::new(),
        timeout_ms: 10_000,
    }
}
fn prepare(
    store: &mut SshTaskStore,
    profile: &ConnectionProfile,
    request: SshTaskRequest,
) -> SshTaskIntent {
    let target = ExecutionTarget::new("test-session".into(), profile.id.clone());
    let intent = SshTaskStore::prepare(request, target.clone(), profile.clone()).unwrap();
    store.insert(intent, profile.clone(), &target).unwrap()
}
fn dispatch(profile: &ConnectionProfile, request: SshTaskRequest) -> SshTaskDispatch {
    let mut store = SshTaskStore::default();
    let intent = prepare(&mut store, profile, request);
    store
        .approve(
            &intent.reference,
            &intent.reference.origin,
            &intent.request,
            &intent.target,
        )
        .unwrap();
    store
        .consume(&intent.reference, &intent.reference.origin, profile)
        .unwrap()
}

#[test]
fn independent_scope_requires_exact_single_use_review_and_profile_binding() {
    let mut store = SshTaskStore::default();
    let profile = profile();
    let intent = prepare(&mut store, &profile, request());
    assert_eq!(intent.analysis.decision, Decision::Ask);
    assert!(store
        .consume(&intent.reference, &intent.reference.origin, &profile)
        .is_err());
    let mut changed = intent.request.clone();
    changed.environment.insert("PATH".into(), "/other".into());
    assert!(store
        .approve(
            &intent.reference,
            &intent.reference.origin,
            &changed,
            &intent.target
        )
        .is_err());
    let mut route = intent.target.clone();
    route.user = "root".into();
    assert!(store
        .approve(
            &intent.reference,
            &intent.reference.origin,
            &intent.request,
            &route
        )
        .is_err());
    store
        .approve(
            &intent.reference,
            &intent.reference.origin,
            &intent.request,
            &intent.target,
        )
        .unwrap();
    let mut changed_profile = profile.clone();
    changed_profile.target.port = Some(23);
    assert!(store
        .consume(
            &intent.reference,
            &intent.reference.origin,
            &changed_profile
        )
        .is_err());
    let mut changed_origin = intent.reference.origin.clone();
    changed_origin.invalidate_context();
    assert!(store
        .consume(&intent.reference, &changed_origin, &profile)
        .is_err());
    let _ = store
        .consume(&intent.reference, &intent.reference.origin, &profile)
        .unwrap();
    assert!(store
        .consume(&intent.reference, &intent.reference.origin, &profile)
        .is_err());
    let serialized = serde_json::to_string(&intent).unwrap();
    assert!(!serialized.contains("fixture-password"));
    assert!(!serialized.contains("credentialRef"));
}

#[test]
fn request_bounds_menu_routes_and_arbitrary_flags_are_rejected() {
    let mut value = request();
    value.working_directory = ".".into();
    assert!(value.validate().is_err());
    value = request();
    value.environment.insert("A;B".into(), "x".into());
    assert!(value.validate().is_err());
    value = request();
    value.timeout_ms = 600_001;
    assert!(value.validate().is_err());
    let mut profile = profile();
    profile.jump_mode = JumpMode::InteractiveMenu;
    profile.menu_profile_id = "menu".into();
    assert!(SshTaskTarget::from_profile(&profile).is_err());
    assert!(serde_json::from_str::<SshTaskRequest>(
        r#"{"command":"pwd","workingDirectory":"/tmp","approved":true}"#
    )
    .is_err());
}

#[test]
fn raw_source_directory_and_environment_are_quoted_without_shell_injection() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("directory ' 空格");
    std::fs::create_dir(&path).unwrap();
    let mut request = request();
    request.working_directory = path.to_str().unwrap().into();
    request.command = "printf '%s\\n' \"$VALUE\" \"${AI_TERM_PTY_ONLY-unset}\"; pwd; exit 7".into();
    request
        .environment
        .insert("VALUE".into(), "literal ' $(never-execute)\n你好".into());
    let command = render_command(&request, "testnonce");
    let output = std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(command)
        .env("AI_TERM_PTY_ONLY", "secret")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(7));
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!(
            "literal ' $(never-execute)\n你好\nunset\n{}\n",
            path.canonicalize().unwrap().display()
        )
    );
    let mut protocol = ExitProtocol::new("testnonce");
    assert!(protocol.feed(&output.stderr).is_empty());
    assert_eq!(protocol.exit, Some(7));
    assert!(protocol.started);
    assert!(!protocol.invalid);
}

#[test]
fn protocol_and_utf8_handle_every_byte_boundary_and_preserve_unowned_output() {
    let raw = b"first\x1eAI_TERM_SSH_nonce_START\x1f\xe4\xbd\xa0\xe5\xa5\xbd\x1eAI_TERM_SSH_other_EXIT:0\x1f\x1eAI_TERM_SSH_nonce_EXIT:7\x1flast";
    for chunk in 1..raw.len() {
        let mut protocol = ExitProtocol::new("nonce");
        let mut decode = Utf8Stream::default();
        let mut output = String::new();
        for part in raw.chunks(chunk) {
            output.push_str(&decode.feed(&protocol.feed(part), false));
        }
        output.push_str(&decode.feed(&protocol.finish(), true));
        assert_eq!(output, "first你好\x1eAI_TERM_SSH_other_EXIT:0\x1flast");
        assert_eq!(protocol.exit, Some(7));
        assert!(!protocol.invalid);
    }
    let mut protocol = ExitProtocol::new("nonce");
    protocol.feed(b"\x1eAI_TERM_SSH_nonce_EXIT:0\x1f");
    assert!(protocol.invalid);
    let mut protocol = ExitProtocol::new("nonce");
    assert_eq!(protocol.feed(&vec![b'x'; 100_000]).len(), 100_000);
}

#[cfg(unix)]
struct Fixture {
    child: std::process::Child,
    directory: tempfile::TempDir,
    port: u16,
}
#[cfg(unix)]
impl Fixture {
    fn start(mode: &str) -> Self {
        use std::io::BufRead;
        let directory = tempfile::tempdir().unwrap();
        let python = std::env::var_os("AI_TERM_SFTP_FIXTURE_PYTHON")
            .expect("use an isolated Python with paramiko");
        let mut child = std::process::Command::new(python)
            .arg(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/fixtures/ssh_exec_server.py"),
            )
            .arg("--root")
            .arg(directory.path())
            .arg("--mode")
            .arg(mode)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let mut ready = String::new();
        std::io::BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&ready).unwrap();
        Self {
            child,
            directory,
            port: value["port"].as_u64().unwrap() as u16,
        }
    }
    fn run(&self, command: &str, stop: bool) -> (SshTaskSnapshot, Vec<SshTaskEvent>) {
        let mut profile = profile();
        profile.target.port = Some(self.port);
        let mut request = request();
        request.working_directory = self.directory.path().to_str().unwrap().into();
        request.command = command.into();
        let dispatch = dispatch(&profile, request);
        let events = Arc::new(Mutex::new(vec![]));
        let recorded = events.clone();
        let control =
            SshTaskControl::new(&dispatch, move |event| recorded.lock().unwrap().push(event));
        let cancel = control.clone();
        let stopper = stop.then(|| {
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(250));
                cancel.stop_observing();
            })
        });
        crate::domain::terminal::ssh::with_test_known_hosts(
            self.directory.path().join("known_hosts"),
            || execute_ssh_task(dispatch, control.clone()),
        );
        if let Some(stopper) = stopper {
            stopper.join().unwrap();
        }
        let snapshot = control.snapshot();
        let events = events.lock().unwrap().clone();
        (snapshot, events)
    }
}
#[cfg(unix)]
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
#[cfg(unix)]
#[ignore = "requires isolated paramiko fixture"]
fn ssh_exec_protocol_streams_both_pipes_and_bounds_output_without_deadlock() {
    let fixture = Fixture::start("normal");
    let (snapshot, events) = fixture.run("printf '你好'; printf '错误' >&2; i=0; while [ \"$i\" -lt 8000 ]; do printf 'stdout-line\\n'; printf 'stderr-line\\n' >&2; i=$((i+1)); done; exit 7", false);
    assert_eq!(
        snapshot.status,
        SshTaskStatus::Completed,
        "{:?}",
        snapshot.reason
    );
    assert_eq!(snapshot.exit_code, Some(7));
    assert!(snapshot.truncated);
    assert!(snapshot.output_bytes <= MAX_TASK_OUTPUT_BYTES);
    assert!(snapshot.stdout.starts_with("你好"));
    assert!(snapshot.stderr.starts_with("错误"));
    assert!(!snapshot.stderr.contains("AI_TERM_SSH"));
    assert!(events
        .windows(2)
        .all(|w| w[1].sequence == w[0].sequence + 1));
    assert_eq!(
        events.iter().map(|e| e.delta.len()).sum::<usize>(),
        snapshot.output_bytes
    );
}

#[test]
#[cfg(unix)]
#[ignore = "requires isolated paramiko fixture"]
fn ssh_exec_protocol_missing_exit_evidence_disconnect_and_stop_never_report_zero_success() {
    let fixture = Fixture::start("missing-trailer");
    let (snapshot, _) = fixture.run("printf 'ignored by fixture'", false);
    assert_eq!(snapshot.status, SshTaskStatus::Unknown);
    assert_eq!(snapshot.exit_code, None);
    let fixture = Fixture::start("no-exit-status");
    let (snapshot, _) = fixture.run("printf '%s' \"${AI_TERM_PTY_ONLY-unset}\"; exit 7", false);
    assert_eq!(
        snapshot.status,
        SshTaskStatus::Completed,
        "{:?}",
        snapshot.reason
    );
    assert_eq!(snapshot.exit_code, Some(7));
    assert_eq!(snapshot.stdout, "unset");
    let fixture = Fixture::start("disconnect");
    let (snapshot, _) = fixture.run("printf started; sleep 5", false);
    assert_eq!(snapshot.status, SshTaskStatus::Unknown);
    assert_eq!(snapshot.exit_code, None);
    let fixture = Fixture::start("normal");
    let started = std::time::Instant::now();
    let (snapshot, _) = fixture.run("printf started; sleep 5", true);
    assert_eq!(snapshot.status, SshTaskStatus::Unknown);
    assert_eq!(snapshot.exit_code, None);
    assert!(started.elapsed().as_secs() < 3);
    assert_eq!(
        std::fs::read_to_string(fixture.directory.path().join("audit")).unwrap(),
        "exec\n"
    );
}
