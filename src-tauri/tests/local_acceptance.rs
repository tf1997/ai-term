//! Real local PTY and production AppState file flow. All writes use a private
//! temporary directory; no user shell startup files, history or app DB are used.
#![cfg(unix)]

#[path = "local_acceptance/workflow.rs"]
mod workflow;

use ai_term_lib::app::state::{AppState, FileDispatchOutcome, FileEditDispatchOutcome};
use ai_term_lib::domain::command_policy::{
    CommandIntent, ExecutionContext, ExecutionTarget, InternalProbe, ShellDialect,
};
use ai_term_lib::domain::filesystem::agent_files::*;
use ai_term_lib::domain::pty::{spawn_pty_process, spawn_reader_channel, PtyCommand, PtySession};
use ai_term_lib::domain::storage::sqlite::SqliteConfigStore;
use ai_term_lib::domain::terminal::ssh::TerminalSession;
use anyhow::{bail, ensure, Context, Result};
use base64::Engine;
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

const PROMPT: &str = "\x1b]9000;LOCAL_ACCEPTANCE_READY\x07";
struct LocalPty(PtySession);
impl TerminalSession for LocalPty {
    fn write(&mut self, data: &[u8]) -> Result<()> {
        self.0.write(data)
    }
    fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        self.0.resize(cols, rows)
    }
}
struct LocalFixture {
    state: AppState,
    output: Receiver<Vec<u8>>,
}
impl LocalFixture {
    async fn start(program: &str, database: &str) -> Result<Self> {
        let args = if program.ends_with("zsh") {
            vec!["-f".into(), "-i".into()]
        } else {
            vec!["--noprofile".into(), "--norc".into(), "-i".into()]
        };
        let mut command = PtyCommand::new(program, args);
        command.envs = vec![
            ("HISTFILE".into(), "/dev/null".into()),
            ("TERM".into(), "xterm-256color".into()),
            ("AI_TERM_SHELL_INTEGRATION_ACTIVE".into(), "".into()),
            ("VSCODE_SHELL_INTEGRATION".into(), "".into()),
        ];
        let process = spawn_pty_process(command, 160, 40)?;
        let mut child = process.child;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        let output = spawn_reader_channel(process.reader);
        process
            .session
            .write(b"PS1=$'\\e]9000;LOCAL_ACCEPTANCE_READY\\a'; PS2=''; unset PROMPT_COMMAND\r")?;
        let state = AppState::with_profile_store(SqliteConfigStore::new(database));
        state
            .register_terminal_session(
                "local-test".into(),
                "local".into(),
                Box::new(LocalPty(process.session)),
            )
            .await;
        let this = Self { state, output };
        this.wait_for(|text| text.contains(PROMPT)).await?;
        this.probe(InternalProbe::ShellIntegration {}).await?;
        Ok(this)
    }
    async fn wait_for(&self, done: impl Fn(&str) -> bool) -> Result<String> {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut bytes = Vec::new();
        loop {
            while let Ok(chunk) = self.output.try_recv() {
                bytes.extend(chunk);
                ensure!(bytes.len() <= 512 * 1024, "local capture exceeded limit");
            }
            let text = String::from_utf8_lossy(&bytes);
            if done(&text) {
                return Ok(text.into_owned());
            }
            ensure!(
                Instant::now() < deadline,
                "local capture timed out ({} bytes)",
                bytes.len()
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    async fn capture(&self, intent: &CommandIntent) -> Result<String> {
        self.state
            .dispatch_command_intent(&intent.reference)
            .await?;
        let footer = format!("AI_TERM_PROBE_END_{}\r\n", intent.capture.nonce);
        self.wait_for(|text| {
            text.split_once(&footer)
                .is_some_and(|(_, rest)| rest.contains(PROMPT))
        })
        .await
    }
    async fn probe(&self, probe: InternalProbe) -> Result<(CommandIntent, String)> {
        let target = self.state.command_execution_target("local-test").await?;
        let intent = self.state.prepare_terminal_probe(target, probe).await?;
        let output = self.capture(&intent).await?;
        Ok((intent, output))
    }
    async fn context(&self) -> Result<ExecutionTarget> {
        let (intent, output) = self.probe(InternalProbe::Context {}).await?;
        let body = output
            .split_once(&format!("__AI_TERM_{}B__", intent.capture.nonce))
            .context("context start")?
            .1
            .split_once(&format!("__AI_TERM_{}E__", intent.capture.nonce))
            .context("context end")?
            .0
            .trim();
        let (shell, rest) = body.split_once('\n').context("shell")?;
        let (directory, rest) = rest
            .split_once("AI_TERM_CONTEXT_USER")
            .context("user tag")?;
        let (user, rest) = rest
            .split_once("AI_TERM_CONTEXT_SCOPE")
            .context("scope tag")?;
        let (scope, _) = rest.split_once("AI_TERM_CONTEXT_END").context("end tag")?;
        let decode = |text: &str| -> Result<String> {
            let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
            Ok(
                String::from_utf8(base64::engine::general_purpose::STANDARD.decode(compact)?)?
                    .trim_end_matches('\n')
                    .into(),
            )
        };
        let shell = match shell.trim() {
            "zsh" => ShellDialect::Zsh,
            "bash" => ShellDialect::Bash,
            _ => bail!("unexpected local shell"),
        };
        self.state
            .update_command_context(
                &intent.reference.target,
                ExecutionContext {
                    shell,
                    working_directory: Some(decode(directory)?),
                    user: Some(decode(user)?),
                    environment_scope: Some(serde_json::to_string(
                        &decode(scope)?.split('\n').collect::<Vec<_>>(),
                    )?),
                },
            )
            .await
    }
    async fn read(&self, path: &str) -> Result<FileToolResponse> {
        let target = self.state.command_execution_target("local-test").await?;
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
        let output = self.capture(&plan.intent).await?;
        let operation = self
            .state
            .finish_agent_file_inspection(plan.reference, output)
            .await?;
        ensure!(!operation.sensitive);
        match self
            .state
            .dispatch_agent_file_operation(operation.reference)
            .await?
        {
            FileDispatchOutcome::Complete { response } => Ok(response),
            FileDispatchOutcome::Terminal { capture } => {
                let output = self.capture(&capture.intent).await?;
                Ok(self
                    .state
                    .finish_agent_terminal_file(capture.reference, output)
                    .await?)
            }
        }
    }
    async fn edit(&self, proposal: &FileEditProposal) -> Result<FileChangeRecord> {
        self.state
            .approve_agent_file_edit(proposal.reference.clone(), proposal.review_hash.clone())
            .await?;
        let record = match self
            .state
            .dispatch_agent_file_edit(proposal.reference.clone())
            .await?
        {
            FileEditDispatchOutcome::Complete { record } => record,
            FileEditDispatchOutcome::Terminal { capture } => {
                let output = self.capture(&capture.intent).await?;
                self.state
                    .finish_agent_terminal_file_edit(capture.reference, output)
                    .await?
            }
        };
        ensure!(
            self.state
                .dispatch_agent_file_edit(proposal.reference.clone())
                .await
                .is_err(),
            "must not replay an edit"
        );
        Ok(record)
    }
}
fn content(response: &FileToolResponse) -> Result<&str> {
    match &response.data {
        FileToolData::ReadFile { data } => {
            ensure!(data.page.complete && response.next_cursor.is_none());
            Ok(&data.page.content)
        }
        _ => bail!("expected file read"),
    }
}

#[tokio::test]
async fn local_pty_file_edit_restore_and_external_conflict_use_real_environment_evidence(
) -> Result<()> {
    for program in ["/bin/zsh", "/bin/bash"] {
        if !std::path::Path::new(program).exists() {
            continue;
        }
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("literal ' quoted 中文.txt");
        let database = directory.path().join("state.sqlite3");
        let original = "\u{feff}first\r\n\tsecond 中文\r\n";
        let changed = "\u{feff}first\r\n\tupdated 中文\r\n";
        std::fs::write(&path, original)?;
        let fixture =
            LocalFixture::start(program, database.to_str().context("database path")?).await?;
        let target = fixture.context().await?;
        ensure!(target
            .context
            .user
            .as_ref()
            .is_some_and(|user| !user.is_empty()));
        let path = path.to_str().context("fixture path")?;
        let before = fixture.read(path).await?;
        ensure!(
            before.provider == FileProvider::Local,
            "local target was not verified"
        );
        ensure!(content(&before)? == original);
        let proposal = fixture
            .state
            .prepare_agent_file_edit(
                target.clone(),
                FileEditRequest {
                    baseline_id: before.baseline_id.context("baseline")?,
                    change: FileChange::Patch {
                        replacements: vec![TextReplacement {
                            old_text: "second".into(),
                            new_text: "updated".into(),
                        }],
                    },
                },
            )
            .await?;
        ensure!(
            proposal.before.as_deref() == Some(original)
                && proposal.after.as_deref() == Some(changed)
        );
        ensure!(
            fixture
                .state
                .dispatch_agent_file_edit(proposal.reference.clone())
                .await
                .is_err(),
            "unapproved write"
        );
        let change = fixture.edit(&proposal).await?;
        ensure!(change.outcome.status == FileEditStatus::Applied);
        ensure!(std::fs::read(path)? == changed.as_bytes());
        let after = fixture.read(path).await?;
        ensure!(content(&after)? == changed);
        let restore = fixture
            .state
            .prepare_agent_file_restore(
                target.clone(),
                after.baseline_id.context("restore baseline")?,
                change.id.clone(),
            )
            .await?;
        let restored = fixture.edit(&restore).await?;
        ensure!(restored.outcome.status == FileEditStatus::Applied);
        ensure!(std::fs::read(path)? == original.as_bytes());
        let fresh = fixture.read(path).await?;
        let stale = fixture
            .state
            .prepare_agent_file_edit(
                target,
                FileEditRequest {
                    baseline_id: fresh.baseline_id.context("fresh baseline")?,
                    change: FileChange::Replace {
                        content: "must not overwrite\n".into(),
                    },
                },
            )
            .await?;
        std::fs::write(path, "external change\n")?;
        ensure!(fixture.edit(&stale).await?.outcome.status == FileEditStatus::Conflict);
        ensure!(content(&fixture.read(path).await?)? == "external change\n");
        fixture.state.remove_session("local-test").await;
        drop(fixture);
        let stored = SqliteConfigStore::new(database.to_str().unwrap())
            .get_agent_file_change(&change.id)?
            .context("durable file change")?;
        ensure!(
            stored.outcome.status == FileEditStatus::Applied
                && stored.before.as_deref() == Some(original)
        );
        println!("local {program}: real context, native read/patch/read/restore, BOM/CRLF/tab/quoted path, one-use approval and external conflict passed");
    }
    Ok(())
}
