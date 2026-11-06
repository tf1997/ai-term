//! Opt-in acceptance against an explicitly selected, saved SSH connection.
//! The source database and credential store are read-only. Never print hydrated
//! profiles/configs: they contain secrets. Normal `cargo test` does not connect.
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use ai_term_lib::app::state::{AppState, FileDispatchOutcome, FileEditDispatchOutcome};
use ai_term_lib::domain::auth::credentials::{CredentialStore, SystemCredentialStore};
use ai_term_lib::domain::command_policy::{
    CaptureKind, CommandIntent, ExecutionContext, ExecutionTarget, InternalProbe, OperationKind,
    ShellDialect,
};
use ai_term_lib::domain::connection::models::ConnectionProfile;
use ai_term_lib::domain::filesystem::agent_files::*;
use ai_term_lib::domain::storage::sqlite::SqliteConfigStore;
use ai_term_lib::domain::terminal::ssh::spawn_ssh_terminal;
use ai_term_lib::domain::terminal::ssh_tasks::{
    execute_ssh_task, SshTaskControl, SshTaskRequest, SshTaskSnapshot, SshTaskStatus, SshTaskStore,
};
use anyhow::{bail, ensure, Context, Result};
use base64::Engine;
use rusqlite::{params_from_iter, types::Value, Connection, OpenFlags};

struct ReadOnlyCredentials;
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
impl CredentialStore for ReadOnlyCredentials {
    fn set_secret(&self, _: &str, _: &str) -> Result<()> {
        bail!("live acceptance cannot write credentials")
    }
    fn get_secret(&self, key: &str) -> Result<Option<String>> {
        SystemCredentialStore::new().get_secret(key)
    }
    fn delete_secret(&self, _: &str) -> Result<()> {
        bail!("live acceptance cannot delete credentials")
    }
}

struct LiveFixture {
    _directory: tempfile::TempDir,
    store: SqliteConfigStore,
    profile: ConnectionProfile,
}

impl LiveFixture {
    fn load() -> Result<Self> {
        let source_path = PathBuf::from(std::env::var("AI_TERM_LIVE_DATABASE")?);
        let profile_id = std::env::var("AI_TERM_LIVE_PROFILE")?;
        let expected_host = std::env::var("AI_TERM_LIVE_HOST")?;
        let source = Connection::open_with_flags(source_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let directory = tempfile::tempdir()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))?;
        }
        let path = directory.path().join("acceptance.sqlite3");
        let snapshot = Connection::open(&path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        copy_selected_row(&source, &snapshot, "connection_profiles", &profile_id)?;
        if std::env::var("AI_TERM_LIVE_FILE_PROVIDER").as_deref() == Ok("current-terminal") {
            // Exercise the user's SFTP-off setting only in the private copy.
            snapshot.execute("UPDATE connection_profiles SET file_transfer_mode = 'inline-small-file' WHERE id = ?1", [&profile_id])?;
        }
        if let Ok(model_id) = std::env::var("AI_TERM_LIVE_MODEL") {
            copy_selected_row(&source, &snapshot, "ai_provider_configs", &model_id)?;
        }
        drop(snapshot);
        drop(source);
        let store = SqliteConfigStore::with_credential_store(
            path.to_string_lossy(),
            Arc::new(ReadOnlyCredentials),
        );
        let profile = store
            .get_connection_profile(&profile_id)?
            .context("selected live connection does not exist")?;
        ensure!(profile.target.host == expected_host, "live target mismatch");
        Ok(Self {
            _directory: directory,
            store,
            profile,
        })
    }

    fn exec(&self, command: &str, cwd: &str) -> Result<SshTaskSnapshot> {
        let request = SshTaskRequest {
            command: command.into(),
            working_directory: cwd.into(),
            environment: BTreeMap::new(),
            timeout_ms: 30_000,
        };
        let origin = ExecutionTarget::new("live-acceptance".into(), self.profile.id.clone());
        let mut intents = SshTaskStore::default();
        let prepared = SshTaskStore::prepare(request, origin.clone(), self.profile.clone())?;
        let intent = intents.insert(prepared, self.profile.clone(), &origin)?;
        // Only the fixed, reviewed acceptance commands call this helper. Model
        // proposals must be separately constrained before they can reach it.
        intents.approve(&intent.reference, &origin, &intent.request, &intent.target)?;
        let dispatch = intents.consume(&intent.reference, &origin, &self.profile)?;
        ensure!(
            intents
                .consume(&intent.reference, &origin, &self.profile)
                .is_err(),
            "a live task must not be replayable"
        );
        let control = SshTaskControl::new(&dispatch, |_| {});
        execute_ssh_task(dispatch, control.clone());
        let result = control.snapshot();
        ensure!(
            result.status == SshTaskStatus::Completed,
            "live SSH did not complete: status={:?}, reason={:?}",
            result.status,
            result.reason
        );
        ensure!(result.exit_evidence.is_some(), "missing real exit evidence");
        Ok(result)
    }
}

fn copy_selected_row(source: &Connection, dest: &Connection, table: &str, id: &str) -> Result<()> {
    ensure!(matches!(
        table,
        "connection_profiles" | "ai_provider_configs"
    ));
    let ddl: String = source.query_row(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |row| row.get(0),
    )?;
    dest.execute_batch(&ddl)?;
    let mut statement = source.prepare(&format!("SELECT * FROM {table} WHERE id = ?1"))?;
    let count = statement.column_count();
    let values = statement.query_row([id], |row| {
        (0..count)
            .map(|i| row.get::<_, Value>(i))
            .collect::<rusqlite::Result<Vec<_>>>()
    })?;
    let placeholders = vec!["?"; count].join(",");
    dest.execute(
        &format!("INSERT INTO {table} VALUES ({placeholders})"),
        params_from_iter(values),
    )?;
    Ok(())
}

#[test]
#[ignore = "requires an explicitly selected live SSH connection"]
fn live_ssh_read_only_preflight() -> Result<()> {
    let fixture = LiveFixture::load()?;
    let result = fixture.exec(
        "printf 'AI_TERM_M5_OS='; uname -s; printf 'AI_TERM_M5_UID='; id -u; printf 'AI_TERM_M5_USER='; id -un; printf 'AI_TERM_M5_CWD='; pwd; printf 'AI_TERM_M5_BASH='; bash --version | head -n 1; printf 'AI_TERM_M5_PYTHON='; python3 --version; printf 'AI_TERM_M5_STDERR\\n' >&2; exit 7",
        "/tmp",
    )?;
    ensure!(result.exit_code == Some(7), "incorrect remote exit code");
    ensure!(result.stdout.contains("AI_TERM_M5_OS=Linux"));
    ensure!(result.stdout.contains("AI_TERM_M5_CWD=/tmp"));
    ensure!(result.stderr.contains("AI_TERM_M5_STDERR"));
    ensure!(!result.stdout.contains("AI_TERM_M5_STDERR"));
    ensure!(!result.truncated);
    println!("{}", result.stdout);
    println!("M5 native SSH: separate stdout/stderr, exit 7, single-use dispatch verified");
    Ok(())
}

struct LiveTerminal {
    state: AppState,
    output: std::sync::mpsc::Receiver<Vec<u8>>,
    session_id: String,
}

impl LiveTerminal {
    async fn connect(fixture: &LiveFixture) -> Result<Self> {
        let (sender, output) = std::sync::mpsc::channel();
        let profile = fixture.profile.clone();
        let terminal = tokio::task::spawn_blocking(move || {
            spawn_ssh_terminal(
                &profile,
                160,
                40,
                move |bytes| {
                    let _ = sender.send(bytes);
                },
                || {},
            )
        })
        .await??;
        let state = AppState::with_profile_store(fixture.store.clone());
        let session_id = format!("live-{}", uuid::Uuid::new_v4());
        state
            .register_terminal_session(session_id.clone(), fixture.profile.id.clone(), terminal)
            .await;
        let this = Self {
            state,
            output,
            session_id,
        };
        // Native authentication is complete. The line editor's mode transition
        // establishes that the initial interactive prompt is ready for input.
        this.wait_for(|text| text.contains("\x1b[?2004h")).await?;
        this.probe(InternalProbe::ShellIntegration {}).await?;
        this.refresh_context().await?;
        Ok(this)
    }

    async fn wait_for(&self, done: impl Fn(&str) -> bool) -> Result<String> {
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut bytes = Vec::new();
        loop {
            while let Ok(chunk) = self.output.try_recv() {
                bytes.extend(chunk);
                ensure!(
                    bytes.len() <= 512 * 1024,
                    "live terminal capture exceeded limit"
                );
            }
            let text = String::from_utf8_lossy(&bytes);
            if done(&text) {
                return Ok(text.into_owned());
            }
            ensure!(
                Instant::now() < deadline,
                "live terminal capture timed out ({} bytes)",
                bytes.len()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn dispatch_probe(&self, intent: &CommandIntent) -> Result<String> {
        self.state
            .dispatch_command_intent(&intent.reference)
            .await?;
        let footer = format!("AI_TERM_PROBE_END_{}\r\n", intent.capture.nonce);
        self.wait_for(|text| {
            text.split_once(&footer)
                .is_some_and(|(_, rest)| rest.contains("\x1b]133;B\x07"))
        })
        .await
    }

    async fn probe(&self, probe: InternalProbe) -> Result<(CommandIntent, String)> {
        let target = self
            .state
            .command_execution_target(&self.session_id)
            .await?;
        let intent = self.state.prepare_terminal_probe(target, probe).await?;
        let output = self.dispatch_probe(&intent).await?;
        Ok((intent, output))
    }

    async fn refresh_context(&self) -> Result<ExecutionTarget> {
        let (intent, output) = self.probe(InternalProbe::Context {}).await?;
        let body = output
            .split_once(&format!("__AI_TERM_{}B__", intent.capture.nonce))
            .context("missing context start")?
            .1
            .split_once(&format!("__AI_TERM_{}E__", intent.capture.nonce))
            .context("missing context end")?
            .0
            .trim();
        let (shell, rest) = body.split_once('\n').context("missing shell")?;
        let (directory, rest) = rest
            .split_once("AI_TERM_CONTEXT_USER")
            .context("missing user tag")?;
        let (user, rest) = rest
            .split_once("AI_TERM_CONTEXT_SCOPE")
            .context("missing scope tag")?;
        let (scope, _) = rest
            .split_once("AI_TERM_CONTEXT_END")
            .context("missing context tag")?;
        let decode = |text: &str| -> Result<String> {
            let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
            Ok(
                String::from_utf8(base64::engine::general_purpose::STANDARD.decode(compact)?)?
                    .trim_end_matches('\n')
                    .into(),
            )
        };
        ensure!(
            shell.trim() == "bash",
            "this acceptance fixture currently expects Bash"
        );
        let context = ExecutionContext {
            shell: ShellDialect::Bash,
            working_directory: Some(decode(directory)?),
            user: Some(decode(user)?),
            environment_scope: Some(serde_json::to_string(
                &decode(scope)?.split('\n').collect::<Vec<_>>(),
            )?),
        };
        self.state
            .update_command_context(&intent.reference.target, context)
            .await
    }

    async fn read(&self, path: &str) -> Result<FileToolResponse> {
        let target = self
            .state
            .command_execution_target(&self.session_id)
            .await?;
        let plan = self
            .state
            .prepare_agent_file_inspection(
                target,
                FileToolRequest::ReadFile {
                    path: path.into(),
                    options: FileReadOptions::default(),
                    cursor: None,
                },
            )
            .await?;
        let output = self.dispatch_probe(&plan.intent).await?;
        let operation = self
            .state
            .finish_agent_file_inspection(plan.reference, output)
            .await?;
        ensure!(
            !operation.sensitive,
            "acceptance fixture must not be a sensitive file"
        );
        match self
            .state
            .dispatch_agent_file_operation(operation.reference)
            .await?
        {
            FileDispatchOutcome::Complete { response } => Ok(response),
            FileDispatchOutcome::Terminal { capture } => {
                let output = self.dispatch_probe(&capture.intent).await?;
                Ok(self
                    .state
                    .finish_agent_terminal_file(capture.reference, output)
                    .await?)
            }
        }
    }

    async fn edit(&self, proposal: &FileEditProposal) -> Result<FileChangeRecord> {
        let started = Instant::now();
        self.state
            .approve_agent_file_edit(proposal.reference.clone(), proposal.review_hash.clone())
            .await?;
        match self
            .state
            .dispatch_agent_file_edit(proposal.reference.clone())
            .await?
        {
            FileEditDispatchOutcome::Complete { record } => {
                println!(
                    "M5 file edit observed in {:.2}s: {:?}",
                    started.elapsed().as_secs_f64(),
                    record.outcome.status
                );
                Ok(record)
            }
            FileEditDispatchOutcome::Terminal { capture } => {
                let output = self.dispatch_probe(&capture.intent).await?;
                Ok(self
                    .state
                    .finish_agent_terminal_file_edit(capture.reference, output)
                    .await?)
            }
        }
    }
}

fn file_content(response: &FileToolResponse) -> Result<&str> {
    match &response.data {
        FileToolData::ReadFile { data } => {
            ensure!(data.page.eof && response.next_cursor.is_none());
            Ok(&data.page.content)
        }
        _ => bail!("expected file read"),
    }
}

#[tokio::test]
#[ignore = "creates and removes one file in a private live /tmp directory"]
async fn live_shell_capture_and_file_edit_restore() -> Result<()> {
    ensure!(std::env::var("AI_TERM_LIVE_WRITES")? == "temporary-directory");
    let fixture = LiveFixture::load()?;
    let root = format!("/tmp/ai-term-m5-{}", uuid::Uuid::new_v4().simple());
    let path = format!("{root}/fixture 中文.txt");
    let original = "first\nsecond\n";
    let setup = fixture.exec(
        &format!(
            "umask 077; mkdir -- {} && printf '%s' {} > {}",
            shell_quote(&root),
            shell_quote(original),
            shell_quote(&path)
        ),
        "/tmp",
    )?;
    ensure!(setup.exit_code == Some(0), "fixture setup failed");
    let result: Result<()> = async {
        let terminal = LiveTerminal::connect(&fixture).await?;
        let (probe, probe_output) = terminal.probe(InternalProbe::BracketedCapture {}).await?;
        ensure!(probe_output.contains("AI_TERM_MULTILINE_FIRST\r\n") && probe_output.contains("AI_TERM_CAPTURE_OK\r\n"));
        ensure!(probe_output.contains("\x1b]133;D;7\x07"));
        let target = terminal.state.command_execution_target(&terminal.session_id).await?;
        let source = format!("cd {}\nprintf 'M5_FIRST\\n'\n\n# preserve this comment\nprintf '%s\\n' 'M5 中文\tsecond'\n(exit 9)", shell_quote(&root));
        let intent = terminal.state.analyze_captured_command_intent(target, source.clone(), OperationKind::Command, CaptureKind::Bracketed).await?;
        ensure!(intent.capture.kind == CaptureKind::Bracketed);
        terminal.state.approve_command_intent(&intent.reference, &source).await?;
        terminal.state.dispatch_command_intent(&intent.reference).await?;
        let output = terminal.wait_for(|text| text.split_once("\x1b]133;D;9\x07").is_some_and(|(_, rest)| rest.contains("\x1b]133;B\x07"))).await?;
        ensure!(output.contains("M5_FIRST\r\n") && output.contains("M5 中文\tsecond\r\n"));
        ensure!(output.matches("\x1b]133;D;").count() == 1);
        if let Ok(replay_path) = std::env::var("AI_TERM_LIVE_REPLAY") {
            let prompt = format!("\x1b]133;A{}", probe_output.rsplit_once("\x1b]133;A").context("missing prompt")?.1);
            std::fs::write(replay_path, serde_json::to_vec_pretty(&serde_json::json!([{
                "shell": "live-ssh-bash", "source": source, "output": output,
                "prompt": prompt, "probe": probe_output, "nonce": probe.capture.nonce,
                "expectedExitCode": 9, "expectedOutput": ["M5_FIRST", "M5 中文", "second"],
            }]))?)?;
        }
        let target = terminal.refresh_context().await?;
        ensure!(target.context.working_directory.as_deref() == Some(root.as_str()));
        let before = terminal.read(&path).await?;
        ensure!(file_content(&before)? == original);
        let expected_provider = if std::env::var("AI_TERM_LIVE_FILE_PROVIDER").as_deref() == Ok("current-terminal") { FileProvider::CurrentTerminal } else { FileProvider::Sftp };
        ensure!(before.provider == expected_provider, "unexpected file provider");
        println!("M5 verified file provider: {:?}", before.provider);
        let proposal = terminal.state.prepare_agent_file_edit(target.clone(), FileEditRequest {
            baseline_id: before.baseline_id.context("missing baseline")?,
            change: FileChange::Patch { replacements: vec![TextReplacement { old_text: "second".into(), new_text: "第二行".into() }] },
        }).await?;
        ensure!(proposal.before.as_deref() == Some(original));
        ensure!(proposal.after.as_deref() == Some("first\n第二行\n"));
        let change = terminal.edit(&proposal).await?;
        ensure!(change.outcome.status == FileEditStatus::Applied, "edit outcome: {:?}", change.outcome);
        let after = terminal.read(&path).await?;
        ensure!(file_content(&after)? == "first\n第二行\n");
        let restore = terminal.state.prepare_agent_file_restore(target.clone(), after.baseline_id.context("missing fresh baseline")?, change.id.clone()).await?;
        let restored = terminal.edit(&restore).await?;
        ensure!(restored.outcome.status == FileEditStatus::Applied);
        ensure!(file_content(&terminal.read(&path).await?)? == original);
        let fresh = terminal.read(&path).await?;
        let stale = terminal.state.prepare_agent_file_edit(target, FileEditRequest {
            baseline_id: fresh.baseline_id.context("missing baseline")?,
            change: FileChange::Replace { content: "must not overwrite external change\n".into() },
        }).await?;
        let external = fixture.exec(&format!("printf '%s' 'external change\n' > {}", shell_quote(&path)), &root)?;
        ensure!(external.exit_code == Some(0));
        let blocked = terminal.edit(&stale).await?;
        ensure!(blocked.outcome.status == FileEditStatus::Conflict, "stale edit was not rejected: {:?}", blocked.outcome);
        ensure!(file_content(&terminal.read(&path).await?)? == "external change\n");
        terminal.state.remove_session(&terminal.session_id).await;
        println!("M5 live Bash: raw multiline, UTF-8/tab, final exit 9, persistent cwd verified");
        println!("M5 live files: read, reviewed patch, reread, restore and external-change conflict verified");
        Ok(())
    }.await;
    let cleanup = fixture.exec(
        &format!(
            "rm -- {} && rmdir -- {}",
            shell_quote(&path),
            shell_quote(&root)
        ),
        "/tmp",
    )?;
    ensure!(
        cleanup.exit_code == Some(0),
        "fixture cleanup incomplete: {root}"
    );
    result
}

#[tokio::test]
#[ignore = "uses the selected model and one disposable remote fixture file"]
async fn live_model_reads_patches_and_verifies_fixture() -> Result<()> {
    use ai_term_lib::domain::ai::agent::{
        agent_turn_with_provider_stream, AiAgentTurn, AiAgentTurnRequest,
    };
    ensure!(std::env::var("AI_TERM_LIVE_WRITES")? == "temporary-directory");
    let fixture = LiveFixture::load()?;
    let model_id = std::env::var("AI_TERM_LIVE_MODEL")?;
    let mut config = fixture
        .store
        .get_ai_provider_config(&model_id)?
        .context("selected model is missing")?;
    let api_key = config
        .api_key
        .take()
        .context("selected model credential is missing")?;
    config.timeout_seconds = 90;
    let root = format!("/tmp/ai-term-m5-model-{}", uuid::Uuid::new_v4().simple());
    let path = format!("{root}/example.conf");
    let original = "server {\n    listen 8080;\n    server_name example.invalid;\n}\n";
    let expected = original.replace("listen 8080;", "listen 8081;");
    let setup = fixture.exec(
        &format!(
            "umask 077; mkdir -- {} && printf '%s' {} > {}",
            shell_quote(&root),
            shell_quote(original),
            shell_quote(&path)
        ),
        "/tmp",
    )?;
    ensure!(setup.exit_code == Some(0));
    let result: Result<()> = async {
        let terminal = LiveTerminal::connect(&fixture).await?;
        let mut turns = Vec::new();
        let mut wrote = false;
        let mut reread = false;
        let mut completed = false;
        let mut total_calls = 0;
        for round in 1..=8 {
            let response = agent_turn_with_provider_stream(AiAgentTurnRequest {
                host_knowledge_context: String::new(), file_tools: true, file_edits: true,
                ssh_tasks: false, task_tools: false, task_context: String::new(),
                config: config.clone(), api_key: api_key.clone(),
                goal: format!("这是已授权的隔离文件工具验收。只处理文件 {path}：先用 read_file 完整读取，把唯一的 listen 8080; 改为 listen 8081;，其他所有字节不变。使用 apply_patch 并引用本次读取返回的 baselineId。完成后再次 read_file，核对完整内容后简短报告。此文件不属于任何运行中服务，不安装软件、不重载服务、不调用 run_command、不处理其他路径、不创建其他文件。不需要询问批准，应用会核对固定差异并审批。"),
                turns: turns.clone(), terminal_snapshot: String::new(), command_history: Vec::new(),
                conversation_messages: Vec::new(), conversation_summary: None,
            }, |_| {}, |_| {}, None).await?;
            println!("M5 model {} round {round}: {} tool calls", config.model, response.tool_calls.len());
            if response.tool_calls.is_empty() {
                ensure!(wrote && reread, "model stopped before a verified read/edit/read sequence");
                completed = true;
                break;
            }
            total_calls += response.tool_calls.len();
            ensure!(total_calls <= 12, "model tool-call budget exceeded");
            turns.push(AiAgentTurn::Assistant { text: response.text, tool_calls: response.tool_calls.clone() });
            for call in response.tool_calls {
                let arguments: serde_json::Value = serde_json::from_str(&call.arguments)?;
                let tool_result = match call.name.as_str() {
                    "read_file" => {
                        ensure!(arguments["path"].as_str() == Some(&path), "model requested an unapproved path");
                        ensure!(arguments.get("cursor").is_none(), "fixture needs no pagination");
                        let read = terminal.read(&path).await?;
                        ensure!(file_content(&read)? == if wrote { expected.as_str() } else { original });
                        reread |= wrote;
                        serde_json::to_value(read)?
                    },
                    "apply_patch" => {
                        ensure!(!wrote, "model attempted to replay a mutation");
                        let files = arguments["files"].as_array().context("patch files missing")?;
                        ensure!(files.len() == 1, "only one fixture file may be changed");
                        let target = terminal.state.command_execution_target(&terminal.session_id).await?;
                        let proposal = terminal.state.prepare_agent_file_edit(target, FileEditRequest {
                            baseline_id: files[0]["baselineId"].as_str().context("model baseline missing")?.into(),
                            change: FileChange::Patch { replacements: serde_json::from_value(files[0]["replacements"].clone())? },
                        }).await?;
                        // Native diff is checked against the user's exact fixture
                        // task before approval; no arbitrary model write is run.
                        ensure!(proposal.path == path && proposal.resolved_path == path);
                        ensure!(proposal.before.as_deref() == Some(original));
                        ensure!(proposal.after.as_deref() == Some(expected.as_str()), "model patch differs from the authorized fixture change");
                        let record = terminal.edit(&proposal).await?;
                        ensure!(record.outcome.status == FileEditStatus::Applied, "fixture write was not confirmed; no retry");
                        wrote = true;
                        serde_json::json!({"tool":"apply_patch", "status":"applied", "files":[{"path":path,"status":"applied","changeId":record.id,"revision":record.outcome.revision}], "note":"文件写入已核对；请再次读取验证。"})
                    },
                    _ => bail!("model requested a tool outside this fixture: {}", call.name),
                };
                turns.push(AiAgentTurn::ToolResult { tool_call_id: call.id, content: serde_json::to_string(&tool_result)? });
            }
        }
        ensure!(completed, "model round budget exhausted");
        ensure!(file_content(&terminal.read(&path).await?)? == expected);
        terminal.state.remove_session(&terminal.session_id).await;
        println!("M5 real model/native tools: exact fixture diff, single write, fresh read evidence verified");
        Ok(())
    }.await;
    let cleanup = fixture.exec(
        &format!(
            "rm -- {} && rmdir -- {}",
            shell_quote(&path),
            shell_quote(&root)
        ),
        "/tmp",
    )?;
    ensure!(
        cleanup.exit_code == Some(0),
        "model fixture cleanup incomplete: {root}"
    );
    result
}
