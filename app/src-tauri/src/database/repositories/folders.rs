use crate::database::models::FolderModel;
use chrono::Utc;
use sqlx::SqlitePool;

pub struct FoldersRepository;

impl FoldersRepository {
    /// All folders, alphabetical.
    pub async fn list_folders(pool: &SqlitePool) -> Result<Vec<FolderModel>, sqlx::Error> {
        sqlx::query_as::<_, FolderModel>(
            "SELECT id, name, emoji, created_at, updated_at FROM folders ORDER BY name COLLATE NOCASE ASC",
        )
        .fetch_all(pool)
        .await
    }

    /// Create a folder and return it. Generates a `folder-{uuid}` id.
    pub async fn create_folder(
        pool: &SqlitePool,
        name: &str,
        emoji: Option<&str>,
    ) -> Result<FolderModel, sqlx::Error> {
        let id = format!("folder-{}", uuid::Uuid::new_v4());
        let now = Utc::now();
        sqlx::query(
            "INSERT INTO folders (id, name, emoji, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(name)
        .bind(emoji)
        .bind(now)
        .bind(now)
        .execute(pool)
        .await?;
        Ok(FolderModel {
            id,
            name: name.to_string(),
            emoji: emoji.map(str::to_string),
            created_at: crate::database::models::DateTimeUtc(now),
            updated_at: crate::database::models::DateTimeUtc(now),
        })
    }

    /// Update a folder's name and emoji. False if it doesn't exist.
    pub async fn update_folder(
        pool: &SqlitePool,
        folder_id: &str,
        name: &str,
        emoji: Option<&str>,
    ) -> Result<bool, sqlx::Error> {
        let now = Utc::now();
        let result = sqlx::query("UPDATE folders SET name = ?, emoji = ?, updated_at = ? WHERE id = ?")
            .bind(name)
            .bind(emoji)
            .bind(now)
            .bind(folder_id)
            .execute(pool)
            .await?;
        Ok(result.rows_affected() > 0)
    }

    /// Delete a folder, detaching (not deleting) its meetings. False if absent.
    /// Foreign keys aren't relied upon here, so the detach is explicit.
    pub async fn delete_folder(pool: &SqlitePool, folder_id: &str) -> Result<bool, sqlx::Error> {
        let mut tx = pool.begin().await?;

        sqlx::query("UPDATE meetings SET folder_id = NULL WHERE folder_id = ?")
            .bind(folder_id)
            .execute(&mut *tx)
            .await?;

        // Drop event→folder pre-assign rules for this folder in the same transaction
        // (the ON DELETE CASCADE is inert — SQLite foreign keys are off app-wide).
        sqlx::query("DELETE FROM calendar_event_rules WHERE folder_id = ?")
            .bind(folder_id)
            .execute(&mut *tx)
            .await?;

        let result = sqlx::query("DELETE FROM folders WHERE id = ?")
            .bind(folder_id)
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;
        Ok(result.rows_affected() > 0)
    }

    /// Move a meeting into a folder, or out of all folders when `folder_id` is None.
    pub async fn set_meeting_folder(
        pool: &SqlitePool,
        meeting_id: &str,
        folder_id: Option<&str>,
    ) -> Result<bool, sqlx::Error> {
        let now = Utc::now();
        let result = sqlx::query("UPDATE meetings SET folder_id = ?, updated_at = ? WHERE id = ?")
            .bind(folder_id)
            .bind(now)
            .bind(meeting_id)
            .execute(pool)
            .await?;
        Ok(result.rows_affected() > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::repositories::meeting::MeetingsRepository;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect in-memory sqlite");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        pool
    }

    async fn insert_meeting(pool: &SqlitePool, id: &str) {
        let now = Utc::now();
        sqlx::query("INSERT INTO meetings (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
            .bind(id)
            .bind("Test meeting")
            .bind(now)
            .bind(now)
            .execute(pool)
            .await
            .expect("insert meeting");
    }

    #[tokio::test]
    async fn create_list_update_folder() {
        let pool = test_pool().await;
        let folder = FoldersRepository::create_folder(&pool, "Work", Some("💼")).await.unwrap();
        assert!(folder.id.starts_with("folder-"));
        assert_eq!(folder.emoji.as_deref(), Some("💼"));

        let folders = FoldersRepository::list_folders(&pool).await.unwrap();
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].name, "Work");
        assert_eq!(folders[0].emoji.as_deref(), Some("💼"));

        assert!(FoldersRepository::update_folder(&pool, &folder.id, "Projects", Some("📁"))
            .await
            .unwrap());
        let folders = FoldersRepository::list_folders(&pool).await.unwrap();
        assert_eq!(folders[0].name, "Projects");
        assert_eq!(folders[0].emoji.as_deref(), Some("📁"));
    }

    #[tokio::test]
    async fn move_meeting_in_and_out_of_folder() {
        let pool = test_pool().await;
        insert_meeting(&pool, "m1").await;
        let folder = FoldersRepository::create_folder(&pool, "Work", None).await.unwrap();

        assert!(FoldersRepository::set_meeting_folder(&pool, "m1", Some(&folder.id)).await.unwrap());
        let m = MeetingsRepository::get_meeting_metadata(&pool, "m1").await.unwrap().unwrap();
        assert_eq!(m.folder_id.as_deref(), Some(folder.id.as_str()));

        assert!(FoldersRepository::set_meeting_folder(&pool, "m1", None).await.unwrap());
        let m = MeetingsRepository::get_meeting_metadata(&pool, "m1").await.unwrap().unwrap();
        assert!(m.folder_id.is_none());
    }

    #[tokio::test]
    async fn delete_folder_detaches_meetings() {
        let pool = test_pool().await;
        insert_meeting(&pool, "m1").await;
        let folder = FoldersRepository::create_folder(&pool, "Work", None).await.unwrap();
        FoldersRepository::set_meeting_folder(&pool, "m1", Some(&folder.id)).await.unwrap();

        assert!(FoldersRepository::delete_folder(&pool, &folder.id).await.unwrap());
        assert!(FoldersRepository::list_folders(&pool).await.unwrap().is_empty());

        // Meeting survives, detached from the folder.
        let m = MeetingsRepository::get_meeting_metadata(&pool, "m1").await.unwrap().unwrap();
        assert!(m.folder_id.is_none());
    }
}
