use ai_term_lib::ai::{redact_ai_config, validate_ai_config};
use ai_term_lib::models::{AiProviderConfig, AiProviderType, ContextPolicy};

fn config() -> AiProviderConfig {
    AiProviderConfig {
        id: "default".into(),
        provider: AiProviderType::OpenAiCompatible,
        base_url: "https://ai-gateway.company.com/v1".into(),
        model: "gpt-4.1-mini".into(),
        api_key_ref: "ai-provider:default".into(),
        api_key: Some("sk-test".into()),
        context_policy: ContextPolicy::SelectedOutputOnly,
        system_prompt: "You are an assistant for safe server operations.".into(),
        risk_policy: "confirm-dangerous".into(),
        timeout_seconds: 0,
    }
}

#[test]
fn valid_ai_config_passes() {
    assert!(validate_ai_config(&config()).is_ok());
}

#[test]
fn draft_ai_config_without_endpoint_fields_can_be_saved() {
    let mut draft = config();
    draft.base_url = "".into();
    draft.model = "".into();
    draft.api_key_ref = "".into();
    draft.api_key = None;

    assert!(validate_ai_config(&draft).is_ok());
}

#[test]
fn redacted_config_keeps_reference_not_secret() {
    let redacted = redact_ai_config(&config());
    assert_eq!(redacted.api_key_ref, "configured");
    assert_eq!(redacted.api_key, None);
}

#[test]
fn ai_provider_json_uses_backend_kebab_case_names() {
    let payload = serde_json::json!({
        "id": "default",
        "provider": "open-ai-compatible",
        "baseUrl": "https://ai-gateway.company.com/v1",
        "model": "gpt-4.1-mini",
        "apiKeyRef": "ai-provider:default",
        "apiKey": "sk-test",
        "contextPolicy": "selected-output-only",
        "systemPrompt": "You are an assistant for safe server operations.",
        "riskPolicy": "confirm-dangerous"
    });

    let config: AiProviderConfig = serde_json::from_value(payload).unwrap();
    assert_eq!(config.provider, AiProviderType::OpenAiCompatible);
    assert_eq!(config.timeout_seconds, 0);

    let serialized = serde_json::to_value(config).unwrap();
    assert_eq!(serialized["provider"], "open-ai-compatible");
    assert_eq!(serialized["timeoutSeconds"], 0);
}

#[test]
fn ai_timeout_round_trips_and_rejects_invalid_values() {
    let mut configured = config();
    configured.timeout_seconds = 120;
    assert!(validate_ai_config(&configured).is_ok());
    let payload = serde_json::to_value(&configured).unwrap();
    assert_eq!(payload["timeoutSeconds"], 120);
    assert_eq!(
        serde_json::from_value::<AiProviderConfig>(payload.clone()).unwrap(),
        configured
    );

    for invalid in [
        serde_json::json!(-1),
        serde_json::json!(1.5),
        serde_json::json!(4_294_967_296_u64),
    ] {
        let mut invalid_payload = payload.clone();
        invalid_payload["timeoutSeconds"] = invalid;
        assert!(serde_json::from_value::<AiProviderConfig>(invalid_payload).is_err());
    }
}
