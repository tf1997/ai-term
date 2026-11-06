use super::sqlite::SqliteConfigStore;
use crate::domain::filesystem::agent_files::{FileChangeRecord, FileEditStatus};
use anyhow::Result;
use rusqlite::{params, OptionalExtension};

impl SqliteConfigStore {
    pub fn save_agent_file_change(&self, record: &FileChangeRecord) -> Result<()> {
        let record = record.persisted();
        let connection = self.connection()?;
        let status = serde_json::to_string(&record.outcome.status)?;
        connection.execute(
            "INSERT INTO agent_file_changes (id, profile_id, created_at, status, payload) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload = excluded.payload
             WHERE agent_file_changes.status IN ('\"dispatching\"', '\"unknown\"')",
            params![record.id, record.target.profile_id, record.created_at, status, serde_json::to_string(&record)?],
        )?;
        Ok(())
    }
    pub fn get_agent_file_change(&self, id: &str) -> Result<Option<FileChangeRecord>> {
        let connection = self.connection()?;
        let payload: Option<String> = connection
            .query_row(
                "SELECT payload FROM agent_file_changes WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        payload.map(|json| decode(&json)).transpose()
    }
    pub fn list_agent_file_changes(
        &self,
        profile_id: &str,
        limit: u32,
    ) -> Result<Vec<FileChangeRecord>> {
        let connection = self.connection()?;
        let mut query = connection.prepare("SELECT payload FROM agent_file_changes WHERE profile_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2")?;
        let rows = query.query_map(params![profile_id, limit.clamp(1, 100)], |row| {
            row.get::<_, String>(0)
        })?;
        rows.map(|row| decode(&row?)).collect()
    }
}
fn decode(json: &str) -> Result<FileChangeRecord> {
    let mut record: FileChangeRecord = serde_json::from_str(json)?;
    if record.outcome.status == FileEditStatus::Dispatching {
        // A durable dispatch record without a verified result is not proof of
        // failure. It must never turn into a resumable write or an undo ticket.
        record.outcome.status = FileEditStatus::Unknown;
    }
    Ok(record)
}
