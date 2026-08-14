use serde::{Deserialize, Serialize};

pub const LOCAL_CONNECTION_ID: &str = "local";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSession {
    pub id: String,
    pub connection_id: String,
    pub name: String,
    pub summary: String,
    /// AI-compressed summary of conversation turns older than the recent
    /// window; empty when the session has not been compacted yet.
    #[serde(default)]
    pub context_summary: String,
    /// Id of the last conversation message covered by `context_summary`.
    #[serde(default)]
    pub context_summary_last_message_id: String,
    /// 会话的 AI 面板模式("chat" / "agent");旧数据缺省按 chat 处理。
    #[serde(default = "default_ai_mode")]
    pub ai_mode: String,
    pub created_at: String,
    pub updated_at: String,
}

/// 旧库/旧前端数据不带 `aiMode` 字段,反序列化时回退为普通对话模式。
fn default_ai_mode() -> String {
    "chat".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandHistoryRecord {
    pub id: String,
    pub connection_id: String,
    pub workspace_session_id: String,
    pub terminal_id: String,
    pub command: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiConversationMessage {
    pub id: String,
    pub connection_id: String,
    pub workspace_session_id: String,
    pub terminal_id: String,
    pub role: AiMessageRole,
    pub text: String,
    pub command: Option<String>,
    pub error: bool,
    /// agent 消息的结构化 payload(`{mode, agentSteps, agentStatus}` 的 JSON 序列化);
    /// 空串按纯 chat 消息处理。
    #[serde(default)]
    pub payload_json: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateScript {
    pub id: String,
    pub connection_id: String,
    pub workspace_session_id: String,
    pub name: String,
    pub description: String,
    pub content: String,
    pub source_commands: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Agent 模式「总是允许」命令允许列表条目(见 docs/ai-agent-mode-development.md 6.4)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommandAllowlistEntry {
    /// token 前缀模式,如 "git status"。
    pub pattern: String,
    /// 点击「总是允许」时的完整来源命令。
    pub source_command: String,
    pub created_at: String,
    /// 最近一次自动执行命中时间;从未命中为 None。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,
    /// 自动执行命中次数。
    pub use_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AiMessageRole {
    User,
    Assistant,
}
