use ai_term_lib::keys::{default_key_name, key_comment};

#[test]
fn uses_dedicated_ai_term_key_name() {
    assert_eq!(default_key_name(), "ai-term-ed25519");
}

#[test]
fn key_comment_includes_device_id() {
    assert_eq!(key_comment("local-device"), "ai-term:local-device");
}
