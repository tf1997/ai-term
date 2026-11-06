use std::collections::HashMap;
use std::time::{Duration, Instant};

use anyhow::{bail, Result};

use super::{SshTaskIntent, SshTaskReference, SshTaskRequest, SshTaskTarget};
use crate::domain::command_policy::{
    analyze_command, AnalysisBudget, AnalysisIssue, Decision, ExecutionTarget, ShellDialect,
    SourceRange, POLICY_VERSION,
};
use crate::domain::connection::models::ConnectionProfile;

const TTL: Duration = Duration::from_secs(5 * 60);

struct Pending {
    intent: SshTaskIntent,
    profile: ConnectionProfile,
    approved: bool,
    expires: Instant,
}

#[derive(Default)]
pub struct SshTaskStore {
    pending: HashMap<String, Pending>,
}

/// Not deserializable. Only consumption of an approved, current intent can
/// create the operation accepted by the network executor.
pub struct SshTaskDispatch {
    pub(crate) intent: SshTaskIntent,
    pub(crate) profile: ConnectionProfile,
}

impl SshTaskDispatch {
    pub fn intent(&self) -> &SshTaskIntent {
        &self.intent
    }
}

impl SshTaskStore {
    pub fn prepare(
        request: SshTaskRequest,
        origin: ExecutionTarget,
        profile: ConnectionProfile,
    ) -> Result<SshTaskIntent> {
        request.validate()?;
        if origin.profile_id != profile.id {
            bail!("独立任务的连接目标不一致");
        }
        let target = SshTaskTarget::from_profile(&profile)?;
        let mut analysis = analyze_command(
            &request.command,
            ShellDialect::Posix,
            AnalysisBudget::default(),
        );
        if analysis.decision != Decision::Deny {
            analysis.decision = Decision::Ask;
        }
        analysis.unknown_reasons.push(AnalysisIssue {
            code: "independent-ssh-scope".into(),
            message: "独立登录环境使用 /bin/sh、指定目录和清空后显式设置的环境；不会继承当前终端的目录、提权、函数或容器。环境变量也可能改变命令行为，需要逐次确认。".into(),
            range: SourceRange::new(&request.command, 0, request.command.len()),
        });
        Ok(SshTaskIntent {
            reference: SshTaskReference {
                id: uuid::Uuid::new_v4().to_string(),
                origin,
                policy_version: POLICY_VERSION.into(),
            },
            effective_environment: request.effective_environment(),
            request,
            target,
            analysis,
            expires_in_ms: TTL.as_millis() as u64,
        })
    }

    pub fn insert(
        &mut self,
        intent: SshTaskIntent,
        profile: ConnectionProfile,
        current: &ExecutionTarget,
    ) -> Result<SshTaskIntent> {
        if intent.reference.origin != *current
            || intent.target != SshTaskTarget::from_profile(&profile)?
        {
            bail!("独立任务目标已变化，请重新分析");
        }
        self.pending
            .retain(|_, entry| entry.expires > Instant::now());
        if self.pending.len() >= 16 {
            bail!("待审批的独立任务过多");
        }
        self.pending.insert(
            intent.reference.id.clone(),
            Pending {
                intent: intent.clone(),
                profile,
                approved: false,
                expires: Instant::now() + TTL,
            },
        );
        Ok(intent)
    }

    fn checked(
        &mut self,
        reference: &SshTaskReference,
        current: &ExecutionTarget,
    ) -> Result<&mut Pending> {
        let Some(entry) = self.pending.get_mut(&reference.id) else {
            bail!("独立任务已派发或失效，不能重放");
        };
        if entry.expires <= Instant::now()
            || entry.intent.reference != *reference
            || reference.origin != *current
            || reference.policy_version != POLICY_VERSION
        {
            bail!("独立任务目标、策略或审批已失效");
        }
        if entry.intent.analysis.decision == Decision::Deny {
            bail!("命令被策略拒绝");
        }
        Ok(entry)
    }

    pub fn approve(
        &mut self,
        reference: &SshTaskReference,
        current: &ExecutionTarget,
        reviewed: &SshTaskRequest,
        target: &SshTaskTarget,
    ) -> Result<()> {
        let entry = self.checked(reference, current)?;
        if entry.intent.request != *reviewed || entry.intent.target != *target {
            bail!("确认的命令、环境或目标与独立任务不一致");
        }
        entry.approved = true;
        Ok(())
    }

    pub fn consume(
        &mut self,
        reference: &SshTaskReference,
        current: &ExecutionTarget,
        profile: &ConnectionProfile,
    ) -> Result<SshTaskDispatch> {
        let entry = self.checked(reference, current)?;
        if !entry.approved {
            bail!("独立任务需要用户逐次确认");
        }
        if entry.profile != *profile {
            bail!("独立任务连接配置已改变");
        }
        let entry = self.pending.remove(&reference.id).expect("checked");
        Ok(SshTaskDispatch {
            intent: entry.intent,
            profile: entry.profile,
        })
    }

    pub fn cancel(&mut self, reference: &SshTaskReference) -> bool {
        if self
            .pending
            .get(&reference.id)
            .is_some_and(|entry| entry.intent.reference == *reference)
        {
            self.pending.remove(&reference.id);
            true
        } else {
            false
        }
    }
    pub fn invalidate(&mut self) {
        self.pending.clear();
    }
}
