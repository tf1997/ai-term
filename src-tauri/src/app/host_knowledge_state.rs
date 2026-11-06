use super::{run_store_task, AppState};
use crate::domain::{ai::host_knowledge::*, command_policy::ExecutionTarget};
use anyhow::{bail, Result};
impl AppState {
    async fn knowledge_scope(&self, expected: &ExecutionTarget) -> Result<HostKnowledgeScope> {
        if self.command_execution_target(&expected.session_id).await? != *expected {
            bail!("知识目标已变化，请重新核对环境")
        }
        HostKnowledgeScope::from_target(expected, self.agent_route_key(expected).await?)
    }
    pub async fn host_knowledge_scope(
        &self,
        expected: ExecutionTarget,
    ) -> Result<HostKnowledgeScope> {
        self.knowledge_scope(&expected).await
    }
    pub async fn list_host_knowledge(&self, profile_id: String) -> Result<Vec<HostKnowledge>> {
        run_store_task(self.store("host knowledge")?, move |store| {
            store.list_host_knowledge(&profile_id)
        })
        .await
    }
    pub async fn save_host_knowledge(
        &self,
        expected: ExecutionTarget,
        draft: HostKnowledgeDraft,
    ) -> Result<HostKnowledge> {
        let scope = self.knowledge_scope(&expected).await?;
        run_store_task(self.store("host knowledge")?, move |store| {
            store.save_host_knowledge(scope, draft)
        })
        .await
    }
    pub async fn delete_host_knowledge(
        &self,
        profile_id: String,
        id: String,
        revision: u64,
    ) -> Result<bool> {
        run_store_task(self.store("host knowledge")?, move |store| {
            store.delete_host_knowledge(&profile_id, &id, revision)
        })
        .await
    }
    pub async fn host_knowledge_context(
        &self,
        expected: ExecutionTarget,
        query: String,
        run_id: Option<String>,
    ) -> Result<String> {
        let scope = self.knowledge_scope(&expected).await?;
        let target = expected.clone();
        let bound_scope = scope.clone();
        let result = run_store_task(self.store("host knowledge")?, move |store| {
            store.host_knowledge_context(&bound_scope, &target, &query, run_id.as_deref())
        })
        .await?;
        if self.knowledge_scope(&expected).await? != scope {
            bail!("读取知识期间目标发生变化")
        }
        Ok(result)
    }
}
