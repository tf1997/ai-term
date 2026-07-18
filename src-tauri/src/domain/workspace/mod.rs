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
    pub created_at: String,
    pub updated_at: String,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AiMessageRole {
    User,
    Assistant,
}
