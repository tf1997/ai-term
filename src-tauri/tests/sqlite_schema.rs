use ai_term_lib::domain::storage::sqlite::{
    default_database_path, schema_contains_required_tables, validate_schema, SCHEMA,
};
use std::path::Path;

#[test]
fn schema_contains_required_config_tables() {
    assert!(schema_contains_required_tables());
    assert!(validate_schema().is_ok());
}

#[test]
fn schema_stores_plaintext_ssh_and_ai_passwords() {
    assert!(SCHEMA.contains("gateway_credential_ref"));
    assert!(SCHEMA.contains("target_credential_ref"));
    assert!(SCHEMA.contains("gateway_password"));
    assert!(SCHEMA.contains("target_password"));
    assert!(SCHEMA.contains("api_key_ref"));
    assert!(SCHEMA.contains("api_key TEXT"));
}

#[test]
fn default_database_path_uses_app_config_directory() {
    let path = default_database_path(Path::new("/tmp/ai-term-test"));
    let expected = Path::new("/tmp/ai-term-test")
        .join("ai-term.sqlite3")
        .to_string_lossy()
        .into_owned();
    assert_eq!(path, expected);
}
