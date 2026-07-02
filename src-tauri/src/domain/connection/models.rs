use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AuthMode {
    Auto,
    Password,
    Key,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum JumpMode {
    Direct,
    InteractiveMenu,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FileTransferMode {
    Auto,
    SftpDirect,
    SftpGateway,
    ScpThroughTerminal,
    InlineSmallFile,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthEndpoint {
    pub host: String,
    pub port: Option<u16>,
    pub username: String,
    pub auth_mode: AuthMode,
    pub credential_ref: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub gateway: AuthEndpoint,
    pub target: AuthEndpoint,
    pub jump_mode: JumpMode,
    pub menu_profile_id: String,
    pub file_transfer_mode: FileTransferMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MenuStep {
    pub expect: String,
    pub send: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MenuProfile {
    pub id: String,
    pub name: String,
    pub steps: Vec<MenuStep>,
    pub success_patterns: Vec<String>,
    pub failure_patterns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AiProviderType {
    OpenAiCompatible,
    OpenAi,
    CompanyGateway,
    Ollama,
    CustomHttp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ContextPolicy {
    SelectedOutputOnly,
    ActiveCommandOutput,
    ManualAttachments,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderConfig {
    pub id: String,
    pub provider: AiProviderType,
    pub base_url: String,
    pub model: String,
    pub api_key_ref: String,
    pub api_key: Option<String>,
    pub context_policy: ContextPolicy,
    pub system_prompt: String,
    pub risk_policy: String,
}
