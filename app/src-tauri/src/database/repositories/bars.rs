//! User-authored chat bars (reusable prompts). Built-in and imported bars
//! live in the frontend catalog; this stores only what the user creates.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

/// Raw row; `scenarios` is a comma-separated list on disk.
#[derive(Debug, Clone, sqlx::FromRow)]
struct BarRow {
    id: String,
    title: String,
    description: String,
    prompt: String,
    scenarios: String,
    icon: String,
    created_at: String,
    updated_at: String,
}

/// A saved bar, with `scenarios` split back into a list for the frontend.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct UserBar {
    pub id: String,
    pub title: String,
    pub description: String,
    pub prompt: String,
    pub scenarios: Vec<String>,
    pub icon: String,
    pub created_at: String,
    pub updated_at: String,
}

impl From<BarRow> for UserBar {
    fn from(r: BarRow) -> Self {
        let scenarios = r
            .scenarios
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
        UserBar {
            id: r.id,
            title: r.title,
            description: r.description,
            prompt: r.prompt,
            scenarios,
            icon: r.icon,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

/// Create/update payload. `id` present = edit; absent/empty = create.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct BarInput {
    pub id: Option<String>,
    pub title: String,
    pub description: String,
    pub prompt: String,
    pub scenarios: Vec<String>,
    pub icon: String,
}

/// Keep only known scenarios (before/during/after a meeting, or across
/// meetings), defaulting to `after` if none survive.
fn normalize_scenarios(scenarios: &[String]) -> String {
    const KNOWN: [&str; 4] = ["before", "during", "after", "across"];
    let valid: Vec<&str> = scenarios
        .iter()
        .map(String::as_str)
        .filter(|s| KNOWN.contains(s))
        .collect();
    if valid.is_empty() {
        "after".to_string()
    } else {
        valid.join(",")
    }
}

pub struct BarsRepository;

impl BarsRepository {
    /// All user bars, most recently edited first.
    pub async fn list(pool: &SqlitePool) -> Result<Vec<UserBar>, sqlx::Error> {
        let rows = sqlx::query_as::<_, BarRow>(
            "SELECT id, title, description, prompt, scenarios, icon, created_at, updated_at \
             FROM bars ORDER BY updated_at DESC, rowid DESC",
        )
        .fetch_all(pool)
        .await?;
        Ok(rows.into_iter().map(UserBar::from).collect())
    }

    /// Insert a new bar or update an existing one (by `id`).
    pub async fn upsert(pool: &SqlitePool, input: BarInput) -> Result<UserBar, sqlx::Error> {
        let now = Utc::now().to_rfc3339();
        let scenarios = normalize_scenarios(&input.scenarios);
        let id = input
            .id
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("bar-{}", uuid::Uuid::new_v4()));
        // created_at is only set on insert; the update path leaves it untouched.
        sqlx::query(
            "INSERT INTO bars (id, title, description, prompt, scenarios, icon, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(id) DO UPDATE SET \
               title = excluded.title, description = excluded.description, \
               prompt = excluded.prompt, scenarios = excluded.scenarios, \
               icon = excluded.icon, updated_at = excluded.updated_at",
        )
        .bind(&id)
        .bind(&input.title)
        .bind(&input.description)
        .bind(&input.prompt)
        .bind(&scenarios)
        .bind(&input.icon)
        .bind(&now)
        .bind(&now)
        .execute(pool)
        .await?;
        let row = sqlx::query_as::<_, BarRow>(
            "SELECT id, title, description, prompt, scenarios, icon, created_at, updated_at \
             FROM bars WHERE id = ?",
        )
        .bind(&id)
        .fetch_one(pool)
        .await?;
        Ok(row.into())
    }

    /// Delete a user bar by id.
    pub async fn delete(pool: &SqlitePool, id: &str) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM bars WHERE id = ?")
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

    fn input(title: &str, scenarios: &[&str]) -> BarInput {
        BarInput {
            id: None,
            title: title.to_string(),
            description: "desc".to_string(),
            prompt: "do the thing".to_string(),
            scenarios: scenarios.iter().map(|s| s.to_string()).collect(),
            icon: "sparkles".to_string(),
        }
    }

    #[tokio::test]
    async fn creates_lists_updates_and_deletes() {
        let pool = test_pool().await;

        let created = BarsRepository::upsert(&pool, input("Weekly recap", &["across"]))
            .await
            .unwrap();
        assert!(created.id.starts_with("bar-"));
        assert_eq!(created.scenarios, vec!["across"]);

        let all = BarsRepository::list(&pool).await.unwrap();
        assert_eq!(all.len(), 1);

        // Editing by id keeps the same row and updates fields.
        let edited = BarsRepository::upsert(
            &pool,
            BarInput {
                id: Some(created.id.clone()),
                title: "Weekly recap v2".to_string(),
                ..input("ignored", &["during", "after"])
            },
        )
        .await
        .unwrap();
        assert_eq!(edited.id, created.id);
        assert_eq!(edited.title, "Weekly recap v2");
        assert_eq!(edited.scenarios, vec!["during", "after"]);
        assert_eq!(
            edited.created_at, created.created_at,
            "created_at preserved"
        );
        assert_eq!(BarsRepository::list(&pool).await.unwrap().len(), 1);

        BarsRepository::delete(&pool, &created.id).await.unwrap();
        assert!(BarsRepository::list(&pool).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn invalid_scenarios_fall_back_to_after() {
        let pool = test_pool().await;
        let r = BarsRepository::upsert(&pool, input("Bad scenarios", &["nonsense", ""]))
            .await
            .unwrap();
        assert_eq!(r.scenarios, vec!["after"]);
    }
}
