//! Joint native/TypeScript acceptance with an owned loopback service. The
//! service, configuration, checkpoint DB and generated draft are temporary.
use super::*;
use ai_term_lib::app::state::AgentRunLease;
use ai_term_lib::domain::ai::{checkpoints::*, host_knowledge::*, recovery::RecoveryResolution};
use ai_term_lib::domain::command_policy::{CaptureKind, Decision, OperationKind};
use ai_term_lib::domain::workspace::UpdateScript;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

struct Service(Child);
impl Drop for Service {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct Journal {
    lease: AgentRunLease,
    state: Value,
}
impl Journal {
    async fn save(
        &mut self,
        fixture: &LocalFixture,
        boundary: &str,
        step: Option<&str>,
        intent: Option<&CommandIntent>,
    ) -> Result<()> {
        self.lease.sequence = fixture
            .state
            .save_agent_checkpoint(
                self.lease.clone(),
                AgentCheckpointUpdate {
                    script_intent: intent.map(|intent| intent.reference.clone()),
                    expected_sequence: self.lease.sequence,
                    boundary: boundary.into(),
                    step_id: step.map(str::to_owned),
                    state: serde_json::from_value(self.state.clone())?,
                },
            )
            .await?;
        Ok(())
    }

    fn add(&mut self, id: &str, tool: &str, command: &str) {
        self.state["steps"].as_array_mut().unwrap().push(json!({
            "id":id,"toolName":tool,"command":command,"reason":"本机联合验收",
            "sensitive":false,"status":"running","executionPhase":"not-started",
            "output":null,"outputTruncated":false,"exitCode":null,"failureReason":null,
            "workingDirectory":null,"fileRead":null,"fileEdits":[]
        }));
    }

    fn step(&mut self, id: &str) -> &mut Value {
        self.state["steps"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|step| step["id"] == id)
            .unwrap()
    }

    async fn read(
        &mut self,
        fixture: &LocalFixture,
        id: &str,
        path: &str,
    ) -> Result<FileToolResponse> {
        self.add(id, "read_file", "");
        self.save(fixture, "before-dispatch", Some(id), None)
            .await?;
        let response = fixture.read(path).await?;
        let FileToolData::ReadFile { data } = &response.data else {
            bail!("not a file")
        };
        ensure!(data.page.complete && !data.changed_during_read);
        let step = self.step(id);
        step["status"] = json!("completed");
        step["executionPhase"] = json!("finished");
        step["exitCode"] = json!(0);
        step["fileRead"] = json!({
            "path":data.path,"resolvedPath":data.resolved_path,"revision":data.revision,
            "environmentScope":response.environment_scope,"complete":true,
            "changedDuringRead":false,"content":data.page.content,"absent":false
        });
        self.save(fixture, "result", Some(id), None).await?;
        Ok(response)
    }

    async fn command(
        &mut self,
        fixture: &LocalFixture,
        id: &str,
        source: &str,
        lose_receipt: bool,
    ) -> Result<(CommandIntent, String)> {
        // Production policy refreshes context before each complete command;
        // ordinary dispatch deliberately invalidates the previous observation.
        let target = fixture.context().await?;
        let intent = fixture
            .state
            .analyze_captured_command_intent(
                target,
                source.into(),
                OperationKind::Command,
                CaptureKind::Sentinel,
            )
            .await?;
        ensure!(intent.source == source && intent.analysis.decision != Decision::Deny);
        self.add(id, "run_command", source);
        self.save(fixture, "prepared", Some(id), Some(&intent))
            .await?;
        fixture
            .state
            .approve_command_intent(&intent.reference, source)
            .await?;
        self.step(id)["executionPhase"] = json!("dispatching");
        self.save(fixture, "before-dispatch", Some(id), Some(&intent))
            .await?;
        fixture
            .state
            .dispatch_command_intent(&intent.reference)
            .await?;
        self.step(id)["executionPhase"] = json!("running");
        self.save(fixture, "observing", Some(id), None).await?;
        let begin = format!("__AI_TERM_{}B__\r\n", intent.capture.nonce);
        let end = format!("__AI_TERM_{}E__:", intent.capture.nonce);
        let raw = fixture
            .wait_for(|text| {
                text.split_once(&end)
                    .is_some_and(|(_, tail)| tail.contains(PROMPT))
            })
            .await?;
        let (body, tail) = raw
            .split_once(&begin)
            .context("command begin")?
            .1
            .split_once(&end)
            .context("command end")?;
        let exit: i32 = tail.lines().next().context("exit status")?.trim().parse()?;
        ensure!(exit == 0, "fixture command failed: {source}: {body}");
        let output = body.replace("\r\n", "\n").trim().to_owned();
        if !lose_receipt {
            let step = self.step(id);
            step["executionPhase"] = json!("finished");
            step["status"] = json!("completed");
            step["exitCode"] = json!(exit);
            step["output"] = json!(output);
            self.save(fixture, "result", Some(id), None).await?;
        }
        Ok((intent, output))
    }
}

#[tokio::test]
#[ignore = "opt-in joint acceptance requires Python 3, curl, Node and installed frontend dependencies"]
async fn private_service_config_reload_recovery_verification_and_script_source() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let config = directory.path().join("service config.json");
    let status = directory.path().join("service-status.json");
    let database = directory.path().join("workflow.sqlite3");
    let database = database.to_str().context("database path")?;
    let program = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/local_reload_service.py");
    std::fs::write(&config, "{\"response\":\"before\"}\n")?;
    let mut service = Service(
        Command::new("python3")
            .arg(&program)
            .arg(&config)
            .arg(&status)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?,
    );
    let stdout = service.0.stdout.take().unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
        let _ = sender.send(result);
    });
    let port: u16 = receiver
        .recv_timeout(Duration::from_secs(5))??
        .trim()
        .parse()?;
    let config_path = config.to_str().context("config path")?;
    let status_path = status.to_str().context("status path")?;
    let fixture = LocalFixture::start("/bin/bash", database).await?;
    let target = fixture.context().await?;
    fixture
        .state
        .save_host_knowledge(
            target.clone(),
            HostKnowledgeDraft {
                valid_for_days: 90,
                id: None,
                expected_revision: None,
                kind: HostKnowledgeKind::ConfigPath,
                title: "验收服务配置".into(),
                value: config_path.into(),
                status: HostKnowledgeStatus::Active,
                evidence: None,
            },
        )
        .await?;
    let context = fixture
        .state
        .host_knowledge_context(target.clone(), "验收服务配置".into(), None)
        .await?;
    ensure!(context.contains(config_path));
    let lease = fixture
        .state
        .begin_agent_run(
            target.clone(),
            AgentRunStart {
                run_id: uuid::Uuid::new_v4().to_string(),
                workspace_session_id: "joint-workspace".into(),
                message_id: "joint-answer".into(),
                goal: "修改测试服务配置并通过实际请求确认生效".into(),
            },
        )
        .await?;
    let mut journal = Journal {
        lease,
        state: json!({
            "status":"executing","steps":[],"verifications":[],"finalText":"","error":null,"stopReason":null,
            "plan":{"version":1,"reason":"按目标读取、修改、检查、重载和验证","changes":[],"items":
            (["read","edit","config-check","reload","health"].map(|id| json!({"id":id,"description":id,"status":"pending","stepIds":[]})))}
        }),
    };
    journal.save(&fixture, "progress", None, None).await?;
    let baseline = journal.read(&fixture, "read", config_path).await?;
    let proposal = fixture
        .state
        .prepare_agent_file_edit(
            target.clone(),
            FileEditRequest {
                baseline_id: baseline.baseline_id.context("baseline")?,
                change: FileChange::Patch {
                    replacements: vec![TextReplacement {
                        old_text: "before".into(),
                        new_text: "after".into(),
                    }],
                },
            },
        )
        .await?;
    ensure!(proposal.before.as_deref() == Some("{\"response\":\"before\"}\n"));
    ensure!(proposal.after.as_deref() == Some("{\"response\":\"after\"}\n"));
    journal.add("edit", "apply_patch", "");
    journal.step("edit")["executionPhase"] = json!("dispatching");
    journal.step("edit")["fileEdits"] = json!([{"changeId":proposal.reference.id,"path":proposal.path,"environmentScope":proposal.environment_scope,"revision":null,"status":"dispatching"}]);
    journal
        .save(&fixture, "before-dispatch", Some("edit"), None)
        .await?;
    let change = fixture.edit(&proposal).await?;
    ensure!(change.outcome.status == FileEditStatus::Applied);
    journal.step("edit")["executionPhase"] = json!("finished");
    journal.step("edit")["status"] = json!("completed");
    journal.step("edit")["fileEdits"][0]["status"] = json!("applied");
    journal.step("edit")["fileEdits"][0]["revision"] = json!(change.outcome.revision);
    journal.save(&fixture, "result", Some("edit"), None).await?;
    let command = format!(
        "python3 {} --check {}",
        shell_quote(program.to_str().unwrap()),
        shell_quote(config_path)
    );
    let (_, checked) = journal
        .command(&fixture, "config-check", &command, false)
        .await?;
    ensure!(checked == "CONFIG_OK");
    let loaded: Value = serde_json::from_slice(&std::fs::read(&status)?)?;
    ensure!(
        loaded["response"] == "before",
        "changing the file does not prove service reload"
    );
    let reload = format!("kill -HUP {}", service.0.id());
    let (lost_intent, _) = journal.command(&fixture, "reload", &reload, true).await?;
    let run_id = journal.lease.run_id.clone();
    let sequence = journal.lease.sequence;
    fixture.state.remove_session("local-test").await;
    drop(fixture);
    // App restart loses the old PTY and owner. The service and durable records
    // remain; never manufacture an exit result or send the reload again.
    let fixture = LocalFixture::start("/bin/bash", database).await?;
    let current = fixture.context().await?;
    ensure!(fixture
        .state
        .dispatch_command_intent(&lost_intent.reference)
        .await
        .is_err());
    let recovered = fixture
        .state
        .recover_agent_run(current.clone(), run_id.clone(), sequence)
        .await?;
    ensure!(
        recovered
            .checkpoint
            .recovery
            .as_ref()
            .unwrap()
            .required_step_ids
            == ["reload"]
    );
    journal = Journal {
        lease: recovered.lease,
        state: serde_json::to_value(recovered.checkpoint.state)?,
    };
    ensure!(fixture
        .state
        .confirm_agent_recovery(
            journal.lease.clone(),
            current.clone(),
            journal.lease.sequence,
            vec![]
        )
        .await
        .is_err());
    let observed = journal
        .read(&fixture, "reload-observation", status_path)
        .await?;
    let loaded: Value = serde_json::from_str(content(&observed)?)?;
    ensure!(
        loaded["generation"] == 1
            && loaded["response"] == "after"
            && loaded["pid"] == service.0.id()
    );
    let confirmed =
        fixture
            .state
            .confirm_agent_recovery(
                journal.lease.clone(),
                current.clone(),
                journal.lease.sequence,
                vec![RecoveryResolution {
                    step_id: "reload".into(),
                    evidence_step_ids: vec!["reload-observation".into()],
                    observation:
                        "当前测试进程的状态文件显示 generation=1 且 response=after；原重载不重放"
                            .into(),
                }],
            )
            .await?;
    journal.lease.sequence = confirmed.sequence;
    journal.state = serde_json::to_value(confirmed.state)?;
    let health = format!("curl --silent --show-error --fail http://127.0.0.1:{port}/health");
    let (_, output) = journal.command(&fixture, "health", &health, false).await?;
    ensure!(output == "HTTP 200 response=after generation=1");
    for item in journal.state["plan"]["items"].as_array_mut().unwrap() {
        let id = item["id"].as_str().unwrap().to_owned();
        item["status"] = json!("completed");
        item["stepIds"] = json!([if id == "reload" {
            "reload-observation"
        } else {
            &id
        }]);
    }
    journal.state["plan"]["version"] = json!(2);
    journal.state["plan"]["reason"] = json!("重启后核对重载效果，实际 HTTP 响应确认配置已生效");
    journal.save(&fixture, "progress", None, None).await?;
    let store = SqliteConfigStore::new(database);
    let checkpoint = store.get_agent_checkpoint(&run_id)?.context("checkpoint")?;
    ensure!(checkpoint.resolved_effects.len() == 1);
    let evidence = directory.path().join("evidence.json");
    std::fs::write(
        &evidence,
        serde_json::to_vec(&json!({"checkpoint":checkpoint,"changes":[change.clone()]}))?,
    )?;
    let frontend = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../frontend");
    let derived = Command::new("node")
        .current_dir(&frontend)
        .args(["--import", "tsx", "tests/ai/local-workflow-evidence.mjs"])
        .arg(&evidence)
        .output()?;
    ensure!(
        derived.status.success(),
        "TypeScript evidence: {}",
        String::from_utf8_lossy(&derived.stderr)
    );
    let derived: Value = serde_json::from_slice(&derived.stdout)?;
    journal.state["verifications"] = derived["checks"].clone();
    journal.state["status"] = json!("done");
    journal.state["finalText"] =
        json!("配置写入与实际 HTTP 响应已核验；原重载经重启后的现场检查确认，没有重放。");
    journal.save(&fixture, "finished", None, None).await?;
    let script: UpdateScript = serde_json::from_value(json!({
        "id":"joint-draft","connectionId":"local","workspaceSessionId":"joint-workspace","name":"验收任务草稿",
        "description":"原重载结果曾丢失，保留为待整理来源","content":derived["draft"]["content"],
        "sourceCommands":derived["draft"]["sourceCommands"],"taskMetadata":derived["draft"]["metadata"],"createdAt":"now","updatedAt":"now"
    }))?;
    store.save_update_script(&script)?;
    let saved = SqliteConfigStore::new(database)
        .get_update_script(&script.id)?
        .context("saved draft")?;
    ensure!(saved.task_metadata.as_ref().unwrap().source.run_id == run_id);
    ensure!(fixture
        .state
        .list_agent_checkpoints("local".into(), "joint-workspace".into())
        .await?
        .is_empty());
    let current = fixture.context().await?;
    let fresh = fixture.read(config_path).await?;
    let restore = fixture
        .state
        .prepare_agent_file_restore(
            current,
            fresh.baseline_id.context("restore baseline")?,
            change.id,
        )
        .await?;
    ensure!(fixture.edit(&restore).await?.outcome.status == FileEditStatus::Applied);
    ensure!(std::fs::read_to_string(&config)? == "{\"response\":\"before\"}\n");
    let loaded: Value = serde_json::from_slice(&std::fs::read(&status)?)?;
    ensure!(
        loaded["response"] == "after" && loaded["generation"] == 1,
        "file restore must not claim to undo service effects"
    );
    fixture.state.remove_session("local-test").await;
    println!("joint local acceptance: knowledge, plan, reviewed patch, syntax check, real reload/HTTP, restart reconciliation, source-preserving draft and conflict-safe restore passed");
    Ok(())
}
