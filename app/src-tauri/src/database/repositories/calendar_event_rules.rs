use chrono::Utc;
use sqlx::SqlitePool;

/// Sentinel `occurrence_minute` for a rule that applies to a whole recurring series
/// (rather than a single occurrence). Chosen to never collide with a real
/// `minute_bucket`, which is always a positive Unix-minute count.
pub const SERIES_OCCURRENCE: i64 = -1;

/// A folder pre-assignment for a calendar event (or its whole series). Keyed by the
/// normalized `ical_uid` + `occurrence_minute` (minute bucket); a per-occurrence rule
/// takes precedence over a series rule for the same uid.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct CalendarEventRule {
    pub id: String,
    pub ical_uid: String,
    pub event_identifier: Option<String>,
    pub occurrence_minute: i64,
    pub folder_id: String,
    pub applies_to_series: bool,
    pub created_at: String,
}

pub struct CalendarEventRulesRepository;

impl CalendarEventRulesRepository {
    /// Create or replace the rule for an occurrence (or, when `applies_to_series`,
    /// the whole series — stored under [`SERIES_OCCURRENCE`]). Callers pass an
    /// already-normalized `ical_uid` (trim + lowercase) so lookups match at record
    /// time regardless of which calendar source won the dedup.
    pub async fn upsert_rule(
        pool: &SqlitePool,
        ical_uid: &str,
        event_identifier: Option<&str>,
        occurrence_minute: i64,
        folder_id: &str,
        applies_to_series: bool,
    ) -> Result<(), sqlx::Error> {
        let stored_minute = if applies_to_series {
            SERIES_OCCURRENCE
        } else {
            occurrence_minute
        };
        let id = format!("rule-{}", uuid::Uuid::new_v4());
        let now = Utc::now();
        sqlx::query(
            r#"
            INSERT INTO calendar_event_rules
                (id, ical_uid, event_identifier, occurrence_minute, folder_id, applies_to_series, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (ical_uid, occurrence_minute) DO UPDATE SET
                folder_id = excluded.folder_id,
                event_identifier = excluded.event_identifier,
                applies_to_series = excluded.applies_to_series
            "#,
        )
        .bind(&id)
        .bind(ical_uid)
        .bind(event_identifier)
        .bind(stored_minute)
        .bind(folder_id)
        .bind(applies_to_series)
        .bind(now)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// The effective rule for an occurrence. A per-occurrence rule wins over a series
    /// rule (`ORDER BY applies_to_series ASC` puts the occurrence row, value 0, first).
    pub async fn rule_for(
        pool: &SqlitePool,
        ical_uid: &str,
        occurrence_minute: i64,
    ) -> Result<Option<CalendarEventRule>, sqlx::Error> {
        sqlx::query_as::<_, CalendarEventRule>(
            r#"
            SELECT id, ical_uid, event_identifier, occurrence_minute, folder_id, applies_to_series, created_at
            FROM calendar_event_rules
            WHERE ical_uid = ? AND (occurrence_minute = ? OR applies_to_series = 1)
            ORDER BY applies_to_series ASC
            LIMIT 1
            "#,
        )
        .bind(ical_uid)
        .bind(occurrence_minute)
        .fetch_optional(pool)
        .await
    }

    /// Folder id currently assigned to an occurrence (for picker hydration), or None.
    pub async fn folder_for(
        pool: &SqlitePool,
        ical_uid: &str,
        occurrence_minute: i64,
    ) -> Result<Option<String>, sqlx::Error> {
        Ok(Self::rule_for(pool, ical_uid, occurrence_minute)
            .await?
            .map(|rule| rule.folder_id))
    }

    /// Remove the per-occurrence rule for this occurrence (unassign). A series rule for
    /// the same uid is left intact — clearing the series is a separate explicit action.
    pub async fn clear_rule(
        pool: &SqlitePool,
        ical_uid: &str,
        occurrence_minute: i64,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "DELETE FROM calendar_event_rules WHERE ical_uid = ? AND occurrence_minute = ?",
        )
        .bind(ical_uid)
        .bind(occurrence_minute)
        .execute(pool)
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::repositories::folders::FoldersRepository;
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

    async fn folder(pool: &SqlitePool, name: &str) -> String {
        FoldersRepository::create_folder(pool, name, None, None)
            .await
            .unwrap()
            .id
    }

    #[tokio::test]
    async fn occurrence_rule_roundtrips() {
        let pool = test_pool().await;
        let work = folder(&pool, "Work").await;

        CalendarEventRulesRepository::upsert_rule(&pool, "uid-a", Some("ek-1"), 100, &work, false)
            .await
            .unwrap();

        let rule = CalendarEventRulesRepository::rule_for(&pool, "uid-a", 100)
            .await
            .unwrap()
            .expect("rule present");
        assert_eq!(rule.folder_id, work);
        assert!(!rule.applies_to_series);
        // A different occurrence of the same uid has no rule.
        assert!(
            CalendarEventRulesRepository::rule_for(&pool, "uid-a", 200)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn upsert_replaces_folder_for_same_occurrence() {
        let pool = test_pool().await;
        let a = folder(&pool, "A").await;
        let b = folder(&pool, "B").await;

        CalendarEventRulesRepository::upsert_rule(&pool, "uid-a", None, 100, &a, false)
            .await
            .unwrap();
        CalendarEventRulesRepository::upsert_rule(&pool, "uid-a", None, 100, &b, false)
            .await
            .unwrap();

        assert_eq!(
            CalendarEventRulesRepository::folder_for(&pool, "uid-a", 100)
                .await
                .unwrap(),
            Some(b)
        );
    }

    #[tokio::test]
    async fn series_rule_matches_any_occurrence() {
        let pool = test_pool().await;
        let team = folder(&pool, "Team").await;

        CalendarEventRulesRepository::upsert_rule(&pool, "uid-s", None, 999, &team, true)
            .await
            .unwrap();

        // Any future occurrence of the series resolves to the folder.
        for minute in [500, 5000, 50000] {
            assert_eq!(
                CalendarEventRulesRepository::folder_for(&pool, "uid-s", minute)
                    .await
                    .unwrap()
                    .as_deref(),
                Some(team.as_str())
            );
        }
    }

    #[tokio::test]
    async fn occurrence_override_beats_series_rule() {
        let pool = test_pool().await;
        let series_folder = folder(&pool, "Series").await;
        let override_folder = folder(&pool, "Override").await;

        CalendarEventRulesRepository::upsert_rule(&pool, "uid-x", None, 0, &series_folder, true)
            .await
            .unwrap();
        CalendarEventRulesRepository::upsert_rule(
            &pool,
            "uid-x",
            None,
            777,
            &override_folder,
            false,
        )
        .await
        .unwrap();

        // The overridden occurrence uses the override folder...
        assert_eq!(
            CalendarEventRulesRepository::folder_for(&pool, "uid-x", 777)
                .await
                .unwrap(),
            Some(override_folder)
        );
        // ...while other occurrences still follow the series folder.
        assert_eq!(
            CalendarEventRulesRepository::folder_for(&pool, "uid-x", 888)
                .await
                .unwrap(),
            Some(series_folder)
        );
    }

    #[tokio::test]
    async fn clear_removes_occurrence_but_keeps_series() {
        let pool = test_pool().await;
        let series_folder = folder(&pool, "Series").await;
        let override_folder = folder(&pool, "Override").await;
        CalendarEventRulesRepository::upsert_rule(&pool, "uid-x", None, 0, &series_folder, true)
            .await
            .unwrap();
        CalendarEventRulesRepository::upsert_rule(
            &pool,
            "uid-x",
            None,
            777,
            &override_folder,
            false,
        )
        .await
        .unwrap();

        CalendarEventRulesRepository::clear_rule(&pool, "uid-x", 777)
            .await
            .unwrap();

        // The override is gone; the occurrence falls back to the series folder.
        assert_eq!(
            CalendarEventRulesRepository::folder_for(&pool, "uid-x", 777)
                .await
                .unwrap(),
            Some(series_folder)
        );
    }

    #[tokio::test]
    async fn deleting_folder_cascades_rules_away() {
        let pool = test_pool().await;
        let doomed = folder(&pool, "Doomed").await;
        CalendarEventRulesRepository::upsert_rule(&pool, "uid-a", None, 100, &doomed, false)
            .await
            .unwrap();

        // ON DELETE CASCADE requires foreign keys to be enabled per-connection.
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .unwrap();
        FoldersRepository::delete_folder(&pool, &doomed)
            .await
            .unwrap();

        assert!(
            CalendarEventRulesRepository::rule_for(&pool, "uid-a", 100)
                .await
                .unwrap()
                .is_none()
        );
    }
}
