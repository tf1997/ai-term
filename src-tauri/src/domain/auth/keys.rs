use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppKeyInfo {
    pub name: String,
    pub private_key_path: PathBuf,
    pub public_key_path: PathBuf,
    pub comment: String,
}

pub fn default_key_name() -> &'static str {
    "ai-term-ed25519"
}

pub fn key_comment(device_id: &str) -> String {
    format!("ai-term:{device_id}")
}
