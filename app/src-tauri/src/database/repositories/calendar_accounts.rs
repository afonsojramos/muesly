use crate::database::models::CalendarAccount;
use sqlx::SqlitePool;

pub struct CalendarAccountsRepository;

impl CalendarAccountsRepository {
    /// All connected calendar sources (local + Google accounts).
    pub async fn list(pool: &SqlitePool) -> Result<Vec<CalendarAccount>, sqlx::Error> {
        sqlx::query_as::<_, CalendarAccount>(
            "SELECT * FROM calendar_accounts ORDER BY source, created_at",
        )
        .fetch_all(pool)
        .await
    }

    pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<CalendarAccount>, sqlx::Error> {
        sqlx::query_as::<_, CalendarAccount>("SELECT * FROM calendar_accounts WHERE id = ?")
            .bind(id)
            .fetch_optional(pool)
            .await
    }

    /// Insert or update an account. `created_at` is preserved on conflict.
    pub async fn upsert(pool: &SqlitePool, account: &CalendarAccount) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO calendar_accounts
                (id, source, email, enabled, excluded_calendar_ids, status, created_at, calendars_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                source = excluded.source,
                email = excluded.email,
                enabled = excluded.enabled,
                excluded_calendar_ids = excluded.excluded_calendar_ids,
                status = excluded.status,
                calendars_json = excluded.calendars_json
            "#,
        )
        .bind(&account.id)
        .bind(&account.source)
        .bind(&account.email)
        .bind(account.enabled)
        .bind(&account.excluded_calendar_ids)
        .bind(&account.status)
        .bind(&account.created_at)
        .bind(&account.calendars_json)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn delete(pool: &SqlitePool, id: &str) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM calendar_accounts WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
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

    fn google_account(id: &str, email: &str) -> CalendarAccount {
        CalendarAccount {
            id: id.to_string(),
            source: "google".to_string(),
            email: Some(email.to_string()),
            enabled: true,
            excluded_calendar_ids: Some("[]".to_string()),
            status: None,
            created_at: "2026-06-29T12:00:00Z".to_string(),
            calendars_json: None,
        }
    }

    #[tokio::test]
    async fn migration_backfills_eventkit_local_row() {
        let pool = test_pool().await;
        let local = CalendarAccountsRepository::get(&pool, "eventkit-local")
            .await
            .expect("query")
            .expect("eventkit-local row present");
        assert_eq!(local.source, "eventkit");
        assert!(local.enabled);
    }

    #[tokio::test]
    async fn upsert_then_get_and_list() {
        let pool = test_pool().await;
        CalendarAccountsRepository::upsert(&pool, &google_account("sub-1", "a@x.com"))
            .await
            .expect("upsert");

        let got = CalendarAccountsRepository::get(&pool, "sub-1")
            .await
            .expect("query")
            .expect("present");
        assert_eq!(got.email.as_deref(), Some("a@x.com"));
        assert!(got.enabled);

        // list includes the backfilled local row + the google one.
        let all = CalendarAccountsRepository::list(&pool).await.expect("list");
        assert!(all.iter().any(|a| a.id == "eventkit-local"));
        assert!(all.iter().any(|a| a.id == "sub-1"));
    }

    #[tokio::test]
    async fn upsert_updates_enabled_and_status_preserving_created_at() {
        let pool = test_pool().await;
        CalendarAccountsRepository::upsert(&pool, &google_account("sub-1", "a@x.com"))
            .await
            .expect("first");

        let mut updated = google_account("sub-1", "a@x.com");
        updated.enabled = false;
        updated.status = Some("reauth_required".to_string());
        updated.created_at = "2099-01-01T00:00:00Z".to_string(); // must be ignored
        CalendarAccountsRepository::upsert(&pool, &updated)
            .await
            .expect("second");

        let got = CalendarAccountsRepository::get(&pool, "sub-1")
            .await
            .expect("query")
            .expect("present");
        assert!(!got.enabled);
        assert_eq!(got.status.as_deref(), Some("reauth_required"));
        assert_eq!(got.created_at, "2026-06-29T12:00:00Z");
    }

    #[tokio::test]
    async fn delete_removes_account() {
        let pool = test_pool().await;
        CalendarAccountsRepository::upsert(&pool, &google_account("sub-1", "a@x.com"))
            .await
            .expect("upsert");
        CalendarAccountsRepository::delete(&pool, "sub-1")
            .await
            .expect("delete");
        assert!(
            CalendarAccountsRepository::get(&pool, "sub-1")
                .await
                .expect("query")
                .is_none()
        );
    }
}
