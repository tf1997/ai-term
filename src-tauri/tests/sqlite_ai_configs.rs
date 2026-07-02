use ai_term_lib::domain::connection::models::{AiProviderConfig, AiProviderType, ContextPolicy};
use ai_term_lib::domain::storage::sqlite::SqliteConfigStore;
use rusqlite::Connection;

fn config(id: &str, model: &str) -> AiProviderConfig {
    AiProviderConfig {
        id: id.into(),
        provider: AiProviderType::OpenAiCompatible,
        base_url: "https://ai-gateway.company.com/v1".into(),
        model: model.into(),
        api_key_ref: "ai-provider:default".into(),
        api_key: Some("sk-test".into()),
        context_policy: ContextPolicy::ActiveCommandOutput,
        system_prompt: "You are an assistant for safe server operations.".into(),
        risk_policy: "confirm-dangerous".into(),
    }
}

fn temp_db_path(name: &str) -> String {
    let path =
        std::env::temp_dir().join(format!("ai-term-{name}-{}.sqlite3", uuid::Uuid::new_v4()));
    path.to_string_lossy().into_owned()
}

#[test]
fn sqlite_store_roundtrips_ai_provider_configs() {
    let store = SqliteConfigStore::new(temp_db_path("ai-config-roundtrip"));
    let saved = config("default", "gpt-4.1-mini");

    store.save_ai_provider_config(&saved).unwrap();

    assert_eq!(store.list_ai_provider_configs().unwrap(), vec![saved]);
}

#[test]
fn sqlite_store_updates_existing_ai_provider_config() {
    let store = SqliteConfigStore::new(temp_db_path("ai-config-update"));
    store
        .save_ai_provider_config(&config("default", "gpt-4.1-mini"))
        .unwrap();

    let updated = config("default", "gpt-4.1");
    store.save_ai_provider_config(&updated).unwrap();

    assert_eq!(
        store.get_ai_provider_config("default").unwrap(),
        Some(updated)
    );
}

#[test]
fn sqlite_store_deletes_ai_provider_configs() {
    let store = SqliteConfigStore::new(temp_db_path("ai-config-delete"));
    let saved = config("default", "gpt-4.1-mini");

    store.save_ai_provider_config(&saved).unwrap();

    assert!(store.delete_ai_provider_config("default").unwrap());
    assert!(!store.delete_ai_provider_config("missing").unwrap());
    assert!(store.list_ai_provider_configs().unwrap().is_empty());
}

#[test]
fn sqlite_store_allows_ai_config_without_api_key_ref() {
    let store = SqliteConfigStore::new(temp_db_path("ai-config-no-key"));
    let mut saved = config("default", "gpt-4.1-mini");
    saved.api_key_ref = "".into();
    saved.api_key = None;

    store.save_ai_provider_config(&saved).unwrap();

    assert_eq!(
        store.get_ai_provider_config("default").unwrap(),
        Some(saved)
    );
}

#[test]
fn sqlite_store_migrates_existing_ai_config_table_for_plaintext_api_key() {
    let database_path = temp_db_path("ai-config-api-key-migration");
    let connection = Connection::open(&database_path).unwrap();
    connection
        .execute_batch(
            r#"
            CREATE TABLE ai_provider_configs (
              id TEXT PRIMARY KEY NOT NULL,
              provider TEXT NOT NULL,
              base_url TEXT NOT NULL,
              model TEXT NOT NULL,
              api_key_ref TEXT NOT NULL,
              context_policy TEXT NOT NULL,
              system_prompt TEXT NOT NULL,
              risk_policy TEXT NOT NULL,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            "#,
        )
        .unwrap();
    drop(connection);

    let store = SqliteConfigStore::new(database_path);
    let saved = config("company-gpt4", "gpt-4.1");

    store.save_ai_provider_config(&saved).unwrap();

    assert_eq!(
        store.get_ai_provider_config("company-gpt4").unwrap(),
        Some(saved)
    );
}
