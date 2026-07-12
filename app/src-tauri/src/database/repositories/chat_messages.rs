//! Persisted "Ask anything" chat threads, one per meeting.

use chrono::Utc;
use sqlx::SqlitePool;

/// One persisted chat turn.
#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize, specta::Type)]
pub struct ChatMessageRow {
    pub id: String,
    pub meeting_id: String,
    pub role: String,
    pub content: String,
    pub created_at: String,
}

/// A meeting that has a chat thread, for the "Recent chats" list.
#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize, specta::Type)]
pub struct RecentChatThread {
    pub meeting_id: String,
    pub meeting_title: String,
    /// First user question of the thread - the list's human handle.
    pub first_question: String,
    pub message_count: i64,
    pub last_message_at: String,
}

pub struct ChatMessagesRepository;

impl ChatMessagesRepository {
    /// The meeting's thread in conversation order.
    pub async fn list_for_meeting(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<Vec<ChatMessageRow>, sqlx::Error> {
        sqlx::query_as::<_, ChatMessageRow>(
            "SELECT id, meeting_id, role, content, created_at FROM chat_messages \
             WHERE meeting_id = ? ORDER BY created_at, rowid",
        )
        .bind(meeting_id)
        .fetch_all(pool)
        .await
    }

    /// Append a turn. Returns `false` (writing nothing) when the meeting row
    /// does not exist - live recordings chat under an ephemeral id that is not
    /// in SQLite until save, and those turns stay in-memory by design.
    pub async fn append(
        pool: &SqlitePool,
        meeting_id: &str,
        role: &str,
        content: &str,
    ) -> Result<bool, sqlx::Error> {
        let meeting_exists: bool = sqlx::query("SELECT 1 FROM meetings WHERE id = ?")
            .bind(meeting_id)
            .fetch_optional(pool)
            .await?
            .is_some();
        if !meeting_exists {
            return Ok(false);
        }
        sqlx::query(
            "INSERT INTO chat_messages (id, meeting_id, role, content, created_at) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(format!("chatmsg-{}", uuid::Uuid::new_v4()))
        .bind(meeting_id)
        .bind(role)
        .bind(content)
        .bind(Utc::now().to_rfc3339())
        .execute(pool)
        .await?;
        Ok(true)
    }

    /// Delete the meeting's thread.
    pub async fn clear_for_meeting(pool: &SqlitePool, meeting_id: &str) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM chat_messages WHERE meeting_id = ?")
            .bind(meeting_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// Meetings with chat threads, newest activity first. Excludes trashed
    /// meetings so a recent chat can't navigate into the trash.
    pub async fn recent_threads(
        pool: &SqlitePool,
        limit: i64,
    ) -> Result<Vec<RecentChatThread>, sqlx::Error> {
        sqlx::query_as::<_, RecentChatThread>(
            "SELECT c.meeting_id, m.title AS meeting_title, \
                    (SELECT content FROM chat_messages f \
                     WHERE f.meeting_id = c.meeting_id AND f.role = 'user' \
                     ORDER BY f.created_at, f.rowid LIMIT 1) AS first_question, \
                    COUNT(*) AS message_count, \
                    MAX(c.created_at) AS last_message_at \
             FROM chat_messages c \
             JOIN meetings m ON m.id = c.meeting_id AND m.deleted_at IS NULL \
             GROUP BY c.meeting_id \
             ORDER BY last_message_at DESC \
             LIMIT ?",
        )
        .bind(limit)
        .fetch_all(pool)
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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

    async fn insert_meeting(pool: &SqlitePool, id: &str, title: &str) {
        let now = Utc::now();
        sqlx::query("INSERT INTO meetings (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
            .bind(id)
            .bind(title)
            .bind(now)
            .bind(now)
            .execute(pool)
            .await
            .expect("insert meeting");
    }

    #[tokio::test]
    async fn append_and_list_keep_conversation_order() {
        let pool = test_pool().await;
        insert_meeting(&pool, "m1", "Sync").await;

        assert!(ChatMessagesRepository::append(&pool, "m1", "user", "What was decided?")
            .await
            .expect("append"));
        assert!(ChatMessagesRepository::append(&pool, "m1", "assistant", "The budget.")
            .await
            .expect("append"));

        let thread = ChatMessagesRepository::list_for_meeting(&pool, "m1")
            .await
            .expect("list");
        assert_eq!(thread.len(), 2);
        assert_eq!(thread[0].role, "user");
        assert_eq!(thread[1].role, "assistant");
        assert_eq!(thread[1].content, "The budget.");
    }

    #[tokio::test]
    async fn append_to_missing_meeting_writes_nothing() {
        let pool = test_pool().await;
        // Ephemeral live-recording id: not in `meetings` yet.
        let wrote = ChatMessagesRepository::append(&pool, "meeting-1752300000", "user", "hi")
            .await
            .expect("append");
        assert!(!wrote);
        assert!(ChatMessagesRepository::list_for_meeting(&pool, "meeting-1752300000")
            .await
            .expect("list")
            .is_empty());
    }

    #[tokio::test]
    async fn clear_removes_only_that_meetings_thread() {
        let pool = test_pool().await;
        insert_meeting(&pool, "m1", "Sync").await;
        insert_meeting(&pool, "m2", "Plan").await;
        ChatMessagesRepository::append(&pool, "m1", "user", "a").await.expect("a");
        ChatMessagesRepository::append(&pool, "m2", "user", "b").await.expect("b");

        ChatMessagesRepository::clear_for_meeting(&pool, "m1")
            .await
            .expect("clear");

        assert!(ChatMessagesRepository::list_for_meeting(&pool, "m1")
            .await
            .expect("list")
            .is_empty());
        assert_eq!(
            ChatMessagesRepository::list_for_meeting(&pool, "m2")
                .await
                .expect("list")
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn recent_threads_summarize_newest_first_and_skip_trashed() {
        let pool = test_pool().await;
        insert_meeting(&pool, "m1", "Sync").await;
        insert_meeting(&pool, "m2", "Plan").await;
        insert_meeting(&pool, "m3", "Trashed").await;
        sqlx::query("UPDATE meetings SET deleted_at = ? WHERE id = 'm3'")
            .bind(Utc::now())
            .execute(&pool)
            .await
            .expect("trash m3");

        ChatMessagesRepository::append(&pool, "m1", "user", "First question?").await.expect("a");
        ChatMessagesRepository::append(&pool, "m1", "assistant", "Answer.").await.expect("b");
        ChatMessagesRepository::append(&pool, "m2", "user", "Other question?").await.expect("c");
        ChatMessagesRepository::append(&pool, "m3", "user", "Ghost?").await.expect("d");

        let recent = ChatMessagesRepository::recent_threads(&pool, 10)
            .await
            .expect("recent");
        assert_eq!(recent.len(), 2, "trashed meeting excluded");
        // m2 has the newest activity.
        assert_eq!(recent[0].meeting_id, "m2");
        assert_eq!(recent[0].first_question, "Other question?");
        assert_eq!(recent[1].meeting_id, "m1");
        assert_eq!(recent[1].message_count, 2);
        assert_eq!(recent[1].meeting_title, "Sync");
    }
}
