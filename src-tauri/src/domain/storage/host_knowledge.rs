use super::sqlite::SqliteConfigStore;
use crate::domain::{
    ai::{
        checkpoints::{now_ms, AgentCheckpoint},
        host_knowledge::*,
    },
    command_policy::ExecutionTarget,
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension, Transaction};

fn checkpoint(tx: &Transaction<'_>, run_id: &str) -> Result<AgentCheckpoint> {
    let payload: String = tx.query_row(
        "SELECT payload FROM agent_runs WHERE run_id=?1",
        [run_id],
        |row| row.get(0),
    )?;
    Ok(serde_json::from_str(&payload)?)
}
fn rows(tx: &Transaction<'_>, profile: &str) -> Result<Vec<HostKnowledge>> {
    let mut statement = tx.prepare(
        "SELECT payload FROM host_knowledge WHERE profile_id=?1 ORDER BY updated_at DESC, id",
    )?;
    let payloads = statement
        .query_map([profile], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    payloads
        .into_iter()
        .map(|payload| Ok(serde_json::from_str(&payload)?))
        .collect()
}
fn write(tx: &Transaction<'_>, record: &HostKnowledge) -> Result<()> {
    tx.execute("INSERT INTO host_knowledge (id, profile_id, revision, updated_at, payload) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, updated_at=excluded.updated_at, payload=excluded.payload", params![record.id, record.scope.profile_id, record.revision, record.updated_at, serde_json::to_string(record)?])?;
    Ok(())
}
// Expiration is evaluated by both the manager and each model-context read.
// Older records receive the same finite default from their last confirmation;
// neither reopening nor a successful tool observation extends that deadline.
fn refresh_validity(tx: &Transaction<'_>, records: &mut [HostKnowledge], now: u64) -> Result<()> {
    for record in records {
        let mut changed = false;
        if record.expires_at.is_none() {
            if let Some(confirmed) = record.confirmed_at {
                record.expires_at = confirmed
                    .checked_add(u64::from(default_knowledge_valid_days()) * KNOWLEDGE_DAY_MS);
                changed = true;
            }
        }
        if record.status == HostKnowledgeStatus::Active
            && record.expires_at.is_none_or(|expires| expires <= now)
        {
            record.status = HostKnowledgeStatus::NeedsReview;
            record.invalid_reason = Some("知识有效期已过或缺少确认时间，请重新核验后确认".into());
            changed = true;
        }
        if changed {
            record.revision = record
                .revision
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("知识版本已满"))?;
            record.updated_at = now;
            write(tx, record)?;
        }
    }
    Ok(())
}

impl SqliteConfigStore {
    pub fn list_host_knowledge(&self, profile_id: &str) -> Result<Vec<HostKnowledge>> {
        let mut connection = self.connection()?;
        let tx = connection.transaction()?;
        let mut records = rows(&tx, profile_id)?;
        refresh_validity(&tx, &mut records, now_ms())?;
        tx.commit()?;
        Ok(records)
    }
    pub fn save_host_knowledge(
        &self,
        scope: HostKnowledgeScope,
        mut draft: HostKnowledgeDraft,
    ) -> Result<HostKnowledge> {
        draft.validate()?;
        let mut connection = self.connection()?;
        let tx = connection.transaction()?;
        let mut record = if let Some(id) = &draft.id {
            let payload: String = tx.query_row(
                "SELECT payload FROM host_knowledge WHERE id=?1",
                [id],
                |row| row.get(0),
            )?;
            let old: HostKnowledge = serde_json::from_str(&payload)?;
            if old.scope != scope || Some(old.revision) != draft.expected_revision {
                bail!("知识的环境或版本已经变化，请重新读取")
            }
            old
        } else {
            let count: u64 = tx.query_row(
                "SELECT count(*) FROM host_knowledge WHERE profile_id=?1",
                [&scope.profile_id],
                |row| row.get(0),
            )?;
            if count >= 200 {
                bail!("每个连接最多保存 200 条知识，请先整理旧记录")
            }
            HostKnowledge {
                expires_at: None,
                id: uuid::Uuid::new_v4().to_string(),
                revision: 0,
                scope: scope.clone(),
                kind: draft.kind.clone(),
                title: String::new(),
                value: String::new(),
                status: HostKnowledgeStatus::NeedsReview,
                source: None,
                created_at: now_ms(),
                updated_at: 0,
                confirmed_at: None,
                invalid_reason: None,
                last_observation: None,
            }
        };
        let source = if let Some(evidence) = &draft.evidence {
            let run = checkpoint(&tx, &evidence.run_id)?;
            let step = run
                .state
                .steps
                .iter()
                .find(|s| s.id == evidence.step_id)
                .ok_or_else(|| anyhow::anyhow!("来源步骤不存在"))?;
            let target = step
                .execution_target
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("来源没有实际环境记录"))?;
            if !scope.matches_target(target, run.route_key.as_deref())
                || step.sensitive
                || step.status != "completed"
                || step.execution_phase != "finished"
                || step.exit_code != Some(0)
            {
                bail!("来源需要同一实际环境中的成功、非敏感步骤")
            }
            if draft.kind.is_path() {
                let read = step
                    .file_read
                    .as_ref()
                    .filter(|r| {
                        !r.absent && !r.changed_during_read && r.environment_scope.is_some()
                    })
                    .ok_or_else(|| anyhow::anyhow!("来源不是稳定的路径检查"))?;
                if !["read_file", "list_directory"].contains(&step.tool_name.as_str())
                    || (draft.value != read.path
                        && Some(&draft.value) != read.resolved_path.as_ref())
                {
                    bail!("路径与来源步骤不一致")
                }
                Some(KnowledgeSource {
                    evidence: evidence.clone(),
                    resolved_path: read.resolved_path.clone(),
                    file_scope: read.environment_scope.clone(),
                })
            } else {
                if step.tool_name != "run_command" || draft.value != step.command {
                    bail!("方法与来源命令不一致")
                }
                Some(KnowledgeSource {
                    evidence: evidence.clone(),
                    resolved_path: None,
                    file_scope: None,
                })
            }
        } else {
            None
        };
        record.revision = record
            .revision
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("知识版本已满"))?;
        record.kind = draft.kind;
        record.title = draft.title;
        record.value = draft.value;
        record.status = draft.status;
        record.source = source;
        record.updated_at = now_ms();
        if record.status == HostKnowledgeStatus::Active {
            record.confirmed_at = Some(record.updated_at);
            record.expires_at =
                Some(record.updated_at + u64::from(draft.valid_for_days) * KNOWLEDGE_DAY_MS);
        }
        record.invalid_reason = None;
        // Keep the last observation: explicitly re-confirming a fact must not
        // immediately be undone by replaying the same old tool result.
        write(&tx, &record)?;
        tx.commit()?;
        Ok(record)
    }
    pub fn delete_host_knowledge(&self, profile_id: &str, id: &str, revision: u64) -> Result<bool> {
        let mut connection = self.connection()?;
        let connection = connection.transaction()?;
        let current: Option<u64> = connection
            .query_row(
                "SELECT revision FROM host_knowledge WHERE id=?1 AND profile_id=?2",
                params![id, profile_id],
                |row| row.get(0),
            )
            .optional()?;
        if current.is_none() {
            return Ok(false);
        }
        if current != Some(revision) {
            bail!("知识已经更新，请重新读取后删除")
        }
        let deleted = connection.execute(
            "DELETE FROM host_knowledge WHERE id=?1 AND profile_id=?2 AND revision=?3",
            params![id, profile_id, revision],
        )? == 1;
        connection.commit()?;
        Ok(deleted)
    }
    pub fn host_knowledge_context(
        &self,
        scope: &HostKnowledgeScope,
        target: &ExecutionTarget,
        query: &str,
        run_id: Option<&str>,
    ) -> Result<String> {
        let mut connection = self.connection()?;
        let tx = connection.transaction()?;
        let mut records = rows(&tx, &scope.profile_id)?;
        refresh_validity(&tx, &mut records, now_ms())?;
        if let Some(run_id) = run_id {
            let run = checkpoint(&tx, run_id)?;
            let last = run.last_target.as_ref().unwrap_or(&run.target);
            if last.session_instance != target.session_instance
                || !scope.matches_target(last, run.route_key.as_deref())
            {
                bail!("任务观察不属于当前环境")
            }
            for record in records.iter_mut().filter(|r| &r.scope == scope) {
                let step = run.state.steps.iter().rev().find(|step| {
                    !step.sensitive
                        && step.execution_phase == "finished"
                        && step.execution_target.as_ref().is_some_and(|t| {
                            scope.matches_target(t, run.route_key.as_deref())
                                && t.session_instance == target.session_instance
                        })
                        && if record.kind.is_path() {
                            step.file_read.as_ref().is_some_and(|read| {
                                read.path == record.value
                                    && read.environment_scope.is_some()
                                    && (read.absent
                                        || (step.status == "completed"
                                            && !read.changed_during_read))
                            })
                        } else {
                            step.tool_name == "run_command"
                                && step.command == record.value
                                && step.exit_code.is_some()
                        }
                });
                let Some(step) = step else { continue };
                let evidence = KnowledgeEvidence {
                    run_id: run.run_id.clone(),
                    step_id: step.id.clone(),
                };
                if record.last_observation.as_ref() == Some(&evidence) {
                    continue;
                }
                let conflict = if let Some(read) = &step.file_read {
                    if read.absent {
                        Some((HostKnowledgeStatus::Invalid, "最新文件检查确认路径不存在"))
                    } else if record.source.as_ref().is_some_and(|source| {
                        source.resolved_path.is_some() && source.resolved_path != read.resolved_path
                            || source.file_scope.is_some()
                                && source.file_scope != read.environment_scope
                    }) {
                        Some((
                            HostKnowledgeStatus::NeedsReview,
                            "最新文件检查的实际路径或文件环境与来源不同",
                        ))
                    } else {
                        None
                    }
                } else if step.exit_code != Some(0) {
                    Some((
                        HostKnowledgeStatus::NeedsReview,
                        "最新执行未成功，需要重新确认此方法的适用性",
                    ))
                } else {
                    None
                };
                record.last_observation = Some(evidence);
                if let Some((status, reason)) = conflict {
                    record.status = status;
                    record.invalid_reason = Some(reason.into());
                }
                record.revision = record
                    .revision
                    .checked_add(1)
                    .ok_or_else(|| anyhow::anyhow!("知识版本已满"))?;
                record.updated_at = now_ms();
                write(&tx, record)?;
            }
        }
        let result = knowledge_context(scope, &records, query);
        tx.commit()?;
        Ok(result)
    }
}
