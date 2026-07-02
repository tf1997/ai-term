use anyhow::Result;

pub trait CredentialStore: Send + Sync {
    fn set_secret(&self, key: &str, value: &str) -> Result<()>;
    fn get_secret(&self, key: &str) -> Result<Option<String>>;
    fn delete_secret(&self, key: &str) -> Result<()>;
}

#[derive(Debug, Default)]
pub struct MemoryCredentialStore {
    values: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

impl CredentialStore for MemoryCredentialStore {
    fn set_secret(&self, key: &str, value: &str) -> Result<()> {
        self.values
            .lock()
            .expect("credential store lock poisoned")
            .insert(key.to_string(), value.to_string());
        Ok(())
    }

    fn get_secret(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .values
            .lock()
            .expect("credential store lock poisoned")
            .get(key)
            .cloned())
    }

    fn delete_secret(&self, key: &str) -> Result<()> {
        self.values
            .lock()
            .expect("credential store lock poisoned")
            .remove(key);
        Ok(())
    }
}
