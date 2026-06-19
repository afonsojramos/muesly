use serde::{Deserialize, Serialize};
use sqlx::{Error as SqlxError, FromRow, SqlitePool};

/// A reusable dictation cleanup instruction. At most one preset is active at a
/// time; the active preset's `prompt` drives the cleanup pass before injection.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, specta::Type)]
pub struct DictationCleanupPreset {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub is_active: bool,
    pub created_at: String,
}

pub struct DictationCleanupPresetsRepository;

impl DictationCleanupPresetsRepository {
    /// All presets, oldest first.
    pub async fn list(pool: &SqlitePool) -> Result<Vec<DictationCleanupPreset>, SqlxError> {
        sqlx::query_as(
            "SELECT id, name, prompt, is_active, created_at \
             FROM dictation_cleanup_presets ORDER BY created_at",
        )
        .fetch_all(pool)
        .await
    }

    /// The active preset, if any.
    pub async fn active(pool: &SqlitePool) -> Result<Option<DictationCleanupPreset>, SqlxError> {
        sqlx::query_as(
            "SELECT id, name, prompt, is_active, created_at \
             FROM dictation_cleanup_presets WHERE is_active = 1 LIMIT 1",
        )
        .fetch_optional(pool)
        .await
    }

    /// Create a preset (inactive) and return it.
    pub async fn create(
        pool: &SqlitePool,
        name: &str,
        prompt: &str,
    ) -> Result<DictationCleanupPreset, SqlxError> {
        let id = uuid::Uuid::new_v4().to_string();
        let created_at = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO dictation_cleanup_presets (id, name, prompt, is_active, created_at) \
             VALUES (?, ?, ?, 0, ?)",
        )
        .bind(&id)
        .bind(name)
        .bind(prompt)
        .bind(&created_at)
        .execute(pool)
        .await?;
        Ok(DictationCleanupPreset {
            id,
            name: name.to_string(),
            prompt: prompt.to_string(),
            is_active: false,
            created_at,
        })
    }

    /// Rename / re-word a preset.
    pub async fn update(
        pool: &SqlitePool,
        id: &str,
        name: &str,
        prompt: &str,
    ) -> Result<(), SqlxError> {
        sqlx::query("UPDATE dictation_cleanup_presets SET name = ?, prompt = ? WHERE id = ?")
            .bind(name)
            .bind(prompt)
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// Delete a preset.
    pub async fn delete(pool: &SqlitePool, id: &str) -> Result<(), SqlxError> {
        sqlx::query("DELETE FROM dictation_cleanup_presets WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// Make exactly one preset active (clears the flag on all others).
    pub async fn set_active(pool: &SqlitePool, id: &str) -> Result<(), SqlxError> {
        let mut tx = pool.begin().await?;
        sqlx::query("UPDATE dictation_cleanup_presets SET is_active = 0")
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE dictation_cleanup_presets SET is_active = 1 WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }
}
