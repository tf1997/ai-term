use ai_term_lib::domain::command_policy::{
    analyze_reusable_command, CommandScriptSource, ExecutionContext, ExecutionTarget, IntentStore,
    OperationKind, ShellDialect,
};

fn source(command: &str) -> CommandScriptSource {
    analyze_reusable_command(command, ShellDialect::Bash)
        .source
        .unwrap_or_else(|| panic!("missing draft for fixture: {command}"))
}

#[test]
fn preserves_complete_bash_programs_without_interactive_dependencies() {
    for command in [
        "export FIXTURE_DIR=/tmp; fixture() { printf '%s' \"$FIXTURE_DIR\"; }",
        "for value in one two; do printf '%s\\n' \"$value\"; done | sort",
        "value=$(printf fixture); if [ -n \"$value\" ]; then printf '%s' \"$value\"; fi",
        "cat <<'EOF'\nspaces ' quotes $NOT_EXPANDED\nEOF",
    ] {
        let draft = source(command);
        assert_eq!(draft.source, command);
        assert!(draft.secrets.is_empty());
    }
    for command in [
        "read response",
        "exit 0",
        "trap 'echo fixture' EXIT",
        "if broken",
        "echo __AI_TERM_PARAM_X__",
        "_ai_term_step_status=0",
    ] {
        assert!(
            analyze_reusable_command(command, ShellDialect::Bash)
                .source
                .is_none(),
            "{command}"
        );
    }
    assert!(analyze_reusable_command("print fixture", ShellDialect::Zsh)
        .source
        .is_none());
}

#[test]
fn export_budgets_never_return_a_partial_program_or_partial_secret_mask() {
    assert!(
        analyze_reusable_command(&"printf x;".repeat(9000), ShellDialect::Bash)
            .source
            .is_none()
    );
    let many_secrets = (0..33)
        .map(|index| format!("APP_PASSWORD_{index}=fixture{index};"))
        .collect::<String>();
    let analysis = analyze_reusable_command(&many_secrets, ShellDialect::Bash);
    assert!(analysis.sensitive);
    assert!(analysis.source.is_none());
    let comments = source("printf fixture # discarded comment\nprintf after");
    assert_eq!(comments.source, "printf fixture \nprintf after");
}

#[test]
fn credential_arguments_assignments_headers_urls_and_repeated_literals_are_externalized() {
    let fixtures = [
        ("export APP_PASSWORD='fixture-private-value'; printf '%s' \"$APP_PASSWORD\"", "fixture-private-value"),
        ("tool --to\"ken\"='fixture-private-value'", "fixture-private-value"),
        ("tool --password 'fixture-private-value'; printf '%s' 'copy:fixture-private-value'", "fixture-private-value"),
        ("env APP_SECRET='fixture-private-value' tool", "fixture-private-value"),
        ("curl -u 'fixture:private-value' https://example.invalid", "fixture:private-value"),
        ("sshpass -p 'fixture-private-value' ssh example.invalid", "fixture-private-value"),
        ("curl '-ufixture:private-value' https://example.invalid", "private-value"),
        ("sudo /usr/bin/curl --user 'fixture:private-value' https://example.invalid", "private-value"),
        ("mysql '-pfixture-private-value' -e 'select 1'", "fixture-private-value"),
        ("redis-cli -a 'fixture-private-value' ping", "fixture-private-value"),
        ("curl -H 'Authorization: Bearer fixture-private-value' https://example.invalid", "fixture-private-value"),
        ("curl 'https://fixture:private-value@example.invalid/path'", "private-value"),
        ("printf '%s' '-----BEGIN PRIVATE KEY-----\nfixture-private-value\n-----END PRIVATE KEY-----'", "fixture-private-value"),
    ];
    for (command, secret) in fixtures {
        let analysis = analyze_reusable_command(command, ShellDialect::Bash);
        assert!(analysis.sensitive, "{command}");
        let draft = analysis
            .source
            .unwrap_or_else(|| panic!("missing credential template: {command}"));
        assert!(!draft.secrets.is_empty());
        assert!(!serde_json::to_string(&draft).unwrap().contains(secret));
        let check = std::process::Command::new("/bin/bash")
            .args(["-n", "-c", &draft.source])
            .output()
            .unwrap();
        assert!(
            check.status.success(),
            "{}",
            String::from_utf8_lossy(&check.stderr)
        );
    }
}

#[test]
fn ambiguous_embedded_sensitive_source_never_partially_survives() {
    for command in [
        "tool --token fixture-private-value; DATA='curl --password another-private-value'",
        "tool --token fixture-private-value; cat <<'EOF'\npassword=another-private-value\nEOF",
        "tool --token fixture-private-value; echo '{\"password\":\"another-private-value\"}'",
        "tool --token fixture-private-value; curl --password=\"$OTHER\"",
        "tool --token fixture-private-value; printf '%s' $'fixture-private-value'",
        "tool --token fixture-private-value > /tmp/fixture-private-value",
        "DATA='curl --password fixture-private-value'",
        "declare -a PASSWORDS=(fixture-private-value)",
    ] {
        let analysis = analyze_reusable_command(command, ShellDialect::Bash);
        assert!(analysis.sensitive, "{command}");
        assert!(
            analysis.source.is_none(),
            "partial secret template survived: {command}"
        );
    }
}

#[test]
fn external_credentials_are_data_in_a_real_shell_and_missing_values_fail() {
    let draft =
        source("export APP_PASSWORD='original-fixture-secret'; printf '%s' \"$APP_PASSWORD\"");
    let dir = tempfile::tempdir().unwrap();
    let sentinel = dir.path().join("must-not-exist");
    let value = format!(
        "literal ' \" newline\n$(touch {}) ; end",
        sentinel.display()
    );
    let mut program = std::process::Command::new("/bin/bash");
    let output = program
        .args(["--noprofile", "--norc", "-c", &draft.source])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env(&draft.secrets[0].variable, &value)
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stdout).unwrap(), value);
    assert!(!sentinel.exists());
    let missing = std::process::Command::new("/bin/bash")
        .args(["-c", &draft.source])
        .env_clear()
        .output()
        .unwrap();
    assert!(!missing.status.success());
}

#[test]
fn live_intent_binding_is_required_and_export_does_not_approve_or_consume() {
    let mut target = ExecutionTarget::new("fixture".into(), "local".into());
    target.context = ExecutionContext {
        shell: ShellDialect::Bash,
        working_directory: Some("/tmp".into()),
        user: Some("fixture".into()),
        environment_scope: Some("host".into()),
    };
    let command = "export APP_PASSWORD='fixture-private-value'";
    let mut store = IntentStore::default();
    let intent = store
        .insert(
            IntentStore::prepare(command.into(), OperationKind::Command, target.clone()).unwrap(),
            &target,
        )
        .unwrap();
    assert!(intent.source_sensitive);
    assert!(store
        .reusable_source(&intent.reference, &target, true)
        .unwrap()
        .source
        .is_some());
    assert!(store.consume(&intent.reference, &target).is_err());
    let mut forged = intent.reference.clone();
    forged.target.context.user = Some("different".into());
    assert!(store.reusable_source(&forged, &target, false).is_err());
    store.approve(&intent.reference, &target, command).unwrap();
    store.consume(&intent.reference, &target).unwrap();
    assert!(store
        .reusable_source(&intent.reference, &target, true)
        .is_err());
    let simple = store
        .insert(
            IntentStore::prepare("pwd".into(), OperationKind::Command, target.clone()).unwrap(),
            &target,
        )
        .unwrap();
    assert!(store
        .reusable_source(&simple.reference, &target, true)
        .unwrap()
        .source
        .is_none());
}
