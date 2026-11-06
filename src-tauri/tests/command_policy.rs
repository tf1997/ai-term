use std::time::Duration;

use ai_term_lib::domain::command_policy::{
    analyze_command, AnalysisBudget, AnalysisStatus, CaptureKind, Decision, ExecutionContext,
    ExecutionTarget, IntentStore, OperationKind, RiskKind, RiskSeverity, ShellDialect,
};

fn analyze(source: &str) -> ai_term_lib::domain::command_policy::CommandAnalysis {
    analyze_command(
        source,
        ShellDialect::Bash,
        AnalysisBudget {
            timeout: Duration::from_secs(2),
            ..Default::default()
        },
    )
}

#[test]
fn exported_zsh_steps_keep_foreign_dialect_unknown_and_require_new_review() {
    for source in [
        "zsh -f -c 'pwd' ai-term-task-step",
        "zsh -f -c 'cd \"${1}\" && print -r -- ready' ai-term-task-step '/tmp/a b'",
    ] {
        let result = analyze(source);
        assert_eq!(result.decision, Decision::Ask);
        assert_eq!(result.analysis_status, AnalysisStatus::Unknown);
    }
}

#[cfg(unix)]
#[test]
fn backend_capture_runs_exact_reviewed_benign_source_and_keeps_current_shell_state() {
    // Only harmless fixture programs reach a real shell. The dangerous corpus
    // above is analyzed as text or sent to recording terminals, never executed.
    for source in [
        "printf hello; (exit 7) # trailing comment",
        "printf '%s\\n' 'quote '\"'\"' value'\n(exit 7)",
        "cd /; export AI_TERM_TEST_CAPTURE=ok; (exit 7)",
    ] {
        let target = target();
        let mut store = IntentStore::default();
        let intent = store
            .insert(
                IntentStore::prepare_capture(
                    source.into(),
                    OperationKind::Command,
                    target.clone(),
                    CaptureKind::Sentinel,
                )
                .unwrap(),
                &target,
            )
            .unwrap();
        store.approve(&intent.reference, &target, source).unwrap();
        let payload =
            String::from_utf8(store.consume(&intent.reference, &target).unwrap()).unwrap();
        assert_eq!(payload, intent.terminal_input);
        assert!(
            !payload.trim_end_matches('\r').contains(['\n', '\r', '\t']),
            "sentinel transport must submit one physical input line"
        );
        let program = format!(
            "{}; printf '\\nSTATE:%s:%s' \"$PWD\" \"${{AI_TERM_TEST_CAPTURE-}}\"",
            payload.trim_end_matches('\r')
        );
        let output = std::process::Command::new("/bin/bash")
            .args(["--noprofile", "--norc", "-c", &program])
            .output()
            .unwrap();
        assert!(output.status.success());
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert!(
            stdout.contains(&format!("__AI_TERM_{}B__", intent.capture.nonce)),
            "{stdout}"
        );
        assert!(
            stdout.contains(&format!("__AI_TERM_{}E__:7", intent.capture.nonce)),
            "{stdout}"
        );
        if source.starts_with("cd /") {
            assert!(stdout.ends_with("STATE:/:ok"), "{stdout}");
        }
    }
}

fn target() -> ExecutionTarget {
    let mut target = ExecutionTarget::new("session".into(), "profile".into());
    target.context = ExecutionContext {
        shell: ShellDialect::Bash,
        working_directory: Some("/srv/app".into()),
        user: Some("operator".into()),
        environment_scope: Some("host".into()),
    };
    target
}

#[test]
fn regression_corpus_is_never_automatically_allowed() {
    let cases: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("fixtures/command_policy_cases.json")).unwrap();
    for case in cases {
        let command = case["command"].as_str().unwrap();
        let result = analyze(command);
        assert_ne!(
            result.decision,
            Decision::Allow,
            "{}: {result:?}",
            case["name"]
        );
        assert!(
            result
                .risks
                .iter()
                .any(|r| serde_json::to_value(r.kind).unwrap() == case["kind"]),
            "{}: {result:?}",
            case["name"]
        );
    }
}

#[test]
fn literals_and_comments_are_data_not_nested_commands() {
    for command in [
        "echo 'rm -rf /tmp/x'",
        "printf '%s' \"systemctl restart nginx\"",
        "printf ready # rm -rf /tmp/x",
        "echo '$(rm -rf /tmp/x)'",
        "cat <<'EOF'\nrm -rf /tmp/x\nEOF",
        "ls > /dev/null 2>&1",
        "systemctl status reboot",
        "command -v rm",
        "printf -- '%%n'",
        "printf -- '%s' '%n'",
        "file -- -C",
        "rg -- --hostname-bin=./hook.sh",
    ] {
        let result = analyze(command);
        assert_eq!(
            result.analysis_status,
            AnalysisStatus::Complete,
            "{command}: {result:?}"
        );
        assert_eq!(result.decision, Decision::Allow, "{command}: {result:?}");
        assert!(result.risks.is_empty(), "{command}: {result:?}");
    }
}

#[test]
fn nested_shell_risks_map_to_original_utf8_bytes_and_utf16_columns() {
    let source = "printf '中文😀'; bash -lc \"r'm' -rf /tmp/example\"";
    let result = analyze(source);
    let risk = result
        .risks
        .iter()
        .find(|r| r.kind == RiskKind::Delete)
        .unwrap();
    assert_eq!(&source[risk.range.start_byte..risk.range.end_byte], "r'm'");
    assert_eq!(risk.range.start_line, 1);
    assert_eq!(
        risk.range.start_column,
        source[..risk.range.start_byte].encode_utf16().count() + 1
    );
}

#[test]
fn whole_script_retains_later_high_severity_findings() {
    let result =
        analyze("sed -i 's/a/b/' local.conf; cp app.conf /etc/app.conf\nrm \\\n  -rf /tmp/example");
    assert_eq!(result.highest_severity, Some(RiskSeverity::High));
    assert!(result
        .risks
        .iter()
        .any(|r| r.kind == RiskKind::Edit && r.severity == RiskSeverity::Medium));
    assert!(result
        .risks
        .iter()
        .any(|r| r.kind == RiskKind::Edit && r.severity == RiskSeverity::High));
    assert!(result
        .risks
        .iter()
        .any(|r| r.kind == RiskKind::Delete && r.range.start_line == 2));
}

#[test]
fn readonly_prefixes_cannot_cover_execution_or_writes() {
    for source in [
        "find . -exec rm -rf '{}' \\;",
        "rg --pre=./hook.sh text .",
        "rg --hostname-bin=./hook.sh text .",
        "rg --hostname-bin ./hook.sh text .",
        "file -C -m /tmp/magic",
        "file --compile --magic-file /tmp/magic",
        "git reset --hard",
        "git clean -fd",
        "git log --output=/tmp/out",
        "printf -v BASH_ENV /tmp/startup",
        "printf -- '%n' BASH_ENV",
        "builtin printf -- '%n' BASH_ENV",
        "printf -- '%10n' BASH_ENV",
        "printf -- '%ln' BASH_ENV",
        "cat ~/.ssh/id_rsa",
        "echo \"!!\"",
    ] {
        assert_ne!(analyze(source).decision, Decision::Allow, "{source}");
    }
}

#[test]
fn wrappers_and_static_eval_do_not_hide_inner_operations() {
    for source in [
        "timeout -k 2 5 bash -lc 'rm -rf /tmp/x'",
        "sudo -u root rm -rf /tmp/x",
        "sudo -k rm -rf /tmp/x",
        "command rm -rf /tmp/x -v",
        "env NAME=value rm -rf /tmp/x",
        "eval 'r'\"'m'\"' -rf /tmp/x'",
        "builtin eval 'rm -rf /tmp/x'",
        "builtin -- eval -- 'rm -rf /tmp/x'",
    ] {
        let result = analyze(source);
        assert!(
            result.risks.iter().any(|r| r.kind == RiskKind::Delete),
            "{source}: {result:?}"
        );
    }
}

#[test]
fn an_argument_that_looks_like_a_wrapper_flag_is_not_a_wrapper_flag() {
    assert_eq!(analyze("command -p -v rm").decision, Decision::Allow);
    assert_eq!(analyze("command rm -rf / -v").decision, Decision::Deny);
    assert_eq!(analyze("sudo -k rm -rf /").decision, Decision::Deny);
    assert_eq!(analyze("builtin eval 'rm -rf /'").decision, Decision::Deny);
}

#[test]
fn unknown_shells_invalid_syntax_and_dynamic_parameters_do_not_allow() {
    for dialect in [
        ShellDialect::Zsh,
        ShellDialect::Powershell,
        ShellDialect::Cmd,
        ShellDialect::Unknown,
    ] {
        let result = analyze_command("echo safe", dialect, AnalysisBudget::default());
        assert_eq!(result.analysis_status, AnalysisStatus::Unknown);
        assert_eq!(result.decision, Decision::Ask);
    }
    for source in [
        "echo \"unterminated",
        "find $OPTIONS",
        "[[ -v array[index] ]]",
        "echo \"$(rm -rf /tmp/x)\"",
        "python3 <<'PY'\nimport shutil\nshutil.rmtree('/tmp/x')\nPY",
    ] {
        let result = analyze(source);
        assert_eq!(result.analysis_status, AnalysisStatus::Unknown, "{source}");
        assert_ne!(result.decision, Decision::Allow);
        assert!(!result.unknown_reasons.is_empty());
    }
}

#[test]
fn resource_budgets_never_allow_a_partial_prefix() {
    let posix = analyze_command(
        "cat <<< literal",
        ShellDialect::Posix,
        AnalysisBudget::default(),
    );
    assert_eq!(posix.analysis_status, AnalysisStatus::Unknown);
    for budget in [
        AnalysisBudget {
            max_bytes: 4,
            ..Default::default()
        },
        AnalysisBudget {
            max_nodes: 1,
            ..Default::default()
        },
        AnalysisBudget {
            max_depth: 1,
            ..Default::default()
        },
        AnalysisBudget {
            timeout: Duration::ZERO,
            ..Default::default()
        },
    ] {
        let result = analyze_command("echo safe; rm -rf /tmp/x", ShellDialect::Bash, budget);
        assert_eq!(result.analysis_status, AnalysisStatus::Unknown);
        assert_ne!(result.decision, Decision::Allow);
    }
    let long = format!("{}rm -rf /tmp/x", "echo safe;".repeat(3_000));
    let result = analyze(&long);
    assert_ne!(result.decision, Decision::Allow);
    assert!(
        result.risks.iter().any(|r| r.kind == RiskKind::Delete)
            || result.analysis_status == AnalysisStatus::Unknown
    );
}

#[test]
fn prohibited_root_delete_and_terminal_controls_cannot_be_approved() {
    for source in [
        "rm -rf /",
        "rm --recursive ///",
        "echo\u{1b}[A",
        "echo\0suffix",
        "echo\u{7f}x",
        "echo safe\rreboot",
    ] {
        assert_eq!(analyze(source).decision, Decision::Deny, "{source:?}");
        let target = target();
        let mut store = IntentStore::default();
        let prepared =
            IntentStore::prepare(source.into(), OperationKind::Command, target.clone()).unwrap();
        let intent = store.insert(prepared, &target).unwrap();
        assert!(store.approve(&intent.reference, &target, source).is_err());
        assert!(store.consume(&intent.reference, &target).is_err());
    }
}

#[test]
fn immutable_intents_bind_exact_source_and_are_single_use() {
    let target = target();
    let mut store = IntentStore::default();
    let prepared = IntentStore::prepare(
        "rm -rf /tmp/example".into(),
        OperationKind::Command,
        target.clone(),
    )
    .unwrap();
    let mut intent = store.insert(prepared, &target).unwrap();
    assert!(store.consume(&intent.reference, &target).is_err());
    assert!(store
        .approve(&intent.reference, &target, "rm -rf /tmp/other")
        .is_err());
    store
        .approve(&intent.reference, &target, &intent.source)
        .unwrap();
    intent.source = "rm -rf /tmp/other".into();
    assert_eq!(
        store.consume(&intent.reference, &target).unwrap(),
        b"rm -rf /tmp/example\r"
    );
    assert!(store.consume(&intent.reference, &target).is_err());
}

#[test]
fn stale_targets_versions_and_expired_tickets_are_rejected() {
    let target = target();
    let mut store = IntentStore::default();
    let prepared =
        IntentStore::prepare("ls".into(), OperationKind::Command, target.clone()).unwrap();
    let mut changed = target.clone();
    changed.context_version += 1;
    assert!(store.insert(prepared, &changed).is_err());
    let prepared =
        IntentStore::prepare("ls".into(), OperationKind::Command, target.clone()).unwrap();
    let intent = store.insert(prepared, &target).unwrap();
    let mut forged = intent.reference.clone();
    forged.policy_version = "old".into();
    assert!(store.consume(&forged, &target).is_err());
    let mut changed_mode = intent.reference.clone();
    changed_mode.operation = OperationKind::BashScript;
    assert!(store.approve(&changed_mode, &target, "ls").is_err());
    assert!(store.consume(&intent.reference, &changed).is_err());
    let mut expired = IntentStore::with_ttl(Duration::ZERO);
    let prepared =
        IntentStore::prepare("ls".into(), OperationKind::Command, target.clone()).unwrap();
    let intent = expired.insert(prepared, &target).unwrap();
    assert!(expired.consume(&intent.reference, &target).is_err());
}

#[test]
fn bash_script_wrapper_preserves_exact_source_without_readline_control_bytes() {
    use base64::Engine;
    let target = target();
    let source = "printf '%s\\n' '中文'\n\tprintf '%s' \"$(date)\"";
    let mut store = IntentStore::default();
    let prepared =
        IntentStore::prepare(source.into(), OperationKind::BashScript, target.clone()).unwrap();
    let intent = store.insert(prepared, &target).unwrap();
    store.approve(&intent.reference, &target, source).unwrap();
    let payload = String::from_utf8(store.consume(&intent.reference, &target).unwrap()).unwrap();
    assert!(!payload.contains('\n') && !payload.contains('\t'));
    let encoded = payload
        .split("printf '%s' '")
        .nth(1)
        .unwrap()
        .split('\'')
        .next()
        .unwrap();
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap(),
        source.as_bytes()
    );
    assert!(IntentStore::prepare(source.into(), OperationKind::Command, target).is_err());
}
