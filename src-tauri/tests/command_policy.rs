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
fn printed_parameter_reads_are_data_not_dynamic_execution() {
    for command in [
        "ls -l /tmp/ai-term-note.txt 2>&1; echo \"exit=$?\"",
        "echo $?",
        "echo \"pid=$$ args=$# home=${HOME}\" pre$USER/post",
        "echo \"$a $b\" $1 \"$@\" \"done! $x\"",
        "grep -c error app.log || echo \"rc=$?\"",
        "(false; echo \"exit=$?\") 2>&1 | tail -n 5",
        "printf 'exit=%s\\n' \"$?\"",
        "printf 'exit=%d\\n' $?",
        "printf -- '%-10s|%.3s|%%|%b\\n' \"$USER\" $HOME \"$x\"",
    ] {
        let result = analyze(command);
        assert_eq!(result.decision, Decision::Allow, "{command}: {result:?}");
        assert_eq!(result.analysis_status, AnalysisStatus::Complete);
        assert!(result.risks.is_empty() && result.unknown_reasons.is_empty());
    }
    assert_eq!(
        analyze("ls /tmp; echo \"exit=$?\"").commands,
        vec!["ls /tmp", "echo \"exit=$?\""]
    );
    // A printed read neither hides nor inflates what the rest of the line does.
    let result = analyze("echo \"exit=$?\"; rm notes.txt");
    assert_eq!(result.analysis_status, AnalysisStatus::Complete);
    assert_eq!(result.highest_severity, Some(RiskSeverity::Medium));
    assert_eq!(result.risks.len(), 1, "{result:?}");
    assert_eq!(result.risks[0].kind, RiskKind::Delete);

    for command in [
        // The value picks the program, an option or a file.
        "$? arg",
        "\"$cmd\" arg",
        "cat \"$file\"",
        "ls $?",
        "rm -rf \"$dir\"",
        "builtin echo \"$?\"",
        "echo \"exit=$?\" > \"$file\"",
        "echo hi <<< \"$x\"",
        "X=$? echo hi",
        // Evaluating the expansion runs code, changes state or reads history.
        "echo \"$(id) $?\"",
        "echo ${x:=y}",
        "echo ${x@P}",
        "echo ${!x}",
        "echo ${#x}",
        "echo \"${arr[0]}\"",
        "echo $((i++))",
        "echo $x*",
        "echo \"last !$x\"",
        "echo $!",
        "echo \"$ $?\"",
        // printf reads these operands as a format, a variable, a number or a width.
        "printf \"$format\" x",
        "printf -- \"$format\"",
        "printf -v out '%s' \"$?\"",
        "printf '%s %n' \"$?\" count",
        "printf '%d\\n' \"$x\"",
        "printf '%*s' \"$width\" x",
    ] {
        let result = analyze(command);
        assert_ne!(result.decision, Decision::Allow, "{command}: {result:?}");
        assert_eq!(result.analysis_status, AnalysisStatus::Unknown, "{command}");
        assert!(result.commands.is_empty(), "{command}");
    }

    // Zsh indexes or modifies a bare `$name` and may glob its unquoted value.
    for shell in [ShellDialect::Zsh, ShellDialect::Unknown] {
        for command in [
            "ls /tmp 2>&1; echo \"exit=$?\"",
            "echo $? \"$HOME: ${USER}[1] $PATH:/usr/bin\"",
        ] {
            let result = analyze_in(command, shell);
            assert_eq!(result.decision, Decision::Allow, "{command}: {result:?}");
        }
        for command in [
            "echo $HOME",
            "echo ${HOME}",
            "echo \"$x[1]\"",
            "echo \"$x:h\"",
            "echo \"$?[1]\"",
            "echo \"$#name\"",
            "printf '%s\\n' $x",
        ] {
            let result = analyze_in(command, shell);
            assert_ne!(result.decision, Decision::Allow, "{command}: {result:?}");
        }
    }
    for command in ["echo $HOME", "echo \"$x[1] $x:h\""] {
        assert_eq!(analyze(command).decision, Decision::Allow, "{command}");
    }
}

#[test]
fn environment_hooks_and_brace_expansions_cannot_be_granted_as_readonly() {
    for source in [
        "GIT_PAGER='sh -c id' git log",
        "PROMPT_COMMAND='id'; ls",
        "CUSTOM_HOOK='id' ls",
        "LC_ALL=C; ls",
    ] {
        let result = analyze(source);
        assert_eq!(result.decision, Decision::Ask, "{source}: {result:?}");
        assert!(
            result.risks.iter().any(|risk| {
                risk.kind == RiskKind::Execution && risk.severity == RiskSeverity::High
            }),
            "{source}: {result:?}"
        );
    }

    for source in ["LC_ALL=C ls", "LANG=en_US.UTF-8 ls"] {
        let result = analyze(source);
        assert_eq!(result.decision, Decision::Allow, "{source}: {result:?}");
        assert!(result.risks.is_empty() && result.unknown_reasons.is_empty());
    }

    for (source, kind) in [
        ("find . {-delete,-name} x", RiskKind::Execution),
        ("cat /etc/shado{w,}", RiskKind::Permission),
        ("cat < /etc/shadow", RiskKind::Permission),
        ("cat < /etc/shado{w,}", RiskKind::Permission),
        ("cat < \"$TARGET\"", RiskKind::Permission),
    ] {
        let result = analyze(source);
        assert_eq!(result.decision, Decision::Ask, "{source}: {result:?}");
        assert!(
            result
                .risks
                .iter()
                .any(|risk| risk.kind == kind && risk.severity == RiskSeverity::High),
            "{source}: {result:?}"
        );
    }

    for source in [
        "echo {one,two}",
        "find . -name file{one,two}.log",
        "cat < /tmp/ai-term-note.txt",
        "find . -name 'file{one,two}.log'",
        r"find . -name file\{one,two\}.log",
    ] {
        let result = analyze(source);
        assert_eq!(result.decision, Decision::Allow, "{source}: {result:?}");
        assert!(result.risks.is_empty() && result.unknown_reasons.is_empty());
    }
}

#[test]
fn safe_compound_commands_check_every_executable_branch() {
    for command in [
        "grep error app.log || true",
        "tail -n 100 app.log 2>/dev/null || echo missing",
        "pwd && ls | head -n 20 || printf '%s\\n' unavailable",
        "false || true && :",
        "(grep error app.log || true) | head -n 20",
        "{ tail -n 100 app.log || echo missing; } | head -n 20",
    ] {
        let result = analyze(command);
        assert_eq!(result.decision, Decision::Allow, "{command}: {result:?}");
        assert_eq!(result.analysis_status, AnalysisStatus::Complete);
    }
    for command in [
        "ls || rm -rf /tmp/data",
        "false && reboot || true",
        "tail -n 10 app.log || echo missing > result.txt",
        "ls || printf -v PATH '%s' /tmp",
        "echo $(reboot) || true",
        "sh -c 'rm -rf /tmp/data' || true",
        "tail /etc/shadow || true",
        "(ls || rm -rf /tmp/data) | head",
        "{ ls; }; function ls() { rm -rf /tmp/data; }; ls",
    ] {
        let result = analyze(command);
        assert_ne!(result.decision, Decision::Allow, "{command}");
        assert!(
            result.commands.is_empty(),
            "partial AST must not authorize: {command}"
        );
    }
    assert_eq!(
        analyze("(grep error app.log || true) | head -n 20").commands,
        vec!["grep error app.log", "true", "head -n 20"]
    );
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
    for dialect in [ShellDialect::Powershell, ShellDialect::Cmd] {
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

fn analyze_in(
    source: &str,
    shell: ShellDialect,
) -> ai_term_lib::domain::command_policy::CommandAnalysis {
    analyze_command(
        source,
        shell,
        AnalysisBudget {
            timeout: Duration::from_secs(2),
            ..Default::default()
        },
    )
}

#[test]
fn zsh_and_unprobed_shells_allow_plain_readonly_commands_only() {
    for shell in [ShellDialect::Zsh, ShellDialect::Unknown] {
        for source in [
            "ls -la /var/log",
            "git status",
            "ps aux | grep nginx | head -n 5",
            "df -h && free -m",
        ] {
            let result = analyze_in(source, shell);
            assert_eq!(result.decision, Decision::Allow, "{source}: {result:?}");
            assert_eq!(result.analysis_status, AnalysisStatus::Complete);
        }
        for source in [
            "ls *(e:'rm -rf /tmp/x':)",
            "cat =(reboot)",
            "echo =ls",
            "ls ^keep",
            "ls file#1",
            "rm -rf /tmp/x",
            "echo hi > out.txt",
            "echo $(reboot)",
            "deploy --now",
        ] {
            let result = analyze_in(source, shell);
            assert_ne!(result.decision, Decision::Allow, "{source}");
            assert!(result.commands.is_empty(), "{source}");
        }
    }
    for source in ["echo %PATH%", "echo @(Get-Date)", "echo a & del b"] {
        assert_ne!(
            analyze_in(source, ShellDialect::Unknown).decision,
            Decision::Allow,
            "{source}"
        );
    }
}

#[test]
fn zsh_and_unprobed_shells_ask_where_the_typed_line_runs_differently() {
    // Each of these runs the hidden text, or splits the value, when typed into
    // an interactive zsh, while the Bourne tree shows one read-only command.
    let cases = [
        ("echo hi # ; rm -rf /tmp/x", "interactive-comment"),
        ("ls -la /var/log # newest first", "interactive-comment"),
        (
            "echo \"a!\" \"; rm -rf /tmp/x; echo \" \"x\"",
            "history-expansion",
        ),
        ("echo \"done!\"", "history-expansion"),
        ("cat <<'EOF'\nsee !! here\nEOF", "history-expansion"),
        ("find /tmp/x \"$=x\"", "foreign-expansion"),
        ("ls \"$~x\"", "foreign-expansion"),
        ("ls \"$+x\"", "foreign-expansion"),
        ("PROMPT='$(id)'; ls", "variable-assignment"),
        ("GIT_PAGER='sh -c id' git log", "variable-assignment"),
    ];
    for shell in [ShellDialect::Zsh, ShellDialect::Unknown] {
        for (source, code) in cases {
            let result = analyze_in(source, shell);
            assert_eq!(result.decision, Decision::Ask, "{source}: {result:?}");
            assert!(result.commands.is_empty(), "{source}");
            assert!(
                result.unknown_reasons.iter().any(|r| r.code == code),
                "{source}: {result:?}"
            );
        }
        // Single quotes switch history expansion off, and `!` before a blank
        // or `=` never starts it.
        for source in [
            "grep -c '!important' style.css",
            "echo 'done!'",
            "echo \"wow! a != b\"",
            "grep 'a$=b' notes.txt",
        ] {
            let result = analyze_in(source, shell);
            assert_eq!(result.decision, Decision::Allow, "{source}: {result:?}");
        }
    }
    // Bash and POSIX sh keep their modeled behaviour.
    for source in [
        "ls -la /var/log # newest first",
        "echo \"done!\"",
        "LC_ALL=C ls",
    ] {
        for shell in [ShellDialect::Bash, ShellDialect::Posix] {
            let result = analyze_in(source, shell);
            assert_eq!(result.decision, Decision::Allow, "{source}: {result:?}");
        }
    }
    assert_eq!(
        analyze_in("LC_ALL=C ls", ShellDialect::Unknown).decision,
        Decision::Ask
    );
}

#[test]
fn builtin_readonly_set_is_allowed_and_its_write_forms_are_not() {
    for source in [
        "w",
        "printenv HOME",
        "which python3",
        "type ls",
        "env",
        "hostname",
        "hostname -f",
        "date",
        "date -u +%s",
        "date -d yesterday +%F",
        "ss -tlnp",
        "journalctl -u nginx -n 50 --no-pager",
        "find /var/log -name app.log -mtime -1",
        "systemctl status nginx",
        "docker ps -a",
        "docker logs --tail 50 web",
        "kubectl get pods -n prod",
        "git status",
        "git log --oneline -5",
        "git diff HEAD",
        "git branch",
        "git branch -a -vv",
        "ip addr show",
        "timeout 5 ls /tmp",
    ] {
        let result = analyze(source);
        assert_eq!(result.decision, Decision::Allow, "{source}: {result:?}");
    }
    for source in [
        "hostname web-2",
        "date -s 12:00",
        "date --set=12:00",
        "date 010112002026",
        "ss -K dst 10.0.0.1",
        "journalctl --vacuum-time=1d",
        "journalctl --rotate",
        "git branch feature",
        "git branch -m old new",
        "git branch -D old",
        "git branch --set-upstream-to=origin/main",
        "git diff --ext-diff",
        "git commit -m x",
        "env rm notes.txt",
        "printenv > out",
        "docker exec web ls",
        "systemctl restart nginx",
    ] {
        assert_ne!(analyze(source).decision, Decision::Allow, "{source}");
    }
}

#[test]
fn unconfirmed_context_keeps_readonly_allowed_and_asks_for_everything_else() {
    let unknown = ExecutionTarget::new("session".into(), "profile".into());
    let prepared =
        IntentStore::prepare("ls -la".into(), OperationKind::Command, unknown.clone()).unwrap();
    let mut store = IntentStore::default();
    let intent = store.insert(prepared, &unknown).unwrap();
    assert_eq!(intent.analysis.decision, Decision::Allow);
    assert_eq!(intent.analysis.analysis_status, AnalysisStatus::Complete);

    for source in ["make build", "rm notes.txt", "echo $HOME"] {
        let prepared =
            IntentStore::prepare(source.into(), OperationKind::Command, unknown.clone()).unwrap();
        let intent = store.insert(prepared, &unknown).unwrap();
        assert_eq!(intent.analysis.decision, Decision::Ask, "{source}");
        assert!(
            intent
                .analysis
                .unknown_reasons
                .iter()
                .any(|r| r.code == "target-context"),
            "{source}"
        );
    }
    let script =
        IntentStore::prepare("ls -la".into(), OperationKind::BashScript, unknown.clone()).unwrap();
    assert_eq!(
        store.insert(script, &unknown).unwrap().analysis.decision,
        Decision::Ask
    );
}
