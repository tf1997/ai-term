#![cfg(unix)]

use ai_term_lib::domain::command_policy::{ExecutionTarget, IntentStore, InternalProbe};
use ai_term_lib::domain::pty::{spawn_pty_process, spawn_reader_channel, PtyCommand, PtySession};
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

const PROMPT: &str = "\x1b]9000;FIXTURE_READY\x07";

struct Shell {
    session: PtySession,
    output: Receiver<Vec<u8>>,
}
impl Shell {
    fn start(program: &str) -> Self {
        Self::start_with_cols(program, 160)
    }
    fn start_with_cols(program: &str, cols: u16) -> Self {
        let args = if program.ends_with("zsh") {
            vec!["-f".into(), "-i".into()]
        } else {
            vec!["--noprofile".into(), "--norc".into(), "-i".into()]
        };
        let shell = Self::start_command(PtyCommand::new(program, args), cols);
        shell.send("PS1=$'\\e]9000;FIXTURE_READY\\a'; PS2=''; unset PROMPT_COMMAND\r");
        shell
    }
    fn start_command(mut command: PtyCommand, cols: u16) -> Self {
        command.envs.extend([
            ("HISTFILE".into(), "/dev/null".into()),
            ("TERM".into(), "xterm-256color".into()),
            ("AI_TERM_SHELL_INTEGRATION_ACTIVE".into(), "".into()),
            ("VSCODE_SHELL_INTEGRATION".into(), "".into()),
            ("SHELL_SESSIONS_DISABLE".into(), "1".into()),
        ]);
        let process = spawn_pty_process(command, cols, 30).unwrap();
        let mut child = process.child;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Self {
            session: process.session,
            output: spawn_reader_channel(process.reader),
        }
    }
    #[cfg(target_os = "macos")]
    fn start_injected_zsh(cols: u16, directory: &std::path::Path) -> (Self, String) {
        use ai_term_lib::domain::terminal::shell_integration::{
            apply_shell_integration, ensure_integration_scripts,
        };
        let integration = ensure_integration_scripts(directory).unwrap();
        let user_rc = directory.join("user");
        std::fs::create_dir(&user_rc).unwrap();
        // Exercise normal -i startup and the production ZDOTDIR wrappers,
        // without sourcing or modifying the developer's private configuration.
        std::fs::write(user_rc.join(".zshrc"), "HISTFILE=/dev/null\nPS1=$'%{\\e]9000;FIXTURE_READY\\a%}tester@mac ~ %# '\nPS2='continuation> '\n").unwrap();
        let mut command = PtyCommand::new("/bin/zsh", vec!["-i".into()]);
        apply_shell_integration(
            "/bin/zsh",
            &mut command.args,
            &mut command.envs,
            &integration,
        );
        command
            .envs
            .retain(|(key, _)| key != "AI_TERM_USER_ZDOTDIR");
        command.envs.push((
            "AI_TERM_USER_ZDOTDIR".into(),
            user_rc.to_string_lossy().into(),
        ));
        let shell = Self::start_command(command, cols);
        let ready = shell.send("");
        assert!(ready.contains("\x1b]133;B\x07"), "{ready:?}");
        (shell, ready)
    }
    fn send(&self, input: &str) -> String {
        self.send_until_prompt(input, input.starts_with("\x1b[200~"))
    }
    fn send_until_prompt(&self, input: &str, require_finished: bool) -> String {
        self.send_with_timeout(input, require_finished, Duration::from_secs(5))
    }
    fn send_with_timeout(&self, input: &str, require_finished: bool, timeout: Duration) -> String {
        self.session.write(input.as_bytes()).unwrap();
        let deadline = Instant::now() + timeout;
        let mut bytes = Vec::new();
        while Instant::now() < deadline {
            if let Ok(chunk) = self.output.recv_timeout(Duration::from_millis(50)) {
                bytes.extend(chunk);
                let output = String::from_utf8_lossy(&bytes);
                // Narrow shells redraw their prompt while editing a long line.
                // Only the prompt after D proves a submitted command finished.
                let complete_prompt = |tail: &str| {
                    tail.contains(PROMPT)
                        && (!tail.contains("\x1b]133;A") || tail.contains("\x1b]133;B\x07"))
                };
                let complete = if require_finished {
                    output
                        .rfind("\x1b]133;D;")
                        .is_some_and(|index| complete_prompt(&output[index..]))
                } else {
                    complete_prompt(&output)
                };
                if complete {
                    // The prompt can share a read with a partial UTF-8 character.
                    if let Ok(output) = std::str::from_utf8(&bytes) {
                        return output.into();
                    }
                }
            }
        }
        panic!(
            "shell did not return its prompt: {:?}",
            String::from_utf8_lossy(&bytes)
        );
    }
    fn probe(&self, probe: InternalProbe) -> (String, String) {
        let target = ExecutionTarget::new("fixture".into(), "fixture".into());
        let mut store = IntentStore::default();
        let intent = store
            .insert(
                IntentStore::prepare_probe(probe, target.clone()).unwrap(),
                &target,
            )
            .unwrap();
        let output = self.send(&intent.terminal_input);
        (output, intent.capture.nonce)
    }
}

#[test]
fn bash_security_command_retains_source_through_real_shell_echo() {
    use ai_term_lib::domain::command_policy::{CaptureKind, OperationKind, ShellDialect};
    let program = std::env::var("AI_TERM_TEST_BASH").unwrap_or_else(|_| "/bin/bash".into());
    let original = include_str!("fixtures/ubuntu-security-status.sh").trim_end();
    let mut records = Vec::new();
    for (cols, source) in [40, 76, 80, 96, 120, 160]
        .into_iter()
        .map(|cols| (cols, original.to_owned()))
        .chain([(40, original.replace("更新时间", "更新 时间"))])
    {
        let shell = Shell::start_with_cols(&program, cols);
        let (loaded, _) = shell.probe(InternalProbe::ShellIntegration {});
        if !loaded.contains("\x1b]133;A\x07") {
            return;
        }
        let ready = shell.send_until_prompt(
            "PS1=$'\\[\\e]9000;FIXTURE_READY\\a\\]root@server:~# '\r",
            true,
        );
        let prompt = format!("\x1b]133;A{}", ready.rsplit_once("\x1b]133;A").unwrap().1);
        let mut target = ExecutionTarget::new("fixture".into(), "fixture".into());
        target.context.shell = ShellDialect::Bash;
        let mut store = IntentStore::default();
        let intent = store
            .insert(
                IntentStore::prepare_capture(
                    source.clone(),
                    OperationKind::Command,
                    target.clone(),
                    CaptureKind::Markers,
                )
                .unwrap(),
                &target,
            )
            .unwrap();
        store.approve(&intent.reference, &target, &source).unwrap();
        let input = String::from_utf8(store.consume(&intent.reference, &target).unwrap()).unwrap();
        assert_eq!(input, format!("{source}\r"));
        // These read-only diagnostics can also run on a non-Ubuntu test host;
        // the regression concerns Bash/readline echo, not package availability.
        let output = shell.send_with_timeout(&input, true, Duration::from_secs(15));
        assert_eq!(output.matches("\x1b]133;C\x07").count(), 1);
        assert_eq!(output.matches("\x1b]133;D;0\x07").count(), 1);
        records.push(serde_json::json!({ "shell":program, "cols":cols, "source":source, "prompt":prompt, "output":output, "expectedExitCode":0 }));
    }
    if let Ok(path) = std::env::var("AI_TERM_BASH_REPLAY_FILE") {
        std::fs::write(path, serde_json::to_vec(&records).unwrap()).unwrap();
    }
}

#[test]
#[cfg(target_os = "macos")]
fn macos_display_command_preserves_quotes_and_substitution() {
    use ai_term_lib::domain::command_policy::{CaptureKind, OperationKind, ShellDialect};
    use base64::Engine;
    let source = include_str!("fixtures/macos-display-status.sh").trim_end();
    let mut records = Vec::new();
    for startup in ["session-loader", "local-startup"] {
        let directory = tempfile::tempdir().unwrap();
        let (shell, ready) = if startup == "local-startup" {
            Shell::start_injected_zsh(80, directory.path())
        } else {
            let shell = Shell::start_with_cols("/bin/zsh", 80);
            let (ready, _) = shell.probe(InternalProbe::ShellIntegration {});
            (shell, ready)
        };
        let prompt = format!("\x1b]133;A{}", ready.rsplit_once("\x1b]133;A").unwrap().1);
        let mut target = ExecutionTarget::new("fixture".into(), "fixture".into());
        target.context.shell = ShellDialect::Zsh;
        let mut store = IntentStore::default();
        let mut probes = Vec::new();
        for kind in [InternalProbe::Capture {}, InternalProbe::Context {}] {
            let probe = store
                .insert(
                    IntentStore::prepare_probe(kind, target.clone()).unwrap(),
                    &target,
                )
                .unwrap();
            let output = shell.send_until_prompt(&probe.terminal_input, true);
            assert!(!output.contains("parse error"), "{output:?}");
            probes.push(serde_json::json!({ "input":probe.terminal_input, "output":output }));
        }
        let intent = store
            .insert(
                IntentStore::prepare_capture(
                    source.into(),
                    OperationKind::Command,
                    target.clone(),
                    CaptureKind::Markers,
                )
                .unwrap(),
                &target,
            )
            .unwrap();
        store.approve(&intent.reference, &target, source).unwrap();
        let bytes = store.consume(&intent.reference, &target).unwrap();
        assert_eq!(bytes, format!("{source}\r").as_bytes());
        let output = shell.send_with_timeout(
            std::str::from_utf8(&bytes).unwrap(),
            true,
            Duration::from_secs(20),
        );
        let encoded = base64::engine::general_purpose::STANDARD.encode(source.as_bytes());
        assert!(
            output.contains(&format!("\x1b]633;E;{encoded};base64\x07")),
            "{output:?}"
        );
        assert!(!output.contains("unmatched"), "{output:?}");
        assert!(!output.contains("parse error"), "{output:?}");
        assert!(output.contains("cores: "), "{output:?}");
        assert_eq!(output.matches("\x1b]133;D;0\x07").count(), 1);
        records.push(serde_json::json!({ "shell":"/bin/zsh", "startup":startup, "cols":80, "source":source, "prompt":prompt, "output":output, "probes":probes }));
    }
    if let Ok(path) = std::env::var("AI_TERM_DISPLAY_REPLAY_FILE") {
        std::fs::write(path, serde_json::to_vec(&records).unwrap()).unwrap();
    }
}

#[test]
#[cfg(target_os = "macos")]
fn macos_status_command_retains_source_through_real_shell_echo() {
    use ai_term_lib::domain::command_policy::{CaptureKind, OperationKind, ShellDialect};
    use base64::Engine;
    let source = include_str!("fixtures/macos-system-status.sh").trim_end();
    let bash = std::env::var("AI_TERM_TEST_BASH").ok();
    let mut replay = Vec::new();
    for program in std::iter::once("/bin/zsh").chain(bash.as_deref()) {
        for cols in [40, 80, 120, 160] {
            let shell = Shell::start_with_cols(program, cols);
            let (loaded, _) = shell.probe(InternalProbe::ShellIntegration {});
            if !loaded.contains("\x1b]133;A\x07") {
                // AI_TERM_TEST_BASH is also used by the legacy fallback test.
                assert!(!program.ends_with("zsh"), "Zsh integration did not load");
                continue;
            }
            let setup = if program.ends_with("zsh") {
                "PS1=$'%{\\e]9000;FIXTURE_READY\\a%}中文 ❯ '\r"
            } else {
                "PS1=$'\\[\\e]9000;FIXTURE_READY\\a\\]中文 ❯ '\r"
            };
            let ready = shell.send_until_prompt(setup, true);
            let prompt = format!("\x1b]133;A{}", ready.rsplit_once("\x1b]133;A").unwrap().1);
            let mut target = ExecutionTarget::new("fixture".into(), "fixture".into());
            target.context.shell = if program.ends_with("zsh") {
                ShellDialect::Zsh
            } else {
                ShellDialect::Bash
            };
            let mut store = IntentStore::default();
            let probe = store
                .insert(
                    IntentStore::prepare_probe(InternalProbe::Capture {}, target.clone()).unwrap(),
                    &target,
                )
                .unwrap();
            let probe_output = shell.send_until_prompt(&probe.terminal_input, true);
            let intent = store
                .insert(
                    IntentStore::prepare_capture(
                        source.into(),
                        OperationKind::Command,
                        target.clone(),
                        CaptureKind::Markers,
                    )
                    .unwrap(),
                    &target,
                )
                .unwrap();
            assert_eq!(intent.capture.kind, CaptureKind::Markers);
            assert_eq!(intent.terminal_input, format!("{source}\r"));
            store.approve(&intent.reference, &target, source).unwrap();
            let input =
                String::from_utf8(store.consume(&intent.reference, &target).unwrap()).unwrap();
            let output = shell.send_until_prompt(&input, true);
            assert_eq!(output.matches("\x1b]133;C\x07").count(), 1);
            assert_eq!(output.matches("\x1b]133;D;0\x07").count(), 1);
            if program.ends_with("zsh") {
                let encoded = base64::engine::general_purpose::STANDARD.encode(source.as_bytes());
                assert!(
                    output.contains(&format!("\x1b]633;E;{encoded};base64\x07")),
                    "Zsh did not report the original command"
                );
            }
            replay.push(serde_json::json!({ "shell":program, "cols":cols, "source":source, "prompt":prompt, "output":output, "expectedExitCode":0, "probeInput":probe.terminal_input, "probeOutput":probe_output }));
        }
    }
    if let Ok(path) = std::env::var("AI_TERM_COMMAND_REPLAY_FILE") {
        std::fs::write(path, serde_json::to_vec(&replay).unwrap()).unwrap();
    }
}

#[test]
fn zsh_session_loader_preserves_status_and_is_idempotent() {
    if !std::path::Path::new("/bin/zsh").exists() {
        return;
    }
    let shell = Shell::start("/bin/zsh");
    shell.probe(InternalProbe::ShellIntegration {});
    let (output, nonce) = shell.probe(InternalProbe::Capture {});
    assert!(output.contains("\x1b]133;C\x07"), "{output:?}");
    assert!(
        output.contains(&format!("__AI_TERM_{nonce}E__:7")),
        "{output:?}"
    );
    assert!(output.contains("\x1b]133;D;7\x07"), "{output:?}");
    shell.probe(InternalProbe::ShellIntegration {});
    let (output, _) = shell.probe(InternalProbe::Capture {});
    assert_eq!(output.matches("\x1b]133;C\x07").count(), 1, "{output:?}");
    assert_eq!(output.matches("\x1b]133;D;7\x07").count(), 1, "{output:?}");
    let output = shell.send("printf 'first\\nsecond'; (exit 9)\r");
    assert!(output.contains("first\r\nsecond"), "{output:?}");
    assert!(output.contains("\x1b]133;D;9\x07"), "{output:?}");
}

#[test]
fn zsh_syntax_error_returns_a_prompt_without_preexec_or_a_completion_status() {
    if !std::path::Path::new("/bin/zsh").exists() {
        return;
    }
    let shell = Shell::start("/bin/zsh");
    let (loaded, _) = shell.probe(InternalProbe::ShellIntegration {});
    let prompt = format!("\x1b]133;A{}", loaded.rsplit_once("\x1b]133;A").unwrap().1);
    let source = "echo before; then";
    let output = shell.send(&format!("{source}\r"));
    assert!(output.contains("parse error near"), "{output:?}");
    assert!(!output.contains("\x1b]133;C\x07"), "{output:?}");
    assert!(output.contains("\x1b]133;D\x07"), "{output:?}");
    assert!(output.contains("\x1b]133;A\x07"), "{output:?}");
    if let Ok(path) = std::env::var("AI_TERM_PARSE_ERROR_REPLAY_FILE") {
        std::fs::write(path, serde_json::to_vec(&serde_json::json!({
            "shell": "/bin/zsh", "cols": 160, "source": source, "prompt": prompt, "output": output
        })).unwrap()).unwrap();
    }
}

#[test]
fn zsh_existing_precmd_cannot_overwrite_the_observed_command_exit_status() {
    if !std::path::Path::new("/bin/zsh").exists() {
        return;
    }
    let shell = Shell::start("/bin/zsh");
    shell.send("precmd() { printf 'existing-hook\\n'; }; precmd_functions=(test_hook); test_hook() { PS1=$'\\e]9000;FIXTURE_READY\\a'; }\r");
    shell.probe(InternalProbe::ShellIntegration {});
    let (output, _) = shell.probe(InternalProbe::Capture {});
    assert!(output.contains("existing-hook\r\n"), "{output:?}");
    assert!(output.contains("\x1b]133;D;7\x07"), "{output:?}");
}

#[test]
fn bash_old_versions_emit_no_partial_integration_and_modern_versions_capture() {
    let bash = std::env::var("AI_TERM_TEST_BASH").unwrap_or_else(|_| "/bin/bash".into());
    if !std::path::Path::new(&bash).exists() {
        return;
    }
    let shell = Shell::start(&bash);
    let version = std::process::Command::new(&bash)
        .args([
            "-c",
            "printf '%s' \"${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}\"",
        ])
        .output()
        .unwrap();
    let version = String::from_utf8(version.stdout).unwrap();
    let parts: Vec<u32> = version
        .split('.')
        .map(|part| part.parse().unwrap())
        .collect();
    let supported = parts[0] > 4 || (parts[0] == 4 && parts[1] >= 4);
    shell.probe(InternalProbe::ShellIntegration {});
    let (output, nonce) = shell.probe(InternalProbe::Capture {});
    assert!(
        output.contains(&format!("__AI_TERM_{nonce}E__:7")),
        "{output:?}"
    );
    assert_eq!(output.contains("\x1b]133;C\x07"), supported, "{output:?}");
    assert_eq!(output.contains("\x1b]133;D;7\x07"), supported, "{output:?}");
    assert!(!output.contains("can only `return'"), "{output:?}");
    if supported {
        // Use a fresh shell to install around pre-existing array hooks.
        let shell = Shell::start(&bash);
        shell.send(concat!(
            r#"PROMPT_COMMAND=('printf "hook-one:%s\n" "$?"' 'printf "hook-two\n"'); PS0='prefix'"#,
            "\r"
        ));
        shell.probe(InternalProbe::ShellIntegration {});
        let (output, _) = shell.probe(InternalProbe::Capture {});
        assert!(output.contains("hook-one:7"), "{output:?}");
        assert!(output.contains("hook-two"), "{output:?}");
        assert!(output.contains("\x1b]133;D;7\x07"), "{output:?}");
    }
}

#[test]
fn multiline_capture_uses_one_complete_program_and_reports_the_final_status() {
    use ai_term_lib::domain::command_policy::{CaptureKind, OperationKind};
    if !std::path::Path::new("/bin/zsh").exists() {
        return;
    }
    let shell = Shell::start("/bin/zsh");
    shell.probe(InternalProbe::ShellIntegration {});
    let mut target = ExecutionTarget::new("fixture".into(), "fixture".into());
    target.context.shell = ai_term_lib::domain::command_policy::ShellDialect::Zsh;
    let mut store = IntentStore::default();
    let source = "printf 'first\\n'\nprintf 'second\\n'; (exit 9)";
    let intent = store
        .insert(
            IntentStore::prepare_capture(
                source.into(),
                OperationKind::Command,
                target.clone(),
                CaptureKind::Markers,
            )
            .unwrap(),
            &target,
        )
        .unwrap();
    assert_eq!(intent.capture.kind, CaptureKind::Sentinel);
    store.approve(&intent.reference, &target, source).unwrap();
    let bytes = store.consume(&intent.reference, &target).unwrap();
    let output = shell.send(&String::from_utf8(bytes).unwrap());
    assert!(output.contains("first\r\nsecond\r\n"), "{output:?}");
    assert!(
        output.contains(&format!("__AI_TERM_{}E__:9", intent.capture.nonce)),
        "{output:?}"
    );
    assert_eq!(output.matches("\x1b]133;C\x07").count(), 1, "{output:?}");
}

#[test]
fn negotiated_bracketed_transport_preserves_multiline_source_and_final_shell_status() {
    use ai_term_lib::domain::command_policy::{CaptureKind, OperationKind, ShellDialect};
    let bash = std::env::var("AI_TERM_TEST_BASH").unwrap_or_else(|_| "/bin/bash".into());
    let mut replay = vec![];
    let directory = tempfile::tempdir().unwrap();
    for program in ["/bin/zsh", bash.as_str()] {
        if !std::path::Path::new(program).exists() {
            continue;
        }
        let shell = Shell::start(program);
        let (loaded, _) = shell.probe(InternalProbe::ShellIntegration {});
        let (capability, _) = shell.probe(InternalProbe::Capture {});
        if !capability.contains("\x1b]133;C\x07") {
            continue;
        }
        // Existing editor mode, not a setting silently changed by the app.
        assert!(loaded.contains("\x1b[?2004h") || capability.contains("\x1b[?2004h"));
        let (probe_output, nonce) = shell.probe(InternalProbe::BracketedCapture {});
        assert!(
            probe_output.contains("AI_TERM_MULTILINE_FIRST\r\n"),
            "{probe_output:?}"
        );
        assert!(
            probe_output.contains("AI_TERM_CAPTURE_OK\r\n"),
            "{probe_output:?}"
        );
        assert!(
            probe_output.contains(&format!("__AI_TERM_{nonce}E__:7")),
            "{probe_output:?}"
        );
        assert_eq!(
            probe_output.matches("\x1b]133;D;7\x07").count(),
            1,
            "{probe_output:?}"
        );
        assert_eq!(
            probe_output.matches("\x1b]133;D;").count(),
            1,
            "{probe_output:?}"
        );
        let mut target = ExecutionTarget::new("fixture".into(), "fixture".into());
        target.context.shell = if program.ends_with("zsh") {
            ShellDialect::Zsh
        } else {
            ShellDialect::Bash
        };
        let source = "printf 'first\\n'\n\n# a literal comment\nprintf '%s\\n' 'two\nlines'\n\tprintf '%s\\n' '中文 and spaces'\n(exit 9)";
        let mut store = IntentStore::default();
        let intent = store
            .insert(
                IntentStore::prepare_capture(
                    source.into(),
                    OperationKind::Command,
                    target.clone(),
                    CaptureKind::Bracketed,
                )
                .unwrap(),
                &target,
            )
            .unwrap();
        assert_eq!(intent.capture.kind, CaptureKind::Bracketed);
        assert_eq!(intent.source, source);
        assert_eq!(
            intent.terminal_input,
            format!("\x1b[200~{source}\x1b[201~\r")
        );
        store.approve(&intent.reference, &target, source).unwrap();
        let bytes = store.consume(&intent.reference, &target).unwrap();
        let output = shell.send(&String::from_utf8(bytes).unwrap());
        assert!(output.contains("first\r\n"), "{program}: {output:?}");
        assert!(output.contains("two\r\nlines\r\n"));
        assert!(output.contains("中文 and spaces\r\n"));
        assert_eq!(output.matches("\x1b]133;D;9\x07").count(), 1, "{output:?}");
        assert_eq!(output.matches("\x1b]133;D;").count(), 1, "{output:?}");
        let next_source = format!("cd '{}'\nAI_TERM_PASTE_TEST='persistent value'\nprintf '%s\\n' \"$AI_TERM_PASTE_TEST\"\n(exit 11)", directory.path().display());
        let intent = store
            .insert(
                IntentStore::prepare_capture(
                    next_source.clone(),
                    OperationKind::Command,
                    target.clone(),
                    CaptureKind::Bracketed,
                )
                .unwrap(),
                &target,
            )
            .unwrap();
        store
            .approve(&intent.reference, &target, &next_source)
            .unwrap();
        let state_output = shell
            .send(&String::from_utf8(store.consume(&intent.reference, &target).unwrap()).unwrap());
        assert!(state_output.contains("persistent value\r\n"));
        assert!(state_output.contains("\x1b]133;D;11\x07"));
        let subsequent = shell.send("pwd; printf '%s\\n' \"$AI_TERM_PASTE_TEST\"\r");
        assert!(subsequent.contains(directory.path().to_str().unwrap()));
        assert!(subsequent.contains("persistent value\r\n"));
        replay.push(serde_json::json!({ "shell":program, "prompt":"\u{1b}]133;A\u{7}\u{1b}]133;B\u{7}\u{1b}[?2004h", "source":source, "output":output, "probe":probe_output, "nonce":nonce, "expectedExitCode":9 }));
    }
    if let Ok(path) = std::env::var("AI_TERM_CAPTURE_REPLAY_FILE") {
        std::fs::write(path, serde_json::to_vec(&replay).unwrap()).unwrap();
    }
    assert!(
        !replay.is_empty(),
        "no supported shell was available for the bracketed transport test"
    );
}

#[test]
fn application_file_reader_survives_real_interactive_shell_transport() {
    use ai_term_lib::domain::filesystem::agent_files::{
        FileInspection, FileReadOptions, FileReadResponse, TerminalFileRequest,
    };
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("literal ' quoted 中文.txt");
    let content = "\u{feff}first\r\n第二行  \r\n".repeat(1000);
    std::fs::write(&path, &content).unwrap();
    for program in ["/bin/bash", "/bin/zsh"] {
        if !std::path::Path::new(program).exists() {
            continue;
        }
        let shell = Shell::start(program);
        let inspect = TerminalFileRequest::inspect(path.to_str().unwrap().into()).unwrap();
        let (output, _) = shell.probe(InternalProbe::FileReader {
            request: inspect.clone(),
        });
        let inspection: FileInspection = inspect.parse(&output).unwrap();
        let read = TerminalFileRequest::read(
            &inspection,
            FileReadOptions {
                max_lines: 2000,
                ..Default::default()
            },
            None,
            false,
        )
        .unwrap();
        let (output, _) = shell.probe(InternalProbe::FileReader {
            request: read.clone(),
        });
        let result: FileReadResponse = read.parse(&output).unwrap();
        assert_eq!(result.page.content, content);
        assert!(result.page.complete);
    }
}
