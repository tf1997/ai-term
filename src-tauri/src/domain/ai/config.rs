use anyhow::{bail, Result};

use crate::domain::connection::models::AiProviderConfig;

pub fn validate_ai_config(config: &AiProviderConfig) -> Result<()> {
    if config.id.trim().is_empty() {
        bail!("ai config id is required");
    }
    if config.risk_policy != "confirm-dangerous" {
        bail!("unsupported risk policy");
    }
    Ok(())
}

pub fn redact_ai_config(config: &AiProviderConfig) -> AiProviderConfig {
    let mut redacted = config.clone();
    if !redacted.api_key_ref.trim().is_empty() {
        redacted.api_key_ref = "configured".to_string();
    }
    redacted.api_key = None;
    redacted
}
